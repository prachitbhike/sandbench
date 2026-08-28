import { loadEnv } from '@sgp/core';
import { buildTelemetry, type Telemetry } from '@/lib/telemetry';
import { PitWall } from '@/components/PitWall';

// Read the results directory on every request — new race files must show up.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

loadEnv();

export default function Page() {
  let initial: Telemetry | null = null;
  try {
    initial = buildTelemetry();
  } catch {
    // Client polling will recover; never blank the page over a read error.
    initial = null;
  }
  return <PitWall initial={initial} />;
}
