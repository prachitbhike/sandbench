import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null = null;

/** Walk up from this module until we find the workspace marker. */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}

/**
 * Where race files are read from and written to.
 *
 * `SGP_RESULTS_DIR` lets you keep result sets apart — a scratch directory
 * while developing the dashboard, or one directory per measurement campaign,
 * without mixing them into the repo's own history of runs.
 */
export function resultsDir(): string {
  const override = process.env['SGP_RESULTS_DIR'];
  if (override) return resolve(override);
  return resolve(repoRoot(), 'results');
}
