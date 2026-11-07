// Owner › Public marketplace (P7), drawn with fixed data: the open reports with Hide and Dismiss, held and hidden
// listings with Unhide, the Search Console submit's outcome in words and treg's owner alert; nothing in the claude.ai
// build.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import { alertText, type MarketAdmin } from '@/lib/marketPublic';
import { MarketAdminView, MarketSection, outcomeText, submitResultText } from './MarketSection';

const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
const L1 = { id: '11111111-1111-4111-8111-111111111111', slug: 'cut-ab12cd', title: 'Cut <and> color', seller_name: 'Maya Cuts', status: 'held' };
const DATA: MarketAdmin = {
  reports: [{ id: '22222222-2222-4222-8222-222222222222', reason: 'scam', note: 'Asked me to pay by gift card', from: 'visitor', at: '2026-11-05T10:00:00Z', listing: L1 }],
  held: [{ ...L1, report_count: 3, held_at: '2026-11-05T10:00:00Z' }],
  hidden: [{ id: '33333333-3333-4333-8333-333333333333', slug: 'junk-zz99yy', title: 'Junk', seller_name: 'Spammer', hidden_reason: 'spam', hidden_at: '2026-11-04T10:00:00Z' }],
  submit: { lastAt: '2026-11-06T05:40:00Z', outcome: 'ok', changedSince: true, property: true },
  alert: alertText({ kind: 'team_unavailable', at: '2026-11-06T05:40:00Z' }),
};
const noop = { onHide: () => {}, onDismiss: () => {}, onUnhide: () => {}, onSubmit: () => {} };
const view = (p: Partial<Parameters<typeof MarketAdminView>[0]> = {}) => wrap(createElement(MarketAdminView, { data: DATA, error: null, origin: 'https://yourlocalbusiness.replit.app', busy: false, last: null, actions: noop, ...p }));

afterEach(() => vi.unstubAllGlobals());

describe('Owner › Public marketplace', () => {
  it('the open reports: listing (a link to its page), seller, reason, note, date, with Hide and Dismiss', () => {
    const html = view();
    expect(html).toContain('href="https://yourlocalbusiness.replit.app/market/cut-ab12cd"');
    expect(html).toContain('Cut &lt;and&gt; color');
    expect(html).toContain('Maya Cuts');
    expect(html).toContain('Looks like a scam');
    expect(html).toContain('Asked me to pay by gift card');
    expect(html).toMatch(/>Hide<\/button>/);
    expect(html).toMatch(/>Dismiss<\/button>/);
    expect(view({ data: { ...DATA, reports: [] } })).toContain('No open reports.');
  });

  it('held and hidden listings, each with Unhide', () => {
    const html = view();
    expect(html).toContain('Held after reports');
    expect(html).toContain('Junk');
    expect(html.match(/>Unhide<\/button>/g)).toHaveLength(2);
  });

  it('Search Console: the last submit, whether the market changed, treg’s alert, and the button', () => {
    const html = view();
    expect(html).toContain('Google accepted it.');
    expect(html).toContain('Market changed since then');
    expect(html).toContain('team connection is unavailable');
    expect(html).toContain('Send sitemap to Google');
    expect(outcomeText('unknown', '2026-11-06T05:40:00Z')).toContain('isn’t sent again');
    expect(outcomeText(null, null)).toBe('Not sent yet.');
    expect(submitResultText({ outcome: 'skipped', alreadySubmittedAt: '2026-11-06T05:40:00Z' })).toMatch(/^Skipped: already sent at /);
    expect(view({ last: { outcome: 'skipped', alreadySubmittedAt: '2026-11-06T05:40:00Z' } })).toContain('Skipped: already sent at');
    const off = view({ data: { ...DATA, submit: { ...DATA.submit, property: false } } });
    expect(off).toContain('GSC_APP_PROPERTY isn’t set');
    expect(/<button[^>]*>(?:(?!<\/button>).)*Send sitemap to Google/.exec(off)?.[0]).toContain('disabled');
  });

  it('an error, and nothing in the claude.ai build', () => {
    expect(view({ error: 'Only the app’s owner can see this.' })).toContain('Only the app’s owner can see this.');
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(wrap(createElement(MarketSection))).toBe('');
  });
});
