'use client';

import { useState } from 'react';
import type { ProviderRollup } from '@/lib/telemetry';
import { livery, ms, msUnit } from '@/lib/format';

interface Hover { x: number; y: number; label: string; sub: string; color: string }

/**
 * Where a single long run actually spent its time.
 *
 * Used instead of a distribution chart when a race has one iteration — a
 * "distribution" of one sample is not a chart. Segments are steps of the same
 * run, so they are shaded along ONE hue (the provider's livery) rather than
 * given twelve invented categorical colours; the step's identity comes from
 * the direct label and the hover, never from hue.
 */
export function StepBreakdown({ providers }: { providers: ProviderRollup[] }) {
  const [hover, setHover] = useState<Hover | null>(null);

  const rows = providers
    .filter((p) => p.laps.length > 0 && p.laps[0]!.steps.length > 0)
    .map((p) => ({ provider: p.provider, steps: p.laps[0]!.steps }));

  if (rows.length === 0) return <p className="blurb">No step timings recorded.</p>;

  const maxTotal = Math.max(
    ...rows.map((r) => r.steps.reduce((a, s) => a + s.durationMs, 0)),
    1,
  );

  return (
    <div className="steps">
      {rows.map((row) => {
        const c = livery(row.provider);
        const total = row.steps.reduce((a, s) => a + s.durationMs, 0);
        let acc = 0;
        return (
          <div className="step-row" key={row.provider}>
            <div className="lap-label">
              <span className="livery" style={{ background: c.base, height: 16 }} />
              <span>
                <div className="display" style={{ color: c.lit, fontSize: 12 }}>{row.provider}</div>
                <div style={{ color: 'var(--ink-4)', fontSize: 9 }} className="num">
                  {ms(total)}{msUnit(total)} total
                </div>
              </span>
            </div>
            <div className="step-track" style={{ width: `${(total / maxTotal) * 100}%` }}>
              {row.steps.map((s, i) => {
                const pct = (s.durationMs / total) * 100;
                acc += pct;
                // Alternating shade along one hue keeps segments countable.
                const opacity = 0.35 + (i % 3) * 0.22;
                const wide = pct > 12;
                return (
                  <div
                    key={`${s.name}-${i}`}
                    className="step-seg"
                    style={{
                      width: `${pct}%`,
                      background: s.ok ? c.base : 'var(--critical)',
                      opacity: s.ok ? opacity : 0.85,
                    }}
                    onMouseEnter={(e) =>
                      setHover({
                        x: e.clientX, y: e.clientY,
                        label: `${ms(s.durationMs)}${msUnit(s.durationMs)}`,
                        sub: `${row.provider} · ${s.name}${s.ok ? '' : ' · non-zero exit'}`,
                        color: s.ok ? c.lit : 'var(--critical)',
                      })
                    }
                    onMouseLeave={() => setHover(null)}
                  >
                    {/* Direct-label only the segments wide enough to hold text. */}
                    {wide && <span className="step-tag">{shortName(s.name)}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="footnote">
        One bar per provider, scaled against the slowest run. Segments are consecutive steps of the
        same session, shaded along each provider&apos;s livery; hover for the step name and duration.
        Red segments exited non-zero — in Marathon that includes the deliberately broken test.
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

/** Strip the ordering prefix we use in task code: "a:pip-install" -> "pip-install". */
function shortName(n: string): string {
  return n.replace(/^[a-z]:/i, '').replace(/^(probe|exec|write|read):/, '');
}
