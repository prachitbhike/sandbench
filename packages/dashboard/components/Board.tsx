'use client';

import type { EscapeCell, TaskBoard } from '@/lib/telemetry';
import { TimingTower, order } from './TimingTower';
import { LapTrace } from './LapTrace';
import { ColdStartChart } from './ColdStartChart';
import { LatencySplit } from './LatencySplit';
import { StepBreakdown } from './StepBreakdown';
import { EscapeMatrix } from './EscapeMatrix';
import { PlatformPlate } from './PlatformPlate';
import { FairnessPanel } from './FairnessPanel';
import { fmtSummaryValue, humanize, livery } from '@/lib/format';
import { TimeAgo } from './TimeAgo';

const TASK_COPY: Record<string, { name: string; blurb: string }> = {
  sprint: {
    name: 'Sprint',
    blurb:
      'Cold-start qualifying. Write a Python script into a fresh sandbox, execute it, read stdout back — the 10,000th prime — then push 1 MiB in and pull it back out. Repeated to build a distribution.',
  },
  marathon: {
    name: 'Marathon',
    blurb:
      'Endurance run in a single sandbox: pip install, write a Flask app and a pytest suite, run it, deliberately break a test, fix it, re-run until green. Proves whether installed deps and written files survive between exec calls.',
  },
  escape: {
    name: 'Escape Room',
    blurb:
      'Isolation scrutineering. Each probe attempts something a hostile agent might, and we record what the sandbox does about it. Observational — and what it observes is each platform’s default, not its ceiling.',
  },
  relay: {
    name: 'Relay',
    blurb:
      'Parallel provisioning. Twenty sandboxes at once, each mapping a shard of a 100,000-row CSV; the orchestrator reduces and checks the result against a locally computed reference. Throttling is a finding, not something to retry away.',
  },
};

export function Board({
  board,
  index,
  probes,
  escape,
}: {
  board: TaskBoard;
  index: number;
  probes: string[];
  escape: EscapeCell[];
}) {
  const copy = TASK_COPY[board.task] ?? { name: board.task, blurb: '' };
  const ranked = order(board.providers);
  const summaryKeys = [
    ...new Set(ranked.flatMap((p) => (p.summary ? Object.keys(p.summary) : []))),
  ].filter((k) => !k.startsWith('_'));
  const isEscape = board.task === 'escape';
  // A "distribution" of one sample is not a chart — show where the single long
  // run actually spent its time instead.
  const hasDistribution = board.providers.some((p) => p.coldSamples.length > 1);
  const hasSplit = board.providers.some((p) => p.ready && p.cold);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title display">
          <span className="idx num">R{String(index + 1).padStart(2, '0')}</span>
          {copy.name}
        </h2>
        <span className="panel-meta">
          {board.iterations} {board.task === 'relay' ? 'sandboxes' : 'laps'} ·{' '}
          <TimeAgo iso={board.startedAt} /> · {board.raceId}
        </span>
      </div>
      <div className="panel-body">
        {copy.blurb && <p className="blurb">{copy.blurb}</p>}

        {/* The conditions the run was held under, stated before the results —
            an ordering claim means nothing without them. */}
        <div className="protocol">
          <span><b>{board.config.order}</b> provider order</span>
          <span>{board.config.formationLap ? 'formation lap' : 'no formation lap'}</span>
          <span>
            {board.config.resources
              ? `asked for ${board.config.resources.vcpus} vCPU / ${(board.config.resources.memMib / 1024).toFixed(0)} GiB`
              : 'default machine size'}
          </span>
          <span>{board.config.probes ? 'readiness + RTT probed' : 'no micro-probes'}</span>
        </div>

        <div className="scroll-x">
          <TimingTower board={board} />
        </div>

        {isEscape ? (
          <div style={{ marginTop: 26 }}>
            <EscapeMatrix probes={probes} cells={escape} />
          </div>
        ) : (
          <>
            {summaryKeys.length > 0 && (
              <div className="scroll-x" style={{ marginTop: 24 }}>
                <table className="tower">
                  <caption className="sr-only">{copy.name} task-specific results</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="l">Detail</th>
                      {ranked
                        .filter((p) => p.summary)
                        .map((p) => (
                          <th scope="col" key={p.provider} style={{ color: livery(p.provider).lit }}>
                            {p.provider}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summaryKeys.map((k) => (
                      <tr key={k}>
                        <td className="l t-muted">{humanize(k)}</td>
                        {ranked
                          .filter((p) => p.summary)
                          .map((p) => {
                            const v = p.summary?.[k];
                            const bad =
                              v === false ||
                              (k.toLowerCase().includes('failed') && typeof v === 'number' && v > 0) ||
                              (k.toLowerCase().includes('throttl') && typeof v === 'number' && v > 0) ||
                              (k.toLowerCase().includes('ratelimit') && typeof v === 'number' && v > 0) ||
                              // A fleet that only half came up cannot be compared
                              // on throughput, so flag it where it is read.
                              (k === 'fleetCompletion' && typeof v === 'number' && v < 1) ||
                              // Creates-per-second counts only successful
                              // creates, so a throttled fleet can post a
                              // flattering rate for the few it managed.
                              (k === 'createThroughputPerSec' &&
                                p.summary?.['throughputComparable'] === false);
                            return (
                              <td key={p.provider}>
                                <span
                                  className="num t-secondary"
                                  style={bad ? { color: 'var(--critical)' } : undefined}
                                >
                                  {fmtSummaryValue(v, k)}
                                </span>
                              </td>
                            );
                          })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {hasSplit && (
              <div style={{ marginTop: 26 }}>
                <h3 className="subhead display">Where the wait comes from</h3>
                <LatencySplit providers={board.providers} />
              </div>
            )}

            {hasDistribution ? (
              <div className="grid-2" style={{ marginTop: 26 }}>
                <div>
                  <h3 className="subhead display">Cold start distribution</h3>
                  <div className="chart-well">
                    <ColdStartChart providers={board.providers} />
                  </div>
                </div>
                <div>
                  <h3 className="subhead display">Lap times</h3>
                  <LapTrace providers={board.providers} />
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 26 }}>
                <h3 className="subhead display">Where the time went</h3>
                <StepBreakdown providers={board.providers} />
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: 26 }}>
          <h3 className="subhead display">What was under test</h3>
          <PlatformPlate providers={board.providers} />
        </div>

        <FairnessPanel notes={board.fairness} />
      </div>
    </section>
  );
}
