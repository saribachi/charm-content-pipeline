import express from 'express';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import { pool, initDb, resetToSeed, bankCategories } from './db.js';
import { settingsStatus, setSetting, startIngest, ingestItems, confirmIngest } from './ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ---------- auth (single shared team password) ----------
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || ('ccp-session-' + PASSWORD);
const COOKIE = 'ccp_session';
const MAXAGE = 30 * 24 * 3600; // 30 days, seconds
if (!PASSWORD) console.warn('⚠ APP_PASSWORD not set — app is OPEN (no login required).');

const sign = (ts) => crypto.createHmac('sha256', SECRET).update(String(ts)).digest('hex');
const makeToken = () => { const ts = Date.now(); return ts + '.' + sign(ts); };
function tokenValid(tok) {
  if (!tok) return false;
  const i = tok.indexOf('.');
  if (i < 0) return false;
  const ts = tok.slice(0, i), sig = tok.slice(i + 1);
  if (!/^\d+$/.test(ts) || Date.now() - Number(ts) > MAXAGE * 1000) return false;
  const good = sign(ts);
  return sig.length === good.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function pwMatch(input) {
  if (!PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const eq = part.indexOf('=');
    if (eq > -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
function setSession(req, res, val, maxAge) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(val)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
function loginPage(err) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Charm Content Pipeline — Sign in</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>*{margin:0;box-sizing:border-box;font-family:'Poppins',system-ui,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#8733ed,#a855f7);padding:20px}
.box{background:#fff;border-radius:18px;padding:38px 34px;width:380px;max-width:100%;box-shadow:0 20px 60px rgba(40,20,80,.3)}
h1{font-size:22px;font-weight:800;color:#1a1525;letter-spacing:-.4px}h1 span{color:#8733ed}
p{color:#6b6577;font-size:13px;margin:6px 0 22px}
label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#6b6577}
input{width:100%;border:1px solid #e7e2f0;border-radius:10px;padding:12px 14px;font-size:14px;margin:7px 0 16px}
input:focus{outline:none;border-color:#8733ed}
button{width:100%;background:#8733ed;color:#fff;border:none;border-radius:10px;padding:12px;font-size:14px;font-weight:700;cursor:pointer}
button:hover{background:#6a1fc0}.err{background:#fde8e8;color:#dc2626;font-size:12px;font-weight:600;padding:9px 12px;border-radius:9px;margin-bottom:16px}</style>
</head><body><form class="box" method="POST" action="/login">
<h1>Charm Content Pipeline<span>.</span></h1><p>Enter the team password to continue.</p>
${err ? '<div class="err">Incorrect password. Try again.</div>' : ''}
<label>Password</label><input type="password" name="password" autofocus autocomplete="current-password">
<button type="submit">Sign in</button></form></body></html>`;
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/login', (req, res) => res.type('html').send(loginPage(req.query.e)));
app.post('/login', (req, res) => {
  if (pwMatch(req.body.password)) { setSession(req, res, makeToken(), MAXAGE); return res.redirect('/'); }
  return res.redirect('/login?e=1');
});
app.get('/logout', (req, res) => { setSession(req, res, '', 0); res.redirect('/login'); });

// gate everything else
app.use((req, res, next) => {
  if (!PASSWORD) return next();
  if (tokenValid(getCookie(req, COOKIE))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Slack board-update alerts (debounced digest) ----------
// Set SLACK_WEBHOOK_URL (Slack Incoming Webhook) to enable. A burst of edits/drags
// is coalesced into ONE message after SLACK_DEBOUNCE_MS so the channel isn't spammed.
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || '';
const BOARD_URL = process.env.APP_URL || 'https://content.hirecharm.com';
const SLACK_DEBOUNCE_MS = Number(process.env.SLACK_DEBOUNCE_MS || 20000);
const STAGE_LABEL = { planned: 'Planned', recorded: 'Recorded', shared: 'Recorded & shared with editor', edit: 'In edit', drafted: 'Drafted', review: 'In review', approved: 'Approved', concept: 'Concept', drafting: 'Drafting', design: 'Design', landing: 'Landing page', wired: 'Welcome flow wired', scheduled: 'Scheduled', live: 'Live', reviewed: 'Reviewed' };
// Video's "scheduled" id displays as "Ready for review" (editor -> Chris/Sarah handoff).
function stageLabel(contentType, id) {
  if (VIDEO_TYPES.includes(contentType) && id === 'scheduled') return 'Ready for review';
  return STAGE_LABEL[id] || id;
}
function notifyReviewReady(card) {
  if (!SLACK_WEBHOOK) return;
  const chris = CHRIS_SLACK_ID ? `<@${CHRIS_SLACK_ID}>` : '@Chris';
  const sarah = SARAH_SLACK_ID ? `<@${SARAH_SLACK_ID}>` : '@Sarah';
  const vs = (Array.isArray(card.variants) ? card.variants : []).filter((v) => v && /^https?:\/\//i.test(v.url || ''));
  const n = vs.length;
  const links = n ? ' — ' + vs.map((v) => `<${v.url}|${v.label || 'edit'}>`).join(' · ') : '';
  const cnt = n > 1 ? ` (*${n} variants*)` : '';
  postSlack(`:eyes: ${chris} ${sarah} *${card.name}* is *ready for review*${cnt}${links}. <${BOARD_URL}|Open the board →>`);
}
const TRACK_LABEL = { gtm: 'GTM', cs: 'CS-Flex', vsl: 'VSL', consulting: 'Consulting', cs_engine: 'CS Engine' };
// Leo's handoff: when a card reaches "Uploaded" he gets @-tagged with a link to the right Drive folder.
const LEO_SLACK_ID = process.env.LEO_SLACK_ID || 'U09VDPB6WSJ'; // leogzd
const CHRIS_SLACK_ID = process.env.CHRIS_SLACK_ID || 'UKZ9YEQ1J';
const SARAH_SLACK_ID = process.env.SARAH_SLACK_ID || 'U0B77HHHPPX';
const VIDEO_TYPES = ['ad', 'vsl', 'video_organic'];
const DRIVE_FOLDERS = {
  gtm: 'https://drive.google.com/drive/folders/11M9X1lf1sPPC9VyVxNjDbIeu8gG0Cx1z',
  cs: 'https://drive.google.com/drive/folders/1X_jRhwO8vuDD91xxJUmVa0fU0f6ZG00t',
  vslGtm: 'https://drive.google.com/drive/folders/1uPbh6WnwMUHsU08553yPr07gngOmP-zZ', // VSL section inside the GTM folder
  vslCs: 'https://drive.google.com/drive/folders/1MIA90_lWvqFXdDlvkXlizp0DxGGvG4GK', // VSL section inside the CS folder
};
// Resolve the Drive folder + label for a card. VSL cards (track 'vsl') split by name
// into the GTM-VSL vs CS-VSL section (seeded names: "GTM VSL …" / "CS-Flex VSL").
function folderFor(card) {
  if (card.track === 'gtm') return { url: DRIVE_FOLDERS.gtm, label: 'GTM folder' };
  if (card.track === 'cs') return { url: DRIVE_FOLDERS.cs, label: 'CS-Flex folder' };
  if (card.track === 'vsl') {
    return /\bcs\b|cs-?flex/i.test(card.name || '')
      ? { url: DRIVE_FOLDERS.vslCs, label: 'CS VSL folder' }
      : { url: DRIVE_FOLDERS.vslGtm, label: 'GTM VSL folder' };
  }
  return null;
}
if (!SLACK_WEBHOOK) console.warn('⚠ SLACK_WEBHOOK_URL not set — board-update alerts are OFF.');

async function postSlack(text) {
  try {
    const r = await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) { console.warn('Slack HTTP', r.status); return false; }
    return true;
  } catch (e) { console.warn('Slack post failed:', e.message); return false; }
}

// ---- general board-change digest ----
let slackBuffer = [];
let slackTimer = null;
function notifyBoard(line) {
  if (!SLACK_WEBHOOK || !line) return;
  slackBuffer.push(line);
  if (!slackTimer) slackTimer = setTimeout(flushSlack, SLACK_DEBOUNCE_MS);
}
async function flushSlack() {
  slackTimer = null;
  const changes = slackBuffer;
  slackBuffer = [];
  if (!changes.length) return;
  const shown = changes.slice(0, 15);
  const more = changes.length - shown.length;
  const head = `:clipboard: *Content pipeline updated* — ${changes.length} change${changes.length > 1 ? 's' : ''}`;
  const body = shown.map((l) => `• ${l}`).join('\n') + (more > 0 ? `\n• …and ${more} more` : '');
  await postSlack(`${head}\n${body}\n<${BOARD_URL}|Open the board →>`);
}

// ---- Leo handoff: card(s) moved to "Uploaded" → its own digest, tags Leo + Drive folder ----
let handoffBuffer = [];
let handoffTimer = null;
function notifyHandoff(card) {
  if (!SLACK_WEBHOOK || !card) return;
  handoffBuffer.push(card); // { name, track }
  if (!handoffTimer) handoffTimer = setTimeout(flushHandoff, SLACK_DEBOUNCE_MS);
}
async function flushHandoff() {
  handoffTimer = null;
  const items = handoffBuffer;
  handoffBuffer = [];
  if (!items.length) return;
  const tag = LEO_SLACK_ID ? `<@${LEO_SLACK_ID}>` : '@Leo';
  const lines = items.map((c) => {
    const f = folderFor(c);
    const urls = (c.sourceUrl || '').split(/[\s,]+/).filter((u) => /^https?:\/\//i.test(u));
    const src = urls.map((u, idx) => `<${u}|:movie_camera: file${urls.length > 1 ? ' ' + (idx + 1) : ''}>`).join(' ');
    const folder = f ? `<${f.url}|:file_folder: ${f.label}>` : (TRACK_LABEL[c.track] || (c.track || '').toUpperCase());
    return `• *${c.name}* — ${src ? src + ' · ' : ''}${folder}`;
  });
  const n = items.length;
  const head = `:inbox_tray: *${n} file${n > 1 ? 's' : ''} uploaded — ready to edit* ${tag}`;
  await postSlack(`${head}\n${lines.join('\n')}\n<${BOARD_URL}|Open the board →>`);
}

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Short, Slack-safe one-line preview of a script for notifications.
function scriptPreview(s, n = 180) {
  let flat = String(s || '').replace(/\s+/g, ' ').trim();
  if (flat.length > n) flat = flat.slice(0, n).trimEnd() + '…';
  return flat.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rowToCard(r) {
  return {
    id: r.id, name: r.name, hook: r.hook, track: r.track, type: r.type,
    stage: r.stage, owner: r.owner, batch: r.batch, file: r.file, notes: r.notes,
    script: r.script || '',
    recordWeek: iso(r.record_week), liveDate: iso(r.live_date),
    performance: r.performance || {},
    position: r.position, backlogged: !!r.backlogged,
    contentType: r.content_type, referenceUrl: r.reference_url, reviewUrl: r.review_url, sourceUrl: r.source_url, variants: Array.isArray(r.variants) ? r.variants : [], funnelStage: r.funnel_stage,
    editStartedAt: r.edit_started_at, sprintId: r.sprint_id,
    parentId: r.parent_id, chainTemplateId: r.chain_template_id,
    magnetFormat: r.magnet_format, targetIcp: r.target_icp, giveawayPostId: r.giveaway_post_id, optinCount: r.optin_count,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const FIELDS = {
  name: 'name', hook: 'hook', track: 'track', type: 'type', stage: 'stage',
  owner: 'owner', batch: 'batch', file: 'file', notes: 'notes', script: 'script',
  recordWeek: 'record_week', liveDate: 'live_date', backlogged: 'backlogged',
  contentType: 'content_type', referenceUrl: 'reference_url', funnelStage: 'funnel_stage',
  chainTemplateId: 'chain_template_id', reviewUrl: 'review_url', sourceUrl: 'source_url',
  magnetFormat: 'magnet_format', targetIcp: 'target_icp', optinCount: 'optin_count',
};

// ---------- Studio session ingest (Dropbox -> Deepgram -> match to card) ----------
app.get('/api/settings/status', async (_req, res) => {
  try { res.json(await settingsStatus()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings', async (req, res) => {
  try { await setSetting(req.body.key, (req.body.value || '').trim()); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ingest', async (req, res) => {
  try {
    const url = (req.body.url || '').trim();
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Paste a Dropbox folder link.' });
    res.json(await startIngest(url));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/ingest/:sid', async (req, res) => {
  try { res.json(await ingestItems(req.params.sid)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ingest/confirm', async (req, res) => {
  try { res.json(await confirmIngest(req.body.items || [])); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/state', async (_req, res) => {
  try {
    const cards = await pool.query('SELECT * FROM cards ORDER BY position, created_at');
    const bank = await pool.query('SELECT id, category, text, done, position FROM bank_items ORDER BY position, id');
    const cadence = await pool.query(`SELECT content_type, target_count, period, default_owner, active,
      est_create_min, est_publish_min, create_role, publish_role, next_due_date, serialized FROM cadence_rules ORDER BY id`);
    const sprint = await pool.query(`SELECT * FROM sprints WHERE status='active' ORDER BY starts_on DESC LIMIT 1`);
    const capacity = await pool.query('SELECT person, weekly_minutes FROM capacity_budgets');
    const chains = await pool.query('SELECT id, name, trigger_stage, children FROM chain_templates ORDER BY id');
    res.json({
      cards: cards.rows.map(rowToCard),
      bankItems: bank.rows,
      bankCategories,
      cadenceRules: cadence.rows,
      sprint: sprint.rows[0] || null,
      capacity: capacity.rows,
      chainTemplates: chains.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a person's weekly capacity budget (minutes).
app.put('/api/capacity/:person', async (req, res) => {
  try {
    await pool.query(`INSERT INTO capacity_budgets (person, weekly_minutes) VALUES ($1,$2)
      ON CONFLICT (person) DO UPDATE SET weekly_minutes=$2`, [req.params.person, Number(req.body.weekly_minutes) || 0]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a sprint from the Composer: insert planned cards + log deferrals. One Slack summary.
app.post('/api/sprints/create', async (req, res) => {
  try {
    const b = req.body || {};
    const s = await pool.query(`INSERT INTO sprints (name, starts_on, ends_on) VALUES ($1,$2,$3) RETURNING *`,
      [b.name || 'Sprint', b.starts_on, b.ends_on]);
    const sprintId = s.rows[0].id;
    const list = b.cards || [];
    let n = 0;
    for (const c of list) {
      const id = 'sp' + sprintId + '_' + (n++);
      await pool.query(
        `INSERT INTO cards (id, name, hook, track, type, stage, owner, batch, content_type, funnel_stage, sprint_id, record_week, position)
         VALUES ($1,$2,$3,$4,$5,'planned',$6,$7,$8,$9,$10,$11,(SELECT COALESCE(MAX(position),0)+1 FROM cards))`,
        [id, c.name || 'Untitled', c.hook || '', c.track || 'gtm', c.type || 'ad', c.owner || 'chris',
         b.name || '', c.contentType || 'video_organic', c.funnelStage || null, sprintId, b.starts_on || null]);
    }
    for (const d of (b.deferrals || [])) {
      await pool.query(`INSERT INTO deferrals (content_type, deferred_from, deferred_to, sprint_id) VALUES ($1,$2,$3,$4)`,
        [d.content_type, b.starts_on, d.deferred_to, sprintId]);
      await pool.query(`UPDATE cadence_rules SET next_due_date=$2 WHERE content_type=$1`, [d.content_type, d.deferred_to]);
    }
    const nd = (b.deferrals || []).length;
    notifyBoard(`:spiral_calendar_pad: *Sprint started: ${b.name || 'Sprint'}* — ${n} card${n !== 1 ? 's' : ''} planned${nd ? `, ${nd} deferred` : ''}. <${BOARD_URL}|Open the board →>`);
    res.json({ ok: true, sprintId, created: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a coverage cadence lane (target / owner / active), edited from the dashboard.
app.put('/api/cadence/:ct', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    let i = 1;
    if ('target_count' in b) { sets.push(`target_count = $${i++}`); vals.push(Number(b.target_count) || 0); }
    if ('default_owner' in b) { sets.push(`default_owner = $${i++}`); vals.push(b.default_owner || null); }
    if ('active' in b) { sets.push(`active = $${i++}`); vals.push(!!b.active); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.ct);
    await pool.query(`UPDATE cadence_rules SET ${sets.join(', ')} WHERE content_type = $${i}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cards', async (req, res) => {
  try {
    const b = req.body || {};
    const id = 'n' + Date.now() + Math.floor(Math.random() * 1000);
    const r = await pool.query(
      `INSERT INTO cards (id, name, hook, track, type, stage, owner, batch, file, notes, script, record_week, content_type, reference_url, chain_template_id, magnet_format, target_icp, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         (SELECT COALESCE(MAX(position),0)+1 FROM cards))
       RETURNING *`,
      [id, b.name || 'Untitled', b.hook || '', b.track || 'gtm',
       b.type || (b.track === 'vsl' ? 'vsl' : 'ad'), b.stage || 'planned',
       b.owner || 'chris', b.batch || '', b.file || '', b.notes || '', b.script || '',
       b.recordWeek || null, b.contentType || 'video_organic', b.referenceUrl || '', b.chainTemplateId || null,
       b.magnetFormat || null, b.targetIcp || null]
    );
    const card = rowToCard(r.rows[0]);
    notifyBoard(`:new: *New card added:* ${card.name} (${TRACK_LABEL[card.track] || card.track})`);
    res.json(card);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cards/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const prev = await pool.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
    const sets = [], vals = [];
    let i = 1;
    for (const [key, col] of Object.entries(FIELDS)) {
      if (key in b) { sets.push(`${col} = $${i++}`); vals.push(b[key] === '' ? null : b[key]); }
    }
    if (b.performance) { sets.push(`performance = $${i++}`); vals.push(JSON.stringify(b.performance)); }
    if (Array.isArray(b.variants)) { sets.push(`variants = $${i++}`); vals.push(JSON.stringify(b.variants)); }
    // Auto-stamp live_date the first time a card lands on Live and has no date yet.
    if (b.stage === 'live' || b.stage === 'reviewed') {
      sets.push(`live_date = COALESCE(live_date, CURRENT_DATE)`);
    }
    // Start the In-Edit SLA countdown each time a card freshly enters the edit stage (re-arm the reminder).
    if (b.stage === 'edit' && (!prev.rows[0] || prev.rows[0].stage !== 'edit')) {
      sets.push(`edit_started_at = now()`);
      sets.push(`edit_reminded = FALSE`);
    }
    sets.push(`updated_at = now()`);
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE cards SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const card = rowToCard(r.rows[0]);
    const before = prev.rows[0] ? rowToCard(prev.rows[0]) : null;
    if (before && card.stage !== before.stage) {
      if (card.stage === 'shared') {
        // Reached "Uploaded" → Leo's handoff (tags him + Drive folder), not the generic digest.
        notifyHandoff({ name: card.name, track: card.track, sourceUrl: card.sourceUrl });
      } else if (card.stage === 'scheduled' && VIDEO_TYPES.includes(card.contentType)) {
        // Video "Ready for review" → tag Chris + Sarah with the editor's file link.
        notifyReviewReady(card);
      } else {
        notifyBoard(`:twisted_rightwards_arrows: *${card.name}* moved: ${stageLabel(card.contentType, before.stage)} → *${stageLabel(card.contentType, card.stage)}*`);
      }
    } else if (before && !!before.backlogged !== !!card.backlogged) {
      // Backlog park/restore is intentionally silent (no Slack alert).
    } else if (before) {
      // Impactful-only: a new script, or a newly raised blocker. Minor field edits stay silent.
      const newScript = (card.script || '').trim();
      const oldScript = (before.script || '').trim();
      const blockerRaised = !(before.notes || '').includes('⚠') && (card.notes || '').includes('⚠');
      if (newScript && !oldScript) {
        notifyBoard(`:page_facing_up: Script added on *${card.name}*\n> ${scriptPreview(card.script)}`);
      } else if (blockerRaised) {
        notifyBoard(`:warning: Blocker flagged on *${card.name}*`);
      }
    }
    // Chain spawn: a templated card reaching its trigger stage creates its derivatives, once.
    if (card.chainTemplateId && before && card.stage !== before.stage) {
      const tpl = (await pool.query('SELECT trigger_stage, children FROM chain_templates WHERE id=$1', [card.chainTemplateId])).rows[0];
      if (tpl && card.stage === tpl.trigger_stage) {
        const has = await pool.query('SELECT 1 FROM cards WHERE parent_id=$1 LIMIT 1', [card.id]);
        if (!has.rowCount) {
          const kids = Array.isArray(tpl.children) ? tpl.children : [];
          let k = 0;
          for (const ch of kids) {
            const cid = 'dv' + card.id + '_' + (k++);
            await pool.query(
              `INSERT INTO cards (id, name, hook, track, type, stage, owner, batch, content_type, funnel_stage, parent_id, position)
               VALUES ($1,$2,$3,$4,$5,'planned',$6,$7,$8,$9,$10,(SELECT COALESCE(MAX(position),0)+1 FROM cards))`,
              [cid, `${card.name} — ${ch.title_suffix || ch.content_type}`,
               `Derived from: ${card.name}`, card.track,
               ch.content_type === 'ad' ? 'ad' : ch.content_type === 'vsl' ? 'vsl' : 'organic',
               card.owner || 'chris', card.batch || '', ch.content_type, ch.funnel_stage || null, card.id]);
            // Link a lead magnet to its auto-created giveaway post.
            if (card.contentType === 'lead_magnet' && ch.content_type === 'linkedin_post')
              await pool.query(`UPDATE cards SET giveaway_post_id=$1 WHERE id=$2`, [cid, card.id]);
          }
          if (kids.length) notifyBoard(`:link: *${card.name}* spawned ${kids.length} derivative${kids.length !== 1 ? 's' : ''} (chain). <${BOARD_URL}|Open the board →>`);
        }
      }
    }
    res.json(card);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cards/:id', async (req, res) => {
  try {
    // No Slack alert on delete (not an impactful pipeline update).
    await pool.query('UPDATE cards SET parent_id=NULL WHERE parent_id=$1', [req.params.id]); // orphan children, never cascade
    await pool.query('DELETE FROM cards WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk park/restore, e.g. "backlog all CS planned". Body: {backlogged, track?, stage?}. One summary alert.
app.post('/api/cards/bulk-backlog', async (req, res) => {
  try {
    const b = req.body || {};
    const val = !!b.backlogged;
    const where = ['backlogged = $1'], vals = [!val]; // only flip rows not already in target state
    let i = 2;
    if (b.track) { where.push(`track = $${i++}`); vals.push(b.track); }
    if (b.stage) { where.push(`stage = $${i++}`); vals.push(b.stage); }
    const r = await pool.query(
      `UPDATE cards SET backlogged = ${val}, updated_at = now() WHERE ${where.join(' AND ')} RETURNING id`, vals);
    // Backlog park/restore is intentionally silent (no Slack alert).
    res.json({ count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bank-items', async (req, res) => {
  try {
    const { category, text } = req.body || {};
    const id = 'b' + Date.now() + Math.floor(Math.random() * 1000);
    const r = await pool.query(
      `INSERT INTO bank_items (id, category, text, done, position)
       VALUES ($1,$2,$3,FALSE,(SELECT COALESCE(MAX(position),0)+1 FROM bank_items))
       RETURNING id, category, text, done, position`,
      [id, category || 'Uncategorized', (text || '').trim() || 'New idea']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bank-items/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    let i = 1;
    if ('text' in b)     { sets.push(`text = $${i++}`);     vals.push(b.text); }
    if ('done' in b)     { sets.push(`done = $${i++}`);     vals.push(!!b.done); }
    if ('category' in b) { sets.push(`category = $${i++}`); vals.push(b.category); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE bank_items SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, category, text, done, position`, vals);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bank-items/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bank_items WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reset', async (_req, res) => {
  try { await resetToSeed(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Days + hours, e.g. "2d 6h" (or "6h" under a day).
function fmtDurSrv(ms) {
  const h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h` : `${h % 24}h`;
}

// Periodic check: when an In-Edit card crosses into its final 24h, tag Leo once.
// Everything else about the timer is visible on the board; this keeps the channel low-noise.
const SLA_MS = { vsl: 168 * 3600000, default: 72 * 3600000 };
async function checkEditSlas() {
  if (!SLACK_WEBHOOK) return;
  try {
    const r = await pool.query(
      `SELECT * FROM cards WHERE stage='edit' AND backlogged=FALSE AND edit_started_at IS NOT NULL AND edit_reminded=FALSE`);
    const due = [];
    for (const row of r.rows) {
      const card = rowToCard(row);
      const slaMs = (card.type === 'vsl' || card.track === 'vsl') ? SLA_MS.vsl : SLA_MS.default;
      const remaining = slaMs - (Date.now() - new Date(card.editStartedAt).getTime());
      if (remaining <= 24 * 3600000) due.push({ card, remaining });
    }
    if (!due.length) return;
    // One coalesced message: tag Leo once, list every edit that's crossed the 24h mark.
    const tag = LEO_SLACK_ID ? `<@${LEO_SLACK_ID}>` : '@Leo';
    const lines = due.map(({ card, remaining }) => remaining > 0
      ? `• *${card.name}* — due in ${fmtDurSrv(remaining)}`
      : `• *${card.name}* — *overdue by ${fmtDurSrv(-remaining)}*`);
    const head = `:alarm_clock: ${tag} — ${due.length} edit${due.length > 1 ? 's are' : ' is'} approaching the deadline:`;
    const ok = await postSlack(`${head}\n${lines.join('\n')}\n<${BOARD_URL}|Open the board →>`);
    if (ok) {
      for (const { card } of due) await pool.query(`UPDATE cards SET edit_reminded = TRUE WHERE id = $1`, [card.id]);
    }
  } catch (e) { console.warn('edit-SLA check failed:', e.message); }
}

// ---- weekly Monday digest (the low-noise nag) ----
const CTYPE_LABEL_SRV = { ad: 'Ad', vsl: 'VSL', video_organic: 'Organic video', linkedin_post: 'LinkedIn post', lead_magnet: 'Lead magnet', newsletter_issue: 'Newsletter', partner_asset: 'Partner asset' };
function mondayISO(d) {
  const x = new Date(d); const off = (x.getUTCDay() + 6) % 7; // 0 = Monday
  x.setUTCDate(x.getUTCDate() - off);
  return x.toISOString().slice(0, 10);
}
async function weeklyDigest() {
  if (!SLACK_WEBHOOK) return { ok: false, reason: 'no webhook' };
  const cards = (await pool.query(`SELECT * FROM cards WHERE backlogged=FALSE`)).rows.map(rowToCard);
  const rules = (await pool.query(`SELECT * FROM cadence_rules WHERE active`)).rows;
  const now = Date.now();
  const label = (ct) => CTYPE_LABEL_SRV[ct] || ct;
  const lines = [];
  for (const r of rules) {
    const target = r.target_count || 0;
    if (target <= 0) { if (!r.default_owner) lines.push(`:red_circle: *${label(r.content_type)}*: no owner assigned`); continue; }
    const winDays = r.period === 'quarter' ? 90 : 30;
    const live = cards.filter(c => c.contentType === r.content_type && c.liveDate && (now - new Date(c.liveDate).getTime()) <= winDays * 86400000).length;
    const expected = Math.round(target * (winDays / ({ week: 7, sprint: 14, month: 30, quarter: 90 }[r.period] || 14)));
    if (!r.default_owner) lines.push(`:red_circle: *${label(r.content_type)}*: ${live} live / ~${expected} target (no owner)`);
    else if (live < 0.75 * expected) lines.push(`:red_circle: *${label(r.content_type)}*: ${live} / ~${expected} (${r.default_owner})`);
    else if (live < expected) lines.push(`:large_yellow_circle: *${label(r.content_type)}*: ${live} / ~${expected} (${r.default_owner})`);
  }
  const stuck = cards.filter(c => c.stage !== 'live' && c.stage !== 'reviewed' && c.updatedAt && (now - new Date(c.updatedAt).getTime()) > 7 * 86400000);
  if (stuck.length) lines.push(`:hourglass_flowing_sand: *${stuck.length} stuck 7+ days*: ${stuck.slice(0, 5).map(c => c.name).join(', ')}${stuck.length > 5 ? '…' : ''}`);
  const mon = mondayISO(new Date());
  const shooting = cards.filter(c => c.recordWeek === mon && c.stage === 'planned');
  if (shooting.length) lines.push(`:clapper: *Recording this week*: ${shooting.slice(0, 6).map(c => c.name).join(', ')}`);
  const body = lines.length ? lines.join('\n') : ':white_check_mark: All lanes on track.';
  await postSlack(`:clipboard: *Charm Content — week of ${mon}*\n${body}\n<${BOARD_URL}|Open the board →>`);
  return { ok: true, lines: lines.length };
}
app.post('/api/digest/test', async (_req, res) => {
  try { res.json(await weeklyDigest()); } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Charm Content Pipeline on :${PORT}`));
    setInterval(checkEditSlas, 15 * 60 * 1000); // every 15 min
    setTimeout(checkEditSlas, 30 * 1000);       // and shortly after boot
    // Weekly digest: Monday 8am Phoenix (UTC-7, no DST), deduped per week via meta.
    setInterval(async () => {
      try {
        const phx = new Date(Date.now() - 7 * 3600000);
        if (phx.getUTCDay() !== 1 || phx.getUTCHours() !== 8) return;
        const wk = mondayISO(new Date());
        const last = (await pool.query(`SELECT v FROM meta WHERE k='digest_week'`)).rows[0];
        if (last && last.v === wk) return;
        await weeklyDigest();
        await pool.query(`INSERT INTO meta (k,v) VALUES ('digest_week',$1) ON CONFLICT (k) DO UPDATE SET v=$1`, [wk]);
      } catch (e) { console.warn('digest cron failed:', e.message); }
    }, 10 * 60 * 1000);
  })
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
