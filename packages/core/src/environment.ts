import type { Environment } from './types.js';

const MARK = '__SGP__';

/**
 * One command that reports what the sandbox actually is.
 *
 * Run once per provider per race. It grounds three separate claims that were
 * previously assumptions:
 *   - the cost model (how many vCPU and how much RAM are we paying for?)
 *   - image parity (are we even comparing the same base image?)
 *   - the isolation story (gVisor, microVM, plain container?)
 *
 * os.cpu_count() reports HOST cpus under gVisor, so the schedulable affinity
 * mask and the cgroup quota are what the workload actually gets.
 */
export const ENVIRONMENT_CMD = `python3 - <<'PY'
import os, platform, sys
def read(p):
    try:
        return open(p).read().strip()
    except Exception:
        return ""

try:
    affinity = len(os.sched_getaffinity(0))
except Exception:
    affinity = 0

quota = ""
cpu_max = read("/sys/fs/cgroup/cpu.max")            # cgroup v2: "<quota> <period>"
if cpu_max:
    parts = cpu_max.split()
    if len(parts) == 2 and parts[0] != "max":
        try:
            quota = "%.3f" % (int(parts[0]) / int(parts[1]))
        except Exception:
            quota = ""
if not quota:
    q = read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")  # cgroup v1
    p = read("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
    try:
        if q and p and int(q) > 0:
            quota = "%.3f" % (int(q) / int(p))
    except Exception:
        quota = ""

mem = read("/sys/fs/cgroup/memory.max") or read("/sys/fs/cgroup/memory/memory.limit_in_bytes")
try:
    st = os.statvfs("/tmp")
    disk = st.f_bavail * st.f_frsize
except Exception:
    disk = 0

osname = ""
for line in read("/etc/os-release").splitlines():
    if line.startswith("PRETTY_NAME="):
        osname = line.split("=", 1)[1].strip().strip('"')
        break

print("${MARK}cpu_count=%s affinity=%s cpu_quota=%s mem_bytes=%s disk_bytes=%s kernel=%s python=%s os=%s" % (
    os.cpu_count() or 0, affinity, quota or "none", mem or "unknown", disk,
    platform.release(), "%d.%d.%d" % sys.version_info[:3], osname or "unknown"))
PY`;

/** Sandboxes on virtualised filesystems report absurd free space. */
const PLAUSIBLE_MAX_BYTES = 1024 ** 5;

export function parseEnvironment(stdout: string, template: string | null): Environment | null {
  const line = marker(stdout, 'cpu_count');
  if (!line) return null;
  const d = parseKv(line);
  const memRaw = d['mem_bytes'] ?? '';
  const memBytes = /^\d+$/.test(memRaw) ? Number(memRaw) : null;
  const kernel = d['kernel'] ?? null;
  const quotaRaw = d['cpu_quota'] ?? 'none';
  const osRaw = d['os'] ?? '';
  return {
    os: osRaw && osRaw !== 'unknown' ? osRaw : null,
    python: d['python'] ?? null,
    kernel,
    isolation: inferIsolation(kernel),
    // The affinity mask is the honest core count; fall back to os.cpu_count().
    vcpus: numOrNull(d['affinity']) || numOrNull(d['cpu_count']),
    cpuQuota: quotaRaw === 'none' ? null : numOrNull(quotaRaw),
    memGib: gib(memBytes),
    diskFreeGib: gib(Number(d['disk_bytes'] ?? 0)),
    template,
  };
}

/** Kernel strings leak the sandboxing technology. */
export function inferIsolation(kernel: string | null): string | null {
  if (!kernel) return null;
  const k = kernel.toLowerCase();
  if (k.includes('gvisor')) return 'gVisor';
  if (k.includes('microvm') || k.includes('amazon') || k.includes('fc')) return 'microVM (likely Firecracker)';
  if (k.includes('wsl')) return 'WSL';
  return null;
}

/**
 * How many vCPU this environment can actually use. A cgroup quota of 1 core
 * on a box reporting 64 schedulable CPUs means you get one core, and billing
 * a "64 vCPU sandbox" would be nonsense.
 */
export function effectiveVcpus(env: Environment | null): number | null {
  if (!env) return null;
  if (env.cpuQuota && env.cpuQuota > 0) return env.cpuQuota;
  return env.vcpus;
}

/** Short human label used in parity checks and report tables. */
export function environmentFingerprint(env: Environment | null): string {
  if (!env) return 'unmeasured';
  return [env.template ?? 'provider default', env.os ?? 'unknown os', `python ${env.python ?? '?'}`].join(' · ');
}

function gib(b: number | null): number | null {
  return b === null || !Number.isFinite(b) || b <= 0 || b > PLAUSIBLE_MAX_BYTES
    ? null
    : Number((b / 1024 ** 3).toFixed(2));
}

function numOrNull(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Last marker line, optionally requiring a key — probes may stream progress. */
export function marker(stdout: string, requireKey?: string): string {
  const lines = stdout.split('\n').filter((l) => l.includes(MARK));
  const wanted = requireKey ? lines.filter((l) => l.includes(`${requireKey}=`)) : lines;
  const line = wanted[wanted.length - 1];
  return line ? line.slice(line.indexOf(MARK) + MARK.length).trim() : '';
}

/** Parse `k=v k=v` where the final value may contain spaces. */
export function parseKv(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=([^\s]*(?:\s(?![\w]+=)[^\s]*)*)/g;
  for (const m of line.matchAll(re)) out[m[1]!] = m[2]!.trim();
  return out;
}

export const PROBE_MARK = MARK;
