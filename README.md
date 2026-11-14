# BudgetGuard

> **Give us your ad + budget. We spend it optimally on Meta, 24/7.**
> Not a rule builder. An autopilot for Meta budget.

BudgetGuard protects small business owners from Meta's overspend behavior and wasted
ad spend: it **pauses losers, scales winners and hard-caps spend**, explaining every
decision in plain English. Built for people who check Ads Manager once a week and are
scared of what happens overnight.

---

## Architecture

**One codebase, two deployable processes** (+ a shared web app):

```
┌─────────────────────┐         ┌──────────────────────────┐
│  WEB APP (Next.js)  │         │  WORKER (Node, cron 15m) │
│  - signup/login     │         │  1. read configs ◄───────┼── PostgreSQL
│  - Meta OAuth       │         │  2. fetch insights ◄─────┼── Meta Marketing API
│  - dashboard        │         │  3. run ENGINE (pure)    │
│  - settings/billing │         │  4. execute actions ────►│── Meta Marketing API
└─────────────────────┘         │  5. log everything       │
          │                     └──────────────────────────┘
          └────────────────────► PostgreSQL (shared)
```

| Package | What it is | Key rule |
| --- | --- | --- |
| `packages/engine` | **The heart**: pure rule engine (G1–G3 guardrails, B1–B4 strategy rules). Zero I/O — takes a snapshot, returns decisions. | Must stay dependency-free and 100% unit-tested |
| `packages/db` | Prisma schema (PostgreSQL, 6 tables) + AES-256-GCM token encryption | Tokens are NEVER logged or stored unencrypted |
| `packages/meta` | Thin typed Meta Marketing API client (insights, pause/resume, budgets, token exchange) with rate-limit backoff | Only place that talks to Graph API |
| `apps/worker` | 15-minute cron loop: fetch → decide → execute (or dry-run) → log → alert | `DRY_RUN=true` never mutates Meta |
| `apps/web` | Next.js 16 + Tailwind 4 + shadcn/ui — landing + dashboard | Dashboard reads `daily_stats`, never Meta |

### Why the engine is pure

- **Unit-testable**: "spend $62, 0 purchases, CPA $58 → PAUSE" is a 3-line test.
- **Dry-run mode**: run against live data, log every decision, mutate nothing. For a
  product whose success metric is *trust*, this is the killer beta feature.
- **Backtestable**: replay the engine over historical `daily_stats` later.

## The rules (spec §5)

**Guardrails — run first every 15 min; a hit stops all further checks:**

- **G1 Hard daily cap** — spend today ≥ cap → pause all + alert, auto-resume 00:00 next day
  (Meta itself can overspend a daily budget by up to ~75%; we prevent that)
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
#    → set DATABASE_URL, APP_ENCRYPTION_KEY (openssl rand -hex 32), WORKER_SECRET

# 3. Database
npm run db:up                                   # Postgres in Docker
cd packages/db && npx prisma db push && cd ../..

# 4. Seed a dev campaign (dryRun=true — safe)
npm run db:seed

# 5. Test the engine + Meta client (vitest, fully offline)
npm test

# 6. Run the worker (DRY_RUN=true by default — safe)
npm run worker            # cron every 15 min + HTTP trigger on :3001
npm run worker:check-once # single check, exits — for external crons

# 7. Run the web app
npm run web               # Next.js on :3000
```

### Database

PostgreSQL. Six tables (spec §6): `users`, `meta_accounts`, `campaigns`, `rules`,
`action_logs`, `daily_stats`. See `packages/db/prisma/schema.prisma`.
The dashboard reads `daily_stats` — never the Meta API.

## Testing — three tiers

`npm test` runs every workspace's vitest suite offline: the engine rules (35 tests)
plus the Meta client against a **mocked Graph API** (requests, normalization, error
redaction, rate-limit retry, token exchange). Beyond that, the app is tested against
a real Meta **test ad account**:

| Tier | What you verify | Needs real Meta? | Needs DB? |
| --- | --- | --- | --- |
| 0 — unit | Engine rules, client parsing/errors/retries | no (mocked) | no |
| 1 — dry-run, dummy token | Worker loop end-to-end, `action_logs` rows | no | yes |
| 2 — dry-run vs test account | Real insights fetched, decisions logged, **zero mutations** | yes | yes |
| 3 — live on test account | Real pauses / budget writes on fake money | yes | yes |

### Local setup (Tier 0/1)

```bash
npm run db:up                                # Postgres in Docker (docker-compose.yml)
npm run db:push --workspace @budgetguard/db  # create tables
npm run db:seed                              # dev user + test campaign, dryRun=true
npm run worker:check-once                    # one full check cycle
psql "$DATABASE_URL" -c "select rule_id, action, is_dry_run, reason from action_logs order by created_at desc limit 20;"
```

With no real token, Meta calls fail with code 190 — the worker records the error,
marks the token expired and exits cleanly. That *is* Tier 1: the loop, logging and
failure paths all work without touching Meta.

### Tier 2/3 — Meta test ad account

1. In Business Settings → **Ad Accounts**, create an account marked **Test**
   (fake money, ads never reach real people). Create a fake campaign + ad set in it.
2. [Graph API Explorer](https://developers.facebook.com/tools/explorer) → select your
   app → add `ads_read` + `ads_management` → pick the **test ad account** in the
   token dropdown → Generate Access Token.
3. Re-seed with the real token (stored AES-256-GCM encrypted):
   ```bash
   DEV_META_TOKEN=EAAB... DEV_AD_ACCOUNT_ID=act_123 DEV_CAMPAIGN_ID=456789 npm run db:seed
   ```
4. `npm run worker:check-once` — the global `DRY_RUN` default plus the campaign's
   `dry_run=true` mean every decision is logged, nothing is mutated (Tier 2).
5. Tier 3: flip **one** campaign only, keep the global switch as belt-and-braces:
   ```bash
   psql "$DATABASE_URL" -c "update campaigns set dry_run = false where id = '<campaign-uuid>';"
   ```
   `DRY_RUN=true` in `.env` still wins — remove it there only when you truly mean it.
   This is also the phase that produces the `ads_management` usage evidence Meta
   wants for **App Review**.

## Deployment (Railway / Render / Fly.io)

- **web**: `npm run build && npm start` inside `apps/web` (or any Next.js host / Vercel)
- **worker**: one service, `npm start` in `apps/worker` — built-in cron, no extra queue
  infra needed for MVP. Exposes `POST /internal/worker/check-all`
  (header `x-worker-secret`) for external schedulers too.
- **database**: any managed Postgres (Railway/Supabase/Neon). Run `prisma db push` once.

**Rollout safety ladder:** `DRY_RUN=true` (log only) → review a week of action_logs →
flip `dry_run=false` per campaign → scale.

## Meta app setup (do this first — longest lead time)

1. Create an app at [developers.facebook.com](https://developers.facebook.com)
2. Add the **Marketing API** product; request `ads_read` + `ads_management`
3. Development Mode works immediately with your own ad accounts (enough for building
   and the first beta users); submit **App Review** early — it takes days–weeks
4. MVP tokens: exchange the OAuth short-lived token for a **~60-day long-lived token**
   (`MetaClient.exchangeLongLivedToken`) — the worker alerts 7 days before expiry
5. Never log tokens; they're AES-256-GCM encrypted at rest (`packages/db/src/crypto.ts`)

## Roadmap (spec §10 — 4-week MVP build order)

- [x] Week 0 — monorepo, engine (G1–G3 + B1–B4) with 35 passing tests, schema,
      Meta client, worker skeleton, landing + dashboard UI
- [ ] Week 1 — auth + Meta OAuth connect + campaign picker wired end-to-end
- [ ] Week 2 — engine live against a real account (G1 + B1 first), dashboard KPIs from DB
- [ ] Week 3 — B2/B3 live, Slack/email alerts, Stripe billing
- [ ] Week 4 — weekly report email ("You saved $132 last week"), polish, 20 beta users

**Success metric for MVP: not revenue — trust.** 20 beta users keep autopilot ON for
30 days → product-market fit.

## License

Private — all rights reserved.
