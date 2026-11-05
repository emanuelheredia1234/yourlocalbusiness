// SEO on Google (WP4): the app host's sitemap, robots.txt and verification file; "Submit to Google" for app-host
// pages (one shared submit per 24 h, the inspection budgets, claims before calls) and custom domains (stored
// steps, reads before any resend); exact page filters so customers never see each other's numbers.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createDb } from '../integrations/db.mjs';
import { seoPageIdFor, utcDay } from '../integrations/common.mjs';
import { createSitemapRoutes, robotsTxt, sitemapXml, VERIFICATION_FILE_RE } from './sitemap.mjs';
import { createSeoGoogleRoutes } from './google.mjs';
import { pagePerformance } from './gsc.mjs';
import { createRunner } from '../analytics/runner.mjs';
import { ENV, call, fakeAuth, fakeConnections, fakeTreg, makeStorage, readJson, send, tregError } from '../analytics/test-helpers.mjs';

const APP = 'https://yourlocalbusiness.replit.app';
let supa;
let db;
let A;
let B;
beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  A = (await supa.tokenFor('a@example.com')).user;
  B = (await supa.tokenFor('b@example.com')).user;
});
afterAll(async () => {
  await supa.close();
});
const rows = (t) => supa.tables.get(t) ?? [];
beforeEach(() => {
  for (const t of ['user_docs', 'published_pages', 'published_domains', 'seo_google_steps', 'billing_customers']) supa.tables.set(t, []);
});
function project(userId, id) {
  rows('user_docs').push({ user_id: userId, kind: 'project', id, data: { id, brand: { name: 'x', socials: {} } } });
}
function page(userId, projectId, slug, { domain = null, kind = 'seo', updated = '2026-11-01T00:00:00Z' } = {}) {
  rows('published_pages').push({ slug, user_id: userId, page_id: `${kind}:${projectId}`, kind, title: '', html: '<p/>', images: [], domain, home: false, updated_at: updated });
}

describe('app-host sitemap, robots.txt and verification file', () => {
  it('lists only published sales pages with no custom domain, escaped, and caches for 10 minutes', async () => {
    page(A.id, 'p1', 'joes-bakery');
    page(B.id, 'p2', 'tom-s');
    page(B.id, 'p3', 'on-domain', { domain: 'tom.example' });
    page(A.id, 'p4', 'an-artifact', { kind: 'artifact' });
    let t = 1_000_000;
    const sitemap = createSitemapRoutes({ db, env: ENV, now: () => t });
    const r = await call(sitemap, 'GET', '/sitemap.xml');
    expect(r.handled).toBe(true);
    expect(r.headers['content-type']).toMatch(/application\/xml/);
    expect(r.raw).toContain(`<loc>${APP}/joes-bakery</loc><lastmod>2026-11-01</lastmod>`);
    expect(r.raw).toContain(`<loc>${APP}/tom-s</loc>`);
    expect(r.raw).not.toMatch(/on-domain|an-artifact/);
    page(A.id, 'p5', 'new-page');
    expect((await call(sitemap, 'GET', '/sitemap.xml')).raw).not.toContain('new-page');
    t += 10 * 60_000 + 1;
    expect((await call(sitemap, 'GET', '/sitemap.xml')).raw).toContain('new-page');
    expect(sitemapXml('https://a.example', [{ slug: 'ok-1' }, { slug: 'bad"<slug' }])).not.toContain('bad');
    expect(sitemapXml('https://a&b', [{ slug: 'ok-1' }])).toContain('https://a&amp;b/ok-1');
  });

  it('answers robots.txt and the Google verification file, and leaves everything else alone', async () => {
    const sitemap = createSitemapRoutes({ db, env: { ...ENV, GSC_APP_VERIFICATION_FILE: 'google1a2b3c4d5e6f7a8b.html' } });
    const robots = await call(sitemap, 'GET', '/robots.txt');
    expect(robots.raw).toBe(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${APP}/sitemap.xml\n`);
    expect(robotsTxt('https://x.example')).toContain('Sitemap: https://x.example/sitemap.xml');
    const file = await call(sitemap, 'GET', '/google1a2b3c4d5e6f7a8b.html');
    expect(file.raw).toBe('google-site-verification: google1a2b3c4d5e6f7a8b.html');
    expect((await call(sitemap, 'GET', '/google0000000000000000.html')).handled).toBe(false);
    expect((await call(sitemap, 'GET', '/joes-bakery')).handled).toBe(false);
    expect((await call(sitemap, 'POST', '/robots.txt')).handled).toBe(false);
    expect(VERIFICATION_FILE_RE.test('google1a2b3c4d5e6f7a8b.html')).toBe(true);
    expect(VERIFICATION_FILE_RE.test('google1a2b.html')).toBe(false);
    expect(VERIFICATION_FILE_RE.test('../google1a2b3c4d5e6f7a8b.html')).toBe(false);
    const bad = createSitemapRoutes({ db, env: { ...ENV, GSC_APP_VERIFICATION_FILE: '../../etc/passwd' } });
    expect((await call(bad, 'GET', '/../../etc/passwd')).handled).toBe(false);
  });
});

function gscAnswer(endpointId, request) {
  if (endpointId === 'google-search-console.url_inspection') return { inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed', lastCrawlTime: '2026-11-01T00:00:00Z' } } };
  if (endpointId === 'google-search-console.performance') {
    const url = request.body.dimensionFilterGroups[0].filters[0].expression;
    const clicks = url.startsWith(`${APP}/joes-bakery`) ? 100 : url.startsWith(`${APP}/joe`) ? 1 : 0;
    return { rows: [{ keys: ['2026-11-01'], clicks, impressions: clicks * 10, ctr: 0.1, position: 2 }] };
  }
  return {};
}

function makeRoutes({ treg = fakeTreg(gscAnswer), connections = fakeConnections(), storage = makeStorage(), now = () => Date.now() } = {}) {
  const routes = createSeoGoogleRoutes({ auth: fakeAuth({ a: A, b: B }), db, storage, treg, connections, env: ENV, send, readJson, now });
  return { routes, treg, storage, connections };
}

describe('Submit to Google: app-host pages', () => {
  it('needs confirm and a published page of the user’s own; another user gets 404', async () => {
    project(A.id, 'p1');
    const { routes, treg } = makeRoutes();
    expect((await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1' } })).status).toBe(400);
    expect((await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } })).status).toBe(409);
    page(A.id, 'p1', 'joe');
    expect((await call(routes, 'POST', '/api/seo/google/publish', { token: 'b', body: { projectId: 'p1', confirm: true } })).status).toBe(404);
    expect((await call(routes, 'GET', '/api/seo/google/status?projectId=p1', { token: 'b' })).status).toBe(404);
    expect(treg.calls).toHaveLength(0);
  });

  it('submits the shared sitemap once per 24 h (two presses at once: one submit), then inspects the page', async () => {
    project(A.id, 'p1');
    project(B.id, 'p2');
    page(A.id, 'p1', 'joe');
    page(B.id, 'p2', 'tom');
    const storage = makeStorage({ latencyMs: 5 });
    const { routes, treg } = makeRoutes({ storage });
    const [x, y] = await Promise.all([
      call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } }),
      call(routes, 'POST', '/api/seo/google/publish', { token: 'b', body: { projectId: 'p2', confirm: true } }),
    ]);
    const submits = treg.calls.filter((c) => c.endpointId === 'google-search-console.x.webmasters-sitemaps-submit');
    expect(submits).toHaveLength(1);
    expect(submits[0].request).toEqual({ method: 'PUT', query: { siteUrl: ENV.GSC_APP_PROPERTY, feedpath: `${APP}/sitemap.xml` } });
    expect(submits[0].opts.oneShot).toBe(true);
    const outcomes = [x, y].map((r) => r.body.result.steps[0]);
    expect(outcomes.map((s) => s.outcome).sort()).toEqual(['ok', 'skipped']);
    expect(outcomes.find((s) => s.outcome === 'skipped').alreadySubmittedAt).toEqual(expect.any(String));
    expect(x.body.result.steps[1]).toMatchObject({ step: 'inspect', outcome: 'ok', verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' });
    const inspect = treg.calls.find((c) => c.endpointId === 'google-search-console.url_inspection' && c.ctx.userId === A.id);
    expect(inspect.request.body).toEqual({ inspectionUrl: `${APP}/joe`, siteUrl: ENV.GSC_APP_PROPERTY, languageCode: 'en-US' });
    // a week's wait before the same page is inspected again; status shows the stored result
    const again = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(again.body.result.steps.map((s) => s.outcome)).toEqual(['skipped', 'skipped']);
    expect(treg.calls.filter((c) => c.endpointId === 'google-search-console.url_inspection')).toHaveLength(2);
    const status = await call(routes, 'GET', '/api/seo/google/status?projectId=p1', { token: 'a' });
    expect(status.body.status).toMatchObject({ host: 'app', published: true, verdict: 'NEUTRAL', submittedAt: expect.any(String) });
  });

  it('keeps the submit claim after an unknown outcome and never sends it again by itself', async () => {
    project(A.id, 'p1');
    page(A.id, 'p1', 'joe');
    const treg = fakeTreg((id, req) => {
      if (id.includes('sitemaps-submit')) throw tregError('timeout');
      return gscAnswer(id, req);
    });
    const { routes, storage } = makeRoutes({ treg });
    const r = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(r.body.result.steps[0]).toEqual({ step: 'sitemap', outcome: 'unknown' });
    expect(storage.documents.get('gsc:app:lastSubmit').value.at).toEqual(expect.any(String));
    expect(rows('seo_google_steps').find((s) => s.step === 'sitemap').outcome).toBe('unknown');
    await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(treg.calls.filter((c) => c.endpointId.includes('sitemaps-submit'))).toHaveLength(1);
  });

  it('a refused submit is failed and not retried', async () => {
    project(A.id, 'p1');
    page(A.id, 'p1', 'joe');
    const treg = fakeTreg((id, req) => {
      if (id.includes('sitemaps-submit')) throw tregError('bad_request');
      return gscAnswer(id, req);
    });
    const { routes } = makeRoutes({ treg });
    const r = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(r.body.result.steps[0]).toEqual({ step: 'sitemap', outcome: 'failed' });
    expect(treg.calls.filter((c) => c.endpointId.includes('sitemaps-submit'))).toHaveLength(1);
  });

  it('refuses inspections above 1,500 for the property and 20 per customer; two at once at 1,499 make one call', async () => {
    project(A.id, 'p1');
    project(A.id, 'p2');
    page(A.id, 'p1', 'joe');
    page(A.id, 'p2', 'joe-two');
    const storage = makeStorage({ latencyMs: 3 });
    const day = utcDay(Date.now());
    await storage.put('gsc:app:lastSubmit', { at: new Date().toISOString() });
    await storage.put(`gsc:app:inspect:${day}`, { count: 1499 });
    const { routes, treg } = makeRoutes({ storage });
    const [x, y] = await Promise.all([
      call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } }),
      call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p2', confirm: true } }),
    ]);
    expect(treg.calls.filter((c) => c.endpointId === 'google-search-console.url_inspection')).toHaveLength(1);
    expect([x, y].map((r) => r.body.result.steps[1].detail ?? 'ok').sort()).toEqual(['INSPECTION_QUOTA', 'ok']);
    expect(storage.documents.get(`gsc:app:inspect:${day}`).value.count).toBe(1500);

    // per customer: 20 a day
    supa.tables.set('seo_google_steps', []);
    await storage.put(`gsc:app:inspect:${day}`, { count: 0 }, { ifVersion: storage.documents.get(`gsc:app:inspect:${day}`).updatedAt });
    const tag = rows('billing_customers').find((c) => c.user_id === A.id).customer_tag;
    const key = `gsc:app:inspect:${day}:${tag}`;
    await storage.put(key, { count: 20 }, { ifVersion: storage.documents.get(key).updatedAt });
    const r = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(r.body.result.steps[1]).toEqual({ step: 'inspect', outcome: 'skipped', detail: 'INSPECTION_QUOTA' });
  });
});

describe('Submit to Google: custom domains', () => {
  function domainPage() {
    project(A.id, 'p1');
    rows('published_domains').push({ domain: 'joesbakery.com', user_id: A.id, token: 't', verified_at: '2026-10-01T00:00:00Z' });
    page(A.id, 'p1', 'joe', { domain: 'joesbakery.com' });
  }
  const connected = { google_search_console: { state: 'connected', targetLabel: 'sc-domain:joesbakery.com', targetKind: 'gsc_site' } };

  it('needs Search Console connected', async () => {
    domainPage();
    const { routes } = makeRoutes();
    const r = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_CONNECTED');
  });

  it('shows the DNS record, then verifies, adds the site, submits the sitemap and inspects; later presses skip what is done', async () => {
    domainPage();
    let fail = null;
    const connections = fakeConnections({
      statuses: connected,
      request: async (_u, _p, req) => {
        if (fail && req.path.includes(fail.path)) return fail.res;
        if (req.path === '/siteVerification/v1/token') return { status: 200, body: { method: 'DNS_TXT', token: 'google-site-verification=abc' } };
        if (req.path === '/v1/urlInspection/index:inspect') return { status: 200, body: { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } } } };
        if (req.method === 'GET' && req.path === '/v3/sites') return { status: 200, body: { siteEntry: [] } };
        if (req.method === 'GET' && req.path.endsWith('/sitemaps')) return { status: 200, body: { sitemap: [{ path: 'https://joesbakery.com/sitemap.xml' }] } };
        return { status: 200, body: {} };
      },
    });
    const { routes } = makeRoutes({ connections });
    const first = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(first.body.result).toEqual({ host: 'custom', steps: [{ step: 'verify_token', outcome: 'ok' }], dnsRecord: { type: 'TXT', name: 'joesbakery.com', value: 'google-site-verification=abc' } });

    // Google can't see the record yet: Verify fails, the record is shown again
    fail = { path: 'webResource', res: { status: 400, body: { error: { message: 'secret text' } } } };
    const second = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(second.body.result.steps).toEqual([{ step: 'verify_token', outcome: 'skipped' }, { step: 'verify', outcome: 'failed', detail: 'DNS_RECORD_NOT_FOUND' }]);
    expect(second.raw).not.toContain('secret text');

    // the site add's answer is lost (5xx): unknown, and the press stops there
    fail = { path: '/v3/sites/sc-domain', res: { status: 503, body: null } };
    const third = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(third.body.result.steps.at(-1)).toEqual({ step: 'site_add', outcome: 'unknown' });

    // next press: a read first; not there, so it needs the user's confirmation before sending again
    fail = null;
    const before = connections.calls.filter((c) => c.method === 'PUT' && c.path === '/v3/sites/sc-domain%3Ajoesbakery.com').length;
    const fourth = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(fourth.body.result.steps.at(-1)).toEqual({ step: 'site_add', outcome: 'unknown', detail: 'CONFIRM_RESEND' });
    expect(connections.calls.filter((c) => c.method === 'PUT' && c.path === '/v3/sites/sc-domain%3Ajoesbakery.com')).toHaveLength(before);
    expect(connections.calls.some((c) => c.method === 'GET' && c.path === '/v3/sites')).toBe(true);

    const fifth = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true, resend: true } });
    expect(fifth.body.result.steps).toEqual([
      { step: 'verify_token', outcome: 'skipped' },
      { step: 'verify', outcome: 'skipped' },
      { step: 'site_add', outcome: 'ok' },
      { step: 'sitemap', outcome: 'ok' },
      { step: 'inspect', outcome: 'ok', verdict: 'PASS', coverageState: 'Submitted and indexed' },
    ]);
    const sitemapPut = connections.calls.find((c) => c.method === 'PUT' && c.path.includes('/sitemaps/'));
    expect(sitemapPut.path).toBe(`/v3/sites/sc-domain%3Ajoesbakery.com/sitemaps/${encodeURIComponent('https://joesbakery.com/sitemap.xml')}`);
    expect(sitemapPut.oneShot).toBe(true);
    // every write is one attempt
    for (const c of connections.calls.filter((x) => x.method !== 'GET' && !x.path.includes('urlInspection'))) expect(c.oneShot).toBe(true);

    // an unknown sitemap step that the read shows as there is ok without sending
    supa.tables.get('seo_google_steps').find((s) => s.step === 'sitemap').outcome = 'unknown';
    connections.calls.length = 0;
    const sixth = await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true } });
    expect(sixth.body.result.steps.find((s) => s.step === 'sitemap').outcome).toBe('ok');
    expect(connections.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('Search Console numbers stay per customer', () => {
  it('builds every filter from the page given (exact equals), so joe never sees joes-bakery', async () => {
    const treg = fakeTreg(gscAnswer);
    const runner = createRunner({ treg, connections: fakeConnections(), ctx: { userId: A.id, projectId: 'p1', runId: 'r1', customerTag: 'cust_x' } });
    const joe = await pagePerformance({ runner, page: { url: `${APP}/joe`, host: 'app' }, property: ENV.GSC_APP_PROPERTY, now: Date.now() });
    const bakery = await pagePerformance({ runner, page: { url: `${APP}/joes-bakery`, host: 'app' }, property: ENV.GSC_APP_PROPERTY, now: Date.now() });
    expect(joe.clicks).toBe(2);
    expect(bakery.clicks).toBe(200);
    for (const c of treg.calls) {
      const filters = c.request.body.dimensionFilterGroups.flatMap((g) => g.filters);
      expect(filters).toHaveLength(1);
      expect(filters[0].operator).toBe('equals');
    }
  });

  it('ignores a page URL sent by the browser', async () => {
    project(A.id, 'p1');
    page(A.id, 'p1', 'joe');
    const { routes, treg } = makeRoutes();
    await call(routes, 'POST', '/api/seo/google/publish', { token: 'a', body: { projectId: 'p1', confirm: true, url: `${APP}/someone-else`, siteUrl: 'https://evil.example/' } });
    expect(JSON.stringify(treg.calls)).not.toMatch(/someone-else|evil/);
    expect(seoPageIdFor('p1')).toBe('seo:p1');
  });
});
