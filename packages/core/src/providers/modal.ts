import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { repoRoot } from '../paths.js';
import type {
  CreateOptions,
  ExecOpts,
  ExecResult,
  ProviderCapabilities,
  SandboxHandle,
  SandboxProvider,
} from '../types.js';
import { StdioSidecar } from './sidecar.js';

interface ModalNative {
  sandboxId: string;
}

/**
 * Modal adapter — drives `providers/modal_sidecar/sidecar.py` over stdio,
 * because Modal ships no TypeScript SDK.
 *
 * The sidecar process boot is done in warmup() so it never lands in
 * cold_start_ms; only Sandbox.create() is timed.
 */
export class ModalProvider implements SandboxProvider {
  readonly name = 'modal';
  readonly supportsPersistence = true;

  /**
   * `nativeTsSdk: false` describes THIS ADAPTER, not Modal.
   *
   * Modal has published a TypeScript SDK since 2026-08. This integration
   * predates that and still goes through a Python sidecar, which is why its
   * line count is an outlier. The distinction matters enough to encode: a
   * reader comparing adapters should see "our integration path", not "the
   * vendor made this hard".
   */
  readonly capabilities: ProviderCapabilities = {
    nativeTsSdk: false,
    externalRuntime: 'python3 + modal (sidecar)',
    resourceControl: 'per-sandbox',
    registryImages: true,
    separateStderr: true,
    nonZeroExitThrows: false,
    defaultTemplate: 'python:3.12-slim',
    notes: [
      'a first-party TypeScript SDK exists (npm `modal`); this adapter predates it and is due a rewrite',
      'Sandbox.create takes cpu (physical cores) and memory (MiB) — billed on the request, not on usage',
      'egress is on by default; block_network turns it off',
    ],
  };

  private readonly sidecar: StdioSidecar;

  /**
   * Resources are pinned rather than left to Modal's default so the cost row
   * is grounded: Modal bills per *requested* core-second, and `cpu` is in
   * physical cores (1 core = 2 vCPU in Modal's pricing).
   */
  constructor(
    private readonly timeoutSeconds = 15 * 60,
    private readonly cpuCores = 1.0,
    private readonly memoryMib = 2048,
  ) {
    this.sidecar = new StdioSidecar(modalPython(), [sidecarScript()], {
      cwd: repoRoot(),
      readyTimeoutMs: 90_000,
    });
  }

  missingEnv(): string[] {
    // Modal accepts either env tokens or a ~/.modal.toml written by `modal token new`.
    if (process.env['MODAL_TOKEN_ID'] && process.env['MODAL_TOKEN_SECRET']) return [];
    if (existsSync(resolve(homedir(), '.modal.toml'))) return [];
    return ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'];
  }

  async warmup(): Promise<void> {
    await this.sidecar.start();
    await this.sidecar.call('warmup', {}, 120_000);
  }

  async createSandbox(opts?: CreateOptions): Promise<SandboxHandle> {
    // Modal's `cpu` is physical cores and 1 core == 2 vCPU in its pricing, so
    // the shared vCPU request is halved to ask for the same machine as the
    // others rather than twice as much.
    const cpu = opts?.resources ? opts.resources.vcpus / 2 : this.cpuCores;
    const memory = opts?.resources ? opts.resources.memMib : this.memoryMib;
    const r = await this.sidecar.call<{ sandbox_id: string }>('create', {
      ...(opts?.template ? { template: opts.template } : {}),
      timeout: this.timeoutSeconds,
      cpu,
      memory,
    });
    return {
      id: r.sandbox_id,
      provider: this.name,
      createdAt: Date.now(),
      resourcesApplied: true,
      native: { sandboxId: r.sandbox_id } satisfies ModalNative,
    };
  }

  async exec(handle: SandboxHandle, cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const r = await this.sidecar.call<{ stdout: string; stderr: string; exit_code: number }>(
      'exec',
      {
        sandbox_id: (handle.native as ModalNative).sandboxId,
        cmd,
        timeout_ms: timeoutMs,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.env ? { env: opts.env } : {}),
      },
      timeoutMs + 60_000,
    );
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code, durationMs: 0 };
  }

  async writeFile(handle: SandboxHandle, path: string, contents: string): Promise<void> {
    await this.sidecar.call('write', {
      sandbox_id: (handle.native as ModalNative).sandboxId,
      path,
      contents,
    });
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    const r = await this.sidecar.call<{ contents: string }>('read', {
      sandbox_id: (handle.native as ModalNative).sandboxId,
      path,
    });
    return r.contents;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.sidecar.call('destroy', { sandbox_id: (handle.native as ModalNative).sandboxId }, 60_000);
  }

  async shutdown(): Promise<void> {
    await this.sidecar.stop();
  }
}

/** $SGP_MODAL_PYTHON > repo venv > system python3. */
function modalPython(): string {
  const override = process.env['SGP_MODAL_PYTHON'];
  if (override) return override;
  const venv = resolve(repoRoot(), 'providers/modal_sidecar/.venv/bin/python');
  return existsSync(venv) ? venv : 'python3';
}

function sidecarScript(): string {
  return resolve(repoRoot(), 'providers/modal_sidecar/sidecar.py');
}
