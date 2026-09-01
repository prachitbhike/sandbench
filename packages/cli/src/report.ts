import Table from 'cli-table3';
import pc from 'picocolors';
import {
  PROBE_NAMES,
  coefficientOfVariation,
  type EscapeOutput,
  type FairnessNote,
  type ProbeOutcome,
  type ProviderResult,
  type RaceResult,
} from '@sgp/core';
import {
  gapToLeader,
  headline,
  medal,
  medianWithCi,
  ms,
  pct,
  rank,
  statusBadge,
  truncate,
  usd,
  usdBig,
} from './format.js';

/** Tasks where a podium would be a category error. */
const UNRANKED_TASKS = new Set(['escape']);

export function renderRace(race: RaceResult): string {
  const out: string[] = [];
  const when = new Date(race.startedAt).toLocaleString();
  const ranked = rank(race.providers);
  const isRanked = !UNRANKED_TASKS.has(race.task);
  const meta = [
    `${race.config.iterations} ${race.task === 'relay' ? 'sandboxes' : 'lap(s)'}`,
    race.config.order ?? 'sequential',
    race.config.formationLap ? 'formation lap' : 'no formation lap',
    when,
  ].join(' · ');

  out.push('');
  out.push(`${pc.bold(pc.cyan(`🏁 ${race.task.toUpperCase()}`))}  ${pc.dim(meta)}`);
  out.push(pc.dim(`   ${race.raceId}`));

  out.push(renderHeadline(race, ranked, isRanked));

  const spread = renderSpread(ranked);
  if (spread) out.push(spread);

  const platform = renderPlatform(ranked);
  if (platform) out.push(platform);

  if (race.task === 'escape') {
    const matrix = renderEscapeMatrix(race);
    if (matrix) out.push(matrix);
  } else {
    const detail = renderTaskDetail(ranked);
    if (detail) out.push(detail);
  }

  const errors = renderErrors(ranked);
  if (errors) out.push(errors);

  const fairness = renderFairness(race.fairness ?? []);
  if (fairness) out.push(fairness);

  out.push('');
  return out.join('\n');
}

/**
 * The headline is time-to-ready, not create latency.
 *
 * `createSandbox()` returning means different things in different SDKs — some
 * resolve once the API accepts the request and finish booting inside your
 * first command. Ranking on it rewards whoever defers the most work. Ready is
 * create plus a command that actually came back, which is the thing an agent
 * waits for.
 */
function renderHeadline(race: RaceResult, ranked: ProviderResult[], isRanked: boolean): string {
  const leader = ranked.find((p) => p.status !== 'dns' && headline(p));
  // Motorsport's own answer: a car that did not finish is unclassified, not
  // placed last. Numbering a provider that failed half its laps would leave
  // the position column disagreeing with the times printed beside it.
  let position = 0;
  const table = new Table({
    head: [
      '', 'Provider', 'Status', 'Ready p50', 'vs leader', 'Create p50',
      'Exec RTT', 'Laps ok', 'Alive', 'Cost', '$/1k sessions',
    ].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
    colAligns: [
      'left', 'left', 'left', 'right', 'left', 'right',
      'right', 'right', 'right', 'right', 'right',
    ],
  });

  for (const p of ranked) {
    if (p.status === 'dns') {
      table.push([
        '  ', pc.gray(p.provider), statusBadge(p.status),
        pc.gray(truncate(p.dnsReason ?? 'did not start', 60)),
        '', '', '', '', '', '', '',
      ]);
      continue;
    }
    const ok = p.iterations.filter((it) => it.ok).length;
    const classified = p.status === 'ok';
    if (classified) position += 1;
    table.push([
      isRanked ? medal(position - 1, p, classified) : '  ',
      pc.bold(p.provider),
      statusBadge(p.status),
      medianWithCi(p.timeToReady),
      leader ? gapToLeader(p, leader, classified) : '',
      ms(p.coldStart?.p50),
      ms(p.execRtt?.p50),
      `${ok}/${p.iterations.length}`,
      `${p.totalAliveSeconds.toFixed(1)}s`,
      costCell(p),
      p.cost ? usdBig(p.cost.usdPer1kSessions) : '—',
    ]);
  }

  const legend = [
    pc.dim('   Ready = create + first command that came back (± is the 95% CI on the median).'),
    pc.dim('   Exec RTT = per-command round trip on a live sandbox; an agent pays it dozens of times a session.'),
    pc.dim(`   $/1k sessions = 1,000 sandboxes alive 10 minutes each. ${basisLegend(ranked)}`),
  ];
  if (ranked.some((p) => p.status === 'partial' || p.status === 'error')) {
    legend.push(
      pc.dim('   * unclassified — timed on the laps it completed, so not a finishing position.'),
    );
  }
  return [table.toString(), ...legend].join('\n');
}

function costCell(p: ProviderResult): string {
  if (!p.cost) return '—';
  const v = usd(p.cost.totalUsd);
  // An assumed machine size makes the cost column a restatement of runtime.
  return p.cost.basis === 'assumed' ? pc.yellow(`${v}*`) : v;
}

function basisLegend(ranked: ProviderResult[]): string {
  const assumed = ranked.filter((p) => p.cost?.basis === 'assumed').map((p) => p.provider);
  return assumed.length
    ? pc.yellow(`* modelled on an assumed machine size for ${assumed.join(', ')}.`)
    : 'All sizes measured or pinned.';
}

/**
 * Where the laps actually landed. Separate from the headline because a
 * distribution is a different question from a ranking, and because the p95
 * needs a caveat printed next to it rather than in a footnote.
 */
function renderSpread(ranked: ProviderResult[]): string | null {
  const live = ranked.filter((p) => p.status !== 'dns' && (p.coldStart?.n ?? 0) > 1);
  if (live.length === 0) return null;
  const anyUnreliable = live.some((p) => !(p.coldStart?.tailReliable ?? true));

  const t = new Table({
    head: ['Provider', 'n', 'min', 'p50', 'p90', anyUnreliable ? 'p95*' : 'p95', 'max', 'CV', 'Lap 1', 'Steady p50']
      .map((h) => pc.bold(h)),
    style: { head: [], border: [] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  });

  for (const p of live) {
    const d = p.coldStart!;
    const cv = coefficientOfVariation(d);
    const first = p.firstLap?.coldStartMs ?? null;
    const steady = p.coldStartSteady?.p50 ?? null;
    // A first lap far above steady state is connection warm-up, not the
    // platform booting slower — flag it rather than letting it move the median
    // invisibly.
    const warmup = first !== null && steady !== null && first > steady * 1.5;
    t.push([
      p.provider,
      String(d.n),
      ms(d.min),
      ms(d.p50),
      ms(d.p90),
      ms(d.p95),
      ms(d.max),
      cv === null ? '—' : cv.toFixed(2),
      warmup ? pc.yellow(ms(first)) : ms(first),
      ms(steady),
    ]);
  }

  const notes = [pc.dim('  cold-start spread')];
  const lines = [
    notes[0]!,
    t.toString(),
    pc.dim('   CV = stdev/mean: how repeatable, independent of how fast. Lower is more predictable.'),
  ];
  if (anyUnreliable) {
    lines.push(
      pc.yellow(`   * p95 from n<20 is interpolated between the top two samples — read it as the max, not a tail.`),
    );
  }
  if (live.some((p) => (p.firstLap?.coldStartMs ?? 0) > (p.coldStartSteady?.p50 ?? Infinity) * 1.5)) {
    lines.push(
      pc.dim('   Lap 1 carries DNS/TLS/pool warm-up. "Steady p50" is the same run with lap 1 dropped.'),
    );
  }
  return lines.join('\n');
}

/**
 * What we were actually comparing.
 *
 * Two providers on different base images with different core counts are not
 * running the same benchmark, and no amount of decimal places in the timing
 * column fixes that. This table is where a reader finds out.
 */
function renderPlatform(ranked: ProviderResult[]): string | null {
  const live = ranked.filter((p) => p.status !== 'dns');
  if (live.length === 0) return null;

  const t = new Table({
    head: ['Provider', 'Image', 'OS / Python', 'Machine', 'Isolation', 'Sized by us', 'Adapter LOC', 'Integration']
      .map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });

  for (const p of live) {
    const env = p.environment;
    const machine = env
      ? [
          `${env.cpuQuota ?? env.vcpus ?? '?'} vCPU`,
          env.memGib !== null ? `${env.memGib} GiB` : 'no mem cap',
          env.diskFreeGib !== null ? `${env.diskFreeGib} GiB disk` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : pc.dim('unmeasured');
    const loc = p.loc;
    const locCell = loc
      ? loc.scaffolding
        ? `${loc.adapter ?? 0} ${pc.dim(`+${loc.scaffolding} scaffold`)}`
        : String(loc.adapter ?? '—')
      : '—';
    const integration = p.capabilities
      ? p.capabilities.nativeTsSdk
        ? pc.dim('native TS SDK')
        : pc.yellow(`via ${p.capabilities.externalRuntime ?? 'external runtime'}`)
      : '—';
    t.push([
      p.provider,
      truncate(p.template ?? 'provider default', 22),
      env ? truncate(`${shortOs(env.os)} / py${env.python ?? '?'}`, 26) : pc.dim('—'),
      machine,
      env?.isolation ?? pc.dim(env?.kernel ?? '—'),
      p.resources?.honored ? pc.green('yes') : pc.yellow('no'),
      locCell,
      integration,
    ]);
  }

  return [pc.dim('  what was actually under test'), t.toString()].join('\n');
}

function shortOs(os: string | null): string {
  if (!os) return 'unknown';
  return os.replace(/ GNU\/Linux.*$/, '').replace(/^Debian /, 'Debian ');
}

function renderTaskDetail(ranked: ProviderResult[]): string | null {
  const summaries = ranked.filter((p) => p.summary && Object.keys(p.summary).length > 0);
  if (summaries.length === 0) return null;
  const keys = [...new Set(summaries.flatMap((p) => Object.keys(p.summary!)))];
  const st = new Table({
    head: [pc.bold('Detail'), ...summaries.map((p) => pc.bold(p.provider))],
    style: { head: [], border: [] },
  });
  for (const k of keys) {
    st.push([humanize(k), ...summaries.map((p) => fmtVal(p.summary![k], k))]);
  }
  return [pc.dim('  task detail'), st.toString()].join('\n');
}

function renderErrors(ranked: ProviderResult[]): string | null {
  const withErrors = ranked.filter((p) => p.errors.length > 0);
  if (withErrors.length === 0) return null;
  const out: string[] = [pc.red(pc.bold('  errors'))];
  for (const p of withErrors) {
    const kinds = Object.entries(p.errorsByKind ?? {})
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    out.push(`    ${pc.bold(p.provider)} ${pc.dim(kinds || `${p.errors.length} total`)}`);
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
      out.push(`      ${pc.red('•')} ${pc.dim(v.phase)}: ${truncate(msg, 140)}${times}`);
    }
  }
  return out.join('\n');
}

/**
 * The harness arguing with its own numbers.
 *
 * Printed last and printed always, because the failure mode of a benchmark is
 * not a wrong number — it is a right number quoted as if it settled something
 * it never touched.
 */
function renderFairness(notes: FairnessNote[]): string | null {
  if (notes.length === 0) return null;
  const icon: Record<FairnessNote['severity'], string> = {
    warning: pc.yellow('▲'),
    caution: pc.cyan('▲'),
    info: pc.dim('•'),
  };
  const out: string[] = ['', pc.bold('  read this before quoting the numbers')];
  for (const n of notes) {
    const who = n.affects.length ? pc.dim(` [${n.affects.join(', ')}]`) : '';
    out.push(`    ${icon[n.severity]} ${pc.bold(n.title)}${who}`);
    for (const line of n.detail.split('\n')) {
      out.push(pc.dim(`       ${line}`));
    }
  }
  return out.join('\n');
}

function fmtVal(v: unknown, key = ''): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : pc.yellow('no');
  if (typeof v === 'number') {
    if (/completion$|rate$/i.test(key) && v >= 0 && v <= 1) return pct(v);
    if (/ms$/i.test(key)) return ms(v);
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
  }
  if (typeof v === 'object') return truncate(JSON.stringify(v), 40);
  return truncate(String(v), 40);
}

function humanize(k: string): string {
  return k.replace(/^_/, '').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

const OUTCOME_STYLE: Record<ProbeOutcome, (s: string) => string> = {
  allowed: pc.yellow,   // the sandbox permitted it — often the documented default
  blocked: pc.green,    // the sandbox stopped it
  killed: pc.cyan,      // the sandbox died doing it
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

  const controls: string[] = [];
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
      if (hit.control && !controls.some((c) => c.startsWith(`    ${probe}`))) {
        controls.push(`    ${probe}: ${hit.control}`);
      }
    }
    t.push(row);
  }

  return [
    pc.dim('  escape room — observational, not pass/fail'),
    t.toString(),
    pc.dim('   These are defaults, not capabilities. Where a knob exists, it is named below.'),
    ...controls.map((c) => pc.dim(c)),
  ].join('\n');
}
