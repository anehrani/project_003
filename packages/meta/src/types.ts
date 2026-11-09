/** Types for Meta Marketing API entities and normalized insights. */

export interface MetaAdAccount {
  id: string; // act_123456
  name: string;
  currency: string;
  /** Meta account_status: 1 = active, 2 = disabled, etc. */
  accountStatus: number;
}

export interface MetaCampaignSummary {
  id: string;
  name: string;
  status: string; // ACTIVE | PAUSED | DELETED | ARCHIVED
  objective?: string;
}

export interface MetaAdSetSummary {
  id: string;
  name: string;
  status: string; // ACTIVE | PAUSED | ...
  /** Daily budget in minor units (cents), as string. */
  dailyBudget?: string;
}

/** Raw insights row as returned by GET /{id}/insights. */
export interface RawInsightsRow {
  spend?: string; // "42.10" in account currency
  impressions?: string;
  clicks?: string;
  /** Meta returns CTR as a PERCENTAGE string, e.g. "1.23" = 1.23%. */
  ctr?: string;
  reach?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}

/**
 * Normalized insights — all money in integer cents, ratios as fractions.
 * Shape-compatible with the engine's WindowMetrics (plus reach).
 */
export interface NormalizedInsights {
  spendCents: number;
  revenueCents: number;
  purchases: number;
  impressions: number;
  clicks: number;
  reach: number;
  /** impressions / reach — null when reach = 0. */
  frequency: number | null;
  /** Link CTR as a fraction (0.012 = 1.2%) — null when impressions = 0. */
  ctr: number | null;
  /** revenue / spend — null when spend = 0. */
  roas: number | null;
  /** spend / purchases in cents — null when purchases = 0. */
  cpaCents: number | null;
}

export interface UsageSnapshot {
  /** 0–100, per ad account. >= 100 means throttled. */
  callCount: number;
  accountId: string;
}
