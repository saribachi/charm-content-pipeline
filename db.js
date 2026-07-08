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

// Leo's inbound idea bank — seeded once, then editable/searchable in the UI.
const BANK = {
  'Sales Systems / Tactical': [
    'The subject line formula getting 40% open rates right now',
    'Why your cold emails hit spam (and the 3-step fix)',
    'How to personalize 1,000 emails/day without sounding like a robot',
    'LinkedIn DM that gets 60% response rates (no pitch, just this)',
    'Cold email that booked 12 meetings this week [breakdown]',
    'The deliverability audit that saved our client $40K in wasted sends',
    'The only cold email template you need (tested on 10K+ sends)',
    'The 7-touch follow-up sequence that doesn’t feel desperate',
    'We sent 50 prospects custom gifts, booked 18 meetings',
    'How we QA 1,000 cold emails before hitting send',
    '0 outbound to 40 meetings/month in only 2 weeks',
    'The cold call script that actually books meetings without sounding like a robot',
    'Lead reactivation: what to send when they’ve ignored 7 emails',
    'The discovery call framework that qualifies or disqualifies in 15 minutes',
    'Referral ask sequence: how to get intros from existing clients (exact copy)',
    'The meeting confirmation sequence that cuts no-shows by 60%',
    'Event outreach that doesn’t feel salesy (before, during, after playbook)',
  ],
  'Sales Ops / Systems Build': [
    'How to set up sales forecasting in HubSpot that’s actually accurate',
    'The CRM hygiene checklist that prevents pipeline rot',
    'Sales coaching system using conversational intelligence (Gong walkthrough)',
    'New SDR onboarding: from hire to first meeting in 7 days',
    'Sales attribution model: which channels actually close (not just book)',
    'How to build an ICP scoring system that tells you who to target',
    'The sales tech stack decision framework: when to add vs delete tools',
    'Territory planning for SDRs: divide accounts without overlap',
    'Sales comp plan that aligns rep behavior with company goals',
    'How I built a 10K lead list in Clay for $0',
    'This HubSpot dashboard predicts which leads will close',
    'Clay workflow that finds 100 qualified leads in 10 minutes',
    'Building a complete sales system in HubSpot [time-lapse]',
    'Why your sales stack doesn’t integrate (and how to fix it)',
    'Lead scoring model that predicted 80% of our closed deals',
    'Sales enablement setup: 10 to 50 meetings/week',
  ],
  'Authority / POV': [
    'What a $60K/month outbound operation actually looks like',
    'We scaled to 100 clients with this sales process [breakdown]',
    'Pipeline velocity: why it matters more than win rate',
    'Sales problems are usually ops problems: here’s how to tell',
    'Most SDRs are just expensive API calls (automate them)',
    'Running outbound for 3 industries at once: the systems that make it possible',
    'Solutions selling saved my agency when cold email died',
    'The 5 outbound channels ranked by ROI (email isn’t #1)',
    'Why selling cold email campaigns will kill your agency',
    'How we use all 5 channels (email, LinkedIn, calls, events, gifting) at once',
    'Reverse engineering competitor outreach',
    'What the top 1% of cold emailers do differently (data analysis)',
    '"I’m not a sales guy, I’m an engineer who builds sales machines"',
    'How sales and service should work together (but nobody does it)',
    'Inbound vs outbound vs hybrid: how to pick your GTM motion',
    'Account-based selling vs spray-and-pray: when each works',
    'Market timing: when to double down on outbound vs pull back',
  ],
  'Client Results / Case Studies': [
    'Sex toy brand: $0 to $200K in outbound revenue',
    'Home services: 150 leads/month in a local market',
    'The campaign that failed: $10K spent, 0 meetings (what went wrong)',
    'Client firing us → rehiring 6 months later (what changed)',
    'Q4 vs Q1: how outbound results change seasonally',
    'E-commerce/DTC outbound (B2C tactics that work)',
    'Time-to-first-meeting: 45 days → 12 days',
    'Expansion revenue: existing client $50K → $200K',
    'Before/after stack: 12 tools cut to 4 (ROI)',
    '$0 to $50K/mo on cold email alone',
    '$60K ad spend vs $250K pipeline: the exact system',
    'Won the world cold email competition (Clay World Cup): what we did',
    '2% reply rate → 18% in 30 days',
    'Highline Fiber: $60K → $250K in 90 days',
    'SaaS: 2 → 30 demos/week',
    '40% reply rates [screen recording]',
    '"You 10x’d our pipeline" — full story',
  ],
};
const BANK_CATEGORIES = Object.keys(BANK);

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
      script      TEXT DEFAULT '',
      record_week DATE,
      live_date   DATE,
      perf_hold   TEXT DEFAULT '',
      perf_ctr    TEXT DEFAULT '',
      perf_cpl    TEXT DEFAULT '',
      position    INTEGER DEFAULT 0,
      backlogged  BOOLEAN DEFAULT FALSE,
      edit_started_at TIMESTAMPTZ,
      edit_reminded BOOLEAN DEFAULT FALSE,
      content_type TEXT DEFAULT 'Instagram',
      reference_url TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS bank_items (
      id       TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      text     TEXT NOT NULL,
      done     BOOLEAN DEFAULT FALSE,
      position INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);

  // Migration: add script column to pre-existing deployments.
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS script TEXT DEFAULT ''`);
  // Migration: add backlogged flag (parked cards kept off the active board).
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS backlogged BOOLEAN DEFAULT FALSE`);
  // Migration: add In-Edit SLA start timestamp (countdown timer).
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS edit_started_at TIMESTAMPTZ`);
  // Migration: track whether the 24h-out edit reminder has been sent (once per edit session).
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS edit_reminded BOOLEAN DEFAULT FALSE`);
  // Migration: content type segmentation + reference/inspiration URL(s).
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS content_type TEXT DEFAULT 'Instagram'`);
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS reference_url TEXT DEFAULT ''`);
  // Backfill: cards already sitting in "In edit" before the timer feature never got a start stamp
  // (so their timer + SLA reminder were skipped). Start their clock now. Self-heals any future NULL too.
  await pool.query(`UPDATE cards SET edit_started_at = now() WHERE stage = 'edit' AND edit_started_at IS NULL`);

  // ---- v2 Phase 1: content-type expansion + funnel stage + cadence rules ----
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS funnel_stage TEXT`);
  await pool.query(`ALTER TABLE cards ALTER COLUMN content_type SET DEFAULT 'video_organic'`);
  // Remap legacy content-type labels to the v2 enum values.
  await pool.query(`UPDATE cards SET content_type='ad'  WHERE content_type='Ad'`);
  await pool.query(`UPDATE cards SET content_type='vsl' WHERE content_type='VSL'`);
  await pool.query(`UPDATE cards SET content_type='video_organic'
    WHERE content_type IS NULL OR content_type NOT IN
    ('ad','vsl','video_organic','linkedin_post','lead_magnet','newsletter_issue','welcome_flow_email','partner_asset','landing_page')`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cadence_rules (
    id           SERIAL PRIMARY KEY,
    content_type TEXT NOT NULL UNIQUE,
    target_count INTEGER NOT NULL,
    period       TEXT NOT NULL,
    default_owner TEXT,
    active       BOOLEAN DEFAULT true
  )`);
  // Seed the 9 content lanes (idempotent). Realistic 3-person cadence; edit in the UI.
  const seedCadence = [
    ['ad', 8, 'sprint', 'chris'],
    ['vsl', 0, 'sprint', 'chris'],            // no cadence; as-needed
    ['video_organic', 2, 'week', 'leo'],
    ['linkedin_post', 2, 'week', 'sarah'],
    ['lead_magnet', 2, 'quarter', null],      // unassigned -> red
    ['newsletter_issue', 1, 'week', null],    // unassigned -> red
    ['welcome_flow_email', 0, 'sprint', 'sarah'],
    ['partner_asset', 1, 'month', 'sarah'],
    ['landing_page', 0, 'sprint', 'sarah'],   // as-needed
  ];
  for (const [ct, tc, per, own] of seedCadence) {
    await pool.query(
      `INSERT INTO cadence_rules (content_type, target_count, period, default_owner)
       VALUES ($1,$2,$3,$4) ON CONFLICT (content_type) DO NOTHING`, [ct, tc, per, own]);
  }

  // ---- v2 Phase 2: sprints + capacity + deferrals + effort model ----
  await pool.query(`CREATE TABLE IF NOT EXISTS sprints (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL,
    starts_on DATE NOT NULL, ends_on DATE NOT NULL, status TEXT DEFAULT 'active'
  )`);
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS sprint_id INTEGER`);
  await pool.query(`ALTER TABLE cadence_rules ADD COLUMN IF NOT EXISTS est_create_min  INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE cadence_rules ADD COLUMN IF NOT EXISTS est_publish_min INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE cadence_rules ADD COLUMN IF NOT EXISTS create_role  TEXT`);
  await pool.query(`ALTER TABLE cadence_rules ADD COLUMN IF NOT EXISTS publish_role TEXT`);
  await pool.query(`ALTER TABLE cadence_rules ADD COLUMN IF NOT EXISTS next_due_date DATE`);
  await pool.query(`ALTER TABLE cadence_rules ADD COLUMN IF NOT EXISTS serialized BOOLEAN DEFAULT false`);
  await pool.query(`CREATE TABLE IF NOT EXISTS capacity_budgets (person TEXT PRIMARY KEY, weekly_minutes INTEGER NOT NULL)`);
  for (const [p, m] of [['chris', 240], ['leo', 480], ['sarah', 180]])
    await pool.query(`INSERT INTO capacity_budgets (person, weekly_minutes) VALUES ($1,$2) ON CONFLICT (person) DO NOTHING`, [p, m]);
  await pool.query(`CREATE TABLE IF NOT EXISTS deferrals (
    id SERIAL PRIMARY KEY, content_type TEXT NOT NULL,
    deferred_from DATE NOT NULL, deferred_to DATE NOT NULL, sprint_id INTEGER, created_at TIMESTAMPTZ DEFAULT now()
  )`);
  // Seed per-lane effort + roles (derivatives-first: chain-derived lanes cost 0 to create). Idempotent.
  const effort = [
    ['ad', 12, 'chris', 25, 'leo', false],
    ['vsl', 90, 'chris', 120, 'leo', false],
    ['video_organic', 30, 'leo', 30, 'leo', false],
    ['linkedin_post', 0, 'chris', 10, 'sarah', false],       // chain derivative of recordings
    ['newsletter_issue', 20, 'chris', 15, 'sarah', false],   // Claude drafts, Chris edits ~20m, Sarah sends
    ['welcome_flow_email', 30, 'sarah', 10, 'sarah', false],
    ['partner_asset', 45, 'sarah', 10, 'chris', false],
    ['lead_magnet', 240, 'sarah', 30, 'sarah', true],        // serialized: one at a time
    ['landing_page', 60, 'sarah', 10, 'sarah', false],
  ];
  for (const [ct, ec, cr, ep, pr, ser] of effort)
    await pool.query(
      `UPDATE cadence_rules SET est_create_min=$2, create_role=$3, est_publish_min=$4, publish_role=$5, serialized=$6
       WHERE content_type=$1 AND create_role IS NULL`, [ct, ec, cr, ep, pr, ser]);

  // ---- v2 Phase 4: repurposing chains (parent/child cards) ----
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS parent_id TEXT`);          // cards.id is TEXT
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS chain_template_id INTEGER`);
  // Editor's finished-file link for the "Ready for review" stage.
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS review_url TEXT DEFAULT ''`);
  await pool.query(`CREATE TABLE IF NOT EXISTS chain_templates (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, trigger_stage TEXT NOT NULL, children JSONB NOT NULL
  )`);
  const nTpl = +(await pool.query('SELECT COUNT(*) FROM chain_templates')).rows[0].count;
  if (nTpl === 0) {
    const templates = [
      ['Pillar video', 'recorded', [
        { content_type: 'linkedin_post', funnel_stage: 'mof', title_suffix: 'LinkedIn post' },
        { content_type: 'video_organic', funnel_stage: 'mof', title_suffix: 'IG cut' },
        { content_type: 'newsletter_issue', funnel_stage: 'mof', title_suffix: 'newsletter section' }]],
      ['Lead magnet launch', 'design', [
        { content_type: 'linkedin_post', funnel_stage: 'tof', title_suffix: 'giveaway post' },
        { content_type: 'welcome_flow_email', funnel_stage: 'mof', title_suffix: 'welcome flow review' },
        { content_type: 'landing_page', funnel_stage: 'tof', title_suffix: 'landing page' }]],
      ['Case study', 'recorded', [
        { content_type: 'linkedin_post', funnel_stage: 'bof', title_suffix: 'LinkedIn post' },
        { content_type: 'video_organic', funnel_stage: 'bof', title_suffix: 'IG cut' },
        { content_type: 'partner_asset', funnel_stage: 'bof', title_suffix: 'partner asset update' }]],
    ];
    for (const [name, trig, kids] of templates)
      await pool.query(`INSERT INTO chain_templates (name, trigger_stage, children) VALUES ($1,$2,$3)`,
        [name, trig, JSON.stringify(kids)]);
  }

  // Consolidate the video "Recorded" + "Uploaded" stages into one "Recorded & shared with editor" (id 'shared').
  await pool.query(`UPDATE cards SET stage='shared' WHERE stage='recorded'`);
  await pool.query(`UPDATE chain_templates SET trigger_stage='shared' WHERE trigger_stage='recorded'`);

  const seeded = await pool.query(`SELECT v FROM meta WHERE k = 'seeded'`);
  if (seeded.rowCount === 0) {
    await seedCards();
    await pool.query(`INSERT INTO meta (k, v) VALUES ('seeded', 'true')
                      ON CONFLICT (k) DO NOTHING`);
  }

  // Seed the idea bank independently so existing deploys also get populated.
  const bankCount = await pool.query('SELECT COUNT(*)::int AS n FROM bank_items');
  if (bankCount.rows[0].n === 0) await seedBank();
}

export const bankCategories = BANK_CATEGORIES;

async function seedBank() {
  let pos = 0;
  for (const category of BANK_CATEGORIES) {
    for (const text of BANK[category]) {
      await pool.query(
        `INSERT INTO bank_items (id, category, text, done, position)
         VALUES ($1,$2,$3,FALSE,$4)`,
        ['bk' + pos, category, text, pos]
      );
      pos++;
    }
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
  await pool.query('DELETE FROM bank_items');
  await seedCards();
  await seedBank();
}
