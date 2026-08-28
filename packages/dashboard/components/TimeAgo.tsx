'use client';

import { useEffect, useState } from 'react';
import { relTime } from '@/lib/format';

/**
 * Relative timestamps can't be server-rendered: the clock moves between SSR
 * and hydration, which React reports as a mismatch. Render a stable dash on
 * the server, then fill in on the client and keep it ticking.
 */
export function TimeAgo({ iso, prefix = '' }: { iso: string; prefix?: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const update = (): void => setLabel(relTime(iso));
    update();
    const id = setInterval(update, 10_000);
    return () => clearInterval(id);
  }, [iso]);

  return <span suppressHydrationWarning>{label ? `${prefix}${label}` : '—'}</span>;
}
