import type {
  ErrorRecord,
  ExecOpts,
  ExecResult,
  SandboxHandle,
  SandboxProvider,
  StepTiming,
} from './types.js';
import { toErrorRecord } from './errors.js';

export function now(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = now();
  const value = await fn();
  return { ms: now() - t0, value };
}

/**
 * Per-iteration recorder. Collects step timings + errors so an adapter can
 * stay a dumb SDK wrapper and every provider is measured identically.
 */
export class Recorder {
  readonly steps: StepTiming[] = [];
  readonly errors: ErrorRecord[] = [];
  retries = 0;

  step(name: string, durationMs: number, ok: boolean, exitCode?: number, note?: string): void {
    const s: StepTiming = { name, durationMs, ok };
    if (exitCode !== undefined) s.exitCode = exitCode;
    if (note !== undefined) s.note = note;
    this.steps.push(s);
  }

  error(phase: string, err: unknown, iteration?: number): ErrorRecord {
    const rec = toErrorRecord(phase, err, iteration);
    this.errors.push(rec);
    return rec;
  }

  /** Time an arbitrary named step, recording failure without throwing away the error. */
  async measure<T>(name: string, fn: () => Promise<T>): Promise<{ ms: number; value?: T; err?: unknown }> {
    const t0 = now();
    try {
      const value = await fn();
      this.step(name, now() - t0, true);
      return { ms: now() - t0, value };
    } catch (err) {
      const ms = now() - t0;
      this.step(name, ms, false, undefined, String(err).slice(0, 200));
      this.error(name, err);
      return { ms, err };
    }
  }
}

/**
 * Wraps a provider so every call is timed and every failure is recorded.
 *
 * Retry policy (per spec): exactly one retry on createSandbox, zero on exec —
 * we want real flakiness visible in the data.
 */
export class InstrumentedProvider {
  constructor(
    private readonly inner: SandboxProvider,
    private readonly rec: Recorder,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get supportsPersistence(): boolean {
    return this.inner.supportsPersistence;
  }

  /** Returns cold-start ms alongside the handle. Retries once. */
  async createSandbox(template?: string): Promise<{ handle: SandboxHandle; coldStartMs: number }> {
    const attempt = async (): Promise<{ handle: SandboxHandle; coldStartMs: number }> => {
      const { ms, value } = await timed(() => this.inner.createSandbox(template));
      value.createdAt = Date.now();
      return { handle: value, coldStartMs: ms };
    };

    try {
      const r = await attempt();
      this.rec.step('createSandbox', r.coldStartMs, true);
      return r;
    } catch (first) {
      this.rec.error('createSandbox', first);
      this.rec.retries += 1;
      const r = await attempt(); // single retry; if this throws the iteration fails
      this.rec.step('createSandbox', r.coldStartMs, true, undefined, 'succeeded on retry');
      return r;
    }
  }

  /** No retry by design. SDK errors become a synthetic exitCode -1 result. */
  async exec(handle: SandboxHandle, cmd: string, opts?: ExecOpts, label?: string): Promise<ExecResult> {
    const name = label ?? `exec:${cmd.slice(0, 40)}`;
    const t0 = now();
    try {
      const res = await this.inner.exec(handle, cmd, opts);
      res.durationMs = now() - t0;
      this.rec.step(name, res.durationMs, res.exitCode === 0, res.exitCode);
      return res;
    } catch (err) {
      const durationMs = now() - t0;
      this.rec.step(name, durationMs, false, -1, String(err).slice(0, 200));
      const rec = this.rec.error(name, err);
      return { stdout: '', stderr: '', exitCode: -1, durationMs, error: rec.message };
    }
  }

  async writeFile(handle: SandboxHandle, path: string, contents: string, label?: string): Promise<boolean> {
    const r = await this.rec.measure(label ?? `writeFile:${path}`, () =>
      this.inner.writeFile(handle, path, contents),
    );
    return r.err === undefined;
  }

  async readFile(handle: SandboxHandle, path: string, label?: string): Promise<string | undefined> {
    const r = await this.rec.measure(label ?? `readFile:${path}`, () => this.inner.readFile(handle, path));
    return r.value;
  }

  /** Always safe to call — swallows nothing, records everything, never throws. */
  async destroy(handle: SandboxHandle | undefined): Promise<void> {
    if (!handle) return;
    const t0 = now();
    try {
      await this.inner.destroy(handle);
      handle.destroyedAt = Date.now();
      this.rec.step('destroy', now() - t0, true);
    } catch (err) {
      handle.destroyedAt = Date.now();
      this.rec.step('destroy', now() - t0, false, undefined, 'ORPHAN RISK');
      this.rec.error('destroy', err);
    }
  }
}

/** Seconds the sandbox billed as alive. Falls back to now() if destroy never set it. */
export function aliveSeconds(handle: SandboxHandle | undefined): number {
  if (!handle) return 0;
  const end = handle.destroyedAt ?? Date.now();
  return Math.max(0, (end - handle.createdAt) / 1000);
}
