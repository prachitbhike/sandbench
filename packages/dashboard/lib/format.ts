export const LIVERY: Record<string, { base: string; lit: string }> = {
  e2b: { base: 'var(--e2b)', lit: 'var(--e2b-lit)' },
  modal: { base: 'var(--modal)', lit: 'var(--modal-lit)' },
  daytona: { base: 'var(--daytona)', lit: 'var(--daytona-lit)' },
  local: { base: 'var(--local)', lit: 'var(--local-lit)' },
};

export function livery(provider: string): { base: string; lit: string } {
  return LIVERY[provider] ?? { base: 'var(--ink-3)', lit: 'var(--ink-2)' };
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v < 1000) return `${v.toFixed(0)}`;
  return `${(v / 1000).toFixed(2)}s`;
}

export function msUnit(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return v < 1000 ? 'ms' : '';
}

export function usd(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '$0.0000';
  if (v < 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(digits)}`;
}

export function gap(value: number | null, leader: number | null): string {
  if (value === null || leader === null) return '';
  const d = value - leader;
  if (d <= 0.5) return 'LEADER';
  return `+${(d / 1000).toFixed(3)}`;
}

export function humanize(key: string): string {
  return key
    .replace(/^_/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export function fmtSummaryValue(v: unknown, key = ''): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'YES' : 'NO';
  if (typeof v === 'number') {
    // A "rate" of 1 reads as the number one; as a percentage it reads as 100%.
    if (/rate$/i.test(key) && v >= 0 && v <= 1) return `${(v * 100).toFixed(0)}%`;
    if (/ms$/i.test(key)) return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`;
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    return v.toFixed(v < 1 ? 3 : 1);
  }
  return String(v);
}

export const OUTCOME_GLYPH: Record<string, string> = {
  allowed: '●',   // filled — the sandbox permitted it
  blocked: '■',   // square — stopped at the boundary
  killed: '✕',    // cross  — the sandbox died doing it
  partial: '◐',   // half   — got some of the way
  unknown: '○',   // hollow — no signal
};

export function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return `${secs.toFixed(0)}s ago`;
  if (secs < 3600) return `${(secs / 60).toFixed(0)}m ago`;
  if (secs < 86400) return `${(secs / 3600).toFixed(0)}h ago`;
  return `${(secs / 86400).toFixed(0)}d ago`;
}
