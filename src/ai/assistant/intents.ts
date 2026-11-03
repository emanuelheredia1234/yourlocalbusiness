// What the assistant can still do without an AI: open the page a message is about. Also the three
// starter suggestions an empty chat offers, from the state of the workspace.

import type { Route } from '@/lib/router';
import { pageName } from './nav';

export interface PageIntent {
  route: Route;
  tab?: string;
  label: string;
}

/** Most specific first: "AI keys" is Settings → AI, not just Settings. */
const RULES: { re: RegExp; route: Route; tab?: string }[] = [
  { re: /\b(api keys?|ai keys?|ai settings?|my keys?|keys?\b.*\bai|daily limit)/i, route: 'workspace-settings', tab: 'ai' },
  { re: /\b(social accounts?|handles?)\b/i, route: 'workspace-settings', tab: 'accounts' },
  { re: /\b(password|log ?out|sign ?out|delete (my )?account)\b/i, route: 'workspace-settings', tab: 'account' },
  { re: /\b(backup|restore|reset|projects? (&|and) data)\b/i, route: 'workspace-settings', tab: 'projects' },
  { re: /\b(domains?)\b/i, route: 'workspace-settings', tab: 'domains' },
  { re: /\b(brand|logo|colou?rs?|banner)\b/i, route: 'workspace-settings', tab: 'brand' },
  { re: /\b(theme|dark mode|light mode|preferences?)\b/i, route: 'workspace-settings', tab: 'prefs' },
  { re: /\b(drafts?)\b/i, route: 'calendar', tab: 'drafts' },
  { re: /\b(posted|went out)\b/i, route: 'calendar', tab: 'published' },
  { re: /\b(calendar|queue|due|scheduled|planned)\b/i, route: 'calendar' },
  { re: /\b(create|write|new|make)\b.*\bpost\b/i, route: 'marketing-social', tab: 'create' },
  { re: /\b(30-day|plan)\b/i, route: 'marketing-social', tab: 'plan' },
  { re: /\b(batch|social|instagram|facebook|tiktok|linkedin|campaign)\b/i, route: 'marketing-social' },
  { re: /\b(subscribers?)\b/i, route: 'marketing-email', tab: 'subscribers' },
  { re: /\b(lead magnet|opt-?in)\b/i, route: 'marketing-email', tab: 'magnet' },
  { re: /\b(emails?|sequence|newsletter)\b/i, route: 'marketing-email' },
  { re: /\b(seo|sales page|landing page|meta description)\b/i, route: 'marketing-seo' },
  { re: /\b(ads?|advert\w*|budget)\b/i, route: 'marketing-ads' },
  { re: /\b(analytics|stats|numbers|results)\b/i, route: 'analytics' },
  { re: /\b(my listings?)\b/i, route: 'store', tab: 'mine' },
  { re: /\b(marketplace|store)\b/i, route: 'store' },
  { re: /\b(listing|publish)\b/i, route: 'studio', tab: 'publish' },
  { re: /\b(code|widget|calculator|quiz|assets?)\b/i, route: 'studio', tab: 'code' },
  { re: /\b(studio|outline|chapters?|packages?|pdf|workbook)\b/i, route: 'studio', tab: 'structure' },
  { re: /\b(brain|skills?|voice|knowledge)\b/i, route: 'brain' },
  { re: /\b(marketing)\b/i, route: 'marketing' },
  { re: /\b(settings)\b/i, route: 'workspace-settings' },
  { re: /\b(dashboard|home|readiness|next step)\b/i, route: 'dashboard' },
];

/** The page a message is about, if it names one. */
export function matchPageIntent(text: string): PageIntent | null {
  const hit = RULES.find((r) => r.re.test(text));
  return hit ? { route: hit.route, tab: hit.tab, label: pageName(hit.route, hit.tab) } : null;
}

export interface WorkspaceGist {
  name: string;
  due: number;
  posts: number;
  nextStep: string | null;
  plan: boolean;
}

/** Three things to ask an empty chat, from where the workspace is. */
export function starterSuggestions(w: WorkspaceGist | null): string[] {
  if (!w) return ['What can you do?', 'Open my content calendar', 'Show me my brand settings'];
  const out: string[] = [];
  if (w.due) out.push(w.due === 1 ? 'What’s due on my calendar?' : `Which ${w.due} posts are due?`);
  if (w.nextStep) out.push(`What should I do next for ${w.name}?`);
  if (!w.posts) out.push('Help me write my first post');
  else out.push('What’s planned for this week?');
  if (!w.plan) out.push('How do I plan a month of posts?');
  out.push('What can you do?');
  return [...new Set(out)].slice(0, 3);
}

/** What to offer when there's no AI: plain page links. */
export const OFFLINE_SUGGESTIONS: PageIntent[] = [
  { route: 'calendar', label: 'Open the content calendar' },
  { route: 'marketing-social', tab: 'create', label: 'Create a post' },
  { route: 'workspace-settings', tab: 'ai', label: 'Open Settings → AI' },
];
