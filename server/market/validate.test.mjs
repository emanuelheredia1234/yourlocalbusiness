// The public marketplace's input rules (P7 S3.2): normalization, length caps, https-only links, the two-link cap, hosted
// images only (never data URLs, never another seller's), the seller's own live offer, a Stripe offer's price, and no
// coordinates.
import { describe, expect, it } from 'vitest';
import { categorySlug, contentHash, countUrls, normalizeText, safeHttpsUrl, safePhone, slugFor, SLUG_RE, toMinor, validatePublicListing } from './validate.mjs';
import { qualityOf, statusOf, titleShouts, wordCount, QUALITY_KEYS } from './quality.mjs';
import { DESCRIPTION } from './test-helpers.mjs';

const UID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const IMG = `${UID}/l-AAAAAAAAAAAAAAAAAAAAAA.png`;
const IMG2 = `${UID}/l-BBBBBBBBBBBBBBBBBBBBBB.webp`;
const base = (over = {}) => ({ projectId: 'p1', kind: 'product', title: 'Stoneware mug', description: DESCRIPTION, category: 'Home', tags: ['mug', 'pottery', 'gift'], price: 34, priceModel: 'one-time', sellerName: 'River Pottery', coverPath: IMG, ...over });
const ctx = (over = {}) => ({ uid: UID, offerOf: async () => null, imagesOf: async () => new Set(['l-AAAAAAAAAAAAAAAAAAAAAA.png', 'l-BBBBBBBBBBBBBBBBBBBBBB.webp']), ...over });
const refused = async (input, code, c = ctx()) => {
  await expect(validatePublicListing(input, c)).rejects.toMatchObject({ code });
};

describe('normalizeText', () => {
  it('turns control characters into spaces, removes zero-width and bidi ones, applies NFC and collapses spaces', () => {
    expect(normalizeText('  a\u0000b\u200Bc \u202Ed\u2066e\u0007  f  ', 50)).toBe('a bc de f');
    expect(normalizeText('Cafe\u0301', 50)).toBe('Café');
    expect(normalizeText('one\r\n\r\n\r\n\r\ntwo\nthree', 50, { multiline: true })).toBe('one\n\ntwo\nthree');
    // text is stored as typed: never HTML-decoded or stripped
    expect(normalizeText('<b>&amp;</b>', 50)).toBe('<b>&amp;</b>');
  });

  it('refuses over the cap, non-text and missing required text', () => {
    expect(() => normalizeText('x'.repeat(121), 120)).toThrow(/at most 120/);
    expect(() => normalizeText(5, 10)).toThrow();
    expect(() => normalizeText('', 10, { required: true })).toThrow(/required/);
    expect(() => normalizeText('abc', 10, { min: 4 })).toThrow(/at least 4/);
  });
});

describe('links, phones, money and slugs', () => {
  it('takes https web addresses only', () => {
    expect(safeHttpsUrl('https://shop.example.com/a?b=1')).toBe('https://shop.example.com/a?b=1');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'http://shop.example.com', 'https://127.0.0.1/', 'https://[::1]/', 'https://user:pw@shop.example.com', 'https://localhost/', 'https://printer.local/', 'https://example.com:8443/', 'https://intranet/', `https://${'a'.repeat(300)}.com`]) {
      expect(() => safeHttpsUrl(bad), bad).toThrow(expect.objectContaining({ code: 'BAD_URL' }));
    }
    expect(safeHttpsUrl('')).toBeNull();
  });

  it('counts the web addresses in a text', () => {
    expect(countUrls('see https://a.example and www.b.example and shop.com/x')).toBe(3);
    expect(countUrls('no links here, e.g. 3.5 cups')).toBe(0);
  });

  it('phones, money and addresses', () => {
    expect(safePhone(' +1 (503) 555-0100 ')).toBe('+1 (503) 555-0100');
    expect(safePhone('call me')).toBeNull();
    expect(safePhone('123')).toBeNull();
    expect(toMinor(34.5)).toBe(3450);
    expect(toMinor(null)).toBeNull();
    for (const bad of [-1, Number.NaN, 1_000_001, '12']) expect(() => toMinor(bad)).toThrow();
    const slug = slugFor('Ünïcode Café — Mugs & Bowls for every Kitchen table today');
    expect(slug).toMatch(/^unicode-cafe-mugs-bowls-for-every-[a-z0-9]{6}$/);
    expect(SLUG_RE.test(slugFor('!!!'))).toBe(true);
    expect(categorySlug('Home & Kitchen')).toBe('home-kitchen');
    expect(categorySlug('★')).toBe('other');
  });
});

describe('validatePublicListing', () => {
  it('normalizes a full listing and drops coordinates', async () => {
    const row = await validatePublicListing(base({ tags: ['Mug', 'mug', ' Pottery '], location: { city: 'Portland', region: 'OR', lat: 45.5, lng: -122.6, online: false }, website: 'https://river.example.com' }), ctx());
    expect(row).toMatchObject({ project_id: 'p1', title: 'Stoneware mug', category_slug: 'home', tags: ['mug', 'pottery'], price_minor: 3400, currency: 'usd', cover_path: IMG, location: { city: 'Portland', region: 'OR', online: false } });
    expect(JSON.stringify(row)).not.toMatch(/lat|lng|45\.5/);
    expect(row.content_hash).toBe(contentHash(DESCRIPTION));
  });

  it('enforces every length cap', async () => {
    await refused(base({ title: 'abc' }), 'BAD_REQUEST');
    await refused(base({ title: 'x'.repeat(121) }), 'BAD_REQUEST');
    await refused(base({ tagline: 'x'.repeat(161) }), 'BAD_REQUEST');
    await refused(base({ description: 'short' }), 'BAD_REQUEST');
    await refused(base({ description: 'x '.repeat(2600) }), 'BAD_REQUEST');
    await refused(base({ category: '' }), 'BAD_REQUEST');
    await refused(base({ sellerName: 'x'.repeat(81) }), 'BAD_REQUEST');
    await refused(base({ tags: ['x'.repeat(33)] }), 'BAD_REQUEST');
    await refused(base({ includes: Array(9).fill('a') }), 'BAD_REQUEST');
    await refused(base({ services: Array(13).fill({ name: 'a' }) }), 'BAD_REQUEST');
    await refused(base({ priceModel: 'weekly' }), 'BAD_REQUEST');
    await refused(base({ price: -1 }), 'BAD_REQUEST');
  });

  it('refuses bad links and more than two links in the description', async () => {
    for (const website of ['javascript:alert(1)', 'http://river.example.com', 'https://10.0.0.1/', 'https://a:b@river.example.com', 'https://localhost']) await refused(base({ website }), 'BAD_URL');
    await refused(base({ buyUrl: 'data:text/html,x' }), 'IMAGE_NOT_HOSTED');
    await refused(base({ description: `${DESCRIPTION} https://a.example https://b.example https://c.example` }), 'TOO_MANY_LINKS');
    await expect(validatePublicListing(base({ description: `${DESCRIPTION} https://a.example https://b.example` }), ctx())).resolves.toBeTruthy();
  });

  it('takes only the seller’s own hosted listing images, never a data URL', async () => {
    await refused(base({ coverPath: 'data:image/png;base64,AAAA' }), 'IMAGE_NOT_HOSTED');
    await refused(base({ galleryPaths: ['data:image/png;base64,AAAA'] }), 'IMAGE_NOT_HOSTED');
    await refused(base({ services: [{ name: 'x', note: 'data:text/plain,hi' }] }), 'IMAGE_NOT_HOSTED');
    await refused(base({ coverPath: `${OTHER}/l-AAAAAAAAAAAAAAAAAAAAAA.png` }), 'IMAGE_NOT_HOSTED');
    await refused(base({ coverPath: `${UID}/AAAAAAAAAAAAAAAAAAAAAA.png` }), 'IMAGE_NOT_HOSTED');
    await refused(base({ coverPath: `${UID}/e-AAAAAAAAAAAAAAAAAAAAAA.png` }), 'IMAGE_NOT_HOSTED');
    await refused(base({ coverPath: 'https://evil.example/x.png' }), 'IMAGE_NOT_HOSTED');
    await refused(base({ galleryPaths: [`${UID}/l-CCCCCCCCCCCCCCCCCCCCCC.png`] }), 'IMAGE_NOT_HOSTED');
    await refused(base({ galleryPaths: [IMG2, IMG2, IMG, `${UID}/l-DDDDDDDDDDDDDDDDDDDDDD.png`, `${UID}/l-EEEEEEEEEEEEEEEEEEEEEE.png`] }), 'BAD_REQUEST');
    const ok = await validatePublicListing(base({ galleryPaths: [IMG2, IMG2] }), ctx());
    expect(ok.gallery_paths).toEqual([IMG2]);
  });

  it('takes the seller’s own live offer only, and a Stripe offer’s price wins', async () => {
    const offers = {
      mine: { id: 'AAAAAAAAAAAAAAAAAAAAAA', user_id: UID, status: 'active', provider: 'stripe', price_minor: 2500, currency: 'usd' },
      theirs: { id: 'BBBBBBBBBBBBBBBBBBBBBB', user_id: OTHER, status: 'active', provider: 'external' },
      archived: { id: 'CCCCCCCCCCCCCCCCCCCCCC', user_id: UID, status: 'archived', provider: 'external' },
      draft: { id: 'DDDDDDDDDDDDDDDDDDDDDD', user_id: UID, status: 'draft', provider: 'whop' },
      whop: { id: 'EEEEEEEEEEEEEEEEEEEEEE', user_id: UID, status: 'paused', provider: 'whop', price_minor: 9900 },
    };
    const c = ctx({ offerOf: async (id) => Object.values(offers).find((o) => o.id === id) ?? null });
    for (const k of ['theirs', 'archived', 'draft']) await refused(base({ offerId: offers[k].id }), 'OFFER_NOT_YOURS', c);
    await refused(base({ offerId: 'not-an-id' }), 'OFFER_NOT_YOURS', c);
    const stripe = await validatePublicListing(base({ offerId: offers.mine.id, buyUrl: 'https://elsewhere.example.com' }), c);
    expect(stripe).toMatchObject({ offer_id: offers.mine.id, price_minor: 2500, outside_buy_url: null });
    const whop = await validatePublicListing(base({ offerId: offers.whop.id }), c);
    expect(whop.price_minor).toBe(3400);
  });
});

describe('quality', () => {
  const row = (over = {}) => ({ title: 'Stoneware mug', description: DESCRIPTION, cover_path: IMG, category: 'Home', tags: ['a', 'b', 'c'], website: 'https://a.example', price_minor: 100, price_model: 'one-time', ...over });
  it('is indexable when everything is there, and names each missing thing by a stable key', () => {
    expect(qualityOf(row())).toEqual({ indexable: true, missing: [], words: wordCount(DESCRIPTION) });
    const q = qualityOf(row({ description: 'word '.repeat(30), title: 'BUY NOW CHEAP MUGS', cover_path: null, tags: ['a'], website: null, price_minor: null }), { duplicate: true, trial: true });
    expect(q.missing).toEqual(['description_length', 'title_caps', 'cover', 'tags', 'action', 'price', 'duplicate', 'trial']);
    expect(q.missing.every((k) => QUALITY_KEYS.includes(k))).toBe(true);
    expect(titleShouts('Sooooo good mugs')).toBe(true);
    expect(qualityOf(row({ price_minor: null, price_model: 'quote' })).indexable).toBe(true);
    expect(qualityOf(row({ website: null, offer_id: 'x' }), { offer: { status: 'archived' } }).missing).toEqual(['action']);
  });

  it('serves stored rows by their flags, the plan and a deletion', () => {
    expect(statusOf({ status: 'live' })).toBe('live');
    expect(statusOf({ status: 'thin' })).toBe('thin');
    expect(statusOf({ status: 'live', held_at: 'x' })).toBe('held');
    for (const status of ['unlisted', 'hidden', 'over_limit']) expect(statusOf({ status })).toBe('gone');
    expect(statusOf({ status: 'live' }, { serveUntil: '2020-01-01T00:00:00Z' })).toBe('gone');
    expect(statusOf({ status: 'live' }, { blocked: true })).toBe('gone');
    expect(statusOf(null)).toBe('missing');
  });
});
