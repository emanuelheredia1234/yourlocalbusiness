// Visitor and signed-in reports, the hold after three distinct reporters, and the owner's moderation (P7 S6). The form
// has no script; its token is good from 3 s to 1 h; the honeypot looks like success and stores nothing; limits per
// visitor and per listing; one report per reporter per listing per day; sellers never see who reported.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { marketServer } from './test-helpers.mjs';
import { checkFormToken, makeFormToken } from './reports.mjs';

let s;
beforeAll(async () => {
  s = await marketServer({ env: { MARKET_REPORTS_PER_IP_PER_HOUR: '3', MARKET_REPORTS_PER_LISTING_PER_HOUR: '6' } });
});
afterAll(async () => {
  await s.close();
});
beforeEach(() => {
  for (const t of ['public_listings', 'public_listing_reports']) s.supa.tables.set(t, []);
  s.market.store.drop();
});

const form = (fields) => new URLSearchParams(fields).toString();
const tokenFrom = (html) => /name="t" value="([^"]+)"/.exec(html)?.[1];
let ipN = 0;
/** One visitor's report: GET the form, wait past the 3 s floor (the clock), POST it. */
async function report(slug, { ip = `203.0.113.${++ipN}`, reason = 'scam', note = 'Asked me to pay by gift card', website = '', wait = 4000, token = null } = {}) {
  const page = await s.visit(`/market/${slug}/report`, { headers: { 'x-test-ip': ip } });
  s.advance(wait);
  return s.visit(`/market/${slug}/report`, { method: 'POST', headers: { 'x-test-ip': ip, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ reason, note, t: token ?? tokenFrom(page.text), website }) });
}
async function liveListing(email) {
  const a = await s.user(email);
  const r = await s.put(a, 'lst_r', s.listing(a));
  return { seller: a, slug: r.body.listing.slug, row: () => s.rows('public_listings').find((x) => x.slug === r.body.listing.slug) };
}

describe('the report form', () => {
  it('has no script, is noindex and no-store, and carries a token', async () => {
    const { slug } = await liveListing('form@example.com');
    const page = await s.visit(`/market/${slug}/report`);
    expect(page.status).toBe(200);
    expect(page.text).not.toMatch(/<script(?! type="application\/ld\+json")/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(page.headers.get('content-security-policy')).toMatch(/form-action 'self'/);
    expect(tokenFrom(page.text)).toMatch(/^[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
    expect((await s.visit('/market/missing-one-abcdef/report')).status).toBe(404);
  });

  it('a token younger than 3 s or older than 1 h is refused and stores nothing', async () => {
    const secret = Buffer.from('k'.repeat(32));
    const t = makeFormToken(secret, 'a-slug', 1_000_000);
    expect(checkFormToken(secret, 'a-slug', t, 1_001_000)).toBe(false);
    expect(checkFormToken(secret, 'a-slug', t, 1_004_000)).toBe(true);
    expect(checkFormToken(secret, 'a-slug', t, 1_000_000 + 3_600_001)).toBe(false);
    expect(checkFormToken(secret, 'other-slug', t, 1_004_000)).toBe(false);
    const { slug } = await liveListing('tok@example.com');
    const fast = await report(slug, { wait: 0 });
    expect(fast.status).toBe(400);
    expect(fast.text).toContain('Please send the form again.');
    const old = await report(slug, { wait: 3_700_000 });
    expect(old.status).toBe(400);
    expect(s.rows('public_listing_reports')).toHaveLength(0);
  });

  it('the honeypot answers like a success and stores nothing', async () => {
    const { slug } = await liveListing('honey@example.com');
    const r = await report(slug, { website: 'http://spam.example' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('Thanks, we’ll take a look');
    expect(s.rows('public_listing_reports')).toHaveLength(0);
  });

  it('stores a report once per visitor per day, with a keyed hash and nothing typed in the logs', async () => {
    const { slug, row } = await liveListing('once@example.com');
    const ip = '198.51.100.7';
    expect((await report(slug, { ip, note: 'SECRET-NOTE-TEXT' })).status).toBe(200);
    expect((await report(slug, { ip })).status).toBe(200);
    const stored = s.rows('public_listing_reports');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ reason: 'scam', note: 'SECRET-NOTE-TEXT', reporter_kind: 'visitor', status: 'open' });
    expect(stored[0].reporter_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored[0])).not.toContain(ip);
    expect(row().report_count).toBe(1);
    expect(s.logs.join('\n')).not.toContain('SECRET-NOTE-TEXT');
  });

  it('limits reports per visitor and per listing (429)', async () => {
    const { slug } = await liveListing('limits@example.com');
    const ip = '192.0.2.50';
    for (let i = 0; i < 3; i++) expect((await report(slug, { ip })).status).toBe(200);
    expect((await report(slug, { ip })).status).toBe(429);
    const other = await liveListing('limits2@example.com');
    for (let i = 0; i < 3; i++) await report(other.slug);
    // 3 of this listing's 6 an hour already went: three more visitors, then the listing's limit
    for (let i = 0; i < 3; i++) await report(other.slug);
    expect((await report(other.slug)).status).toBe(429);
  });
});

describe('the hold and moderation', () => {
  it('the third distinct reporter in 7 days holds a listing: noindex, off the grid and the sitemap', async () => {
    const { slug, row } = await liveListing('held@example.com');
    await report(slug);
    await report(slug);
    expect(row().status).toBe('live');
    await report(slug);
    expect(row().status).toBe('held');
    expect(row().held_at).toEqual(expect.any(String));
    const page = await s.visit(`/market/${slug}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-robots-tag')).toBe('noindex');
    expect((await s.visit('/market')).text).not.toContain(slug);
    s.sitemap.clearCache();
    expect((await s.visit('/sitemap.xml')).text).not.toContain(slug);
    expect(s.logs.some((l) => l.includes('market_listing_held'))).toBe(true);
  });

  it('the seller sees the status and the count only', async () => {
    const { seller, slug } = await liveListing('sellerview@example.com');
    await report(slug, { note: 'PRIVATE NOTE' });
    const mine = await s.call(seller, 'GET', '/api/market/public');
    expect(mine.body.listings[0]).toMatchObject({ reportCount: 1, status: 'live' });
    expect(mine.text).not.toMatch(/PRIVATE NOTE|reporter|hash/);
  });

  it('hide, unhide and dismiss need the owner; dismissing the last open report lifts the hold', async () => {
    const { seller, slug, row } = await liveListing('mod@example.com');
    for (let i = 0; i < 3; i++) await report(slug);
    expect(row().status).toBe('held');
    const owner = await s.user('boss@example.com', { isAdmin: true });
    const id = row().id;
    for (const [m, p] of [['GET', '/api/market/admin'], ['POST', `/api/market/admin/listings/${id}/hide`], ['POST', `/api/market/admin/listings/${id}/unhide`], ['POST', `/api/market/admin/reports/${id}/dismiss`], ['POST', '/api/market/admin/submit-sitemap']]) {
      const r = await s.call(seller, m, p, m === 'POST' ? { reason: 'spam', confirm: true } : undefined);
      expect([p, r.status, r.body.code]).toEqual([p, 403, 'FORBIDDEN']);
    }
    const view = await s.call(owner, 'GET', '/api/market/admin');
    expect(view.status).toBe(200);
    expect(view.body.reports).toHaveLength(3);
    expect(view.body.reports[0]).toMatchObject({ reason: 'scam', from: 'visitor', listing: { slug } });
    expect(view.text).not.toMatch(/reporter_hash|[0-9a-f]{64}/);
    expect(view.body.held.map((h) => h.slug)).toEqual([slug]);
    for (const rep of view.body.reports) expect((await s.call(owner, 'POST', `/api/market/admin/reports/${rep.id}/dismiss`)).status).toBe(200);
    expect(row()).toMatchObject({ status: 'live', held_at: null, report_count: 0 });
    expect(s.logs.some((l) => l.includes('market_moderation') && l.includes('dismiss'))).toBe(true);
  });

  it('hide makes the page 410 and actions the reports; unhide brings back the computed status', async () => {
    const { seller, slug, row } = await liveListing('hide@example.com');
    await report(slug);
    const owner = await s.user('boss2@example.com', { isAdmin: true });
    const id = row().id;
    expect((await s.call(owner, 'POST', `/api/market/admin/listings/${id}/hide`, { reason: 'nope' })).status).toBe(400);
    expect((await s.call(owner, 'POST', `/api/market/admin/listings/${id}/hide`, { reason: 'misleading', note: 'checked' })).status).toBe(200);
    expect(row()).toMatchObject({ status: 'hidden', hidden_reason: 'misleading' });
    expect(s.rows('public_listing_reports').every((r) => r.status === 'actioned')).toBe(true);
    expect((await s.visit(`/market/${slug}`)).status).toBe(410);
    const mine = await s.call(seller, 'GET', '/api/market/public');
    expect(mine.body.listings[0]).toMatchObject({ status: 'hidden', hiddenReason: 'misleading' });
    expect((await s.put(seller, 'lst_r', s.listing(seller))).body.code).toBe('HIDDEN');
    expect((await s.call(owner, 'POST', `/api/market/admin/listings/${id}/unhide`)).body).toMatchObject({ ok: true, status: 'live' });
    expect((await s.visit(`/market/${slug}`)).status).toBe(200);
  });

  it('signed-in reports work, and reporting your own listing is 400', async () => {
    const { seller, slug, row } = await liveListing('signed@example.com');
    const b = await s.user('reporter@example.com');
    expect((await s.call(seller, 'POST', '/api/market/reports', { slug, reason: 'spam' })).status).toBe(400);
    expect((await s.call(b, 'POST', '/api/market/reports', { slug, reason: 'bogus' })).status).toBe(400);
    expect((await s.call(b, 'POST', '/api/market/reports', { slug, reason: 'spam', note: 'dup listing' })).body).toEqual({ ok: true });
    expect((await s.call(b, 'POST', '/api/market/reports', { slug, reason: 'spam' })).body).toEqual({ ok: true });
    expect(s.rows('public_listing_reports')).toHaveLength(1);
    expect(s.rows('public_listing_reports')[0].reporter_kind).toBe('user');
    expect(row().report_count).toBe(1);
    expect((await s.call(b, 'POST', '/api/market/reports', { slug: 'missing-one-abcdef', reason: 'spam' })).status).toBe(404);
  });
});
