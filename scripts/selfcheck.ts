/**
 * Fault-injection self-check for the harness invariants.
 *
 * Lifecycle:
 *   1. createSandbox retries exactly once, then gives up
 *   2. destroy() always runs, even when the task body throws
 *   3. exec is never retried
 *   4. a destroy() failure is recorded but does not crash the race
 *
 * Fairness — the controls that make a comparison a comparison:
 *   5. providers are interleaved lap by lap, with a rotating start order
 *   6. the requested machine size is recorded as honoured only when an adapter
 *      says it applied it
 *   7. errors a task declares as expected do not count against a provider
 *   8. a retry's failed attempt shows up in acquire time instead of vanishing
 *   9. micro-probes are collected when on, and absent when off
 *  10. the run reports its own caveats rather than presenting a bare podium
 */
import { runRace } from '../packages/core/src/runner.js';
import type {
  ExecResult,
  ProviderCapabilities,
  SandboxHandle,
  SandboxProvider,
} from '../packages/core/src/types.js';
import type { FleetTask, Task } from '../packages/core/src/tasks/types.js';

const MOCK_CAPS: ProviderCapabilities = {
  nativeTsSdk: true,
  externalRuntime: null,
  resourceControl: 'per-sandbox',
  registryImages: false,
  separateStderr: true,
  nonZeroExitThrows: false,
  defaultTemplate: null,
};

let created = 0;
let destroyed = 0;
let execCalls = 0;

class FlakyProvider implements SandboxProvider {
  readonly name = 'e2b'; // borrow a registered slot name for pricing/LOC lookup
  readonly supportsPersistence = true;
  readonly capabilities = MOCK_CAPS;
  constructor(
    private readonly failCreateTimes: number,
    private readonly failDestroy = false,
    private readonly createDelayMs = 0,
  ) {}
  missingEnv(): string[] { return []; }
  async createSandbox(): Promise<SandboxHandle> {
    created++;
    if (created <= this.failCreateTimes) {
      // Fail slowly: the whole point of acquireMs is that a slow failure
      // followed by a fast success must not report as a fast create.
      if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
      throw new Error(`boom create #${created}`);
    }
    return { id: `s${created}`, provider: this.name, createdAt: Date.now(), native: {} };
  }
  async exec(): Promise<ExecResult> {
    execCalls++;
    throw new Error('boom exec');
  }
  async writeFile(): Promise<void> {}
  async readFile(): Promise<string> { return ''; }
  async destroy(): Promise<void> {
    destroyed++;
    if (this.failDestroy) throw new Error('boom destroy');
  }
}

/** Answers every command, so probes and task bodies both succeed. */
class HealthyProvider implements SandboxProvider {
  readonly supportsPersistence = true;
  readonly capabilities: ProviderCapabilities;
  constructor(
    readonly name: string,
    private readonly log?: string[],
    resourceControl: ProviderCapabilities['resourceControl'] = 'per-sandbox',
    private readonly applyResources = true,
  ) {
    this.capabilities = { ...MOCK_CAPS, resourceControl };
  }
  missingEnv(): string[] { return []; }
  async createSandbox(): Promise<SandboxHandle> {
    created++;
    this.log?.push(this.name);
    return {
      id: `${this.name}-${created}`,
      provider: this.name,
      createdAt: Date.now(),
      resourcesApplied: this.applyResources,
      native: {},
    };
  }
  async exec(_h: SandboxHandle, cmd: string): Promise<ExecResult> {
    execCalls++;
    const stdout = cmd.includes('__SGP_READY__') ? '__SGP_READY__\n' : 'ok';
    return { stdout, stderr: '', exitCode: 0, durationMs: 0 };
  }
  async writeFile(): Promise<void> {}
  async readFile(): Promise<string> { return ''; }
  async destroy(): Promise<void> { destroyed++; }
}

const throwingTask: Task = {
  name: 'selfcheck', description: 'fault injection', mode: 'perSandbox', defaultIterations: 1,
  async run(ctx) { await ctx.provider.exec(ctx.handle, 'true'); throw new Error('task body exploded'); },
};

const quietTask: Task = {
  name: 'selfcheck-quiet', description: 'does nothing loudly', mode: 'perSandbox', defaultIterations: 1,
  async run() { return { ok: true }; },
};

/** Mirrors ESCAPE ROOM: the probe failing IS the measurement. */
const provokingTask: Task = {
  name: 'selfcheck-probe', description: 'expects its probe to fail', mode: 'perSandbox', defaultIterations: 1,
  async run(ctx) {
    ctx.rec.error('probe:memory_oom', new Error('sandbox died under the OOM probe'));
    return { probed: true };
  },
  expectedErrorPhase: (phase) => phase.startsWith('probe:'),
};

function reset(): void { created = 0; destroyed = 0; execCalls = 0; }

let failures = 0;
function check(label: string, cond: boolean, detail: string): void {
  console.log(`${cond ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${label} — ${detail}`);
  if (!cond) failures++;
}

function section(title: string): void {
  console.log(`\n  \x1b[2m${title}\x1b[0m`);
}

/** Bypass the registry so we can inject: temporarily monkey-patch the slots. */
async function run(
  providers: Record<string, SandboxProvider>,
  task: Task,
  iterations = 1,
  extra: Partial<Parameters<typeof runRace>[0]> = {},
) {
  const mod = await import('../packages/core/src/providers/index.js');
  const originals: Record<string, unknown> = {};
  for (const [name, impl] of Object.entries(providers)) {
    originals[name] = mod.getSlot(name)!.make;
    (mod.getSlot(name) as { make: unknown }).make = () => impl;
  }
  try {
    return await runRace({
      task,
      providers: Object.keys(providers),
      iterations,
      // Probes are on in real races; the fault-injection checks turn them off
      // so their exec calls do not confuse the "exec is never retried" count.
      probes: false,
      ...extra,
    });
  } finally {
    for (const [name, orig] of Object.entries(originals)) {
      (mod.getSlot(name) as { make: unknown }).make = orig;
    }
  }
}

console.log('\nharness self-check');

section('lifecycle');

// 1. one transient create failure -> retried once -> succeeds
reset();
let r = await run({ e2b: new FlakyProvider(1, false, 120) }, throwingTask);
let p = r.providers[0]!;
check('retry-once', created === 2, `createSandbox called ${created}x (expected 2: initial + 1 retry)`);
check('retry-counted', p.retries === 1, `retries recorded = ${p.retries}`);
check('destroy-after-task-throw', destroyed === 1, `destroy called ${destroyed}x despite task throwing`);
check('exec-not-retried', execCalls === 1, `exec called ${execCalls}x (expected 1: no retry on exec)`);
check('errors-captured', p.errors.length >= 2, `${p.errors.length} errors recorded, race did not crash`);

// 8. the failed attempt is charged to acquire time, not discarded
const lap = p.iterations[0]!;
check('acquire-includes-failed-attempt',
  (lap.acquireMs ?? 0) >= 100 && (lap.acquireMs ?? 0) > (lap.coldStartMs ?? 0),
  `acquire ${lap.acquireMs}ms vs cold start ${lap.coldStartMs}ms after a 120ms failure`);
check('attempts-recorded', lap.attempts === 2, `attempts = ${lap.attempts}`);

// 2. persistent create failure -> exactly 2 attempts, no destroy, still no crash
reset();
r = await run({ e2b: new FlakyProvider(99) }, throwingTask);
p = r.providers[0]!;
check('give-up-after-one-retry', created === 2, `createSandbox called ${created}x then gave up`);
check('no-destroy-without-handle', destroyed === 0, `destroy called ${destroyed}x (nothing to destroy)`);
check('status-error', p.status === 'error', `status = ${p.status}`);
check('race-still-written', r.providers.length === 1, 'race object produced despite total failure');

// 3. destroy failure is recorded, not fatal
reset();
r = await run({ e2b: new FlakyProvider(0, true) }, throwingTask);
p = r.providers[0]!;
const orphan = p.iterations[0]!.steps.find((s) => s.name === 'destroy');
check('destroy-failure-recorded', orphan?.ok === false && orphan.note === 'ORPHAN RISK',
  `destroy step note = ${orphan?.note ?? 'missing'}`);
check('no-crash-on-destroy-failure', r.providers[0]!.iterations.length === 1, 'iteration completed');

section('fleet');

// 4. fleet mode: parallel spawn, every sandbox destroyed, one bad shard
//    must not take the fleet down.
class FleetProvider implements SandboxProvider {
  readonly name = 'e2b';
  readonly supportsPersistence = true;
  readonly capabilities = MOCK_CAPS;
  concurrentPeak = 0;
  private live = 0;
  missingEnv(): string[] { return []; }
  async createSandbox(): Promise<SandboxHandle> {
    created++;
    this.live++;
    this.concurrentPeak = Math.max(this.concurrentPeak, this.live);
    await new Promise((r) => setTimeout(r, 20));
    return { id: `f${created}`, provider: this.name, createdAt: Date.now(), native: {} };
  }
  async exec(): Promise<ExecResult> {
    execCalls++;
    return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 0 };
  }
  async writeFile(): Promise<void> {}
  async readFile(): Promise<string> { return ''; }
  async destroy(): Promise<void> { destroyed++; this.live--; }
}

const FLEET_SIZE = 12;
const fleetTask: FleetTask = {
  name: 'selfcheck-fleet', description: 'parallel fan-out', mode: 'fleet', defaultIterations: FLEET_SIZE,
  async runFleet(ctx) {
    return await Promise.all(
      Array.from({ length: ctx.size }, (_, i) =>
        ctx.spawn(i, async (c) => {
          await c.provider.exec(c.handle, 'true');
          // Shard 3 throws: the other 11 must still finish and be destroyed.
          if (i === 3) throw new Error('shard 3 exploded');
          return { shard: i };
        }),
      ),
    );
  },
};

reset();
const fleetProvider = new FleetProvider();
r = await run({ e2b: fleetProvider }, fleetTask, FLEET_SIZE);
p = r.providers[0]!;
check('fleet-all-spawned', created === FLEET_SIZE, `created ${created}/${FLEET_SIZE} sandboxes`);
check('fleet-all-destroyed', destroyed === FLEET_SIZE, `destroyed ${destroyed}/${FLEET_SIZE} — no orphans`);
check('fleet-truly-parallel', fleetProvider.concurrentPeak > 1,
  `peak concurrent creates = ${fleetProvider.concurrentPeak} (serial would be 1)`);
check('fleet-isolates-failure', p.iterations.filter((i) => i.ok).length === FLEET_SIZE - 1,
  `${p.iterations.filter((i) => i.ok).length}/${FLEET_SIZE} shards ok, 1 deliberate failure contained`);
check('fleet-status-partial', p.status === 'partial', `status = ${p.status}`);
check('fleet-cold-samples', p.coldStart?.n === FLEET_SIZE,
  `${p.coldStart?.n ?? 0} cold-start samples recorded across the fleet`);
check('fleet-not-interleaved', r.config.order === 'sequential',
  `fleet order = ${r.config.order} (interleaving two fleets would measure them competing)`);

section('fairness controls');

// 5. interleaving: lap n on every provider before lap n+1, rotating who leads
reset();
const createOrder: string[] = [];
r = await run(
  { e2b: new HealthyProvider('e2b', createOrder), daytona: new HealthyProvider('daytona', createOrder) },
  quietTask,
  4,
);
const rounds = [createOrder.slice(0, 2), createOrder.slice(2, 4), createOrder.slice(4, 6), createOrder.slice(6, 8)];
check('interleaved-by-lap', rounds.every((round) => new Set(round).size === 2),
  `create order = ${createOrder.join(' → ')}`);
check('interleave-rotates-lead', rounds[0]![0] !== rounds[1]![0],
  `lap 1 led by ${rounds[0]![0]}, lap 2 led by ${rounds[1]![0]} — neither provider owns the front`);
check('order-recorded', r.config.order === 'interleaved', `config.order = ${r.config.order}`);

// 6. requested size is only claimed as honoured when an adapter applied it
reset();
r = await run(
  {
    e2b: new HealthyProvider('e2b', undefined, 'template-only', false),
    daytona: new HealthyProvider('daytona', undefined, 'per-sandbox', true),
  },
  quietTask,
  1,
);
const e2bRes = r.providers.find((x) => x.provider === 'e2b')!;
const dayRes = r.providers.find((x) => x.provider === 'daytona')!;
check('resources-not-claimed-when-unapplied', e2bRes.resources?.honored === false,
  `e2b honored = ${e2bRes.resources?.honored} (adapter reported it could not size the sandbox)`);
check('resources-honored-when-applied', dayRes.resources?.honored === true,
  `daytona honored = ${dayRes.resources?.honored}`);
check('resource-mismatch-flagged',
  (r.fairness ?? []).some((n) => n.id === 'resource-parity'),
  `fairness ids = ${(r.fairness ?? []).map((n) => n.id).join(', ')}`);

// 7. a task's expected errors are data, not a failing grade
reset();
r = await run({ e2b: new HealthyProvider('e2b') }, provokingTask, 1);
p = r.providers[0]!;
check('expected-errors-are-data', p.status === 'ok' && p.errors.length === 1,
  `status = ${p.status} with ${p.errors.length} recorded probe error(s)`);
check('expected-errors-still-recorded', p.errors[0]?.phase === 'probe:memory_oom',
  `error retained at phase ${p.errors[0]?.phase}`);

section('measurement');

// 9. micro-probes on/off
reset();
r = await run({ e2b: new HealthyProvider('e2b') }, quietTask, 3, { probes: true });
p = r.providers[0]!;
check('probes-measure-readiness', (p.timeToReady?.n ?? 0) === 3,
  `${p.timeToReady?.n ?? 0}/3 laps produced a time-to-ready sample`);
check('probes-measure-exec-rtt', (p.execRtt?.n ?? 0) === 15,
  `${p.execRtt?.n ?? 0} exec round-trip samples (3 laps x 5)`);
check('probes-capture-environment-once',
  p.iterations.filter((i) => i.steps.some((s) => s.name === 'probe:environment')).length === 1,
  'the machine is fingerprinted once per provider, not once per lap');

reset();
r = await run({ e2b: new HealthyProvider('e2b') }, quietTask, 2, { probes: false });
check('probes-off-collects-nothing', r.providers[0]!.timeToReady === null,
  'no readiness samples when --no-probes');

// 10. the run states its own caveats
reset();
r = await run(
  { e2b: new HealthyProvider('e2b'), daytona: new HealthyProvider('daytona') },
  quietTask,
  3,
  { probes: true },
);
const ids = new Set((r.fairness ?? []).map((n) => n.id));
check('reports-small-sample', ids.has('sample-size-median') || ids.has('sample-size-tail'),
  `n=3 flagged: ${[...ids].join(', ')}`);
check('reports-client-context', ids.has('client-context'),
  'every run states it was measured from one client, one location, one moment');
check('cost-basis-recorded', r.providers.every((x) => Boolean(x.cost?.basis)),
  `cost basis = ${r.providers.map((x) => `${x.provider}:${x.cost?.basis}`).join(', ')}`);

console.log(failures === 0 ? '\n\x1b[32mall invariants hold\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
