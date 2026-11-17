/** BudgetGuard Google Ads client — domain types. */

/**
 * Date range for a metrics window. Google reports in the ACCOUNT's timezone,
 * so YYYY-MM-DD strings are passed through as-is (no client-side shifting).
 */
export type MetricsRange =
  | { datePreset: 'today' | 'this_month' | 'last_3d' | 'last_7d' | 'last_30d' }
  | { since: string; until: string }; // inclusive YYYY-MM-DD

export interface GoogleCampaignSummary {
  id: string;
  name: string;
  /** ENABLED | PAUSED | REMOVED | … */
  status: string;
  advertisingChannelType: string;
  /** Campaign budget resource id — budgets live at CAMPAIGN level in Google Ads. */
  budgetId: string;
  /** Daily budget of the linked campaign budget, in cents. */
  dailyBudgetCents: number;
}

export interface GoogleAdGroupSummary {
  id: string;
  name: string;
  /** ENABLED | PAUSED | REMOVED | … */
  status: string;
  campaignId: string;
  /** Campaign budget resource id this ad group inherits its budget from. */
  budgetId: string;
  /** Daily budget in cents (from the linked campaign budget). */
  dailyBudgetCents: number;
}

/**
 * Normalized metrics — the exact shape the engine consumes everywhere
 * (money always in integer cents). Platform-agnostic by design.
 */
export interface NormalizedMetrics {
  spendCents: number;
  revenueCents: number;
  purchases: number;
  impressions: number;
  clicks: number;
  /** Google exposes no per-window reach via GAQL → always 0. */
  reach: number;
  /** impressions / reach — always null on Google (see reach). */
  frequency: number | null;
  /** CTR as a fraction (0.03 = 3%); null when impressions = 0. */
  ctr: number | null;
  /** revenue / spend; null when spend = 0. */
  roas: number | null;
  /** spend / purchases; null when purchases = 0 (engine treats as unbounded). */
  cpaCents: number | null;
}

/** One GoogleAdsRow as returned by the REST interface (proto3 JSON, camelCase). */
export interface GoogleAdsRow {
  campaign?: {
    id?: string;
    name?: string;
    status?: string;
    advertisingChannelType?: string;
  };
  adGroup?: { id?: string; name?: string; status?: string };
  campaignBudget?: { id?: string; amountMicros?: string | number };
  metrics?: RawMetrics;
  segments?: { date?: string };
}

/** Raw metrics fields — int64 fields arrive as strings, doubles as numbers. */
export interface RawMetrics {
  costMicros?: string | number;
  clicks?: string | number;
  impressions?: string | number;
  conversions?: string | number;
  conversionsValue?: string | number;
  ctr?: string | number;
}
