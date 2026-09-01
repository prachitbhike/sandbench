import { randomUUID } from 'node:crypto';
import {
  InstrumentedProvider,
  Recorder,
  aliveSeconds,
  measureExecRoundTrips,
  measureReadiness,
  now,
} from './instrument.js';
import { ENVIRONMENT_CMD, parseEnvironment } from './environment.js';
import { assessFairness } from './fairness.js';
import { computeCost } from './pricing.js';
import { getSlot } from './providers/index.js';
import { describe } from './stats.js';
import { adapterLoc, locBreakdown } from './loc.js';
import { tallyErrorKinds, toErrorRecord } from './errors.js';
import type { Task, TaskContext } from './tasks/types.js';
import type {
  Environment,
  ErrorRecord,
  IterationResult,
  ProviderResult,
  RaceResult,
  ResourceRequest,
  SandboxHandle,
  SandboxProvider,
} from './types.js';
import { SCHEMA_VERSION } from './types.js';

/**
 * What we ask every provider for by default.
 *
 * The point is not that 2 vCPU is the right size — it is that all three are
 * asked for the same thing, so a timing difference is a platform difference
 * rather than a difference in what each vendor felt like handing out.
 */
export const DEFAULT_RESOURCES: ResourceRequest = { vcpus: 2, memMib: 2048 };

/** No-op exec round trips per lap, to measure the per-command floor. */
const EXEC_RTT_SAMPLES = 5;

export interface RunOptions {
  task: Task;
  providers: string[];
  iterations?: number;
  /** Global template applied to every provider. */
  template?: string;
  /** Per-provider template overrides; wins over `template`. */
  templates?: Record<string, string>;
  resources?: ResourceRequest;
  /**
   * interleaved (default) runs lap n on every provider before lap n+1, with a
   * rotating start order, so no provider owns a privileged slice of time.
   */
  order?: 'interleaved' | 'sequential';
  /** Run one throwaway sandbox per provider before measuring. */
  formationLap?: boolean;
  /** Collect readiness / exec round-trip micro-probes. Default true. */
  probes?: boolean;
  onEvent?: (e: RaceEvent) => void;
}

export type RaceEvent =
  | { type: 'race:start'; raceId: string; task: string; providers: string[]; iterations: number; order: string }
  | { type: 'provider:start'; provider: string; iterations: number }
  | { type: 'provider:dns'; provider: string; reason: string }
  | { type: 'provider:formationLap'; provider: string; ok: boolean }
  | { type: 'iteration:start'; provider: string; iteration: number }
  | {
      type: 'iteration:end';
      provider: string;
      iteration: number;
      ok: boolean;
      coldStartMs?: number;
      timeToReadyMs?: number;
      totalMs: number;
    }
  | { type: 'provider:end'; provider: string; result: ProviderResult }
  | { type: 'race:end'; result: RaceResult };

/** Everything we carry per provider while the race is running. */
interface Lane {
  name: string;
  base: SandboxProvider;
  template: string | null;
  resources: ResourceRequest;
  iterations: IterationResult[];
  preErrors: ErrorRecord[];
  environment: Environment | null;
  environmentCaptured: boolean;
  /** Set from what the adapter reported it actually applied, not from a claim. */
  resourcesApplied: boolean | null;
  /**
   * Time this provider itself was busy — the sum of its own laps.
   *
   * NOT elapsed wall clock: under interleaving a lane's first and last laps
   * are minutes apart with other providers running in between, so elapsed time
   * would report every provider as having taken the whole race.
   */
  busyMs: number;
}

export async function runRace(opts: RunOptions): Promise<RaceResult> {
  const iterations = opts.iterations ?? opts.task.defaultIterations;
  const raceId = `${opts.task.name}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const emit = opts.onEvent ?? (() => {});
  const startedAt = new Date();
  const t0 = now();
  const resources = opts.resources ?? DEFAULT_RESOURCES;
  const probes = opts.probes ?? true;
  // A fleet task saturates the provider on purpose; interleaving two fleets
  // would have them compete for the same concurrency ceiling and measure that
  // instead of the provider.
  const order = opts.task.mode === 'fleet' ? 'sequential' : (opts.order ?? 'interleaved');

  emit({ type: 'race:start', raceId, task: opts.task.name, providers: opts.providers, iterations, order });

  const results: ProviderResult[] = [];
  const lanes: Lane[] = [];

  for (const name of opts.providers) {
    const prepared = await prepare(name, opts, emit);
    if ('dns' in prepared) results.push(prepared.dns);
    else lanes.push(prepared.lane);
  }

  for (const lane of lanes) {
    emit({ type: 'provider:start', provider: lane.name, iterations });
    if (opts.formationLap) await formationLap(lane, emit);
  }

  if (opts.task.mode === 'fleet') {
    for (const lane of lanes) {
      // A fleet genuinely runs in parallel, so elapsed time IS the measurement
      // here — sum-of-laps would count twenty concurrent sandboxes twenty times.
      const laneStart = now();
      try {
        lane.iterations = await opts.task.runFleet({
          spawn: (index, body) => runLap(lane, index, body, opts.task, probes, emit),
          size: iterations,
          ...(lane.template ? { template: lane.template } : {}),
        });
      } catch (err) {
        lane.preErrors.push(toErrorRecord('runFleet', err));
      }
      lane.busyMs = now() - laneStart;
    }
  } else if (order === 'interleaved') {
    await runInterleaved(lanes, iterations, opts.task, probes, emit);
  } else {
    for (const lane of lanes) {
      for (let i = 0; i < iterations; i++) {
        const lap = await runLap(lane, i, (ctx) => runBody(opts.task, ctx), opts.task, probes, emit);
        lane.iterations.push(lap);
        lane.busyMs += lap.totalMs;
      }
    }
  }

  for (const lane of lanes) {
    await safeShutdown(lane.base);
    const result = finalize(lane, opts.task);
    emit({ type: 'provider:end', provider: lane.name, result });
    results.push(result);
  }

  // Preserve the order the caller asked for, not the order lanes finished in.
  const byName = new Map(results.map((r) => [r.provider, r]));
  const ordered = opts.providers.map((n) => byName.get(n)).filter((r): r is ProviderResult => Boolean(r));

  const finishedAt = new Date();
  const result: RaceResult = {
    schemaVersion: SCHEMA_VERSION,
    raceId,
    task: opts.task.name,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: now() - t0,
    config: {
      iterations,
      providersRequested: opts.providers,
      ...(opts.template ? { template: opts.template } : {}),
      templates: Object.fromEntries(lanes.map((l) => [l.name, l.template])),
      resources,
      order,
      formationLap: opts.formationLap ?? false,
      probes,
    },
    providers: ordered,
  };
  result.fairness = assessFairness(result);
  emit({ type: 'race:end', result });
  return result;
}

/**
 * Lap n on every provider before lap n+1, rotating who goes first.
 *
 * Running all of provider A and then all of provider B measures two different
 * minutes of the internet. Interleaving puts every provider in the same
 * conditions; rotating the start order stops whoever is listed first from
 * permanently owning the top of each round.
 */
async function runInterleaved(
  lanes: Lane[],
  iterations: number,
  task: Task,
  probes: boolean,
  emit: (e: RaceEvent) => void,
): Promise<void> {
  for (let lap = 0; lap < iterations; lap++) {
    for (let k = 0; k < lanes.length; k++) {
      const lane = lanes[(lap + k) % lanes.length]!;
      const result = await runLap(lane, lap, (ctx) => runBody(task, ctx), task, probes, emit);
      lane.iterations.push(result);
      lane.busyMs += result.totalMs;
    }
  }
}

function runBody(task: Task, ctx: TaskContext): Promise<unknown> {
  if (task.mode !== 'perSandbox') throw new Error('runBody called for a fleet task');
  return task.run(ctx);
}

/**
 * One sandbox, one body, fully instrumented. Shared by both task modes so the
 * destroy-in-finally guarantee can never diverge between them.
 */
async function runLap(
  lane: Lane,
  index: number,
  body: (ctx: TaskContext) => Promise<unknown>,
  task: Task,
  probes: boolean,
  emit: (e: RaceEvent) => void,
): Promise<IterationResult> {
  emit({ type: 'iteration:start', provider: lane.name, iteration: index });
  const rec = new Recorder();
  const inst = new InstrumentedProvider(lane.base, rec);
  const startedAt = new Date().toISOString();
  const iStart = now();
  let handle: SandboxHandle | undefined;
  let coldStartMs: number | undefined;
  let acquireMs: number | undefined;
  let attempts = 0;
  let readyMs: number | null = null;
  let execRtt: number[] = [];
  let output: unknown;
  let ok = false;

  try {
    const created = await inst.createSandbox({
      ...(lane.template ? { template: lane.template } : {}),
      resources: lane.resources,
    });
    handle = created.handle;
    coldStartMs = created.coldStartMs;
    acquireMs = created.acquireMs;
    attempts = created.attempts;
    if (handle.resourcesApplied !== undefined) {
      // Latch to false: one lap that ran an unsized machine is enough to make
      // the comparison size-mismatched.
      lane.resourcesApplied = (lane.resourcesApplied ?? true) && handle.resourcesApplied;
    }

    if (probes) {
      readyMs = await measureReadiness(inst, handle);
      // Capture the machine once per provider: it grounds the cost model and
      // makes image parity checkable, and costs one exec for the whole race.
      if (!lane.environmentCaptured) {
        lane.environmentCaptured = true;
        const res = await inst.exec(handle, ENVIRONMENT_CMD, { timeoutMs: 60_000 }, 'probe:environment');
        // The *effective* image, not just a pinned one: an unpinned run still
        // has a known default, and recording it as "provider default" made the
        // parity check disagree with the platform table beside it.
        lane.environment = parseEnvironment(
          res.stdout,
          lane.template ?? lane.base.capabilities.defaultTemplate,
        );
      }
      if (task.mode === 'perSandbox') {
        execRtt = await measureExecRoundTrips(inst, handle, EXEC_RTT_SAMPLES);
      }
    }

    output = await body({ provider: inst, handle, rec, iteration: index });
    ok = countedErrors(rec.errors, task).length === 0;
  } catch (err) {
    // Creation failed even after its one retry, or the task body threw.
    rec.errors.push(toErrorRecord('iteration', err, index));
    ok = false;
  } finally {
    // Never leave an orphan running — this is billed time.
    await inst.destroy(handle);
  }

  const timeToReadyMs =
    coldStartMs !== undefined && readyMs !== null ? coldStartMs + readyMs : undefined;

  const ir: IterationResult = {
    iteration: index,
    ok,
    startedAt,
    totalMs: now() - iStart,
    aliveSeconds: aliveSeconds(handle),
    steps: rec.steps,
    errors: rec.errors.map((e) => ({ ...e, iteration: index })),
    retries: rec.retries,
    attempts,
    ...(coldStartMs !== undefined ? { coldStartMs } : {}),
    ...(acquireMs !== undefined ? { acquireMs } : {}),
    ...(readyMs !== null ? { readyMs } : {}),
    ...(timeToReadyMs !== undefined ? { timeToReadyMs } : {}),
    ...(execRtt.length ? { execRttMs: execRtt } : {}),
    ...(output !== undefined ? { output } : {}),
  };
  emit({
    type: 'iteration:end',
    provider: lane.name,
    iteration: index,
    ok,
    totalMs: ir.totalMs,
    ...(coldStartMs !== undefined ? { coldStartMs } : {}),
    ...(timeToReadyMs !== undefined ? { timeToReadyMs } : {}),
  });
  return ir;
}

/**
 * Errors a task expects are data, not failures.
 *
 * ESCAPE ROOM's whole point is provoking the sandbox; a provider whose memory
 * cap kills the OOM probe was doing its job. Counting that against it would
 * mark the strongest isolation as the most broken provider.
 */
function countedErrors(errors: ErrorRecord[], task: Task): ErrorRecord[] {
  if (!task.expectedErrorPhase) return errors;
  return errors.filter((e) => !task.expectedErrorPhase!(e.phase));
}

async function prepare(
  name: string,
  opts: RunOptions,
  emit: (e: RaceEvent) => void,
): Promise<{ lane: Lane } | { dns: ProviderResult }> {
  const fail = (reason: string, base?: SandboxProvider, errors: ErrorRecord[] = []): { dns: ProviderResult } => {
    const r = dns(name, reason);
    if (base) {
      r.supportsPersistence = base.supportsPersistence;
      r.capabilities = base.capabilities;
    }
    r.errors = errors;
    emit({ type: 'provider:dns', provider: name, reason });
    return { dns: r };
  };

  const slot = getSlot(name);
  if (!slot) return fail(`Unknown provider "${name}"`);
  if (!slot.make) return fail(slot.notImplementedReason ?? 'adapter not implemented');

  let base: SandboxProvider;
  try {
    base = slot.make();
  } catch (err) {
    return fail(`adapter constructor threw: ${extractShort(err)}`);
  }

  const missing = base.missingEnv();
  if (missing.length > 0) return fail(`missing env: ${missing.join(', ')}`, base);

  // Adapter-internal setup (sidecar boot, SDK client construction) —
  // deliberately untimed, so our architecture never inflates cold_start_ms.
  if (base.warmup) {
    try {
      await base.warmup();
    } catch (err) {
      const r = fail(`warmup failed: ${extractShort(err)}`, base, [toErrorRecord('warmup', err)]);
      await safeShutdown(base);
      return r;
    }
  }

  return {
    lane: {
      name,
      base,
      // Only what the caller actually pinned. A default we merely know the name
      // of must not be resent as if it had been chosen — finalize() reports it
      // as the effective image instead.
      template: opts.templates?.[name] ?? opts.template ?? null,
      resources: opts.resources ?? DEFAULT_RESOURCES,
      iterations: [],
      preErrors: [],
      environment: null,
      environmentCaptured: false,
      resourcesApplied: null,
      busyMs: 0,
    },
  };
}

/**
 * One throwaway sandbox to absorb first-call costs (image pull, lazy auth).
 * Applied uniformly to every provider, or not at all.
 */
async function formationLap(lane: Lane, emit: (e: RaceEvent) => void): Promise<void> {
  const rec = new Recorder();
  const inst = new InstrumentedProvider(lane.base, rec);
  let h: SandboxHandle | undefined;
  try {
    h = (
      await inst.createSandbox({
        ...(lane.template ? { template: lane.template } : {}),
        resources: lane.resources,
      })
    ).handle;
  } catch (err) {
    lane.preErrors.push(toErrorRecord('formationLap', err));
  } finally {
    await inst.destroy(h);
  }
  emit({ type: 'provider:formationLap', provider: lane.name, ok: lane.preErrors.length === 0 });
}

function finalize(lane: Lane, task: Task): ProviderResult {
  const { name, base } = lane;
  const iterResults = lane.iterations;
  const allErrors: ErrorRecord[] = [...lane.preErrors];
  let totalRetries = 0;
  for (const ir of iterResults) {
    allErrors.push(...ir.errors);
    totalRetries += ir.retries;
  }

  const totalAlive = iterResults.reduce((a, r) => a + r.aliveSeconds, 0);
  const coldSamples = numbers(iterResults.map((r) => r.coldStartMs));
  const readySamples = numbers(iterResults.map((r) => r.timeToReadyMs));
  const rttSamples = iterResults.flatMap((r) => r.execRttMs ?? []);
  // Lap one carries DNS/TLS/pool warm-up the rest of the run never pays again.
  const steadySamples = numbers(iterResults.slice(1).map((r) => r.coldStartMs));

  const okCount = iterResults.filter((r) => r.ok).length;
  const total = iterResults.length;
  const status =
    total === 0 ? 'error' : okCount === total ? 'ok' : okCount === 0 ? 'error' : 'partial';

  const loc = locBreakdown(name);
  const first = iterResults[0];

  return {
    provider: name,
    status,
    supportsPersistence: base.supportsPersistence,
    capabilities: base.capabilities,
    adapterLoc: adapterLoc(name),
    loc,
    template: lane.template ?? lane.environment?.template ?? base.capabilities.defaultTemplate,
    resources: {
      requested: lane.resources,
      honored: lane.resourcesApplied ?? base.capabilities.resourceControl === 'per-sandbox',
    },
    environment: lane.environment,
    iterations: iterResults,
    coldStart: describe(coldSamples),
    coldStartSteady: steadySamples.length >= 2 ? describe(steadySamples) : null,
    timeToReady: describe(readySamples),
    execRtt: describe(rttSamples),
    firstLap: first
      ? { coldStartMs: first.coldStartMs ?? null, timeToReadyMs: first.timeToReadyMs ?? null }
      : null,
    totalWallClockMs: lane.busyMs,
    totalAliveSeconds: totalAlive,
    cost: computeCost(name, totalAlive, {
      requested: lane.resources,
      requestHonored: lane.resourcesApplied ?? base.capabilities.resourceControl === 'per-sandbox',
      environment: lane.environment,
    }),
    errors: allErrors,
    errorsByKind: tallyErrorKinds(allErrors),
    retries: totalRetries,
    successRate: total > 0 ? okCount / total : 0,
    ...(task.summarize ? { summary: task.summarize(iterResults) } : {}),
  };
}

function numbers(vals: (number | undefined)[]): number[] {
  return vals.filter((v): v is number => typeof v === 'number');
}

function dns(provider: string, reason: string): ProviderResult {
  return {
    provider,
    status: 'dns',
    dnsReason: reason,
    supportsPersistence: false,
    capabilities: null,
    adapterLoc: adapterLoc(provider),
    loc: locBreakdown(provider),
    template: null,
    resources: null,
    environment: null,
    iterations: [],
    coldStart: null,
    coldStartSteady: null,
    timeToReady: null,
    execRtt: null,
    firstLap: null,
    totalWallClockMs: 0,
    totalAliveSeconds: 0,
    cost: null,
    errors: [],
    errorsByKind: {},
    retries: 0,
    successRate: 0,
  };
}

/** Adapter teardown must never take the race down with it. */
async function safeShutdown(p: SandboxProvider): Promise<void> {
  if (!p.shutdown) return;
  try {
    await p.shutdown();
  } catch {
    /* nothing actionable; the race is already over for this provider */
  }
}

function extractShort(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split('\n')[0]!.slice(0, 120);
}
