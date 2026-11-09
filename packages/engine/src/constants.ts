/**
 * Tuning constants — every threshold from the product spec §5 lives here.
 * All money values are integer cents.
 */

/** B1 (Stop-Loss): minimum 3-day spend before a zero-purchase ad set is killed. */
export const STOP_LOSS_MIN_SPEND_3D_CENTS = 5000; // $50

/** B3 (Slow Bleed): minimum 3-day spend before a bleeding ad set is reduced. */
export const SLOW_BLEED_MIN_SPEND_3D_CENTS = 7500; // $75

/** B3: ROAS below which an ad set with purchases is considered "bleeding". */
export const SLOW_BLEED_MAX_ROAS_3D = 1.0;

/** B3: budget reduction applied when a slow bleed is detected. */
export const SLOW_BLEED_DECREASE_PCT = 0.3; // -30%

/** B2: never scale an ad set whose 3-day frequency is at/above this (audience saturation). */
export const SCALE_MAX_FREQUENCY_3D = 3.5;

/** B2: minimum 3-day ROAS to trigger scaling, per strategy. */
export const SCALE_ROAS_THRESHOLD = {
  balanced: 3.5,
  aggressive: 2.5,
} as const;

/** B2: budget increase applied when scaling, per strategy. */
export const SCALE_INCREASE_PCT = {
  balanced: 0.2, // +20%
  aggressive: 0.3, // +30%
} as const;

/** B2: minimum hours between budget changes on the same ad set, per strategy.
 *  Meta limit is ~4 changes/hour; we stay far below to avoid resetting the learning phase. */
export const SCALE_COOLDOWN_HOURS = {
  balanced: 6,
  aggressive: 3,
} as const;

/** B4 (Creative Fatigue): alert when 7-day frequency exceeds this… */
export const FATIGUE_FREQUENCY_7D = 4.0;

/** B4: …and 7-day CTR dropped below (30-day CTR × this ratio). */
export const FATIGUE_CTR_DROP_RATIO = 0.7;

/** G3 (Spend Spike): pause when 1-hour spend exceeds daily cap × this fraction. */
export const SPIKE_FRACTION_OF_DAILY_CAP = 0.5;

/** Floor for ad set daily budget after a decrease (Meta minimum is ~$1/day). */
export const MIN_ADSET_DAILY_BUDGET_CENTS = 100; // $1

export const HOUR_MS = 3_600_000;
