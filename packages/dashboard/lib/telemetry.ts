import {
  latestPerTask,
  loadAllResults,
  separation,
  type Distribution,
  type Environment,
  type FairnessNote,
  type ProbeOutcome,
  type ProviderCapabilities,
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
  readyMs: number | null;
  timeToReadyMs: number | null;
  totalMs: number;
  ok: boolean;
  steps: StepPoint[];
}

/** A distribution flattened for the client, CI and tail caveat included. */
export interface Dist {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  max: number;
  stdev: number;
  ci95: [number, number] | null;
  tailReliable: boolean;
  samples: number[];
}

export interface CostView {
  totalUsd: number;
  per1kSessions: number;
  perSandboxHour: number;
  basis: 'measured' | 'requested' | 'assumed';
  basisNote: string;
}

export interface ProviderRollup {
  provider: string;
  status: ProviderResult['status'];
  dnsReason?: string;
  supportsPersistence: boolean;
  capabilities: ProviderCapabilities | null;
  loc: { adapter: number | null; scaffolding: number | null } | null;
  template: string | null;
  environment: Environment | null;
  resourcesHonored: boolean | null;
  cold: Dist | null;
  coldSteady: Dist | null;
  ready: Dist | null;
  execRtt: Dist | null;
  firstLapColdMs: number | null;
  /** 'separated' | 'overlapping' against the leader of this board. */
  vsLeader: 'leader' | 'separated' | 'overlapping' | 'unknown';
  totalWallClockMs: number;
  aliveSeconds: number;
  cost: CostView | null;
  errors: number;
  errorsByKind: Record<string, number>;
  retries: number;
  successRate: number;
  laps: LapPoint[];
  summary: Record<string, unknown> | null;
  /** Convenience for the strip plot; same numbers as `cold.samples`. */
  coldSamples: number[];
}

export interface BoardConfig {
  iterations: number;
  order: string;
  formationLap: boolean;
  probes: boolean;
  resources: { vcpus: number; memMib: number } | null;
}

export interface TaskBoard {
  task: string;
  raceId: string;
  startedAt: string;
  iterations: number;
  config: BoardConfig;
  providers: ProviderRollup[];
  fairness: FairnessNote[];
}

export interface EscapeCell {
  provider: string;
  probe: string;
  outcome: ProbeOutcome;
  evidence: string;
  control?: string;
}

export interface Telemetry {
  generatedAt: string;
  raceCount: number;
  totalCostUsd: number;
  totalSandboxSeconds: number;
  totalErrors: number;
  /** Open caveats across the boards on screen. */
  openCaveats: number;
  boards: TaskBoard[];
  probes: string[];
  escape: EscapeCell[];
  /** Newest-first race log for the ticker. */
  log: { raceId: string; task: string; startedAt: string; providers: number; costUsd: number }[];
}

function dist(d: Distribution | null | undefined): Dist | null {
  if (!d) return null;
  return {
    n: d.n,
    min: d.min,
    p50: d.p50,
    p90: d.p90 ?? d.p50,
    p95: d.p95,
    max: d.max,
    stdev: d.stdev ?? 0,
    ci95: d.ci95 ?? null,
    tailReliable: d.tailReliable ?? d.n >= 20,
    samples: d.samples,
  };
}

function rollup(p: ProviderResult, leader: ProviderResult | undefined): ProviderRollup {
  const headline = p.timeToReady ?? p.coldStart;
  const leaderHeadline = leader ? (leader.timeToReady ?? leader.coldStart) : null;
  const vsLeader: ProviderRollup['vsLeader'] =
    leader === p ? 'leader' : separation(leaderHeadline, headline);

  return {
    provider: p.provider,
    status: p.status,
    ...(p.dnsReason ? { dnsReason: p.dnsReason } : {}),
    supportsPersistence: p.supportsPersistence,
    capabilities: p.capabilities ?? null,
    loc: p.loc ? { adapter: p.loc.adapter, scaffolding: p.loc.scaffolding } : null,
    template: p.template ?? null,
    environment: p.environment ?? null,
    resourcesHonored: p.resources?.honored ?? null,
    cold: dist(p.coldStart),
    coldSteady: dist(p.coldStartSteady),
    ready: dist(p.timeToReady),
    execRtt: dist(p.execRtt),
    firstLapColdMs: p.firstLap?.coldStartMs ?? null,
    vsLeader,
    totalWallClockMs: p.totalWallClockMs,
    aliveSeconds: p.totalAliveSeconds,
    cost: p.cost
      ? {
          totalUsd: p.cost.totalUsd,
          per1kSessions: p.cost.usdPer1kSessions ?? 0,
          perSandboxHour: p.cost.usdPerSandboxHour ?? 0,
          basis: p.cost.basis ?? 'assumed',
          basisNote: p.cost.basisNote ?? '',
        }
      : null,
    errors: p.errors.length,
    errorsByKind: p.errorsByKind ?? {},
    retries: p.retries,
    successRate: p.successRate ?? (p.iterations.length
      ? p.iterations.filter((i) => i.ok).length / p.iterations.length
      : 0),
    laps: p.iterations.map((it) => ({
      lap: it.iteration + 1,
      coldStartMs: it.coldStartMs ?? null,
      readyMs: it.readyMs ?? null,
      timeToReadyMs: it.timeToReadyMs ?? null,
      totalMs: it.totalMs,
      ok: it.ok,
      steps: it.steps.map((s) => ({ name: s.name, durationMs: s.durationMs, ok: s.ok })),
    })),
    summary: (p.summary as Record<string, unknown> | undefined) ?? null,
    coldSamples: p.coldStart?.samples ?? [],
  };
}

interface EscapeShaped {
  probes?: { probe: string; outcome: ProbeOutcome; evidence: string; control?: string }[];
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
          ...(probe.control ? { control: probe.control } : {}),
        });
      }
    }
  }

  const boards = latest.map((r) => {
    // The leader is whoever the board ranks first, which is what every
    // provider's "is this difference real?" verdict is measured against.
    const contenders = r.providers
      .filter((p) => p.status !== 'dns')
      .sort(
        (a, b) =>
          ((a.timeToReady ?? a.coldStart)?.p50 ?? Infinity) -
          ((b.timeToReady ?? b.coldStart)?.p50 ?? Infinity),
      );
    const leader = contenders[0];
    return {
      task: r.task,
      raceId: r.raceId,
      startedAt: r.startedAt,
      iterations: r.config.iterations,
      config: {
        iterations: r.config.iterations,
        order: r.config.order ?? 'sequential',
        formationLap: r.config.formationLap ?? false,
        probes: r.config.probes ?? false,
        resources: r.config.resources
          ? { vcpus: r.config.resources.vcpus, memMib: r.config.resources.memMib }
          : null,
      },
      providers: r.providers.map((p) => rollup(p, leader)),
      fairness: r.fairness ?? [],
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    raceCount: all.length,
    totalCostUsd,
    totalSandboxSeconds,
    totalErrors,
    openCaveats: boards.reduce(
      (a, b) => a + b.fairness.filter((n) => n.severity !== 'info').length,
      0,
    ),
    boards,
    probes: probeNames,
    escape,
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
