'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Odometer-style counter. Eases to each new value rather than snapping, so a
 * fresh race file reads as the number rolling up — the pit-wall fuel-burn cue.
 */
export function CostCounter({ value, digits = 5 }: { value: number; digits?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    const b = value;
    if (a === b) return;
    const DURATION = 900;

    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / DURATION);
      const eased = 1 - (1 - t) ** 3;
      setShown(a + (b - a) * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      from.current = b;
    };
  }, [value]);

  return (
    <span className="num" suppressHydrationWarning>
      ${shown.toFixed(digits)}
    </span>
  );
}
