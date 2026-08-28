import type { ErrorRecord } from './types.js';

/**
 * Turn anything thrown into a structured record. We never want a provider
 * SDK blowing up to kill the race — the failure IS data.
 */
export function toErrorRecord(phase: string, err: unknown, iteration?: number): ErrorRecord {
  const rec: ErrorRecord = {
    phase,
    message: extractMessage(err),
    at: new Date().toISOString(),
  };
  if (iteration !== undefined) rec.iteration = iteration;
  if (err instanceof Error) {
    rec.name = err.name;
    if (err.stack) rec.stack = err.stack.split('\n').slice(0, 6).join('\n');
  }
  return rec;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    // Many SDKs stuff the useful bit into a `body`/`response` property.
    const extra = (err as unknown as Record<string, unknown>)['body'];
    const base = err.message || String(err);
    if (typeof extra === 'string' && extra && !base.includes(extra)) {
      return `${base} :: ${extra.slice(0, 500)}`;
    }
    return base;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Detect provider throttling for RELAY.
 *
 * Not just HTTP 429: providers express capacity limits very differently —
 * E2B returns "Rate limit exceeded ... maximum number of concurrent E2B
 * sandboxes", Daytona returns "Total CPU limit exceeded. Maximum allowed: 10".
 * Both are throttling, and counting only 429s would report the most
 * throttled provider as having zero throttling.
 */
const THROTTLE_PATTERNS = [
  'rate limit',
  'ratelimit',
  'too many requests',
  'limit exceeded',
  'exceeded the limit',
  'quota exceeded',
  'concurrency limit',
  'concurrent',
  'maximum allowed',
  'capacity',
  'try again later',
];

export function isRateLimit(err: unknown): boolean {
  const msg = extractMessage(err).toLowerCase();
  const status = (err as { status?: number; statusCode?: number } | null)?.status
    ?? (err as { statusCode?: number } | null)?.statusCode;
  if (status === 429) return true;
  if (msg.includes('429')) return true;
  return THROTTLE_PATTERNS.some((p) => msg.includes(p));
}
