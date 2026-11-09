/**
 * BudgetGuard rule engine — PURE function, the heart of the product.
 *
 * Execution order (spec §5 "Engine Execution Order — Critical"):
 *   1. G1 Hard Daily Cap        ─┐
 *   2. G2 Hard Monthly Cap       ├─ first hit pauses everything and STOPS all further checks
 *   3. G3 Account Spend Anomaly ─┘
 *   4. B1 Stop-Loss              (per ad set)
 *   5. B3 Slow Bleed             (per ad set, only if B1 did not fire for it)
 *   6. B2 Scale Winner           (per ad set, only if B1/B3 did not fire for it)
 *   7. B4 Creative Fatigue       (alert only, never mutates)
 *
 * Idempotency (spec):
 *   - Never pause an already-paused ad set (isActive === false is skipped).
 *   - Never change a budget more than once per cooldown window (lastBudgetChangeAt).
 *
 * Design notes / documented interpretations of the spec:
 *   - B1: with purchases_3d === 0, CPA is unbounded, so the spec's
 *     "CPA_3d > target_cpa * 2" is trivially satisfied. We therefore fire B1 on
 *     (spend_3d > $50 AND purchases_3d === 0) even when no target CPA is configured —
 *     $50 with nothing to show is a loser regardless of target.
 *   - B2: if cpaCents is null (attribution lag) we treat the CPA condition as passed,
 *     because ROAS_3d >= threshold already implies strong performance.
 *   - B2: new budget is clamped to dailyCapCents so scaling can never push a single
 *     ad set past the user's hard daily cap.
 */

import {
  FATIGUE_CTR_DROP_RATIO,
  FATIGUE_FREQUENCY_7D,
  HOUR_MS,
  MIN_ADSET_DAILY_BUDGET_CENTS,
  SCALE_COOLDOWN_HOURS,
  SCALE_INCREASE_PCT,
  SCALE_MAX_FREQUENCY_3D,
  SCALE_ROAS_THRESHOLD,
  SLOW_BLEED_DECREASE_PCT,
  SLOW_BLEED_MAX_ROAS_3D,
  SLOW_BLEED_MIN_SPEND_3D_CENTS,
  SPIKE_FRACTION_OF_DAILY_CAP,
  STOP_LOSS_MIN_SPEND_3D_CENTS,
} from './constants';
import { fmtCents, fmtPct, fmtRoas } from './format';
import type {
  AdSetState,
  EngineAction,
  EngineDecision,
  EngineInput,
  RuleId,
} from './types';

export function evaluate(input: EngineInput): EngineDecision {
  const { config, now } = input;
  const log: string[] = [];
  const actions: EngineAction[] = [];
  const active = input.adSets.filter((a) => a.isActive);
  const pausedCount = input.adSets.length - active.length;

  log.push(
    `Check started: strategy=${config.strategy}, spendToday=${fmtCents(input.spendTodayCents)}/${fmtCents(config.dailyCapCents)}, spendMTD=${fmtCents(input.spendThisMonthCents)}/${fmtCents(config.monthlyBudgetCents)}, 1h=${fmtCents(input.spendLast1hCents)}, adSets=${active.length} active / ${pausedCount} paused`,
  );

  // ------------------------------------------------------------------
  // Guardrails (run first; a trigger stops ALL further checks — spec)
  // ------------------------------------------------------------------
  const guardrail = evaluateGuardrails(input, active, log);
  if (guardrail) {
    if (guardrail.pauseIds.length > 0) {
      actions.push({
        kind: 'pause_adsets',
        rule: guardrail.rule,
        adSetIds: guardrail.pauseIds,
        reason: guardrail.reason,
        autoResume: guardrail.rule === 'G1', // G1 auto-resumes at 00:00; G2/G3 need review
      });
    }
    actions.push({
      kind: 'alert',
      rule: guardrail.rule,
      severity: 'critical',
      message: guardrail.alert,
    });
    log.push(`Guardrail ${guardrail.rule} triggered — skipping all strategy rules for this run.`);
    return { strategy: config.strategy, guardrailTriggered: guardrail.rule, actions, log };
  }

  // ------------------------------------------------------------------
  // Strategy rules
  // ------------------------------------------------------------------
  const losers = new Set<string>(); // ad sets hit by B1 — excluded from B3/B2
  const bleeding = new Set<string>(); // ad sets hit by B3 — excluded from B2

  // ---- B1 Stop-Loss (all strategies, incl. Protect Only) ----
  for (const ad of active) {
    const m3 = ad.metrics.last3d;
    if (m3.spendCents > STOP_LOSS_MIN_SPEND_3D_CENTS && m3.purchases === 0) {
      const cpaNote =
        config.targetCpaCents != null
          ? `, CPA unbounded (target ${fmtCents(config.targetCpaCents)}, 2× limit ${fmtCents(config.targetCpaCents * 2)})`
          : '';
      actions.push({
        kind: 'pause_adsets',
        rule: 'B1',
        adSetIds: [ad.id],
        reason: `Stop-loss: spent ${fmtCents(m3.spendCents)} over 3 days with 0 purchases${cpaNote}`,
        autoResume: false,
      });
      losers.add(ad.id);
      log.push(`B1 fired for "${ad.name}" (${ad.id}).`);
    } else {
      log.push(
        `B1 clear for "${ad.name}": spend3d=${fmtCents(m3.spendCents)}, purchases3d=${m3.purchases}.`,
      );
    }
  }

  const remainingAfterB1 = active.filter((a) => !losers.has(a.id));

  // ---- B3 Slow Bleed (balanced & aggressive only — Protect never touches budgets) ----
  if (config.strategy !== 'protect') {
    for (const ad of remainingAfterB1) {
      const m3 = ad.metrics.last3d;
      const roas = m3.roas ?? 0;
      if (
        m3.spendCents > SLOW_BLEED_MIN_SPEND_3D_CENTS &&
        roas < SLOW_BLEED_MAX_ROAS_3D &&
        m3.purchases > 0
      ) {
        const newCents = Math.max(
          MIN_ADSET_DAILY_BUDGET_CENTS,
          Math.round(ad.currentDailyBudgetCents * (1 - SLOW_BLEED_DECREASE_PCT)),
        );
        if (newCents < ad.currentDailyBudgetCents) {
          actions.push({
            kind: 'decrease_budget',
            rule: 'B3',
            adSetId: ad.id,
            oldCents: ad.currentDailyBudgetCents,
            newCents,
            reason: `Slow bleed: ROAS ${fmtRoas(m3.roas)} < ${SLOW_BLEED_MAX_ROAS_3D.toFixed(1)} on ${fmtCents(m3.spendCents)} spend (${m3.purchases} purchases) — reducing budget -${fmtPct(SLOW_BLEED_DECREASE_PCT)}`,
          });
          bleeding.add(ad.id);
          log.push(`B3 fired for "${ad.name}" (${ad.id}).`);
        } else {
          log.push(`B3 matched "${ad.name}" but budget is already at the floor — no change.`);
        }
      } else {
        log.push(
          `B3 clear for "${ad.name}": spend3d=${fmtCents(m3.spendCents)}, roas3d=${fmtRoas(m3.roas)}, purchases3d=${m3.purchases}.`,
        );
      }
    }
  } else {
    log.push('Strategy "protect": B3 (budget changes) disabled.');
  }

  // ---- B2 Scale Winner (balanced & aggressive only) ----
  if (config.strategy !== 'protect') {
    const threshold = SCALE_ROAS_THRESHOLD[config.strategy];
    const increasePct = SCALE_INCREASE_PCT[config.strategy];
    const cooldownMs = SCALE_COOLDOWN_HOURS[config.strategy] * HOUR_MS;

    for (const ad of remainingAfterB1) {
      if (bleeding.has(ad.id)) {
        log.push(`B2 skipped for "${ad.name}": B3 fired in this run.`);
        continue;
      }
      const m3 = ad.metrics.last3d;

      // Throttle — check before conditions so the log explains *why* nothing happened.
      if (ad.lastBudgetChangeAt && now.getTime() - ad.lastBudgetChangeAt.getTime() < cooldownMs) {
        const readyAt = new Date(ad.lastBudgetChangeAt.getTime() + cooldownMs);
        log.push(
          `B2 throttled for "${ad.name}": last budget change ${ad.lastBudgetChangeAt.toISOString()}, cooldown ${SCALE_COOLDOWN_HOURS[config.strategy]}h (ready at ${readyAt.toISOString()}).`,
        );
        continue;
      }

      const roas = m3.roas ?? 0;
      const freq = m3.frequency ?? 0;
      const cpaOk =
        config.targetCpaCents == null || m3.cpaCents == null || m3.cpaCents <= config.targetCpaCents;

      if (roas >= threshold && cpaOk && freq < SCALE_MAX_FREQUENCY_3D) {
        if (ad.currentDailyBudgetCents >= config.dailyCapCents) {
          log.push(
            `B2 matched "${ad.name}" but daily budget ${fmtCents(ad.currentDailyBudgetCents)} already at cap — no headroom.`,
          );
          continue;
        }
        const newCents = Math.min(
          Math.round(ad.currentDailyBudgetCents * (1 + increasePct)),
          config.dailyCapCents,
        );
        if (newCents > ad.currentDailyBudgetCents) {
          const cpaPart =
            config.targetCpaCents != null && m3.cpaCents != null
              ? `, CPA ${fmtCents(m3.cpaCents)} ≤ target ${fmtCents(config.targetCpaCents)}`
              : '';
          actions.push({
            kind: 'increase_budget',
            rule: 'B2',
            adSetId: ad.id,
            oldCents: ad.currentDailyBudgetCents,
            newCents,
            reason: `Scale winner: ROAS ${fmtRoas(m3.roas)} ≥ ${threshold.toFixed(1)} over 3 days${cpaPart}, frequency ${freq.toFixed(1)} < ${SCALE_MAX_FREQUENCY_3D} — budget +${fmtPct(increasePct)}`,
          });
          log.push(`B2 fired for "${ad.name}" (${ad.id}).`);
        } else {
          log.push(`B2 matched "${ad.name}" but rounding left no increase — no change.`);
        }
      } else {
        log.push(
          `B2 clear for "${ad.name}": roas3d=${fmtRoas(m3.roas)} (need ≥${threshold.toFixed(1)}), cpaOk=${cpaOk}, freq3d=${freq.toFixed(1)} (need <${SCALE_MAX_FREQUENCY_3D}).`,
        );
      }
    }
  } else {
    log.push('Strategy "protect": B2 (scaling) disabled.');
  }

  // ---- B4 Creative Fatigue (alert only; balanced & aggressive) ----
  if (config.strategy !== 'protect') {
    for (const ad of active) {
      const f7 = ad.metrics.last7d.frequency;
      const ctr7 = ad.metrics.last7d.ctr;
      const ctr30 = ad.metrics.last30dCtr;
      if (
        f7 != null &&
        f7 > FATIGUE_FREQUENCY_7D &&
        ctr7 != null &&
        ctr30 != null &&
        ctr30 > 0 &&
        ctr7 < ctr30 * FATIGUE_CTR_DROP_RATIO
      ) {
        actions.push({
          kind: 'alert',
          rule: 'B4',
          severity: 'info',
          message: `Creative fatigue in "${ad.name}": frequency ${f7.toFixed(1)} > ${FATIGUE_FREQUENCY_7D}, CTR down ${fmtPct(1 - ctr7 / ctr30)} vs 30-day baseline. Consider new creative.`,
        });
        log.push(`B4 fired for "${ad.name}" (${ad.id}).`);
      }
    }
  }

  log.push(
    `Check complete: ${actions.length} action(s) proposed, no guardrail triggered.`,
  );
  return { strategy: config.strategy, guardrailTriggered: null, actions, log };
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

interface GuardrailHit {
  rule: RuleId;
  pauseIds: string[];
  reason: string;
  alert: string;
}

function evaluateGuardrails(
  input: EngineInput,
  active: AdSetState[],
  log: string[],
): GuardrailHit | null {
  const { config } = input;

  // G1 — Hard Daily Cap. Meta itself can overspend a daily budget by up to ~75%.
  if (input.spendTodayCents >= config.dailyCapCents) {
    log.push(
      `G1 triggered: spendToday ${fmtCents(input.spendTodayCents)} >= dailyCap ${fmtCents(config.dailyCapCents)}.`,
    );
    return {
      rule: 'G1',
      pauseIds: active.map((a) => a.id),
      reason: `Daily cap reached: spend ${fmtCents(input.spendTodayCents)} ≥ cap ${fmtCents(config.dailyCapCents)} — paused to protect budget`,
      alert: `Daily cap reached (${fmtCents(input.spendTodayCents)} / ${fmtCents(config.dailyCapCents)}). ${active.length > 0 ? 'All ad sets paused.' : 'All ad sets were already paused.'} Auto-resume at 00:00 tomorrow.`,
    };
  }

  // G2 — Hard Monthly Cap.
  if (input.spendThisMonthCents >= config.monthlyBudgetCents) {
    log.push(
      `G2 triggered: spendMTD ${fmtCents(input.spendThisMonthCents)} >= monthlyBudget ${fmtCents(config.monthlyBudgetCents)}.`,
    );
    return {
      rule: 'G2',
      pauseIds: active.map((a) => a.id),
      reason: `Monthly budget reached: spend ${fmtCents(input.spendThisMonthCents)} ≥ budget ${fmtCents(config.monthlyBudgetCents)} — paused`,
      alert: `Monthly budget reached (${fmtCents(input.spendThisMonthCents)} / ${fmtCents(config.monthlyBudgetCents)}). ${active.length > 0 ? 'All ad sets paused.' : 'All ad sets were already paused.'} Increase your monthly budget in Settings to resume.`,
    };
  }

  // G3 — Account Spend Anomaly (1-hour spike).
  const spikeLimit = Math.floor(config.dailyCapCents * SPIKE_FRACTION_OF_DAILY_CAP);
  if (input.spendLast1hCents > spikeLimit && spikeLimit > 0) {
    log.push(
      `G3 triggered: spendLast1h ${fmtCents(input.spendLast1hCents)} > ${fmtPct(SPIKE_FRACTION_OF_DAILY_CAP)} of dailyCap (${fmtCents(spikeLimit)}).`,
    );
    return {
      rule: 'G3',
      pauseIds: active.map((a) => a.id),
      reason: `Spend spike detected: ${fmtCents(input.spendLast1hCents)} in the last hour (limit ${fmtCents(spikeLimit)})`,
      alert: `Spend spike detected: ${fmtCents(input.spendLast1hCents)} in the last hour — more than ${fmtPct(SPIKE_FRACTION_OF_DAILY_CAP)} of your ${fmtCents(config.dailyCapCents)} daily cap. All ad sets paused for review.`,
    };
  }

  return null;
}

// Re-export for consumers that only import the engine entry point.
export type { AdSetState, EngineAction, EngineDecision, EngineInput, RuleId };
