'use client';

import type { EscapeCell, MachineRow } from '@/lib/telemetry';
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
export function EscapeMatrix({
  probes,
  cells,
  machines,
}: {
  probes: string[];
  cells: EscapeCell[];
  machines: MachineRow[];
}) {
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

      {machines.length > 0 && (
        <div className="machines">
          {machines.map((m) => (
            <div className="machine" key={m.provider}>
              <div className="machine-name display" style={{ color: livery(m.provider).lit }}>
                <span className="livery" style={{ background: livery(m.provider).base, height: 14 }} />
                {m.provider}
              </div>
              <dl>
                <dt>CPU</dt><dd>{m.cpu}</dd>
                <dt>MEM</dt><dd>{m.memory}</dd>
                <dt>DISK</dt><dd>{m.disk}</dd>
                <dt>KERNEL</dt><dd>{m.kernel}</dd>
                {m.isolation && (
                  <>
                    <dt>ISOLATION</dt>
                    <dd style={{ color: 'var(--e2b-lit)' }}>{m.isolation}</dd>
                  </>
                )}
              </dl>
            </div>
          ))}
        </div>
      )}

      <p className="footnote">
        Observational, not pass/fail — <strong style={{ color: 'var(--warn)' }}>allowed</strong> means the
        sandbox permitted the action, which may be the intended default.
        Glyphs: ● allowed · ■ blocked · ✕ killed · ◐ partial · ○ unknown.
      </p>
    </>
  );
}
