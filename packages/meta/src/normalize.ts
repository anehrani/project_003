/** Converts raw Meta insights rows into engine-ready normalized metrics. */

import type { NormalizedInsights, RawInsightsRow } from './types';

/** Meta action types that count as a purchase/conversion for our purposes. */
const PURCHASE_ACTION_TYPES = new Set([
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'onsite_conversion.purchase',
  'offsite_conversion',
]);

function toCents(v: string | undefined): number {
  if (!v) return 0;
  return Math.round(parseFloat(v) * 100) || 0;
}

function toInt(v: string | undefined): number {
  if (!v) return 0;
  return parseInt(v, 10) || 0;
}

function sumActions(
  rows: Array<{ action_type: string; value: string }> | undefined,
  predicate: (t: string) => boolean,
): number {
  if (!rows) return 0;
  return rows.reduce((acc, a) => (predicate(a.action_type) ? acc + (parseFloat(a.value) || 0) : acc), 0);
}

export function normalizeInsights(row: RawInsightsRow | undefined | null): NormalizedInsights {
  const spendCents = toCents(row?.spend);
  const revenueCents = toCents(row?.action_values?.find((a) => PURCHASE_ACTION_TYPES.has(a.action_type))?.value) ||
    sumActions(row?.action_values, (t) => PURCHASE_ACTION_TYPES.has(t));
  const purchases = Math.round(sumActions(row?.actions, (t) => PURCHASE_ACTION_TYPES.has(t)));
  const impressions = toInt(row?.impressions);
  const clicks = toInt(row?.clicks);
  const reach = toInt(row?.reach);

  // Meta's `ctr` field is a percentage ("1.23" = 1.23%); engine expects a fraction.
  const ctrPct = row?.ctr ? parseFloat(row.ctr) : null;
  const ctr = ctrPct != null && !Number.isNaN(ctrPct) ? ctrPct / 100 : null;

  return {
    spendCents,
    revenueCents,
    purchases,
    impressions,
    clicks,
    reach,
    frequency: reach > 0 ? impressions / reach : null,
    ctr,
    roas: spendCents > 0 ? revenueCents / spendCents : null,
    cpaCents: purchases > 0 ? Math.round(spendCents / purchases) : null,
  };
}

export const EMPTY_INSIGHTS: NormalizedInsights = {
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
