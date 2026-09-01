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

/**
 * Below this, a "p95" is just the largest sample wearing a lab coat: with
 * n=10 the 95th percentile is interpolated between the top two values, so it
 * moves by a whole outlier. Reported, but flagged.
 */
export const TAIL_RELIABLE_N = 20;

/** mulberry32 — the resampler is seeded so a result file is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap 95% CI on the median.
 *
 * Non-parametric on purpose — cold-start samples are right-skewed with fat
 * tails, so anything assuming normality would report a confidence interval
 * far tighter than the data supports. Below n=4 we return null instead of a
 * number that would only look authoritative.
 */
export function bootstrapMedianCi(
  samples: number[],
  resamples = 2000,
  seed = 0x5eed,
): [number, number] | null {
  const n = samples.length;
  if (n < 4) return null;
  const rand = mulberry32(seed);
  const medians: number[] = new Array(resamples);
  const draw: number[] = new Array(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) draw[i] = samples[Math.floor(rand() * n)]!;
    draw.sort((a, b) => a - b);
    medians[r] = percentile(draw, 50);
  }
  medians.sort((a, b) => a - b);
  return [percentile(medians, 2.5), percentile(medians, 97.5)];
}

export function describe(samples: number[], seed = 0x5eed): Distribution | null {
  const clean = samples.filter((s) => Number.isFinite(s));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance =
    clean.length > 1
      ? clean.reduce((a, b) => a + (b - mean) ** 2, 0) / (clean.length - 1)
      : 0;
  return {
    samples: clean,
    n: clean.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    stdev: Math.sqrt(variance),
    ci95: bootstrapMedianCi(clean, 2000, seed),
    tailReliable: clean.length >= TAIL_RELIABLE_N,
  };
}

export type Separation = 'separated' | 'overlapping' | 'unknown';

/**
 * Can these two medians be told apart at all?
 *
 * Overlapping confidence intervals mean the ordering between two providers is
 * not supported by the data. A benchmark that prints a podium without saying
 * this is inviting the reader to over-read a few milliseconds of noise.
 */
export function separation(a: Distribution | null, b: Distribution | null): Separation {
  if (!a?.ci95 || !b?.ci95) return 'unknown';
  const [aLo, aHi] = a.ci95;
  const [bLo, bHi] = b.ci95;
  return aHi < bLo || bHi < aLo ? 'separated' : 'overlapping';
}

/** Relative spread — how repeatable a provider is, independent of its speed. */
export function coefficientOfVariation(d: Distribution | null): number | null {
  if (!d || d.mean === 0) return null;
  return d.stdev / d.mean;
}
