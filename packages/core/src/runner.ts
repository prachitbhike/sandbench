import { randomUUID } from 'node:crypto';
import { InstrumentedProvider, Recorder, aliveSeconds, now } from './instrument.js';
import { computeCost } from './pricing.js';
import { getSlot } from './providers/index.js';
import { describe } from './stats.js';
import { adapterLoc } from './loc.js';
import { toErrorRecord } from './errors.js';
import type { Task, TaskContext } from './tasks/types.js';
import type {
  ErrorRecord,
  IterationResult,
  ProviderResult,
  RaceResult,
  SandboxHandle,
  SandboxProvider,
} from './types.js';
import { SCHEMA_VERSION } from './types.js';

export interface RunOptions {
  task: Task;
  providers: string[];
  iterations?: number;
  template?: string;
  /** Run one throwaway sandbox per provider before measuring. */
  formationLap?: boolean;
  onEvent?: (e: RaceEvent) => void;
}

export type RaceEvent =
  | { type: 'race:start'; raceId: string; task: string; providers: string[]; iterations: number }
  | { type: 'provider:start'; provider: string; iterations: number }
  | { type: 'provider:dns'; provider: string; reason: string }
  | { type: 'provider:formationLap'; provider: string; ok: boolean }
  | { type: 'iteration:start'; provider: string; iteration: number }
  | { type: 'iteration:end'; provider: string; iteration: number; ok: boolean; coldStartMs?: number; totalMs: number }
  | { type: 'provider:end'; provider: string; result: ProviderResult }
  | { type: 'race:end'; result: RaceResult };

export async function runRace(opts: RunOptions): Promise<RaceResult> {
  const iterations = opts.iterations ?? opts.task.defaultIterations;
  const raceId = `${opts.task.name}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const emit = opts.onEvent ?? (() => {});
  const startedAt = new Date();
  const t0 = now();

  emit({ type: 'race:start', raceId, task: opts.task.name, providers: opts.providers, iterations });

  const results: ProviderResult[] = [];
  for (const name of opts.providers) {
    results.push(
      await runProvider(name, opts.task, iterations, opts.template, emit, opts.formationLap ?? false),
    );
  }

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
    },
    providers: results,
  };
  emit({ type: 'race:end', result });
  return result;
}

function dns(provider: string, reason: string): ProviderResult {
  return {
    provider,
    status: 'dns',
    dnsReason: reason,
    supportsPersistence: false,
    adapterLoc: adapterLoc(provider),
    iterations: [],
    coldStart: null,
    totalWallClockMs: 0,
    totalAliveSeconds: 0,
    cost: null,
    errors: [],
    retries: 0,
  };
}

async function runProvider(
  name: string,
  task: Task,
  iterations: number,
  template: string | undefined,
  emit: (e: RaceEvent) => void,
  formationLap: boolean,
): Promise<ProviderResult> {
  const slot = getSlot(name);
  if (!slot) {
    const r = dns(name, `Unknown provider "${name}"`);
    emit({ type: 'provider:dns', provider: name, reason: r.dnsReason! });
    return r;
  }
  if (!slot.make) {
    const r = dns(name, slot.notImplementedReason ?? 'adapter not implemented');
    emit({ type: 'provider:dns', provider: name, reason: r.dnsReason! });
    return r;
  }

  let base: SandboxProvider;
  try {
    base = slot.make();
  } catch (err) {
    const r = dns(name, `adapter constructor threw: ${extractShort(err)}`);
    emit({ type: 'provider:dns', provider: name, reason: r.dnsReason! });
    return r;
  }

  const missing = base.missingEnv();
  if (missing.length > 0) {
    const r = dns(name, `missing env: ${missing.join(', ')}`);
    r.supportsPersistence = base.supportsPersistence;
    emit({ type: 'provider:dns', provider: name, reason: r.dnsReason! });
    return r;
  }

  emit({ type: 'provider:start', provider: name, iterations });

  let iterResults: IterationResult[] = [];
  const allErrors: ErrorRecord[] = [];
  const preErrors: ErrorRecord[] = [];
  let totalRetries = 0;
  const pStart = now();

  // Adapter-internal setup (sidecar boot, SDK client construction) —
  // deliberately untimed, so our architecture never inflates cold_start_ms.
  if (base.warmup) {
    try {
      await base.warmup();
    } catch (err) {
      const r = dns(name, `warmup failed: ${extractShort(err)}`);
      r.supportsPersistence = base.supportsPersistence;
      r.errors = [toErrorRecord('warmup', err)];
      emit({ type: 'provider:dns', provider: name, reason: r.dnsReason! });
      await safeShutdown(base);
      return r;
    }
  }

  /**
   * One sandbox, one body, fully instrumented. Shared by both task modes so
   * the destroy-in-finally guarantee can never diverge between them.
   */
  const spawn = async (
    index: number,
    body: (ctx: TaskContext) => Promise<unknown>,
  ): Promise<IterationResult> => {
    emit({ type: 'iteration:start', provider: name, iteration: index });
    const rec = new Recorder();
    const inst = new InstrumentedProvider(base, rec);
    const iStart = now();
    let handle: SandboxHandle | undefined;
    let coldStartMs: number | undefined;
    let output: unknown;
    let ok = false;

    try {
      const created = await inst.createSandbox(template);
      handle = created.handle;
      coldStartMs = created.coldStartMs;
      output = await body({ provider: inst, handle, rec, iteration: index });
      ok = rec.errors.length === 0;
    } catch (err) {
      // Creation failed even after its one retry, or the task body threw.
      rec.errors.push(toErrorRecord('iteration', err, index));
      ok = false;
    } finally {
      // Never leave an orphan running — this is billed time.
      await inst.destroy(handle);
    }

    const ir: IterationResult = {
      iteration: index,
      ok,
      totalMs: now() - iStart,
      aliveSeconds: aliveSeconds(handle),
      steps: rec.steps,
      errors: rec.errors.map((e) => ({ ...e, iteration: index })),
      retries: rec.retries,
      ...(coldStartMs !== undefined ? { coldStartMs } : {}),
      ...(output !== undefined ? { output } : {}),
    };
    emit({
      type: 'iteration:end',
      provider: name,
      iteration: index,
      ok,
      totalMs: ir.totalMs,
      ...(coldStartMs !== undefined ? { coldStartMs } : {}),
    });
    return ir;
  };

  // Optional formation lap: one throwaway sandbox to absorb first-call costs
  // (image pull, lazy auth). Applied uniformly to every provider, or not at all.
  if (formationLap) {
    const rec = new Recorder();
    const inst = new InstrumentedProvider(base, rec);
    let h: SandboxHandle | undefined;
    try {
      h = (await inst.createSandbox(template)).handle;
    } catch (err) {
      preErrors.push(toErrorRecord('formationLap', err));
    } finally {
      await inst.destroy(h);
    }
    emit({ type: 'provider:formationLap', provider: name, ok: preErrors.length === 0 });
  }

  if (task.mode === 'fleet') {
    try {
      iterResults = await task.runFleet({
        spawn,
        size: iterations,
        ...(template ? { template } : {}),
      });
    } catch (err) {
      preErrors.push(toErrorRecord('runFleet', err));
    }
  } else {
    for (let i = 0; i < iterations; i++) {
      iterResults.push(await spawn(i, (ctx) => task.run(ctx)));
    }
  }

  await safeShutdown(base);

  allErrors.push(...preErrors);
  for (const ir of iterResults) {
    allErrors.push(...ir.errors);
    totalRetries += ir.retries;
  }

  const totalAlive = iterResults.reduce((a, r) => a + r.aliveSeconds, 0);
  const coldSamples = iterResults
    .map((r) => r.coldStartMs)
    .filter((v): v is number => typeof v === 'number');
  const okCount = iterResults.filter((r) => r.ok).length;
  const total = iterResults.length;

  const status =
    preErrors.length > 0 && total === 0
      ? 'error'
      : total === 0
        ? 'error'
        : okCount === total
          ? 'ok'
          : okCount === 0
            ? 'error'
            : 'partial';

  const result: ProviderResult = {
    provider: name,
    status,
    supportsPersistence: base.supportsPersistence,
    adapterLoc: adapterLoc(name),
    iterations: iterResults,
    coldStart: describe(coldSamples),
    totalWallClockMs: now() - pStart,
    totalAliveSeconds: totalAlive,
    cost: computeCost(name, totalAlive),
    errors: allErrors,
    retries: totalRetries,
    ...(task.summarize ? { summary: task.summarize(iterResults) } : {}),
  };
  emit({ type: 'provider:end', provider: name, result });
  return result;
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
