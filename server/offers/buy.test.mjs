// /b/<id> (spec test 5): a redirect only to the checkout link stored for the offer's own provider, re-checked on every
// click; never an open redirect; the status pages; limits; no counting for HEAD or a prefetch; /done says nothing it
// can't know. Plus pages.mjs handing /b/ to offers on the app's host and on a domain.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { offersServer } from './test-helpers.mjs';
import { createPages } from '../pages.mjs';
import { isCheckoutHost, validWhopPurchaseUrl } from './providers.mjs';

describe('/b/<id>', () => {
  let h;
  let s;
  let serveUntil = null;
  beforeAll(async () => {
    h = await offersServer({ billing: { pagesServeUntil: async () => serveUntil, requireActive: async () => null } });
    s = await h.seller('buy@example.com');
  });
  afterAll(() => h.close());
  const row = (id) => h.rows('offers').find((o) => o.id === id);
  const fresh = (id) => h.offers.buy.drop(id);
  let ip = 0;
  // each test its own visitor, so the per-visitor limit only matters where it's tested
  const visit = (path, opts = {}) => h.visit(path, { ...opts, headers: { 'x-test-ip': `198.51.100.${(ip++ % 200) + 1}`, ...(opts.headers ?? {}) } });

  it('a Whop offer: 302 to the stored link only, with the safe headers; the query string never reaches it', async () => {
    const offer = (await h.whopOffer(s)).body.offer;
    const r = await visit(`/b/${offer.id}?next=https://evil.com&utm=x`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(row(offer.id).provider_ref.purchaseUrl);
    expect(r.headers.get('location')).not.toContain('evil');
    for (const [k, v] of [['cache-control', 'no-store'], ['referrer-policy', 'no-referrer'], ['x-robots-tag', 'noindex'], ['x-content-type-options', 'nosniff'], ['content-length', '0']]) expect(r.headers.get(k)).toBe(v);
    expect(row(offer.id).clicks).toBe(1);
  });

  it('a tampered row never redirects: other host, look-alike host, http, the other environment, another ch_', async () => {
    const offer = (await h.whopOffer(s)).body.offer;
    const good = row(offer.id).provider_ref;
    for (const purchaseUrl of ['https://evil.com/checkout/' + good.checkoutId + '/', 'https://whop.com.evil.com/checkout/' + good.checkoutId + '/', 'http://whop.com/checkout/' + good.checkoutId + '/', 'https://sandbox.whop.com/checkout/' + good.checkoutId + '/', 'https://whop.com/checkout/ch_someoneelse1/', 'https://whop.com@evil.com/checkout/' + good.checkoutId + '/', '//evil.com/checkout/' + good.checkoutId]) {
      row(offer.id).provider_ref = { ...good, purchaseUrl };
      fresh(offer.id);
      const r = await visit(`/b/${offer.id}`);
      expect(r.status, purchaseUrl).toBe(503);
      expect(r.headers.get('location')).toBeNull();
      expect(r.text).not.toContain('evil');
      expect(r.text).not.toMatch(/whop/i);
    }
    row(offer.id).provider_ref = good;
    fresh(offer.id);
  });

  it('an outside link: a known checkout site redirects; any other site is a leave page here and a redirect on the owner’s domain', async () => {
    const known = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', title: 'Gumroad', provider: 'external', url: 'https://app.gumroad.com/l/x' })).body.offer;
    expect((await visit(`/b/${known.id}`)).headers.get('location')).toBe('https://app.gumroad.com/l/x');
    const other = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', title: 'My shop', provider: 'external', url: 'https://myshop.example/buy?x=1' })).body.offer;
    const here = await visit(`/b/${other.id}`);
    expect(here.status).toBe(200);
    expect(here.headers.get('location')).toBeNull();
    expect(here.text).toContain('myshop.example');
    expect(here.text).toContain('rel="noopener noreferrer"');
    expect(here.text).not.toMatch(/<script/i);
    expect(here.headers.get('content-security-policy')).toContain("default-src 'none'");
    const onDomain = await visit(`/b/${other.id}`, { site: s.who.id });
    expect(onDomain.status).toBe(302);
    expect(onDomain.headers.get('location')).toBe('https://myshop.example/buy?x=1');
    // someone else's domain: not found
    expect((await visit(`/b/${other.id}`, { site: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('the status pages: missing 404, draft 404, archived 410, paused 503, a disconnected Whop 503, plan ended 410', async () => {
    expect((await visit(`/b/${'Z'.repeat(22)}`)).status).toBe(404);
    expect((await visit('/b/short')).status).toBe(404);
    const o = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', title: 'States', provider: 'external', url: 'https://gumroad.com/l/s' })).body.offer;
    row(o.id).status = 'draft';
    fresh(o.id);
    expect((await visit(`/b/${o.id}`)).status).toBe(404);
    row(o.id).status = 'paused';
    fresh(o.id);
    const paused = await visit(`/b/${o.id}`);
    expect(paused.status).toBe(503);
    expect(paused.text).toContain('isn’t available to buy right now');
    row(o.id).status = 'archived';
    fresh(o.id);
    const archived = await visit(`/b/${o.id}`);
    expect(archived.status).toBe(410);
    expect(archived.text).toContain('no longer available');
    row(o.id).status = 'active';
    fresh(o.id);
    serveUntil = new Date(Date.now() - 1000).toISOString();
    try {
      expect((await visit(`/b/${o.id}`)).text).toBe('GONE PAGE');
    } finally {
      serveUntil = null;
    }
    const w = (await h.whopOffer(s)).body.offer;
    h.rows('payment_connections').find((c) => c.id === s.connection.id).status = 'key_rejected';
    fresh(w.id);
    try {
      expect((await visit(`/b/${w.id}`)).status).toBe(503);
    } finally {
      h.rows('payment_connections').find((c) => c.id === s.connection.id).status = 'active';
      fresh(w.id);
    }
  });

  it('HEAD and a prefetch don’t count; other methods 405', async () => {
    const o = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', title: 'Count', provider: 'external', url: 'https://gumroad.com/l/c' })).body.offer;
    expect((await visit(`/b/${o.id}`, { method: 'HEAD' })).status).toBe(302);
    expect((await visit(`/b/${o.id}`, { headers: { 'sec-purpose': 'prefetch' } })).status).toBe(302);
    expect(row(o.id).clicks ?? 0).toBe(0);
    await visit(`/b/${o.id}`);
    expect(row(o.id).clicks).toBe(1);
    const post = await visit(`/b/${o.id}`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('per visitor: 429 with retry-after; a lookup that fails never redirects', async () => {
    const o = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', title: 'Busy', provider: 'external', url: 'https://gumroad.com/l/b' })).body.offer;
    let last;
    for (let i = 0; i < 61; i++) last = await h.visit(`/b/${o.id}`, { headers: { 'x-test-ip': '192.0.2.77' } });
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    const other = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', title: 'Down', provider: 'external', url: 'https://gumroad.com/l/d' })).body.offer;
    h.supa.behavior.fail = (method, path) => (path === '/rest/v1/offers' && method === 'GET' ? { status: 503, body: { message: 'down' } } : null);
    try {
      const r = await visit(`/b/${other.id}`);
      expect(r.status).toBe(503);
      expect(r.headers.get('location')).toBeNull();
    } finally {
      h.supa.behavior.fail = null;
    }
  });

  it('/b/<id>/done: a thank-you with no script, nothing from the query, never "payment confirmed"', async () => {
    const o = (await h.whopOffer(s)).body.offer;
    const r = await visit(`/b/${o.id}/done?payment=pay_x&status=succeeded&msg=<script>alert(1)</script>`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('Thanks for your order');
    expect(r.text).not.toMatch(/<script|pay_x|succeeded|confirmed|successful/i);
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(row(o.id).clicks ?? 0).toBe(0);
  });
});

describe('checkout hosts and Whop links', () => {
  it('matches known checkout sites on a dot boundary only', () => {
    expect(isCheckoutHost('buy.stripe.com')).toBe(true);
    expect(isCheckoutHost('www.gumroad.com')).toBe(true);
    expect(isCheckoutHost('shop.myshopify.com')).toBe(true);
    expect(isCheckoutHost('evilgumroad.com')).toBe(false);
    expect(isCheckoutHost('gumroad.com.evil.com')).toBe(false);
  });
  it('a Whop link: the environment’s host, https, no port, the stored ch_', () => {
    expect(validWhopPurchaseUrl('https://whop.com/checkout/ch_abc123/', 'production', 'ch_abc123')).toBe('https://whop.com/checkout/ch_abc123/');
    expect(validWhopPurchaseUrl('https://sandbox.whop.com/checkout/ch_abc123/', 'sandbox', 'ch_abc123')).toBeTruthy();
    expect(validWhopPurchaseUrl('https://whop.com/checkout/ch_abc123/', 'sandbox', 'ch_abc123')).toBeNull();
    expect(validWhopPurchaseUrl('https://whop.com/checkout/ch_abc123x/', 'production', 'ch_abc123')).toBeNull();
    expect(validWhopPurchaseUrl('https://whop.com:443/checkout/ch_abc123/', 'production', 'ch_abc123')).toBeTruthy();
    expect(validWhopPurchaseUrl('https://whop.com:444/checkout/ch_abc123/', 'production', 'ch_abc123')).toBeNull();
  });
});

describe('pages.mjs hands /b/ to offers', () => {
  it('on the app’s host and on a domain, with the pages’ own not-found and gone', async () => {
    const seen = [];
    const offers = { matchBuy: (url) => url.pathname.startsWith('/b/'), serveBuy: async (req, res, url, site, pages) => seen.push([url.pathname, site, typeof pages.notFound, typeof pages.gone, typeof pages.visitor]) };
    const pages = createPages({ send: () => {}, offers });
    const res = { writeHead() {}, end() {} };
    await pages.servePublicRoute({ method: 'GET', headers: {}, socket: {} }, res, new URL('http://x/b/AAAAAAAAAAAAAAAAAAAAAA'));
    await pages.servePublicRoute({ method: 'GET', headers: {}, socket: {} }, res, new URL('http://x/b/AAAAAAAAAAAAAAAAAAAAAA'), { user_id: 'u1' });
    expect(seen).toEqual([
      ['/b/AAAAAAAAAAAAAAAAAAAAAA', null, 'function', 'function', 'function'],
      ['/b/AAAAAAAAAAAAAAAAAAAAAA', { user_id: 'u1' }, 'function', 'function', 'function'],
    ]);
    pages.close();
  });
});
