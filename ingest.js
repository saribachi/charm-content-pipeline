// Studio session ingest: Dropbox folder -> ffmpeg audio (byte-range, no full download) -> Deepgram -> match to planned cards.
// Keys live in the meta table (setting_*) so they stay out of git and out of the flaky Coolify env path.
import { pool } from './db.js';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);
const HOOK_SECONDS = 90;   // first ~90s identifies a clip (raw masters too large to go deeper reliably)
const CHUNK = 4 * 1024 * 1024;

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

// Slate/direction stripping: takes are ad-libbed with "take one / sync sound / action / slow it down 20%"
// noise. Cut everything up to the LAST "action" cue; that's where the real read starts.
export function stripSlate(t) {
  const s = String(t || '');
  const ms = [...s.matchAll(/\baction[.,!]?/gi)];
  const core = (ms.length ? s.slice(ms[ms.length - 1].index + ms[ms.length - 1][0].length) : s).trim();
  return core.length > 40 ? core : s.trim();  // fall back to full text if the cut leaves too little
}

// ---- Deepgram (file upload of the small extracted audio) ----
export async function deepgramFile(audioBuf, key) {
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true', {
    method: 'POST',
    headers: { Authorization: 'Token ' + key, 'Content-Type': 'audio/wav' },
    body: audioBuf,
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
// Shared links don't support recursive list_folder — BFS each subfolder (A Cam / B Cam / …).
export async function dropboxList(sharedUrl, token) {
  const files = [];
  const queue = ['']; // paths relative to the shared root; shared-link entries lack path_lower, so build from names
  while (queue.length) {
    const base = queue.shift();
    let d = await dbx('/files/list_folder', token, { path: base, shared_link: { url: sharedUrl } });
    for (;;) {
      for (const e of d.entries || []) {
        const full = base + '/' + e.name;
        if (e['.tag'] === 'folder') queue.push(full);
        else if (e['.tag'] === 'file' && MEDIA.test(e.name || '')) files.push({ ...e, path: full });
      }
      if (!d.has_more) break;
      d = await dbx('/files/list_folder/continue', token, { cursor: d.cursor });
    }
  }
  return files;
}
// Fetch one byte range of a shared-link file (no full download; works on free accounts, no mounting).
async function dbxRange(sharedUrl, filePath, token, start, end) {
  const r = await fetch('https://content.dropboxapi.com/2/sharing/get_shared_link_file', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({ url: sharedUrl, path: filePath }),
      Range: `bytes=${start}-${end}`,
    },
  });
  if (r.status !== 206 && r.status !== 200) throw new Error('dropbox range ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const buf = Buffer.from(await r.arrayBuffer());
  const cr = r.headers.get('content-range');
  const total = cr ? parseInt(cr.split('/')[1], 10) : buf.length;
  return { buf, total };
}
// Serve a shared-link file over local HTTP so ffmpeg can range-seek it (pulls only the audio bytes it needs).
function serveRange(sharedUrl, filePath, token) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const h = req.headers.range || 'bytes=0-';
        const mm = h.replace('bytes=', '').split('-');
        const start = parseInt(mm[0] || '0', 10);
        let end = mm[1] ? parseInt(mm[1], 10) : start + CHUNK - 1;
        if (end - start + 1 > CHUNK) end = start + CHUNK - 1;
        const { buf, total } = await dbxRange(sharedUrl, filePath, token, start, end);
        res.writeHead(206, {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${start + buf.length - 1}/${total}`,
          'Content-Length': buf.length,
        });
        res.end(buf);
      } catch (e) { try { res.writeHead(500); res.end(); } catch {} }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
// Extract the first HOOK_SECONDS of audio as a small mono 16kHz wav, via the range proxy + ffmpeg.
async function extractAudio(sharedUrl, filePath, token) {
  const server = await serveRange(sharedUrl, filePath, token);
  const port = server.address().port;
  const out = path.join(os.tmpdir(), 'ing_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.wav');
  try {
    await execFileP('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', `http://127.0.0.1:${port}/f`,
      '-vn', '-ac', '1', '-ar', '16000', '-t', String(HOOK_SECONDS), '-y', out],
      { timeout: 10 * 60 * 1000 });
    return fs.readFileSync(out);
  } finally {
    server.close();
    try { fs.unlinkSync(out); } catch {}
  }
}
// Per-file deep links aren't possible for link-only shared files (not in the account), so return the
// shared FOLDER link (the member can open it) — the row/card shows the filename to find the exact clip.
function fileWebUrl(sharedUrl) {
  const q = sharedUrl.indexOf('?');
  const base = q >= 0 ? sharedUrl.slice(0, q) : sharedUrl;
  const rl = (sharedUrl.match(/[?&](rlkey=[^&]+)/) || [, ''])[1];
  return base + (rl ? '?' + rl : '');
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
      `INSERT INTO ingest_items (session_id, file_id, file_name, shared_url, file_path, status) VALUES ($1,$2,$3,$4,$5,'pending')`,
      [sessionId, f.id, f.name, sharedUrl, f.path]);
  }
  processIngest(sessionId, dgkey).catch((e) => console.error('ingest run failed', e.message));
  return { sessionId, count: files.length };
}
async function processIngest(sessionId, dgkey) {
  // Match ONLY against planned-stage cards — every planned card should have a matching recording.
  const planned = (await pool.query(`SELECT id,name,script FROM cards WHERE stage='planned'`)).rows;
  const { rows: items } = await pool.query(`SELECT * FROM ingest_items WHERE session_id=$1 AND status='pending' ORDER BY id`, [sessionId]);
  for (const it of items) {
    try {
      const token = await dropboxAccessToken(); // refresh per file (long runs can outlive a token)
      const audio = await extractAudio(it.shared_url, it.file_path, token);
      const rawTx = await deepgramFile(audio, dgkey);
      const scored = matchTranscript(stripSlate(rawTx), planned);
      const top = scored[0] || { cardId: null, score: 0 };
      await pool.query(
        `UPDATE ingest_items SET transcript=$1, proposed_card_id=$2, confidence=$3, file_url=$4, status='matched' WHERE id=$5`,
        [rawTx.slice(0, 6000), top.cardId, top.score, fileWebUrl(it.shared_url) + '#' + encodeURIComponent(it.file_name || ''), it.id]);
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
