// Published pages (server/pages.mjs), mostly through the real ai-server.mjs against the Supabase
// stand-in: pages at https://<app>/<name> in a CSP sandbox, their images, names (format, reserved,
// taken, renamed), unpublishing, the limits, and people's own domains (claimed once, checked, served
// on their Host without the sandbox, home page, robots.txt, sitemap.xml, and never the app or /api).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.mjs';
import { claimable, createPages, imageTypeOf, isPrivateAddress, normalizeDomain, publicOnly } from './pages.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-pages-'));

// small files with the right first bytes (what the server checks; it never decodes the picture)
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(40, 7)]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), Buffer.alloc(40, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(40, 2)]);
const image = (name, mime, bytes) => ({ name, mime, data: bytes.toString('base64') });

const ARTIFACT_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const SEO_CSP = 'sandbox allow-forms allow-popups allow-popups-to-escape-sandbox';
const MIGRATION_HINT = 'Run supabase/migrations/20261103040000_published_pages.sql in Supabase → SQL Editor.';

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
    // content-length: Node frames a DELETE or OPTIONS body only when it's given
    const length = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: u.hostname, port: u.port, path: pathname, method, headers: { ...(host ? { host } : {}), ...length, ...headers } }, (res) => {
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

/**
 * The internet, for the domain check (PAGES_CHECK_BASE): a linked domain reaches the app, as Replit
 * routes it. wrong.example.net answers with another site; moved.example.net redirects elsewhere.
 */
async function startInternet(appPort) {
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '');
    if (host === 'wrong.example.net') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('somebody-elses-site');
    }
    if (host === 'moved.example.net') {
      res.writeHead(301, { location: 'https://elsewhere.example.net/.well-known/ylb-domain-check' });
      return res.end();
    }
    const up = http.request({ host: '127.0.0.1', port: appPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

let supa;
let internet;
let child;
let app;
let alice;
let bob;

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  const port = await freePort();
  internet = await startInternet(port);
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
      PAGES_CHECK_BASE: internet.base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('Publishing pages: on')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`server didn’t start: ${out}`)), 15_000);
  });
  app = { base: `http://127.0.0.1:${port}` };
  alice = await supa.tokenFor('alice@pages.test');
  bob = await supa.tokenFor('bob@pages.test');
}, 30_000);

afterAll(async () => {
  child?.kill();
  await internet?.close();
  await supa?.close();
});

const api = (pathname, { who, method = 'GET', body, headers = {} } = {}) =>
  fetch(`${app.base}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const publish = (who, pageId, fields) =>
  api(`/api/pages/${encodeURIComponent(pageId)}`, { who, method: 'PUT', body: { kind: pageId.split(':')[0], title: 'A page', html: `<!doctype html><title>${pageId}</title><p>Hello from ${pageId}</p>`, images: [], ...fields } });
const get = (pathname, opts) => request(app.base, pathname, opts);
const rowsOf = (table) => supa.tables.get(table) ?? [];

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

  it('stores only text Postgres can keep, and caps the title', async () => {
    const r = await publish(alice, 'artifact:text1', { slug: 'alice-text', html: '<p>a\u0000b \ud83d</p>', title: `${'é'.repeat(299)}😀😀` });
    expect(r.status).toBe(200);
    const row = rowsOf('published_pages').find((p) => p.slug === 'alice-text');
    expect(row.html).toBe('<p>ab �</p>');
    expect(Array.from(row.title)).toHaveLength(300);
    expect(row.title.endsWith('😀')).toBe(true); // whole characters only
  });

  it('serves the images listed with the page, and only those', async () => {
    let r = await publish(alice, 'seo:proj2', {
      slug: 'alice-gallery',
      html: '<img src="/alice-gallery/img/img-1.png" alt="Shop front"><img src="/alice-gallery/img/img-2.jpg" alt="Candles">',
      images: [image('img-1.png', 'image/png', PNG), image('img-2.jpg', 'image/jpeg', JPEG)],
    });
    expect(r.status).toBe(200);
    const folder = `media/${alice.user.id}/published/seo-proj2`;
    expect(supa.objects.get(`${folder}/img-1.png`)?.bytes.equals(PNG)).toBe(true);
    expect(rowsOf('published_pages').find((p) => p.slug === 'alice-gallery').images).toEqual([
      { name: 'img-1.png', mime: 'image/png', size: PNG.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { name: 'img-2.jpg', mime: 'image/jpeg', size: JPEG.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    const pic = await get('/alice-gallery/img/img-1.png');
    expect(pic.status).toBe(200);
    expect(pic.buf.equals(PNG)).toBe(true);
    expect(pic.headers).toMatchObject({ 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
    expect((await get('/alice-gallery/img/img-2.jpg')).headers['content-type']).toBe('image/jpeg');
    // in the folder, but not listed with the page
    supa.objects.set(`${folder}/img-9.png`, { bytes: PNG, type: 'image/png', created: Date.now() });
    expect((await get('/alice-gallery/img/img-9.png')).status).toBe(404);
    expect((await get('/alice-gallery/img/notes.txt')).status).toBe(404);
    // republished without the first image: it goes from storage and stops answering
    r = await publish(alice, 'seo:proj2', { slug: 'alice-gallery', html: '<img src="/alice-gallery/img/img-2.jpg" alt="">', images: [image('img-2.jpg', 'image/jpeg', JPEG)] });
    expect(r.status).toBe(200);
    expect(supa.objects.has(`${folder}/img-1.png`)).toBe(false);
    expect(supa.objects.has(`${folder}/img-9.png`)).toBe(false);
    expect((await get('/alice-gallery/img/img-1.png')).status).toBe(404);
    expect((await get('/alice-gallery/img/img-2.jpg')).status).toBe(200);
  });

  it('serves only the exact image checked at publishing, even if the stored file changes', async () => {
    expect((await publish(alice, 'artifact:gif1', { slug: 'alice-animation', images: [image('img-1.gif', 'image/gif', GIF), image('img-2.webp', 'image/webp', WEBP), image('img-3.png', 'image/png', PNG)] })).status).toBe(200);
    const folder = `media/${alice.user.id}/published/artifact-gif1`;
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
    expect(supa.objects.has(`media/${alice.user.id}/published/seo-gone1/img-1.png`)).toBe(false);
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
  });
});

describe('people’s own domains', () => {
  const at = (host, pathname, opts) => get(pathname, { ...opts, host });

  it('claims a domain once, checks it reaches the app, and serves its pages there without the sandbox', async () => {
    let r = await api('/api/domains', { who: alice, method: 'POST', body: { domain: 'https://Shop.Example.com:443/about' } });
    expect(r.status).toBe(200);
    const claimed = await r.json();
    expect(claimed).toEqual({ domain: 'shop.example.com', token: expect.stringMatching(/^[0-9a-f]{32}$/), verified: false, verifiedAt: null });
    // adding it again changes nothing; someone else can't take it
    expect(await (await api('/api/domains', { who: alice, method: 'POST', body: { domain: 'shop.example.com.' } })).json()).toEqual(claimed);
    r = await api('/api/domains', { who: bob, method: 'POST', body: { domain: 'SHOP.example.com' } });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('DOMAIN_TAKEN');
    for (const domain of ['', 'localhost', '127.0.0.1', '[::1]', 'my-app.replit.app', 'preview.replit.dev', 'shop.localhost', 'not a domain', 'nodot']) {
      r = await api('/api/domains', { who: bob, method: 'POST', body: { domain } });
      expect(r.status, domain).toBe(400);
      expect((await r.json()).code, domain).toBe('BAD_DOMAIN');
    }
    // the app's own address (the host this request was made to)
    r = await get('/api/domains', { host: 'app.mybiz.test', method: 'POST', headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'App.MyBiz.test' }) });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).code).toBe('BAD_DOMAIN');

    // the code the check looks for, on the domain itself
    const code = await at('shop.example.com', '/.well-known/ylb-domain-check');
    expect(code.status).toBe(200);
    expect(code.text).toBe(claimed.token);
    expect(code.headers['cache-control']).toBe('no-store');
    r = await api('/api/domains/shop.example.com/check', { who: alice, method: 'POST' });
    expect(await r.json()).toEqual({ verified: true });
    expect((await (await api('/api/pages', { who: alice })).json()).domains).toEqual([{ domain: 'shop.example.com', token: claimed.token, verified: true, verifiedAt: expect.any(String) }]);
    // bob can't check (or remove) alice's domain
    expect((await api('/api/domains/shop.example.com/check', { who: bob, method: 'POST' })).status).toBe(404);

    // a domain that answers with another site, and one that redirects somewhere else
    await api('/api/domains', { who: alice, method: 'POST', body: { domain: 'wrong.example.net' } });
    expect(await (await api('/api/domains/wrong.example.net/check', { who: alice, method: 'POST' })).json()).toEqual({ verified: false, error: expect.stringContaining('not with this app') });
    await api('/api/domains', { who: alice, method: 'POST', body: { domain: 'moved.example.net' } });
    expect(await (await api('/api/domains/moved.example.net/check', { who: alice, method: 'POST' })).json()).toEqual({ verified: false, error: expect.stringContaining('another address') });

    // a page on the domain
    r = await publish(alice, 'seo:shop1', { slug: 'candle-shop', domain: 'shop.example.com', html: '<!doctype html><h1>Candle shop</h1><img src="/candle-shop/img/img-1.png" alt="">', images: [image('img-1.png', 'image/png', PNG)] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ url: `${app.base}/candle-shop`, domainUrl: 'https://shop.example.com/candle-shop', page: { domain: 'shop.example.com', home: false } });
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
    // a host nobody claimed is the app as usual
    const other = await at('other.example.org', '/api/config');
    expect(asJson(other)).toBe(true);
  });

  it('removing a domain keeps its pages on the app’s address', async () => {
    expect((await api('/api/domains/shop.example.com', { who: bob, method: 'DELETE' })).status).toBe(200); // not his: nothing happens
    expect((await at('shop.example.com', '/candle-shop')).status).toBe(200);
    const { token } = rowsOf('published_domains').find((d) => d.domain === 'shop.example.com');
    const r = await api('/api/domains/shop.example.com', { who: alice, method: 'DELETE' });
    expect(await r.json()).toEqual({ ok: true });
    const list = await (await api('/api/pages', { who: alice })).json();
    expect(list.domains.map((d) => d.domain)).not.toContain('shop.example.com');
    expect(list.pages.find((p) => p.slug === 'scent-quiz')).toMatchObject({ domain: null, home: false });
    expect(list.pages.find((p) => p.slug === 'scent-quiz').domainUrl).toBeUndefined();
    expect((await get('/scent-quiz')).status).toBe(200);
    // the domain is no one's now: it no longer shows them unsandboxed, nor its code
    expect((await at('shop.example.com', '/scent-quiz')).headers['content-security-policy']).toBe(ARTIFACT_CSP);
    expect((await at('shop.example.com', '/.well-known/ylb-domain-check')).text).not.toContain(token);
  });
});

describe('deleting an account', () => {
  it('removes the person’s published pages and their images', async () => {
    const carol = await supa.tokenFor('carol@pages.test');
    expect((await publish(carol, 'seo:c1', { slug: 'carol-bakes', images: [image('img-1.jpg', 'image/jpeg', JPEG)] })).status).toBe(200);
    expect((await api('/api/domains', { who: carol, method: 'POST', body: { domain: 'carol-bakes.example.com' } })).status).toBe(200);
    expect((await get('/carol-bakes')).status).toBe(200);
    supa.objects.set(`media/${carol.user.id}/media_photo1`, { bytes: JPEG, type: 'image/jpeg', created: Date.now() });
    const r = await fetch(`${app.base}/api/account`, { method: 'DELETE', headers: { authorization: `Bearer ${carol.token}` } });
    expect(r.status).toBe(200);
    expect([...supa.objects.keys()].some((k) => k.startsWith(`media/${carol.user.id}/`))).toBe(false);
    expect(rowsOf('published_pages').some((p) => p.user_id === carol.user.id)).toBe(false);
    expect(rowsOf('published_domains').some((d) => d.user_id === carol.user.id)).toBe(false);
    expect((await get('/carol-bakes')).status).toBe(404);
  });
});

// ───────────── the module on its own ─────────────

/** pages.mjs behind a bare server, routed like ai-server.mjs. */
async function startPages({ mock, secretKey, distDir = '' }) {
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
  const pages = createPages({ supabaseUrl: mock.url, secretKey, auth, whoIs, send, readJson, distDir });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (pages.mayBeDomain(req) && (await pages.serveDomain(req, res, url))) return;
    if (pages.matchApi(url)) return pages.handleApi(req, res, url);
    if (pages.matchPage(url) && (await pages.servePage(req, res, url))) return;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('the app');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { pages, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

describe('without the setup', () => {
  it('is off without the secret key, and says so', async () => {
    const s = await startPages({ mock: supa, secretKey: '' });
    try {
      expect(s.pages.config()).toEqual({ enabled: false });
      const r = await fetch(`${s.base}/api/pages`, { headers: { authorization: `Bearer ${alice.token}` } });
      expect(r.status).toBe(503);
      expect((await r.json()).code).toBe('PAGES_OFF');
      // and nothing changes for the app's own paths or hosts
      expect((await request(s.base, '/alice-widget')).text).toBe('the app');
      expect((await request(s.base, '/', { host: 'shop.example.com' })).text).toBe('the app');
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
      // visitors: nothing is published yet, and no host is anyone's domain
      expect((await request(s.base, '/dana-page')).status).toBe(404);
      expect((await request(s.base, '/', { host: 'dana.example.com' })).text).toBe('the app');
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

describe('helpers', () => {
  it('reads a domain the way people type it', () => {
    expect(normalizeDomain(' HTTPS://Shop.Example.com:8443/about?x=1#top ')).toBe('shop.example.com');
    expect(normalizeDomain('user:pw@www.shop.example.com.')).toBe('www.shop.example.com');
    expect(normalizeDomain('bücher.example')).toBe('xn--bcher-kva.example');
    expect(normalizeDomain('')).toBe('');
    expect(claimable('shop.example.com')).toBe(true);
    for (const h of ['localhost', '10.0.0.1', 'app.replit.app', 'x.replit.dev', 'y.repl.co', 'a.localhost', 'nodot', '[::1]']) expect(claimable(h), h).toBe(false);
    expect(claimable('app.mybiz.com', new Set(['app.mybiz.com']))).toBe(false);
  });

  it('knows image types by their first bytes', () => {
    expect(imageTypeOf(PNG)).toBe('image/png');
    expect(imageTypeOf(JPEG)).toBe('image/jpeg');
    expect(imageTypeOf(GIF)).toBe('image/gif');
    expect(imageTypeOf(WEBP)).toBe('image/webp');
    expect(imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(imageTypeOf(Buffer.alloc(4))).toBeNull();
  });

  it('never checks a domain that points at a private address', async () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['34.111.179.208', '2600:1f18::1', '::ffff:8.8.8.8']) expect(isPrivateAddress(a), a).toBe(false);
    // the lookup the check connects with (localhost resolves from the hosts file, no network needed)
    for (const options of [{}, { all: true }]) {
      const err = await new Promise((r) => publicOnly('localhost', options, (e) => r(e)));
      expect(err?.code, JSON.stringify(options)).toBe('EPRIVATE');
    }
  });
});
