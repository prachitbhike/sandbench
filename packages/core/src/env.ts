import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { repoRoot } from './paths.js';

let loaded = false;

/**
 * Load env files from the repo root exactly once, in precedence order:
 * `.env.local` (git-ignored, machine-specific) wins over `.env`, and a real
 * process env var always wins over both — dotenv never overrides what is set.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const name of ['.env.local', '.env']) {
    const p = resolve(repoRoot(), name);
    if (existsSync(p)) dotenv.config({ path: p });
  }
}
