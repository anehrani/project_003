/**
 * Deterministic demo data for the landing-page dashboard preview.
 * IMPORTANT: computed from a fixed seed (never Math.random()) so server and
 * client render identical values — no hydration mismatches.
 */

export interface DayPoint {
  date: string;
  spend: number;
  revenue: number;
  action: 'pause' | 'scale' | 'decrease' | null;
}

export interface ActionLogRow {
  time: string;
  adSet: string;
  action: 'paused' | 'scaled' | 'decreased' | 'alert' | 'resumed';
  detail: string;
  reason: string;
  impact: string;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTH_LABELS = ['Oct', 'Nov'];

/** Fixed 7-day window (matches the KPI cards below). */
export const SERIES_7D: DayPoint[] = [
  { date: 'Nov 3', spend: 38.4, revenue: 142.6, action: null },
  { date: 'Nov 4', spend: 44.2, revenue: 178.1, action: 'pause' },
  { date: 'Nov 5', spend: 41.8, revenue: 165.0, action: null },
  { date: 'Nov 6', spend: 47.5, revenue: 190.2, action: 'scale' },
  { date: 'Nov 7', spend: 46.1, revenue: 171.4, action: 'decrease' },
  { date: 'Nov 8', spend: 49.8, revenue: 201.9, action: null },
  { date: 'Nov 9', spend: 42.1, revenue: 160.3, action: null },
];

/** 30-day series from a fixed seed — deterministic across renders. */
function build30d(): DayPoint[] {
  const rand = mulberry32(20261109);
  const points: DayPoint[] = [];
  for (let i = 0; i < 30; i++) {
    const day = i + 11; // Oct 11 → Nov 9
    const month = day > 31 ? MONTH_LABELS[1] : MONTH_LABELS[0];
    const dom = day > 31 ? day - 31 : day;
    const spend = 34 + rand() * 18;
    const roas = 2.6 + rand() * 1.9;
    points.push({
      date: `${month} ${dom}`,
      spend: Math.round(spend * 10) / 10,
      revenue: Math.round(spend * roas * 10) / 10,
      action:
        i === 4 ? 'pause' : i === 12 ? 'scale' : i === 18 ? 'decrease' : i === 25 ? 'pause' : null,
    });
  }
  return points;
}

export const SERIES_30D: DayPoint[] = build30d();

export const KPIS = {
  spendToday: { value: 42.1, cap: 50, pct: 84 },
  spendMonth: { value: 612, budget: 1000, pct: 61 },
  roas7d: { value: '3.8x', delta: '+0.4x vs prior week', positive: true },
  cpa7d: { value: '$19.40', delta: '−$5.60 vs target $25.00', positive: true },
  moneySaved: { value: 132.5, detail: 'this month · from 6 paused losers' },
};

export const ACTION_LOG: ActionLogRow[] = [
  {
    time: 'Today 02:15',
    adSet: 'Summer Sale – 25-34',
    action: 'paused',
    detail: 'Paused',
    reason: 'CPA $58 > Target $25 · Spend $62 · 0 purchases',
    impact: 'Saved ~$48',
  },
  {
    time: 'Today 09:00',
    adSet: 'Summer Sale – 35-44',
    action: 'scaled',
    detail: 'Budget +20% · $40 → $48',
    reason: 'ROAS 4.5x for 3 days · CPA $18 ≤ $25 · Frequency 2.1',
    impact: '+$12 spend/day',
  },
  {
    time: 'Yesterday 23:40',
    adSet: 'Summer Sale – 45+',
    action: 'decreased',
    detail: 'Budget −30% · $30 → $21',
    reason: 'ROAS 0.8 on $75 spend · 2 purchases (slow bleed)',
    impact: '−$9 spend/day',
  },
  {
    time: 'Yesterday 14:05',
    adSet: 'Summer Sale – 25-34',
    action: 'alert',
    detail: 'Creative fatigue alert',
    reason: 'Frequency 4.2 > 4.0 · CTR down 34% vs 30-day baseline',
    impact: 'New creative suggested',
  },
  {
    time: 'Nov 6 00:00',
    adSet: 'All ad sets',
    action: 'resumed',
    detail: 'Auto-resumed',
    reason: 'New day started — daily cap pause lifted automatically',
    impact: 'Spend reset to $0 / $50',
  },
  {
    time: 'Nov 5 21:30',
    adSet: 'All ad sets',
    action: 'paused',
    detail: 'Paused',
    reason: 'Daily cap reached: $50.00 ≥ $50 cap — budget protected',
    impact: 'Overspend prevented',
  },
];

export const STRATEGIES = [
  {
    name: 'Balanced Autopilot',
    tag: 'Recommended',
    risk: 'Low',
    riskColor: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    forWho: 'Most store owners. Protects your budget and scales what works.',
    rules: ['Pauses losers: $50 spent, 0 sales in 3 days', 'Scales winners: +20% when ROAS ≥ 3.5', 'Slows bleeds: −30% when ROAS < 1.0'],
  },
  {
    name: 'Protect Only',
    tag: 'Cautious',
    risk: 'Low',
    riskColor: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    forWho: 'Nervous beginners. Only ever pauses losers — never spends more.',
    rules: ['Pauses losers: $50 spent, 0 sales in 3 days', 'All guardrails active (caps + spike alerts)', 'Never touches budgets upward'],
  },
  {
    name: 'Aggressive Scale',
    tag: 'Growth',
    risk: 'Medium',
    riskColor: 'bg-amber-100 text-amber-700 border-amber-200',
    forWho: 'Winning products. Scales harder and faster, tolerates higher CPA.',
    rules: ['Scales winners: +30% when ROAS ≥ 2.5', 'Checks every 3 hours instead of 6', 'All guardrails still hard-capped'],
  },
] as const;

export const PLANS = [
  {
    name: 'Starter',
    price: 29,
    blurb: 'For one store getting serious about Meta.',
    features: ['1 ad account', 'Up to $2k/mo ad spend', 'Balanced Autopilot strategy', 'Dashboard + action log', 'Email alerts', '14-day free trial'],
    cta: 'Start free trial',
    featured: false,
  },
  {
    name: 'Pro',
    price: 99,
    blurb: 'For growing brands running multiple campaigns.',
    features: ['3 ad accounts', 'Up to $10k/mo ad spend', 'All 3 strategies', 'Slack alerts', 'Weekly report email', 'Priority support'],
    cta: 'Start free trial',
    featured: true,
  },
  {
    name: 'Agency',
    price: 249,
    blurb: 'For freelancers and small agencies protecting clients.',
    features: ['10 ad accounts', 'Up to $50k/mo ad spend', 'All 3 strategies', 'Weekly client-ready reports', 'Slack alerts', 'Priority support'],
    cta: 'Start free trial',
    featured: false,
  },
] as const;
