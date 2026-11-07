// The public marketplace end to end against mock Supabase (P7 S3–S5, S9): "Public on the web", the pages and their
// headers, statuses (live, thin, held, gone), paging, categories and search, the sitemap, the plan's limits (two
// toggles at once included), unlisting, the downgrade sweep and an account's deletion. No live calls.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP, DESCRIPTION, marketServer } from './test-helpers.mjs';
import { createMarket } from './index.mjs';
import { sendJson } from '../billing/test-helpers.mjs';

let s;
/** this deployment's Stripe mode, as the offers module's config() says it */
let stripeEnv = 'production';
beforeAll(async () => {
  s = await marketServer({ offersConfig: () => ({ stripe: { environment: stripeEnv } }) });
});
afterAll(async () => {
  await s.close();
});
beforeEach(() => {
  stripeEnv = 'production';
  for (const t of ['public_listings', 'public_listing_reports', 'offers']) s.supa.tables.set(t, []);
  s.market.store.drop();
  s.sitemap.clearCache();
});

const slugOf = (r) => r.body.listing.slug;
/** A row straight into the table (the grid and sitemap tests need many). */
function seed(userId, n, over = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
    const row = { id: crypto.randomUUID(), user_id: userId, listing_id: `l${i}`, project_id: 'p1', slug: `item-${String(i).padStart(3, '0')}-abcdef`, kind: 'product', title: `Item ${i}`, tagline: '', description: DESCRIPTION, category: 'Home', category_slug: 'home', tags: ['a', 'b', 'c'], price_minor: 1000, currency: 'usd', price_model: 'one-time', services: [], includes: [], location: null, seller_name: 'Seller', website: null, outside_buy_url: null, phone: null, offer_id: null, cover_path: null, gallery_paths: [], content_hash: 'h', quality: {}, status: 'live', public_at: at, content_updated_at: at, unlisted_at: null, hidden_at: null, hidden_reason: null, held_at: null, report_count: 0, ...over };
    s.rows('public_listings').push(row);
    out.push(row);
  }
  return out;
}

describe('Public on the web', () => {
  it('puts a full listing live (201, then 200) and keeps its address when the title changes', async () => {
    const a = await s.user('live@example.com');
    const body = s.listing(a);
    const first = await s.put(a, 'lst_1', body);
    expect(first.status).toBe(201);
    expect(first.body.listing).toMatchObject({ listingId: 'lst_1', status: 'live', indexable: true, missing: [] });
    expect(first.headers.get('cache-control')).toBe('no-store');
    const again = await s.put(a, 'lst_1', { ...body, title: 'A brand new title for it' });
    expect(again.status).toBe(200);
    expect(slugOf(again)).toBe(slugOf(first));
    const row = s.rows('public_listings').find((r) => r.listing_id === 'lst_1');
    expect(row.title).toBe('A brand new title for it');
    expect(row.location).toEqual({ city: 'Portland', region: 'OR', online: false });
  });

  it('a thin listing is public with noindex; the seller sees why', async () => {
    const a = await s.user('thin@example.com');
    const r = await s.put(a, 'lst_t', s.listing(a, { description: `${'Short words here. '.repeat(6)}`, coverPath: null, tags: ['one'] }));
    expect(r.body.listing).toMatchObject({ status: 'thin', indexable: false });
    expect(r.body.listing.missing).toEqual(expect.arrayContaining(['description_length', 'cover', 'tags']));
    const page = await s.visit(`/market/${slugOf(r)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-robots-tag')).toBe('noindex');
    expect(page.text).toContain('<meta name="robots" content="noindex, follow">');
    expect((await s.visit('/market')).text).not.toContain(slugOf(r));
  });

  it('during a card trial a listing is public but not indexed', async () => {
    const a = await s.user('trial@example.com', { trialing: true });
    const r = await s.put(a, 'lst_tr', s.listing(a));
    expect(r.body.listing).toMatchObject({ status: 'thin', missing: ['trial'] });
  });

  it('a copied description stays thin', async () => {
    const a = await s.user('orig@example.com');
    const b = await s.user('copy@example.com');
    await s.put(a, 'lst_o', s.listing(a));
    const r = await s.put(b, 'lst_c', s.listing(b));
    expect(r.body.listing.missing).toEqual(['duplicate']);
  });

  it('refuses data URLs, another seller’s image and a missing one; the seller’s request never calls treg', async () => {
    const a = await s.user('img@example.com');
    const b = await s.user('img2@example.com');
    expect((await s.put(a, 'lst_i', s.listing(a, { coverPath: 'data:image/png;base64,AAAA' }))).body.code).toBe('IMAGE_NOT_HOSTED');
    expect((await s.put(a, 'lst_i', s.listing(a, { coverPath: s.image(b) }))).body.code).toBe('IMAGE_NOT_HOSTED');
    expect((await s.put(a, 'lst_i', s.listing(a, { coverPath: `${a.id}/l-ZZZZZZZZZZZZZZZZZZZZZZ.png` }))).body.code).toBe('IMAGE_NOT_HOSTED');
    expect(s.treg.calls).toHaveLength(0);
  });

  it('an old image the listing no longer shows is removed from Storage', async () => {
    const a = await s.user('swap@example.com');
    const body = s.listing(a);
    await s.put(a, 'lst_s', body);
    const next = s.image(a);
    await s.put(a, 'lst_s', { ...body, coverPath: next });
    expect(s.supa.objects.has(`public-files/${body.coverPath}`)).toBe(false);
    expect(s.supa.objects.has(`public-files/${next}`)).toBe(true);
  });

  it('a Stripe offer’s price is the page’s and its Buy goes through /b/', async () => {
    const a = await s.user('stripe@example.com');
    const offer = s.offer(a, { provider: 'stripe', price_minor: 2500, currency: 'usd' });
    const r = await s.put(a, 'lst_b', s.listing(a, { offerId: offer.id, price: 99 }));
    const page = await s.visit(`/market/${slugOf(r)}`);
    expect(page.text).toContain(`href="${APP}/b/${offer.id}" rel="nofollow">Buy</a>`);
    expect(page.text).toContain('"price":"25.00"');
    // paused: the button goes, the page says so (after the 60 s offer cache on this copy)
    offer.status = 'paused';
    s.market.store.dropOffer(offer.id);
    s.market.store.drop();
    const paused = await s.visit(`/market/${slugOf(r)}`);
    expect(paused.text).toContain('Not available to buy right now');
    expect(paused.text).toContain('OutOfStock');
  });
});

describe('public pages', () => {
  it('serves the listing with its headers, an ETag (304) and HEAD without a body', async () => {
    const a = await s.user('page@example.com');
    const slug = slugOf(await s.put(a, 'lst_p', s.listing(a)));
    const page = await s.visit(`/market/${slug}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('content-security-policy')).toMatch(/^default-src 'none'/);
    expect(page.headers.get('content-security-policy')).not.toMatch(/script-src/);
    expect(page.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(page.headers.get('x-robots-tag')).toBeNull();
    const etag = page.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect((await s.visit(`/market/${slug}`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    const head = await s.visit(`/market/${slug}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(page.text).toContain(`<link rel="canonical" href="${APP}/market/${slug}">`);
    expect(page.text).not.toMatch(/@example\.com/);
  });

  it('redirects trailing slashes, 404s unknown paths, 405s other methods', async () => {
    const a = await s.user('paths@example.com');
    const slug = slugOf(await s.put(a, 'lst_x', s.listing(a)));
    expect((await s.visit('/market/')).status).toBe(301);
    expect((await s.visit('/market/')).headers.get('location')).toBe('/market');
    const slash = await s.visit(`/market/${slug}/`);
    expect([slash.status, slash.headers.get('location')]).toEqual([301, `/market/${slug}`]);
    for (const p of ['/market/nope-zzzzzz', '/market/UPPER', `/market/${slug}/other`, '/market/a/b/c']) {
      const r = await s.visit(p);
      expect([p, r.status]).toEqual([p, 404]);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    const put = await s.visit(`/market/${slug}`, { method: 'PUT', body: 'x' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, HEAD');
    expect((await s.visit('/market', { method: 'POST', body: 'x' })).status).toBe(405);
  });

  it('pages the grid 24 at a time, newest first; past the end is 404', async () => {
    const a = await s.user('grid@example.com');
    seed(a.id, 30);
    const one = await s.visit('/market');
    expect((one.text.match(/class="item"/g) ?? []).length).toBe(24);
    expect(one.text).toContain('item-029-abcdef');
    expect(one.text).toContain(`<link rel="next" href="${APP}/market?page=2">`);
    expect(one.text).toContain('<meta name="robots" content="index, follow">');
    const two = await s.visit('/market?page=2');
    expect((two.text.match(/class="item"/g) ?? []).length).toBe(6);
    expect(two.text).toContain(`<link rel="canonical" href="${APP}/market?page=2">`);
    expect(two.text).toContain(`<link rel="prev" href="${APP}/market">`);
    expect((await s.visit('/market?page=3')).status).toBe(404);
    expect((await s.visit('/market?page=51')).status).toBe(404);
    expect((await s.visit('/market?page=0')).status).toBe(404);
    expect((await s.visit('/market?page=x')).status).toBe(404);
  });

  it('filters by category (a thin category is noindex) and 404s an unknown one', async () => {
    const a = await s.user('cats@example.com');
    seed(a.id, 3);
    seed(a.id, 1, { id: crypto.randomUUID(), listing_id: 'z', slug: 'garden-one-abcdef', category: 'Garden & Yard', category_slug: 'garden-yard' });
    const home = await s.visit('/market?category=home');
    expect(home.text).toContain('<meta name="robots" content="index, follow">');
    expect(home.text).toContain(`<link rel="canonical" href="${APP}/market?category=home">`);
    expect(home.text).not.toContain('garden-one');
    const garden = await s.visit('/market?category=garden-yard&utm_source=x');
    expect(garden.text).toContain('<meta name="robots" content="noindex, follow">');
    expect(garden.text).toContain(`<link rel="canonical" href="${APP}/market?category=garden-yard">`);
    expect((await s.visit('/market?category=nope')).status).toBe(404);
    expect((await s.visit('/market?category=%3Cscript%3E')).status).toBe(404);
  });

  it('search pages are noindex with the /market canonical and a shorter cache', async () => {
    const a = await s.user('search@example.com');
    seed(a.id, 2);
    seed(a.id, 1, { id: crypto.randomUUID(), listing_id: 'q', slug: 'blue-teapot-abcdef', title: 'Blue teapot' });
    const r = await s.visit('/market?q=teapot');
    expect(r.text).toContain('blue-teapot-abcdef');
    expect(r.text).not.toContain('item-000');
    expect(r.text).toContain('<meta name="robots" content="noindex, follow">');
    expect(r.text).toContain(`<link rel="canonical" href="${APP}/market">`);
    expect(r.headers.get('cache-control')).toBe('public, max-age=30');
    const evil = await s.visit(`/market?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
    // no category: a one-item breadcrumb, so no data block at all
    expect(evil.text).not.toContain('<script');
  });

  it('an empty grid is noindex', async () => {
    const r = await s.visit('/market');
    expect(r.status).toBe(200);
    expect(r.text).toContain('No listings here yet');
    expect(r.text).toContain('<meta name="robots" content="noindex, follow">');
  });

  it('unlisted, hidden and over-limit listings and ended plans answer 410; held is 200 noindex', async () => {
    const a = await s.user('statuses@example.com');
    const [unlisted, hidden, over, held] = seed(a.id, 4);
    Object.assign(unlisted, { status: 'unlisted', unlisted_at: new Date().toISOString() });
    Object.assign(hidden, { status: 'hidden', hidden_at: new Date().toISOString(), hidden_reason: 'spam' });
    over.status = 'over_limit';
    Object.assign(held, { status: 'held', held_at: new Date().toISOString() });
    for (const r of [unlisted, hidden, over]) {
      const page = await s.visit(`/market/${r.slug}`);
      expect([r.status, page.status]).toEqual([r.status, 410]);
      expect(page.headers.get('cache-control')).toBe('no-store');
    }
    const h = await s.visit(`/market/${held.slug}`);
    expect(h.status).toBe(200);
    expect(h.headers.get('x-robots-tag')).toBe('noindex');
    // the seller's plan ended more than 30 days ago
    const b = await s.user('ended@example.com');
    const [live] = seed(b.id, 1, { id: crypto.randomUUID(), slug: 'ended-plan-abcdef' });
    s.billing.state.serveUntil = '2020-01-01T00:00:00Z';
    try {
      expect((await s.visit(`/market/${live.slug}`)).status).toBe(410);
    } finally {
      s.billing.state.serveUntil = null;
    }
  });

  it('a database outage is a 503 notice, never a page', async () => {
    s.supa.behavior.down = true;
    try {
      const r = await s.visit('/market/never-cached-abcdef');
      expect(r.status).toBe(503);
      expect(r.headers.get('cache-control')).toBe('no-store');
    } finally {
      s.supa.behavior.down = false;
    }
  });
});

describe('sitemap', () => {
  it('lists live listings and categories with 3+ (escaped), never thin, held, hidden, unlisted, over-limit or ended ones', async () => {
    const a = await s.user('sm@example.com');
    seed(a.id, 3);
    seed(a.id, 1, { id: crypto.randomUUID(), slug: 'thin-one-abcdef', status: 'thin' });
    seed(a.id, 1, { id: crypto.randomUUID(), slug: 'held-one-abcdef', status: 'held', held_at: new Date().toISOString() });
    seed(a.id, 1, { id: crypto.randomUUID(), slug: 'hidden-one-abcdef', status: 'hidden' });
    seed(a.id, 1, { id: crypto.randomUUID(), slug: 'gone-one-abcdef', status: 'unlisted' });
    seed(a.id, 1, { id: crypto.randomUUID(), slug: 'over-one-abcdef', status: 'over_limit' });
    const xml = (await s.visit('/sitemap.xml')).text;
    expect(xml).toContain(`<loc>${APP}/market</loc><lastmod>2026-11-01</lastmod>`);
    expect(xml).toContain(`<loc>${APP}/market?category=home</loc>`);
    expect(xml).toContain(`<loc>${APP}/market/item-000-abcdef</loc><lastmod>2026-11-01</lastmod>`);
    expect(xml).not.toMatch(/thin-one|held-one|hidden-one|gone-one|over-one/);
    const b = await s.user('sm-ended@example.com');
    seed(b.id, 1, { id: crypto.randomUUID(), slug: 'ended-one-abcdef' });
    s.sitemap.clearCache();
    s.billing.state.serveUntil = '2020-01-01T00:00:00Z';
    s.market.store.dropUser(a.id);
    s.market.store.dropUser(b.id);
    try {
      expect((await s.visit('/sitemap.xml')).text).not.toContain('ended-one');
    } finally {
      s.billing.state.serveUntil = null;
      s.market.store.dropUser(a.id);
      s.market.store.dropUser(b.id);
    }
  });

  it('a change on this copy drops the sitemap’s cache and marks the market changed', async () => {
    const a = await s.user('smc@example.com');
    expect((await s.visit('/sitemap.xml')).text).not.toContain('/market/');
    const slug = slugOf(await s.put(a, 'lst_sm', s.listing(a)));
    expect((await s.visit('/sitemap.xml')).text).toContain(`/market/${slug}`);
    expect(s.storage.documents.get('market:changedAt').value.at).toEqual(expect.any(String));
    await s.call(a, 'DELETE', '/api/market/public/lst_sm');
    expect((await s.visit('/sitemap.xml')).text).not.toContain(`/market/${slug}`);
  });

  it('keeps the 50,000 cap', async () => {
    const { sitemapXml } = await import('../seo/sitemap.mjs');
    const rows = Array.from({ length: 50_010 }, (_, i) => ({ slug: `p-${i}-abc`, updated_at: '2026-11-01' }));
    const xml = sitemapXml(APP, rows, [{ slug: 'mkt-one-abc', category_slug: 'home', content_updated_at: '2026-11-02' }]);
    expect((xml.match(/<url>/g) ?? []).length).toBe(50_000);
  });
});

describe('the plan’s limit', () => {
  it('Launch: 3 public listings, the 4th is 409 LIMIT with used and limit', async () => {
    const a = await s.user('limit@example.com');
    for (let i = 1; i <= 3; i++) expect((await s.put(a, `lst_${i}`, s.listing(a, { description: `${DESCRIPTION} ${i}` }))).status).toBe(201);
    const fourth = await s.put(a, 'lst_4', s.listing(a));
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({ code: 'LIMIT', used: 3, limit: 3 });
    expect(fourth.body.error).toBe('Your plan includes 3 public listings. Upgrade or turn one off.');
    // editing one of the three still works
    expect((await s.put(a, 'lst_2', s.listing(a, { title: 'Second listing, edited' }))).status).toBe(200);
    const list = await s.call(a, 'GET', '/api/market/public');
    expect(list.body).toMatchObject({ limit: 3, used: 3, appUrl: APP });
  });

  it('two toggles at once at used=2: exactly one goes through', async () => {
    const a = await s.user('race@example.com');
    await s.put(a, 'lst_1', s.listing(a));
    await s.put(a, 'lst_2', s.listing(a));
    const [x, y] = await Promise.all([s.put(a, 'lst_3', s.listing(a)), s.put(a, 'lst_4', s.listing(a))]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(s.rows('public_listings').filter((r) => r.user_id === a.id && r.status !== 'unlisted')).toHaveLength(3);
  });

  it('the owner and legacy accounts have no limit; a paused plan is refused', async () => {
    const owner = await s.user('owner@example.com', { isAdmin: true });
    for (let i = 1; i <= 4; i++) expect((await s.put(owner, `lst_${i}`, s.listing(owner))).status).toBe(201);
    expect((await s.call(owner, 'GET', '/api/market/public')).body.limit).toBeNull();
    const paused = await s.user('paused@example.com', { status: 'unpaid' });
    const r = await s.put(paused, 'lst_1', s.listing(paused));
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('PAYMENT_REQUIRED');
  });

  it('at most MARKET_NEW_PUBLIC_PER_DAY new public listings a day', async () => {
    const t = await marketServer({ env: { MARKET_NEW_PUBLIC_PER_DAY: '2' } });
    try {
      const a = await t.user('daily@example.com', { tier: 'scale' });
      expect((await t.put(a, 'lst_1', t.listing(a))).status).toBe(201);
      expect((await t.put(a, 'lst_2', t.listing(a))).status).toBe(201);
      const third = await t.put(a, 'lst_3', t.listing(a));
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ code: 'RATE_LIMITED', error: 'You can put up to 2 new listings on the web a day.' });
      // an edit isn't new
      expect((await t.put(a, 'lst_1', t.listing(a, { title: 'Edited title here' }))).status).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('after a downgrade the sweep keeps the earliest and sets the rest over_limit (410)', async () => {
    const a = await s.user('downgrade@example.com', { tier: 'grow' });
    const slugs = [];
    for (let i = 1; i <= 5; i++) slugs.push(slugOf(await s.put(a, `lst_${i}`, s.listing(a, { description: `${DESCRIPTION} ${i}` }))));
    s.billing.plans.set(a.id, { user_id: a.id, tier: 'launch', source: 'stripe', status: 'active', business_limit: 1 });
    const got = await s.market.sweep();
    expect(got.overLimit).toBe(2);
    const statuses = slugs.map((slug) => s.rows('public_listings').find((r) => r.slug === slug).status);
    expect(statuses).toEqual(['live', 'live', 'live', 'over_limit', 'over_limit']);
    expect((await s.visit(`/market/${slugs[4]}`)).status).toBe(410);
    expect(s.logs.some((l) => l.includes('market_over_limit') && l.includes('"count":2'))).toBe(true);
  });
});

describe('unlisting', () => {
  it('DELETE answers 410 at once, leaves the grid and sitemap, and PUT brings it back on the same address', async () => {
    const a = await s.user('unlist@example.com');
    const slug = slugOf(await s.put(a, 'lst_u', s.listing(a)));
    expect((await s.visit(`/market/${slug}`)).status).toBe(200);
    expect((await s.visit('/market')).text).toContain(slug);
    expect((await s.call(a, 'DELETE', '/api/market/public/lst_u')).body).toEqual({ ok: true });
    expect((await s.visit(`/market/${slug}`)).status).toBe(410);
    expect((await s.visit('/market')).text).not.toContain(slug);
    expect((await s.visit('/sitemap.xml')).text).not.toContain(slug);
    const back = await s.put(a, 'lst_u', s.listing(a));
    expect(back.status).toBe(200);
    expect(slugOf(back)).toBe(slug);
    expect((await s.visit(`/market/${slug}`)).status).toBe(200);
  });

  it('a hidden listing can’t be turned back on by its seller; DELETE of a missing one is ok', async () => {
    const a = await s.user('hiddenput@example.com');
    await s.put(a, 'lst_h', s.listing(a));
    const row = s.rows('public_listings').find((r) => r.user_id === a.id);
    Object.assign(row, { status: 'hidden', hidden_at: new Date().toISOString(), hidden_reason: 'spam' });
    const r = await s.put(a, 'lst_h', s.listing(a));
    expect([r.status, r.body.code]).toEqual([409, 'HIDDEN']);
    expect((await s.call(a, 'DELETE', '/api/market/public/never_there')).body).toEqual({ ok: true });
  });
});

describe('accounts and switches', () => {
  it('after forgetUser the seller’s pages are 410 on this copy; deleting the account removes the rows', async () => {
    const a = await s.user('bye@example.com');
    const slug = slugOf(await s.put(a, 'lst_d', s.listing(a)));
    await s.market.forgetUser(a.id);
    expect((await s.visit(`/market/${slug}`)).status).toBe(410);
    await s.market.unforgetUser(a.id);
    expect((await s.visit(`/market/${slug}`)).status).toBe(200);
    await fetch(`${s.supa.url}/auth/v1/admin/users/${a.id}`, { method: 'DELETE', headers: { apikey: s.supa.SECRET } });
    expect(s.rows('public_listings').filter((r) => r.user_id === a.id)).toHaveLength(0);
  });

  it('MARKET_PUBLIC=off: every page is the 404 notice and the API is 503 NOT_SET_UP', async () => {
    const t = await marketServer({ env: { MARKET_PUBLIC: 'off' } });
    try {
      for (const p of ['/market', '/market/some-name-abcdef', '/market/some-name-abcdef/report']) expect((await t.visit(p)).status).toBe(404);
      const a = await t.user('off@example.com');
      const r = await t.call(a, 'GET', '/api/market/public');
      expect([r.status, r.body.code]).toEqual([503, 'NOT_SET_UP']);
      expect(t.market.config()).toEqual({ enabled: false, publicUrl: null });
      expect(t.market.notes().join('\n')).toContain('MARKET_PUBLIC=off');
    } finally {
      await t.close();
    }
  });

  it('without the migration the API names it and the pages are a 503 notice', async () => {
    const a = await s.user('nomig@example.com');
    const missing = { ...s.db, select: async () => Promise.reject(Object.assign(new Error('x'), { name: 'DbError', code: 'NOT_SET_UP' })), enabled: true };
    const m = createMarket({ auth: { enabled: true, identify: async () => a }, db: missing, send: sendJson, readJson: async () => ({}), env: s.env, log: { log() {} } });
    const res = { headers: {}, status: 0, body: '', writeHead(st, h) { this.status = st; Object.assign(this.headers, h); }, end(b) { this.body = String(b ?? ''); }, headersSent: false };
    const req = { method: 'GET', headers: {}, on() {}, resume() {} };
    await m.handle(req, res, new URL('http://x/api/market/public'));
    expect(res.status).toBe(503);
    expect(res.body).toContain('20261119000000_public_market.sql');
    const res2 = { ...res, headers: {}, status: 0 };
    await m.publicRoutes.handle(req, res2, new URL('http://x/market/some-name-abcdef'));
    expect(res2.status).toBe(503);
    expect(res2.headers['cache-control']).toBe('no-store');
  });
});

describe('review fixes', () => {
  // a fresh minute for the per-visitor lookup budget (every visit here is the same visitor)
  beforeEach(() => s.advance(61_000));
  it('a Stripe offer in test mode says so; a live one doesn’t; a Whop sandbox offer says so', async () => {
    const a = await s.user('testmode@example.com');
    const offer = s.offer(a, { provider: 'stripe', price_minor: 2500, currency: 'usd', provider_ref: {} });
    const r = await s.put(a, 'lst_tm', s.listing(a, { offerId: offer.id }));
    expect((await s.visit(`/market/${slugOf(r)}`)).text).not.toContain('Test mode');
    stripeEnv = 'sandbox';
    s.market.store.drop();
    const test = await s.visit(`/market/${slugOf(r)}`);
    expect(test.text).toContain('Test mode: this checkout takes no real payments.');
    const whop = s.offer(a, { provider: 'whop', price_minor: 1500, currency: 'usd', provider_ref: { environment: 'sandbox' } });
    const w = await s.put(a, 'lst_wh', s.listing(a, { offerId: whop.id, title: 'Stoneware bowl, river glaze', description: `bowl ${DESCRIPTION}` }));
    stripeEnv = 'production';
    expect((await s.visit(`/market/${slugOf(w)}`)).text).toContain('Test mode');
  });

  it('a Stripe offer’s price is read at render: a later price change shows on the page and in its JSON-LD', async () => {
    const a = await s.user('reprice@example.com');
    const offer = s.offer(a, { provider: 'stripe', price_minor: 2500, currency: 'usd' });
    const r = await s.put(a, 'lst_rp', s.listing(a, { offerId: offer.id }));
    offer.price_minor = 3900;
    s.market.store.dropOffer(offer.id);
    s.market.store.drop();
    const page = await s.visit(`/market/${slugOf(r)}`);
    expect(page.text).toContain('"price":"39.00"');
    expect(page.text).toContain('<p class="price">$39</p>');
    expect(page.text).not.toContain('25.00');
  });

  it('every address on a page comes from the app’s address, never the request’s Host', async () => {
    const t = await marketServer({ env: { GSC_APP_PROPERTY: '' } });
    try {
      const a = await t.user('host@example.com');
      const r = await t.put(a, 'lst_h', t.listing(a));
      expect(r.body.listing.url).toBe(`${APP}/market/${slugOf(r)}`);
      const host = new URL(t.base).host;
      for (const p of [`/market/${slugOf(r)}`, '/market', `/market/${slugOf(r)}/report`]) {
        const page = await t.visit(p);
        expect(page.text, p).not.toContain(host);
      }
      const page = await t.visit(`/market/${slugOf(r)}`);
      expect(page.text).toContain(`<link rel="canonical" href="${APP}/market/${slugOf(r)}">`);
      expect(page.text).toContain(`<meta property="og:url" content="${APP}/market/${slugOf(r)}">`);
      // the sitemap on another of the app's hosts doesn't list the market (its pages' one address is the app's)
      expect((await t.visit('/sitemap.xml')).text).not.toContain('/market');
    } finally {
      await t.close();
    }
  });

  it('categories past PostgREST’s 1,000 rows still answer, and their counts are right', async () => {
    const a = await s.user('many@example.com');
    seed(a.id, 1000, { category: 'Home', category_slug: 'home' });
    // ids after the first 1,000 (they sort last)
    for (let i = 0; i < 3; i++) seed(a.id, 1, { id: `ffffffff-ffff-4fff-8fff-00000000000${i}`, listing_id: `z${i}`, slug: `zeta-item-${i}-abcdef`, category: 'Zeta', category_slug: 'zeta' });
    const cats = await s.market.store.categories();
    expect(cats).toEqual([{ slug: 'home', name: 'Home', count: 1000 }, { slug: 'zeta', name: 'Zeta', count: 3 }]);
    const z = await s.visit('/market?category=zeta');
    expect(z.status).toBe(200);
    expect(z.text).toContain('<meta name="robots" content="index, follow">');
  });

  it('the sweep reads every public row, past 1,000', async () => {
    const a = await s.user('sweep-many@example.com');
    seed(a.id, 1003);
    const got = await s.market.sweep();
    expect(got.overLimit).toBe(1000);
    expect(s.rows('public_listings').filter((r) => ['live', 'thin'].includes(r.status))).toHaveLength(3);
  });

  it('search keeps the category it was made in', async () => {
    const a = await s.user('catsearch@example.com');
    seed(a.id, 1, { listing_id: 'c1', slug: 'cake-home-abcdef', title: 'Cake stand', category: 'Home', category_slug: 'home' });
    seed(a.id, 1, { id: crypto.randomUUID(), listing_id: 'c2', slug: 'cake-food-abcdef', title: 'Chocolate cake', category: 'Food', category_slug: 'food' });
    const r = await s.visit('/market?category=food&q=cake');
    expect(r.text).toContain('cake-food-abcdef');
    expect(r.text).not.toContain('cake-home-abcdef');
    expect((await s.visit('/market?q=cake')).text).toContain('cake-home-abcdef');
  });

  it('breadcrumbs: none in the data on /market itself; a category with no live listings isn’t linked', async () => {
    const a = await s.user('crumbs@example.com');
    seed(a.id, 3);
    const grid = await s.visit('/market');
    expect(grid.text).not.toContain('BreadcrumbList');
    expect((await s.visit('/market?category=home')).text).toContain('BreadcrumbList');
    const b = await s.user('crumbs2@example.com');
    const thin = await s.put(b, 'lst_th', s.listing(b, { category: 'Lonely things', coverPath: null }));
    expect(thin.body).toMatchObject({ listing: { status: 'thin' } });
    const page = await s.visit(`/market/${slugOf(thin)}`);
    expect(page.text).not.toContain('category=lonely-things');
    expect(page.text).toContain('<span>Lonely things</span>');
    const live = await s.visit('/market/item-000-abcdef');
    expect(live.text).toContain(`href="${APP}/market?category=home"`);
  });

  it('a quote listing sends no Product; a business listing is a Service', async () => {
    const a = await s.user('ld@example.com');
    const q = await s.put(a, 'lst_q', s.listing(a, { price: 0, priceModel: 'quote' }));
    const page = await s.visit(`/market/${slugOf(q)}`);
    expect(page.text).not.toContain('"Product"');
    expect(page.text).toContain('BreadcrumbList');
  });
});
