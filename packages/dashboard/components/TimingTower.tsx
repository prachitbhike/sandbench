'use client';

import type { ProviderRollup, TaskBoard } from '@/lib/telemetry';
import { gap, livery, ms, msUnit, usd } from '@/lib/format';

/** Finishers first (by cold-start p50), then partial, error, DNS. */
function classify(p: ProviderRollup): number {
  return p.status === 'dns' ? 3 : p.status === 'error' ? 2 : p.status === 'partial' ? 1 : 0;
}

export function order(providers: ProviderRollup[]): ProviderRollup[] {
  return [...providers].sort((a, b) => {
    const w = classify(a) - classify(b);
    if (w !== 0) return w;
    return (a.coldP50 ?? Infinity) - (b.coldP50 ?? Infinity);
  });
}

export function TimingTower({ board }: { board: TaskBoard }) {
  const ranked = order(board.providers);
  const running = ranked.filter((p) => p.status !== 'dns');
  const leader = running[0]?.coldP50 ?? null;
  const slowest = Math.max(...running.map((p) => p.coldP95 ?? p.coldP50 ?? 0), 1);
  // With one lap there is no distribution — the column would be a row of dots.
  const showSpread = running.some((p) => p.coldSamples.length > 1);
  const cols = showSpread ? 8 : 7;

  return (
    <table className="tower">
      <caption className="sr-only">
        {board.task} results by provider: position, cold start, total time, cost and errors.
      </caption>
      <thead>
        <tr>
          <th scope="col" className="l" style={{ width: 30 }}>
            <span className="sr-only">Position</span>
          </th>
          <th scope="col" className="l">Competitor</th>
          <th scope="col">Cold p50</th>
          <th scope="col">Gap</th>
          <th scope="col">p95</th>
          {showSpread && <th scope="col" style={{ width: 150 }}>min — p95</th>}
          <th scope="col">Total</th>
          <th scope="col">Alive</th>
          <th scope="col">Cost</th>
          <th scope="col">Err</th>
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
                <td className="l" colSpan={cols} style={{ textAlign: 'left' }}>
                  {p.dnsReason ?? 'did not start'}
                </td>
                <td><span className="chip dns">DNS</span></td>
              </tr>
            );
          }
          const p50 = p.coldP50;
          const spread = ((p.coldP95 ?? p50 ?? 0) / slowest) * 100;
          const floor = ((p.coldMin ?? p50 ?? 0) / slowest) * 100;
          return (
            <tr key={p.provider} style={{ animationDelay: `${i * 55}ms` }}>
              <td className={`pos display${i === 0 ? ' p1' : ''}`}>{i + 1}</td>
              <td className="l">
                <div className="competitor">
                  <span className="livery" style={{ background: c.base }} />
                  <span>
                    <div className="competitor-name display" style={{ color: c.lit }}>
                      {p.provider}
                    </div>
                    <div className="competitor-sub">
                      {p.adapterLoc ?? '—'} LOC
                      {p.supportsPersistence ? ' · STATEFUL' : ''}
                    </div>
                  </span>
                </div>
              </td>
              <td>
                <span className="t-primary num display">{ms(p50)}</span>
                <span className="t-muted">{msUnit(p50)}</span>
              </td>
              <td>
                <span className={`gap num${i === 0 ? ' leader' : ''}`}>{gap(p50, leader)}</span>
              </td>
              <td><span className="t-secondary num">{ms(p.coldP95)}{msUnit(p.coldP95)}</span></td>
              {showSpread && (
                <td>
                  {/* Where this provider's cold starts actually live: a min→p95
                      range with end caps and a p50 tick. A collapsed range still
                      renders as a visible marker rather than vanishing. */}
                  <div
                    className="range"
                    title={`min ${ms(p.coldMin)}${msUnit(p.coldMin)} · p50 ${ms(p50)}${msUnit(p50)} · p95 ${ms(p.coldP95)}${msUnit(p.coldP95)}`}
                  >
                    <span className="range-axis" />
                    <span
                      className="range-band"
                      style={{
                        left: `${floor}%`,
                        width: `${Math.max(spread - floor, 1.5)}%`,
                        background: c.base,
                      }}
                    />
                    <span className="range-cap" style={{ left: `${floor}%`, background: c.base }} />
                    <span className="range-cap" style={{ left: `${spread}%`, background: c.base }} />
                    {p50 !== null && (
                      <span
                        className="range-median"
                        style={{ left: `${(p50 / slowest) * 100}%` }}
                      />
                    )}
                  </div>
                </td>
              )}
              <td><span className="t-secondary num">{ms(p.totalWallClockMs)}{msUnit(p.totalWallClockMs)}</span></td>
              <td><span className="t-muted num">{p.aliveSeconds.toFixed(1)}s</span></td>
              <td><span className="num" style={{ color: 'var(--flag)' }}>{usd(p.costUsd, 5)}</span></td>
              <td>
                <span className="num" style={{ color: p.errors ? 'var(--critical)' : 'var(--ink-3)' }}>
                  {p.errors}
                </span>
                {p.retries > 0 && (
                  <span className="t-muted" style={{ color: 'var(--warn)' }}> ↻{p.retries}</span>
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
