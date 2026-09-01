'use client';

import { useState } from 'react';
import type { ProviderRollup } from '@/lib/telemetry';
import { livery, ms, msUnit } from '@/lib/format';

interface Hover { x: number; y: number; label: string; sub: string; color: string }

/**
 * Where the wait actually comes from.
 *
 * A single "cold start" number hides the trade every one of these platforms
 * makes: return from create early and finish booting inside the caller's first
 * command, or block until the sandbox is genuinely live. Split the bar and the
 * trade becomes visible — a provider can win on create and lose on ready.
 *
 * The third mark is the per-command round trip, drawn on the same axis because
 * an agent session is one create and then dozens of commands. At twenty
 * commands a 40ms difference in round trip outweighs a 200ms difference in
 * boot, which is the opposite of what a cold-start leaderboard implies.
 */
export function LatencySplit({ providers }: { providers: ProviderRollup[] }) {
  const [hover, setHover] = useState<Hover | null>(null);

  const rows = providers.filter((p) => p.status !== 'dns' && p.ready && p.cold);
  if (rows.length === 0) {
    return (
      <p className="blurb">
        No readiness samples — run with micro-probes enabled to split create from first command.
      </p>
    );
  }

  const maxTotal = Math.max(...rows.map((p) => p.ready!.p50), 1);
  const W = 640;
  const H = 30;

  return (
    <div className="laps">
      {rows.map((p) => {
        const c = livery(p.provider);
        const create = p.cold!.p50;
        // The delta, not the readiness sample itself: what the first command
        // cost on top of create, which is where deferred boot work shows up.
        const firstCmd = Math.max(p.ready!.p50 - create, 0);
        const rtt = p.execRtt?.p50 ?? null;
        const scale = (v: number): number => (v / maxTotal) * W;

        return (
          <div className="lap-row" key={p.provider}>
            <div className="lap-label">
              <span className="livery" style={{ background: c.base, height: 16 }} />
              <span>
                <div className="display" style={{ color: c.lit, fontSize: 12 }}>{p.provider}</div>
                <div style={{ color: 'var(--ink-4)', fontSize: 9 }} className="num">
                  ready {ms(p.ready!.p50)}{msUnit(p.ready!.p50)}
                </div>
              </span>
            </div>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              style={{ width: '100%', height: H, display: 'block', overflow: 'visible' }}
              role="img"
              aria-label={`${p.provider}: create ${ms(create)}, first command ${ms(firstCmd)}, per-command round trip ${ms(rtt)}`}
            >
              <rect
                x={0} y={6} width={Math.max(scale(create), 1)} height={16}
                fill={c.base} opacity={0.9}
                onMouseEnter={(e) => setHover({
                  x: e.clientX, y: e.clientY,
                  label: `${ms(create)}${msUnit(create)}`,
                  sub: `${p.provider} · createSandbox() returned`,
                  color: c.lit,
                })}
                onMouseLeave={() => setHover(null)}
              />
              <rect
                x={scale(create)} y={6} width={Math.max(scale(firstCmd), 1)} height={16}
                fill={c.base} opacity={0.34}
                onMouseEnter={(e) => setHover({
                  x: e.clientX, y: e.clientY,
                  label: `${ms(firstCmd)}${msUnit(firstCmd)}`,
                  sub: `${p.provider} · first command on top of create`,
                  color: c.lit,
                })}
                onMouseLeave={() => setHover(null)}
              />
              {/* Per-command floor, drawn as a caliper on the same axis. */}
              {rtt !== null && (
                <g
                  onMouseEnter={(e) => setHover({
                    x: e.clientX, y: e.clientY,
                    label: `${ms(rtt)}${msUnit(rtt)}`,
                    sub: `${p.provider} · every subsequent command`,
                    color: 'var(--ink)',
                  })}
                  onMouseLeave={() => setHover(null)}
                >
                  <rect x={0} y={0} width={Math.max(scale(rtt), 1)} height={4} fill="var(--ink-2)" />
                  <rect x={0} y={0} width={Math.max(scale(rtt), 1)} height={22} fill="transparent" />
                </g>
              )}
            </svg>
          </div>
        );
      })}

      <div className="dist-legend" style={{ marginTop: 10 }}>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--ink-2)', opacity: 0.9 }} />
          create returns
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--ink-2)', opacity: 0.34 }} />
          first command
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--ink-2)', height: 4 }} />
          per-command round trip
        </span>
      </div>
      <p className="footnote">
        Medians, shared scale. A short dark bar with a long pale one is a provider that returns from
        create before the sandbox can run anything — the wait moved, it did not disappear.
      </p>

      <div className="sr-only">
        <table>
          <caption>Latency split per provider, milliseconds (medians)</caption>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Create</th>
              <th scope="col">First command</th>
              <th scope="col">Ready total</th>
              <th scope="col">Per-command round trip</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.provider}>
                <th scope="row">{p.provider}</th>
                <td>{p.cold!.p50.toFixed(0)}</td>
                <td>{Math.max(p.ready!.p50 - p.cold!.p50, 0).toFixed(0)}</td>
                <td>{p.ready!.p50.toFixed(0)}</td>
                <td>{p.execRtt ? p.execRtt.p50.toFixed(0) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
