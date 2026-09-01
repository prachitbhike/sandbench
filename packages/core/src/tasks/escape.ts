import {
  ENVIRONMENT_CMD,
  PROBE_MARK,
  marker,
  parseEnvironment,
  parseKv,
} from '../environment.js';
import type { Environment, IterationResult } from '../types.js';
import type { Task, TaskContext } from './types.js';

export type ProbeOutcome = 'allowed' | 'blocked' | 'killed' | 'partial' | 'unknown';

export interface ProbeResult {
  probe: string;
  description: string;
  outcome: ProbeOutcome;
  exitCode: number;
  durationMs: number;
  /** Short evidence string — what the sandbox actually said. */
  evidence: string;
  /** Extra structured detail, e.g. bytes actually written. */
  detail?: Record<string, unknown>;
  /** The knob that changes this behaviour, so a default is not read as a limit. */
  control?: string;
}

interface Probe {
  name: string;
  description: string;
  cmd: string;
  timeoutMs: number;
  /**
   * How you would change this outcome on each platform. Without it, a reader
   * sees "Daytona blocks egress, the others don't" and concludes one is safer,
   * when all three ship a switch and merely default differently.
   */
  control?: string;
  /** Interpret the raw result. This is observational: nothing is pass/fail. */
  classify(stdout: string, stderr: string, exitCode: number): { outcome: ProbeOutcome; evidence: string; detail?: Record<string, unknown> };
}

const MARK = PROBE_MARK;

/**
 * Probes are written so the interesting signal is printed on stdout with a
 * marker, and the command itself exits 0 wherever possible — that way a
 * non-zero exit genuinely means the sandbox intervened.
 */
const PROBES: Probe[] = [
  {
    name: 'outbound_http',
    description: 'HTTP GET http://example.com',
    timeoutMs: 45_000,
    control: 'default egress policy — E2B allowInternetAccess, Daytona networkBlockAll/networkAllowList, Modal block_network',
    cmd: `python3 - <<'PY'
import urllib.request, traceback
try:
    with urllib.request.urlopen("http://example.com", timeout=20) as r:
        body = r.read(200)
    print("${MARK}status=%d bytes=%d" % (r.status, len(body)))
except Exception as e:
    print("${MARK}error=%s: %s" % (type(e).__name__, str(e)[:200]))
PY`,
    classify(stdout, stderr, exitCode) {
      const line = marker(stdout);
      if (line.startsWith('status=')) {
        return { outcome: 'allowed', evidence: line, detail: parseKv(line) };
      }
      if (line.startsWith('error=')) {
        return { outcome: 'blocked', evidence: line.slice(6, 160) };
      }
      return unknown(stdout, stderr, exitCode);
    },
  },
  {
    name: 'read_etc_passwd',
    description: 'Read /etc/passwd',
    timeoutMs: 30_000,
    cmd: `python3 - <<'PY'
try:
    data = open("/etc/passwd").read()
    print("${MARK}ok lines=%d root=%s" % (len(data.splitlines()), "root:" in data))
except Exception as e:
    print("${MARK}error=%s: %s" % (type(e).__name__, str(e)[:200]))
PY`,
    classify(stdout, stderr, exitCode) {
      const line = marker(stdout);
      if (line.startsWith('ok ')) return { outcome: 'allowed', evidence: line, detail: parseKv(line) };
      if (line.startsWith('error=')) return { outcome: 'blocked', evidence: line.slice(6, 160) };
      return unknown(stdout, stderr, exitCode);
    },
  },
  {
    name: 'list_proc',
    description: 'List /proc (visible PIDs)',
    timeoutMs: 30_000,
    cmd: `python3 - <<'PY'
import os
try:
    entries = os.listdir("/proc")
    pids = [e for e in entries if e.isdigit()]
    print("${MARK}ok entries=%d pids=%d" % (len(entries), len(pids)))
except Exception as e:
    print("${MARK}error=%s: %s" % (type(e).__name__, str(e)[:200]))
PY`,
    classify(stdout, stderr, exitCode) {
      const line = marker(stdout);
      if (line.startsWith('ok ')) {
        const d = parseKv(line);
        // A handful of visible PIDs means a private PID namespace, not a host view.
        const pids = Number(d['pids'] ?? 0);
        return {
          outcome: 'allowed',
          evidence: `${line} (${pids <= 20 ? 'isolated pid namespace' : 'broad pid visibility'})`,
          detail: d,
        };
      }
      if (line.startsWith('error=')) return { outcome: 'blocked', evidence: line.slice(6, 160) };
      return unknown(stdout, stderr, exitCode);
    },
  },
  {
    name: 'disk_2gb',
    description: 'Write 2 GB to disk',
    timeoutMs: 240_000,
    cmd: `python3 - <<'PY'
import os
target = 2 * 1024 * 1024 * 1024
chunk = b"x" * (8 * 1024 * 1024)
written = 0
err = ""
path = "/tmp/sgp_fill.bin"
try:
    with open(path, "wb") as f:
        while written < target:
            f.write(chunk)
            written += len(chunk)
        f.flush()
        os.fsync(f.fileno())
except Exception as e:
    err = "%s: %s" % (type(e).__name__, str(e)[:200])
finally:
    try:
        os.remove(path)
    except Exception:
        pass
print("${MARK}written_mb=%d target_mb=%d error=%s" % (written // (1024*1024), target // (1024*1024), err or "none"))
PY`,
    classify(stdout, stderr, exitCode) {
      const line = marker(stdout);
      if (!line) return unknown(stdout, stderr, exitCode);
      const d = parseKv(line);
      const wrote = Number(d['written_mb'] ?? 0);
      const target = Number(d['target_mb'] ?? 2048);
      const err = String(d['error'] ?? 'none');
      if (wrote >= target) return { outcome: 'allowed', evidence: `wrote ${wrote} MB`, detail: d };
      if (err !== 'none') {
        return { outcome: 'blocked', evidence: `stopped at ${wrote} MB — ${err}`, detail: d };
      }
      return { outcome: 'partial', evidence: `wrote ${wrote}/${target} MB`, detail: d };
    },
  },
  {
    name: 'fork_200',
    description: 'Spawn 200 processes',
    timeoutMs: 120_000,
    cmd: `python3 - <<'PY'
import subprocess, time
procs, err = [], ""
try:
    for _ in range(200):
        procs.append(subprocess.Popen(["sleep", "5"]))
except Exception as e:
    err = "%s: %s" % (type(e).__name__, str(e)[:200])
spawned = len(procs)
for p in procs:
    try:
        p.kill()
    except Exception:
        pass
print("${MARK}spawned=%d target=200 error=%s" % (spawned, err or "none"))
PY`,
    classify(stdout, stderr, exitCode) {
      const line = marker(stdout);
      if (!line) return unknown(stdout, stderr, exitCode);
      const d = parseKv(line);
      const spawned = Number(d['spawned'] ?? 0);
      const err = String(d['error'] ?? 'none');
      if (spawned >= 200) return { outcome: 'allowed', evidence: 'spawned 200/200', detail: d };
      if (err !== 'none') return { outcome: 'blocked', evidence: `capped at ${spawned} — ${err}`, detail: d };
      return { outcome: 'partial', evidence: `spawned ${spawned}/200`, detail: d };
    },
  },
  {
    name: 'memory_oom',
    description: 'Allocate memory until OOM',
    timeoutMs: 180_000,
    control: 'memory ceiling follows the requested/template size, not a platform limit',
    cmd: `python3 - <<'PY'
import sys
blocks, err = [], ""
mb = 0
BLOCK = 256 * 1024 * 1024
try:
    while mb < 32768:            # hard ceiling so we terminate on huge boxes
        b = bytearray(BLOCK)
        # bytearray() can hand back lazily-mapped zero pages, so allocation
        # alone never trips a cgroup limit. Touch one byte per 4 KiB page to
        # force real residency — otherwise this probe reports a fake "allowed".
        for off in range(0, BLOCK, 4096):
            b[off] = 1
        blocks.append(b)
        mb += BLOCK // (1024 * 1024)
        print("${MARK}progress_mb=%d" % mb, flush=True)
except MemoryError:
    err = "MemoryError"
except Exception as e:
    err = "%s: %s" % (type(e).__name__, str(e)[:200])
print("${MARK}allocated_mb=%d error=%s" % (mb, err or "none"))
sys.stdout.flush()
PY`,
    classify(stdout, stderr, exitCode) {
      const line = marker(stdout, 'allocated_mb');
      if (!line) {
        // No final line == the kernel/runtime killed us mid-probe. The streamed
        // progress checkpoints tell us how far we got before that happened.
        const reached = lastProgressMb(stdout);
        const sig = /killed|signal|137|oom/i.test(`${stdout}${stderr}`);
        if (exitCode !== 0 || reached !== null) {
          const how = sig ? 'OOM killer' : `exit ${exitCode}`;
          return {
            outcome: 'killed',
            evidence: reached !== null
              ? `killed after ~${reached} MB resident (${how})`
              : `process died before reporting (${how})`,
            ...(reached !== null ? { detail: { reached_mb: String(reached) } } : {}),
          };
        }
        return unknown(stdout, stderr, exitCode);
      }
      const d = parseKv(line);
      const mb = Number(d['allocated_mb'] ?? 0);
      const err = String(d['error'] ?? 'none');
      if (err === 'MemoryError') {
        return { outcome: 'blocked', evidence: `MemoryError after ${mb} MB (graceful)`, detail: d };
      }
      if (err !== 'none') return { outcome: 'blocked', evidence: `${err} after ${mb} MB`, detail: d };
      return { outcome: 'allowed', evidence: `allocated ${mb} MB without limit`, detail: d };
    },
  },
];

export const PROBE_NAMES = PROBES.map((p) => p.name);

export interface EscapeOutput {
  /** The machine as delivered — shared with the runner's cost calibration. */
  specs: Environment | null;
  probes: ProbeResult[];
}

/**
 * ESCAPE ROOM — observational, not pass/fail.
 * Every probe runs regardless of what the previous one did; a probe that kills
 * its own exec is itself the finding.
 */
export const escapeTask: Task = {
  name: 'escape',
  description: 'Probe isolation behaviour: network, /etc/passwd, /proc, disk, forks, OOM.',
  mode: 'perSandbox',
  defaultIterations: 1,

  async run(ctx: TaskContext): Promise<EscapeOutput> {
    const { provider, handle } = ctx;
    const results: ProbeResult[] = [];

    // Capture real CPU/memory before probing: pricing.json's vCPU assumption
    // is only as good as the machine the provider actually hands out.
    const specsRes = await provider.exec(handle, ENVIRONMENT_CMD, { timeoutMs: 60_000 }, 'probe:specs');
    const specs = parseEnvironment(specsRes.stdout, null);

    for (const probe of PROBES) {
      const res = await provider.exec(handle, probe.cmd, { timeoutMs: probe.timeoutMs }, `probe:${probe.name}`);
      let classified: { outcome: ProbeOutcome; evidence: string; detail?: Record<string, unknown> };
      if (res.error && res.exitCode === -1) {
        // The exec call itself failed — often the sandbox died under the probe.
        classified = { outcome: 'killed', evidence: `exec failed: ${res.error.slice(0, 160)}` };
      } else {
        classified = probe.classify(res.stdout, res.stderr, res.exitCode);
      }
      results.push({
        probe: probe.name,
        description: probe.description,
        outcome: classified.outcome,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        evidence: classified.evidence,
        ...(classified.detail ? { detail: classified.detail } : {}),
        ...(probe.control ? { control: probe.control } : {}),
      });
    }
    return { specs, probes: results };
  },

  summarize(iterations: IterationResult[]): Record<string, unknown> {
    const outs = iterations
      .map((i) => i.output as EscapeOutput | undefined)
      .filter((o): o is EscapeOutput => Boolean(o));
    const specs = outs.find((o) => o.specs)?.specs;
    const byProbe: Record<string, ProbeOutcome | string> = {};
    if (specs) {
      byProbe['_machine'] =
        `${specs.vcpus ?? '?'} cpu` +
        `${specs.cpuQuota ? ` (quota ${specs.cpuQuota})` : ''}` +
        ` / ${specs.memGib ?? '?'} GiB mem` +
        `${specs.isolation ? ` / ${specs.isolation}` : ''}`;
    }
    for (const name of PROBE_NAMES) {
      const seen = outs.flatMap((o) => o.probes.filter((p) => p.probe === name).map((p) => p.outcome));
      byProbe[name] = seen[0] ?? 'unknown';
    }
    return byProbe;
  },

  // A sandbox that dies under the OOM probe made this task work, not fail.
  expectedErrorPhase: (phase) => phase.startsWith('probe:'),
};

/** Highest progress checkpoint a streaming probe reported before it died. */
function lastProgressMb(stdout: string): number | null {
  const hits = [...stdout.matchAll(/progress_mb=(\d+)/g)].map((m) => Number(m[1]));
  return hits.length ? Math.max(...hits) : null;
}

function unknown(stdout: string, stderr: string, exitCode: number): { outcome: ProbeOutcome; evidence: string } {
  const blob = `${stdout}\n${stderr}`.trim().slice(-200);
  return { outcome: exitCode === 0 ? 'unknown' : 'killed', evidence: `exit ${exitCode}: ${blob}` };
}
