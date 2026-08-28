import type { SandboxProvider } from '../types.js';
import { E2BProvider } from './e2b.js';
import { DaytonaProvider } from './daytona.js';
import { ModalProvider } from './modal.js';
import { LocalProvider } from './local.js';

export const PROVIDER_NAMES = ['e2b', 'modal', 'daytona'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderSlot {
  name: string;
  /** null when the adapter isn't built yet — surfaces as DNS, not a crash. */
  make: (() => SandboxProvider) | null;
  notImplementedReason?: string;
}

const SLOTS: Record<string, ProviderSlot> = {
  e2b: { name: 'e2b', make: () => new E2BProvider() },
  modal: { name: 'modal', make: () => new ModalProvider() },
  daytona: { name: 'daytona', make: () => new DaytonaProvider() },
  // Harness self-test fixture: opt in explicitly with --providers local.
  local: { name: 'local', make: () => new LocalProvider() },
};

export function getSlot(name: string): ProviderSlot | undefined {
  return SLOTS[name.toLowerCase().trim()];
}

export function allProviderNames(): string[] {
  return [...PROVIDER_NAMES];
}

export { E2BProvider, ModalProvider, DaytonaProvider, LocalProvider };
export { StdioSidecar } from './sidecar.js';
