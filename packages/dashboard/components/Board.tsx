'use client';

import type { TaskBoard } from '@/lib/telemetry';
import { TimingTower, order } from './TimingTower';
import { LapTrace } from './LapTrace';
import { ColdStartChart } from './ColdStartChart';
import { StepBreakdown } from './StepBreakdown';
import { EscapeMatrix } from './EscapeMatrix';
import { fmtSummaryValue, humanize, livery } from '@/lib/format';
import { TimeAgo } from './TimeAgo';
import type { EscapeCell, MachineRow } from '@/lib/telemetry';

const TASK_COPY: Record<string, { name: string; blurb: string }> = {
  sprint: {
    name: 'Sprint',
    blurb:
      'Cold-start qualifying. Write a Python script into a fresh sandbox, execute it, read stdout back — the 10,000th prime. Repeated to build a cold-start distribution.',
  },
  marathon: {
    name: 'Marathon',
    blurb:
      'Endurance run in a single sandbox: pip install, write a Flask app and a pytest suite, run it, deliberately break a test, fix it, re-run until green. Proves whether installed deps and written files survive between exec calls.',
  },
  escape: {
    name: 'Escape Room',
    blurb:
      'Isolation scrutineering. Each probe attempts something a hostile agent might, and we record what the sandbox does about it. Observational — not a score.',
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
  machines,
}: {
  board: TaskBoard;
  index: number;
  probes: string[];
  escape: EscapeCell[];
  machines: MachineRow[];
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

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title display">
          <span className="idx num">R{String(index + 1).padStart(2, '0')}</span>
          {copy.name}
        </h2>
        <span className="panel-meta">
          {board.iterations} {board.task === 'relay' ? 'sandboxes' : 'iterations'} ·{' '}
          <TimeAgo iso={board.startedAt} /> · {board.raceId}
        </span>
      </div>
      <div className="panel-body">
        {copy.blurb && <p className="blurb">{copy.blurb}</p>}

        <div className="scroll-x">
          <TimingTower board={board} />
        </div>

        {isEscape ? (
          <div style={{ marginTop: 26 }}>
            <EscapeMatrix probes={probes} cells={escape} machines={machines} />
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
                              (k.toLowerCase().includes('ratelimit') && typeof v === 'number' && v > 0);
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
      </div>
    </section>
  );
}
