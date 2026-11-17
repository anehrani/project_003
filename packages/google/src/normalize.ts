/**
 * Converts raw Google Ads metrics rows into engine-ready normalized metrics.
 *
 * Money: Google reports cost in MICROS (1 currency unit = 1,000,000 micros),
 * so 1 cent = 10,000 micros. Conversion value arrives in currency units.
 */

import type { GoogleAdsRow, NormalizedMetrics, RawMetrics } from './types';

/** 1 cent = 10,000 micros. */
export const MICROS_PER_CENT = 10_000;

function num(v: string | number | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** campaign_budget.amount_micros → cents. */
export function microsToCents(micros: string | number | undefined): number {
  return Math.round(num(micros) / MICROS_PER_CENT);
}

/**
 * Aggregates daily rows (segments.date in the SELECT → one row per day)
 * into a single engine-ready window.
 */
export function normalizeMetrics(rows: GoogleAdsRow[] | undefined | null): NormalizedMetrics {
  let costMicros = 0;
  let clicks = 0;
  let impressions = 0;
  let conversions = 0;
  let conversionsValue = 0;
  for (const row of rows ?? []) {
    const m: RawMetrics = row.metrics ?? {};
    costMicros += num(m.costMicros);
    clicks += num(m.clicks);
    impressions += num(m.impressions);
    conversions += num(m.conversions);
    conversionsValue += num(m.conversionsValue);
  }

  const spendCents = Math.round(costMicros / MICROS_PER_CENT);
  const revenueCents = Math.round(conversionsValue * 100);
  const purchases = Math.round(conversions);
  const ctr = impressions > 0 ? clicks / impressions : null;
  const roas = spendCents > 0 ? revenueCents / spendCents : null;
  const cpaCents = purchases > 0 ? Math.round(spendCents / purchases) : null;

  // Google has no per-window reach field in GAQL → frequency is unknown and
  // the B4 fatigue rule runs in degraded (alert-only) mode until a real
  // frequency source exists. The engine handles null frequency safely.
  const reach = 0;
  return {
    spendCents,
    revenueCents,
    purchases,
    impressions,
    clicks,
    reach,
    frequency: null,
    ctr,
    roas,
    cpaCents,
  };
}

export const EMPTY_METRICS: NormalizedMetrics = {
  spendCents: 0,
  revenueCents: 0,
  purchases: 0,
  impressions: 0,
  clicks: 0,
  reach: 0,
  frequency: null,
  ctr: null,
  roas: null,
  cpaCents: null,
};
