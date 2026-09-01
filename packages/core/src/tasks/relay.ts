import { isRateLimit } from '../errors.js';
import { DATASET_ROWS, referenceReduce, shardDataset } from '../dataset.js';
import type { IterationResult } from '../types.js';
import type { FleetTask, FleetContext, TaskContext } from './types.js';

const SHARD_PATH = '/tmp/shard.csv';
const MAPPER_PATH = '/tmp/mapper.py';

const MAPPER_PY = `import csv, json, sys
from collections import defaultdict

acc = defaultdict(lambda: {"count": 0, "sum": 0.0})
with open("${SHARD_PATH}", newline="") as f:
    for row in csv.DictReader(f):
        a = acc[row["category"]]
        a["count"] += 1
        a["sum"] += float(row["value"])

rows = sum(v["count"] for v in acc.values())
print(json.dumps({"rows": rows, "groups": {k: v for k, v in acc.items()}}))
`;

export interface ShardOutput {
  shard: number;
  rowsExpected: number;
  rowsProcessed: number | null;
  groups: Record<string, { count: number; sum: number }> | null;
  ok: boolean;
  note?: string;
}

export interface RelayReduction {
  fleetSize: number;
  shardsCompleted: number;
  shardsFailed: number;
  rowsExpected: number;
  rowsProcessed: number;
  /** Does the distributed reduce match a local computation exactly? */
  reduceMatchesReference: boolean;
  categories: number;
  rateLimitHits: number;
  /** Fraction of the fleet that actually came up. */
  fleetCompletion: number;
  /** Wall clock from fleet start to the last successful create. */
  provisioningWindowMs: number | null;
  /**
   * Successful creates per second across that window. Only comparable at
   * fleetCompletion == 1: a provider throttled after two sandboxes can post a
   * spectacular rate for the two it managed.
   */
  createThroughputPerSec: number | null;
  /** Whether the throughput figure above can be compared to another provider's. */
  throughputComparable: boolean;
  /** Sandboxes that came up before the provider started refusing. */
  concurrencyCeiling: number | null;
}

/**
 * RELAY — 20 sandboxes in parallel, each maps a shard of a 100k-row CSV;
 * the orchestrator reduces. Measures parallel provisioning throughput and
 * surfaces any throttling (429s) rather than hiding it behind a retry.
 */
export const relayTask: FleetTask = {
  name: 'relay',
  description: 'Fan out 20 parallel sandboxes over a 100k-row CSV, reduce in the orchestrator.',
  mode: 'fleet',
  defaultIterations: 20,

  async runFleet(ctx: FleetContext): Promise<IterationResult[]> {
    const size = ctx.size;
    const shards = shardDataset(size);

    // All at once — no pacing. Throttling is a finding, not something to avoid.
    return await Promise.all(
      shards.map((shard) =>
        ctx.spawn(shard.index, async (c: TaskContext): Promise<ShardOutput> => mapShard(c, shard)),
      ),
    );
  },

  // Stateless: everything is derived from the iterations we are handed, so
  // racing several providers in one run cannot leak state between them.
  summarize(iterations: IterationResult[]): Record<string, unknown> {
    return { ...reduce(iterations, iterations.length) };
  },
};

async function mapShard(
  c: TaskContext,
  shard: { index: number; header: string; body: string; rows: number },
): Promise<ShardOutput> {
  const base: ShardOutput = {
    shard: shard.index,
    rowsExpected: shard.rows,
    rowsProcessed: null,
    groups: null,
    ok: false,
  };

  const csv = `${shard.header}\n${shard.body}\n`;
  const wroteData = await c.provider.writeFile(c.handle, SHARD_PATH, csv, 'write:shard');
  if (!wroteData) return { ...base, note: 'shard upload failed' };

  const wroteMapper = await c.provider.writeFile(c.handle, MAPPER_PATH, MAPPER_PY, 'write:mapper');
  if (!wroteMapper) return { ...base, note: 'mapper upload failed' };

  const res = await c.provider.exec(c.handle, `python3 ${MAPPER_PATH}`, { timeoutMs: 180_000 }, 'exec:map');
  if (res.exitCode !== 0) {
    return { ...base, note: `mapper exit ${res.exitCode}: ${(res.stderr || res.stdout).slice(-200)}` };
  }

  const parsed = parseLastJson(res.stdout);
  if (!parsed) return { ...base, note: `unparsable mapper output: ${res.stdout.slice(-200)}` };

  return {
    ...base,
    rowsProcessed: typeof parsed['rows'] === 'number' ? parsed['rows'] : null,
    groups: (parsed['groups'] as ShardOutput['groups']) ?? null,
    ok: true,
  };
}

function reduce(results: IterationResult[], size: number): RelayReduction {
  const outs = results
    .map((r) => r.output as ShardOutput | undefined)
    .filter((o): o is ShardOutput => Boolean(o));

  const merged: Record<string, { count: number; sum: number }> = {};
  let rowsProcessed = 0;
  for (const o of outs) {
    if (!o.ok || !o.groups) continue;
    rowsProcessed += o.rowsProcessed ?? 0;
    for (const [cat, v] of Object.entries(o.groups)) {
      const m = (merged[cat] ??= { count: 0, sum: 0 });
      m.count += v.count;
      m.sum += v.sum;
    }
  }

  const reference = referenceReduce();
  const matches =
    Object.keys(reference).length === Object.keys(merged).length &&
    Object.entries(reference).every(([cat, ref]) => {
      const got = merged[cat];
      // Float sums accumulate in a different order across shards; compare with
      // a relative tolerance rather than demanding bit-identical results.
      return got !== undefined && got.count === ref.count && Math.abs(got.sum - ref.sum) < Math.max(1e-6, Math.abs(ref.sum) * 1e-9);
    });

  const rateLimitHits = results.reduce(
    (a, r) => a + r.errors.filter((e) => isRateLimit(e.message)).length,
    0,
  );

  // Provisioning window.
  //
  // The old definition was max(individual create duration), which silently
  // excluded creates that failed — so a provider throttled on half the fleet
  // reported the window of the half that worked, and a flattering
  // creates-per-second to go with it. Every shard starts together, so the
  // honest window is the longest wall-clock wait to a live sandbox, and
  // throughput is qualified by how much of the fleet actually came up.
  const okCreates = results.filter((r) => r.coldStartMs !== undefined).length;
  const acquisitions = results
    .map((r) => r.acquireMs ?? r.coldStartMs)
    .filter((v): v is number => typeof v === 'number');
  const windowMs = acquisitions.length ? Math.max(...acquisitions) : null;
  const completion = size > 0 ? okCreates / size : 0;

  return {
    fleetSize: size,
    shardsCompleted: outs.filter((o) => o.ok).length,
    shardsFailed: outs.filter((o) => !o.ok).length + (size - outs.length),
    rowsExpected: DATASET_ROWS,
    rowsProcessed,
    reduceMatchesReference: matches,
    categories: Object.keys(merged).length,
    rateLimitHits,
    fleetCompletion: Number(completion.toFixed(3)),
    provisioningWindowMs: windowMs,
    createThroughputPerSec:
      windowMs && windowMs > 0 ? Number((okCreates / (windowMs / 1000)).toFixed(2)) : null,
    throughputComparable: completion >= 1,
    concurrencyCeiling: okCreates,
  };
}

function parseLastJson(text: string): Record<string, unknown> | null {
  const lines = text.trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}
