import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resultsDir } from './paths.js';
import type { RaceResult } from './types.js';

/** Append-only: one JSON file per race run, never overwritten. */
export function writeResult(result: RaceResult): string {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${result.raceId}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return path;
}

export function listResultFiles(): string[] {
  const dir = resultsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f))
    .sort();
}

export function readResult(path: string): RaceResult | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RaceResult;
    return parsed.schemaVersion ? parsed : null;
  } catch {
    return null;
  }
}

export function loadAllResults(): RaceResult[] {
  return listResultFiles()
    .map(readResult)
    .filter((r): r is RaceResult => r !== null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Most recent run per task — what `sgp report` shows by default. */
export function latestPerTask(results?: RaceResult[]): Map<string, RaceResult> {
  const all = results ?? loadAllResults();
  const map = new Map<string, RaceResult>();
  for (const r of all) {
    const prev = map.get(r.task);
    if (!prev || r.startedAt > prev.startedAt) map.set(r.task, r);
  }
  return map;
}
