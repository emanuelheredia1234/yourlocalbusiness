// Is the public marketplace (P7) on here, and at which address? GET /api/config → market: { enabled, publicUrl }.
// Kept apart from src/lib/marketPublic.ts so the shared Marketplace (src/lib/community.ts) can check a listing's web
// address without importing the listing builder. Never asked in the claude.ai build.

import { useEffect } from 'react';
import { create } from 'zustand';
import type { Listing } from './types';
import { serverBaseNow, useAuth } from '@/lib/cloud/auth';

export interface MarketConfig {
  enabled: boolean;
  /** <app>/market */
  publicUrl: string | null;
  /** the server answered */
  reachable: boolean;
}

const OFF: MarketConfig = { enabled: false, publicUrl: null, reachable: false };
let configAsk: Promise<MarketConfig> | null = null;

/** The last config answer, for React (null: not asked yet). */
export const useMarketConfig = create<{ config: MarketConfig | null }>(() => ({ config: null }));

/** Whether this app's server has the public marketplace (GET /api/config → market). Never asked in the claude.ai build. */
export function marketConfig(refresh = false): Promise<MarketConfig> {
  if (__ARTIFACT_BUILD__) return Promise.resolve(OFF);
  if (!configAsk || refresh) {
    const ask: Promise<MarketConfig> = fetch(`${serverBaseNow()}/api/config`, { signal: AbortSignal.timeout(8000) })
      .then(async (res) => {
        const body = res.ok ? ((await res.json().catch(() => null)) as { market?: { enabled?: unknown; publicUrl?: unknown } } | null) : null;
        const m = body?.market;
        const url = typeof m?.publicUrl === 'string' && /^https?:\/\/[^/]+\/market$/.test(m.publicUrl) ? m.publicUrl : null;
        return { enabled: m?.enabled === true && !!url, publicUrl: url, reachable: res.ok || res.status === 404 };
      })
      .catch(() => OFF);
    configAsk = ask;
    void ask.then((c) => {
      if (configAsk === ask) useMarketConfig.setState({ config: c });
      if (!c.reachable && configAsk === ask) configAsk = null;
    });
  }
  return configAsk;
}

/** Whether "Public on the web" is offered here: the app's own build, signed in, and the server has it on. */
export function marketOn(config: MarketConfig | null = useMarketConfig.getState().config, phase: string = useAuth.getState().phase, artifact = __ARTIFACT_BUILD__): boolean {
  return !artifact && phase === 'ready' && config?.enabled === true;
}

/** The app's address the public pages live under (https://<app>), from the server's config, else this server's. */
export function marketOrigin(): string {
  const url = useMarketConfig.getState().config?.publicUrl;
  if (url) return url.replace(/\/market$/, '');
  return serverBaseNow() || (typeof location !== 'undefined' ? location.origin : '');
}

/** A public listing's address part (server/market/validate.mjs SLUG_RE). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

/**
 * A shared listing's web address as it came from another seller: only its slug is read (a valid public listing
 * address part), and the address is this app's own /market/<slug>, never what the seller wrote (an outside address,
 * or this app's under another of its hosts). Who owns that page is the server's to check (a report is refused when
 * it isn't the listing's seller's).
 */
export function webOf(raw: unknown, origin = marketOrigin()): Listing['web'] | undefined {
  const w = raw as { slug?: unknown } | null;
  if (!w || typeof w !== 'object' || typeof w.slug !== 'string' || !SLUG_RE.test(w.slug) || !origin) return undefined;
  return { slug: w.slug, url: webUrl(w.slug, origin) };
}

/** A public listing's address on this app (the server's config origin when known). */
export const webUrl = (slug: string, origin = marketOrigin()): string => `${origin}/market/${slug}`;


/** Whether "Public on the web" is offered here (React): asks the server's config once you're signed in. */
export function useMarketOn(): boolean {
  const phase = useAuth((s) => s.phase);
  const config = useMarketConfig((s) => s.config);
  useEffect(() => {
    if (__ARTIFACT_BUILD__ || phase !== 'ready' || useMarketConfig.getState().config?.reachable) return;
    void marketConfig();
  }, [phase]);
  return marketOn(config, phase);
}
