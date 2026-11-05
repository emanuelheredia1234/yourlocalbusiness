import { useSyncExternalStore } from 'react';

// Plain `#name` routes only (no `#/path`), so links survive inside a claude.ai Artifact.
// Names avoid the host's reserved words (settings, sidebar, customize, upgrade, downloads).
export const ROUTES = [
  'onboarding',
  'dashboard',
  'strategy',
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
  // the owner's per-customer usage (Settings › Billing (owner)); the page checks isAdmin itself
  'admin-billing',
] as const;

export type Route = (typeof ROUTES)[number];

function readHash(): Route | null {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#/, '');
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : null;
}

const listeners = new Set<() => void>();
let current: Route | null = typeof window !== 'undefined' ? readHash() : null;

/** Asked before the page changes: true lets it change (see App: it asks when something is generating). */
type LeaveGuard = (to: Route | null) => boolean | Promise<boolean>;
let guard: LeaveGuard | null = null;
export function setLeaveGuard(g: LeaveGuard | null): void {
  guard = g;
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const next = readHash();
    const ok = next === current || !guard ? true : guard(next);
    if (ok === true) {
      current = next;
      listeners.forEach((l) => l());
      return;
    }
    // Back/Forward or an edited address while something is generating: stay put while we ask
    const back = current;
    try {
      history.replaceState(null, '', back ? `#${back}` : location.pathname + location.search);
    } catch {
      /* ignore */
    }
    void Promise.resolve(ok).then((yes) => {
      if (yes && next) void navigate(next, { force: true });
    });
  });
}

/** Go to a page. Unless forced, the leave guard is asked first; resolves false when the owner stays. */
export function navigate(route: Route, opts: { force?: boolean } = {}): Promise<boolean> {
  if (current === route && location.hash === `#${route}`) return Promise.resolve(true);
  if (!opts.force && guard && current !== route) {
    const ok = guard(route);
    if (ok !== true) return Promise.resolve(ok).then((yes) => (yes ? navigate(route, { force: true }) : false));
  }
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
  return Promise.resolve(true);
}

/** The page showing now, outside React (the assistant reads it; components use useRoute). */
export function currentRoute(): Route | null {
  return current;
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
