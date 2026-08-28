import Table from 'cli-table3';
import pc from 'picocolors';
import { PROBE_NAMES, type EscapeOutput, type ProbeOutcome, type RaceResult } from '@sgp/core';
import { medal, ms, rank, statusBadge, usd } from './format.js';

export function renderRace(race: RaceResult): string {
  const out: string[] = [];
  const when = new Date(race.startedAt).toLocaleString();
  out.push('');
  out.push(
    `${pc.bold(pc.cyan(`🏁 ${race.task.toUpperCase()}`))}  ${pc.dim(`${race.config.iterations} iteration(s) · ${when} · ${race.raceId}`)}`,
  );

  const table = new Table({
    head: [
      '', 'Provider', 'Status', 'Cold p50', 'Cold p95', 'Cold min',
      'Total', 'Alive', 'Cost', 'Err', 'Retry', 'LOC',
    ].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
    colAligns: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  });

  const ranked = rank(race.providers);
  for (const [i, p] of ranked.entries()) {
    if (p.status === 'dns') {
      table.push([
        '  ', pc.gray(p.provider), statusBadge(p.status),
        pc.gray(truncate(p.dnsReason ?? 'did not start', 44)),
        '', '', '', '', '', '', '',
        p.adapterLoc ?? '—',
      ]);
      continue;
    }
    table.push([
      medal(i, p),
      pc.bold(p.provider),
      statusBadge(p.status),
      ms(p.coldStart?.p50),
      ms(p.coldStart?.p95),
      ms(p.coldStart?.min),
      ms(p.totalWallClockMs),
      `${p.totalAliveSeconds.toFixed(1)}s`,
      usd(p.cost?.totalUsd),
      p.errors.length ? pc.red(String(p.errors.length)) : '0',
      p.retries ? pc.yellow(String(p.retries)) : '0',
      p.adapterLoc ?? '—',
    ]);
  }
  out.push(table.toString());

  if (race.task === 'escape') {
    const matrix = renderEscapeMatrix(race);
    if (matrix) out.push(matrix);
  }

  const summaries =
    race.task === 'escape'
      ? []
      : ranked.filter((p) => p.summary && Object.keys(p.summary).length > 0);
  if (summaries.length > 0) {
    const keys = [...new Set(summaries.flatMap((p) => Object.keys(p.summary!)))];
    const st = new Table({
      head: [pc.bold('Provider'), ...keys.map((k) => pc.bold(humanize(k)))],
      style: { head: [], border: [] },
    });
    for (const p of summaries) {
      st.push([p.provider, ...keys.map((k) => fmtVal(p.summary![k]))]);
    }
    out.push(pc.dim('  task detail'));
    out.push(st.toString());
  }

  const withErrors = ranked.filter((p) => p.errors.length > 0);
  if (withErrors.length > 0) {
    out.push(pc.red(pc.bold('  errors')));
    for (const p of withErrors) {
      // Collapse identical messages so one flaky call doesn't flood the report.
      const grouped = new Map<string, { count: number; phase: string }>();
      for (const e of p.errors) {
        const key = `${e.phase}::${e.message}`;
        const prev = grouped.get(key);
        if (prev) prev.count++;
        else grouped.set(key, { count: 1, phase: e.phase });
      }
      for (const [key, v] of grouped) {
        const msg = key.slice(v.phase.length + 2);
        const times = v.count > 1 ? pc.dim(` (x${v.count})`) : '';
        out.push(`    ${pc.red('•')} ${pc.bold(p.provider)} ${pc.dim(v.phase)}: ${truncate(msg, 150)}${times}`);
      }
    }
  }
  out.push('');
  return out.join('\n');
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return truncate(JSON.stringify(v), 40);
  return truncate(String(v), 40);
}

function humanize(k: string): string {
  return k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

const OUTCOME_STYLE: Record<ProbeOutcome, (s: string) => string> = {
  allowed: pc.red,      // the sandbox let it happen
  blocked: pc.green,    // the sandbox stopped it
  killed: pc.yellow,    // the sandbox died doing it
  partial: pc.yellow,
  unknown: pc.gray,
};

/** provider x probe -> outcome. Observational: no colour means "good". */
function renderEscapeMatrix(race: RaceResult): string | null {
  const live = race.providers.filter((p) => p.status !== 'dns' && p.iterations.length > 0);
  if (live.length === 0) return null;

  const t = new Table({
    head: [pc.bold('Probe'), ...live.map((p) => pc.bold(p.provider))],
    style: { head: [], border: [] },
  });

  for (const probe of PROBE_NAMES) {
    const row: string[] = [probe];
    for (const p of live) {
      const out = p.iterations[0]?.output as EscapeOutput | undefined;
      const hit = out?.probes.find((x) => x.probe === probe);
      if (!hit) {
        row.push(pc.gray('—'));
        continue;
      }
      const style = OUTCOME_STYLE[hit.outcome] ?? pc.gray;
      row.push(`${style(hit.outcome)}  ${pc.dim(truncate(hit.evidence, 46))}`);
    }
    t.push(row);
  }
  const specLines: string[] = [];
  for (const p of live) {
    const out = p.iterations[0]?.output as EscapeOutput | undefined;
    const sp = out?.specs;
    if (sp) {
      const bits = [
        `${sp.affinity ?? sp.cpuCount ?? '?'} schedulable cpu`,
        sp.cpuQuota ? `cgroup quota ${sp.cpuQuota} cores` : null,
        sp.memLimitGib !== null ? `${sp.memLimitGib} GiB mem cap` : 'no mem cap reported',
        sp.diskFreeGib !== null ? `${sp.diskFreeGib} GiB free disk` : 'disk unreported',
        `kernel ${sp.kernel ?? '?'}`,
        sp.isolation ? pc.cyan(sp.isolation) : null,
      ].filter(Boolean);
      specLines.push(`    ${pc.bold(p.provider)} ${pc.dim(bits.join(' · '))}`);
    }
  }
  return [
    pc.dim('  escape room — observational, not pass/fail'),
    t.toString(),
    ...(specLines.length ? [pc.dim('  machine as delivered'), ...specLines] : []),
  ].join('\n');
}
