// The tabs a page can be opened on from elsewhere (the assistant, links), with the names people see.
// Settings and Social take theirs through their own fields in useUI (settingsTab,
// socialTab); the other pages through useUI.requestTab + useTabRequest.
import type { Route } from './router';

export const PAGE_TABS = {
  strategy: { plan: 'Plan', research: 'Research', promote: 'Where to promote', content: 'Social content', assets: 'Assets to create', outreach: 'Email outreach', seo: 'SEO page' },
  studio: { structure: 'Structure & outline (Business model for a business)', code: 'Code & assets', publish: 'Listing & publish' },
  'workspace-settings': { brand: 'Brand', ai: 'AI keys', accounts: 'Social accounts', projects: 'Projects & data', prefs: 'Preferences', account: 'Account', domains: 'Domains' },
  'marketing-social': { setup: 'Campaign setup', plan: '30-day plan', batch: '7-day batch', create: 'Create post' },
  'marketing-email': { magnet: 'Lead magnet', sequence: 'Sequence', preview: 'Preview & export', subscribers: 'Subscribers', leads: 'Leads' },
  calendar: { scheduled: 'Planned', published: 'Posted', drafts: 'Drafts' },
  brain: { skills: 'Skills', library: 'Library', docs: 'Knowledge', playground: 'Playground', log: 'Activity' },
  store: { browse: 'Browse', mine: 'My listings' },
} as const satisfies Partial<Record<Route, Record<string, string>>>;

export type TabbedRoute = keyof typeof PAGE_TABS;

/** A page's tab ids ([] for a page without tabs). */
export function tabsOf(route: Route): string[] {
  const t = (PAGE_TABS as Partial<Record<Route, Record<string, string>>>)[route];
  return t ? Object.keys(t) : [];
}

/** The name people see for a page's tab ('' when the page has no such tab). */
export function tabLabel(route: Route, tab: string): string {
  return (PAGE_TABS as Partial<Record<Route, Record<string, string>>>)[route]?.[tab] ?? '';
}
