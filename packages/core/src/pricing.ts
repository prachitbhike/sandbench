import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CostBasis, CostBreakdown, Environment, ResourceRequest } from './types.js';
import { effectiveVcpus } from './environment.js';
import { repoRoot } from './paths.js';

export interface ProviderRate {
  usd_per_vcpu_hour: number;
  usd_per_gib_hour: number;
  /** Fallback size, used only when nothing better is known. */
  default_vcpus: number;
  default_mem_gib: number;
  /** How the vendor actually meters this: per requested resources, or per template tier. */
  billed_on?: 'requested-resources' | 'template-tier' | 'unknown';
  source?: string;
  verified_on?: string;
}

export interface PricingFile {
  version: number;
  providers: Record<string, ProviderRate>;
}

const FALLBACK: ProviderRate = {
  usd_per_vcpu_hour: 0.0504,
  usd_per_gib_hour: 0,
  default_vcpus: 2,
  default_mem_gib: 4,
  billed_on: 'unknown',
  source: 'built-in fallback (pricing.json missing this provider)',
};

let cached: PricingFile | null = null;

export function loadPricing(path?: string): PricingFile {
  if (cached && !path) return cached;
  const file = path ?? resolve(repoRoot(), 'pricing.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PricingFile;
    if (!path) cached = parsed;
    return parsed;
  } catch {
    const empty: PricingFile = { version: 0, providers: {} };
    if (!path) cached = empty;
    return empty;
  }
}

export function rateFor(provider: string, path?: string): ProviderRate {
  return loadPricing(path).providers[provider] ?? FALLBACK;
}

/** A typical agent session: one sandbox alive for ten minutes. */
export const SESSION_MINUTES = 10;

export interface CostInputs {
  /** Resources we asked the SDK for. */
  requested?: ResourceRequest | null;
  /**
   * Whether the adapter actually applied that request. A vendor that bills on
   * the request still bills its own default when we never sent one, so an
   * unapplied request must not be used as a cost basis.
   */
  requestHonored?: boolean;
  /** What the sandbox turned out to be, measured from inside. */
  environment?: Environment | null;
  path?: string;
}

/**
 * Cost, with its provenance attached.
 *
 * The old model multiplied alive-seconds by a hardcoded vCPU count, which
 * meant the "cost" column was really a restatement of runtime. Now the size is
 * resolved in a defined order and the answer carries which rung it landed on,
 * so a reader can tell a measurement from a guess:
 *
 *   1. requested — the SDK let us pin cpu/memory, and that is what is billed
 *   2. measured  — the cgroup limits we observed inside the sandbox
 *   3. assumed   — pricing.json's default, i.e. nobody actually knows
 */
export function computeCost(
  provider: string,
  aliveSeconds: number,
  inputs: CostInputs = {},
): CostBreakdown {
  const r = rateFor(provider, inputs.path);
  const { vcpus, memGib, basis, basisNote } = resolveSize(provider, r, inputs);

  const hours = aliveSeconds / 3600;
  const cpuUsd = hours * vcpus * r.usd_per_vcpu_hour;
  const memUsd = hours * memGib * r.usd_per_gib_hour;
  const total = cpuUsd + memUsd;
  const perHour = vcpus * r.usd_per_vcpu_hour + memGib * r.usd_per_gib_hour;

  return {
    aliveSeconds,
    vcpus,
    memGib,
    usdPerVcpuHour: r.usd_per_vcpu_hour,
    usdPerGibHour: r.usd_per_gib_hour,
    cpuUsd,
    memUsd,
    totalUsd: total,
    basis,
    basisNote,
    ...(r.source ? { rateSource: r.source } : {}),
    ...(r.verified_on ? { rateVerifiedOn: r.verified_on } : {}),
    usdPerSandboxHour: perHour,
    usdPer1kSessions: perHour * (SESSION_MINUTES / 60) * 1000,
  };
}

function resolveSize(
  provider: string,
  rate: ProviderRate,
  inputs: CostInputs,
): { vcpus: number; memGib: number; basis: CostBasis; basisNote: string } {
  const env = inputs.environment ?? null;
  const requested = inputs.requested ?? null;

  // A vendor that bills on what you asked for should be costed on what you
  // asked for — Modal charges for a pinned 1-core request even if the guest
  // kernel cheerfully reports 17 CPUs.
  if (requested && inputs.requestHonored && rate.billed_on === 'requested-resources') {
    return {
      vcpus: requested.vcpus,
      memGib: requested.memMib / 1024,
      basis: 'requested',
      basisNote: `${provider} bills the requested size; adapter pinned ${requested.vcpus} vCPU / ${(requested.memMib / 1024).toFixed(1)} GiB`,
    };
  }

  const measuredCpu = effectiveVcpus(env);
  const measuredMem = env?.memGib ?? null;
  if (measuredCpu !== null && measuredMem !== null) {
    return {
      vcpus: measuredCpu,
      memGib: measuredMem,
      basis: 'measured',
      basisNote: `measured inside the sandbox: ${measuredCpu} vCPU${env?.cpuQuota ? ' (cgroup quota)' : ''} / ${measuredMem} GiB cap`,
    };
  }

  // Half-measured is still a guess for the missing half; say so rather than
  // quietly blending a real number with a made-up one.
  if (measuredCpu !== null) {
    return {
      vcpus: measuredCpu,
      memGib: rate.default_mem_gib,
      basis: 'assumed',
      basisNote: `CPU measured (${measuredCpu} vCPU); memory assumed at ${rate.default_mem_gib} GiB — the sandbox reported no memory cap`,
    };
  }

  return {
    vcpus: rate.default_vcpus,
    memGib: rate.default_mem_gib,
    basis: 'assumed',
    basisNote: `pricing.json defaults (${rate.default_vcpus} vCPU / ${rate.default_mem_gib} GiB) — nothing was measured`,
  };
}
