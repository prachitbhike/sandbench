'use client';

import type { ProviderRollup, TaskBoard } from '@/lib/telemetry';
import { ciHalf, livery, ms, msUnit, pct, usd, usdBig } from '@/lib/format';

/** Finishers first (by time-to-ready), then partial, error, DNS. */
function classify(p: ProviderRollup): number {
  return p.status === 'dns' ? 3 : p.status === 'error' ? 2 : p.status === 'partial' ? 1 : 0;
}

function headline(p: ProviderRollup): { p50: number; ci95: [number, number] | null } | null {
  const d = p.ready ?? p.cold;
  return d ? { p50: d.p50, ci95: d.ci95 } : null;
}

export function order(providers: ProviderRollup[]): ProviderRollup[] {
  return [...providers].sort((a, b) => {
    const w = classify(a) - classify(b);
    if (w !== 0) return w;
    return (headline(a)?.p50 ?? Infinity) - (headline(b)?.p50 ?? Infinity);
  });
}

/**
 * The tower ranks on time-to-ready, not on create latency.
 *
 * `createSandbox()` resolving is not the same event across SDKs — some return
 * as soon as the control plane accepts the request and finish booting inside
 * your first command. Ranking on that rewards whoever defers the most work.
 * Ready is create plus a command that actually came back.
 *
 * Every position carries the confidence interval that produced it, and a
 * position whose interval overlaps the leader's is labelled TIED rather than
 * given a gap it has not earned.
 */
/** Tasks where a podium would be a category error. */
const UNRANKED_TASKS = new Set(['escape']);

export function TimingTower({ board }: { board: TaskBoard }) {
  // Escape Room measures what each sandbox permits. Numbering its rows by how
  // fast they booted would invite exactly the reading the task is built to
  // avoid — that one of these platforms "won" on isolation.
  const unranked = UNRANKED_TASKS.has(board.task);
  const ranked = order(board.providers);
  const running = ranked.filter((p) => p.status !== 'dns');
  const slowest = Math.max(...running.map((p) => headline(p)?.p50 ?? 0), 1);
  const showSpread = running.some((p) => (p.cold?.n ?? 0) > 1);
  const leaderP50 = headline(ranked[0]!)?.p50 ?? 0;

  // Motorsport's own answer to the problem: a car that did not complete the
  // race is *unclassified*, not placed last. Numbering a provider that failed
  // half its laps would make the position column non-monotonic against the
  // times beside it — it can be slower on paper and faster on the clock.
  let position = 0;

  return (
    <table className="tower">
      <caption className="sr-only">
        {board.task} results by provider: position, time to ready with confidence interval, create
        latency, per-command round trip, reliability and cost.
      </caption>
      <thead>
        <tr>
          <th scope="col" className="l" style={{ width: 30 }}>
            <span className="sr-only">Position</span>
          </th>
          <th scope="col" className="l">Competitor</th>
          <th scope="col">Ready p50</th>
          <th scope="col">vs leader</th>
          <th scope="col">Create p50</th>
          <th scope="col">Exec RTT</th>
          {showSpread && <th scope="col" style={{ width: 132 }}>spread</th>}
          <th scope="col">Laps ok</th>
          <th scope="col">Alive</th>
          <th scope="col">Cost</th>
          <th scope="col">$/1k sessions</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {ranked.map((p, i) => {
          const c = livery(p.provider);
          if (p.status === 'dns') {
            return (
              <tr key={p.provider} className="dnsrow" style={{ animationDelay: `${i * 55}ms` }}>
                <td className="pos">–</td>
                <td className="l">
                  <div className="competitor">
                    <span className="livery" style={{ background: 'var(--ink-4)' }} />
                    <span>
                      <div className="competitor-name" style={{ color: 'var(--ink-3)' }}>
                        {p.provider}
                      </div>
                    </span>
                  </div>
                </td>
                <td className="l" colSpan={showSpread ? 9 : 8} style={{ textAlign: 'left' }}>
                  {p.dnsReason ?? 'did not start'}
                </td>
                <td><span className="chip dns">DNS</span></td>
              </tr>
            );
          }

          const h = headline(p);
          const classified = p.status === 'ok';
          if (classified) position += 1;
          const half = ciHalf(h?.ci95);
          const lo = p.cold?.min ?? h?.p50 ?? 0;
          const hi = p.cold?.max ?? h?.p50 ?? 0;
          const floor = (lo / slowest) * 100;
          const ceiling = Math.min((hi / slowest) * 100, 100);

          return (
            <tr key={p.provider} style={{ animationDelay: `${i * 55}ms` }}>
              <td
                className={`pos display${!unranked && classified && position === 1 ? ' p1' : ''}`}
                title={
                  unranked
                    ? 'not ranked — this task records behaviour, not speed'
                    : classified
                      ? undefined
                      : 'unclassified — did not complete every lap'
                }
              >
                {unranked ? '·' : classified ? position : '–'}
              </td>
              <td className="l">
                <div className="competitor">
                  <span className="livery" style={{ background: c.base }} />
                  <span>
                    <div className="competitor-name display" style={{ color: c.lit }}>
                      {p.provider}
                    </div>
                    <div className="competitor-sub">
                      {p.template ?? 'default image'}
                      {p.environment?.isolation ? ` · ${p.environment.isolation}` : ''}
                    </div>
                  </span>
                </div>
              </td>
              <td>
                <span className="t-primary num display">{ms(h?.p50 ?? null)}</span>
                <span className="t-muted">{msUnit(h?.p50 ?? null)}</span>
                {half !== null && (
                  <span className="ci num" title="bootstrap 95% CI on the median">
                    ±{half.toFixed(0)}
                  </span>
                )}
              </td>
              <td>
                {unranked ? (
                  <span className="t-muted">—</span>
                ) : classified && position === 1 ? (
                  <span className="gap num leader">LEADER</span>
                ) : p.vsLeader === 'overlapping' ? (
                  // Overlapping intervals mean the ordering is inside the
                  // noise. Printing "+5ms" here would invent a result.
                  <span className="chip tied" title="confidence intervals overlap the leader's">
                    ≈ TIED
                  </span>
                ) : (
                  <span
                    className={`gap num${classified ? '' : ' unclassified'}`}
                    title={
                      classified
                        ? undefined
                        : 'timed on the laps it completed — not a finishing position'
                    }
                  >
                    +{ms((h?.p50 ?? 0) - leaderP50)}
                    {msUnit((h?.p50 ?? 0) - leaderP50)}
                    {classified ? '' : '*'}
                  </span>
                )}
              </td>
              <td><span className="t-secondary num">{ms(p.cold?.p50 ?? null)}{msUnit(p.cold?.p50 ?? null)}</span></td>
              <td><span className="t-secondary num">{ms(p.execRtt?.p50 ?? null)}{msUnit(p.execRtt?.p50 ?? null)}</span></td>
              {showSpread && (
                <td>
                  {/* min → max with a p50 tick. The full range, not min→p95:
                      at n<20 a p95 is the max anyway, so drawing it as a
                      distinct boundary would imply a tail we cannot see. */}
                  <div
                    className="range"
                    title={`min ${ms(p.cold?.min ?? null)} · p50 ${ms(p.cold?.p50 ?? null)} · max ${ms(p.cold?.max ?? null)}`}
                  >
                    <span className="range-axis" />
                    <span
                      className="range-band"
                      style={{
                        left: `${floor}%`,
                        width: `${Math.max(ceiling - floor, 1.5)}%`,
                        background: c.base,
                      }}
                    />
                    <span className="range-cap" style={{ left: `${floor}%`, background: c.base }} />
                    <span className="range-cap" style={{ left: `${ceiling}%`, background: c.base }} />
                    {p.cold && (
                      <span className="range-median" style={{ left: `${(p.cold.p50 / slowest) * 100}%` }} />
                    )}
                  </div>
                </td>
              )}
              <td>
                <span
                  className="num t-secondary"
                  style={p.successRate < 1 ? { color: 'var(--critical)' } : undefined}
                >
                  {pct(p.successRate)}
                </span>
                {p.retries > 0 && (
                  <span className="t-muted" style={{ color: 'var(--warn)' }} title="createSandbox retries">
                    {' '}↻{p.retries}
                  </span>
                )}
              </td>
              <td><span className="t-muted num">{p.aliveSeconds.toFixed(1)}s</span></td>
              <td>
                <span className="num" style={{ color: 'var(--flag)' }}>{usd(p.cost?.totalUsd ?? 0, 5)}</span>
              </td>
              <td>
                <span className="num" style={{ color: 'var(--flag)' }}>
                  {usdBig(p.cost?.per1kSessions)}
                </span>
                {/* An assumed machine size makes cost a restatement of runtime.
                    The badge is the difference between a price and a guess. */}
                {p.cost && p.cost.basis === 'assumed' && (
                  <span className="basis assumed" title={p.cost.basisNote}>est</span>
                )}
                {p.cost && p.cost.basis !== 'assumed' && (
                  <span className="basis" title={p.cost.basisNote}>{p.cost.basis}</span>
                )}
              </td>
              <td><span className={`chip ${p.status}`}>{p.status}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
