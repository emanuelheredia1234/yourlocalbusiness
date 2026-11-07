// The assistant and "Public on the web" (P7): get_listing says whether the listing has a public page (or that the
// feature isn't here); set_listing_public asks on a card naming the address and Google first, refuses with the
// server's own words (the plan's limit), and isn't offered in the claude.ai build or with the market off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicListingState } from '@/lib/marketPublic';

const api = vi.hoisted(() => ({ fetchPublicListings: vi.fn(), setListingPublic: vi.fn(), unlistPublic: vi.fn(), publicImagesFor: vi.fn() }));
vi.mock('@/lib/marketPublic', async (orig) => ({ ...(await orig<typeof import('@/lib/marketPublic')>()), ...api }));

const { MarketError } = await import('@/lib/marketPublic');
const { useMarketConfig } = await import('@/lib/marketConfig');
const { useAuth } = await import('@/lib/cloud/auth');
const { useMarketPublic } = await import('@/store/marketPublic');
const { useStore } = await import('@/store/useStore');
const { buildListing } = await import('@/lib/listing');
const { answerCard } = await import('@/store/assistant');
const { fakeHost, runTool, seedWorkspace, testChat } = await import('../testing');
const { webToolsFor } = await import('./studio');
const { webListingsHere } = await import('./excluded');
const { TOOL_GROUPS } = await import('.');
const { toolCatalog } = await import('../catalog');

const URL = 'https://yourlocalbusiness.replit.app/market';
const state = (extra: Partial<PublicListingState> = {}): PublicListingState => ({ listingId: 'lst_1', projectId: 'p1', slug: 'copper-kettle-ab12cd', url: `${URL}/copper-kettle-ab12cd`, status: 'live', indexable: true, missing: [], reportCount: 0, publicAt: null, contentUpdatedAt: null, ...extra });

async function pendingCard() {
  let id = '';
  await vi.waitFor(() => {
    const c = testChat().find((m) => m.role === 'card' && m.card?.state === 'pending');
    expect(c).toBeTruthy();
    id = c!.id;
  });
  return testChat().find((m) => m.id === id)!;
}
const marketOn = (on = true) => {
  useAuth.setState({ phase: on ? 'ready' : 'loading' } as never);
  useMarketConfig.setState({ config: on ? { enabled: true, publicUrl: URL, reachable: true } : { enabled: false, publicUrl: null, reachable: true } });
};
function publish() {
  const p = useStore.getState().projects[0];
  const l = { ...buildListing(p), id: 'lst_1' };
  useStore.setState({ myListings: [l] });
  useStore.getState().updateStudio({ publishedListingId: l.id, publishedAt: Date.now() });
  return l;
}

let host: ReturnType<typeof fakeHost>;
beforeEach(() => {
  seedWorkspace();
  for (const f of Object.values(api)) f.mockReset();
  api.fetchPublicListings.mockResolvedValue({ listings: [], limit: 3, used: 1 });
  api.publicImagesFor.mockResolvedValue({ galleryPaths: [], cache: {} });
  useMarketPublic.setState({ byListing: {}, limit: null, used: 0, loaded: false, loading: false, error: null, busy: {} });
  marketOn();
  host = fakeHost();
});
afterEach(() => {
  host.restore();
  marketOn(false);
  useMarketConfig.setState({ config: null });
});

describe('get_listing’s web page', () => {
  it('says whether it’s on the web, with its status, what keeps it off Google, and the plan’s count', async () => {
    publish();
    api.fetchPublicListings.mockResolvedValue({ listings: [state({ status: 'thin', indexable: false, missing: ['cover'] })], limit: 3, used: 1 });
    const r = await runTool('get_listing');
    expect(r.result).toMatchObject({ web: { public: true, url: `${URL}/copper-kettle-ab12cd`, status: 'On the web, not shown on Google yet', indexable: false, missing: ['Choose a cover photo.'], limit: 3, used: 1 } });
  });

  it('with the market off: web is null, with a note', async () => {
    marketOn(false);
    const r = await runTool('get_listing');
    expect(r.result).toMatchObject({ web: null, webNote: 'Public web listings aren’t available here.' });
    expect(api.fetchPublicListings).not.toHaveBeenCalled();
  });
});

describe('set_listing_public', () => {
  it('asks on a card naming the address and Google; nothing goes on the web without a yes', async () => {
    publish();
    const run = runTool('set_listing_public', { on: true });
    const c = await pendingCard();
    expect(c.card?.title).toBe('Put “Copper Kettle” on the web?');
    expect(c.card?.what).toContain(`${URL}/<its name>`);
    expect(c.card?.what).toContain('Google');
    expect(c.card?.confirmLabel).toBe('Put on the web');
    answerCard(c.id, false);
    expect(await run).toMatchObject({ ok: false, status: 'declined' });
    expect(api.setListingPublic).not.toHaveBeenCalled();
  });

  it('on yes, puts it on the web and returns the server’s status and what to add', async () => {
    const l = publish();
    api.setListingPublic.mockResolvedValue({ listing: state({ status: 'thin', indexable: false, missing: ['tags', 'trial'] }), created: true });
    const run = runTool('set_listing_public', { on: true });
    answerCard((await pendingCard()).id, true);
    const r = await run;
    expect(r).toMatchObject({ ok: true, result: { public: true, url: `${URL}/copper-kettle-ab12cd`, status: 'On the web, not shown on Google yet', indexable: false } });
    expect((r.result as { missing: string[] }).missing).toEqual(['Add at least 3 search tags.', expect.stringContaining('first paid month')]);
    expect(api.setListingPublic).toHaveBeenCalledWith('lst_1', expect.objectContaining({ title: l.title, galleryPaths: [] }));
    // the in-app listing keeps its web address
    expect(useStore.getState().myListings[0].web).toEqual({ slug: 'copper-kettle-ab12cd', url: `${URL}/copper-kettle-ab12cd` });
  });

  it('refuses with the server’s own words: the plan’s limit', async () => {
    publish();
    api.setListingPublic.mockRejectedValue(new MarketError('Your plan includes 3 public listings. Upgrade or turn one off.', 'LIMIT', 409, { used: 3, limit: 3 }));
    const run = runTool('set_listing_public', { on: true });
    answerCard((await pendingCard()).id, true);
    expect(await run).toMatchObject({ ok: false, error: 'Your plan includes 3 public listings. Upgrade or turn one off.' });
    // at the limit now: the next ask is refused before any card
    expect(await runTool('set_listing_public', { on: true })).toMatchObject({ ok: false, error: 'Your plan includes 3 public listings. Upgrade or turn one off.' });
  });

  it('refuses before a card: not published, already on, hidden by the owner, or the market off', async () => {
    expect((await runTool('set_listing_public', { on: true })).error).toMatch(/isn’t published yet/);
    publish();
    api.fetchPublicListings.mockResolvedValue({ listings: [state()], limit: 3, used: 1 });
    useMarketPublic.setState({ loaded: false });
    expect((await runTool('set_listing_public', { on: true })).error).toMatch(/already on the web/);
    useMarketPublic.setState({ byListing: { lst_1: state({ status: 'hidden', hiddenReason: 'spam' }) } });
    expect((await runTool('set_listing_public', { on: false })).error).toMatch(/hid this listing/);
    marketOn(false);
    expect((await runTool('set_listing_public', { on: true })).error).toMatch(/aren’t available here/);
    expect(testChat().some((m) => m.role === 'card')).toBe(false);
  });

  it('off: a card, then the page comes down', async () => {
    publish();
    api.fetchPublicListings.mockResolvedValue({ listings: [state()], limit: 3, used: 1 });
    api.unlistPublic.mockResolvedValue(undefined);
    const run = runTool('set_listing_public', { on: false });
    const c = await pendingCard();
    expect(c.card?.what).toContain('stops working');
    answerCard(c.id, true);
    expect(await run).toMatchObject({ ok: true, result: { public: false } });
    expect(api.unlistPublic).toHaveBeenCalledWith('lst_1');
  });
});

describe('where the web tools are offered', () => {
  it('a group of its own, listed only with the market on; none of it in the claude.ai build', () => {
    expect(webToolsFor(false).map((t) => t.name)).toEqual(['set_listing_public', 'moderate_market']);
    expect(webToolsFor(true)).toEqual([]);
    expect(webListingsHere).toMatchObject({ name: 'set_listing_public', class: 'X' });
    expect(webListingsHere.class === 'X' && webListingsHere.refusal.text).toContain('need the app’s server');
    expect(toolCatalog(TOOL_GROUPS, { route: 'studio', message: 'hello' }).full).toContain('- set_listing_public(on: bool)');
    marketOn(false);
    expect(toolCatalog(TOOL_GROUPS, { route: 'studio', message: 'hello' }).full).not.toContain('set_listing_public');
  });

  it('moderation is the app owner’s page: refused, and the admin page opens', async () => {
    const r = await runTool('moderate_market');
    expect(r).toMatchObject({ ok: false, status: 'refused' });
    expect(host.calls.pages).toEqual([['admin-billing', undefined]]);
  });
});
