import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface SidecarError {
  type: string;
  message: string;
  traceback?: string;
}

/**
 * Newline-delimited-JSON RPC client over a child process's stdio.
 *
 * Requests are correlated by id and may complete out of order — the Modal
 * sidecar answers on a thread pool so parallel provisioning stays parallel.
 */
export class StdioSidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private ready: Promise<void> | null = null;
  private stderrTail: string[] = [];
  private exited: { code: number | null; signal: string | null } | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly opts: { cwd?: string; env?: NodeJS.ProcessEnv; readyTimeoutMs?: number } = {},
  ) {}

  /** Idempotent: boots the process and resolves once it announces readiness. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string): void => {
        if (settled) return;
        settled = true;
        reject(new Error(`${msg}${this.stderrSnippet()}`));
      };

      const child = spawn(this.command, this.args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      this.child = child;

      const timer = setTimeout(
        () => fail(`sidecar did not become ready within ${this.opts.readyTimeoutMs ?? 60_000}ms`),
        this.opts.readyTimeoutMs ?? 60_000,
      );

      child.on('error', (err) => {
        clearTimeout(timer);
        fail(`failed to spawn sidecar "${this.command}": ${err.message}`);
      });

      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        this.exited = { code, signal };
        const err = new Error(`sidecar exited (code=${code} signal=${signal})${this.stderrSnippet()}`);
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        fail(`sidecar exited during startup (code=${code} signal=${signal})`);
      });

      createInterface({ input: child.stderr }).on('line', (l) => {
        this.stderrTail.push(l);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      });

      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        let msg: { id?: string; ok?: boolean; result?: unknown; error?: SidecarError };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          this.stderrTail.push(`[unparsable stdout] ${line.slice(0, 300)}`);
          return;
        }
        if (msg.id === '__ready__') {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        const p = msg.id ? this.pending.get(msg.id) : undefined;
        if (!p || !msg.id) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else {
          const e = msg.error;
          const err = new Error(e ? `${e.type}: ${e.message}` : 'unknown sidecar error');
          if (e?.traceback) err.stack = e.traceback;
          p.reject(err);
        }
      });
    });
    return this.ready;
  }

  async call<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<T> {
    await this.start();
    if (this.exited) {
      throw new Error(`sidecar is dead (code=${this.exited.code})${this.stderrSnippet()}`);
    }
    const id = String(++this.seq);
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar op "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child?.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  /** Closing stdin lets the sidecar sweep its own orphans before exiting. */
  async stop(graceMs = 10_000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(done);
        resolve();
      });
      child.stdin.end();
    });
  }

  private stderrSnippet(): string {
    if (this.stderrTail.length === 0) return '';
    return `\n--- sidecar stderr ---\n${this.stderrTail.slice(-12).join('\n')}`;
  }
}
