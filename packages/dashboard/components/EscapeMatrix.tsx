'use client';

import type { EscapeCell } from '@/lib/telemetry';
import { OUTCOME_GLYPH, livery } from '@/lib/format';

const PROBE_DESC: Record<string, string> = {
  outbound_http: 'HTTP GET example.com',
  read_etc_passwd: 'read /etc/passwd',
  list_proc: 'enumerate /proc',
  disk_2gb: 'write 2 GB to disk',
  fork_200: 'spawn 200 processes',
  memory_oom: 'allocate until OOM',
};

/**
 * provider x probe -> outcome.
 *
 * Outcomes are STATES, not scores: "allowed" is not a failing grade, it is an
 * observation about a default. Every cell carries a glyph and a word alongside
 * its colour, so nothing depends on hue.
 */
export function EscapeMatrix({ probes, cells }: { probes: string[]; cells: EscapeCell[] }) {
  const providers = [...new Set(cells.map((c) => c.provider))];
  if (providers.length === 0) {
    return (
      <p className="blurb">
        No escape-room data yet. Run <code>sgp race --task escape</code>.
      </p>
    );
  }
  const at = (probe: string, provider: string): EscapeCell | undefined =>
    cells.find((c) => c.probe === probe && c.provider === provider);

  // One control note per probe: the knob is a property of the probe, not of
  // whichever provider happened to be listed first.
  const controls = probes
    .map((probe) => {
      const control = cells.find((c) => c.probe === probe && c.control)?.control;
      return control ? { probe, control } : null;
    })
    .filter((c): c is { probe: string; control: string } => c !== null);

  return (
    <>
      <div className="scroll-x">
      <table className="matrix">
        <caption className="sr-only">
          Isolation probe outcomes for each provider. Observational, not pass/fail.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="probe-h">Probe</th>
            {providers.map((p) => (
              <th scope="col" key={p} style={{ color: livery(p).lit }} className="display">
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {probes.map((probe) => (
            <tr key={probe}>
              <th scope="row" style={{ textAlign: 'left', verticalAlign: 'middle' }}>
                <div className="probe-name">{probe}</div>
                <div className="probe-desc">{PROBE_DESC[probe] ?? ''}</div>
              </th>
              {providers.map((prov) => {
                const cell = at(probe, prov);
                if (!cell) {
                  return (
                    <td key={prov}>
                      <div className="cell">
                        <span className="cell-outcome o-unknown">
                          <span className="cell-glyph">{OUTCOME_GLYPH['unknown']}</span> no data
                        </span>
                      </div>
                    </td>
                  );
                }
                return (
                  <td key={prov}>
                    <div className="cell">
                      <span className={`cell-outcome o-${cell.outcome}`}>
                        <span className="cell-glyph">{OUTCOME_GLYPH[cell.outcome] ?? '○'}</span>
                        {cell.outcome}
                      </span>
                      <span className="cell-evidence">{cell.evidence}</span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {controls.length > 0 && (
        <dl className="controls">
          {controls.map((c) => (
            <div key={c.probe}>
              <dt>{c.probe}</dt>
              <dd>{c.control}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="footnote">
        Observational, not pass/fail — <strong style={{ color: 'var(--warn)' }}>allowed</strong> means the
        sandbox permitted the action, which may be the intended default.
        These are <strong>defaults, not capabilities</strong>: where a platform ships a switch for a
        row, it is named above, so a difference here is a difference in what each vendor chose to
        turn on rather than in what it can do.
        Glyphs: ● allowed · ■ blocked · ✕ killed · ◐ partial · ○ unknown.
      </p>
    </>
  );
}
