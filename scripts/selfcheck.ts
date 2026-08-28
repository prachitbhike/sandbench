/**
 * Fault-injection self-check for the harness invariants:
 *   1. createSandbox retries exactly once, then gives up
 *   2. destroy() always runs, even when the task body throws
 *   3. exec is never retried
 *   4. a destroy() failure is recorded but does not crash the race
 */
import { runRace } from '../packages/core/src/runner.js';
import type { ExecResult, SandboxHandle, SandboxProvider } from '../packages/core/src/types.js';
import type { FleetTask, Task } from '../packages/core/src/tasks/types.js';

let created = 0;
let destroyed = 0;
let execCalls = 0;

class FlakyProvider implements SandboxProvider {
  readonly name = 'e2b'; // borrow a registered slot name for pricing/LOC lookup
  readonly supportsPersistence = true;
  constructor(
    private readonly failCreateTimes: number,
    private readonly failDestroy = false,
  ) {}
  missingEnv(): string[] { return []; }
  async createSandbox(): Promise<SandboxHandle> {
    created++;
    if (created <= this.failCreateTimes) throw new Error(`boom create #${created}`);
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

const throwingTask: Task = {
  name: 'selfcheck', description: 'fault injection', mode: 'perSandbox', defaultIterations: 1,
  async run(ctx) { await ctx.provider.exec(ctx.handle, 'true'); throw new Error('task body exploded'); },
};

function reset(): void { created = 0; destroyed = 0; execCalls = 0; }

let failures = 0;
function check(label: string, cond: boolean, detail: string): void {
  console.log(`${cond ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${label} — ${detail}`);
  if (!cond) failures++;
}

async function run(provider: SandboxProvider, task: Task, iterations = 1) {
  // Bypass the registry so we can inject: temporarily monkey-patch the slot.
  const mod = await import('../packages/core/src/providers/index.js');
  const orig = mod.getSlot('e2b')!.make;
  (mod.getSlot('e2b') as { make: unknown }).make = () => provider;
  try {
    return await runRace({ task, providers: ['e2b'], iterations });
  } finally {
    (mod.getSlot('e2b') as { make: unknown }).make = orig;
  }
}

console.log('\nharness self-check\n');

// 1. one transient create failure -> retried once -> succeeds
reset();
let r = await run(new FlakyProvider(1), throwingTask);
let p = r.providers[0]!;
check('retry-once', created === 2, `createSandbox called ${created}x (expected 2: initial + 1 retry)`);
check('retry-counted', p.retries === 1, `retries recorded = ${p.retries}`);
check('destroy-after-task-throw', destroyed === 1, `destroy called ${destroyed}x despite task throwing`);
check('exec-not-retried', execCalls === 1, `exec called ${execCalls}x (expected 1: no retry on exec)`);
check('errors-captured', p.errors.length >= 2, `${p.errors.length} errors recorded, race did not crash`);

// 2. persistent create failure -> exactly 2 attempts, no destroy, still no crash
reset();
r = await run(new FlakyProvider(99), throwingTask);
p = r.providers[0]!;
check('give-up-after-one-retry', created === 2, `createSandbox called ${created}x then gave up`);
check('no-destroy-without-handle', destroyed === 0, `destroy called ${destroyed}x (nothing to destroy)`);
check('status-error', p.status === 'error', `status = ${p.status}`);
check('race-still-written', r.providers.length === 1, 'race object produced despite total failure');

// 3. destroy failure is recorded, not fatal
reset();
r = await run(new FlakyProvider(0, true), throwingTask);
p = r.providers[0]!;
const orphan = p.iterations[0]!.steps.find((s) => s.name === 'destroy');
check('destroy-failure-recorded', orphan?.ok === false && orphan.note === 'ORPHAN RISK',
  `destroy step note = ${orphan?.note ?? 'missing'}`);
check('no-crash-on-destroy-failure', r.providers[0]!.iterations.length === 1, 'iteration completed');

// 4. fleet mode: parallel spawn, every sandbox destroyed, one bad shard
//    must not take the fleet down.
class FleetProvider implements SandboxProvider {
  readonly name = 'e2b';
  readonly supportsPersistence = true;
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
r = await run(fleetProvider, fleetTask, FLEET_SIZE);
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

console.log(failures === 0 ? '\n\x1b[32mall invariants hold\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
