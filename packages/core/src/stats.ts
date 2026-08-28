import type { Distribution } from './types.js';

/** Linear-interpolation percentile (same convention as numpy's default). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loV = sorted[lo]!;
  if (lo === hi) return loV;
  return loV + (sorted[hi]! - loV) * (rank - lo);
}

export function describe(samples: number[]): Distribution | null {
  const clean = samples.filter((s) => Number.isFinite(s));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    samples: clean,
    n: clean.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: clean.reduce((a, b) => a + b, 0) / clean.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}
