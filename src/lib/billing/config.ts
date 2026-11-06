// What the server said about plans (GET /api/config → billing: { enabled, enforce }), kept apart from the billing
// store so the start-up code (cloud/auth.ts) can set it without loading the rest. Never set in the artifact build.

import { create } from 'zustand';
import { safeStorage } from '@/lib/storage';

export interface BillingConfig {
  /** Stripe is set up on the server */
  enabled: boolean;
  /** plans are enforced (slots, credits, gating) */
  enforce: boolean;
}

const KEY = 'ylb-billing-config';

function stored(): BillingConfig {
  try {
    const c = JSON.parse(safeStorage.getItem(KEY) || 'null') as Partial<BillingConfig> | null;
    return { enabled: c?.enabled === true, enforce: c?.enforce === true };
  } catch {
    return { enabled: false, enforce: false };
  }
}

export const useBillingConfig = create<BillingConfig>(() => (typeof __ARTIFACT_BUILD__ !== 'undefined' && __ARTIFACT_BUILD__ ? { enabled: false, enforce: false } : stored()));

/** From /api/config (anything else counts as off). */
export function setBillingConfig(raw: unknown): void {
  if (typeof __ARTIFACT_BUILD__ !== 'undefined' && __ARTIFACT_BUILD__) return;
  const b = raw && typeof raw === 'object' ? (raw as Partial<BillingConfig>) : null;
  const next: BillingConfig = { enabled: b?.enabled === true, enforce: b?.enabled === true && b?.enforce === true };
  safeStorage.setItem(KEY, JSON.stringify(next));
  useBillingConfig.setState(next);
}
