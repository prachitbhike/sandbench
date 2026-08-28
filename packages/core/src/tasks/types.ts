import type { InstrumentedProvider, Recorder } from '../instrument.js';
import type { IterationResult, SandboxHandle } from '../types.js';

export interface TaskContext {
  provider: InstrumentedProvider;
  handle: SandboxHandle;
  rec: Recorder;
  iteration: number;
}

/**
 * Runs one body inside a freshly created sandbox and returns the recorded
 * iteration. Create/destroy/timing/retry are handled for you — including
 * destroy-in-finally — so fleet tasks get the same guarantees as simple ones.
 */
export type SpawnUnit = (
  index: number,
  body: (ctx: TaskContext) => Promise<unknown>,
) => Promise<IterationResult>;

export interface FleetContext {
  spawn: SpawnUnit;
  /** Fleet size for this run (the CLI's --iterations). */
  size: number;
  template?: string;
}

interface TaskBase {
  name: string;
  description: string;
  defaultIterations: number;
  /** Roll iteration outputs up into report columns. */
  summarize?(iterations: IterationResult[]): Record<string, unknown>;
}

/** One fresh sandbox per iteration, run sequentially. */
export interface PerSandboxTask extends TaskBase {
  mode: 'perSandbox';
  run(ctx: TaskContext): Promise<unknown>;
}

/** The task orchestrates its own fleet (RELAY spins up N in parallel). */
export interface FleetTask extends TaskBase {
  mode: 'fleet';
  runFleet(ctx: FleetContext): Promise<IterationResult[]>;
}

export type Task = PerSandboxTask | FleetTask;
