import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ExecOpts, ExecResult, SandboxHandle, SandboxProvider } from '../types.js';

interface LocalNative {
  root: string;
}

/**
 * Harness self-test fixture — NOT a benchmark competitor.
 *
 * Runs "sandboxes" as temp directories with plain subprocesses so the whole
 * pipeline (timing, retries, results JSON, report) can be verified without
 * cloud credentials. It provides no isolation, so it is deliberately excluded
 * from the default provider list.
 */
export class LocalProvider implements SandboxProvider {
  readonly name = 'local';
  readonly supportsPersistence = true;

  missingEnv(): string[] {
    return [];
  }

  async createSandbox(_template?: string): Promise<SandboxHandle> {
    const root = await mkdtemp(join(tmpdir(), 'sgp-local-'));
    await mkdir(join(root, 'tmp'), { recursive: true });
    return { id: root, provider: this.name, createdAt: Date.now(), native: { root } satisfies LocalNative };
  }

  /** Sandbox-absolute paths (/tmp/x) are remapped under the temp root. */
  private resolvePath(handle: SandboxHandle, p: string): string {
    const { root } = handle.native as LocalNative;
    return resolve(root, p.replace(/^\/+/, ''));
  }

  /**
   * There is no mount namespace here, so `/tmp/...` is rewritten to the
   * sandbox root in both commands AND file contents. Real providers give us a
   * genuine filesystem and need none of this.
   */
  private remap(handle: SandboxHandle, text: string): string {
    const { root } = handle.native as LocalNative;
    return text.replace(/(^|[^\w])\/tmp\//g, `$1${join(root, 'tmp')}/`);
  }

  async exec(handle: SandboxHandle, cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const { root } = handle.native as LocalNative;
    const cwd = opts?.cwd ? this.resolvePath(handle, opts.cwd) : root;
    const timeoutMs = opts?.timeoutMs ?? 120_000;

    const rewritten = this.remap(handle, cmd);

    return await new Promise<ExecResult>((resolvePromise) => {
      const child = spawn('/bin/sh', ['-c', rewritten], {
        cwd,
        env: { ...process.env, ...opts?.env, SGP_SANDBOX_ROOT: root },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        stderr += `\n[sgp] killed after ${timeoutMs}ms`;
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      const finish = (exitCode: number, error?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr, exitCode, durationMs: 0, ...(error ? { error } : {}) });
      };
      child.on('error', (err) => finish(-1, err.message));
      child.on('close', (code) => finish(code ?? -1));
    });
  }

  async writeFile(handle: SandboxHandle, path: string, contents: string): Promise<void> {
    const full = this.resolvePath(handle, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, this.remap(handle, contents), 'utf8');
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    return await readFile(this.resolvePath(handle, path), 'utf8');
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await rm((handle.native as LocalNative).root, { recursive: true, force: true });
  }
}
