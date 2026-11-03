// Moving around the app for the assistant: pages (with a tab where the page has one) and projects.
// Both go through the leave guard, so something generating on the page is never dropped without asking.

import { ROUTES, currentRoute, navigate, type Route } from '@/lib/router';
import { tabLabel, tabsOf } from '@/lib/pageTabs';
import { useStore } from '@/store/useStore';
import { useUI, type SocialTab } from '@/store/ui';
import { confirmLeave } from '@/components/ui/leave';

/** Pages the assistant can open (onboarding opens by itself for a project still being set up). */
export const OPENABLE_ROUTES = ROUTES.filter((r) => r !== 'onboarding') as Exclude<Route, 'onboarding'>[];

/** What people call each page. */
export const PAGE_LABELS: Record<Route, string> = {
  onboarding: 'Setup',
  dashboard: 'Dashboard',
  studio: 'Studio',
  marketing: 'Marketing Hub',
  'marketing-seo': 'SEO sales page',
  'marketing-email': 'Email funnel',
  'marketing-social': 'Social media engine',
  'marketing-ads': 'Paid ads',
  calendar: 'Content calendar',
  analytics: 'Analytics',
  store: 'Marketplace',
  brain: 'Brain',
  'workspace-settings': 'Settings',
};

/** "Settings → AI", "Content calendar". */
export function pageName(route: Route, tab?: string): string {
  const t = tab ? tabLabel(route, tab) : '';
  return t ? `${PAGE_LABELS[route]} → ${t}` : PAGE_LABELS[route];
}

/** Why a tab can't be opened on a page ('' when it can). */
export function tabProblem(route: Route, tab: string | undefined): string {
  if (!tab) return '';
  const tabs = tabsOf(route);
  if (!tabs.length) return `${PAGE_LABELS[route]} has no tabs.`;
  return tabs.includes(tab) ? '' : `${PAGE_LABELS[route]} has these tabs: ${tabs.join(', ')}.`;
}

/** Ask the page for a tab (after it's open: a refused page change must not leave a request behind). */
function requestTab(route: Route, tab: string) {
  const ui = useUI.getState();
  if (route === 'workspace-settings') ui.setSettingsTab(tab);
  else if (route === 'marketing-social') ui.setSocialTab(tab as SocialTab);
  else ui.requestTab(route, tab);
}

/** Open a page, on a tab when given. False when the owner chose to stay (something was generating). */
export async function openPage(route: Route, tab?: string): Promise<boolean> {
  const ok = currentRoute() === route ? true : await navigate(route);
  if (!ok) return false;
  if (tab && !tabProblem(route, tab)) requestTab(route, tab);
  return true;
}

/** Switch to another project, as the project menu does (asks first when something would stop). */
export async function switchProject(id: string): Promise<'switched' | 'stayed' | 'missing'> {
  const s = useStore.getState();
  const p = s.projects.find((x) => x.id === id);
  if (!p) return 'missing';
  if (p.id === s.activeProjectId) return 'switched';
  if (!(await confirmLeave())) return 'stayed';
  useStore.getState().setActiveProject(p.id);
  void navigate(p.onboarded ? 'dashboard' : 'onboarding', { force: true });
  return 'switched';
}
