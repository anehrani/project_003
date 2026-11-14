# BudgetGuard — Project Plan

> **Autopilot budget guard for Meta Ads.** Not a rule builder — an autopilot.
> _Give us your ad + budget. We spend it optimally on Meta, 24/7._

| | |
|---|---|
| **Version** | 2.0 — clean rewrite |
| **Date** | November 14, 2026 |
| **Owner** | Anehrani |
| **Repo** | `github.com/anehrani/project_003` (SSH deploy key, `main` @ `3b6af92`) |
| **Status** | Week 0 complete — MVP build, Week 1 starting |
| **MVP success metric** | **Trust, not revenue**: 20 beta users keep autopilot ON for 30 days |

---

## 1. Executive Summary

BudgetGuard is an autonomous budget-protection layer for small business owners advertising on Meta (Facebook / Instagram). Meta can overspend a daily budget by up to ~75%, bleeds spend on losing ad sets, and gives no overnight supervision — and the people who can least afford it check Ads Manager once a week. BudgetGuard plugs into a user's ad account through the Marketing API, checks every 15 minutes, and does exactly three things: **pause losers, scale winners, and hard-cap spend** — explaining every decision in plain English in an auditable log.

The core differentiator is architecture: the decision logic is a **pure, dependency-free rule engine** (3 guardrails, 4 strategy rules, 3 strategies) that is 100% unit-tested (35 tests), dry-runnable against live accounts without mutating anything, and replayable over historical data. For a product whose success metric is *trust*, this is the killer feature: beta users can watch the autopilot reason for a week before it earns write access to their budget.

This plan covers the 4-week MVP build (Week 0 complete), the exact rule specification, the data model and security posture, the owner's external setup checklist (Meta app use case, App Review, hosting, billing), risks, and the beta program that defines product-market fit.

## 2. Product Overview

### 2.1 Problem

Small advertisers on Meta face three recurring, expensive failure modes:

1. **Overspend** — Meta treats a "daily budget" as a target, not a cap; actual daily spend can exceed it by up to ~75%.
2. **Slow bleed** — ad sets with no purchases keep spending for days because nobody is watching at 2am.
3. **Missed winners** — winning ad sets stay at conservative budgets because scaling manually requires vigilance the owner doesn't have.

Existing tools (AdEspresso, Revealbot, Madgicx) are rule *builders*: powerful, but they shift the work to configuring hundreds of conditions — exactly the complexity the SMB owner is escaping. Meta's own AI assistant advises but does not autonomously execute and audit.

### 2.2 Solution

One connect flow, one toggle per campaign, three preset strategies. The user picks a campaign, a strategy (`balanced` / `protect` / `aggressive`), a monthly budget and a daily cap; BudgetGuard's worker checks every 15 minutes and acts within those hard limits. Every action — pause, budget change, alert, and even "checked, nothing to do" — lands in a plain-English action log with the metrics snapshot that justified it.

### 2.3 Target user & pricing

SMB e-commerce and local-service advertisers spending $500–$10k/month on Meta who have no agency retainer. Pricing (14-day free trial on all tiers):

| Plan | Price | Accounts | Managed spend | Differentiators |
|---|---|---|---|---|
| Starter | $29/mo | 1 | up to $2k/mo | Balanced strategy, dashboard + action log, email alerts |
| Pro | $99/mo | 3 | up to $10k/mo | All 3 strategies, Slack alerts, weekly report email |
| Agency | $249/mo | 10 | up to $50k/mo | Client-ready weekly reports, priority support |

## 3. MVP Scope

**In scope (MVP):** email/password auth; Meta OAuth connect (long-lived token, AES-256-GCM encrypted at rest); campaign picker with strategy/budget/CPA configuration; the 7-rule autopilot (G1–G3, B1–B4); 15-minute check loop; dashboard fed exclusively from the local `daily_stats` cache (never the Meta API); Slack + email alerts; Stripe billing; weekly report email; dry-run safety mode.

**Out of scope (post-MVP):** custom rule builder (the `rules` table is pre-seeded per strategy for MVP and becomes the builder later); other ad platforms (Google/TikTok); multi-user teams & roles; native mobile apps; backtesting UI (the engine is replayable, but no UI yet).

**Product-market fit definition:** 20 beta users keep autopilot ON for 30 consecutive days. Engagement metric is retention of the toggle, not logins.

## 4. System Architecture

One codebase, two deployable processes, one database.

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

| Package | Role | Hard rule |
|---|---|---|
| `packages/engine` | Pure rule engine — G1–G3 guardrails, B1–B4 strategy rules. Zero I/O: takes a snapshot, returns decisions. | Dependency-free, 100% unit-tested (35 tests) |
| `packages/db` | Prisma schema (PostgreSQL, 6 tables) + AES-256-GCM token encryption | Tokens never logged, never stored unencrypted |
| `packages/meta` | Thin typed Marketing API client: insights, pause/resume, budget updates, token exchange; rate-limit backoff with usage callback | Only place that talks to Graph API (v23.0) |
| `apps/worker` | 15-min cron loop: fetch → decide → execute (or dry-run) → log → alert. Also exposes `POST /internal/worker/check-all` (`x-worker-secret`) and `/healthz` | `DRY_RUN=true` never mutates Meta |
| `apps/web` | Next.js 16 + Tailwind 4 + shadcn/ui — landing, dashboard demo, auth & settings (W1+) | Dashboard reads `daily_stats`, never Meta |

**Why the engine is pure:** unit-testable ("spend $62, 0 purchases, CPA $58 → PAUSE" is a 3-line test), dry-runnable against live data, and backtestable over historical `daily_stats`. CI (GitHub Actions) runs the engine tests plus typecheck across all five workspaces on every push.

## 5. Autopilot Rule Engine

### 5.1 Execution order (critical)

Guardrails run first every 15 minutes; **a guardrail hit pauses everything and skips all strategy rules for that run**. Strategy rules then run per ad set in fixed order B1 → B3 → B2, with B4 last (alert only).

### 5.2 Guardrails (G1–G3)

| Rule | Trigger | Action | Recovery |
|---|---|---|---|
| **G1 Hard daily cap** | Spend today ≥ daily cap | Pause all active ad sets + critical alert | **Auto-resume at 00:00** next day |
| **G2 Hard monthly cap** | Spend month-to-date ≥ monthly budget | Pause all + critical alert | User raises monthly budget in settings |
| **G3 Spend spike** | 1-hour spend > 50% of daily cap | Pause all + critical alert | Manual review (anomaly suspected) |

G1 exists because Meta itself can overspend a daily budget by up to ~75%; G3 is the runaway-campaign circuit breaker.

### 5.3 Strategy rules (B1–B4)

| Rule | Trigger (3-day window unless noted) | Action | Strategies |
|---|---|---|---|
| **B1 Stop-loss** | Spend > $50 AND purchases = 0 (CPA unbounded — fires even without a target CPA) | Pause ad set | All, incl. protect |
| **B3 Slow bleed** | Spend > $75 AND ROAS < 1.0 AND purchases > 0 | Budget −30% (floor $1/day) | Balanced, aggressive |
| **B2 Scale winner** | ROAS ≥ 3.5 (balanced) / 2.5 (aggressive); CPA ≤ target (if set); frequency < 3.5 | Budget +20% / +30%, clamped to daily cap; max 1 change per 6h / 3h | Balanced, aggressive |
| **B4 Creative fatigue** | 7-day frequency > 4.0 AND 7-day CTR < 70% of 30-day baseline | Alert only (suggest new creative) | Balanced, aggressive |

B2's cooldown (6h/3h) stays far below Meta's ~4-changes/hour limit so scaling never resets the learning phase. B2 never pushes an ad set past the user's daily cap.

### 5.4 Strategies

`balanced` — all rules with standard thresholds · `protect` — guardrails + B1 only, never touches budgets · `aggressive` — all rules with harder thresholds (earlier scaling).

### 5.5 Safety properties

- **Idempotency:** never re-pause a paused ad set; budget cooldown enforced in the engine *and* re-checked against `action_logs` at execution time.
- **Dry-run mode:** global `DRY_RUN` env kill-switch + per-campaign `dry_run` column. Engine runs and logs every decision; no Meta mutation. This is the beta trust ladder: `DRY_RUN=true` → review one week of logs → flip per campaign.
- **Full audit trail:** every decision, including alerts and no-ops, is written to `action_logs` with a metrics snapshot and the sanitized Meta API response.

## 6. Data Model & Security

PostgreSQL, six tables (money always stored as integer **cents**):

| Table | Purpose | Notable columns |
|---|---|---|
| `users` | Account + plan + Slack webhook | email (unique), password_hash, plan (Starter/Pro/Agency) |
| `meta_accounts` | Connected ad accounts | `access_token` **AES-256-GCM encrypted**, token_expires_at, status |
| `campaigns` | The thing we protect | strategy, monthly/daily budgets, CPA/ROAS targets, `is_autopilot_on`, `dry_run` |
| `rules` | Per-campaign rule instances | Pre-seeded per strategy in MVP → custom builder post-MVP |
| `action_logs` | Audit trail (non-negotiable) | action, rule, reason, metrics snapshot, old/new cents, is_dry_run, sanitized API response |
| `daily_stats` | Per-day metrics cache | Dashboard's only data source — never queries Meta |

**Security posture:** OAuth short-lived token exchanged once for a ~60-day long-lived token (`MetaClient.exchangeLongLivedToken`); worker alerts 7 days before expiry. Tokens are encrypted at rest (AES-256-GCM, `APP_ENCRYPTION_KEY`), sent only in the Authorization header, never logged and never present in stored responses. The worker HTTP surface is protected by `WORKER_SECRET`.

## 7. Four-Week Roadmap & Milestones

| Week | Scope | Exit criteria |
|---|---|---|
| **0 — Foundations** ✅ | Monorepo, engine (G1–G3 + B1–B4) with 35 passing tests, Prisma schema, Meta client, worker skeleton, landing + interactive dashboard demo, CI | Repo pushed; engine tests green in CI |
| **1 — Connect & configure** | Email/password auth (sessions), Meta OAuth connect → callback → long-lived token encrypted & stored, campaign picker (list campaigns, set strategy/budgets/targets), `prisma db push` against live Postgres | A real account connects and configures a campaign end-to-end |
| **2 — Engine goes live (read-only)** | Worker runs the engine against the real connected account: G1 + B1 live first, everything else dry-run; dashboard KPIs wired to `daily_stats` | A week of `action_logs` proves correct decisions on live data |
| **3 — Act + alert + bill** | B2/B3 live, dry-run off per campaign after log review; Slack + email alert delivery; Stripe checkout + plan gating | Autopilot mutates budgets on a real account; billing live |
| **4 — Trust & beta** | Weekly report email ("You saved $132 last week"), copy/polish, onboarding checklist, 20 beta users invited as app Testers | 20 testers onboarded, autopilot toggles ON |

**Long-lead dependency (owner, start now):** Meta App Review for `ads_management` + `ads_read` advanced access — days to weeks. Development Mode already works with the owner's own ad account for building and the first testers, so review latency does not block Weeks 1–2.

## 8. External Setup & Account Prerequisites (owner)

| # | Task | Where | Status |
|---|---|---|---|
| 1 | Create Meta app; add use case **"Create & manage ads with Marketing API"** (bundles `ads_management`, `ads_read`, `business_management`, auto-adds Facebook Login for Business + Webhooks) | developers.facebook.com | ☐ |
| 2 | Save `META_APP_ID` + `META_APP_SECRET` into `.env` (never committed) | same | ☐ |
| 3 | Submit **App Review** (advanced access `ads_management`, `ads_read`) — screencast: connect → dashboard → autopilot pause | App Review → Permissions & Features | ☐ |
| 4 | Create PostgreSQL (Neon / Supabase / Railway free tier) → `DATABASE_URL` | neon.tech | ☐ |
| 5 | Host web (Vercel) + worker (Railway/Render/Fly — needs long-running process) | vercel.com, railway.app | ☐ |
| 6 | Stripe account (Week 3), Resend (email alerts + weekly report), Slack Incoming Webhook (test channel) | stripe.com, resend.com | ☐ |
| 7 | Invite first beta users as **Testers** in app Roles (bypasses App Review) | App dashboard → Roles | ☐ |

**Environment variables** (`.env`, gitignored — see `.env.example`): `DATABASE_URL`, `APP_ENCRYPTION_KEY` (`openssl rand -hex 32`), `WORKER_SECRET`, `META_APP_ID`, `META_APP_SECRET`, `META_API_VERSION=v23.0`, `DRY_RUN=true`.

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Meta App Review delayed beyond Week 3 | Medium | High | Start review Day 1; build & beta against own account in Dev Mode; testers via Roles |
| Platform/API churn (Graph API version deprecations) | Medium | Medium | API version pinned in env (`v23.0`); thin client isolates changes; changelog watch |
| Wrong autopilot decision damages user trust | Low | **Critical** | Dry-run ladder; G-guardrails first; audit log + metrics snapshot for every action; conservative defaults |
| Token expiry silently breaks monitoring | Medium | High | 60-day tokens with 7-day expiry alert; `status: EXPIRED` handling; re-connect flow |
| Rate limits (error 613) at scale | Low | Medium | Backoff + usage snapshot in client; check interval 15 min per campaign is well under limits |
| Single-worker cron misses ticks under load | Low | Medium | Re-entrancy guard; external scheduler hook (`POST /internal/worker/check-all`) as failover |

## 10. Success Metrics & Beta Program

- **North star (MVP):** 20 beta users with autopilot ON for 30 consecutive days → PMF signal.
- **Trust metrics:** % of actions user re-enables after (target > 90%); G1/G2 false-positive rate (target ~0); time-to-first-action after connect (< 24h).
- **Financial proof:** weekly report quantifies prevented waste (paused losers' 3-day spend) and captured upside (winner budget increases) — the retention engine of the product.
- **Beta mechanics:** invite as app **Testers** while App Review is pending; everyone starts in `DRY_RUN=true`, flips per campaign after reviewing their first week of logs together.

## 11. Current Status & Immediate Next Actions

**Done (Week 0):** monorepo with npm workspaces; `packages/engine` (7 rules, 3 strategies, 35 passing tests); `packages/db` (Prisma schema, AES-256-GCM crypto); `packages/meta` (insights, pause/resume, budgets, token exchange, backoff); `apps/worker` (15-min cron + HTTP trigger + health check); `apps/web` (Next.js 16 landing + interactive dashboard demo); GitHub Actions CI; repo at `github.com/anehrani/project_003` `main @ 3b6af92` (SSH deploy key).

**Next actions:**

1. **Owner (today):** Meta app + use case (§8.1–8.2) and App Review submission (§8.3); create the Postgres database (§8.4).
2. **Owner:** re-verify the repo **deploy key is still present** in *Settings → Deploy keys* with write access (an auth check from the build environment was recently rejected; the key pair itself is intact and unchanged).
3. **Builder (Week 1, in repo):** auth, OAuth connect flow, campaign picker, live DB migration — per §7.
4. **Both:** when `META_APP_ID` / `META_APP_SECRET` / `DATABASE_URL` land in `.env`, wire OAuth + `prisma db push` same day.
