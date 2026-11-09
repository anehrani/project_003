/** Money formatting helpers for human-readable reasons in the action log. */

export function fmtCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtRoas(roas: number | null): string {
  return roas == null ? 'n/a' : `${roas.toFixed(1)}x`;
}

export function fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}
