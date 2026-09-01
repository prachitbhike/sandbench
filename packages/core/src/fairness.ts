import { environmentFingerprint } from './environment.js';
import { TAIL_RELIABLE_N, separation } from './stats.js';
import type { FairnessNote, ProviderResult, RaceResult } from './types.js';

/** Rate cards go stale quietly. Flag anything older than a quarter. */
const RATE_STALE_DAYS = 90;

/**
 * The harness auditing its own output.
 *
 * A benchmark's most dangerous failure mode is not a wrong number — it is a
 * right number read as if it settled a question it never touched. Every
 * control this harness does *not* hold constant is enumerated here and shipped
 * inside the result file, so the caveats travel with the data instead of
 * living in a README nobody opens next to the chart.
 */
export function assessFairness(race: RaceResult): FairnessNote[] {
  const notes: FairnessNote[] = [];
  const live = race.providers.filter((p) => p.status !== 'dns');
  if (live.length === 0) return notes;

  imageParity(race, live, notes);
  resourceParity(live, notes);
  sampleSize(race, live, notes);
  medianOverlap(race, live, notes);
  costProvenance(live, notes);
  ordering(race, live, notes);
  firstLapWarmup(race, live, notes);
  retryMasking(live, notes);
  fleetCompletion(race, live, notes);
  scaffoldingLoc(live, notes);
  clientContext(race, notes);

  const rank = { warning: 0, caution: 1, info: 2 };
  return notes.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * The single biggest confound in this benchmark.
 *
 * `pip install flask pytest` on a slim Debian image is a different amount of
 * work than on an image that ships them; a 2 GB image pulls slower than a
 * 200 MB one. Unless every provider ran the same base image, the timing
 * columns are partly measuring image choice.
 */
function imageParity(race: RaceResult, live: ProviderResult[], notes: FairnessNote[]): void {
  const fingerprints = new Map<string, string>();
  for (const p of live) {
    fingerprints.set(p.provider, environmentFingerprint(p.environment));
  }
  const distinct = new Set(fingerprints.values());
  if (distinct.size <= 1) return;

  const lines = [...fingerprints].map(([prov, fp]) => `  ${prov}: ${fp}`).join('\n');
  const unpinned = live.filter((p) => !p.template);
  // Only suggest --image to providers that can actually take a registry tag;
  // telling someone to pin an E2B image that way sends them down a dead end.
  const pinnable = unpinned.filter((p) => p.capabilities?.registryImages);
  const notPinnable = unpinned.filter((p) => p.capabilities && !p.capabilities.registryImages);

  notes.push({
    id: 'image-parity',
    severity: 'warning',
    title: 'Providers ran on different base images',
    detail:
      `Timing and install numbers are partly a measurement of image choice, not of the platform.\n${lines}` +
      (pinnable.length
        ? `\nFix the ones that can take a registry tag: --image ${pinnable.map((p) => `${p.provider}=python:3.12-slim`).join(',')}`
        : '') +
      (notPinnable.length
        ? `\n${notPinnable.map((p) => p.provider).join(', ')} cannot take a registry tag at create time — parity there needs a prebuilt template.`
        : ''),
    affects: live.map((p) => p.provider),
  });
}

/** Same question, one layer down: is it even the same size of machine? */
function resourceParity(live: ProviderResult[], notes: FairnessNote[]): void {
  const unhonored = live.filter((p) => p.resources && !p.resources.honored);
  if (unhonored.length === 0) return;
  // Two different reasons, two different fixes. Collapsing them into "does not
  // support it" would send a Daytona user looking for a feature they have.
  const reasons = unhonored.map((p) => {
    switch (p.capabilities?.resourceControl) {
      case 'template-only':
        return `${p.provider}: size is fixed by the template, so it can only be matched by building one`;
      case 'per-sandbox':
        return `${p.provider}: supports cpu/memory at create time, but only on the from-image path — pin an image with --image ${p.provider}=<tag> and the request applies`;
      default:
        return `${p.provider}: no machine-size control`;
    }
  });
  notes.push({
    id: 'resource-parity',
    severity: 'warning',
    title: 'Requested machine size could not be applied everywhere',
    detail:
      `These providers ran whatever their default hands out while the others ran the requested size, ` +
      `so per-vCPU cost and any CPU-bound step are affected.\n  ${reasons.join('\n  ')}`,
    affects: unhonored.map((p) => p.provider),
  });
}

function sampleSize(race: RaceResult, live: ProviderResult[], notes: FairnessNote[]): void {
  const n = Math.max(...live.map((p) => p.coldStart?.n ?? 0), 0);
  if (n === 0) return;
  if (n < 5) {
    notes.push({
      id: 'sample-size-median',
      severity: 'warning',
      title: `Only ${n} lap${n === 1 ? '' : 's'} per provider`,
      detail:
        'Medians from this few samples move by tens of percent run to run. Treat the ordering as anecdote, ' +
        `not measurement — raise it with --iterations ${Math.max(20, n * 4)}.`,
      affects: [],
    });
  } else if (n < TAIL_RELIABLE_N) {
    notes.push({
      id: 'sample-size-tail',
      severity: 'caution',
      title: `p95 is not meaningful at n=${n}`,
      detail:
        `With ${n} samples the 95th percentile is interpolated between the top two values — it is the max wearing a lab coat, ` +
        `and one slow lap moves it wholesale. Medians are usable; tails need n >= ${TAIL_RELIABLE_N}. ` +
        'The report labels these values rather than hiding them.',
      affects: [],
    });
  }
}

/** Two providers whose confidence intervals overlap are not ranked, they are tied. */
function medianOverlap(race: RaceResult, live: ProviderResult[], notes: FairnessNote[]): void {
  const ranked = live
    .filter((p) => p.timeToReady ?? p.coldStart)
    .sort(
      (a, b) =>
        ((a.timeToReady ?? a.coldStart)?.p50 ?? Infinity) -
        ((b.timeToReady ?? b.coldStart)?.p50 ?? Infinity),
    );
  if (ranked.length < 2) return;
  const leader = ranked[0]!;
  const tied = ranked
    .slice(1)
    .filter(
      (p) =>
        separation(leader.timeToReady ?? leader.coldStart, p.timeToReady ?? p.coldStart) ===
        'overlapping',
    );
  if (tied.length === 0) return;
  notes.push({
    id: 'median-overlap',
    severity: 'warning',
    title: `${leader.provider} is not measurably faster than ${tied.map((p) => p.provider).join(', ')}`,
    detail:
      'Their bootstrap 95% confidence intervals on the median overlap, so the finishing order between them is inside the ' +
      'noise of this run. Reading the podium as a ranking here would be reading the noise.',
    affects: [leader.provider, ...tied.map((p) => p.provider)],
  });
}

function costProvenance(live: ProviderResult[], notes: FairnessNote[]): void {
  const assumed = live.filter((p) => p.cost?.basis === 'assumed');
  if (assumed.length > 0) {
    notes.push({
      id: 'cost-assumed',
      severity: 'warning',
      title: 'Cost for some providers is modelled on assumed machine sizes',
      detail:
        `${assumed.map((p) => `${p.provider} (${p.cost?.basisNote})`).join('; ')}. ` +
        'An assumed size makes the cost column a restatement of runtime rather than a price. ' +
        'Fix it by pinning resources, or by running the environment probe against that provider.',
      affects: assumed.map((p) => p.provider),
    });
  }

  const stale = live.filter((p) => {
    const on = p.cost?.rateVerifiedOn;
    if (!on) return true;
    const age = (Date.now() - new Date(on).getTime()) / 86_400_000;
    return !Number.isFinite(age) || age > RATE_STALE_DAYS;
  });
  if (stale.length > 0) {
    notes.push({
      id: 'cost-rates-stale',
      severity: 'caution',
      title: 'Rate card is unverified or older than 90 days',
      detail:
        `${stale.map((p) => p.provider).join(', ')}: re-check the vendor price page and update pricing.json. ` +
        'Cost is modelled from measured sandbox-alive seconds, never read from a billing API, so it is an estimate in every case.',
      affects: stale.map((p) => p.provider),
    });
  }
}

function ordering(race: RaceResult, live: ProviderResult[], notes: FairnessNote[]): void {
  if (live.length < 2) return;
  if (race.config.order === 'interleaved') {
    notes.push({
      id: 'ordering-interleaved',
      severity: 'info',
      title: 'Providers were interleaved lap by lap',
      detail:
        'Lap n ran on every provider before lap n+1, with a rotating start order, so all providers saw the same ' +
        'few minutes of network and backend conditions. This is what makes the medians comparable at all.',
      affects: [],
    });
    return;
  }
  notes.push({
    id: 'ordering-sequential',
    severity: 'caution',
    title: 'Providers were measured one after another, not interleaved',
    detail:
      'Each provider was benchmarked in a different slice of wall-clock time, so a backend hiccup or a change in local ' +
      'network conditions lands entirely on whoever happened to be running. Prefer --order interleaved.',
    affects: [],
  });
}

/** The first call of a session pays for DNS, TLS and connection-pool setup. */
function firstLapWarmup(race: RaceResult, live: ProviderResult[], notes: FairnessNote[]): void {
  if (race.config.formationLap) return;
  const penalties = live
    .map((p) => {
      const first = p.firstLap?.coldStartMs ?? null;
      const steady = p.coldStartSteady?.p50 ?? null;
      if (first === null || steady === null || steady === 0) return null;
      return { provider: p.provider, ratio: first / steady, first, steady };
    })
    .filter((x): x is { provider: string; ratio: number; first: number; steady: number } => x !== null)
    .filter((x) => x.ratio >= 1.5);
  if (penalties.length === 0) return;
  notes.push({
    id: 'first-lap-warmup',
    severity: 'caution',
    title: 'First lap carries connection warm-up nobody else pays',
    detail:
      `${penalties
        .map((x) => `${x.provider} lap 1 was ${x.first}ms vs a ${Math.round(x.steady)}ms steady-state median (${x.ratio.toFixed(1)}x)`)
        .join('; ')}. ` +
      'That is DNS, TLS and pool setup, not the platform booting slower. It is included in the headline distribution ' +
      'because a short CI job really does pay it; the steady-state column shows the run without it. ' +
      'Use --formation-lap to absorb it uniformly.',
    affects: penalties.map((x) => x.provider),
  });
}

function retryMasking(live: ProviderResult[], notes: FairnessNote[]): void {
  const retried = live.filter((p) => p.retries > 0);
  if (retried.length === 0) return;
  const detail = retried
    .map((p) => {
      const worst = Math.max(
        ...p.iterations.map((i) => (i.acquireMs ?? 0) - (i.coldStartMs ?? 0)),
        0,
      );
      return `${p.provider}: ${p.retries} retry(s), up to ${Math.round(worst)}ms of failed attempts hidden behind the reported cold start`;
    })
    .join('; ');
  notes.push({
    id: 'retry-masking',
    severity: 'caution',
    title: 'Some laps only succeeded on a retry',
    detail: `${detail}. The cold-start column times the attempt that worked; the acquire column times what the caller actually waited.`,
    affects: retried.map((p) => p.provider),
  });
}

/** A provider that only finished half the fleet has no comparable throughput. */
function fleetCompletion(race: RaceResult, live: ProviderResult[], notes: FairnessNote[]): void {
  if (race.task !== 'relay') return;
  const partial = live.filter((p) => {
    const done = Number(p.summary?.['shardsCompleted'] ?? 0);
    const size = Number(p.summary?.['fleetSize'] ?? 0);
    return size > 0 && done < size;
  });
  if (partial.length === 0) return;
  notes.push({
    id: 'fleet-partial',
    severity: 'warning',
    title: 'Throughput is not comparable where the fleet did not complete',
    detail:
      `${partial
        .map((p) => `${p.provider} finished ${p.summary?.['shardsCompleted']}/${p.summary?.['fleetSize']} shards`)
        .join('; ')}. ` +
      'Creates-per-second counts only successful creates, so a provider that is throttled early can post a flattering rate ' +
      'for the few sandboxes it did start. Read it next to fleet completion, and remember these ceilings are account tier, not capability.',
    affects: partial.map((p) => p.provider),
  });
}

function scaffoldingLoc(live: ProviderResult[], notes: FairnessNote[]): void {
  const scaffolded = live.filter((p) => (p.loc?.scaffolding ?? 0) > 0);
  if (scaffolded.length === 0) return;
  notes.push({
    id: 'loc-scaffolding',
    severity: 'caution',
    title: 'Adapter size is inflated by our own integration choices',
    detail:
      `${scaffolded
        .map((p) => `${p.provider}: ${p.loc?.adapter ?? 0} lines of adapter + ${p.loc?.scaffolding ?? 0} lines of scaffolding`)
        .join('; ')}. ` +
      'The scaffolding exists because of the integration path this repo picked, not because the vendor demands it. ' +
      'Compare the adapter column; the total is a cost of our architecture.',
    affects: scaffolded.map((p) => p.provider),
  });
}

function clientContext(race: RaceResult, notes: FairnessNote[]): void {
  notes.push({
    id: 'client-context',
    severity: 'info',
    title: 'One client, one location, one moment',
    detail:
      `Measured from a single machine on ${new Date(race.startedAt).toISOString().slice(0, 10)}. ` +
      'Every latency number includes the round trip from this client to whichever region each provider defaulted to, ' +
      'which is not held constant and can be tens of milliseconds on its own. Re-run from your own deployment region ' +
      'before treating any of it as a decision input.',
    affects: [],
  });
}
