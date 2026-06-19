# Charm Content Pipeline

Shared, live tracker for all Charm marketing content. One URL the whole team
(Sarah, Chris, Leo) updates from. Postgres-backed, so the URL is the single
source of truth — no more per-browser copies.

Built from `charm-content-pipeline-master.md`.

## What it tracks

- **Pipeline board** — 7-stage kanban (Planned → Recorded → Shared → In edit →
  Scheduled → Live → Reviewed). Drag cards; owner auto-updates to whoever holds
  the stage. The 8 ads + 2 VSLs are pre-seeded. Filter by track / owner.
  Stuck cards (no movement in 7+ days) get a red dot; ⚠ flags blockers.
- **Rolling weeks** — timeline anchored to **Mon Jun 15, 2026 (Sprint 1)**.
  Each week shows what's recording (Chris), what's due live from the prior batch,
  and what actually went live. Plus velocity metrics (total live, live this week,
  avg record→live cycle time, overdue, stuck) and the whole-pipeline funnel.
- **Leo's idea bank** — the 50-item inbound reservoir, checkable + promotable
  into the pipeline.
- **Cadence & rules** — the Thursday/Mon-Tue/Wed loop, roles, specs.

## Stack

- Node 20 + Express, `pg` for Postgres
- Static frontend in `public/` (no build step)
- REST API: `GET /api/state`, `POST/PUT/DELETE /api/cards`, `PUT /api/bank`, `POST /api/reset`
- Auto-seeds the 10 sprint assets on first boot (tracked via a `meta` flag, so
  restarts/redeploys do not re-seed or wipe data).

## Run locally

```bash
npm install
# needs a local Postgres; create the db once:
createdb charm_content_pipeline
cp .env.example .env        # adjust DATABASE_URL if needed
npm start                   # → http://localhost:3000
```

## Deploy on Coolify (same server as the other Charm apps)

1. **Push this folder to a Git repo** (e.g. `saribachi/charm-content-pipeline`,
   matching the convention used by `charm-disco-booked`).
2. **Start a Postgres** in Coolify (the existing `charm-postgres` is currently
   stopped — either start it and create a `charm_content_pipeline` database, or
   add a new Postgres resource dedicated to this app). Note the connection string.
3. **New Application → from Git**, Dockerfile build pack, this repo / `main`.
4. **Env vars:** set `DATABASE_URL` to the Postgres connection string. Add
   `PGSSL=require` if the DB connection needs SSL.
5. **Domain:** point a subdomain at it — suggested `content.hirecharm.com`
   (keep it separate from the client-facing `go.hirecharm.com` discovery app).
6. Deploy. The schema + seed run automatically on first boot.

To wipe back to the master-doc defaults later, hit the **Reset** button in the UI
(or `POST /api/reset`). Note this clears everyone's shared changes.

## Slack board-update alerts

Any change to the pipeline (card created, moved between stages, edited, or
deleted — plus a full reset) posts a notification to **#marketing-pipeline-updates**.
A burst of edits/drags is coalesced into **one** digest message after a short
window (`SLACK_DEBOUNCE_MS`, default 20s) so the channel never gets spammed.

**Handoff to Leo:** when a card reaches the **Uploaded** stage (internal id
`shared`), instead of the generic digest it sends a dedicated "ready to edit"
message that **@-mentions Leo** (`LEO_SLACK_ID`, default his user id) and links
the matching Drive folder (GTM or CS-Flex, by the card's track). A batch of
uploads in one window coalesces into a single message that tags him once.

To enable:

1. In Slack, create an **Incoming Webhook** (https://api.slack.com/apps → your
   app → *Incoming Webhooks* → *Add New Webhook to Workspace*) and point it at
   **#marketing-pipeline-updates**. Copy the `https://hooks.slack.com/services/…` URL.
2. Set Coolify env `SLACK_WEBHOOK_URL` to that URL (optionally `APP_URL` and
   `SLACK_DEBOUNCE_MS`) and redeploy.

If `SLACK_WEBHOOK_URL` is unset the app runs normally with alerts off (logged on boot).
