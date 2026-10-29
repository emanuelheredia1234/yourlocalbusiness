import { useSyncExternalStore } from 'react';

// Plain `#name` routes only (no `#/path`), so links survive inside a claude.ai Artifact.
// Names avoid the host's reserved words (settings, sidebar, customize, upgrade, downloads).
export const ROUTES = [
  'onboarding',
  'dashboard',
  'studio',
  'marketing',
  'marketing-seo',
  'marketing-email',
  'marketing-social',
  'marketing-ads',
  'calendar',
  'analytics',
  'store',
  'brain',
  'workspace-settings',
] as const;

export type Route = (typeof ROUTES)[number];

function readHash(): Route | null {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#/, '');
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : null;
}

const listeners = new Set<() => void>();
let current: Route | null = typeof window !== 'undefined' ? readHash() : null;

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = readHash();
    listeners.forEach((l) => l());
  });
}

export function navigate(route: Route): void {
  if (current === route && location.hash === `#${route}`) return;
  current = route;
  try {
    if (location.hash !== `#${route}`) location.hash = route;
  } catch {
    /* some frames refuse hash writes; in-memory route still updates */
  }
  listeners.forEach((l) => l());
  try {
    document.getElementById('main-scroll')?.scrollTo({ top: 0 });
  } catch {
    /* ignore */
  }
}

export function useRoute(): Route | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

export const CHANNEL_ROUTES = {
  seo: 'marketing-seo',
  email: 'marketing-email',
  social: 'marketing-social',
  ads: 'marketing-ads',
} as const;
