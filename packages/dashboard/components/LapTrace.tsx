'use client';

import { useState } from 'react';
import type { ProviderRollup } from '@/lib/telemetry';
import { livery, ms, msUnit } from '@/lib/format';

interface Hover { x: number; y: number; label: string; sub: string; color: string }

/**
 * Per-provider lap times — a sparkline per competitor on a shared y-scale so
 * rows are directly comparable. Failed laps are ringed in the critical colour
 * AND drawn as a hollow mark, so failure is never signalled by colour alone.
 */
export function LapTrace({ providers }: { providers: ProviderRollup[] }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const runners = providers.filter((p) => p.laps.length > 0);
  if (runners.length === 0) return <p className="blurb">No laps recorded.</p>;

  const maxLap = Math.max(...runners.map((p) => p.laps.length));
  const maxMs = Math.max(...runners.flatMap((p) => p.laps.map((l) => l.totalMs)), 1);

  const W = 640;
  const H = 44;

  return (
    <div className="laps">
      {runners.map((p) => {
        const c = livery(p.provider);
        const step = p.laps.length > 1 ? W / (p.laps.length - 1) : 0;
        const y = (v: number): number => H - 6 - (v / maxMs) * (H - 14);
        const pts = p.laps.map((l, i) => [p.laps.length > 1 ? i * step : W / 2, y(l.totalMs)] as const);
        const line = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
        const area = `${line} L${pts[pts.length - 1]![0].toFixed(1)},${H} L${pts[0]![0].toFixed(1)},${H} Z`;

        return (
          <div className="lap-row" key={p.provider}>
            <div className="lap-label">
              <span className="livery" style={{ background: c.base, height: 16 }} />
              <span>
                <div className="display" style={{ color: c.lit, fontSize: 12 }}>{p.provider}</div>
                <div style={{ color: 'var(--ink-4)', fontSize: 9 }}>{p.laps.length} laps</div>
              </span>
            </div>
            <svg
              viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
              style={{ width: '100%', height: H, display: 'block', overflow: 'visible' }}
              role="img"
              aria-label={`${p.provider} lap times, ${p.laps.length} laps, slowest ${ms(Math.max(...p.laps.map((l) => l.totalMs)))}${msUnit(maxMs)}`}
            >
              <line x1={0} x2={W} y1={H - 6} y2={H - 6} stroke="rgba(150,180,210,0.1)" strokeWidth={1} />
              <path d={area} fill={c.base} opacity={0.1} />
              <path d={line} fill="none" stroke={c.base} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {p.laps.map((l, i) => (
                <circle
                  key={i}
                  cx={pts[i]![0]} cy={pts[i]![1]} r={l.ok ? 3.5 : 5}
                  fill={l.ok ? c.base : 'var(--surface)'}
                  stroke={l.ok ? 'var(--surface)' : 'var(--critical)'}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: 'crosshair' }}
                  onMouseEnter={(e) =>
                    setHover({
                      x: e.clientX, y: e.clientY,
                      label: `${ms(l.totalMs)}${msUnit(l.totalMs)}`,
                      sub: `${p.provider} · lap ${l.lap}${l.ok ? '' : ' · FAILED'}`,
                      color: l.ok ? c.lit : 'var(--critical)',
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                />
              ))}
            </svg>
          </div>
        );
      })}
      <p className="footnote">
        Shared vertical scale across rows — peak {ms(maxMs)}{msUnit(maxMs)} over {maxLap} laps.
        Hollow marks ringed in red are failed laps.
      </p>
      {hover && (
        <div
          style={{
            position: 'fixed', left: hover.x + 14, top: hover.y - 34, zIndex: 90,
            background: 'var(--surface-3)', border: '1px solid var(--rule-strong)',
            padding: '7px 10px', pointerEvents: 'none', boxShadow: 'var(--shadow-deep)',
          }}
        >
          <div className="num" style={{ color: hover.color, fontSize: 14 }}>{hover.label}</div>
          <div style={{ color: 'var(--ink-3)', fontSize: 10 }}>{hover.sub}</div>
        </div>
      )}
    </div>
  );
}
