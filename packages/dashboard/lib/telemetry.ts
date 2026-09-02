import {
  latestPerTask,
  loadAllResults,
  type ProbeOutcome,
  type ProviderResult,
  type RaceResult,
} from '@sgp/core';

export interface StepPoint {
  name: string;
  durationMs: number;
  ok: boolean;
}

export interface LapPoint {
  lap: number;
  coldStartMs: number | null;
  totalMs: number;
  ok: boolean;
  steps: StepPoint[];
}

export interface ProviderRollup {
  provider: string;
  status: ProviderResult['status'];
  dnsReason?: string;
  adapterLoc: number | null;
  supportsPersistence: boolean;
  coldP50: number | null;
  coldP95: number | null;
  coldMin: number | null;
  coldSamples: number[];
  totalWallClockMs: number;
  aliveSeconds: number;
  costUsd: number;
  errors: number;
  retries: number;
  laps: LapPoint[];
  summary: Record<string, unknown> | null;
}

export interface TaskBoard {
  task: string;
  raceId: string;
  startedAt: string;
  iterations: number;
  providers: ProviderRollup[];
}

export interface EscapeCell {
  provider: string;
  probe: string;
  outcome: ProbeOutcome;
  evidence: string;
}

export interface MachineRow {
  provider: string;
  cpu: string;
  memory: string;
  disk: string;
  kernel: string;
  isolation: string | null;
}

export interface Telemetry {
  generatedAt: string;
  raceCount: number;
  totalCostUsd: number;
  totalSandboxSeconds: number;
  totalErrors: number;
  boards: TaskBoard[];
  probes: string[];
  escape: EscapeCell[];
  machines: MachineRow[];
  /** Newest-first race log for the ticker. */
  log: { raceId: string; task: string; startedAt: string; providers: number; costUsd: number }[];
}

function rollup(p: ProviderResult): ProviderRollup {
  return {
    provider: p.provider,
    status: p.status,
    ...(p.dnsReason ? { dnsReason: p.dnsReason } : {}),
    adapterLoc: p.adapterLoc,
    supportsPersistence: p.supportsPersistence,
    coldP50: p.coldStart?.p50 ?? null,
    coldP95: p.coldStart?.p95 ?? null,
    coldMin: p.coldStart?.min ?? null,
    coldSamples: p.coldStart?.samples ?? [],
    totalWallClockMs: p.totalWallClockMs,
    aliveSeconds: p.totalAliveSeconds,
    costUsd: p.cost?.totalUsd ?? 0,
    errors: p.errors.length,
    retries: p.retries,
    laps: p.iterations.map((it) => ({
      lap: it.iteration + 1,
      coldStartMs: it.coldStartMs ?? null,
      totalMs: it.totalMs,
      ok: it.ok,
      steps: it.steps.map((s) => ({ name: s.name, durationMs: s.durationMs, ok: s.ok })),
    })),
    summary: (p.summary as Record<string, unknown> | undefined) ?? null,
  };
}

interface EscapeShaped {
  specs?: {
    affinity: number | null;
    cpuCount: number | null;
    cpuQuota: number | null;
    memLimitGib: number | null;
    diskFreeGib: number | null;
    kernel: string | null;
    isolation: string | null;
  } | null;
  probes?: { probe: string; outcome: ProbeOutcome; evidence: string }[];
}

export function buildTelemetry(): Telemetry {
  const all: RaceResult[] = loadAllResults();
  const latest = [...latestPerTask(all).values()].sort(
    (a, b) => TASK_ORDER.indexOf(a.task) - TASK_ORDER.indexOf(b.task),
  );

  let totalCostUsd = 0;
  let totalSandboxSeconds = 0;
  let totalErrors = 0;
  for (const r of all) {
    for (const p of r.providers) {
      totalCostUsd += p.cost?.totalUsd ?? 0;
      totalSandboxSeconds += p.totalAliveSeconds;
      totalErrors += p.errors.length;
    }
  }

  const escapeRace = latest.find((r) => r.task === 'escape');
  const escape: EscapeCell[] = [];
  const machines: MachineRow[] = [];
  const probeNames: string[] = [];

  if (escapeRace) {
    for (const p of escapeRace.providers) {
      const out = p.iterations[0]?.output as EscapeShaped | undefined;
      if (!out) continue;
      for (const probe of out.probes ?? []) {
        if (!probeNames.includes(probe.probe)) probeNames.push(probe.probe);
        escape.push({
          provider: p.provider,
          probe: probe.probe,
          outcome: probe.outcome,
          evidence: probe.evidence,
        });
      }
      const s = out.specs;
      if (s) {
        machines.push({
          provider: p.provider,
          cpu:
            `${s.affinity ?? s.cpuCount ?? '?'} cpu` +
            (s.cpuQuota ? ` · quota ${s.cpuQuota}` : ''),
          memory: s.memLimitGib !== null ? `${s.memLimitGib} GiB cap` : 'no cap',
          disk: s.diskFreeGib !== null ? `${s.diskFreeGib} GiB free` : 'unreported',
          kernel: s.kernel ?? '?',
          isolation: s.isolation,
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    raceCount: all.length,
    totalCostUsd,
    totalSandboxSeconds,
    totalErrors,
    boards: latest.map((r) => ({
      task: r.task,
      raceId: r.raceId,
      startedAt: r.startedAt,
      iterations: r.config.iterations,
      providers: r.providers.map(rollup),
    })),
    probes: probeNames,
    escape,
    machines,
    log: [...all]
      .reverse()
      .slice(0, 14)
      .map((r) => ({
        raceId: r.raceId,
        task: r.task,
        startedAt: r.startedAt,
        providers: r.providers.filter((p) => p.status !== 'dns').length,
        costUsd: r.providers.reduce((a, p) => a + (p.cost?.totalUsd ?? 0), 0),
      })),
  };
}

const TASK_ORDER = ['sprint', 'marathon', 'escape', 'relay'];
