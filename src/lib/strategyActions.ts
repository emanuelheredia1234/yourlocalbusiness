// "Do it": where each plan action, channel and asset leads. The AI never chooses a route: it picks a kind
// from a fixed list, and the app maps the kind to a target here (a page and tab, the SEO builder with a
// page type, the composer with a topic, or a tab of Strategy itself).
import type { PageType, Project } from './types';
import type { ActionKind, AssetKind, StrategyAction, StrategyAsset, StrategyChannel, StrategyState } from './strategyTypes';
import { ACTION_LABEL, actionDone, derivedDone, type ActionCtx } from './strategy';
import { navigate, type Route } from './router';
import { openPage } from '@/ai/assistant/nav';
import { useUI } from '@/store/ui';

export { ACTION_LABEL, actionDone, type ActionCtx };

/** Where a button goes. */
export type StrategyTarget =
  | { kind: 'page'; route: Route; tab?: string }
  | { kind: 'seo'; pageType: PageType }
  | { kind: 'composer'; topic: string }
  | { kind: 'strategy'; tab: 'promote' | 'content' | 'outreach'; anchor?: string };

/** Each kind's page and tab (the builder, the composer and Strategy's own tabs are handled apart). */
export const ACTION_TARGET: Record<Exclude<ActionKind, 'build_page' | 'write_post' | 'link_settings' | 'outreach' | 'offline'>, { route: Route; tab?: string }> = {
  publish_page: { route: 'marketing-seo' },
  campaign_setup: { route: 'marketing-social', tab: 'setup' },
  plan_30: { route: 'marketing-social', tab: 'plan' },
  batch_7: { route: 'marketing-social', tab: 'batch' },
  calendar: { route: 'calendar', tab: 'scheduled' },
  lead_magnet: { route: 'marketing-email', tab: 'magnet' },
  welcome_emails: { route: 'marketing-email', tab: 'sequence' },
  code_asset: { route: 'studio', tab: 'code' },
  listing: { route: 'studio', tab: 'publish' },
  listing_images: { route: 'studio', tab: 'publish' },
  product_file: { route: 'studio', tab: 'structure' },
  packages: { route: 'studio', tab: 'structure' },
  socials: { route: 'workspace-settings', tab: 'accounts' },
  website: { route: 'workspace-settings', tab: 'brand' },
  brain: { route: 'brain', tab: 'docs' },
  ads: { route: 'marketing-ads' },
};

/** A product file is a product's; on a business the same step is its packages. */
const kindFor = (a: Pick<StrategyAction, 'kind'>, p: Project): ActionKind => (a.kind === 'product_file' && p.track === 'business' ? 'packages' : a.kind);

/** An action's button: its label and target, or null (done outside the app). */
export function actionTarget(a: Pick<StrategyAction, 'kind' | 'pageType' | 'topic' | 'title'>, p: Project, s: StrategyState): { label: string; target: StrategyTarget } | null {
  const kind = kindFor(a, p);
  const label = ACTION_LABEL[kind];
  switch (kind) {
    case 'offline':
      return null;
    case 'build_page':
      return { label, target: { kind: 'seo', pageType: a.pageType ?? s.promote?.page.pageType ?? 'landing' } };
    case 'write_post':
      return { label, target: { kind: 'composer', topic: a.topic || a.title } };
    case 'link_settings':
      return { label, target: { kind: 'strategy', tab: 'promote', anchor: 'strategy-links' } };
    case 'outreach':
      return { label, target: { kind: 'strategy', tab: 'outreach' } };
    default:
      return { label, target: { kind: 'page', ...ACTION_TARGET[kind] } };
  }
}

const scrollTo = (id: string) => {
  // after the tab has rendered
  setTimeout(() => {
    try {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      /* not in a browser */
    }
  }, 120);
};

/** Go where a target points (pages go through the leave guard). */
export async function runTarget(t: StrategyTarget): Promise<void> {
  const ui = useUI.getState();
  if (t.kind === 'seo') return ui.openSeoBuilder({ pageType: t.pageType });
  if (t.kind === 'composer') return ui.openComposer({ topic: t.topic });
  if (t.kind === 'strategy') {
    const ok = await openPage('strategy', t.tab);
    if (ok && t.anchor) scrollTo(t.anchor);
    return;
  }
  if (t.tab) await openPage(t.route, t.tab);
  else await navigate(t.route);
}

/** Whether the app can see an action done (for actions shown outside a plan, like the starter checklist). */
export const actionDoneNow = (a: StrategyAction, p: Project, s: StrategyState, ctx: ActionCtx) => actionDone(a, p, s, ctx);
export { derivedDone };

/** Other marketplaces and platforms: a channel naming one is outside the app, even if it says "marketplace". */
const OTHER_PLATFORM = /\b(facebook|etsy|amazon|ebay|gumroad|shopify|craigslist|nextdoor|google|thumbtack|yelp|angi|taskrabbit|fiverr|upwork|creative market|teachable|udemy|kajabi|payhip|depop|vinted|poshmark|whatnot)\b|\.[a-z]{2,}\b/i;

/** A channel's button, if the app has the tool for it; else it's done outside the app. */
export function channelTarget(c: Pick<StrategyChannel, 'channelType' | 'platform' | 'name'>, s: StrategyState): { label: string; target: StrategyTarget } | { label: ''; hint: string } | null {
  if (c.channelType === 'social' && c.platform && c.platform !== 'youtube') return { label: 'See what to post', target: { kind: 'strategy', tab: 'content' } };
  if (c.channelType === 'email') return { label: 'Open the emails', target: { kind: 'strategy', tab: 'outreach' } };
  if (c.channelType === 'ads') return s.inputs.budget.trim() ? { label: 'Plan an ad', target: { kind: 'page', route: 'marketing-ads' } } : { label: '', hint: 'Set a budget in Your details first.' };
  if (c.channelType === 'marketplace' && /marketplace/i.test(c.name) && !OTHER_PLATFORM.test(c.name)) return { label: 'Open Listing & publish', target: { kind: 'page', route: 'studio', tab: 'publish' } };
  return null;
}

/** An asset's button and whether the app can see it made. */
export function assetTarget(a: Pick<StrategyAsset, 'kind' | 'codeKind' | 'title'>, p: Project, s: StrategyState, ctx: ActionCtx): { button: { label: string; target: StrategyTarget } | null; done: boolean } {
  if (a.kind === 'video') {
    return { button: { label: 'Make a video post', target: { kind: 'page', route: 'marketing-social', tab: 'create' } }, done: ctx.posts.some((x) => x.projectId === p.id && x.format === 'video') };
  }
  const MAP: Partial<Record<AssetKind, ActionKind>> = { page: 'build_page', lead_magnet: 'lead_magnet', emails: 'welcome_emails', code: 'code_asset', listing: 'listing', listing_images: 'listing_images', product_file: 'product_file', packages: 'packages' };
  const kind = MAP[a.kind];
  if (!kind) return { button: null, done: false };
  const action = { kind, title: a.title, codeKind: a.codeKind, pageType: undefined, topic: undefined };
  return { button: actionTarget(action, p, s), done: derivedDone({ kind: kindFor(action, p), codeKind: a.codeKind }, p, s, ctx) };
}
