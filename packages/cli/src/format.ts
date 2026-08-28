import pc from 'picocolors';
import type { ProviderResult, ProviderStatus } from '@sgp/core';

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

export function statusBadge(s: ProviderStatus): string {
  switch (s) {
    case 'ok': return pc.green('OK');
    case 'partial': return pc.yellow('PARTIAL');
    case 'error': return pc.red('ERROR');
    case 'dns': return pc.gray('DNS');
  }
}

/** Podium ordering: finishers by cold-start p50, then non-finishers, DNS last. */
export function rank(providers: ProviderResult[]): ProviderResult[] {
  const weight = (p: ProviderResult): number =>
    p.status === 'dns' ? 3 : p.status === 'error' ? 2 : p.status === 'partial' ? 1 : 0;
  return [...providers].sort((a, b) => {
    const w = weight(a) - weight(b);
    if (w !== 0) return w;
    const ap = a.coldStart?.p50 ?? Infinity;
    const bp = b.coldStart?.p50 ?? Infinity;
    return ap - bp;
  });
}

export function medal(i: number, p: ProviderResult): string {
  if (p.status === 'dns' || p.status === 'error') return '  ';
  return ['🥇', '🥈', '🥉'][i] ?? '  ';
}
