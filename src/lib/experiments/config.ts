// Whether this app's server has A/B tests (GET /api/config → experiments.enabled). Never asked in the claude.ai
// build: there the whole feature is hidden (no buttons, no requests, no assistant tools).

import { useEffect } from 'react';
import { create } from 'zustand';
import { serverBaseNow, useAuth } from '@/lib/cloud/auth';

export interface ExperimentsConfig {
  enabled: boolean;
  /** the server answered */
  reachable: boolean;
}

const OFF: ExperimentsConfig = { enabled: false, reachable: false };
let ask: Promise<ExperimentsConfig> | null = null;

export function experimentsConfig(refresh = false): Promise<ExperimentsConfig> {
  if (__ARTIFACT_BUILD__) return Promise.resolve(OFF);
  if (!ask || refresh) {
    const a: Promise<ExperimentsConfig> = fetch(`${serverBaseNow()}/api/config`, { signal: AbortSignal.timeout(8000) })
      .then(async (res) => {
        const body = res.ok ? ((await res.json().catch(() => null)) as { experiments?: { enabled?: unknown } } | null) : null;
        return { enabled: body?.experiments?.enabled === true, reachable: res.ok || res.status === 404 };
      })
      .catch(() => OFF);
    ask = a;
    void a.then((c) => {
      if (!c.reachable && ask === a) ask = null;
    });
  }
  return ask;
}

/** The last answer, for React (tests set it directly). */
export const useExperimentsConfig = create<{ config: ExperimentsConfig | null }>(() => ({ config: null }));

/** Pure: whether A/B tests show, for a sign-in phase and a config. */
export function experimentsOn(phase: string, config: ExperimentsConfig | null, artifact = __ARTIFACT_BUILD__): boolean {
  if (artifact) return false;
  return phase === 'ready' && config?.enabled === true;
}

/** Whether "Make variations", the A/B tests tab and Trial Reels show here (asks the server's config once when signed in). */
export function useExperimentsOn(): boolean {
  const phase = useAuth((s) => s.phase);
  const config = useExperimentsConfig((s) => s.config);
  useEffect(() => {
    if (__ARTIFACT_BUILD__ || phase !== 'ready' || useExperimentsConfig.getState().config?.reachable) return;
    let live = true;
    void experimentsConfig().then((c) => {
      if (live) useExperimentsConfig.setState({ config: c });
    });
    return () => {
      live = false;
    };
  }, [phase]);
  return experimentsOn(phase, config);
}
