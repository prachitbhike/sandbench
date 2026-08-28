import { Daytona, type Sandbox } from '@daytona/sdk';
import type { ExecOpts, ExecResult, SandboxHandle, SandboxProvider } from '../types.js';

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

  async createSandbox(template?: string): Promise<SandboxHandle> {
    // Branch explicitly: create() is overloaded on snapshot-vs-image params.
    const sandbox = template
      ? await this.daytona.create({ image: template })
      : await this.daytona.create();
    return { id: sandbox.id, provider: this.name, createdAt: Date.now(), native: sandbox };
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
