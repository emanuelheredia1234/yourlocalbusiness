// Is the morning action on here, and which kind? `server`: the app's server makes each business's action (signed in,
// GET /api/config says morning.enabled). `local`: the claude.ai build, or accounts off / carrying on as a guest: a
// rule-based action made in this browser with no request (src/lib/morning/local.ts). `off`: no card (loading, signed
// out, the server turned it off or can't be reached).

import { useEffect } from 'react';
import { create } from 'zustand';
import { serverBaseNow, useAuth } from '@/lib/cloud/auth';

export interface MorningConfig {
  enabled: boolean;
  /** the server answered */
  reachable: boolean;
}

const OFF: MorningConfig = { enabled: false, reachable: false };
let ask: Promise<MorningConfig> | null = null;

/** Whether this app's server has the morning action (GET /api/config → morning). Never asked in the claude.ai build. */
export function morningConfig(refresh = false): Promise<MorningConfig> {
  if (__ARTIFACT_BUILD__) return Promise.resolve(OFF);
  if (!ask || refresh) {
    const a: Promise<MorningConfig> = fetch(`${serverBaseNow()}/api/config`, { signal: AbortSignal.timeout(8000) })
      .then(async (res) => {
        const body = res.ok ? ((await res.json().catch(() => null)) as { morning?: { enabled?: unknown } } | null) : null;
        return { enabled: body?.morning?.enabled === true, reachable: res.ok || res.status === 404 };
      })
      .catch(() => OFF);
    ask = a;
    // an unreachable server is asked again next time
    void a.then((c) => {
      if (!c.reachable && ask === a) ask = null;
    });
  }
  return ask;
}

/** The last answer, for React. */
export const useMorningConfig = create<{ config: MorningConfig | null }>(() => ({ config: null }));

export type MorningMode = 'server' | 'local' | 'off';

/** The mode for a phase and a config (pure: the hook below and tests use it). */
export function morningModeOf(phase: string, config: MorningConfig | null, artifact = __ARTIFACT_BUILD__): MorningMode {
  if (artifact) return 'local';
  if (phase === 'off' || phase === 'guest') return 'local';
  if (phase === 'ready' && config?.enabled) return 'server';
  return 'off';
}

/** The morning action's mode here, asking the server's config once when signed in. */
export function useMorningMode(): MorningMode {
  const phase = useAuth((s) => s.phase);
  const config = useMorningConfig((s) => s.config);
  useEffect(() => {
    if (__ARTIFACT_BUILD__ || phase !== 'ready' || useMorningConfig.getState().config?.reachable) return;
    let live = true;
    void morningConfig().then((c) => {
      if (live) useMorningConfig.setState({ config: c });
    });
    return () => {
      live = false;
    };
  }, [phase]);
  return morningModeOf(phase, config);
}
