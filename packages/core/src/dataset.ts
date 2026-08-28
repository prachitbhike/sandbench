import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './paths.js';

export const DATASET_ROWS = 100_000;
const CATEGORIES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

/** mulberry32 — small, fast, deterministic. Same CSV on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function datasetPath(): string {
  return resolve(repoRoot(), 'data', `relay-${DATASET_ROWS}.csv`);
}

/** Generate (and cache) the synthetic CSV. Header: id,category,value,weight */
export function ensureDataset(rows = DATASET_ROWS, seed = 42): string {
  const path = datasetPath();
  if (existsSync(path)) return path;
  mkdirSync(resolve(repoRoot(), 'data'), { recursive: true });
  const rand = mulberry32(seed);
  const parts: string[] = ['id,category,value,weight'];
  for (let i = 0; i < rows; i++) {
    const cat = CATEGORIES[Math.floor(rand() * CATEGORIES.length)]!;
    const value = Math.round(rand() * 1_000_000) / 100;
    const weight = Math.round(rand() * 100) / 10;
    parts.push(`${i},${cat},${value},${weight}`);
  }
  writeFileSync(path, `${parts.join('\n')}\n`, 'utf8');
  return path;
}

export interface Shard {
  index: number;
  header: string;
  body: string;
  rows: number;
}

/** Split the CSV into `count` contiguous shards, each carrying the header. */
export function shardDataset(count: number, rows = DATASET_ROWS): Shard[] {
  const path = ensureDataset(rows);
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const header = lines[0]!;
  const data = lines.slice(1);
  const per = Math.ceil(data.length / count);
  const shards: Shard[] = [];
  for (let i = 0; i < count; i++) {
    const slice = data.slice(i * per, (i + 1) * per);
    shards.push({ index: i, header, body: slice.join('\n'), rows: slice.length });
  }
  return shards;
}

/** Ground truth computed locally, to verify what the sandboxes send back. */
export function referenceReduce(rows = DATASET_ROWS): Record<string, { count: number; sum: number }> {
  const path = ensureDataset(rows);
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n').slice(1);
  const acc: Record<string, { count: number; sum: number }> = {};
  for (const line of lines) {
    const [, category, value] = line.split(',');
    if (!category || value === undefined) continue;
    const a = (acc[category] ??= { count: 0, sum: 0 });
    a.count += 1;
    a.sum += Number.parseFloat(value);
  }
  return acc;
}
