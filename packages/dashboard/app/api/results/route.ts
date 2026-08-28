import { NextResponse } from 'next/server';
import { loadEnv } from '@sgp/core';
import { buildTelemetry } from '@/lib/telemetry';

// Always hit the filesystem: the whole point is picking up new race files.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

loadEnv();

export function GET(): NextResponse {
  try {
    return NextResponse.json(buildTelemetry(), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
