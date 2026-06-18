import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { pool, initDb, resetToSeed } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function rowToCard(r) {
  return {
    id: r.id, name: r.name, hook: r.hook, track: r.track, type: r.type,
    stage: r.stage, owner: r.owner, batch: r.batch, file: r.file, notes: r.notes,
    recordWeek: iso(r.record_week), liveDate: iso(r.live_date),
    perf: { hold: r.perf_hold || '', ctr: r.perf_ctr || '', cpl: r.perf_cpl || '' },
    position: r.position, updatedAt: r.updated_at,
  };
}

const FIELDS = {
  name: 'name', hook: 'hook', track: 'track', type: 'type', stage: 'stage',
  owner: 'owner', batch: 'batch', file: 'file', notes: 'notes',
  recordWeek: 'record_week', liveDate: 'live_date',
};

app.get('/api/state', async (_req, res) => {
  try {
    const cards = await pool.query('SELECT * FROM cards ORDER BY position, created_at');
    const bank = await pool.query('SELECT key FROM bank_done WHERE done = TRUE');
    const bankDone = {};
    bank.rows.forEach((b) => { bankDone[b.key] = true; });
    res.json({ cards: cards.rows.map(rowToCard), bankDone });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cards', async (req, res) => {
  try {
    const b = req.body || {};
    const id = 'n' + Date.now() + Math.floor(Math.random() * 1000);
    const r = await pool.query(
      `INSERT INTO cards (id, name, hook, track, type, stage, owner, batch, file, notes, record_week, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
         (SELECT COALESCE(MAX(position),0)+1 FROM cards))
       RETURNING *`,
      [id, b.name || 'Untitled', b.hook || '', b.track || 'gtm',
       b.type || (b.track === 'vsl' ? 'vsl' : 'ad'), b.stage || 'planned',
       b.owner || 'chris', b.batch || '', b.file || '', b.notes || '',
       b.recordWeek || null]
    );
    res.json(rowToCard(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cards/:id', async (req, res) => {
  try {
    const b = req.body || {};
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
    res.json(rowToCard(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cards/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM cards WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bank', async (req, res) => {
  try {
    const { key, done } = req.body || {};
    if (done) {
      await pool.query(
        `INSERT INTO bank_done (key, done) VALUES ($1, TRUE)
         ON CONFLICT (key) DO UPDATE SET done = TRUE`, [key]);
    } else {
      await pool.query('DELETE FROM bank_done WHERE key = $1', [key]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reset', async (_req, res) => {
  try { await resetToSeed(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Charm Content Pipeline on :${PORT}`)))
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
