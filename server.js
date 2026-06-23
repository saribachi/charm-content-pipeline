import express from 'express';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import { pool, initDb, resetToSeed, bankCategories } from './db.js';

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
const STAGE_LABEL = { planned: 'Planned', recorded: 'Recorded', shared: 'Uploaded', edit: 'In edit', scheduled: 'Scheduled', live: 'Live', reviewed: 'Reviewed' };
const TRACK_LABEL = { gtm: 'GTM', cs: 'CS-Flex', vsl: 'VSL' };
// Leo's handoff: when a card reaches "Uploaded" he gets @-tagged with a link to the right Drive folder.
const LEO_SLACK_ID = process.env.LEO_SLACK_ID || 'U09VDPB6WSJ'; // leogzd
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
    if (!r.ok) console.warn('Slack HTTP', r.status);
  } catch (e) { console.warn('Slack post failed:', e.message); }
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
    return f
      ? `• *${c.name}* — <${f.url}|:file_folder: ${f.label}>`
      : `• *${c.name}* (${TRACK_LABEL[c.track] || (c.track || '').toUpperCase()})`;
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
    perf: { hold: r.perf_hold || '', ctr: r.perf_ctr || '', cpl: r.perf_cpl || '' },
    position: r.position, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const FIELDS = {
  name: 'name', hook: 'hook', track: 'track', type: 'type', stage: 'stage',
  owner: 'owner', batch: 'batch', file: 'file', notes: 'notes', script: 'script',
  recordWeek: 'record_week', liveDate: 'live_date',
};

app.get('/api/state', async (_req, res) => {
  try {
    const cards = await pool.query('SELECT * FROM cards ORDER BY position, created_at');
    const bank = await pool.query('SELECT id, category, text, done, position FROM bank_items ORDER BY position, id');
    res.json({
      cards: cards.rows.map(rowToCard),
      bankItems: bank.rows,
      bankCategories,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cards', async (req, res) => {
  try {
    const b = req.body || {};
    const id = 'n' + Date.now() + Math.floor(Math.random() * 1000);
    const r = await pool.query(
      `INSERT INTO cards (id, name, hook, track, type, stage, owner, batch, file, notes, script, record_week, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         (SELECT COALESCE(MAX(position),0)+1 FROM cards))
       RETURNING *`,
      [id, b.name || 'Untitled', b.hook || '', b.track || 'gtm',
       b.type || (b.track === 'vsl' ? 'vsl' : 'ad'), b.stage || 'planned',
       b.owner || 'chris', b.batch || '', b.file || '', b.notes || '', b.script || '',
       b.recordWeek || null]
    );
    const card = rowToCard(r.rows[0]);
    notifyBoard(`:new: *New card added:* ${card.name} (${TRACK_LABEL[card.track] || card.track})`);
    res.json(card);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cards/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const prev = await pool.query('SELECT name, stage, script FROM cards WHERE id = $1', [req.params.id]);
    const sets = [], vals = [];
    let i = 1;
    for (const [key, col] of Object.entries(FIELDS)) {
      if (key in b) { sets.push(`${col} = $${i++}`); vals.push(b[key] === '' ? null : b[key]); }
    }
    if (b.perf) {
      if ('hold' in b.perf) { sets.push(`perf_hold = $${i++}`); vals.push(b.perf.hold); }
      if ('ctr' in b.perf)  { sets.push(`perf_ctr = $${i++}`);  vals.push(b.perf.ctr); }
      if ('cpl' in b.perf)  { sets.push(`perf_cpl = $${i++}`);  vals.push(b.perf.cpl); }
    }
    // Auto-stamp live_date the first time a card lands on Live and has no date yet.
    if (b.stage === 'live' || b.stage === 'reviewed') {
      sets.push(`live_date = COALESCE(live_date, CURRENT_DATE)`);
    }
    sets.push(`updated_at = now()`);
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE cards SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const card = rowToCard(r.rows[0]);
    const old = prev.rows[0];
    if (old && card.stage !== old.stage) {
      if (card.stage === 'shared') {
        // Reached "Uploaded" → Leo's handoff (tags him + Drive folder), not the generic digest.
        notifyHandoff({ name: card.name, track: card.track });
      } else {
        notifyBoard(`:twisted_rightwards_arrows: *${card.name}* moved: ${STAGE_LABEL[old.stage] || old.stage} → *${STAGE_LABEL[card.stage] || card.stage}*`);
      }
    } else if (old) {
      const newScript = (card.script || '').trim();
      const oldScript = (old.script || '').trim();
      if (newScript && newScript !== oldScript) {
        const verb = oldScript ? 'Script updated' : 'Script added';
        notifyBoard(`:page_facing_up: ${verb} on *${card.name}*\n> ${scriptPreview(card.script)}`);
      } else {
        notifyBoard(`:pencil2: *${card.name}* updated`);
      }
    }
    res.json(card);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cards/:id', async (req, res) => {
  try {
    const prev = await pool.query('SELECT name FROM cards WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM cards WHERE id = $1', [req.params.id]);
    if (prev.rowCount) notifyBoard(`:wastebasket: *${prev.rows[0].name}* deleted`);
    res.json({ ok: true });
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

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Charm Content Pipeline on :${PORT}`)))
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
