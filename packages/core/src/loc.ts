import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { repoRoot } from './paths.js';

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
 * Extra files a provider needs beyond its own adapter. The stdio RPC client
 * exists only because Modal ships no TypeScript SDK, so charging it to Modal
 * is the honest read of "SDK ergonomics".
 */
const EXTRA_FILES: Record<string, string[]> = {
  modal: ['packages/core/src/providers/sidecar.ts'],
};

/** Files that make up a provider's adapter (TS adapter + any sidecar). */
export function adapterFiles(provider: string): string[] {
  const root = repoRoot();
  const files: string[] = [];
  const ts = resolve(root, 'packages/core/src/providers', `${provider}.ts`);
  if (existsSync(ts)) files.push(ts);
  for (const rel of EXTRA_FILES[provider] ?? []) {
    const p = resolve(root, rel);
    if (existsSync(p)) files.push(p);
  }
  const sidecar = resolve(root, 'providers', `${provider}_sidecar`);
  walk(sidecar, files);
  return files;
}

export function adapterLoc(provider: string): number | null {
  const files = adapterFiles(provider);
  if (files.length === 0) return null;
  let total = 0;
  for (const f of files) total += countSignificantLines(readFileSync(f, 'utf8'));
  return total;
}

export function locReport(providers: string[]): Record<string, { loc: number | null; files: string[] }> {
  const out: Record<string, { loc: number | null; files: string[] }> = {};
  const root = repoRoot();
  for (const p of providers) {
    out[p] = {
      loc: adapterLoc(p),
      files: adapterFiles(p).map((f) => f.replace(`${root}/`, '')),
    };
  }
  return out;
}
