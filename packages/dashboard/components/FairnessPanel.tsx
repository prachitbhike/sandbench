'use client';

import { useState } from 'react';
import type { FairnessNote } from '@sgp/core';
import { SEVERITY_COLOR, SEVERITY_GLYPH } from '@/lib/format';

/**
 * The board arguing with its own numbers.
 *
 * A benchmark's real failure mode is not a wrong figure — it is a correct
 * figure quoted as if it settled a question it never touched. Every control
 * the harness could not hold constant is listed here, next to the chart it
 * qualifies, rather than in a README nobody has open.
 *
 * Warnings are expanded by default. Nobody clicks "show caveats".
 */
export function FairnessPanel({ notes }: { notes: FairnessNote[] }) {
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;

  const serious = notes.filter((n) => n.severity === 'warning');
  const rest = notes.filter((n) => n.severity !== 'warning');
  const shown = open ? notes : serious;

  return (
    <div className="caveats">
      <div className="caveats-head">
        <h3 className="subhead display" style={{ margin: 0 }}>
          Read this before quoting the numbers
        </h3>
        {rest.length > 0 && (
          <button type="button" className="caveats-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? 'hide' : `+${rest.length} more`}
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="blurb" style={{ margin: 0 }}>
          Nothing serious flagged for this run — the lesser notes are still worth a look.
        </p>
      ) : (
        <ul className="caveat-list">
          {shown.map((n) => (
            <li key={n.id} className="caveat">
              <span className="caveat-glyph" style={{ color: SEVERITY_COLOR[n.severity] }}>
                {SEVERITY_GLYPH[n.severity]}
              </span>
              <div>
                <div className="caveat-title">
                  {n.title}
                  {n.affects.length > 0 && (
                    <span className="caveat-affects">{n.affects.join(' · ')}</span>
                  )}
                </div>
                {n.detail.split('\n').map((line, i) => (
                  <div className="caveat-detail" key={i}>
                    {line}
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
