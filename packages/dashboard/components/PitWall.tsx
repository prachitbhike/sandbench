'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Telemetry } from '@/lib/telemetry';
import { Masthead } from './Masthead';
import { Board } from './Board';
import { usd } from '@/lib/format';
import { TimeAgo } from './TimeAgo';

const POLL_MS = 2500;

export function PitWall({ initial }: { initial: Telemetry | null }) {
  const [data, setData] = useState<Telemetry | null>(initial);
  const [live, setLive] = useState(true);
  const [lastSync, setLastSync] = useState<number>(initial ? Date.now() : 0);
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current || document.hidden) return;
    inFlight.current = true;
    try {
      const res = await fetch('/api/results', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as Telemetry);
      setLastSync(Date.now());
      setLive(true);
    } catch {
      setLive(false);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    // Catch up immediately when the tab comes back rather than waiting a tick.
    const onVis = (): void => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [poll]);

  const boards = data?.boards ?? [];

  return (
    <>
      <Masthead data={data} live={live} lastSync={lastSync} />
      <main className="shell">
        {boards.length === 0 ? (
          <div className="empty">
            <p style={{ marginTop: 0 }}>No race results in <code>results/</code> yet.</p>
            <p>
              Run <code>sgp race --all --providers e2b,modal,daytona</code>
              <br />
              This board polls every {(POLL_MS / 1000).toFixed(1)}s and will fill itself in.
            </p>
          </div>
        ) : (
          boards.map((b, i) => (
            <Board
              key={b.task}
              board={b}
              index={i}
              probes={data?.probes ?? []}
              escape={data?.escape ?? []}
              machines={data?.machines ?? []}
            />
          ))
        )}

        {data && data.log.length > 0 && (
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title display">
                <span className="idx num">LOG</span>
                Race log
              </h2>
              <span className="panel-meta">newest first · {data.raceCount} total</span>
            </div>
            <div className="panel-body">
              <div className="ticker">
                {data.log.map((l) => (
                  <div className="tick" key={l.raceId}>
                    <span className="tick-task display">{l.task}</span>
                    <span className="tick-id">{l.raceId}</span>
                    <span style={{ color: 'var(--ink-3)' }}>{l.providers} running</span>
                    <span className="tick-cost num">{usd(l.costUsd, 5)}</span>
                  </div>
                ))}
              </div>
              <p className="footnote">
                Results are append-only JSON in <code>results/</code>, one file per race,
                schema-versioned. Cost is modelled from measured sandbox-alive seconds against the
                rates in <code>pricing.json</code> — not billed figures.
                {data.generatedAt && <> Snapshot <TimeAgo iso={data.generatedAt} />.</>}
              </p>
            </div>
          </section>
        )}
      </main>
    </>
  );
}
