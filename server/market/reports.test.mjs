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
    const t = makeFormToken(secret, 'a-slug', 'visitor-a', 1_000_000);
    expect(checkFormToken(secret, 'a-slug', 'visitor-a', t, 1_001_000)).toBe(false);
    expect(checkFormToken(secret, 'a-slug', 'visitor-a', t, 1_004_000)).toBe(true);
    expect(checkFormToken(secret, 'a-slug', 'visitor-a', t, 1_000_000 + 3_600_001)).toBe(false);
    expect(checkFormToken(secret, 'other-slug', 'visitor-a', t, 1_004_000)).toBe(false);
    // another visitor's browser can't use it
    expect(checkFormToken(secret, 'a-slug', 'visitor-b', t, 1_004_000)).toBe(false);
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
    const sellerId = seller.id;
    expect((await s.call(seller, 'POST', '/api/market/reports', { slug, sellerId, reason: 'spam' })).status).toBe(400);
    expect((await s.call(b, 'POST', '/api/market/reports', { slug, sellerId, reason: 'bogus' })).status).toBe(400);
    expect((await s.call(b, 'POST', '/api/market/reports', { slug, sellerId, reason: 'spam', note: 'dup listing' })).body).toEqual({ ok: true });
    expect((await s.call(b, 'POST', '/api/market/reports', { slug, sellerId, reason: 'spam' })).body).toEqual({ ok: true });
    expect(s.rows('public_listing_reports')).toHaveLength(1);
    expect(s.rows('public_listing_reports')[0].reporter_kind).toBe('user');
    expect(row().report_count).toBe(1);
    expect((await s.call(b, 'POST', '/api/market/reports', { slug: 'missing-one-abcdef', sellerId, reason: 'spam' })).status).toBe(404);
  });

  it('a signed-in report goes only to the web page of the in-app listing’s own seller', async () => {
    const victim = await liveListing('victim@example.com');
    const forger = await s.user('forger@example.com');
    const b = await s.user('reporter2@example.com');
    // an in-app listing of the forger's that carries the victim's slug: its seller doesn't own that page
    const r = await s.call(b, 'POST', '/api/market/reports', { slug: victim.slug, sellerId: forger.id, reason: 'scam' });
    expect(r.status).toBe(404);
    expect((await s.call(b, 'POST', '/api/market/reports', { slug: victim.slug, reason: 'scam' })).status).toBe(400);
    expect(s.rows('public_listing_reports')).toHaveLength(0);
    expect(victim.row().report_count).toBe(0);
  });
});

describe('reports from another site', () => {
  /** A cross-site POST of a token this visitor's own form gave them. */
  async function postWith(slug, headers, ip = `203.0.113.${++ipN}`) {
    const page = await s.visit(`/market/${slug}/report`, { headers: { 'x-test-ip': ip } });
    s.advance(4000);
    return s.visit(`/market/${slug}/report`, { method: 'POST', headers: { 'x-test-ip': ip, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form({ reason: 'scam', t: tokenFrom(page.text), website: '' }) });
  }

  it('a POST from another site (Origin or Sec-Fetch-Site) is refused and stores nothing', async () => {
    const { slug, row } = await liveListing('csrf@example.com');
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
      const r = await postWith(slug, headers);
      expect(r.status).toBe(403);
      expect(r.text).toContain('Please send the form again.');
    }
    expect(s.rows('public_listing_reports')).toHaveLength(0);
    expect(row().status).toBe('live');
    // the app's own origin, or the host that served the form, is fine
    expect((await postWith(slug, { origin: 'https://yourlocalbusiness.replit.app', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await postWith(slug, { origin: s.base })).status).toBe(200);
    expect(s.rows('public_listing_reports')).toHaveLength(2);
  });

  it('one copied token posted by many visitors’ browsers files nothing', async () => {
    const { slug, row } = await liveListing('copied@example.com');
    const page = await s.visit(`/market/${slug}/report`, { headers: { 'x-test-ip': '198.51.100.200' } });
    const t = tokenFrom(page.text);
    s.advance(4000);
    for (let i = 0; i < 4; i++) {
      const r = await s.visit(`/market/${slug}/report`, { method: 'POST', headers: { 'x-test-ip': `198.51.100.${10 + i}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ reason: 'scam', t, website: '' }) });
      expect(r.status).toBe(400);
      expect(r.text).toContain('Please send the form again.');
    }
    expect(s.rows('public_listing_reports')).toHaveLength(0);
    expect(row().status).toBe('live');
  });
});

describe('the hold never brings back a listing that is off the web', () => {
  it('a report against a stale cached row doesn’t hold (or serve) a listing its seller unlisted', async () => {
    const { slug, row } = await liveListing('stale@example.com');
    await report(slug);
    await report(slug);
    // the page is cached as live on this copy; another copy unlists it (straight in the table: no cache drop here)
    expect((await s.visit(`/market/${slug}`)).status).toBe(200);
    Object.assign(row(), { status: 'unlisted', unlisted_at: new Date(s.clock()).toISOString() });
    await s.market.reports.file(await s.market.store.bySlug(slug), { reason: 'scam', hash: 'f'.repeat(64), kind: 'visitor' });
    expect(row()).toMatchObject({ status: 'unlisted', held_at: null });
    s.market.store.drop();
    expect((await s.visit(`/market/${slug}`)).status).toBe(410);
  });

  it('nor one the sweep put over the limit', async () => {
    const { slug, row } = await liveListing('stale2@example.com');
    await report(slug);
    await report(slug);
    await s.visit(`/market/${slug}`);
    row().status = 'over_limit';
    await s.market.reports.file(await s.market.store.bySlug(slug), { reason: 'scam', hash: 'e'.repeat(64), kind: 'visitor' });
    expect(row()).toMatchObject({ status: 'over_limit', held_at: null });
  });

  it('a row with unlisted_at set is gone whatever its status says', async () => {
    const { statusOf } = await import('./quality.mjs');
    expect(statusOf({ status: 'held', held_at: '2026-11-01T00:00:00Z', unlisted_at: '2026-11-02T00:00:00Z' })).toBe('gone');
    expect(statusOf({ status: 'live', unlisted_at: '2026-11-02T00:00:00Z' })).toBe('gone');
    expect(statusOf({ status: 'live', unlisted_at: null })).toBe('live');
  });

  it('unhide keeps a listing over the limit when the seller’s plan has no room for it', async () => {
    const seller = await s.user('full@example.com');
    const ids = [];
    for (const n of ['a1', 'a2', 'a3']) ids.push((await s.put(seller, `lst_${n}`, s.listing(seller, { title: `Stoneware mug number ${n}`, description: `${n} ${s.listing(seller).description}` }))).body.listing.slug);
    const owner = await s.user('boss3@example.com', { isAdmin: true });
    const first = s.rows('public_listings').find((r) => r.slug === ids[0]);
    expect((await s.call(owner, 'POST', `/api/market/admin/listings/${first.id}/hide`, { reason: 'spam' })).status).toBe(200);
    // a fourth goes on the web while the first is hidden (Launch: 3)
    expect((await s.put(seller, 'lst_a4', s.listing(seller, { title: 'Stoneware mug number a4', description: `a4 ${s.listing(seller).description}` }))).status).toBe(201);
    const back = await s.call(owner, 'POST', `/api/market/admin/listings/${first.id}/unhide`);
    expect(back.body).toMatchObject({ ok: true, status: 'over_limit' });
    expect(first.status).toBe('over_limit');
    expect((await s.visit(`/market/${ids[0]}`)).status).toBe(410);
  });
});
