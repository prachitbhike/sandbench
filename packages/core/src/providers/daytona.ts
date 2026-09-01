import { Daytona, type Sandbox } from '@daytona/sdk';
import type {
  CreateOptions,
  ExecOpts,
  ExecResult,
  ProviderCapabilities,
  SandboxHandle,
  SandboxProvider,
} from '../types.js';

/**
 * Daytona adapter — @daytona/sdk v0.207.
 *
 * NOTE: the older `@daytonaio/sdk` package is deprecated and now prints a
 * migration notice; `@daytona/sdk` is the current package (same API).
 *
 * API verified 2026-08-28 against the installed .d.ts:
 *   new Daytona({ apiKey })                      (or DAYTONA_API_KEY from env)
 *   daytona.create({ image | snapshot, envVars })      -> Sandbox
 *   sandbox.process.executeCommand(cmd, cwd?, env?, timeoutSec?)
 *                                                -> { exitCode, result, artifacts? }
 *   sandbox.fs.uploadFile(Buffer, remotePath) / downloadFile(remotePath) -> Buffer
 *   sandbox.delete()
 */
export class DaytonaProvider implements SandboxProvider {
  readonly name = 'daytona';
  readonly supportsPersistence = true;

  readonly capabilities: ProviderCapabilities = {
    nativeTsSdk: true,
    externalRuntime: null,
    resourceControl: 'per-sandbox',
    registryImages: true,
    // executeCommand merges the two streams into `result`; there is no
    // separate stderr channel, so failure diagnostics are thinner here.
    separateStderr: false,
    nonZeroExitThrows: false,
    defaultTemplate: null,
    notes: [
      'create() takes resources { cpu, memory (GiB), disk (GiB) } — but only on the from-image overload',
      'accepts a registry tag directly as `image`, so it can be image-matched with Modal',
      'egress policy is set per sandbox via networkBlockAll / networkAllowList',
    ],
  };

  private client: Daytona | null = null;

  missingEnv(): string[] {
    return process.env['DAYTONA_API_KEY'] ? [] : ['DAYTONA_API_KEY'];
  }

  /** Client construction is adapter overhead, not Daytona's cold start. */
  async warmup(): Promise<void> {
    this.client = new Daytona();
  }

  private get daytona(): Daytona {
    if (!this.client) this.client = new Daytona();
    return this.client;
  }

  /**
   * `resources` lives on the from-image overload only — the snapshot overload
   * has no such field. So an unpinned run gets Daytona's default machine and
   * says so, rather than reporting a size-matched comparison it did not make.
   */
  async createSandbox(opts?: CreateOptions): Promise<SandboxHandle> {
    const resources = opts?.resources
      ? { cpu: opts.resources.vcpus, memory: Math.round(opts.resources.memMib / 1024) }
      : undefined;
    // Branch explicitly: create() is overloaded on snapshot-vs-image params.
    const sandbox = opts?.template
      ? await this.daytona.create({ image: opts.template, ...(resources ? { resources } : {}) })
      : await this.daytona.create();
    return {
      id: sandbox.id,
      provider: this.name,
      createdAt: Date.now(),
      resourcesApplied: Boolean(opts?.template && resources),
      native: sandbox,
    };
  }

  async exec(handle: SandboxHandle, cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const sandbox = handle.native as Sandbox;
    const timeoutSec = Math.ceil((opts?.timeoutMs ?? 120_000) / 1000);
    const r = await sandbox.process.executeCommand(cmd, opts?.cwd, opts?.env, timeoutSec);
    // Daytona merges streams into `result`; there is no separate stderr channel.
    return {
      stdout: r.artifacts?.stdout ?? r.result ?? '',
      stderr: '',
      exitCode: r.exitCode,
      durationMs: 0,
    };
  }

  async writeFile(handle: SandboxHandle, path: string, contents: string): Promise<void> {
    await (handle.native as Sandbox).fs.uploadFile(Buffer.from(contents, 'utf8'), path);
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    const buf = await (handle.native as Sandbox).fs.downloadFile(path);
    return buf.toString('utf8');
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await (handle.native as Sandbox).delete();
  }
}
