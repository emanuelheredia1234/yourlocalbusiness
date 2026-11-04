// The built-in engine's fixed choices for Strategy: which page to build first, where each network's link
// goes, the starting post mix and the four weeks. Pure, with no imports from the normalizers, so both the
// normalizers (src/lib/strategyNormalize.ts, for fallbacks) and the built-in engine (./strategy.ts, which
// re-exports these) can use them without an import cycle. Labelled "Built-in guidance": never research.
import type { CampaignConfig, CodeKind, LeadMagnetType, PageType, PostPlatform, PostType, Project } from '@/lib/types';
import type { ActionKind, AssetKind, StrategyLinkRec, StrategyPageRec } from '@/lib/strategyTypes';
import { paymentLink } from '@/lib/pageTypes';
import { DEFAULT_LINK_PLACEMENT } from '@/lib/pageLink';
import { matchBusinessType } from '../knowledge';
import { CODE_KINDS } from './code';

/** Why each page type, in a sentence (the built-in recommendation and its second choice). */
export const PAGE_WHY: Record<PageType, string> = {
  booking: 'People can pick a time and book with your own booking link, straight from a post.',
  lead: 'A short form collects names and emails, so you can follow up.',
  showcase: 'It shows what you sell, with prices or “Ask for a quote”, each with its own button.',
  checkout: 'One offer, its price and a Buy button that opens your own payment link.',
  landing: 'One offer and one call to action: the simplest page to link from posts.',
  website: 'A one-page site with Home, Services, About and Contact, for people who want to know more first.',
};

/** The page to build first, from the track, the price and how people book or buy (basis 'builtin'). */
export function recommendPageType(p: Project): StrategyPageRec {
  const rec = (pageType: PageType, secondType: PageType): StrategyPageRec => ({ basis: 'builtin', pageType, why: PAGE_WHY[pageType], secondType, secondWhy: PAGE_WHY[secondType] });
  if (p.track === 'product') {
    if (p.studio.price > 0) return paymentLink(p) ? rec('checkout', 'landing') : rec('landing', 'checkout');
    return rec('lead', 'landing');
  }
  const bt = matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`);
  if (bt.booking === 'book') return rec('booking', 'lead');
  if (bt.booking === 'buy') return rec('showcase', 'checkout');
  return rec('lead', 'showcase');
}

const LINK_WHY: Record<PostPlatform, string> = {
  instagram: 'Links in Instagram captions aren’t clickable, so posts point to the link in your bio.',
  tiktok: 'Links in TikTok captions aren’t clickable, so posts point to the link in your bio.',
  facebook: 'Facebook shows links in posts as clickable links.',
  linkedin: 'LinkedIn shows links in posts as clickable links.',
  x: 'X shows links in posts as clickable links; keep the post short.',
};

/** Where a network's link goes when nothing better is known (the same defaults the posts use). */
export function defaultLinkPlacement(net: PostPlatform): StrategyLinkRec {
  return { basis: 'builtin', placement: DEFAULT_LINK_PLACEMENT[net], why: LINK_WHY[net] };
}

/** A balanced starting mix (weights 0-3, as Campaign setup uses). */
export const BUILTIN_MIX: Record<PostType, 0 | 1 | 2 | 3> = { educational: 2, tip: 3, question: 1, sales: 1, bts: 2 };

/** The built-in plan's four weeks. */
export const BUILTIN_WEEKS: { week: 1 | 2 | 3 | 4; focus: string; goal: string }[] = [
  { week: 1, focus: 'Get ready', goal: 'Your page and link are ready to share.' },
  { week: 2, focus: 'Launch', goal: 'Your first posts and messages are out.' },
  { week: 3, focus: 'Show up', goal: 'You post at a steady pace.' },
  { week: 4, focus: 'Follow up', goal: 'You follow up and keep what works.' },
];

/** A campaign goal from the page type: pages that collect people get leads, pages that sell make sales. */
export const goalForPage = (t: PageType): CampaignConfig['goal'] => (t === 'checkout' || t === 'showcase' ? 'sales' : 'leads');

/** The SEO page's call to action from its type (a landing page sells when there's a price). */
export function ctaForPage(t: PageType, hasPrice: boolean): 'book' | 'buy' | 'contact' | 'join' | 'download' {
  if (t === 'booking') return 'book';
  if (t === 'checkout' || t === 'showcase') return 'buy';
  if (t === 'lead' || t === 'website') return 'contact';
  return hasPrice ? 'buy' : 'download';
}

/** Code assets Strategy may suggest: never testimonials or a countdown (they need real reviews or a real end date), and no booking widget for a product. */
export function allowedCodeKinds(track: Project['track']): CodeKind[] {
  return CODE_KINDS.map((k) => k.id).filter((id) => id !== 'testimonials' && id !== 'countdown' && !(track === 'product' && id === 'booking'));
}

export const ACTION_KINDS: ActionKind[] = [
  'build_page',
  'publish_page',
  'link_settings',
  'campaign_setup',
  'plan_30',
  'batch_7',
  'write_post',
  'calendar',
  'lead_magnet',
  'welcome_emails',
  'outreach',
  'code_asset',
  'listing',
  'listing_images',
  'product_file',
  'packages',
  'socials',
  'website',
  'brain',
  'ads',
  'offline',
];
export const ASSET_KINDS: AssetKind[] = ['page', 'lead_magnet', 'emails', 'code', 'listing', 'listing_images', 'video', 'product_file', 'packages', 'other'];
export const LEAD_MAGNET_KINDS: LeadMagnetType[] = ['checklist', 'guide', 'cheatsheet', 'template', 'swipe', 'workbook'];
