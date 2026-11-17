# BudgetGuard

> **Give us your ad + budget. We spend it optimally on Google Ads, 24/7.**
> Not a rule builder. An autopilot for Google Ads budget.

BudgetGuard protects small business owners from Google Ads' overspend behavior and
wasted ad spend: it **pauses losers, scales winners and hard-caps spend**, explaining
every decision in plain English. Built for people who check Google Ads once a week
and are scared of what happens overnight.

---

## Architecture

**One codebase, two deployable processes** (+ a shared web app):

```
┌─────────────────────┐         ┌──────────────────────────┐
│  WEB APP (Next.js)  │         │  WORKER (Node, cron 15m) │
│  - signup/login     │         │  1. read configs ◄───────┼── PostgreSQL
│  - Google OAuth     │         │  2. fetch metrics ◄──────┼── Google Ads API (GAQL)
│  - dashboard        │         │  3. run ENGINE (pure)    │
│  - settings/billing │         │  4. execute actions ────►│── Google Ads API (mutations)
└─────────────────────┘         │  5. log everything       │
          │                     └──────────────────────────┘
          └────────────────────► PostgreSQL (shared)
```

| Package | What it is | Key rule |
| --- | --- | --- |
| `packages/engine` | **The heart**: pure rule engine (G1–G3 guardrails, B1–B4 strategy rules). Zero I/O — takes a snapshot, returns decisions. | Must stay dependency-free and 100% unit-tested |
| `packages/db` | Prisma schema (PostgreSQL, 6 tables) + AES-256-GCM token encryption | Tokens are NEVER logged or stored unencrypted |
| `packages/google` | Thin typed Google Ads API client (GAQL metrics, pause/resume ad groups, campaign budget updates, OAuth token refresh) with rate-limit backoff | Only place that talks to googleads.googleapis.com |
| `apps/worker` | 15-minute cron loop: fetch → decide → execute (or dry-run) → log → alert | `DRY_RUN=true` never mutates Google Ads |
| `apps/web` | Next.js 16 + Tailwind 4 + shadcn/ui — landing + dashboard | Dashboard reads `daily_stats`, never the Ads API |

### Why the engine is pure

- **Unit-testable**: "spend $62, 0 purchases, CPA $58 → PAUSE" is a 3-line test.
- **Dry-run mode**: run against live data, log every decision, mutate nothing. For a
  product whose success metric is *trust*, this is the killer beta feature.
- **Backtestable**: replay the engine over historical `daily_stats` later.

## The rules (spec §5)

**Guardrails — run first every 15 min; a hit stops all further checks:**

- **G1 Hard daily cap** — spend today ≥ cap → pause all + alert, auto-resume 00:00 next day
  (Google itself can overspend a daily budget by up to ~2× on high-traffic days; we prevent that)
- **G2 Hard monthly cap** — spend MTD ≥ monthly budget → pause all + alert
- **G3 Spend spike** — 1h spend > 50% of daily cap → pause all + alert

**Strategy rules (per ad set, in order B1 → B3 → B2, B4 last):**

- **B1 Stop-loss** — spend 3d > $50 AND purchases = 0 → pause *(all strategies)*
- **B3 Slow bleed** — spend 3d > $75 AND ROAS < 1.0 AND purchases > 0 → budget −30%
- **B2 Scale winner** — ROAS 3d ≥ 3.5 (balanced) / 2.5 (aggressive), CPA ≤ target,
  frequency < 3.5 → budget +20% / +30%, **max 1 change per 6h / 3h** (protects the
  learning phase)
- **B4 Creative fatigue** — frequency 7d > 4.0 AND CTR dropped < 70% of 30d baseline → alert only

**Strategies:** `balanced` (all rules) · `protect` (guardrails + B1 only, never
increases budgets) · `aggressive` (B1/B3/B2/B4 with harder thresholds).

**Idempotency:** never re-pause a paused ad set; never change a budget inside the
cooldown (checked in the engine AND re-checked against `action_logs` at execution).

## Quickstart

```bash
# 1. Install (Node 20+; npm workspaces)
npm install

# 2. Configure
cp .env.example .env
#    → set DATABASE_URL, APP_ENCRYPTION_KEY (openssl rand -hex 32), WORKER_SECRET,
#      GOOGLE_ADS_CLIENT_ID + GOOGLE_ADS_CLIENT_SECRET (see setup below)

# 3. Database
npm run db:up                                   # Postgres in Docker
cd packages/db && npx prisma db push && cd ../..

# 4. Seed a dev campaign (dryRun=true — safe)
npm run db:seed

# 5. Test the engine + Google Ads client (vitest, fully offline)
npm test

# 6. Run the worker (DRY_RUN=true by default — safe)
npm run worker            # cron every 15 min + HTTP trigger on :3001
npm run worker:check-once # single check, exits — for external crons

# 7. Run the web app
npm run web               # Next.js on :3000
```

### Database

PostgreSQL. Six tables (spec §6): `users`, `google_accounts`, `campaigns`, `rules`,
`action_logs`, `daily_stats`. See `packages/db/prisma/schema.prisma`.
The dashboard reads `daily_stats` — never the Google Ads API.

## Testing — three tiers

`npm test` runs every workspace's vitest suite offline: the engine rules (35 tests)
plus the Google Ads client against a **mocked Ads API** (GAQL requests, micros→cents
normalization, error redaction, rate-limit retry, OAuth token refresh, pagination).
Beyond that, the app is tested against a real Google Ads **test account**:

| Tier | What you verify | Needs real Google? | Needs DB? |
| --- | --- | --- | --- |
| 0 — unit | Engine rules, client parsing/errors/retries | no (mocked) | no |
| 1 — dry-run, dummy token | Worker loop end-to-end, `action_logs` rows | no | yes |
| 2 — dry-run vs test account | Real metrics fetched, decisions logged, **zero mutations** | yes | yes |
| 3 — live on test account | Real pauses / budget writes on fake money | yes | yes |

### Local setup (Tier 0/1)

```bash
npm run db:up                                # Postgres in Docker (docker-compose.yml)
npm run db:push --workspace @budgetguard/db  # create tables
npm run db:seed                              # dev user + test campaign, dryRun=true
npm run worker:check-once                    # one full check cycle
psql "$DATABASE_URL" -c "select rule_id, action, is_dry_run, reason from action_logs order by created_at desc limit 20;"
```

With no real token, Google calls fail with HTTP 401 — the worker records the error,
marks the account expired and exits cleanly. That *is* Tier 1: the loop, logging and
failure paths all work without touching Google.

### Tier 2/3 — Google Ads test account

1. Get test accounts (fake money — ads never reach real people) per Google's
   [test accounts guide](https://developers.google.com/google-ads/api/docs/best-practices/test-accounts),
   and create a fake campaign + ad group in the test account.
2. Mint an OAuth **refresh token** with scope `https://www.googleapis.com/auth/adwords`
   via [OAuth Playground](https://developers.google.com/oauthplayground) (use your own
   client credentials). Refresh tokens don't expire unless revoked.
3. Re-seed with the real token (stored AES-256-GCM encrypted):
   ```bash
   DEV_REFRESH_TOKEN=1//0x... DEV_CUSTOMER_ID=1234567890 DEV_CAMPAIGN_ID=2223334444 npm run db:seed
   ```
4. `npm run worker:check-once` — the global `DRY_RUN` default plus the campaign's
   `dry_run=true` mean every decision is logged, nothing is mutated (Tier 2).
5. Tier 3: flip **one** campaign only, keep the global switch as belt-and-braces:
   ```bash
   psql "$DATABASE_URL" -c "update campaigns set dry_run = false where id = '<campaign-uuid>';"
   ```
   `DRY_RUN=true` in `.env` still wins — remove it there only when you truly mean it.

## Deployment (Railway / Render / Fly.io)

- **web**: `npm run build && npm start` inside `apps/web` (or any Next.js host / Vercel)
- **worker**: one service, `npm start` in `apps/worker` — built-in cron, no extra queue
  infra needed for MVP. Exposes `POST /internal/worker/check-all`
  (header `x-worker-secret`) for external schedulers too.
- **database**: any managed Postgres (Railway/Supabase/Neon). Run `prisma db push` once.

**Rollout safety ladder:** `DRY_RUN=true` (log only) → review a week of action_logs →
flip `dry_run=false` per campaign → scale.

## Google Ads API setup (do this first — ~15 minutes)

1. Create/select a project at [console.cloud.google.com](https://console.cloud.google.com)
   and **enable the Google Ads API** — that grants automatic **Test** access
   (15,000 ops/day, test accounts only). Since Sept 2026 access is managed per
   Cloud project; the old developer-token/API-Center flow is retired (the client
   still sends a `developer-token` header if you configure one, for compatibility).
2. OAuth consent screen (External, add yourself as a test user) → create an
   **OAuth 2.0 client** (Web application) → put id + secret in `.env`
3. Mint a refresh token via [OAuth Playground](https://developers.google.com/oauthplayground)
   with scope `https://www.googleapis.com/auth/adwords`
4. For production accounts later: apply for **Explorer** (test + production,
   auto-reviewed in most cases) or **Basic/Standard** access — same Cloud project
5. Never log tokens; they're AES-256-GCM encrypted at rest (`packages/db/src/crypto.ts`)

## Roadmap (spec §10 — 4-week MVP build order)

- [x] Week 0 — monorepo, engine (G1–G3 + B1–B4) with 35 passing tests, schema,
      Google Ads client (20 tests), worker skeleton, landing + dashboard UI
- [ ] Week 1 — auth + Google OAuth connect + campaign picker wired end-to-end
- [ ] Week 2 — engine live against a real account (G1 + B1 first), dashboard KPIs from DB
- [ ] Week 3 — B2/B3 live, Slack/email alerts, Stripe billing
- [ ] Week 4 — weekly report email ("You saved $132 last week"), polish, 20 beta users

**Success metric for MVP: not revenue — trust.** 20 beta users keep autopilot ON for
30 days → product-market fit.

## License

Private — all rights reserved.
