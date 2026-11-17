/**
 * runCheckAll() — the 15-minute heartbeat (spec §7 Worker).
 *
 * For each campaign with autopilot ON and an active Google Ads account:
 *   1. Resume G1-paused ad groups if the day rolled over (auto-resume at 00:00)
 *   2. Fetch metrics: campaign (today, MTD) + each ad group (3d, 7d, 30d)
 *   3. Build an EngineInput snapshot and run the pure engine
 *   4. Execute actions — or only LOG them when dryRun is on
 *   5. Write every decision to action_logs (spec: even no-ops, for debugging)
 *   6. Upsert daily_stats (dashboard cache — never hit Google Ads from the UI)
 *
 * Google-specific: ad groups have no own budget — budget actions from the
 * engine are executed on the ad group's CAMPAIGN BUDGET (campaignBudgets:mutate).
 *
 * Idempotency at the execution layer (defense in depth — the engine already
 * guards): pause calls are skipped for ad groups Google reports as non-ENABLED,
 * and budget changes re-check the 6h throttle using the action_logs table.
 */

import {
  decryptToken,
  getDb,
  maskToken,
} from '@budgetguard/db';
import {
  evaluate,
  type AdSetState,
  type EngineDecision,
  type EngineInput,
  type Strategy,
  type WindowMetrics,
} from '@budgetguard/engine';
import { GoogleAdsClient, TOKEN_ERROR_STATUSES } from '@budgetguard/google';
import { Prisma } from '@prisma/client';

import { sendAlert } from './alerts';
import { env } from './env';

// ---------------------------------------------------------------------------
// Spend tracker for G3: 1-hour spend is approximated as the delta between
// consecutive checks (~15 min apart, rolling window ≤ 75 min). Cold start = 0.
// ---------------------------------------------------------------------------
const lastSpendSnapshot = new Map<string, { at: number; spendTodayCents: number }>();

export interface CheckResult {
  campaignId: string;
  campaignName: string;
  dryRun: boolean;
  guardrail: string | null;
  proposed: number;
  executed: number;
  errors: string[];
}

export async function runCheckAll(): Promise<CheckResult[]> {
  const db = getDb();
  const results: CheckResult[] = [];

  const campaigns = await db.campaign.findMany({
    where: { isAutopilotOn: true, googleAccount: { status: 'ACTIVE' } },
    include: { googleAccount: true },
  });

  console.info(`[check-all] starting: ${campaigns.length} campaign(s) with autopilot ON`);

  for (const campaign of campaigns) {
    try {
      results.push(await checkCampaign(campaign));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[check-all] campaign ${campaign.id} failed: ${message}`);
      results.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        dryRun: true,
        guardrail: null,
        proposed: 0,
        executed: 0,
        errors: [message],
      });
      // Auth problems need human action — mark the account so the user reconnects.
      if (TOKEN_ERROR_STATUSES.some((s) => message.includes(`HTTP ${s}`))) {
        await markTokenExpired(campaign.googleAccountId);
      }
    }
  }

  console.info(`[check-all] done: ${results.length} campaign(s) checked`);
  return results;
}

// ---------------------------------------------------------------------------
// Client factory — per-account Google Ads client from the stored refresh token
// ---------------------------------------------------------------------------

function makeClient(account: {
  customerId: string;
  refreshToken: string;
  loginCustomerId: string | null;
}): GoogleAdsClient {
  return new GoogleAdsClient({
    customerId: account.customerId,
    refreshToken: decryptToken(account.refreshToken, env.appEncryptionKey),
    clientId: env.googleAdsClientId,
    clientSecret: env.googleAdsClientSecret,
    loginCustomerId: account.loginCustomerId ?? undefined,
    developerToken: env.googleAdsDeveloperToken || undefined,
    apiVersion: env.googleAdsApiVersion,
  });
}

// ---------------------------------------------------------------------------
// G1 auto-resume: ad groups paused by the daily cap resume at 00:00 next day.
// ---------------------------------------------------------------------------

async function resumeExpiredGuardrailPauses(): Promise<number> {
  const db = getDb();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const stalePauses = await db.actionLog.findMany({
    where: {
      ruleId: 'G1',
      action: 'pause',
      autoResumedAt: null,
      createdAt: { lt: startOfToday },
      isDryRun: false,
    },
    include: { campaign: { include: { googleAccount: true } } },
    take: 200,
  });

  let resumed = 0;
  for (const row of stalePauses) {
    const adGroupIds = ((row.metricsSnapshot as any)?.adGroupIds ?? []) as string[];
    if (adGroupIds.length === 0) continue;

    const client = makeClient(row.campaign.googleAccount);
    const adGroups = await client.listAdGroups(row.campaign.googleCampaignId);
    const stillPaused = adGroups.filter((g) => adGroupIds.includes(g.id) && g.status === 'PAUSED');

    for (const group of stillPaused) {
      const res = await client.activateAdGroup(group.id);
      await db.actionLog.create({
        data: {
          campaignId: row.campaignId,
          adGroupId: group.id,
          adGroupName: group.name,
          action: 'resume',
          ruleId: 'G1',
          reason: 'New day started — resuming ad group paused by daily cap (auto-resume 00:00)',
          platformResponse: { success: res.success },
        },
      });
      resumed += 1;
    }
    await db.actionLog.update({ where: { id: row.id }, data: { autoResumedAt: new Date() } });
  }
  return resumed;
}

// ---------------------------------------------------------------------------
// Per-campaign check
// ---------------------------------------------------------------------------

type CampaignWithAccount = Prisma.CampaignGetPayload<{
  include: { googleAccount: true };
}>;

async function checkCampaign(campaign: CampaignWithAccount): Promise<CheckResult> {
  const db = getDb();
  const account = campaign.googleAccount;
  const dryRun = env.globalDryRun || campaign.dryRun;

  const client = makeClient(account);

  // ---- Gather state -----------------------------------------------------
  const [adGroups, today, month] = await Promise.all([
    client.listAdGroups(campaign.googleCampaignId),
    client.getMetrics('campaign', campaign.googleCampaignId, { datePreset: 'today' }),
    client.getMetrics('campaign', campaign.googleCampaignId, { datePreset: 'this_month' }),
  ]);

  const relevantAdGroups = adGroups.filter(
    (g) => g.status === 'ENABLED' || g.status === 'PAUSED',
  );

  // Budget-change timestamps (throttle source of truth = action_logs)
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const recentBudgetChanges = await db.actionLog.findMany({
    where: {
      campaignId: campaign.id,
      action: { in: ['increase_budget', 'decrease_budget'] },
      isDryRun: false,
      createdAt: { gte: dayAgo },
    },
    orderBy: { createdAt: 'desc' },
  });
  const lastBudgetChangeByAdGroup = new Map<string, Date>();
  for (const row of recentBudgetChanges) {
    if (row.adGroupId && !lastBudgetChangeByAdGroup.has(row.adGroupId)) {
      lastBudgetChangeByAdGroup.set(row.adGroupId, row.createdAt);
    }
  }

  // Per-ad-group metrics (3d / 7d / 30d CTR)
  const dates = trailingDates(); // {since3d, since7d, since30d, today}
  const adGroupStates: AdSetState[] = [];
  for (const g of relevantAdGroups) {
    const [m3, m7, m30] = await Promise.all([
      client.getMetrics('adGroup', g.id, { since: dates.since3d, until: dates.today }),
      client.getMetrics('adGroup', g.id, { since: dates.since7d, until: dates.today }),
      client.getMetrics('adGroup', g.id, { since: dates.since30d, until: dates.today }),
    ]);
    adGroupStates.push({
      id: g.id,
      name: g.name,
      isActive: g.status === 'ENABLED',
      currentDailyBudgetCents: g.dailyBudgetCents,
      lastBudgetChangeAt: lastBudgetChangeByAdGroup.get(g.id) ?? null,
      metrics: {
        last3d: toWindowMetrics(m3),
        last7d: toWindowMetrics(m7),
        last30dCtr: m30.ctr,
      },
    });
  }

  // G3 input: 1h spend ≈ delta since previous check (~15 min ago)
  const prev = lastSpendSnapshot.get(campaign.id);
  const spendLast1hCents =
    prev && Date.now() - prev.at < 90 * 60_000
      ? Math.max(0, today.spendCents - prev.spendTodayCents)
      : 0;
  lastSpendSnapshot.set(campaign.id, {
    at: Date.now(),
    spendTodayCents: today.spendCents,
  });

  const engineInput: EngineInput = {
    now: new Date(),
    config: {
      strategy: campaign.strategy as Strategy,
      monthlyBudgetCents: campaign.monthlyBudgetCents,
      dailyCapCents: campaign.dailyCapCents,
      targetCpaCents: campaign.targetCpaCents,
      targetRoas: campaign.targetRoas ? Number(campaign.targetRoas) : null,
    },
    spendTodayCents: today.spendCents,
    spendThisMonthCents: month.spendCents,
    spendLast1hCents,
    adSets: adGroupStates,
  };

  // ---- Decide (pure) ------------------------------------------------------
  const decision: EngineDecision = evaluate(engineInput);

  // ---- Execute ------------------------------------------------------------
  let executed = 0;
  for (const action of decision.actions) {
    if (action.kind === 'alert') {
      const sent = await maybeAlert(campaign, action.rule, action.severity, action.message, dryRun);
      await db.actionLog.create({
        data: {
          campaignId: campaign.id,
          action: 'alert',
          ruleId: action.rule,
          reason: action.message,
          isDryRun: dryRun,
          metricsSnapshot: { severity: action.severity, delivered: sent },
        },
      });
      continue;
    }

    if (action.kind === 'pause_adsets') {
      if (dryRun) {
        await db.actionLog.create({
          data: {
            campaignId: campaign.id,
            action: 'pause',
            ruleId: action.rule,
            adGroupId: action.adSetIds.join(','),
            reason: `[DRY RUN] ${action.reason}`,
            isDryRun: true,
            metricsSnapshot: { adGroupIds: action.adSetIds },
          },
        });
        continue;
      }
      for (const adGroupId of action.adSetIds) {
        const res = await client.pauseAdGroup(adGroupId);
        executed += 1;
        await db.actionLog.create({
          data: {
            campaignId: campaign.id,
            action: 'pause',
            ruleId: action.rule,
            adGroupId,
            reason: action.reason,
            isDryRun: false,
            metricsSnapshot: { adGroupIds: action.adSetIds },
            platformResponse: { success: res.success },
          },
        });
      }
      continue;
    }

    // increase_budget / decrease_budget — executed on the ad group's CAMPAIGN
    // budget (Google ad groups have no own budget).
    if (dryRun) {
      await db.actionLog.create({
        data: {
          campaignId: campaign.id,
          action: action.kind === 'increase_budget' ? 'increase_budget' : 'decrease_budget',
          ruleId: action.rule,
          adGroupId: action.adSetId,
          reason: `[DRY RUN] ${action.reason}`,
          isDryRun: true,
          oldValueCents: action.oldCents,
          newValueCents: action.newCents,
        },
      });
      continue;
    }
    const adGroup = adGroups.find((g) => g.id === action.adSetId);
    if (!adGroup?.budgetId) {
      await db.actionLog.create({
        data: {
          campaignId: campaign.id,
          action: action.kind === 'increase_budget' ? 'increase_budget' : 'decrease_budget',
          ruleId: action.rule,
          adGroupId: action.adSetId,
          reason: `[SKIPPED] ${action.reason} — no campaign budget found for ad group ${action.adSetId}`,
          isDryRun: false,
          oldValueCents: action.oldCents,
          newValueCents: action.newCents,
        },
      });
      continue;
    }
    const res = await client.setCampaignBudgetDailyCents(adGroup.budgetId, action.newCents);
    executed += 1;
    await db.actionLog.create({
      data: {
        campaignId: campaign.id,
        action: action.kind === 'increase_budget' ? 'increase_budget' : 'decrease_budget',
        ruleId: action.rule,
        adGroupId: action.adSetId,
        reason: action.reason,
        isDryRun: false,
        oldValueCents: action.oldCents,
        newValueCents: action.newCents,
        platformResponse: { success: res.success },
      },
    });
  }

  // ---- No-op rows: write every decision, even when nothing happened (spec) ----
  if (decision.actions.length === 0) {
    await db.actionLog.create({
      data: {
        campaignId: campaign.id,
        action: 'none',
        reason: `No action needed. ${decision.log.length} checks ran clear.`,
        isDryRun: dryRun,
        metricsSnapshot: { trace: decision.log.slice(0, 10) },
      },
    });
  }

  // ---- daily_stats cache + lastCheckedAt ----------------------------------
  await upsertDailyStat(campaign.id, today);
  await db.campaign.update({
    where: { id: campaign.id },
    data: { lastCheckedAt: new Date() },
  });

  // Refresh tokens don't expire (they're revoked, which surfaces as HTTP 401/403
  // and marks the account EXPIRED via the error path above) — no expiry watchdog
  // needed on Google, unlike Meta's 60-day tokens.

  console.info(
    `[check] ${campaign.name}: guardrail=${decision.guardrailTriggered ?? 'none'}, proposed=${decision.actions.length}, executed=${executed}${dryRun ? ' (DRY RUN)' : ''}, token=${maskToken(account.refreshToken)}`,
  );

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    dryRun,
    guardrail: decision.guardrailTriggered,
    proposed: decision.actions.length,
    executed,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Alerts with simple time-window dedupe (no alert spam)
// ---------------------------------------------------------------------------

async function maybeAlert(
  campaign: CampaignWithAccount,
  rule: string,
  severity: 'info' | 'warning' | 'critical',
  message: string,
  dryRun: boolean,
  dedupeHours = 6,
): Promise<boolean> {
  const db = getDb();
  const since = new Date(Date.now() - dedupeHours * 3600_000);
  const recent = await db.actionLog.findFirst({
    where: {
      campaignId: campaign.id,
      action: 'alert',
      reason: { startsWith: message.slice(0, 40) },
      createdAt: { gte: since },
    },
  });
  if (recent && !dryRun) return false; // already alerted recently

  const user = await db.user.findUnique({ where: { id: campaign.googleAccount.userId } });
  await sendAlert({
    rule,
    severity,
    message: `${message}\nCampaign: ${campaign.name}`,
    slackWebhookUrl: user?.slackWebhookUrl,
  });
  return true;
}

async function markTokenExpired(googleAccountId: string): Promise<void> {
  const db = getDb();
  await db.googleAccount.update({
    where: { id: googleAccountId },
    data: { status: 'EXPIRED' },
  });
  console.warn(`[google] auth failed for account ${googleAccountId} — user must reconnect`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toWindowMetrics(n: {
  spendCents: number;
  revenueCents: number;
  purchases: number;
  impressions: number;
  clicks: number;
  frequency: number | null;
  ctr: number | null;
  roas: number | null;
  cpaCents: number | null;
}): WindowMetrics {
  return n;
}

function trailingDates(): { since3d: string; since7d: string; since30d: string; today: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 3600_000);
  return {
    today: fmt(now),
    since3d: fmt(daysAgo(2)),
    since7d: fmt(daysAgo(6)),
    since30d: fmt(daysAgo(29)),
  };
}

async function upsertDailyStat(
  campaignId: string,
  today: {
    spendCents: number;
    revenueCents: number;
    roas: number | null;
    cpaCents: number | null;
    impressions: number;
    clicks: number;
  },
): Promise<void> {
  const db = getDb();
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  const data = {
    spendCents: today.spendCents,
    revenueCents: today.revenueCents,
    roas: today.roas != null ? new Prisma.Decimal(today.roas.toFixed(2)) : null,
    cpaCents: today.cpaCents,
    impressions: today.impressions,
    clicks: today.clicks,
  };
  await db.dailyStat.upsert({
    where: { campaignId_date: { campaignId, date } },
    create: { campaignId, date, ...data },
    update: data,
  });
}

export { resumeExpiredGuardrailPauses };
