// Publishing a page: names and domains are cleaned the way the server wants them, the fingerprint only
// changes when the page does, images get their published addresses, and the server's answers and
// refusals become plain results and messages.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, PromptImage } from './types';

vi.mock('./promptImages', async (original) => ({
  ...(await original<typeof import('./promptImages')>()),
  // redrawing images needs a browser: stand in with one small file per used key
  imagesForPublish: vi.fn(async (images: PromptImage[], keys: string[]) => images.filter((i) => keys.includes(i.key)).map((i) => ({ name: `${i.key}.jpg`, mime: 'image/jpeg', data: 'AAAA', hash: 'h' }))),
}));

const pub = await import('./publish');
const { buildHash, fingerprint, isValidDomain, isValidSlug, normalizeDomain, preparePublish, publishTarget, publishedImagePaths, slugFrom, typedSlug } = pub;

const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0 });
const img = (key: string, id = `media_${key}`): PromptImage => ({ key, media: media(id) });

describe('page names', () => {
  it('are made from any text: lower-case letters, digits and single hyphens', () => {
    expect(slugFrom('Maya’s Bakery & Café')).toBe('mayas-bakery-and-cafe');
    expect(slugFrom('  ROI calculator -- 2026!! ')).toBe('roi-calculator-2026');
    expect(slugFrom('Crème brûlée class')).toBe('creme-brulee-class');
  });

  it('are 3 to 60 characters, cut at a word break', () => {
    const long = slugFrom('The complete beginner friendly guide to home cleaning services in Austin Texas');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toBe('the-complete-beginner-friendly-guide-to-home-cleaning');
    expect(slugFrom('x'.repeat(80))).toHaveLength(60);
    expect(slugFrom('Hi')).toBe('hi-page');
    expect(slugFrom('Q')).toBe('q-page');
    expect(slugFrom('')).toBe('');
    expect(slugFrom('★★★')).toBe('');
    for (const s of [long, slugFrom('Hi'), slugFrom('x'.repeat(80)), slugFrom('Maya’s Bakery & Café')]) expect(isValidSlug(s)).toBe(true);
  });

  it('can end in a hyphen only while it’s being typed', () => {
    expect(typedSlug('My Page')).toBe('my-page');
    expect(typedSlug('my-')).toBe('my-');
    expect(typedSlug('--my--page')).toBe('my-page');
    expect(typedSlug('Été_2026')).toBe('ete-2026');
    expect(typedSlug('a'.repeat(70))).toHaveLength(60);
  });

  it('are checked the way the server checks them', () => {
    expect(isValidSlug('menu')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('a'.repeat(61))).toBe(false);
    expect(isValidSlug('-menu')).toBe(false);
    expect(isValidSlug('menu-')).toBe(false);
    expect(isValidSlug('my--menu')).toBe(false);
    expect(isValidSlug('Menu')).toBe(false);
    expect(isValidSlug('menu.html')).toBe(false);
  });
});

describe('domains', () => {
  it('are reduced to the name the owner means', () => {
    expect(normalizeDomain('HTTPS://Shop.Example.com:443/menu?x=1#top')).toBe('shop.example.com');
    expect(normalizeDomain('  www.example.com.  ')).toBe('www.example.com');
    expect(normalizeDomain('example.com/about')).toBe('example.com');
    expect(normalizeDomain('http://user:pass@example.co.uk:8080')).toBe('example.co.uk');
    expect(normalizeDomain('例え.jp')).toBe('xn--r8jz45g.jp');
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain('not a domain')).toBe('');
  });

  it('must look like a real domain', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('shop.my-brand.co.uk')).toBe(true);
    expect(isValidDomain('localhost')).toBe(false);
    expect(isValidDomain('203.0.113.9')).toBe(false);
    expect(isValidDomain('-bad.com')).toBe(false);
    expect(isValidDomain(`${'a'.repeat(64)}.com`)).toBe(false);
  });
});

describe('where a publish goes', () => {
  it('is the app’s address, and the domain’s when there is one (canonical: the domain’s)', () => {
    expect(publishTarget('https://app.example/', 'menu')).toEqual({ slug: 'menu', url: 'https://app.example/menu', canonical: 'https://app.example/menu', origin: 'https://app.example' });
    expect(publishTarget('https://app.example', 'menu', 'mybakery.com')).toMatchObject({ url: 'https://app.example/menu', domainUrl: 'https://mybakery.com/menu', canonical: 'https://mybakery.com/menu', origin: 'https://mybakery.com' });
    expect(publishTarget('https://app.example', 'menu', 'mybakery.com', true).domainUrl).toBe('https://mybakery.com/');
    expect(publishTarget('https://app.example', 'menu', null, true).domainUrl).toBeUndefined();
    expect(publishTarget('', 'menu').origin).toBe('');
  });
});

describe('fingerprints', () => {
  it('are the same for the same text and differ when it changes', () => {
    expect(fingerprint('hello')).toBe(fingerprint('hello'));
    expect(fingerprint('hello')).not.toBe(fingerprint('hellp'));
    expect(fingerprint('')).toMatch(/^[0-9a-z]+-0$/);
    expect(fingerprint('a'.repeat(1000))).not.toBe(fingerprint('a'.repeat(1001)));
  });

  it('of a build change with the page or the file behind a token it uses, not with anything else', () => {
    const html = '<h1>Menu</h1><img src="{{img-2}}">';
    const images = [img('img-1'), img('img-2')];
    const h = buildHash(html, images);
    expect(buildHash(html, [...images].reverse())).toBe(h);
    // an image the page doesn't use, or its note, doesn't count
    expect(buildHash(html, [img('img-2'), { ...img('img-1', 'media_other'), note: 'new' }])).toBe(h);
    expect(buildHash(html, [{ ...img('img-2'), note: 'shop front' }])).toBe(h);
    // a different file behind the same token does
    expect(buildHash(html, [img('img-2', 'media_new')])).not.toBe(h);
    expect(buildHash('<h1>Menus</h1><img src="{{img-2}}">', images)).not.toBe(h);
    expect(buildHash(html)).not.toBe(h);
  });
});

describe('getting a build ready to publish', () => {
  it('turns each token into its image’s address on the page, and one for a removed image into nothing', async () => {
    const build = { html: '<img src="{{img-1}}"><div style="background:url({{img-3}})"></div><img src="{{img-9}}">', images: [img('img-1'), img('img-2'), img('img-3')] };
    const out = await preparePublish(build, 'menu');
    expect(out.html).toBe('<img src="/menu/img/img-1.jpg"><div style="background:url(/menu/img/img-3.jpg)"></div><img src="">');
    expect(out.images.map((i) => i.name)).toEqual(['img-1.jpg', 'img-3.jpg']);
    expect(out.hash).toBe(buildHash(build.html, build.images));
    expect(publishedImagePaths('menu', [{ name: 'img-12.png' }])).toEqual({ 'img-12': '/menu/img/img-12.png' });
  });

  it('sends no images for a page without tokens', async () => {
    const out = await preparePublish({ html: '<p>Hi</p>', images: [img('img-1')] }, 'hi-page');
    expect(out).toMatchObject({ html: '<p>Hi</p>', images: [] });
  });
});

// ───────────── the server's API ─────────────

type Call = { url: string; method: string; body: unknown; headers: Headers };
const calls: Call[] = [];
let answer: (c: Call) => Response = () => new Response('{}');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init: RequestInit = {}) => {
    const c: Call = { url: String(url), method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, headers: new Headers(init.headers) };
    calls.push(c);
    return answer(c);
  }),
);

afterEach(() => {
  calls.length = 0;
  answer = () => new Response('{}');
});

describe('the publishing API', () => {
  it('says whether the server publishes pages', async () => {
    answer = () => json(200, { accounts: { enabled: true }, pages: { enabled: true } });
    expect(await pub.publishConfig(true)).toEqual({ enabled: true, reachable: true });
    expect(calls[0].url).toBe('/api/config');
    answer = () => json(200, { accounts: { enabled: false } });
    expect(await pub.publishConfig(true)).toEqual({ enabled: false, reachable: true });
    answer = () => new Response('Not found', { status: 404 });
    expect(await pub.publishConfig(true)).toEqual({ enabled: false, reachable: true });
    answer = () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await pub.publishConfig(true)).toEqual({ enabled: false, reachable: false });
    // couldn't reach it: the next look asks again
    answer = () => json(200, { pages: { enabled: true } });
    expect(await pub.publishConfig()).toEqual({ enabled: true, reachable: true });
  });

  it('lists pages and domains in the app’s shapes', async () => {
    answer = () =>
      json(200, {
        pages: [
          { pageId: 'seo:proj_1', kind: 'seo', slug: 'menu', title: 'Menu', domain: null, home: false, updatedAt: '2026-11-03T10:00:00.000Z', url: 'https://app.example/menu' },
          { pageId: 'artifact:code_1', kind: 'artifact', slug: 'calc', title: 'Calc', domain: 'mybakery.com', home: true, updatedAt: 1700000000000, url: 'https://app.example/calc', domainUrl: 'https://mybakery.com/' },
          { pageId: 'bad id', slug: 'x' },
        ],
        domains: [{ domain: 'mybakery.com', token: 't0k', verified: true, verifiedAt: '2026-11-02T00:00:00Z' }, { domain: 'new.example', token: 't1', verified: false, verifiedAt: null }],
        appOrigin: 'https://app.example/',
      });
    const list = await pub.listPublished();
    expect(calls[0]).toMatchObject({ url: '/api/pages', method: 'GET' });
    expect(list.appOrigin).toBe('https://app.example');
    expect(list.pages).toEqual([
      { pageId: 'seo:proj_1', kind: 'seo', slug: 'menu', title: 'Menu', home: false, updatedAt: Date.parse('2026-11-03T10:00:00.000Z'), url: 'https://app.example/menu' },
      { pageId: 'artifact:code_1', kind: 'artifact', slug: 'calc', title: 'Calc', domain: 'mybakery.com', home: true, updatedAt: 1700000000000, url: 'https://app.example/calc', domainUrl: 'https://mybakery.com/' },
    ]);
    expect(list.domains).toEqual([
      { domain: 'mybakery.com', token: 't0k', verified: true, verifiedAt: Date.parse('2026-11-02T00:00:00Z') },
      { domain: 'new.example', token: 't1', verified: false, verifiedAt: null },
    ]);
  });

  it('checks a name, without asking when it can’t be one', async () => {
    expect(await pub.checkSlug('ab', 'seo:proj_1')).toEqual({ ok: false, reason: 'format' });
    expect(calls).toHaveLength(0);
    answer = () => json(200, { ok: true });
    expect(await pub.checkSlug('my-menu', 'seo:proj_1')).toEqual({ ok: true });
    expect(calls[0].url).toBe('/api/pages/check?slug=my-menu&pageId=seo%3Aproj_1');
    answer = () => json(200, { ok: false, reason: 'reserved' });
    expect(await pub.checkSlug('settings', 'seo:proj_1')).toEqual({ ok: false, reason: 'reserved' });
    answer = () => json(200, { ok: false, reason: 'taken' });
    expect(await pub.checkSlug('menu', 'seo:proj_1')).toEqual({ ok: false, reason: 'taken' });
  });

  it('publishes a page and returns what to keep with it', async () => {
    answer = () => json(200, { page: { pageId: 'seo:proj_1', kind: 'seo', slug: 'menu', title: 'Menu', domain: 'mybakery.com', home: true, updatedAt: 1, url: 'https://app.example/menu', domainUrl: 'https://mybakery.com/' }, url: 'https://app.example/menu', domainUrl: 'https://mybakery.com/' });
    const images = [{ name: 'img-1.jpg', mime: 'image/jpeg' as const, data: 'AAAA', hash: 'x' }];
    const p = await pub.publishPage({ pageId: 'seo:proj_1', kind: 'seo', slug: 'menu', title: '  Menu  ', html: '<p>Hi</p>', images, domain: 'mybakery.com', home: true, hash: 'abc' });
    expect(calls[0]).toMatchObject({ url: '/api/pages/seo:proj_1', method: 'PUT' });
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(calls[0].body).toEqual({ kind: 'seo', slug: 'menu', title: 'Menu', html: '<p>Hi</p>', images: [{ name: 'img-1.jpg', mime: 'image/jpeg', data: 'AAAA' }], domain: 'mybakery.com', home: true });
    expect(p).toMatchObject({ slug: 'menu', domain: 'mybakery.com', home: true, url: 'https://app.example/menu', domainUrl: 'https://mybakery.com/', hash: 'abc' });
    expect(p.publishedAt).toBeGreaterThan(0);
  });

  it('never asks for a home page without a domain', async () => {
    answer = () => json(200, { page: { pageId: 'artifact:code_1', kind: 'artifact', slug: 'calc', title: 'Calc', domain: null, home: false, updatedAt: 1, url: 'https://app.example/calc' }, url: 'https://app.example/calc' });
    const p = await pub.publishPage({ pageId: 'artifact:code_1', kind: 'artifact', slug: 'calc', title: 'Calc', html: '<p>x</p>', images: [], domain: '', home: true });
    expect(calls[0].body).toMatchObject({ domain: null, home: false });
    expect(p).not.toHaveProperty('domain');
    expect(p).not.toHaveProperty('home');
    expect(p.hash).toBe(fingerprint('<p>x</p>\n'));
  });

  it('refuses what the server would refuse before sending it', async () => {
    const base = { pageId: 'seo:proj_1', kind: 'seo' as const, slug: 'menu', title: 'Menu', html: '<p>x</p>', images: [] };
    await expect(pub.publishPage({ ...base, slug: 'm' })).rejects.toMatchObject({ code: 'BAD_SLUG' });
    await expect(pub.publishPage({ ...base, html: 'x'.repeat(1_500_001) })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(pub.publishPage({ ...base, pageId: 'seo:bad id' })).rejects.toMatchObject({ code: 'BAD_PAGE_ID' });
    expect(calls).toHaveLength(0);
  });

  it('turns the server’s refusals into plain messages', async () => {
    const base = { pageId: 'seo:proj_1', kind: 'seo' as const, slug: 'menu', title: 'Menu', html: '<p>x</p>', images: [] };
    answer = () => json(409, { error: 'Slug taken', code: 'SLUG_TAKEN' });
    await expect(pub.publishPage(base)).rejects.toMatchObject({ code: 'SLUG_TAKEN', status: 409, message: 'That name is already taken. Try another one.' });
    answer = () => json(503, { error: 'Run supabase/migrations/20261103040000_published_pages.sql in Supabase → SQL Editor.', code: 'PAGES_TABLES' });
    await expect(pub.publishPage(base)).rejects.toMatchObject({ code: 'PAGES_TABLES', message: 'Run supabase/migrations/20261103040000_published_pages.sql in Supabase → SQL Editor.' });
    answer = () => new Response('busy', { status: 429 });
    await expect(pub.publishPage(base)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    answer = () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(pub.publishPage(base)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('unpublishes, and a page that’s already gone counts as done', async () => {
    answer = () => json(200, { ok: true });
    await pub.unpublishPage('artifact:code_1');
    expect(calls[0]).toMatchObject({ url: '/api/pages/artifact:code_1', method: 'DELETE' });
    answer = () => json(404, { error: 'Not found' });
    await expect(pub.unpublishPage('artifact:code_1')).resolves.toBeUndefined();
    answer = () => json(500, { error: 'Boom' });
    await expect(pub.unpublishPage('artifact:code_1')).rejects.toMatchObject({ message: 'Boom' });
  });

  it('adds, checks and removes domains', async () => {
    await expect(pub.addDomain('not a domain')).rejects.toMatchObject({ code: 'BAD_DOMAIN' });
    expect(calls).toHaveLength(0);
    answer = () => json(200, { domain: 'mybakery.com', token: 'tok', verified: false });
    expect(await pub.addDomain('https://MyBakery.com/menu')).toEqual({ domain: 'mybakery.com', token: 'tok', verified: false, verifiedAt: null });
    expect(calls[0]).toMatchObject({ url: '/api/domains', method: 'POST', body: { domain: 'mybakery.com' } });
    answer = () => json(409, { error: 'Taken', code: 'DOMAIN_TAKEN' });
    await expect(pub.addDomain('mybakery.com')).rejects.toMatchObject({ message: 'Someone else has already added that domain to their account.' });
    answer = () => json(200, { verified: false, error: 'It didn’t answer.' });
    expect(await pub.checkDomain('mybakery.com')).toEqual({ verified: false, error: 'It didn’t answer.' });
    expect(calls.at(-1)).toMatchObject({ url: '/api/domains/mybakery.com/check', method: 'POST' });
    answer = () => json(200, { verified: true });
    expect(await pub.checkDomain('mybakery.com')).toEqual({ verified: true });
    answer = () => json(404, {});
    await expect(pub.removeDomain('mybakery.com')).resolves.toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ url: '/api/domains/mybakery.com', method: 'DELETE' });
  });

  it('keeps what the server lists for a page published elsewhere', () => {
    const page = { pageId: 'seo:proj_1', kind: 'seo' as const, slug: 'menu', title: 'Menu', home: false, updatedAt: 5, url: 'https://app.example/menu' };
    expect(pub.publishedFromServer(page)).toEqual({ slug: 'menu', url: 'https://app.example/menu', publishedAt: 5, hash: '' });
    expect(pub.publishedFromServer({ ...page, domain: 'a.com', home: true, domainUrl: 'https://a.com/' }, 'h', 9)).toEqual({ slug: 'menu', domain: 'a.com', home: true, url: 'https://app.example/menu', domainUrl: 'https://a.com/', publishedAt: 9, hash: 'h' });
  });
});
