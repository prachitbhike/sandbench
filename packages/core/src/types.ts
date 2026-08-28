/**
 * Core contracts for Sandbox Grand Prix.
 *
 * Everything a provider adapter must implement lives here. Adapters stay
 * deliberately thin: all timing/instrumentation is layered on top by
 * `instrument.ts`, so `adapter_loc` stays a fair SDK-ergonomics signal.
 */

export const SCHEMA_VERSION = 1;

/** Opaque-ish reference to a live sandbox. `native` holds the SDK object. */
export interface SandboxHandle {
  /** Provider-assigned sandbox id (best effort; empty string if the SDK hides it). */
  id: string;
  /** Provider name that created this handle. */
  provider: string;
  /** Epoch ms when creation completed. Used for alive-seconds cost math. */
  createdAt: number;
  /** Epoch ms when destroy() completed. Set by the instrumentation layer. */
  destroyedAt?: number;
  /** The underlying SDK handle. Adapters cast this back to their own type. */
  native: unknown;
}

export interface ExecOpts {
  /** Hard timeout for this single command. */
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Wall clock for this exec call, measured by the instrumentation layer. */
  durationMs: number;
  /** Transport/SDK error (not a non-zero exit code). */
  error?: string;
}

export interface SandboxProvider {
  readonly name: string;
  /** Whether files + installed deps survive between exec() calls. */
  readonly supportsPersistence: boolean;

  /** Env vars this provider needs but cannot find. Empty array == ready. */
  missingEnv(): string[];

  /**
   * Adapter-internal setup that is NOT the provider's cold start — booting a
   * sidecar process, constructing an SDK client. Run once, untimed, before the
   * iteration loop, so architecture overhead never lands in cold_start_ms.
   */
  warmup?(): Promise<void>;

  /** Release adapter-level resources (sidecar process, sockets). */
  shutdown?(): Promise<void>;

  createSandbox(template?: string): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  writeFile(handle: SandboxHandle, path: string, contents: string): Promise<void>;
  readFile(handle: SandboxHandle, path: string): Promise<string>;
  destroy(handle: SandboxHandle): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Results schema (versioned, written one JSON file per race run)      */
/* ------------------------------------------------------------------ */

export type ProviderStatus = 'ok' | 'partial' | 'error' | 'dns';

export interface ErrorRecord {
  /** Where it happened: 'createSandbox' | 'exec' | 'writeFile' | task step name... */
  phase: string;
  /** Raw error message — never swallowed, this is the point of the benchmark. */
  message: string;
  /** Error class name, when available. */
  name?: string;
  /** Truncated stack, for triage. */
  stack?: string;
  at: string;
  iteration?: number;
}

export interface Distribution {
  samples: number[];
  n: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

export interface StepTiming {
  name: string;
  durationMs: number;
  exitCode?: number;
  ok: boolean;
  note?: string;
}

export interface IterationResult {
  iteration: number;
  ok: boolean;
  coldStartMs?: number;
  /** Time from createSandbox start to destroy completion. */
  totalMs: number;
  aliveSeconds: number;
  steps: StepTiming[];
  /** Task-specific payload (e.g. the prime we computed). */
  output?: unknown;
  errors: ErrorRecord[];
  /** Retries consumed on sandbox creation. */
  retries: number;
}

export interface CostBreakdown {
  aliveSeconds: number;
  vcpus: number;
  memGib: number;
  usdPerVcpuHour: number;
  usdPerGibHour: number;
  cpuUsd: number;
  memUsd: number;
  totalUsd: number;
}

export interface ProviderResult {
  provider: string;
  status: ProviderStatus;
  /** Populated when status === 'dns'. */
  dnsReason?: string;
  supportsPersistence: boolean;
  /** Lines of adapter code — the SDK-ergonomics metric. */
  adapterLoc: number | null;
  iterations: IterationResult[];
  coldStart: Distribution | null;
  totalWallClockMs: number;
  totalAliveSeconds: number;
  cost: CostBreakdown | null;
  errors: ErrorRecord[];
  retries: number;
  /** Task-level rollup, shape depends on the task. */
  summary?: Record<string, unknown>;
}

export interface RaceResult {
  schemaVersion: number;
  raceId: string;
  task: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: {
    iterations: number;
    providersRequested: string[];
    template?: string;
  };
  providers: ProviderResult[];
}
