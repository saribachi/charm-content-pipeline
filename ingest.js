// Studio session ingest: Dropbox folder -> Deepgram transcript -> text-match to card scripts.
// Keys live in the meta table (setting_*) so they stay out of git and out of the flaky Coolify env path.
import { pool } from './db.js';

const KNOWN_SETTINGS = ['deepgram_api_key', 'dropbox_token', 'dropbox_app_key', 'dropbox_app_secret', 'dropbox_refresh_token'];

export async function getSetting(k) {
  if (k === 'deepgram_api_key' && process.env.DEEPGRAM_API_KEY) return process.env.DEEPGRAM_API_KEY;
  if (k === 'dropbox_token' && process.env.DROPBOX_TOKEN) return process.env.DROPBOX_TOKEN;
  const r = await pool.query('SELECT v FROM meta WHERE k=$1', ['setting_' + k]);
  return (r.rows[0] && r.rows[0].v) || '';
}
export async function setSetting(k, v) {
  if (!KNOWN_SETTINGS.includes(k)) throw new Error('unknown setting');
  await pool.query('INSERT INTO meta (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2',
    ['setting_' + k, v]);
}
export async function settingsStatus() {
  const deepgram = !!(await getSetting('deepgram_api_key'));
  const direct = !!(await getSetting('dropbox_token'));
  const refresh = !!(await getSetting('dropbox_refresh_token')) && !!(await getSetting('dropbox_app_key')) && !!(await getSetting('dropbox_app_secret'));
  return { deepgram, dropbox: direct || refresh };
}

// Mint a fresh short-lived Dropbox access token from the stored refresh token (set-and-forget),
// falling back to a directly-pasted token for quick manual testing.
async function dropboxAccessToken() {
  const rt = await getSetting('dropbox_refresh_token');
  const key = await getSetting('dropbox_app_key');
  const secret = await getSetting('dropbox_app_secret');
  if (rt && key && secret) {
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(key + ':' + secret).toString('base64') },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('dropbox oauth ' + r.status + ': ' + JSON.stringify(d).slice(0, 200));
    return d.access_token;
  }
  const direct = await getSetting('dropbox_token');
  if (direct) return direct;
  throw new Error('Dropbox not connected yet.');
}

// ---- text matching: the footage is Chris reading a script, so the transcript is near-verbatim ----
const STOP = new Set(('the a an and or but of to in on for with your you our we it is are was were be been being that this these those at as by from so if not no do does did have has had will would can could should i me my mine us they them he she his her their there here what which who when where why how all any each more most other some such only own same than too very just about into over after out up down off then once').split(/\s+/));
function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}
function vec(toks) { const m = new Map(); for (const t of toks) m.set(t, (m.get(t) || 0) + 1); return m; }
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; if (b.has(k)) dot += v * b.get(k); }
  for (const [, v] of b) nb += v * v;
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
export function matchTranscript(transcript, cards) {
  const tv = vec(tokens(transcript));
  return cards
    .filter((c) => (c.script || '').trim())
    .map((c) => ({ cardId: c.id, name: c.name, score: +cosine(tv, vec(tokens(c.script))).toFixed(4) }))
    .sort((a, b) => b.score - a.score);
}

// ---- Deepgram (URL-based: it fetches the file itself, no local download) ----
export async function deepgramTranscribe(url, key) {
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true', {
    method: 'POST',
    headers: { Authorization: 'Token ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!r.ok) throw new Error('deepgram ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return (((d.results || {}).channels || [{}])[0].alternatives || [{}])[0].transcript || '';
}

// ---- Dropbox ----
const DBX = 'https://api.dropboxapi.com/2';
async function dbx(pathname, token, body) {
  const r = await fetch(DBX + pathname, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('dropbox ' + pathname + ' ' + r.status + ': ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : {};
}
const MEDIA = /\.(mp4|mov|m4v|mkv|webm|wav|mp3|m4a|aac)$/i;
export async function dropboxList(sharedUrl, token) {
  let d = await dbx('/files/list_folder', token, { path: '', shared_link: { url: sharedUrl }, recursive: true });
  let entries = d.entries || [];
  while (d.has_more) { d = await dbx('/files/list_folder/continue', token, { cursor: d.cursor }); entries = entries.concat(d.entries || []); }
  return entries.filter((e) => e['.tag'] === 'file' && MEDIA.test(e.name || ''));
}
async function dropboxTempLink(fileId, token) {
  const d = await dbx('/files/get_temporary_link', token, { path: fileId });
  return d.link;
}
async function dropboxShareLink(fileId, token) {
  try {
    const d = await dbx('/sharing/create_shared_link_with_settings', token, { path: fileId });
    return d.url || null;
  } catch (e) {
    if (/409|shared_link_already_exists/.test(String(e.message))) {
      const d = await dbx('/sharing/list_shared_links', token, { path: fileId });
      return (d.links && d.links[0] && d.links[0].url) || null;
    }
    return null;
  }
}

// ---- orchestration ----
export async function startIngest(sharedUrl) {
  const dgkey = await getSetting('deepgram_api_key');
  if (!dgkey) throw new Error('Deepgram not connected yet — add the key in the Ingest panel.');
  const token = await dropboxAccessToken(); // throws if Dropbox not connected
  const files = await dropboxList(sharedUrl, token);
  if (!files.length) throw new Error('No video/audio files found in that Dropbox folder.');
  const sessionId = 'ses' + Date.now();
  for (const f of files) {
    await pool.query(
      `INSERT INTO ingest_items (session_id, file_id, file_name, status) VALUES ($1,$2,$3,'pending')`,
      [sessionId, f.id, f.name]);
  }
  processIngest(sessionId, token, dgkey).catch((e) => console.error('ingest run failed', e.message));
  return { sessionId, count: files.length };
}
async function processIngest(sessionId, token, dgkey) {
  const cards = (await pool.query('SELECT id,name,script FROM cards')).rows;
  const { rows: items } = await pool.query(`SELECT * FROM ingest_items WHERE session_id=$1 AND status='pending' ORDER BY id`, [sessionId]);
  for (const it of items) {
    try {
      const tmp = await dropboxTempLink(it.file_id, token);
      const transcript = await deepgramTranscribe(tmp, dgkey);
      const scored = matchTranscript(transcript, cards);
      const top = scored[0] || { cardId: null, score: 0 };
      const share = await dropboxShareLink(it.file_id, token);
      await pool.query(
        `UPDATE ingest_items SET transcript=$1, proposed_card_id=$2, confidence=$3, file_url=$4, status='matched' WHERE id=$5`,
        [transcript.slice(0, 6000), top.cardId, top.score, share || tmp, it.id]);
    } catch (e) {
      await pool.query(`UPDATE ingest_items SET status='error', transcript=$1 WHERE id=$2`, [('⚠ ' + e.message).slice(0, 400), it.id]);
    }
  }
}
export async function ingestItems(sessionId) {
  const { rows } = await pool.query('SELECT * FROM ingest_items WHERE session_id=$1 ORDER BY id', [sessionId]);
  return rows.map((r) => ({
    id: r.id, fileName: r.file_name, fileUrl: r.file_url, status: r.status,
    transcript: r.transcript || '', proposedCardId: r.proposed_card_id, confidence: r.confidence,
  }));
}
export async function confirmIngest(assignments) {
  const done = [];
  for (const a of assignments || []) {
    if (!a || !a.cardId) continue;
    const it = (await pool.query('SELECT * FROM ingest_items WHERE id=$1', [a.id])).rows[0];
    if (!it || !it.file_url) continue;
    const card = (await pool.query('SELECT source_url FROM cards WHERE id=$1', [a.cardId])).rows[0];
    if (!card) continue;
    const existing = (card.source_url || '').trim();
    const already = existing.split(/[\s,]+/).includes(it.file_url);
    const next = already ? existing : (existing ? existing + ' ' + it.file_url : it.file_url);
    await pool.query('UPDATE cards SET source_url=$1, updated_at=now() WHERE id=$2', [next, a.cardId]);
    await pool.query(`UPDATE ingest_items SET status='confirmed', proposed_card_id=$1 WHERE id=$2`, [a.cardId, a.id]);
    done.push({ id: a.id, cardId: a.cardId });
  }
  return done;
}
