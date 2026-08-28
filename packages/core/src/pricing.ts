import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CostBreakdown } from './types.js';
import { repoRoot } from './paths.js';

export interface ProviderRate {
  usd_per_vcpu_hour: number;
  usd_per_gib_hour: number;
  default_vcpus: number;
  default_mem_gib: number;
  source?: string;
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

export function computeCost(provider: string, aliveSeconds: number, path?: string): CostBreakdown {
  const r = rateFor(provider, path);
  const hours = aliveSeconds / 3600;
  const cpuUsd = hours * r.default_vcpus * r.usd_per_vcpu_hour;
  const memUsd = hours * r.default_mem_gib * r.usd_per_gib_hour;
  return {
    aliveSeconds,
    vcpus: r.default_vcpus,
    memGib: r.default_mem_gib,
    usdPerVcpuHour: r.usd_per_vcpu_hour,
    usdPerGibHour: r.usd_per_gib_hour,
    cpuUsd,
    memUsd,
    totalUsd: cpuUsd + memUsd,
  };
}
