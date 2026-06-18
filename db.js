import pg from 'pg';

const { Pool } = pg;

// Coolify injects DATABASE_URL for the linked Postgres. Falls back to local dev.
const connectionString =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/charm_content_pipeline';

export const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

// Sprint 1 anchors to the week of Monday June 15, 2026.
const SPRINT1_WEEK = '2026-06-15';

const SEED = [
  ['g1', 'gtm', 'ad', 'Burned-before',
   'Open mid-wound on a specific failure. "You hired an SDR. $8K a month. Booked nothing in 60 days." Each false-solution bullet is its own hook. Pivot: that’s not how it has to go.', ''],
  ['g2', 'gtm', 'ad', 'Infrastructure-reveal',
   '"Everyone thinks cold email is a copy problem. It’s not. It’s an infrastructure problem." Then the blur visual (domains / inboxes / warmup / DNS → "we handle all of this").', ''],
  ['g3', 'gtm', 'ad', '90 days, every decision maker',
   'The core promise as a clean specific claim. "Every decision maker in your market. 90 days. Done for you." Big number, finite window, concrete outcome.', ''],
  ['g4', 'gtm', 'ad', 'Math-of-failure',
   '"DIY cold email: 500 emails a day from your main domain → blacklisted in 3 weeks → can’t email your own mom." Self-sabotage, relatable, funny → "or you let people who do this every day handle it."', ''],
  ['c1', 'cs', 'ad', 'Spike-chart (earthquake)',
   '"Your support volume isn’t a line. It’s an earthquake chart." Visualize 80 → 5,000 on drop day → 80. "Staff for the spike, you go broke. Staff for the baseline, you get cooked. We flex." Cleanest single-concept ad.', ''],
  ['c2', 'cs', 'ad', 'Only pay when solved',
   '"Every CS company charges you for empty seats. We charge $2.50 when a ticket actually gets solved. That’s it." Incentive-alignment as the whole ad; novel model = the hook.', ''],
  ['c3', 'cs', 'ad', '2am',
   '"It’s 2am. You’re clearing a Gorgias queue the night of your biggest drop. This isn’t what you built the business for." Pure pain → "live in 48 hours, sounds like your brand."', ''],
  ['c4', 'cs', 'ad', 'Logo-flex',
   'Borrowed trust from named creator brands (Friday Beers, Channel 5, Pizzafy/Airrack, XPRIZE, Woo More Play). "The team behind Friday Beers’ support during their drops." Credibility + familiarity.',
   '⚠ Chris confirms which brands are cleared to name on camera before this one records.'],
  ['v1', 'vsl', 'vsl', 'GTM VSL — Every Decision Maker in 90 Days',
   'Already drafted. Finalize and record. The call is named "the read" throughout.', ''],
  ['v2', 'vsl', 'vsl', 'CS-Flex VSL',
   'Already drafted. Finalize and record. The call is named "the read" throughout.', ''],
];

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      hook        TEXT DEFAULT '',
      track       TEXT NOT NULL DEFAULT 'gtm',
      type        TEXT NOT NULL DEFAULT 'ad',
      stage       TEXT NOT NULL DEFAULT 'planned',
      owner       TEXT NOT NULL DEFAULT 'chris',
      batch       TEXT DEFAULT '',
      file        TEXT DEFAULT '',
      notes       TEXT DEFAULT '',
      record_week DATE,
      live_date   DATE,
      perf_hold   TEXT DEFAULT '',
      perf_ctr    TEXT DEFAULT '',
      perf_cpl    TEXT DEFAULT '',
      position    INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS bank_done (
      key  TEXT PRIMARY KEY,
      done BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);

  const seeded = await pool.query(`SELECT v FROM meta WHERE k = 'seeded'`);
  if (seeded.rowCount === 0) {
    await seedCards();
    await pool.query(`INSERT INTO meta (k, v) VALUES ('seeded', 'true')
                      ON CONFLICT (k) DO NOTHING`);
  }
}

async function seedCards() {
  let pos = 0;
  for (const [id, track, type, name, hook, notes] of SEED) {
    await pool.query(
      `INSERT INTO cards (id, name, hook, track, type, stage, owner, batch, record_week, notes, position)
       VALUES ($1,$2,$3,$4,$5,'planned','chris','Sprint 1',$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, hook, track, type, SPRINT1_WEEK, notes, pos++]
    );
  }
}

export async function resetToSeed() {
  await pool.query('DELETE FROM cards');
  await pool.query('DELETE FROM bank_done');
  await seedCards();
}
