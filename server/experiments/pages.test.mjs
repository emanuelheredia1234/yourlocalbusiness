// The SEO page split (P4b §S6): starting it (B's checks: its sha256, its images, the page's form), one per page,
// 50/50 and sticky visitors, tampered cookies, crawlers and HEAD on A without a cookie or a count, `private, no-store`
// with Vary: Cookie on split pages only, the lead token in both versions' forms, people's own domains, stopping and
// republishing, the counters' flush (a failed one kept), and lead attribution (server/leads.mjs): a valid token, a
// forged or another page's token ignored, a B-only form, the own-domain cookie, GET /api/leads, and before the migration.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cookieName } from './pages.mjs';
import { DOMAIN, startExperiments } from './test-helpers.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const page = (label, { form = true, extra = '' } = {}) =>
  `<!doctype html><html><head><title>Joe</title><link rel="canonical" href="https://app.test/joes-bakery"></head><body><h1>${label}</h1>${extra}${form ? '<form method="post" action="/joes-bakery/lead"><input name="email"><button>Send</button></form>' : ''}</body></html>`;
const A = page('Version A');
const B = page('Version B');
let t;
let alice;
let bob;
let ip = 0;

beforeAll(async () => {
  t = await startExperiments();
  alice = await t.user('alice-pages@example.com');
  bob = await t.user('bob-pages@example.com');
  await t.project(alice);
  await t.project(bob);
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.update('experiments', { state: 'running' }, { state: 'stopped' });
  t.mod.split.forgetUser(alice.id);
  t.mod.split.forgetUser(bob.id);
});

const get = (path, { cookie, ua = UA, method = 'GET', host } = {}) => t.raw(path, { method, headers: { 'user-agent': ua, 'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}`, ...(cookie ? { cookie } : {}), ...(host ? { host } : {}) } });
const versionOf = (res) => (res.text.includes('Version B') ? 'b' : res.text.includes('Version A') ? 'a' : null);
const cookieOf = (res) => String(res.headers['set-cookie'] ?? '').split(';')[0];

/** A running split on alice's page (A published first). → the experiment */
async function split({ a = A, b = B } = {}) {
  expect((await t.publishPage(alice, { html: a })).status).toBe(200);
  const made = await t.x(alice, 'POST', '/api/experiments', { projectId: 'proj-1', kind: 'page', mode: 'split', changed: 'headline', subjectRef: 'seo:proj-1', variants: [{ key: 'a', label: 'Now' }, { key: 'b', label: 'New' }] });
  expect(made.status).toBe(201);
  const r = await t.x(alice, 'POST', `/api/experiments/${made.body.experiment.id}/page`, { html: b, sha256: t.sha(b) });
  expect(r.status, r.text).toBe(200);
  expect(r.body.experiment).toMatchObject({ state: 'running', counted: true });
  return r.body.experiment;
}
async function lead(path, { cookie, host, email = 'visitor@example.com' } = {}) {
  return t.raw(path, { method: 'POST', body: `email=${encodeURIComponent(email)}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, 'x-forwarded-for': `203.0.113.${(ip++ % 250) + 1}`, ...(cookie ? { cookie } : {}), ...(host ? { host } : {}) } });
}

describe('starting a split', () => {
  it('checks version B: whole (sha256), only the page’s images, the page’s form; one running split per page', async () => {
    expect((await t.publishPage(alice, { html: A })).status).toBe(200);
    const mk = async () => (await t.x(alice, 'POST', '/api/experiments', { projectId: 'proj-1', kind: 'page', mode: 'split', changed: 'hero', subjectRef: 'seo:proj-1', variants: [{ key: 'a' }, { key: 'b' }] })).body.experiment;
    const e = await mk();
    const start = (html, sha = t.sha(html)) => t.x(alice, 'POST', `/api/experiments/${e.id}/page`, { html, sha256: sha });
    expect((await start(B, 'f'.repeat(64))).status).toBe(400);
    const img = page('Version B', { extra: '<img src="/joes-bakery/img/img-9.png">' });
    const r1 = await start(img);
    expect([r1.status, r1.body.error]).toEqual([400, 'Version B uses an image that isn’t published with the page. Publish the page with both images first.']);
    const r2 = await start(page('Version B', { form: false }));
    expect([r2.status, r2.body.code]).toEqual([400, 'VARIANT_NO_FORM']);
    expect((await t.row(e.id)).state).toBe('draft');
    expect((await start(B)).status).toBe(200);
    const other = await mk();
    const r3 = await t.x(alice, 'POST', `/api/experiments/${other.id}/page`, { html: B, sha256: t.sha(B) });
    expect([r3.status, r3.body.code]).toEqual([409, 'EXPERIMENT_RUNNING']);
    expect((await t.row(other.id)).state).toBe('draft');
    // the version's HTML is never in an answer
    expect((await t.x(alice, 'GET', `/api/experiments/${e.id}`)).text).not.toContain('Version B');
  });
});

describe('serving', () => {
  it('about 50/50 without a cookie, each with a valid cookie; the same version for the same cookie', async () => {
    const e = await split();
    let bs = 0;
    for (let i = 0; i < 2000; i++) {
      const r = await get('/joes-bakery');
      const v = versionOf(r);
      if (v === 'b') bs += 1;
      expect(cookieOf(r)).toMatch(new RegExp(`^${cookieName(e.id)}=${v}\\.[A-Za-z0-9_-]{22}$`));
    }
    expect(bs / 2000).toBeGreaterThan(0.45);
    expect(bs / 2000).toBeLessThan(0.55);
    const first = await get('/joes-bakery');
    const c = cookieOf(first);
    for (let i = 0; i < 50; i++) {
      const r = await get('/joes-bakery', { cookie: c });
      expect(versionOf(r)).toBe(versionOf(first));
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    // a tampered cookie is assigned again
    const forged = `${cookieName(e.id)}=b.${'A'.repeat(22)}`;
    expect((await get('/joes-bakery', { cookie: forged })).headers['set-cookie']).toBeDefined();
  });

  it('`private, no-store` and Vary: Cookie on a split page only; crawlers and HEAD get A with no cookie and no count', async () => {
    const e = await split();
    const r = await get('/joes-bakery');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.headers.vary).toBe('Cookie');
    expect(String(r.headers['set-cookie'])).toMatch(/; Path=\/; Max-Age=7776000; HttpOnly; SameSite=Lax$/);
    // Secure everywhere but this machine
    expect(String((await get('/joes-bakery', { host: 'ylb.replit.app' })).headers['set-cookie'])).toMatch(/; SameSite=Lax; Secure$/);
    expect(r.headers['content-security-policy']).toMatch(/^sandbox /);
    await t.mod.split.flush();
    const before = (await t.variantRows(e.id)).map((v) => [v.visitors, v.views]);
    for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)', '']) {
      const bot = await get('/joes-bakery', { ua });
      expect(versionOf(bot)).toBe('a');
      expect(bot.headers['set-cookie']).toBeUndefined();
    }
    const head = await get('/joes-bakery', { method: 'HEAD' });
    expect(head.headers['set-cookie']).toBeUndefined();
    expect(head.headers['cache-control']).toBe('private, no-store');
    await t.mod.split.flush();
    expect((await t.variantRows(e.id)).map((v) => [v.visitors, v.views])).toEqual(before);
    // bob's page has no split: as always
    expect((await t.publishPage(bob, { slug: 'bobs-shop', html: page('Bob') })).status).toBe(200);
    const plain = await get('/bobs-shop');
    expect(plain.headers['cache-control']).toBe('public, max-age=60');
    expect(plain.headers.vary).toBeUndefined();
    expect(plain.headers['set-cookie']).toBeUndefined();
  });

  it('both versions’ forms carry the lead token; stopping serves A to everyone again', async () => {
    const e = await split();
    const seen = {};
    for (let i = 0; i < 40 && Object.keys(seen).length < 2; i++) {
      const r = await get('/joes-bakery');
      seen[versionOf(r)] = r.text;
    }
    for (const key of ['a', 'b']) expect(seen[key]).toContain(`action="/joes-bakery/lead?xv=${t.mod.split.tokenOf(e.id, key)}"`);
    expect((await t.x(alice, 'POST', `/api/experiments/${e.id}/stop`)).body.experiment.state).toBe('stopped');
    for (let i = 0; i < 10; i++) {
      const r = await get('/joes-bakery');
      expect(versionOf(r)).toBe('a');
      expect(r.headers['cache-control']).toBe('public, max-age=60');
    }
  });

  it('on the page’s own domain too', async () => {
    await t.domain(alice);
    expect((await t.publishPage(alice, { html: A, domain: DOMAIN })).status).toBe(200);
    const made = await t.x(alice, 'POST', '/api/experiments', { projectId: 'proj-1', kind: 'page', mode: 'split', changed: 'cta', subjectRef: 'seo:proj-1', variants: [{ key: 'a' }, { key: 'b' }] });
    expect((await t.x(alice, 'POST', `/api/experiments/${made.body.experiment.id}/page`, { html: B, sha256: t.sha(B) })).status).toBe(200);
    const versions = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await get('/joes-bakery', { host: DOMAIN });
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('private, no-store');
      expect(r.headers['content-security-policy']).toBeUndefined();
      versions.add(versionOf(r));
    }
    expect([...versions].sort()).toEqual(['a', 'b']);
  });

  it('republishing the page (a new A) stops its split', async () => {
    const e = await split();
    expect((await t.publishPage(alice, { html: page('Version A2') })).status).toBe(200);
    expect(await t.row(e.id)).toMatchObject({ state: 'stopped', result: { reason: 'page_changed' } });
    const after = await get('/joes-bakery');
    expect(after.text).toContain('Version A2');
    expect(after.headers['set-cookie']).toBeUndefined();
  });
});

describe('Use the winner', () => {
  it('B won: the split ends and the page is republished with B (its form as it was); A won: the split ends', async () => {
    const e = await split();
    await t.db.update('experiments', { id: e.id }, { result: { verdict: 'winner', winner: 'b', lift: 25, metric: 'lead_rate' } });
    const r = await t.x(alice, 'POST', `/api/experiments/${e.id}/winner`, { key: 'b' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.experiment).toMatchObject({ state: 'finished', winner: 'b' });
    expect(r.body.learning.summary).toBe('headlines: “New” beat “Now” on the page: +25% leads');
    for (let i = 0; i < 5; i++) {
      const v = await get('/joes-bakery');
      expect(versionOf(v)).toBe('b');
      expect(v.headers['cache-control']).toBe('public, max-age=60');
      expect(v.text).toContain('action="/joes-bakery/lead"');
    }
    // republishing B didn't count as a new A stopping anything: the test stays finished with its winner
    expect(await t.row(e.id)).toMatchObject({ state: 'finished', winner: 'b' });
    const e2 = await split();
    await t.db.update('experiments', { id: e2.id }, { result: { verdict: 'winner', winner: 'a', metric: 'lead_rate' } });
    expect((await t.x(alice, 'POST', `/api/experiments/${e2.id}/winner`, { key: 'a' })).body.experiment.state).toBe('finished');
    expect(versionOf(await get('/joes-bakery'))).toBe('a');
  });
});

describe('counters', () => {
  it('flush through ylb_experiment_add_counts; a failed flush is kept for the next one', async () => {
    const e = await split();
    await t.mod.split.flush();
    t.supa.behavior.fail = (method, pathname) => (pathname === '/rest/v1/rpc/ylb_experiment_add_counts' ? { status: 503, body: { message: 'down' } } : null);
    for (let i = 0; i < 10; i++) await get('/joes-bakery');
    expect((await t.mod.split.flush()).flushed).toBe(0);
    t.supa.behavior.fail = null;
    expect((await t.mod.split.flush()).flushed).toBeGreaterThan(0);
    const vs = await t.variantRows(e.id);
    expect(vs.reduce((n, v) => n + v.views, 0)).toBe(10);
    expect(vs.reduce((n, v) => n + v.visitors, 0)).toBe(10);
  });
});

describe('lead attribution', () => {
  it('a valid token records the version and counts the lead; a forged, another page’s or another user’s token is ignored and the lead kept', async () => {
    const e = await split();
    const tokenB = t.mod.split.tokenOf(e.id, 'b');
    expect((await lead(`/joes-bakery/lead?xv=${tokenB}`, { email: 'b@example.com' })).status).toBe(200);
    await t.mod.split.flush();
    const rows = await t.db.select('page_leads', { user_id: alice.id, email: 'b@example.com' });
    expect(rows[0]).toMatchObject({ experiment_id: e.id, variant_key: 'b' });
    expect((await t.variantRows(e.id))[1].leads).toBe(1);
    const forged = `${e.id}.b.${'A'.repeat(22)}`;
    expect((await lead(`/joes-bakery/lead?xv=${forged}`, { email: 'forged@example.com' })).status).toBe(200);
    const [forgedRow] = await t.db.select('page_leads', { email: 'forged@example.com' });
    expect(forgedRow.user_id).toBe(alice.id);
    expect([forgedRow.experiment_id ?? null, forgedRow.variant_key ?? null]).toEqual([null, null]);
    // bob's page with a token of alice's split
    expect((await t.publishPage(bob, { slug: 'bobs-shop', html: page('Bob').replaceAll('/joes-bakery/lead', '/bobs-shop/lead') })).status).toBe(200);
    expect((await lead(`/bobs-shop/lead?xv=${tokenB}`, { email: 'cross@example.com' })).status).toBe(200);
    const [cross] = await t.db.select('page_leads', { email: 'cross@example.com' });
    expect([cross.user_id, cross.experiment_id ?? null]).toEqual([bob.id, null]);
    // GET /api/leads shows the version
    const listed = (await t.x(alice, 'GET', '/api/leads')).body.leads.find((l) => l.email === 'b@example.com');
    expect(listed).toMatchObject({ experimentId: e.id, variantKey: 'b' });
  });

  it('a form only in B is taken with B’s token and refused without one', async () => {
    const e = await split({ a: page('Version A', { form: false }), b: B });
    const ok = await lead(`/joes-bakery/lead?xv=${t.mod.split.tokenOf(e.id, 'b')}`, { email: 'bonly@example.com' });
    expect(ok.status).toBe(200);
    expect((await t.db.select('page_leads', { email: 'bonly@example.com' }))[0]).toMatchObject({ variant_key: 'b' });
    const none = await lead('/joes-bakery/lead', { email: 'none@example.com' });
    expect(none.status).toBe(404);
    expect(await t.db.select('page_leads', { email: 'none@example.com' })).toEqual([]);
  });

  it('on the page’s own domain the cookie is enough', async () => {
    await t.domain(alice);
    expect((await t.publishPage(alice, { html: A, domain: DOMAIN })).status).toBe(200);
    const made = await t.x(alice, 'POST', '/api/experiments', { projectId: 'proj-1', kind: 'page', mode: 'split', changed: 'cta', subjectRef: 'seo:proj-1', variants: [{ key: 'a' }, { key: 'b' }] });
    await t.x(alice, 'POST', `/api/experiments/${made.body.experiment.id}/page`, { html: B, sha256: t.sha(B) });
    const visit = await get('/joes-bakery', { host: DOMAIN });
    const key = versionOf(visit);
    expect((await lead('/joes-bakery/lead', { host: DOMAIN, cookie: cookieOf(visit), email: 'cookie@example.com' })).status).toBe(200);
    expect((await t.db.select('page_leads', { email: 'cookie@example.com' }))[0]).toMatchObject({ experiment_id: made.body.experiment.id, variant_key: key });
  });

  it('before the migration (no version columns) the lead is still kept', async () => {
    const e = await split();
    let refused = 0;
    t.supa.behavior.fail = (method, pathname) => {
      if (method === 'POST' && pathname === '/rest/v1/page_leads' && refused === 0) {
        refused += 1;
        return { status: 400, body: { code: 'PGRST204', message: "Could not find the 'experiment_id' column of 'page_leads' in the schema cache" } };
      }
      return null;
    };
    expect((await lead(`/joes-bakery/lead?xv=${t.mod.split.tokenOf(e.id, 'a')}`, { email: 'legacy@example.com' })).status).toBe(200);
    t.supa.behavior.fail = null;
    expect(refused).toBe(1);
    const [row] = await t.db.select('page_leads', { email: 'legacy@example.com' });
    expect(row).toMatchObject({ user_id: alice.id, source: 'page' });
    expect(row.experiment_id).toBeUndefined();
  });
});
