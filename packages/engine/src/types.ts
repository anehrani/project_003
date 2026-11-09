/**
 * BudgetGuard Engine — core domain types.
 *
 * The engine is PURE: no database, no network, no Meta API.
 * It takes a snapshot of the world and returns a list of decisions.
 * This makes it unit-testable, dry-runnable and backtestable.
 */

/** Autopilot strategies available in MVP (spec §5). */
export type Strategy = 'balanced' | 'protect' | 'aggressive';

/** Metrics for a single lookback window (all money in cents, integers). */
export interface WindowMetrics {
  /** Total spend in cents for the window. */
  spendCents: number;
  /** Total purchase/conversion value in cents for the window. */
  revenueCents: number;
  /** Number of purchases/conversions attributed in the window. */
  purchases: number;
  impressions: number;
  clicks: number;
  /** Frequency = impressions / reach. Null when reach is unavailable. */
  frequency: number | null;
  /** Link click-through rate as a fraction (0.012 = 1.2%). Null when impressions = 0. */
  ctr: number | null;
  /** ROAS = revenue / spend. Null when spend = 0. */
  roas: number | null;
  /** CPA = spend / purchases. Null when purchases = 0 (treated as unbounded by the engine). */
  cpaCents: number | null;
}

/** Per-ad-set metrics the engine needs to evaluate B-rules. */
export interface AdSetMetrics {
  last3d: WindowMetrics;
  last7d: WindowMetrics;
  /** 30-day link CTR — used by the fatigue rule (B4) as the baseline. */
  last30dCtr: number | null;
}

/** Current, mutable state of one ad set inside the protected campaign. */
export interface AdSetState {
  id: string;
  name: string;
  /** false = already paused (engine never re-pauses — idempotency). */
  isActive: boolean;
  currentDailyBudgetCents: number;
  /** Last time a budget change was executed on this ad set (throttle: 1 change / N hours). */
  lastBudgetChangeAt: Date | null;
  metrics: AdSetMetrics;
}

/** The user's configuration for the protected campaign (spec §6 campaigns table). */
export interface CampaignConfig {
  strategy: Strategy;
  monthlyBudgetCents: number;
  dailyCapCents: number;
  /** Optional. Null = engine falls back to rule-specific defaults. */
  targetCpaCents: number | null;
  /** Optional. Informational for MVP rules; B2 uses fixed strategy thresholds. */
  targetRoas: number | null;
}

/** Everything the engine needs for one 15-minute check of one campaign. */
export interface EngineInput {
  now: Date;
  config: CampaignConfig;
  /** Campaign-level spend since local midnight. */
  spendTodayCents: number;
  /** Campaign-level spend month-to-date. */
  spendThisMonthCents: number;
  /** Campaign-level spend in the last rolling hour (anomaly detector G3). */
  spendLast1hCents: number;
  adSets: AdSetState[];
}

export type RuleId = 'G1' | 'G2' | 'G3' | 'B1' | 'B2' | 'B3' | 'B4';

/** A decision the engine wants executed. The worker maps these to Meta API calls. */
export type EngineAction =
  /** Pause one or more ad sets (guardrail hit or stop-loss). */
  | {
      kind: 'pause_adsets';
      rule: RuleId;
      adSetIds: string[];
      reason: string;
      /** G1 pauses auto-resume at 00:00 next day (spec G1). */
      autoResume: boolean;
    }
  /** Increase the daily budget of one ad set (B2). */
  | {
      kind: 'increase_budget';
      rule: 'B2';
      adSetId: string;
      oldCents: number;
      newCents: number;
      reason: string;
    }
  /** Decrease the daily budget of one ad set (B3). */
  | {
      kind: 'decrease_budget';
      rule: 'B3';
      adSetId: string;
      oldCents: number;
      newCents: number;
      reason: string;
    }
  /** Notification only — no account mutation (G1/G2/G3 alerts, B4 fatigue). */
  | { kind: 'alert'; rule: RuleId; severity: 'info' | 'warning' | 'critical'; message: string };

/** Result of one engine evaluation for one campaign. */
export interface EngineDecision {
  strategy: Strategy;
  /** The guardrail that fired and short-circuited strategy rules, if any. */
  guardrailTriggered: RuleId | null;
  actions: EngineAction[];
  /** Human-readable trace of every check — including no-op decisions (spec: log everything). */
  log: string[];
}
