/**
 * Core contracts for Sandbox Grand Prix.
 *
 * Everything a provider adapter must implement lives here. Adapters stay
 * deliberately thin: all timing/instrumentation is layered on top by
 * `instrument.ts`, so `adapter_loc` stays a fair SDK-ergonomics signal.
 */

/**
 * 2 — adds time-to-ready / exec-RTT probes, acquisition accounting, measured
 *     environments, capability records, the fairness report, and interleaved
 *     scheduling metadata. v1 files still load; the missing fields render as
 *     "not measured" rather than zero.
 */
export const SCHEMA_VERSION = 2;

/** What we ask every provider for, so the machines under test are comparable. */
export interface ResourceRequest {
  vcpus: number;
  memMib: number;
  diskGib?: number;
}

/**
 * How much of the machine the SDK lets you specify at create time. This is the
 * difference between "we compared like with like" and "we compared whatever
 * each vendor felt like handing out".
 */
export type ResourceControl = 'per-sandbox' | 'template-only' | 'none';

/**
 * Integration facts that a line count cannot express. These are recorded per
 * race so the ergonomics claim is checkable rather than a vibe.
 */
export interface ProviderCapabilities {
  /** Ships a first-party TypeScript SDK we are actually using. */
  nativeTsSdk: boolean;
  /** Non-JS runtime this adapter needs on the host, e.g. 'python3 + modal'. */
  externalRuntime: string | null;
  resourceControl: ResourceControl;
  /** Can you hand it a public registry tag at create time? */
  registryImages: boolean;
  /** Are stdout and stderr delivered as separate streams? */
  separateStderr: boolean;
  /** Does a non-zero exit code throw instead of returning a result? */
  nonZeroExitThrows: boolean;
  /** Image/template used when the caller does not name one. */
  defaultTemplate: string | null;
  /** Free-text notes surfaced next to the numbers. */
  notes?: string[];
}

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
  /**
   * Whether the adapter actually applied the requested cpu/memory. Self-
   * reported per create, because "the SDK has a resources field" and "this
   * call used it" are different claims — Daytona accepts resources only on
   * its from-image overload.
   */
  resourcesApplied?: boolean;
  /** The underlying SDK handle. Adapters cast this back to their own type. */
  native: unknown;
}

export interface CreateOptions {
  /** Provider image/template id. */
  template?: string;
  /** The size we asked for. Adapters that cannot honour it must ignore it. */
  resources?: ResourceRequest;
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
  /** Integration facts recorded alongside every result. */
  readonly capabilities: ProviderCapabilities;

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

  createSandbox(opts?: CreateOptions): Promise<SandboxHandle>;
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
  /** Coarse bucket so a reliability number can be read at a glance. */
  kind?: ErrorKind;
}

/**
 * "17 errors" tells an engineer nothing. "17 throttles" tells them to ask for
 * a quota bump; "17 transport errors" tells them the provider is flaky.
 */
export type ErrorKind =
  | 'throttle'
  | 'timeout'
  | 'auth'
  | 'not-found'
  | 'transport'
  | 'sandbox-died'
  | 'other';

export interface Distribution {
  samples: number[];
  n: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  stdev: number;
  /** Bootstrap 95% confidence interval on the median. Null below n=4. */
  ci95: [number, number] | null;
  /**
   * True when n is large enough for the reported p95 to mean anything. With
   * n=10 the "p95" is essentially the max and should be read as such.
   */
  tailReliable: boolean;
}

export interface StepTiming {
  name: string;
  durationMs: number;
  exitCode?: number;
  ok: boolean;
  note?: string;
}

/** What the sandbox actually turned out to be, measured from inside it. */
export interface Environment {
  os: string | null;
  python: string | null;
  kernel: string | null;
  /** Isolation technology inferred from the kernel string. */
  isolation: string | null;
  /** Schedulable CPUs (affinity mask), which is not always os.cpu_count(). */
  vcpus: number | null;
  /** cgroup CPU quota in cores, when one is set. */
  cpuQuota: number | null;
  memGib: number | null;
  diskFreeGib: number | null;
  /** Image/template the sandbox was created from, as we requested it. */
  template: string | null;
}

export interface IterationResult {
  iteration: number;
  ok: boolean;
  /** ISO timestamp the lap started — makes time-skew between providers visible. */
  startedAt?: string;
  /** Latency of the createSandbox call that finally succeeded. */
  coldStartMs?: number;
  /**
   * Total time to get a usable sandbox, including attempts that failed first.
   * Equals coldStartMs when nothing was retried; diverges sharply when a
   * provider fails slowly and then succeeds fast.
   */
  acquireMs?: number;
  /** createSandbox attempts made this lap (1 == first try worked). */
  attempts?: number;
  /** Round trip of the first trivial command after creation. */
  readyMs?: number;
  /** coldStartMs + readyMs — what an agent actually waits for. */
  timeToReadyMs?: number;
  /** Round trips of repeated no-op commands: the per-call floor of the SDK. */
  execRttMs?: number[];
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

/** Where the numbers behind the cost column came from. */
export type CostBasis = 'measured' | 'requested' | 'assumed';

export interface CostBreakdown {
  aliveSeconds: number;
  vcpus: number;
  memGib: number;
  usdPerVcpuHour: number;
  usdPerGibHour: number;
  cpuUsd: number;
  memUsd: number;
  totalUsd: number;
  /** How vcpus/memGib were determined — 'assumed' means "we guessed". */
  basis: CostBasis;
  basisNote: string;
  /** Rate-card provenance, so a stale price is visible rather than implied. */
  rateSource?: string;
  rateVerifiedOn?: string;
  /** Normalised so the figure is legible: cost of one sandbox running an hour. */
  usdPerSandboxHour: number;
  /** Cost of 1,000 ten-minute agent sessions — the number people budget with. */
  usdPer1kSessions: number;
}

export interface LocBreakdown {
  /** The provider adapter itself. */
  adapter: number | null;
  /** Plumbing that exists only because of the chosen integration path. */
  scaffolding: number | null;
  total: number | null;
  files: string[];
}

export interface ProviderResult {
  provider: string;
  status: ProviderStatus;
  /** Populated when status === 'dns'. */
  dnsReason?: string;
  supportsPersistence: boolean;
  capabilities: ProviderCapabilities | null;
  /** Lines of adapter code — the SDK-ergonomics metric. */
  adapterLoc: number | null;
  loc: LocBreakdown | null;
  /** Template as requested (null == provider default). */
  template: string | null;
  /** What we asked for, and whether the SDK could honour it. */
  resources: { requested: ResourceRequest; honored: boolean } | null;
  /** What the machine turned out to be, measured inside the first sandbox. */
  environment: Environment | null;
  iterations: IterationResult[];
  coldStart: Distribution | null;
  /** Cold start with the first lap dropped — steady state after warm paths. */
  coldStartSteady: Distribution | null;
  /** Create + first usable command. The number an agent actually waits for. */
  timeToReady: Distribution | null;
  /** Per-call round trip of a no-op command. Agents pay this dozens of times. */
  execRtt: Distribution | null;
  /** Lap one on its own — it carries TLS/DNS/pool warm-up nobody else pays. */
  firstLap: { coldStartMs: number | null; timeToReadyMs: number | null } | null;
  /**
   * Time this provider was busy — the sum of its own laps for sequential
   * tasks, elapsed fleet time for parallel ones. Not elapsed race time: under
   * interleaving that would report every provider as having taken the lot.
   */
  totalWallClockMs: number;
  totalAliveSeconds: number;
  cost: CostBreakdown | null;
  errors: ErrorRecord[];
  errorsByKind: Record<string, number>;
  retries: number;
  /** Fraction of laps that completed the task as specified. */
  successRate: number;
  /** Task-level rollup, shape depends on the task. */
  summary?: Record<string, unknown>;
}

export type FairnessSeverity = 'info' | 'caution' | 'warning';

/**
 * A caveat the harness raises against its own results. Anything that would
 * make a reader over-trust a number belongs here — this is the difference
 * between a benchmark and a leaderboard.
 */
export interface FairnessNote {
  id: string;
  severity: FairnessSeverity;
  title: string;
  detail: string;
  /** Providers the caveat applies to; empty means "the whole run". */
  affects: string[];
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
    /** Per-provider template overrides, when they differ. */
    templates?: Record<string, string | null>;
    resources?: ResourceRequest;
    /** interleaved = lap n runs on every provider before lap n+1. */
    order?: 'interleaved' | 'sequential';
    formationLap?: boolean;
    /** Micro-probes (readiness, exec round trip) were collected. */
    probes?: boolean;
  };
  providers: ProviderResult[];
  /** Machine-generated caveats about this specific run. */
  fairness?: FairnessNote[];
}
