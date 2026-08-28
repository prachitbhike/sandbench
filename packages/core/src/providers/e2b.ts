import { CommandExitError, Sandbox } from '@e2b/code-interpreter';
import type { ExecOpts, ExecResult, SandboxHandle, SandboxProvider } from '../types.js';

/**
 * E2B adapter — @e2b/code-interpreter v2.x.
 *
 * API verified 2026-08-28 against the installed .d.ts:
 *   Sandbox.create(template?, opts?) -> Sandbox   (auth via E2B_API_KEY)
 *   sbx.commands.run(cmd, opts)      -> { stdout, stderr, exitCode, error? }
 *                                       THROWS CommandExitError on non-zero exit
 *   sbx.files.write(path, data) / sbx.files.read(path)
 *   sbx.kill()
 */
export class E2BProvider implements SandboxProvider {
  readonly name = 'e2b';
  readonly supportsPersistence = true;

  /**
   * Sandbox lifetime ceiling. Generous on purpose: ESCAPE ROOM's probe budget
   * alone exceeds 5 min, and we always kill explicitly in a finally, so a high
   * ceiling never costs alive-seconds.
   */
  constructor(private readonly timeoutMs = 15 * 60_000) {}

  missingEnv(): string[] {
    return process.env['E2B_API_KEY'] ? [] : ['E2B_API_KEY'];
  }

  async createSandbox(template?: string): Promise<SandboxHandle> {
    const sbx = template
      ? await Sandbox.create(template, { timeoutMs: this.timeoutMs })
      : await Sandbox.create({ timeoutMs: this.timeoutMs });
    return { id: sbx.sandboxId, provider: this.name, createdAt: Date.now(), native: sbx };
  }

  async exec(handle: SandboxHandle, cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const sbx = handle.native as Sandbox;
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    try {
      const r = await sbx.commands.run(cmd, {
        timeoutMs,
        requestTimeoutMs: timeoutMs + 30_000,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.env ? { envs: opts.env } : {}),
      });
      return this.toResult(r.stdout, r.stderr, r.exitCode, r.error);
    } catch (err) {
      // A non-zero exit is a normal outcome for us (failing tests, blocked
      // probes), not an SDK failure — unwrap it instead of letting it bubble.
      if (err instanceof CommandExitError) {
        return this.toResult(err.stdout, err.stderr, err.exitCode, err.error);
      }
      throw err;
    }
  }

  private toResult(stdout: string, stderr: string, exitCode: number, error?: string): ExecResult {
    return { stdout, stderr, exitCode, durationMs: 0, ...(error ? { error } : {}) };
  }

  async writeFile(handle: SandboxHandle, path: string, contents: string): Promise<void> {
    await (handle.native as Sandbox).files.write(path, contents);
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    return await (handle.native as Sandbox).files.read(path);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await (handle.native as Sandbox).kill();
  }
}
