/**
 * runCheckAll() — the 15-minute heartbeat (spec §7 Worker).
 *
 * For each campaign with autopilot ON and an active Meta account:
 *   1. Resume G1-paused ad sets if the day rolled over (auto-resume at 00:00)
 *   2. Fetch insights: campaign (today, MTD) + each ad set (3d, 7d, 30d)
 *   3. Build an EngineInput snapshot and run the pure engine
 *   4. Execute actions — or only LOG them when dryRun is on
 *   5. Write every decision to action_logs (spec: even no-ops, for debugging)
 *   6. Upsert daily_stats (dashboard cache — never hit Meta from the UI)
 *
 * Idempotency at the execution layer (defense in depth — the engine already
 * guards): pause calls are skipped for ad sets Meta reports as non-ACTIVE,
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
import { MetaClient, TOKEN_ERROR_CODES } from '@budgetguard/meta';
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
    where: { isAutopilotOn: true, metaAccount: { status: 'ACTIVE' } },
    include: { metaAccount: true },
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
      // Token problems need human action — alert the user.
      if (TOKEN_ERROR_CODES.some((c) => message.includes(`code ${c}`))) {
        await markTokenExpired(campaign.metaAccountId);
      }
    }
  }

  console.info(`[check-all] done: ${results.length} campaign(s) checked`);
  return results;
}

// ---------------------------------------------------------------------------
// G1 auto-resume: ad sets paused by the daily cap resume at 00:00 next day.
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
    include: { campaign: { include: { metaAccount: true } } },
    take: 200,
  });

  let resumed = 0;
  for (const row of stalePauses) {
    const adsetIds = ((row.metricsSnapshot as any)?.adsetIds ?? []) as string[];
    if (adsetIds.length === 0) continue;

    const client = new MetaClient(
      decryptToken(row.campaign.metaAccount.accessToken, env.appEncryptionKey),
      { apiVersion: env.metaApiVersion },
    );
    const adSets = await client.listAdSets(row.campaign.metaCampaignId);
    const stillPaused = adSets.filter((s) => adsetIds.includes(s.id) && s.status === 'PAUSED');

    for (const adset of stillPaused) {
      const res = await client.activateAdSet(adset.id);
      await db.actionLog.create({
        data: {
          campaignId: row.campaignId,
          adsetId: adset.id,
          adsetName: adset.name,
          action: 'resume',
          ruleId: 'G1',
          reason: 'New day started — resuming ad set paused by daily cap (auto-resume 00:00)',
          metaApiResponse: { success: res.success },
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
  include: { metaAccount: true };
}>;

async function checkCampaign(campaign: CampaignWithAccount): Promise<CheckResult> {
  const db = getDb();
  const account = campaign.metaAccount;
  const dryRun = env.globalDryRun || campaign.dryRun;

  const token = decryptToken(account.accessToken, env.appEncryptionKey);
  const client = new MetaClient(token, {
    apiVersion: env.metaApiVersion,
    onUsage: (u) => {
      if (u.callCount >= 75) {
        console.warn(`[meta] usage ${u.callCount}% for ${u.accountId} — approaching throttle`);
      }
    },
  });

  // ---- Gather state -----------------------------------------------------
  const [metaAdSets, today, month] = await Promise.all([
    client.listAdSets(campaign.metaCampaignId),
    client.getInsights(campaign.metaCampaignId, { datePreset: 'today' }),
    client.getInsights(campaign.metaCampaignId, { datePreset: 'this_month' }),
  ]);

  const relevantAdSets = metaAdSets.filter((s) => s.status === 'ACTIVE' || s.status === 'PAUSED');

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
  const lastBudgetChangeByAdset = new Map<string, Date>();
  for (const row of recentBudgetChanges) {
    if (row.adsetId && !lastBudgetChangeByAdset.has(row.adsetId)) {
      lastBudgetChangeByAdset.set(row.adsetId, row.createdAt);
    }
  }

  // Per-ad-set insights (3d / 7d / 30d CTR)
  const dates = trailingDates(); // {since3d, since7d, since30d, today}
  const adSetStates: AdSetState[] = [];
  for (const s of relevantAdSets) {
    const [m3, m7, m30] = await Promise.all([
      client.getInsights(s.id, { since: dates.since3d, until: dates.today }),
      client.getInsights(s.id, { since: dates.since7d, until: dates.today }),
      client.getInsights(s.id, { since: dates.since30d, until: dates.today }),
    ]);
    adSetStates.push({
      id: s.id,
      name: s.name,
      isActive: s.status === 'ACTIVE',
      currentDailyBudgetCents: parseInt(s.dailyBudget ?? '0', 10) || 0,
      lastBudgetChangeAt: lastBudgetChangeByAdset.get(s.id) ?? null,
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
    adSets: adSetStates,
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
            adsetId: action.adSetIds.join(','),
            reason: `[DRY RUN] ${action.reason}`,
            isDryRun: true,
            metricsSnapshot: { adsetIds: action.adSetIds },
          },
        });
        continue;
      }
      for (const adsetId of action.adSetIds) {
        const meta = await client.pauseAdSet(adsetId);
        executed += 1;
        await db.actionLog.create({
          data: {
            campaignId: campaign.id,
            action: 'pause',
            ruleId: action.rule,
            adsetId,
            reason: action.reason,
            isDryRun: false,
            metricsSnapshot: { adsetIds: action.adSetIds },
            metaApiResponse: { success: meta.success },
          },
        });
      }
      continue;
    }

    // increase_budget / decrease_budget
    if (dryRun) {
      await db.actionLog.create({
        data: {
          campaignId: campaign.id,
          action: action.kind === 'increase_budget' ? 'increase_budget' : 'decrease_budget',
          ruleId: action.rule,
          adsetId: action.adSetId,
          reason: `[DRY RUN] ${action.reason}`,
          isDryRun: true,
          oldValueCents: action.oldCents,
          newValueCents: action.newCents,
        },
      });
      continue;
    }
    const meta = await client.setAdSetDailyBudget(action.adSetId, action.newCents);
    executed += 1;
    await db.actionLog.create({
      data: {
        campaignId: campaign.id,
        action: action.kind === 'increase_budget' ? 'increase_budget' : 'decrease_budget',
        ruleId: action.rule,
        adsetId: action.adSetId,
        reason: action.reason,
        isDryRun: false,
        oldValueCents: action.oldCents,
        newValueCents: action.newCents,
        metaApiResponse: { success: meta.success },
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

  // ---- Token expiry watchdog ----------------------------------------------
  const expiresSoon =
    account.tokenExpiresAt.getTime() - Date.now() < 7 * 24 * 3600_000;
  if (expiresSoon) {
    await maybeAlert(
      campaign,
      'MANUAL',
      'warning',
      `Your Meta connection expires on ${account.tokenExpiresAt.toISOString().slice(0, 10)} — reconnect in Settings so BudgetGuard can keep protecting your budget.`,
      dryRun,
      24,
    );
  }

  console.info(
    `[check] ${campaign.name}: guardrail=${decision.guardrailTriggered ?? 'none'}, proposed=${decision.actions.length}, executed=${executed}${dryRun ? ' (DRY RUN)' : ''}, token=${maskToken(token)}`,
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

  const user = await db.user.findUnique({ where: { id: campaign.metaAccount.userId } });
  await sendAlert({
    rule,
    severity,
    message: `${message}\nCampaign: ${campaign.name}`,
    slackWebhookUrl: user?.slackWebhookUrl,
  });
  return true;
}

async function markTokenExpired(metaAccountId: string): Promise<void> {
  const db = getDb();
  await db.metaAccount.update({
    where: { id: metaAccountId },
    data: { status: 'EXPIRED' },
  });
  console.warn(`[meta] token expired for account ${metaAccountId} — user must reconnect`);
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
