'use client';

import type { ProviderRollup } from '@/lib/telemetry';
import { livery } from '@/lib/format';

/**
 * What was actually under test.
 *
 * Two providers on different base images with different core counts are not
 * running the same benchmark, and no number of decimal places in the timing
 * column repairs that. This plate is where a reader finds out — so it sits on
 * every board, not only the isolation one.
 */
export function PlatformPlate({ providers }: { providers: ProviderRollup[] }) {
  const live = providers.filter((p) => p.status !== 'dns');
  if (live.length === 0) return null;

  const images = new Set(live.map((p) => p.template ?? 'provider default'));
  const mismatched = images.size > 1;

  return (
    <>
      <div className="machines">
        {live.map((p) => {
          const c = livery(p.provider);
          const env = p.environment;
          const caps = p.capabilities;
          return (
            <div className="machine" key={p.provider}>
              <div className="machine-name display" style={{ color: c.lit }}>
                <span className="livery" style={{ background: c.base, height: 14 }} />
                {p.provider}
              </div>
              <dl>
                <dt>IMAGE</dt>
                <dd style={mismatched ? { color: 'var(--warn)' } : undefined}>
                  {p.template ?? 'provider default'}
                </dd>
                <dt>OS</dt>
                <dd>{env?.os ?? '—'}{env?.python ? ` · py${env.python}` : ''}</dd>
                <dt>CPU</dt>
                <dd>
                  {env
                    ? `${env.cpuQuota ?? env.vcpus ?? '?'} vCPU${env.cpuQuota ? ' (cgroup quota)' : ''}`
                    : '—'}
                </dd>
                <dt>MEM</dt>
                <dd>{env?.memGib !== null && env?.memGib !== undefined ? `${env.memGib} GiB cap` : 'no cap'}</dd>
                <dt>DISK</dt>
                <dd>{env?.diskFreeGib !== null && env?.diskFreeGib !== undefined ? `${env.diskFreeGib} GiB free` : 'unreported'}</dd>
                <dt>KERNEL</dt>
                <dd>{env?.kernel ?? '—'}</dd>
                {env?.isolation && (
                  <>
                    <dt>ISOLATION</dt>
                    <dd style={{ color: 'var(--e2b-lit)' }}>{env.isolation}</dd>
                  </>
                )}
                <dt>SIZED BY US</dt>
                <dd style={{ color: p.resourcesHonored ? 'var(--good)' : 'var(--warn)' }}>
                  {p.resourcesHonored ? 'yes' : `no · ${caps?.resourceControl ?? 'unknown'}`}
                </dd>
                <dt>ADAPTER</dt>
                <dd>
                  {p.loc?.adapter ?? '—'} lines
                  {/* Scaffolding is a cost of the integration path this repo
                      chose, not evidence about the vendor's SDK. Kept in its
                      own clause so the two claims stay separable. */}
                  {p.loc?.scaffolding ? (
                    <span style={{ color: 'var(--warn)' }}> + {p.loc.scaffolding} scaffolding</span>
                  ) : null}
                </dd>
                <dt>SDK</dt>
                <dd style={caps && !caps.nativeTsSdk ? { color: 'var(--warn)' } : undefined}>
                  {caps ? (caps.nativeTsSdk ? 'native TypeScript' : `via ${caps.externalRuntime}`) : '—'}
                </dd>
              </dl>
            </div>
          );
        })}
      </div>
      {mismatched && (
        <p className="footnote" style={{ color: 'var(--warn)' }}>
          These providers ran on different base images. Install times and cold starts are partly a
          measurement of image choice. Pin them with{' '}
          <code>--image modal=python:3.12-slim,daytona=python:3.12-slim</code> — E2B needs a
          prebuilt template, since it cannot take a registry tag at create time.
        </p>
      )}
    </>
  );
}
