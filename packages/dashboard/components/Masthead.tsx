'use client';

import type { Telemetry } from '@/lib/telemetry';
import { CostCounter } from './CostCounter';
import { TimeAgo } from './TimeAgo';

export function Masthead({ data, live, lastSync }: { data: Telemetry | null; live: boolean; lastSync: number }) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <div>
          <div className="lights" aria-hidden="true">
            <span className="lamp" /><span className="lamp" /><span className="lamp" />
            <span className="lamp" /><span className="lamp" />
          </div>
          <h1 className="wordmark display">
            Sandbox Grand Prix
            <em>Pit Wall Telemetry</em>
          </h1>
        </div>

        <div className="readouts">
          <div className="readout">
            <span className="readout-label">Races logged</span>
            <span className="readout-value display num">{data?.raceCount ?? '—'}</span>
          </div>
          <div className="readout">
            <span className="readout-label">Sandbox seconds</span>
            <span className="readout-value display num">
              {data ? data.totalSandboxSeconds.toFixed(0) : '—'}
            </span>
          </div>
          <div className="readout">
            {/* Surfaced at masthead level on purpose: an unqualified board is
                the failure mode this project is trying to avoid. */}
            <span className="readout-label">Open caveats</span>
            <span
              className="readout-value display num"
              style={{ color: data && data.openCaveats > 0 ? 'var(--warn)' : 'var(--ink)' }}
            >
              {data?.openCaveats ?? '—'}
            </span>
          </div>
          <div className="readout">
            <span className="readout-label">Errors captured</span>
            <span
              className="readout-value display num"
              style={{ color: data && data.totalErrors > 0 ? 'var(--critical)' : 'var(--ink)' }}
            >
              {data?.totalErrors ?? '—'}
            </span>
          </div>
          <div className="readout">
            <span className="readout-label">Cumulative spend</span>
            <span className="readout-value display cost">
              {data ? <CostCounter value={data.totalCostUsd} /> : '—'}
            </span>
            <span className="readout-sub">
              <span className={`live${live ? '' : ' stale'}`}>
                <span className="live-dot" />
                {live ? 'live' : 'offline'}
              </span>
              {lastSync > 0 && (
                <span style={{ marginLeft: 8, color: 'var(--ink-4)' }}>
                  <TimeAgo iso={new Date(lastSync).toISOString()} prefix="synced " />
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
