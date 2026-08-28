'use client';

import { useState } from 'react';
import type { ProviderRollup } from '@/lib/telemetry';
import { livery } from '@/lib/format';

interface Hover { x: number; y: number; label: string; sub: string; color: string }

/**
 * Cold-start distribution as a strip plot: every sample is drawn, with a
 * min–p95 band and a p50 tick behind it.
 *
 * Deliberately not a histogram — with ~10 laps per provider, binning hides
 * the individual outliers that matter most when judging cold-start tails.
 */
export function ColdStartChart({ providers }: { providers: ProviderRollup[] }) {
  const [hover, setHover] = useState<Hover | null>(null);

  const runners = providers.filter((p) => p.coldSamples.length > 0);
  if (runners.length === 0) {
    return <p className="blurb">No cold-start samples recorded yet.</p>;
  }

  const all = runners.flatMap((p) => p.coldSamples);
  const max = Math.max(...all);
  const domainMax = niceCeil(max * 1.08);

  const ROW_H = 54;
  const PAD_L = 92;
  const LABEL_GUTTER = 96;   // direct p50 labels live here, never over the plot
  const PAD_R = 12 + LABEL_GUTTER;
  const PAD_T = 12;
  const AXIS_H = 46;
  const W = 900;
  const plotW = W - PAD_L - PAD_R;
  const H = PAD_T + runners.length * ROW_H + AXIS_H;

  const x = (v: number): number => PAD_L + (v / domainMax) * plotW;
  const ticks = tickValues(domainMax);

  return (
    <div style={{ position: 'relative' }}>
      <div className="dist-legend">
        {runners.map((p) => (
          <span className="legend-item" key={p.provider}>
            <span className="legend-swatch" style={{ background: livery(p.provider).base }} />
            {p.provider}
          </span>
        ))}
        <span className="legend-item" style={{ color: 'var(--ink-4)' }}>
          <span
            className="legend-swatch"
            style={{ background: 'transparent', borderLeft: '2px solid var(--ink)', width: 2, borderRadius: 0 }}
          />
          median (p50)
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
        role="img"
        aria-label="Cold start distribution per provider, in milliseconds"
      >
        {/* recessive grid */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={x(t)} x2={x(t)} y1={PAD_T} y2={PAD_T + runners.length * ROW_H}
              stroke="rgba(150,180,210,0.09)" strokeWidth={1}
            />
            <text
              x={x(t)} y={PAD_T + runners.length * ROW_H + 17} textAnchor="middle"
              fill="var(--ink-4)" fontSize={10} fontFamily="var(--font-mono)"
            >
              {t}
            </text>
          </g>
        ))}
        <text
          x={PAD_L} y={H - 4} textAnchor="start"
          fill="var(--ink-4)" fontSize={9} letterSpacing="0.16em" fontFamily="var(--font-mono)"
        >
          COLD START — MILLISECONDS
        </text>

        <line
          x1={PAD_L} x2={PAD_L + plotW} y1={PAD_T + runners.length * ROW_H}
          y2={PAD_T + runners.length * ROW_H}
          stroke="rgba(150,180,210,0.18)" strokeWidth={1}
        />

        {runners.map((p, i) => {
          const c = livery(p.provider);
          const cy = PAD_T + i * ROW_H + ROW_H / 2;
          const lo = p.coldMin ?? Math.min(...p.coldSamples);
          const hi = p.coldP95 ?? Math.max(...p.coldSamples);
          return (
            <g key={p.provider}>
              <text
                x={PAD_L - 14} y={cy + 4} textAnchor="end"
                fill={c.lit} fontSize={13} fontFamily="var(--font-display)"
                letterSpacing="0.06em" style={{ textTransform: 'uppercase' }}
              >
                {p.provider}
              </text>

              {/* min → p95 band */}
              <rect
                x={x(lo)} y={cy - 9} width={Math.max(x(hi) - x(lo), 2)} height={18}
                fill={c.base} opacity={0.14} rx={3}
              />

              {/* every sample, 2px surface ring so overlaps stay countable */}
              {p.coldSamples.map((s, j) => (
                <circle
                  key={j}
                  cx={x(s)} cy={cy} r={5}
                  fill={c.base} fillOpacity={0.85}
                  stroke="var(--surface)" strokeWidth={2}
                  style={{ cursor: 'crosshair' }}
                  onMouseEnter={(e) =>
                    setHover({
                      x: e.clientX, y: e.clientY,
                      label: `${s.toFixed(0)} ms`,
                      sub: `${p.provider} · lap ${j + 1}`,
                      color: c.lit,
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                />
              ))}

              {/* p50 tick — reads over the dots */}
              {p.coldP50 !== null && (
                <line
                  x1={x(p.coldP50)} x2={x(p.coldP50)} y1={cy - 14} y2={cy + 14}
                  stroke="var(--ink)" strokeWidth={2}
                />
              )}

              {/* direct label in the reserved gutter: <=4 series, no legend hunting */}
              {p.coldP50 !== null && (
                <>
                  <text
                    x={PAD_L + plotW + 14} y={cy}
                    fill="var(--ink)" fontSize={12} fontFamily="var(--font-mono)"
                  >
                    p50 {p.coldP50.toFixed(0)}
                  </text>
                  <text
                    x={PAD_L + plotW + 14} y={cy + 13}
                    fill="var(--ink-4)" fontSize={9.5} fontFamily="var(--font-mono)"
                  >
                    n={p.coldSamples.length} · max {Math.max(...p.coldSamples).toFixed(0)}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>

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

      {/* Table view — the chart is never the only way to read the data.
          Wrapped in a div because `width:1px` is only a *minimum* for CSS
          tables, so an .sr-only <table> silently widens the page. */}
      <div className="sr-only">
      <table>
        <caption>Cold start samples per provider, milliseconds</caption>
        <thead>
          <tr><th scope="col">Provider</th><th scope="col">Min</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">Samples</th></tr>
        </thead>
        <tbody>
          {runners.map((p) => (
            <tr key={p.provider}>
              <th scope="row">{p.provider}</th>
              <td>{p.coldMin?.toFixed(0)}</td>
              <td>{p.coldP50?.toFixed(0)}</td>
              <td>{p.coldP95?.toFixed(0)}</td>
              <td>{p.coldSamples.map((s) => s.toFixed(0)).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function niceCeil(v: number): number {
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}

function tickValues(domainMax: number): number[] {
  const target = 6;
  const raw = domainMax / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = 0; v <= domainMax + 1e-9; v += step) out.push(Math.round(v));
  return out;
}
