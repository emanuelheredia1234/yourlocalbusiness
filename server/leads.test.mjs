// Lead forms (server/leads.mjs, wired up in pages.mjs and ai-server.mjs), mostly through the real ai-server.mjs
// against the Supabase stand-in: a visitor sends a published page's form, on the app's address or the page's own
// domain; the server keeps it for the page's owner and answers with a small thank-you page, or says what to fix.
// Owners list and delete their leads (/api/leads). Then the limits, a missing table, Supabase down, and the parts
// on their own: every input is bounded before a pattern looks at it, and the page's HTML is scanned, not matched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.mjs';
import { createPages } from './pages.mjs';
import { LEAD_PAYLOAD_MAX, hasLeadForm, leadLimitsFromEnv, readLeadExtras, readLeadFields, visitorKey, visitorOf } from './leads.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-leads-'));

const NOTICE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const LEADS_HINT = 'Run supabase/migrations/20261103050000_page_leads.sql in Supabase → SQL Editor.';

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** Any request, with any Host header (fetch can't set one). */
function request(base, pathname, { host, method = 'GET', headers = {}, body } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const length = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: u.hostname, port: u.port, path: pathname, method, headers: { ...(host ? { host } : {}), ...length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

let supa;
let child;
let app;
let alice;
let bob;

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  const port = await freePort();
  child = spawn(process.execPath, [path.join(here, 'ai-server.mjs')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: tmpDir(),
      SUPABASE_URL: supa.url,
      SUPABASE_PUBLISHABLE_KEY: supa.PUBLISHABLE,
      SUPABASE_SECRET_KEY: supa.SECRET,
      ADMIN_EMAILS: 'owner@example.com',
      RATE_LIMIT_PER_MIN: '1000',
      LEADS_PER_IP_PER_HOUR: '1000',
      LEADS_PER_PAGE_PER_HOUR: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('Lead forms: on')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`server didn’t start: ${out}`)), 15_000);
  });
  app = { base: `http://127.0.0.1:${port}` };
  alice = await supa.tokenFor('alice@leads.test');
  bob = await supa.tokenFor('bob@leads.test');
}, 30_000);

afterAll(async () => {
  child?.kill();
  await supa?.close();
});

const api = (pathname, { who, method = 'GET', body, headers = {} } = {}) =>
  fetch(`${app.base}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const publish = (who, pageId, fields) =>
  api(`/api/pages/${encodeURIComponent(pageId)}`, { who, method: 'PUT', body: { kind: pageId.split(':')[0], title: 'A page', html: `<!doctype html><title>${pageId}</title><p>Hello from ${pageId}</p>`, images: [], ...fields } });
const get = (pathname, opts) => request(app.base, pathname, opts);
const rowsOf = (table) => supa.tables.get(table) ?? [];
const leadsOf = (who) => rowsOf('page_leads').filter((r) => r.user_id === who.user.id);

/** A page with the form the builder writes when it publishes at /<slug>. */
const withForm = (slug, extra = '') =>
  `<!doctype html><title>${slug}</title><h1>Hello</h1>${extra}<form method="post" action="/${slug}/lead" enctype="application/x-www-form-urlencoded"><input name="name" maxlength="120"><input name="email" type="email"><input name="phone" type="tel"><input name="time"><textarea name="message" maxlength="2000"></textarea><input name="website" tabindex="-1" autocomplete="off"><button>Send</button></form>`;
const form = (fields) => new URLSearchParams(fields).toString();
const postLead = (pathname, fields, { base = app.base, host, headers = {} } = {}) =>
  request(base, pathname, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, host, body: typeof fields === 'string' ? fields : form(fields) });

/** One of alice's domains, already verified (as the domain check leaves it). */
function addVerifiedDomain(who, domain) {
  if (!supa.tables.has('published_domains')) supa.tables.set('published_domains', []);
  const now = new Date().toISOString();
  supa.tables.get('published_domains').push({ domain, user_id: who.user.id, token: `ylb-${'0a'.repeat(20)}`, verified_at: now, created_at: now });
}

describe('a published page’s form', () => {
  it('keeps what a visitor sends, for the page’s owner, and says thank you', async () => {
    expect((await publish(alice, 'seo:lead1', { slug: 'alice-leads', html: withForm('alice-leads') })).status).toBe(200);
    const r = await postLead('/alice-leads/lead', { name: 'Ann', email: 'ann@example.com', message: 'Hi' });
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': NOTICE_CSP, 'x-content-type-options': 'nosniff' });
    expect(r.text).toContain('<h1>Thank you</h1>');
    expect(r.text).toContain('Your message was sent.');
    expect(r.text).toContain('<a href="/alice-leads">Back to the page</a>');
    expect(r.text.toLowerCase()).not.toContain('yourlocalbusiness');
    const rows = leadsOf(alice);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), user_id: alice.user.id, page_id: 'seo:lead1', slug: 'alice-leads', name: 'Ann', email: 'ann@example.com', phone: '', message: 'Hi', time: '', created_at: expect.any(String) });
    expect(Number.isNaN(Date.parse(rows[0].created_at))).toBe(false);
    expect(rows[0]).not.toHaveProperty('website');
  });

  it('takes the form from anywhere: the sandboxed page (Origin: null) and a downloaded copy', async () => {
    const before = leadsOf(alice).length;
    for (const origin of ['null', 'https://elsewhere.example']) expect((await postLead('/alice-leads/lead', { email: `from-${origin.length}@example.com` }, { headers: { origin } })).status, origin).toBe(200);
    expect(leadsOf(alice).length).toBe(before + 2);
  });

  it('tidies what was typed, and never repeats it on the answer', async () => {
    const r = await postLead('/alice-leads/lead', { name: ' Ann \t Lee\u0007 ', email: ' ann.lee@example.com ', message: 'Line 1\r\n\r\n\r\n\r\nLine 2  <script>x()</script>\u0000' });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('<script>');
    expect(r.text).not.toContain('Ann Lee');
    expect(leadsOf(alice).at(-1)).toMatchObject({ name: 'Ann Lee', email: 'ann.lee@example.com', message: 'Line 1\n\nLine 2 <script>x()</script>' });
    // spaces that go don't count against the limit, unless there are far too many
    expect((await postLead('/alice-leads/lead', { name: `${' '.repeat(300)}Bo${' '.repeat(100)}`, email: 'bo@example.com' })).status).toBe(200);
    expect(leadsOf(alice).at(-1).name).toBe('Bo');
  });

  it('says thank you to the hidden field’s bots, and keeps nothing', async () => {
    const before = rowsOf('page_leads').length;
    const r = await postLead('/alice-leads/lead', { name: 'Bot', email: 'bot@example.com', website: 'x' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('Thank you');
    expect(rowsOf('page_leads').length).toBe(before);
  });

  it('refuses what it can’t keep, and says what to fix', async () => {
    const before = rowsOf('page_leads').length;
    const cases = [
      [{ name: 'Ann', message: 'No way to reply' }, 400, 'Add your email or phone'],
      [{ email: 'nope' }, 400, 'Check your email'],
      [{ email: 'ann@example.com', phone: '12' }, 400, 'Check your phone number'],
      [{ phone: '555-0100 ext. 2' }, 400, 'Check your phone number'],
      [{ name: 'a'.repeat(121), email: 'ann@example.com' }, 400, 'That’s too long'],
      [{ name: '😀'.repeat(121), email: 'ann@example.com' }, 400, 'That’s too long'],
      [{ email: 'ann@example.com', message: 'x'.repeat(2001) }, 400, 'That’s too long'],
      // far over a field's limit: refused without being tidied
      [{ name: `${'a'.repeat(100)}${' '.repeat(400)}`, email: 'ann@example.com' }, 400, 'That’s too long'],
      [{ email: `${'a'.repeat(5000)}@example.com` }, 400, 'That’s too long'],
      [{ email: 'ann@example.com', message: 'x'.repeat(17_000) }, 413, 'That’s too long to send'],
    ];
    for (const [fields, status, title] of cases) {
      const r = await postLead('/alice-leads/lead', fields);
      const label = JSON.stringify(fields).slice(0, 60);
      expect(r.status, label).toBe(status);
      expect(r.text, label).toContain(title);
      expect(r.text, label).not.toContain('Thank');
      expect(r.headers['content-security-policy'], label).toBe(NOTICE_CSP);
    }
    // not a form
    let r = await get('/alice-leads/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ann@example.com' }) });
    expect(r.status).toBe(415);
    expect(r.text).toContain('This form couldn’t be read');
    // too much, without saying how much up front
    r = await new Promise((resolve, reject) => {
      const u = new URL(app.base);
      const req = http.request({ host: u.hostname, port: u.port, path: '/alice-leads/lead', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.write(`email=ann%40example.com&message=${'y'.repeat(9000)}`);
      req.end('y'.repeat(9000));
    });
    expect(r.status).toBe(413);
    expect(r.text).toContain('That’s too long to send');
    expect(rowsOf('page_leads').length).toBe(before);
  });

  it('a booking request: a phone number and a preferred time, which isn’t a booked time', async () => {
    const r = await postLead('/alice-leads/lead', { name: 'Bo', phone: '+1 512 555 0100', time: 'Tuesday morning' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('Your request was sent. This is a request, not a booked time.');
    expect(leadsOf(alice).at(-1)).toMatchObject({ name: 'Bo', email: '', phone: '+1 512 555 0100', time: 'Tuesday morning' });
  });

  it('only for a published page with a form that posts there', async () => {
    expect((await publish(alice, 'seo:noform1', { slug: 'alice-no-form' })).status).toBe(200);
    expect((await publish(alice, 'artifact:noform1', { slug: 'alice-artifact-form' })).status).toBe(200);
    // a form that posts to another page's address, and an action that isn't the form's, don't count
    expect((await publish(alice, 'seo:otherform1', { slug: 'alice-other-form', html: withForm('alice-leads') })).status).toBe(200);
    expect((await publish(alice, 'seo:tricky1', { slug: 'alice-tricky', html: '<form method="post" data-action="/alice-tricky/lead"><input name="email"></form><p>action="/alice-tricky/lead"</p>' })).status).toBe(200);
    const before = rowsOf('page_leads').length;
    for (const p of ['/nobody-published-this/lead', '/alice-no-form/lead', '/alice-artifact-form/lead', '/alice-other-form/lead', '/alice-tricky/lead']) {
      const r = await postLead(p, { email: 'ann@example.com' });
      expect(r.status, p).toBe(404);
      expect(r.text, p).toContain('Page not found');
    }
    // one of the app's own names: the app's own path, which takes no posts
    const own = await postLead('/login/lead', { email: 'ann@example.com' });
    expect(own.status).toBe(405);
    expect(own.text).not.toContain('Thank');
    expect(rowsOf('page_leads').length).toBe(before);
    // reading the address isn't sending a form: it answers like any other path that isn't a page
    const read = await get('/alice-leads/lead');
    expect(read.status).toBe((await get('/alice-leads/somewhere')).status);
    expect(read.text).not.toContain('Thank');
  });

  it('on the owner’s own domain, for that domain’s pages only', async () => {
    addVerifiedDomain(alice, 'shop.example.com');
    expect((await publish(alice, 'seo:shop1', { slug: 'candle-shop', domain: 'shop.example.com', html: withForm('candle-shop') })).status).toBe(200);
    let r = await postLead('/candle-shop/lead', { name: 'Cy', email: 'cy@example.com' }, { host: 'shop.example.com' });
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toBe(NOTICE_CSP);
    expect(r.text).toContain('<a href="/candle-shop">Back to the page</a>');
    expect(r.text.toLowerCase()).not.toContain('yourlocalbusiness');
    expect(leadsOf(alice).at(-1)).toMatchObject({ page_id: 'seo:shop1', slug: 'candle-shop', email: 'cy@example.com' });
    // the domain's home page: back to /
    expect((await publish(alice, 'seo:shop1', { slug: 'candle-shop', domain: 'shop.example.com', home: true, html: withForm('candle-shop') })).status).toBe(200);
    r = await postLead('/candle-shop/lead', { email: 'cy@example.com' }, { host: 'shop.example.com' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('<a href="/">Back to the page</a>');
    // any other method is still refused there
    expect((await request(app.base, '/candle-shop/lead', { host: 'shop.example.com', method: 'PUT', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=cy%40example.com' })).status).toBe(405);
    // bob's pages aren't on alice's domain, even one whose row says so
    expect((await publish(bob, 'seo:bobform1', { slug: 'bob-form-page', html: withForm('bob-form-page') })).status).toBe(200);
    expect((await publish(bob, 'seo:bobform2', { slug: 'bob-form-two', html: withForm('bob-form-two') })).status).toBe(200);
    rowsOf('published_pages').find((p) => p.slug === 'bob-form-two').domain = 'shop.example.com';
    const before = rowsOf('page_leads').length;
    for (const p of ['/bob-form-page/lead', '/bob-form-two/lead', '/login/lead', '/alice-leads/lead']) {
      r = await postLead(p, { email: 'cy@example.com' }, { host: 'shop.example.com' });
      expect(r.status, p).toBe(404);
      expect(r.text.toLowerCase(), p).not.toContain('yourlocalbusiness');
    }
    expect(rowsOf('page_leads').length).toBe(before);
    // on the app's address, bob's page takes its own leads
    expect((await postLead('/bob-form-page/lead', { email: 'cy@example.com' })).status).toBe(200);
    expect(leadsOf(bob)).toHaveLength(1);
  });
});

describe('every kind of form reaches Leads', () => {
  const json = { accept: 'application/json' };

  it('an artifact with a real form takes leads, tagged as an asset; one without a form doesn’t', async () => {
    expect((await publish(alice, 'artifact:quiz1', { slug: 'alice-quiz', html: withForm('alice-quiz', '<script>/* a quiz */</script>') })).status).toBe(200);
    const r = await postLead('/alice-quiz/lead', { email: 'quiz@example.com', kind: 'quiz', result: 'You’re a sourdough person', score: '8', answers: 'Q1: Crust\nQ2: Tang' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('Thank you');
    expect(leadsOf(alice).at(-1)).toMatchObject({ page_id: 'artifact:quiz1', slug: 'alice-quiz', source: 'asset', kind: 'quiz', consent: false, payload: { result: 'You’re a sourdough person', score: '8', answers: 'Q1: Crust\nQ2: Tang' } });
    // an artifact's default kind is 'lead'; an SEO page's is 'form', with its business from its id
    expect((await postLead('/alice-quiz/lead', { email: 'plain@example.com' })).status).toBe(200);
    expect(leadsOf(alice).at(-1)).toMatchObject({ source: 'asset', kind: 'lead', payload: {} });
    expect((await postLead('/alice-leads/lead', { email: 'seo@example.com' })).status).toBe(200);
    expect(leadsOf(alice).at(-1)).toMatchObject({ source: 'page', kind: 'form', project_id: 'lead1' });
  });

  it('source comes from the page, never from the form; kind only from the list', async () => {
    const cases = [
      [{ source: 'magnet', kind: 'booking' }, 'asset', 'booking'],
      [{ source: 'page', kind: 'magnet' }, 'asset', 'lead'],
      [{ kind: 'evil' }, 'asset', 'lead'],
      [{ kind: `quiz${'x'.repeat(5000)}` }, 'asset', 'lead'],
    ];
    for (const [extra, source, kind] of cases) {
      expect((await postLead('/alice-quiz/lead', { email: 'k@example.com', ...extra })).status, JSON.stringify(extra).slice(0, 40)).toBe(200);
      expect(leadsOf(alice).at(-1), JSON.stringify(extra).slice(0, 40)).toMatchObject({ source, kind });
    }
  });

  it('consent is only a ticked box (consent=yes)', async () => {
    for (const [value, want] of [['yes', true], ['on', false], ['true', false], ['YES', false], ['', false]]) {
      expect((await postLead('/alice-quiz/lead', { email: 'c@example.com', consent: value })).status, value).toBe(200);
      expect(leadsOf(alice).at(-1).consent, value).toBe(want);
    }
  });

  it('result fields: one character over is refused, never cut; unknown keys are ignored', async () => {
    const before = rowsOf('page_leads').length;
    for (const [key, max] of Object.entries(LEAD_PAYLOAD_MAX)) {
      if (key === 'score') continue;
      const r = await postLead('/alice-quiz/lead', { email: 'p@example.com', [key]: 'x'.repeat(max + 1) });
      expect(r.status, key).toBe(400);
      expect(r.text, key).toContain('That’s too long');
    }
    for (const score of ['12345678', 'ten', '1.234', '1e5']) {
      const r = await postLead('/alice-quiz/lead', { email: 'p@example.com', score });
      expect(r.status, score).toBe(400);
    }
    expect(rowsOf('page_leads').length).toBe(before);
    expect((await postLead('/alice-quiz/lead', { email: 'p@example.com', result: 'x'.repeat(200), score: '-12.5', admin: 'yes', user_id: bob.user.id, payload: '{"a":1}' })).status).toBe(200);
    const last = leadsOf(alice).at(-1);
    expect(last.payload).toEqual({ result: 'x'.repeat(200), score: '-12.5' });
    expect(last.user_id).toBe(alice.user.id);
  });

  it('a widget may ask for JSON: CORS *, no cookies, and nothing but its own answer', async () => {
    let r = await postLead('/alice-quiz/lead', { email: 'w@example.com', kind: 'calculator', inputs: 'Rooms: 3', outputs: 'About $450' }, { headers: { ...json, origin: 'null' } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(JSON.parse(r.text)).toEqual({ ok: true, title: 'Thank you', text: 'Your message was sent.' });
    expect(leadsOf(alice).at(-1)).toMatchObject({ kind: 'calculator', payload: { inputs: 'Rooms: 3', outputs: 'About $450' } });
    r = await postLead('/alice-quiz/lead', { name: 'No contact' }, { headers: json });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, title: 'Add your email or phone' });
    r = await postLead('/nobody-published-this/lead', { email: 'w@example.com' }, { headers: json });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, title: 'Page not found' });
    // without the header: the HTML notice, as plain form posts and SEO pages get
    r = await postLead('/alice-quiz/lead', { email: 'w@example.com' });
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the leads API', () => {
  it('lists each owner’s own leads, newest first, a page at a time', async () => {
    let r = await api('/api/leads', { who: alice });
    expect(r.status).toBe(200);
    const { leads } = await r.json();
    const mine = leadsOf(alice).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
    expect(leads.map((l) => l.id)).toEqual(mine.map((x) => x.id));
    expect(leads[0]).toEqual({ id: mine[0].id, pageId: mine[0].page_id, slug: mine[0].slug, projectId: mine[0].project_id ?? null, source: mine[0].source ?? 'page', kind: mine[0].kind ?? 'form', consent: mine[0].consent === true, payload: mine[0].payload ?? {}, name: mine[0].name, email: mine[0].email, phone: mine[0].phone, message: mine[0].message, time: mine[0].time, createdAt: mine[0].created_at });
    expect(leads.some((l) => l.slug === 'bob-form-page')).toBe(false);

    // times as Postgres sends them back (microseconds, +00:00): passed on exactly
    const times = ['2026-01-01T00:00:01.000001+00:00', '2026-01-01T00:00:02.000002+00:00', '2026-01-01T00:00:03.000003+00:00'];
    for (const [i, t] of times.entries()) rowsOf('page_leads').push({ id: `00000000-0000-4000-8000-00000000000${i}`, user_id: alice.user.id, slug: 'alice-paging', page_id: 'seo:paging1', name: `P${i}`, email: `p${i}@example.com`, phone: '', message: '', time: '', created_at: t });
    const page = async (before) => (await (await api(`/api/leads?pageId=${encodeURIComponent('seo:paging1')}&limit=1${before ? `&before=${encodeURIComponent(before)}` : ''}`, { who: alice })).json()).leads;
    const seen = [];
    let next = await page('');
    while (next.length && seen.length < 10) {
      seen.push(next[0].name);
      next = await page(next[0].createdAt);
    }
    expect(seen).toEqual(['P2', 'P1', 'P0']);
    // one page's leads
    r = await api(`/api/leads?pageId=${encodeURIComponent('seo:lead1')}`, { who: alice });
    const one = (await r.json()).leads;
    expect(one.length).toBeGreaterThan(3);
    expect(one.every((l) => l.pageId === 'seo:lead1')).toBe(true);
    // what isn't read: bad times and page ids, and ones too long to look at
    for (const q of ['before=yesterday', 'before=2026-01-01', `before=${encodeURIComponent('2026-01-01T00:00:01 00:00')}`, `before=${encodeURIComponent(`2026-01-01T00:00:01.000001+00:00${'0'.repeat(5000)}`)}`, 'pageId=notes%3Ax', `pageId=seo%3A${'a'.repeat(5000)}`]) {
      r = await api(`/api/leads?${q}`, { who: alice });
      expect(r.status, q.slice(0, 60)).toBe(400);
      expect((await r.json()).code, q.slice(0, 60)).toBe('BAD_REQUEST');
    }
    // 1 to 100 at a time
    expect((await (await api('/api/leads?limit=0', { who: alice })).json()).leads.length).toBe(Math.min(50, leadsOf(alice).length));
    expect((await (await api('/api/leads?limit=2', { who: alice })).json()).leads.length).toBe(2);
    // bob sees only his; signed out and other sites are refused
    expect((await (await api('/api/leads', { who: bob })).json()).leads.map((l) => l.slug)).toEqual(['bob-form-page']);
    r = await api('/api/leads');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'Sign in to see your leads.', code: 'AUTH_REQUIRED' });
    expect((await api('/api/leads', { who: alice, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    for (const p of ['/api/leads/', '/api/leads/check', `/api/leads/${mine[0].id}/x`, `/api/leads/${'a'.repeat(3000)}`]) expect((await api(p, { who: alice })).status, p.slice(0, 60)).toBe(404);
    expect((await api('/api/leads', { who: alice, method: 'POST', body: {} })).status).toBe(405);
  });

  it('filters by business, source and kind: own rows only, and bad values are refused', async () => {
    const list = async (q, who = alice) => (await (await api(`/api/leads?limit=100&${q}`, { who })).json()).leads;
    const quiz = await list('kind=quiz');
    expect(quiz.length).toBeGreaterThan(0);
    expect(quiz.every((l) => l.kind === 'quiz' && l.source === 'asset')).toBe(true);
    expect(quiz[0].payload).toMatchObject({ result: 'You’re a sourdough person' });
    expect((await list('source=asset')).every((l) => l.source === 'asset')).toBe(true);
    expect((await list('source=page')).every((l) => l.source === 'page')).toBe(true);
    const business = await list('projectId=lead1');
    expect(business.length).toBeGreaterThan(0);
    expect(business.every((l) => l.projectId === 'lead1')).toBe(true);
    // bob asking for alice's business gets nothing of hers
    expect(await list('projectId=lead1', bob)).toEqual([]);
    expect(await list('kind=quiz', bob)).toEqual([]);
    for (const q of ['source=email', 'kind=survey', 'projectId=a%20b', `projectId=${'a'.repeat(81)}`, 'pageId=magnet%3Ax%2Fy']) {
      const r = await api(`/api/leads?${q}`, { who: alice });
      expect(r.status, q).toBe(400);
    }
    expect((await api('/api/leads?pageId=magnet%3AAAAAAAAAAAAAAAAAAAAAAA', { who: alice })).status).toBe(200);
  });

  it('deletes a lead for its owner only', async () => {
    const target = leadsOf(alice)[0];
    let r = await api(`/api/leads/${target.id}`, { who: bob, method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(rowsOf('page_leads').some((x) => x.id === target.id)).toBe(true);
    r = await api(`/api/leads/${target.id}`, { who: alice, method: 'DELETE' });
    expect(await r.json()).toEqual({ ok: true });
    expect(rowsOf('page_leads').some((x) => x.id === target.id)).toBe(false);
    // already gone counts as done
    expect((await api(`/api/leads/${target.id}`, { who: alice, method: 'DELETE' })).status).toBe(200);
    for (const id of ['not-a-lead', `${target.id}0`, '%E0%A4%A']) {
      r = await api(`/api/leads/${id}`, { who: alice, method: 'DELETE' });
      expect(r.status, id).toBe(id.startsWith('%') ? 400 : 404);
    }
    expect((await api(`/api/leads/${leadsOf(alice)[0].id}`, { who: alice })).status).toBe(405);
  });

  it('deleting an account deletes its leads', async () => {
    const carol = await supa.tokenFor('carol@leads.test');
    expect((await publish(carol, 'seo:c1', { slug: 'carol-bakes', html: withForm('carol-bakes') })).status).toBe(200);
    expect((await postLead('/carol-bakes/lead', { name: 'Dee', email: 'dee@example.com', message: 'A cake for Friday?' })).status).toBe(200);
    expect(leadsOf(carol)).toHaveLength(1);
    const r = await fetch(`${app.base}/api/account`, { method: 'DELETE', headers: { authorization: `Bearer ${carol.token}` } });
    expect(r.status).toBe(200);
    expect(rowsOf('page_leads').some((l) => l.user_id === carol.user.id)).toBe(false);
    expect((await postLead('/carol-bakes/lead', { email: 'dee@example.com' })).status).toBe(404);
  });
});

// ───────────── the module behind a bare server ─────────────

/** pages.mjs (with its leads) behind a bare server, routed like ai-server.mjs on the app's own address. */
async function startPages({ mock, secretKey, leadLimits }) {
  const auth = createAuth({ supabaseUrl: mock.url, publishableKey: mock.PUBLISHABLE });
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(JSON.parse(raw || '{}')));
    });
  const whoIs = async (req) => (req.headers.authorization ? { who: await auth.identify(req) } : { who: null });
  const pages = createPages({ supabaseUrl: mock.url, secretKey, auth, whoIs, send, readJson, leadLimits });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'POST' && pages.matchLead(url)) return void pages.receiveLead(req, res, url).then((h) => h || (res.writeHead(405), res.end()));
    if (pages.matchApi(url)) return pages.handleApi(req, res, url);
    if (pages.matchPage(url) && (await pages.servePage(req, res, url))) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not a page');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

describe('limits', () => {
  const limited = () => startPages({ mock: supa, secretKey: supa.SECRET, leadLimits: { perIp: 2, perPage: 3, windowMs: 3_600_000 } });
  const send = (s, xff, email = 'lim@example.com') => postLead('/alice-leads/lead', { email }, { base: s.base, headers: xff ? { 'x-forwarded-for': xff } : {} });

  it('one visitor: the third form in an hour waits, the hidden field’s included', async () => {
    const s = await limited();
    try {
      expect((await send(s)).status).toBe(200);
      expect((await postLead('/alice-leads/lead', { email: 'bot@example.com', website: 'x' }, { base: s.base })).status).toBe(200);
      const r = await send(s);
      expect(r.status).toBe(429);
      expect(r.text).toContain('Please wait a little');
      expect(r.text).toContain('Too many messages were sent from here');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(3000);
    } finally {
      await s.close();
    }
  });

  it('behind the host’s proxy, visitors are told apart, and the page takes three', async () => {
    const s = await limited();
    try {
      for (const n of [1, 2, 3]) expect((await send(s, `203.0.113.${n}`)).status, String(n)).toBe(200);
      const r = await send(s, '203.0.113.4');
      expect(r.status).toBe(429);
      expect(r.text).toContain('This page got a lot of messages in the last hour');
    } finally {
      await s.close();
    }
  });

  it('the left part of X-Forwarded-For is whatever the visitor said: the address the proxy added counts', async () => {
    const s = await limited();
    try {
      const statuses = [];
      for (const fake of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) statuses.push((await send(s, `${fake}, 198.51.100.7`)).status);
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      await s.close();
    }
  });

  it('an IPv6 visitor is one /64', async () => {
    const s = await limited();
    try {
      expect((await send(s, '2001:db8:1:2::1')).status).toBe(200);
      expect((await send(s, '2001:db8:1:2:ffff::9')).status).toBe(200);
      expect((await send(s, '2001:db8:1:2::3')).status).toBe(429);
      expect((await send(s, '2001:db8:1:3::1')).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe('without the setup', () => {
  it('without the leads table, a form never says it was sent, and Leads names the file to run', async () => {
    const bare = await (await createMockSupabase({ missingTables: ['page_leads'] })).start();
    const s = await startPages({ mock: bare, secretKey: bare.SECRET });
    try {
      const erin = await bare.tokenFor('erin@leads.test');
      const auth = { authorization: `Bearer ${erin.token}`, 'content-type': 'application/json' };
      let r = await fetch(`${s.base}/api/pages/${encodeURIComponent('seo:e1')}`, { method: 'PUT', headers: auth, body: JSON.stringify({ kind: 'seo', slug: 'erin-page', title: 'Erin', html: withForm('erin-page'), images: [] }) });
      expect(r.status).toBe(200);
      const sent = await postLead('/erin-page/lead', { email: 'fay@example.com' }, { base: s.base });
      expect(sent.status).toBe(503);
      expect(sent.text).toContain('Your message wasn’t sent');
      expect(sent.text).not.toContain('Thank');
      r = await fetch(`${s.base}/api/leads`, { headers: auth });
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: LEADS_HINT, code: 'LEADS_TABLE' });
      r = await fetch(`${s.base}/api/leads/00000000-0000-4000-8000-000000000001`, { method: 'DELETE', headers: auth });
      expect((await r.json()).code).toBe('LEADS_TABLE');
      // publishing itself still works
      r = await fetch(`${s.base}/api/pages`, { headers: auth });
      expect(r.status).toBe(200);
      expect((await r.json()).pages.map((p) => p.slug)).toEqual(['erin-page']);
    } finally {
      await s.close();
      await bare.close();
    }
  });

  it('before the P2 migration, a page’s form is still kept, without the new columns', async () => {
    const s = await startPages({ mock: supa, secretKey: supa.SECRET });
    let refused = 0;
    supa.behavior.fail = (method, pathname) => {
      if (method !== 'POST' || pathname !== '/rest/v1/page_leads' || refused) return null;
      refused++;
      return { status: 400, body: { code: 'PGRST204', message: "Could not find the 'source' column of 'page_leads' in the schema cache" } };
    };
    try {
      const before = rowsOf('page_leads').length;
      const r = await postLead('/alice-leads/lead', { email: 'old-db@example.com', kind: 'lead' }, { base: s.base });
      expect(r.status).toBe(200);
      expect(refused).toBe(1);
      expect(rowsOf('page_leads').length).toBe(before + 1);
      const row = rowsOf('page_leads').at(-1);
      expect(row.email).toBe('old-db@example.com');
      expect(row).not.toHaveProperty('source');
      // filtering on the new columns names the file to run
      supa.behavior.fail = (method, pathname, q) => (pathname === '/rest/v1/page_leads' && String(q.get('select')).includes('source') ? { status: 400, body: { code: '42703', message: 'column page_leads.source does not exist' } } : null);
      let res = await fetch(`${s.base}/api/leads?source=page`, { headers: { authorization: `Bearer ${alice.token}` } });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('LEADS_MIGRATION');
      res = await fetch(`${s.base}/api/leads`, { headers: { authorization: `Bearer ${alice.token}` } });
      expect(res.status).toBe(200);
      expect((await res.json()).leads.length).toBeGreaterThan(0);
    } finally {
      supa.behavior.fail = null;
      await s.close();
    }
  });

  it('a form never says it was sent while Supabase is down', async () => {
    const s = await startPages({ mock: supa, secretKey: supa.SECRET });
    try {
      // the page is known (cached) when Supabase stops answering, so only the insert fails
      expect((await request(s.base, '/alice-leads')).status).toBe(200);
      const before = rowsOf('page_leads').length;
      supa.behavior.down = true;
      const r = await postLead('/alice-leads/lead', { email: 'gus@example.com' }, { base: s.base });
      supa.behavior.down = false;
      expect(r.status).toBe(503);
      expect(r.text).toContain('Your message wasn’t sent');
      expect(rowsOf('page_leads').length).toBe(before);
    } finally {
      supa.behavior.down = false;
      await s.close();
    }
  });

  it('with publishing off, there are no forms to send and no leads to read', async () => {
    const s = await startPages({ mock: supa, secretKey: '' });
    try {
      expect((await postLead('/alice-leads/lead', { email: 'hal@example.com' }, { base: s.base })).status).toBe(404);
      const r = await fetch(`${s.base}/api/leads`, { headers: { authorization: `Bearer ${alice.token}` } });
      expect(r.status).toBe(503);
      expect((await r.json()).code).toBe('PAGES_OFF');
    } finally {
      await s.close();
    }
  });
});

describe('the parts on their own', () => {
  it('finds the builder’s form in the page, and nothing that only looks like one', () => {
    expect(hasLeadForm(withForm('maya-bakes'), 'maya-bakes')).toBe(true);
    expect(hasLeadForm('<FORM><form\naction="/maya-bakes/lead">', 'maya-bakes')).toBe(true);
    expect(hasLeadForm('<form method="post"action="/maya-bakes/lead">', 'maya-bakes')).toBe(true);
    for (const html of [
      '',
      '<p>No form</p>',
      withForm('someone-else'),
      '<formula action="/maya-bakes/lead">',
      '<form data-action="/maya-bakes/lead">',
      '<form method="post">x</form> action="/maya-bakes/lead"',
      '<form action="/maya-bakes/lead"',
      '<form action="/maya-bakes/leads">',
    ])
      expect(hasLeadForm(html, 'maya-bakes'), html).toBe(false);
    expect(hasLeadForm(undefined, 'maya-bakes')).toBe(false);
    expect(hasLeadForm({ html: withForm('maya-bakes') }, 'maya-bakes')).toBe(false);
  });

  it('scans a big page quickly, whatever it holds', () => {
    const big = 1_500_000;
    const A = 'action="/maya-bakes/lead"';
    const cases = [
      // a tag that never ends
      `<form ${'a'.repeat(big)}${A}`,
      // the shape that makes /<form\b[^>]*\baction=/ slow: many <form in one tag, the action after it
      `${'<form '.repeat(big / 6)}>${A}`,
      // many tags, the action outside them
      `${'<form x>'.repeat(big / 8)}${A}`,
      // one tag full of near misses
      `<form ${`x${A}`.repeat(big / 26)}>`,
    ];
    for (const html of cases) {
      const t = performance.now();
      expect(hasLeadForm(html, 'maya-bakes')).toBe(false);
      expect(performance.now() - t, html.slice(0, 20)).toBeLessThan(500);
    }
    const t = performance.now();
    expect(hasLeadForm(`${'<p>x</p>'.repeat(big / 8)}${withForm('maya-bakes')}`, 'maya-bakes')).toBe(true);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('bounds every field before a pattern looks at it', () => {
    const read = (fields) => readLeadFields(new URLSearchParams(fields));
    expect(read({ name: ' Ann ', email: 'ann@example.com' })).toEqual({ fields: { name: 'Ann', email: 'ann@example.com', phone: '', message: '', time: '' } });
    expect(read({ phone: '(512) 555-0100' }).fields.phone).toBe('(512) 555-0100');
    expect(read({}).problem).toBe('noContact');
    // what would make a pattern work hard is refused by its length first, quickly
    const t = performance.now();
    for (const [key, n] of [['email', 2000], ['phone', 200], ['name', 600], ['time', 600], ['message', 9000]]) {
      const v = key === 'email' ? `${'a@'.repeat(n / 2)}` : ' \t'.repeat(n / 2);
      expect(read({ email: 'ann@example.com', [key]: v }).problem, key).toBe('tooLong');
    }
    expect(read({ email: `${'a.'.repeat(60)}@${'b.'.repeat(60)}` }).problem).toBe('badEmail');
    expect(read({ email: 'ann@example.com', phone: `${'1('.repeat(19)}` }).problem).toBe('badPhone');
    expect(performance.now() - t).toBeLessThan(200);
  });

  it('reads only the whitelisted extras', () => {
    const read = (fields) => readLeadExtras(new URLSearchParams(fields));
    expect(read({})).toEqual({ extras: { kind: null, consent: false, magnet: null, payload: {} } });
    expect(read({ kind: 'roi', consent: 'yes', magnet: 'A'.repeat(22), service: ' Deep  clean ', other: 'x' })).toEqual({ extras: { kind: 'roi', consent: true, magnet: 'A'.repeat(22), payload: { service: 'Deep clean' } } });
    expect(read({ magnet: 'A'.repeat(23) }).extras.magnet).toBeNull();
    expect(read({ magnet: '../'.repeat(8) }).extras.magnet).toBeNull();
    expect(read({ answers: 'a\r\nb' }).extras.payload.answers).toBe('a\nb');
    expect(read({ outputs: ' \t'.repeat(4000) }).problem).toBe('tooLong');
  });

  it('tells visitors apart by the address the host’s proxy saw', () => {
    const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
    // a public peer is the visitor, whatever it forwards
    expect(visitorOf(req('203.0.113.9', '198.51.100.1'))).toBe('203.0.113.9');
    expect(visitorOf(req('::ffff:203.0.113.9'))).toBe('203.0.113.9');
    // behind a private proxy: the rightmost public address it forwarded for
    expect(visitorOf(req('10.0.0.5', '1.1.1.1, 198.51.100.7, 10.0.0.2'))).toBe('198.51.100.7');
    expect(visitorOf(req('127.0.0.1', 'nonsense, 192.168.1.1'))).toBe('127.0.0.1');
    expect(visitorOf(req('127.0.0.1'))).toBe('127.0.0.1');
    // only the end of a long header is read
    expect(visitorOf(req('10.0.0.5', `${'9.9.9.9, '.repeat(20_000)}198.51.100.8`))).toBe('198.51.100.8');
    expect(visitorOf(req('10.0.0.5', `${'x'.repeat(50_000)}`))).toBe('10.0.0.5');
    // IPv6: one /64
    expect(visitorKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(visitorKey('2001:0db8:0001:0002:ffff:0:0:9')).toBe('2001:db8:1:2::/64');
    expect(visitorKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(visitorKey('::ffff:198.51.100.3')).toBe('198.51.100.3');
  });

  it('reads the limits from the environment', () => {
    expect(leadLimitsFromEnv({})).toEqual({ perIp: 10, perPage: 30, windowMs: 3_600_000 });
    expect(leadLimitsFromEnv({ LEADS_PER_IP_PER_HOUR: '1000', LEADS_PER_PAGE_PER_HOUR: '5' })).toEqual({ perIp: 1000, perPage: 5, windowMs: 3_600_000 });
    expect(leadLimitsFromEnv({ LEADS_PER_IP_PER_HOUR: '0', LEADS_PER_PAGE_PER_HOUR: 'lots' })).toEqual({ perIp: 10, perPage: 30, windowMs: 3_600_000 });
  });
});
