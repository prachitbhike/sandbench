import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { repoRoot } from './paths.js';
import type { LocBreakdown } from './types.js';

/**
 * SDK-ergonomics metric: significant lines of adapter code per provider.
 * Blank lines, `//` lines and `/* *\/` block comments are excluded so that a
 * well-documented adapter isn't penalised.
 */
export function countSignificantLines(src: string): number {
  let count = 0;
  let inBlock = false;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('#')) continue;
    count++;
  }
  return count;
}

const SOURCE_EXT = new Set(['.ts', '.py']);

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__pycache__' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE_EXT.has(extname(p))) out.push(p);
  }
}

/**
 * Plumbing a provider needs beyond its adapter *because of the integration
 * path we chose*, not because of the SDK itself.
 *
 * Modal's stdio RPC client and Python sidecar exist only because this adapter
 * talks to a Python SDK from TypeScript. Counting them makes Modal look ~9x
 * harder to integrate than it is — Modal ships a TypeScript SDK. So it is
 * counted, reported, and kept in its own column rather than silently folded
 * into a single "LOC" number that reads as a verdict on the vendor.
 */
const SCAFFOLDING: Record<string, string[]> = {
  modal: ['packages/core/src/providers/sidecar.ts'],
};

const SCAFFOLDING_DIR = (provider: string): string =>
  resolve(repoRoot(), 'providers', `${provider}_sidecar`);

/** The adapter file itself — pure SDK translation. */
export function adapterOnlyFiles(provider: string): string[] {
  const ts = resolve(repoRoot(), 'packages/core/src/providers', `${provider}.ts`);
  return existsSync(ts) ? [ts] : [];
}

/** Everything that exists only to make this integration path work. */
export function scaffoldingFiles(provider: string): string[] {
  const files: string[] = [];
  for (const rel of SCAFFOLDING[provider] ?? []) {
    const p = resolve(repoRoot(), rel);
    if (existsSync(p)) files.push(p);
  }
  walk(SCAFFOLDING_DIR(provider), files);
  return files;
}

/** Files that make up a provider's adapter (TS adapter + any sidecar). */
export function adapterFiles(provider: string): string[] {
  return [...adapterOnlyFiles(provider), ...scaffoldingFiles(provider)];
}

function countFiles(files: string[]): number | null {
  if (files.length === 0) return null;
  let total = 0;
  for (const f of files) total += countSignificantLines(readFileSync(f, 'utf8'));
  return total;
}

export function locBreakdown(provider: string): LocBreakdown | null {
  const adapterF = adapterOnlyFiles(provider);
  const scaffoldF = scaffoldingFiles(provider);
  if (adapterF.length === 0 && scaffoldF.length === 0) return null;
  const adapter = countFiles(adapterF);
  const scaffolding = countFiles(scaffoldF);
  const root = repoRoot();
  return {
    adapter,
    scaffolding,
    total: (adapter ?? 0) + (scaffolding ?? 0),
    files: [...adapterF, ...scaffoldF].map((f) => f.replace(`${root}/`, '')),
  };
}

export function adapterLoc(provider: string): number | null {
  return locBreakdown(provider)?.total ?? null;
}

export function locReport(providers: string[]): Record<string, LocBreakdown & { loc: number | null }> {
  const out: Record<string, LocBreakdown & { loc: number | null }> = {};
  for (const p of providers) {
    const b = locBreakdown(p) ?? { adapter: null, scaffolding: null, total: null, files: [] };
    out[p] = { ...b, loc: b.total };
  }
  return out;
}
