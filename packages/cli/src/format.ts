import pc from 'picocolors';
import { separation, type Distribution, type ProviderResult, type ProviderStatus } from '@sgp/core';

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(5)}`;
  return `$${v.toFixed(4)}`;
}

export function usdBig(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

/**
 * A median with the half-width of its bootstrap CI.
 *
 * The ± is the whole point: "118ms" invites a reader to believe the fourth
 * digit, "118ms ±14" tells them where the measurement actually stops.
 */
export function medianWithCi(d: Distribution | null | undefined): string {
  if (!d) return '—';
  const p50 = ms(d.p50);
  if (!d.ci95) return p50;
  const half = (d.ci95[1] - d.ci95[0]) / 2;
  return `${p50} ±${Math.round(half)}`;
}

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

export function statusBadge(s: ProviderStatus): string {
  switch (s) {
    case 'ok': return pc.green('OK');
    case 'partial': return pc.yellow('PARTIAL');
    case 'error': return pc.red('ERROR');
    case 'dns': return pc.gray('DNS');
  }
}

/** The metric a provider is actually ranked on for this task. */
export function headline(p: ProviderResult): Distribution | null {
  return p.timeToReady ?? p.coldStart;
}

/** Podium ordering: finishers by time-to-ready, then non-finishers, DNS last. */
export function rank(providers: ProviderResult[]): ProviderResult[] {
  const weight = (p: ProviderResult): number =>
    p.status === 'dns' ? 3 : p.status === 'error' ? 2 : p.status === 'partial' ? 1 : 0;
  return [...providers].sort((a, b) => {
    const w = weight(a) - weight(b);
    if (w !== 0) return w;
    return (headline(a)?.p50 ?? Infinity) - (headline(b)?.p50 ?? Infinity);
  });
}

/**
 * Gap to the leader, or an explicit tie.
 *
 * Printing "+5ms" next to a provider whose confidence interval overlaps the
 * leader's asserts an ordering the data does not contain. Saying "≈ tied"
 * costs one column and prevents the most common misreading of a benchmark.
 */
export function gapToLeader(p: ProviderResult, leader: ProviderResult, classified = true): string {
  const mine = headline(p);
  const theirs = headline(leader);
  if (!mine || !theirs) return '';
  if (p === leader) return pc.green('LEADER');
  if (separation(theirs, mine) === 'overlapping') return pc.yellow('≈ tied');
  const d = mine.p50 - theirs.p50;
  if (d <= 0 && classified) return '';
  // An unclassified provider is still timed on the laps it managed; the
  // asterisk stops that reading as a finishing position.
  return classified ? pc.dim(`+${ms(d)}`) : pc.dim(`${d > 0 ? '+' : ''}${ms(d)}*`);
}

export function medal(i: number, p: ProviderResult, classified: boolean): string {
  if (!classified || p.status === 'dns' || p.status === 'error') return '  ';
  return ['🥇', '🥈', '🥉'][i] ?? '  ';
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
