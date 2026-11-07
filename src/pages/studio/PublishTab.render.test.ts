// Studio › Listing & publish › "Public on the web" (P7), drawn with fixed data: hidden in the claude.ai build and
// when the server has the market off; the plan's counter; disabled at the limit with the upgrade words; and the status
// lines for a thin, held and hidden listing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import { newProject } from '@/store/defaults';
import { buildListing } from '@/lib/listing';
import { marketOn } from '@/lib/marketConfig';
import type { PublicListingState } from '@/lib/marketPublic';
import { PublicWebToggle, PublicWebView, type PublicWebViewProps } from '@/components/market/PublicWebToggle';

const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
const STATE: PublicListingState = { listingId: 'lst_1', projectId: 'p1', slug: 'cut-ab12cd', url: 'https://yourlocalbusiness.replit.app/market/cut-ab12cd', status: 'live', indexable: true, missing: [], reportCount: 0, publicAt: null, contentUpdatedAt: null };
const view = (p: Partial<PublicWebViewProps> = {}) => wrap(createElement(PublicWebView, { state: undefined, limit: 3, used: 2, plan: 'Launch', marketHost: 'yourlocalbusiness.replit.app/market', busy: false, onToggle: () => {}, ...p }));
const switchOf = (html: string) => /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? '';

afterEach(() => vi.unstubAllGlobals());

describe('Public on the web', () => {
  it('is offered only in the app’s own build, signed in, with the market on', () => {
    const on = { enabled: true, publicUrl: 'https://yourlocalbusiness.replit.app/market', reachable: true };
    expect(marketOn(on, 'ready', false)).toBe(true);
    expect(marketOn(on, 'ready', true)).toBe(false);
    expect(marketOn({ ...on, enabled: false }, 'ready', false)).toBe(false);
    expect(marketOn(null, 'ready', false)).toBe(false);
    expect(marketOn(on, 'signed-out', false)).toBe(false);
    expect(marketOn(on, 'guest', false)).toBe(false);
    // the Studio's toggle draws nothing until the server said it's on (here: not asked yet), nor in the claude.ai build
    const p = newProject('business', 'new');
    const html = () => wrap(createElement(PublicWebToggle, { project: p, listing: buildListing(p) }));
    expect(html()).toBe('');
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(html()).toBe('');
    expect(view()).toContain('Anyone can find this listing on Google at yourlocalbusiness.replit.app/market. Turn it off anytime.');
  });

  it('counts the plan’s public listings, and none for an unlimited plan', () => {
    expect(view()).toContain('Public listings: 2 of 3 on Launch');
    expect(view({ limit: null })).not.toContain('Public listings:');
  });

  it('at the limit: disabled, with the upgrade words and a link to plans', () => {
    const html = view({ used: 3 });
    expect(switchOf(html)).toContain('disabled');
    expect(html).toContain('Your plan includes 3 public listings. Upgrade or turn one off.');
    expect(html).toContain('href="#plans"');
    // a listing already on the web isn't blocked by its own count
    expect(switchOf(view({ used: 3, state: STATE }))).not.toContain('disabled');
  });

  it('live: “On the web” with a View link that opens in a new tab', () => {
    const html = view({ state: STATE });
    expect(html).toContain('On the web');
    expect(html).toContain(`href="${STATE.url}"`);
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('Google picks up new listings on its own schedule');
    expect(html).not.toMatch(/submit/i);
  });

  it('thin: what keeps it off Google, as a checklist', () => {
    const html = view({ state: { ...STATE, status: 'thin', indexable: false, missing: ['description_length', 'cover', 'trial'] } });
    expect(html).toContain('On the web, not shown on Google yet');
    expect(html).toContain('Write at least 200 characters (about 35 words) so Google sees a full page.');
    expect(html).toContain('Choose a cover photo.');
    expect(html).toContain('first paid month');
  });

  it('held and hidden: the review line, and a hidden listing can’t be turned back on', () => {
    expect(view({ state: { ...STATE, status: 'held', reportCount: 3 } })).toContain('Under review after visitor reports');
    const hidden = view({ state: { ...STATE, status: 'hidden', hiddenReason: 'scam' } });
    expect(hidden).toContain('Hidden by Your Local Business: looks like a scam');
    expect(switchOf(hidden)).toContain('disabled');
    expect(view({ state: { ...STATE, status: 'over_limit' } })).toContain('Off the web: over your plan’s limit');
  });
});
