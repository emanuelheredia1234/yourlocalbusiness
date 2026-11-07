// "Public on the web" (P7), the app's side: what goes to the server (hosted image paths only, never a data URL; no
// email, no coordinates; an offer only when one is attached), the words for every quality key the server can send,
// the server's refusals in its own words, and nothing at all in the claude.ai build.
import { afterEach, describe, expect, it, vi } from 'vitest';
import quality from '../../shared/marketQuality.json';
import { newProject } from '@/store/defaults';
import type { Listing, MediaRef } from './types';
import { buildListing } from './listing';
import { fetchPublicListings, marketConfig, MarketError, MISSING_TEXT, publicImagesFor, publicInput, QUALITY_KEYS, reportListing, setListingPublic, statusLine, submitMarketSitemap, toPublicState, unlistPublic, webOf } from './marketPublic';

const UID = '11111111-2222-4333-8444-555555555555';
const DATA = 'data:image/jpeg;base64,AAAA';
const OFFER = 'abcdefghijklmnopqrstuv';
const STATE = { listingId: 'lst_1', projectId: 'p1', slug: 'cut-and-color-ab12cd', url: 'https://app.example.com/market/cut-and-color-ab12cd', status: 'thin', indexable: false, missing: ['cover', 'tags'], reportCount: 2, publicAt: '2026-11-01T00:00:00Z', contentUpdatedAt: '2026-11-02T00:00:00Z' };

const img = (id: string): MediaRef => ({ id, kind: 'image', name: id, mime: 'image/jpeg', size: 1234, createdAt: 0, thumb: DATA });

function project() {
  const p = newProject('business', 'new');
  p.brand.name = 'Maya Cuts';
  p.brand.websiteUrl = 'https://mayacuts.example.com';
  p.location = { city: 'Austin', region: 'TX', lat: 30.26, lng: -97.74 } as never;
  p.brand.images = [img('cover'), img('g1'), img('g2')];
  p.studio.listing = { ...p.studio.listing, title: 'Cut and color', description: 'x'.repeat(120), tags: ['hair', 'color', 'cut'], contactEmail: 'maya@example.com', phone: '(512) 555-0100', coverImageId: 'cover', galleryIds: ['g1', 'g2'] };
  return p;
}

/** Stand-ins for the browser's image encoder and the upload, counting uploads. */
function deps() {
  let n = 0;
  const uploads: string[] = [];
  return {
    uploads,
    deps: {
      uid: UID,
      read: async () => new Blob(['x']),
      encode: async (b: Blob) => ({ blob: b, name: 'listing.webp' }),
      upload: async () => {
        const path = `${UID}/l-${String(++n).padStart(22, 'A')}.webp`;
        uploads.push(path);
        return { path };
      },
    },
  };
}

function server(answers: Record<string, () => Response>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      calls.push({ method, url: String(url), body: typeof init.body === 'string' ? init.body : undefined });
      const answer = answers[`${method} ${path}`];
      return answer ? answer() : new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
    }),
  );
  return calls;
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Every string anywhere in a value. */
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

afterEach(() => vi.unstubAllGlobals());

describe('the public listing payload', () => {
  it('carries hosted image paths only: no data URL anywhere, even though the in-app listing has them', async () => {
    const p = project();
    const listing: Listing = { ...buildListing(p, undefined, DATA, [DATA, DATA]), gallery: [DATA, DATA] };
    expect(strings(listing).some((s) => s.startsWith('data:'))).toBe(true);
    const { deps: d, uploads } = deps();
    const images = await publicImagesFor(p, { deps: d });
    const input = publicInput(listing, images);
    expect(strings(input).filter((s) => /^\s*data:/i.test(s))).toEqual([]);
    expect(input.coverPath).toBe(uploads[0]);
    expect(input.galleryPaths).toEqual(uploads.slice(1));
  });

  it('leaves out the email and the map coordinates', () => {
    const input = publicInput(buildListing(project()), { galleryPaths: [] });
    const text = JSON.stringify(input);
    expect(text).not.toContain('maya@example.com');
    expect(text).not.toMatch(/lat|lng|30\.26|97\.74/);
    expect(input.location).toEqual({ city: 'Austin', region: 'TX', online: false });
    expect(input.phone).toBe('(512) 555-0100');
    expect(input.website).toBe('https://mayacuts.example.com/');
  });

  it('sends an offer id only when one is attached (and then no typed buy link)', () => {
    const p = project();
    const plain = buildListing(p);
    expect(publicInput({ ...plain, buyUrl: 'https://book.example.com/maya' }, { galleryPaths: [] })).toMatchObject({ buyUrl: 'https://book.example.com/maya' });
    expect(publicInput(plain, { galleryPaths: [] })).not.toHaveProperty('offerId');
    const sold: Listing = { ...plain, buyUrl: `https://app.example.com/b/${OFFER}`, offer: { id: OFFER, provider: 'stripe', checkoutHost: 'checkout.stripe.com' } };
    const input = publicInput(sold, { galleryPaths: [] });
    expect(input.offerId).toBe(OFFER);
    expect(input).not.toHaveProperty('buyUrl');
  });

  it('leaves off links the public page can’t use (http, or not a web address)', () => {
    const l = { ...buildListing(project()), website: 'http://mayacuts.example.com', buyUrl: 'javascript:alert(1)', phone: 'call me' };
    const input = publicInput(l, { galleryPaths: [] });
    expect(input).not.toHaveProperty('website');
    expect(input).not.toHaveProperty('buyUrl');
    expect(input).not.toHaveProperty('phone');
  });

  it('uploads each image once: a cached path is reused, another account’s or fresh: true uploads again', async () => {
    const p = project();
    const first = deps();
    const a = await publicImagesFor(p, { deps: first.deps });
    expect(first.uploads).toHaveLength(3);
    p.studio.listing.webImages = a.cache;
    const again = deps();
    const b = await publicImagesFor(p, { deps: again.deps });
    expect(again.uploads).toHaveLength(0);
    expect(b.coverPath).toBe(a.coverPath);
    const other = deps();
    await publicImagesFor(p, { deps: { ...other.deps, uid: '99999999-2222-4333-8444-555555555555' } });
    expect(other.uploads).toHaveLength(3);
    const fresh = deps();
    await publicImagesFor(p, { fresh: true, deps: fresh.deps });
    expect(fresh.uploads).toHaveLength(3);
  });
});

describe('quality keys and status words', () => {
  it('has a sentence for every key the server can send (shared/marketQuality.json)', () => {
    expect(QUALITY_KEYS).toEqual(quality.keys);
    for (const key of quality.keys) expect(MISSING_TEXT[key], key).toMatch(/\w/);
    expect(MISSING_TEXT.description_length).toContain('200 characters');
  });

  it('says what each status means to the seller', () => {
    const s = toPublicState(STATE)!;
    expect(statusLine(s)?.text).toBe('On the web, not shown on Google yet');
    expect(statusLine({ ...s, status: 'live' })?.text).toBe('On the web');
    expect(statusLine({ ...s, status: 'held' })?.text).toBe('Under review after visitor reports');
    expect(statusLine({ ...s, status: 'hidden', hiddenReason: 'scam' })?.text).toMatch(/^Hidden by Your Local Business: /);
    expect(statusLine({ ...s, status: 'over_limit' })?.text).toBe('Off the web: over your plan’s limit');
    expect(statusLine({ ...s, status: 'unlisted' })).toBeNull();
  });

  it('reads the server’s state defensively', () => {
    expect(toPublicState({ ...STATE, slug: '../x' })).toBeNull();
    expect(toPublicState({ ...STATE, hiddenReason: '<b>' })).not.toHaveProperty('hiddenReason');
    expect(toPublicState({ ...STATE, status: 'weird' })?.status).toBe('unlisted');
  });
});

describe('a shared listing’s web address', () => {
  const origin = 'https://app.example.com';
  it('reads only the slug: the address is always this app’s own /market/<slug>, whatever the seller wrote', () => {
    const own = { slug: 'cut-ab12cd', url: `${origin}/market/cut-ab12cd` };
    expect(webOf({ slug: 'cut-ab12cd', url: `${origin}/market/cut-ab12cd` }, origin)).toEqual(own);
    // an outside address, or this app's under another host (a staging or custom app host): rebuilt from the slug
    expect(webOf({ slug: 'cut-ab12cd', url: 'https://evil.example/market/cut-ab12cd' }, origin)).toEqual(own);
    expect(webOf({ slug: 'cut-ab12cd', url: 'https://staging.example.com/market/cut-ab12cd' }, origin)).toEqual(own);
    expect(webOf({ slug: 'cut-ab12cd' }, origin)).toEqual(own);
    expect(webOf({ slug: 'Bad Slug', url: `${origin}/market/Bad Slug` }, origin)).toBeUndefined();
    expect(webOf({ slug: '../x' }, origin)).toBeUndefined();
    expect(webOf('x', origin)).toBeUndefined();
  });
});

describe('the server calls', () => {
  it('turns on, lists and turns off, with the server’s words for a refusal', async () => {
    const calls = server({
      'PUT /api/market/public/lst_1': json({ listing: STATE }, 201),
      'GET /api/market/public': json({ listings: [STATE], limit: 3, used: 1 }),
      'DELETE /api/market/public/lst_2': json({ ok: true }),
      'PUT /api/market/public/lst_3': json({ error: 'Your plan includes 3 public listings. Upgrade or turn one off.', code: 'LIMIT', used: 3, limit: 3 }, 409),
    });
    const put = await setListingPublic('lst_1', publicInput(buildListing(project()), { galleryPaths: [] }));
    expect(put.created).toBe(true);
    expect(put.listing.missing).toEqual(['cover', 'tags']);
    expect(await fetchPublicListings()).toMatchObject({ limit: 3, used: 1 });
    await unlistPublic('lst_2');
    const refused = await setListingPublic('lst_3', publicInput(buildListing(project()), { galleryPaths: [] })).catch((e) => e);
    expect(refused).toBeInstanceOf(MarketError);
    expect(refused.message).toBe('Your plan includes 3 public listings. Upgrade or turn one off.');
    expect(refused.extra).toMatchObject({ used: 3, limit: 3 });
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'DELETE', 'PUT']);
  });

  it('a report sends the slug, the in-app listing’s seller, the reason and a note of at most 500 characters', async () => {
    const calls = server({ 'POST /api/market/reports': json({ ok: true }) });
    await reportListing('cut-ab12cd', '11111111-2222-4333-8444-555555555555', 'scam', 'n'.repeat(900));
    expect(JSON.parse(calls[0].body!)).toEqual({ slug: 'cut-ab12cd', sellerId: '11111111-2222-4333-8444-555555555555', reason: 'scam', note: 'n'.repeat(500) });
  });
});

describe('the claude.ai build', () => {
  it('makes no request: every call refuses first and the config says off', async () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const calls = server({});
    expect(await marketConfig(true)).toMatchObject({ enabled: false });
    for (const run of [() => fetchPublicListings(), () => unlistPublic('lst_1'), () => reportListing('cut-ab12cd', '11111111-2222-4333-8444-555555555555', 'spam'), () => submitMarketSitemap(), () => publicImagesFor(project(), { deps: deps().deps })]) {
      await expect(run()).rejects.toMatchObject({ code: 'NOT_HERE' });
    }
    expect(calls).toEqual([]);
  });
});
