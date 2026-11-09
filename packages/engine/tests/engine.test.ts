import { describe, expect, it } from 'vitest';

import { evaluate } from '../src/evaluate';
import type {
  AdSetState,
  CampaignConfig,
  EngineInput,
  WindowMetrics,
} from '../src/types';

const NOW = new Date('2026-01-15T12:00:00Z');
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metrics(overrides: Partial<WindowMetrics> = {}): WindowMetrics {
  return {
    spendCents: 0,
    revenueCents: 0,
    purchases: 0,
    impressions: 0,
    clicks: 0,
    frequency: null,
    ctr: null,
    roas: null,
    cpaCents: null,
    ...overrides,
  };
}

function adSet(
  id: string,
  overrides: Partial<AdSetState> = {},
  m3: Partial<WindowMetrics> = {},
  m7: Partial<WindowMetrics> = {},
): AdSetState {
  return {
    id,
    name: `Ad Set ${id}`,
    isActive: true,
    currentDailyBudgetCents: 4000,
    lastBudgetChangeAt: null,
    metrics: { last3d: metrics(m3), last7d: metrics(m7), last30dCtr: null },
    ...overrides,
  };
}

function config(overrides: Partial<CampaignConfig> = {}): CampaignConfig {
  return {
    strategy: 'balanced',
    monthlyBudgetCents: 100000,
    dailyCapCents: 5000,
    targetCpaCents: 2500,
    targetRoas: 3.0,
    ...overrides,
  };
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    now: NOW,
    config: config(),
    spendTodayCents: 1000,
    spendThisMonthCents: 12000,
    spendLast1hCents: 100,
    adSets: [adSet('a1')],
    ...overrides,
  };
}

/** A healthy winner ad set: ROAS 4.0, CPA $7.50, frequency 2.0. */
function winner(id = 'a1'): AdSetState {
  return adSet(
    id,
    {},
    {
      spendCents: 9000,
      revenueCents: 36000,
      purchases: 12,
      roas: 4.0,
      cpaCents: 750,
      frequency: 2.0,
    },
  );
}

/** A dead loser: $60 spent, zero purchases. */
function loser(id = 'a1'): AdSetState {
  return adSet(id, {}, { spendCents: 6000, purchases: 0 });
}

/** A bleeder: $80 spent, ROAS 0.8, 2 purchases. */
function bleeder(id = 'a1'): AdSetState {
  return adSet(
    id,
    { currentDailyBudgetCents: 10000 },
    { spendCents: 8000, revenueCents: 6400, purchases: 2, roas: 0.8, cpaCents: 4000 },
  );
}

// ---------------------------------------------------------------------------
// G1 — Hard Daily Cap
// ---------------------------------------------------------------------------

describe('G1 hard daily cap', () => {
  it('pauses all active ad sets and alerts when spend reaches the cap', () => {
    const d = evaluate(input({ spendTodayCents: 5000 }));
    expect(d.guardrailTriggered).toBe('G1');
    const pause = d.actions.find((a) => a.kind === 'pause_adsets');
    expect(pause).toMatchObject({ kind: 'pause_adsets', rule: 'G1', autoResume: true });
    expect(d.actions.some((a) => a.kind === 'alert' && a.severity === 'critical')).toBe(true);
  });

  it('does not fire just below the cap', () => {
    const d = evaluate(input({ spendTodayCents: 4999 }));
    expect(d.guardrailTriggered).toBeNull();
  });

  it('short-circuits strategy rules (winner metrics are ignored)', () => {
    const d = evaluate(input({ spendTodayCents: 5100, adSets: [winner()] }));
    expect(d.actions.some((a) => a.kind === 'increase_budget')).toBe(false);
    expect(d.actions.every((a) => a.rule === 'G1')).toBe(true);
  });

  it('never re-pauses already-paused ad sets (idempotency)', () => {
    const paused = winner('a1');
    paused.isActive = false;
    const d = evaluate(input({ spendTodayCents: 6000, adSets: [paused] }));
    expect(d.actions.some((a) => a.kind === 'pause_adsets')).toBe(false);
    expect(d.actions.some((a) => a.kind === 'alert')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G2 — Hard Monthly Cap
// ---------------------------------------------------------------------------

describe('G2 hard monthly cap', () => {
  it('pauses everything when monthly budget is exhausted', () => {
    const d = evaluate(input({ spendThisMonthCents: 100000 }));
    expect(d.guardrailTriggered).toBe('G2');
    const pause = d.actions.find((a) => a.kind === 'pause_adsets');
    expect(pause && pause.kind === 'pause_adsets' && pause.autoResume).toBe(false);
  });

  it('does not fire below the monthly budget', () => {
    const d = evaluate(input({ spendThisMonthCents: 99999 }));
    expect(d.guardrailTriggered).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G3 — Spend Spike Anomaly
// ---------------------------------------------------------------------------

describe('G3 spend spike', () => {
  it('pauses when 1h spend exceeds 50% of the daily cap', () => {
    const d = evaluate(input({ spendLast1hCents: 3000 }));
    expect(d.guardrailTriggered).toBe('G3');
    expect(d.actions.some((a) => a.kind === 'pause_adsets')).toBe(true);
  });

  it('does not fire at exactly 50% of the daily cap', () => {
    const d = evaluate(input({ spendLast1hCents: 2500 }));
    expect(d.guardrailTriggered).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B1 — Stop-Loss
// ---------------------------------------------------------------------------

describe('B1 stop-loss', () => {
  it('pauses an ad set that spent $50+ over 3 days with 0 purchases', () => {
    const d = evaluate(input({ adSets: [loser()] }));
    const pause = d.actions.find((a) => a.kind === 'pause_adsets');
    expect(pause).toMatchObject({ kind: 'pause_adsets', rule: 'B1', autoResume: false });
    expect(pause && pause.kind === 'pause_adsets' && pause.adSetIds).toEqual(['a1']);
    expect((pause as any).reason).toContain('0 purchases');
  });

  it('mentions the 2x CPA limit in the reason when a target CPA is set', () => {
    const d = evaluate(input({ adSets: [loser()] })); // target $25 -> 2x = $50
    const pause = d.actions.find((a) => a.kind === 'pause_adsets');
    expect((pause as any).reason).toContain('$50.00');
  });

  it('does not fire below the $50 spend threshold', () => {
    const d = evaluate(input({ adSets: [adSet('a1', {}, { spendCents: 4999, purchases: 0 })] }));
    expect(d.actions.some((a) => a.kind === 'pause_adsets')).toBe(false);
  });

  it('does not fire when purchases exist (that is B3 territory)', () => {
    const d = evaluate(
      input({ adSets: [adSet('a1', {}, { spendCents: 8000, purchases: 1, roas: 0.2 })] }),
    );
    expect(d.actions.some((a) => a.kind === 'pause_adsets')).toBe(false);
  });

  it('fires even without a configured target CPA ($50 with nothing to show is a loser)', () => {
    const d = evaluate(input({ config: config({ targetCpaCents: null }), adSets: [loser()] }));
    expect(d.actions.some((a) => a.kind === 'pause_adsets' && a.rule === 'B1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B3 — Slow Bleed
// ---------------------------------------------------------------------------

describe('B3 slow bleed', () => {
  it('decreases budget by 30% when ROAS < 1.0 with purchases', () => {
    const d = evaluate(input({ adSets: [bleeder()] }));
    const dec = d.actions.find((a) => a.kind === 'decrease_budget');
    expect(dec).toMatchObject({
      kind: 'decrease_budget',
      rule: 'B3',
      oldCents: 10000,
      newCents: 7000,
    });
    expect((dec as any).reason).toContain('-30%');
  });

  it('does not fire at ROAS exactly 1.0', () => {
    const d = evaluate(
      input({
        adSets: [
          adSet(
            'a1',
            { currentDailyBudgetCents: 10000 },
            { spendCents: 8000, purchases: 2, roas: 1.0, cpaCents: 4000 },
          ),
        ],
      }),
    );
    expect(d.actions.some((a) => a.kind === 'decrease_budget')).toBe(false);
  });

  it('never decreases below the $1 floor', () => {
    const d = evaluate(
      input({
        adSets: [
          adSet(
            'a1',
            { currentDailyBudgetCents: 120 },
            { spendCents: 8000, purchases: 2, roas: 0.5 },
          ),
        ],
      }),
    );
    const dec = d.actions.find((a) => a.kind === 'decrease_budget');
    expect(dec && dec.kind === 'decrease_budget' && dec.newCents).toBe(100);
  });

  it('does not fire in protect strategy', () => {
    const d = evaluate(
      input({
        config: config({ strategy: 'protect' }),
        adSets: [bleeder()],
      }),
    );
    expect(d.actions.some((a) => a.kind === 'decrease_budget')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B2 — Scale Winner
// ---------------------------------------------------------------------------

describe('B2 scale winner (balanced)', () => {
  it('increases budget by 20% when ROAS ≥ 3.5, CPA ≤ target, frequency < 3.5', () => {
    const d = evaluate(input({ adSets: [winner()] }));
    const inc = d.actions.find((a) => a.kind === 'increase_budget');
    expect(inc).toMatchObject({
      kind: 'increase_budget',
      rule: 'B2',
      oldCents: 4000,
      newCents: 4800,
    });
    expect((inc as any).reason).toContain('+20%');
    expect((inc as any).reason).toContain('$7.50');
  });

  it('clamps the new budget to the daily cap', () => {
    const w = winner();
    w.currentDailyBudgetCents = 4500;
    const d = evaluate(input({ adSets: [w] }));
    const inc = d.actions.find((a) => a.kind === 'increase_budget');
    expect(inc && inc.kind === 'increase_budget' && inc.newCents).toBe(5000);
  });

  it('does not scale when the budget already sits at the cap', () => {
    const w = winner();
    w.currentDailyBudgetCents = 5000;
    const d = evaluate(input({ adSets: [w] }));
    expect(d.actions.some((a) => a.kind === 'increase_budget')).toBe(false);
    expect(d.log.some((l) => l.includes('no headroom'))).toBe(true);
  });

  it('respects the 6h cooldown (2h ago → throttled)', () => {
    const w = winner();
    w.lastBudgetChangeAt = new Date(NOW.getTime() - 2 * HOUR);
    const d = evaluate(input({ adSets: [w] }));
    expect(d.actions.some((a) => a.kind === 'increase_budget')).toBe(false);
    expect(d.log.some((l) => l.includes('throttled'))).toBe(true);
  });

  it('allows scaling again after the 6h cooldown (6h ago → fires)', () => {
    const w = winner();
    w.lastBudgetChangeAt = new Date(NOW.getTime() - 6 * HOUR);
    const d = evaluate(input({ adSets: [w] }));
    expect(d.actions.some((a) => a.kind === 'increase_budget')).toBe(true);
  });

  it('does not scale a saturated audience (frequency ≥ 3.5)', () => {
    const w = winner('a1');
    w.metrics.last3d.frequency = 3.5;
    const d = evaluate(input({ adSets: [w] }));
    expect(d.actions.some((a) => a.kind === 'increase_budget')).toBe(false);
  });

  it('does not scale below the 3.5 ROAS threshold (balanced)', () => {
    const w = winner('a1');
    w.metrics.last3d.roas = 3.4;
    const d = evaluate(input({ adSets: [w] }));
    expect(d.actions.some((a) => a.kind === 'increase_budget')).toBe(false);
  });

  it('never scales in protect strategy', () => {
    const d = evaluate(input({ config: config({ strategy: 'protect' }), adSets: [winner()] }));
    expect(d.actions.some((a) => a.kind === 'increase_budget')).toBe(false);
  });
});

describe('B2 scale winner (aggressive)', () => {
  it('scales at ROAS ≥ 2.5 with +30%', () => {
    const w = winner('a1');
    w.metrics.last3d.roas = 3.0; // below balanced threshold, above aggressive
    const d = evaluate(
      input({ config: config({ strategy: 'aggressive', dailyCapCents: 6000 }), adSets: [w] }),
    );
    const inc = d.actions.find((a) => a.kind === 'increase_budget');
    expect(inc).toMatchObject({ rule: 'B2', oldCents: 4000, newCents: 5200 });
    expect((inc as any).reason).toContain('+30%');
  });

  it('uses a 3h cooldown (2h ago → throttled, 3h ago → fires)', () => {
    const w2h = winner('a1');
    w2h.lastBudgetChangeAt = new Date(NOW.getTime() - 2 * HOUR);
    const d1 = evaluate(
      input({ config: config({ strategy: 'aggressive' }), adSets: [w2h] }),
    );
    expect(d1.actions.some((a) => a.kind === 'increase_budget')).toBe(false);

    const w3h = winner('a1');
    w3h.lastBudgetChangeAt = new Date(NOW.getTime() - 3 * HOUR);
    const d2 = evaluate(
      input({ config: config({ strategy: 'aggressive' }), adSets: [w3h] }),
    );
    expect(d2.actions.some((a) => a.kind === 'increase_budget')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B4 — Creative Fatigue (alert only)
// ---------------------------------------------------------------------------

describe('B4 creative fatigue', () => {
  it('alerts when frequency > 4.0 and CTR dropped below 70% of 30d baseline', () => {
    const a = adSet(
      'a1',
      {},
      { frequency: 2.0 },
      { frequency: 4.5, ctr: 0.005 },
    );
    a.metrics.last30dCtr = 0.012;
    const d = evaluate(input({ adSets: [a] }));
    const alert = d.actions.find((a) => a.kind === 'alert' && a.rule === 'B4');
    expect(alert).toBeDefined();
    expect((alert as any).severity).toBe('info');
    expect((alert as any).message).toContain('Creative fatigue');
    expect(d.actions.some((a) => a.kind === 'pause_adsets')).toBe(false);
  });

  it('does not fire when CTR held up', () => {
    const a = adSet('a1', {}, {}, { frequency: 4.5, ctr: 0.009 });
    a.metrics.last30dCtr = 0.012; // 0.009 >= 0.0084
    const d = evaluate(input({ adSets: [a] }));
    expect(d.actions.some((a) => a.kind === 'alert' && a.rule === 'B4')).toBe(false);
  });

  it('does not fire below frequency 4.0', () => {
    const a = adSet('a1', {}, {}, { frequency: 3.9, ctr: 0.005 });
    a.metrics.last30dCtr = 0.012;
    const d = evaluate(input({ adSets: [a] }));
    expect(d.actions.some((a) => a.kind === 'alert' && a.rule === 'B4')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strategy behaviors & execution order
// ---------------------------------------------------------------------------

describe('strategy & execution order', () => {
  it('balanced: handles loser + bleeder + winner in one pass, in spec order', () => {
    const d = evaluate(
      input({ adSets: [loser('bad'), bleeder('bleed'), winner('good')] }),
    );
    const kinds = d.actions.map((a) => (a.kind === 'alert' ? 'alert' : a.kind));
    expect(kinds).toEqual(['pause_adsets', 'decrease_budget', 'increase_budget']);
    const pause: any = d.actions[0];
    expect(pause.adSetIds).toEqual(['bad']);
    const dec: any = d.actions[1];
    expect(dec.adSetId).toBe('bleed');
    const inc: any = d.actions[2];
    expect(inc.adSetId).toBe('good');
  });

  it('protect: only pauses losers — no budget changes at all', () => {
    const d = evaluate(
      input({
        config: config({ strategy: 'protect' }),
        adSets: [loser('bad'), bleeder('bleed'), winner('good')],
      }),
    );
    expect(d.actions.filter((a) => a.kind === 'pause_adsets')).toHaveLength(1);
    expect(d.actions.some((a) => a.kind === 'increase_budget')).toBe(false);
    expect(d.actions.some((a) => a.kind === 'decrease_budget')).toBe(false);
    expect(d.log.some((l) => l.includes('disabled'))).toBe(true);
  });

  it('aggressive: scales more readily than balanced', () => {
    const w = winner('a1');
    w.metrics.last3d.roas = 3.0;
    const balanced = evaluate(input({ adSets: [w] }));
    const aggressive = evaluate(
      input({ config: config({ strategy: 'aggressive' }), adSets: [w] }),
    );
    expect(balanced.actions.some((a) => a.kind === 'increase_budget')).toBe(false);
    expect(aggressive.actions.some((a) => a.kind === 'increase_budget')).toBe(true);
  });

  it('never touches paused ad sets with B-rules (idempotency)', () => {
    const dead = loser('dead');
    dead.isActive = false;
    const d = evaluate(input({ adSets: [dead, winner('good')] }));
    const pause: any = d.actions.find((a) => a.kind === 'pause_adsets');
    expect(pause).toBeUndefined(); // dead one is already paused
    expect(d.actions.some((a) => a.kind === 'increase_budget')).toBe(true);
  });

  it('always writes a debug log, including no-op decisions', () => {
    const d = evaluate(input({ adSets: [winner()] }));
    expect(d.log.length).toBeGreaterThan(3);
    expect(d.log.some((l) => l.startsWith('Check complete'))).toBe(true);
  });
});
