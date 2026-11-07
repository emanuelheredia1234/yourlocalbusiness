// The public marketplace's pages (P7 S4.3/S4.4): every user text escaped, no script but the one JSON-LD data block,
// valid structured data (Product, Offer, BreadcrumbList; never ratings or reviews), outside links rel="ugc nofollow
// noopener", Buy only through /b/<offer>, no email address, and a CSP without scripts.
import { describe, expect, it } from 'vitest';
import { gridHtml, listingHtml, marketCsp, priceLabel, reportFormHtml } from './render.mjs';
import { productJsonLd, safeJson } from './jsonld.mjs';

const EVIL = `"><script>alert(1)</script><img src=x onerror=alert(1)>'&`;
const ORIGIN = 'https://yourlocalbusiness.replit.app';
const imageUrl = (p) => `https://abc.supabase.co/storage/v1/object/public/public-files/${p}`;
const row = (over = {}) => ({
  id: 'r1',
  user_id: 'u1',
  slug: 'mug-abc123',
  kind: 'product',
  title: 'River mug',
  tagline: 'Handmade',
  description: 'A mug.\n\nSecond paragraph with https://link.example in it and seller@example.com.',
  category: 'Home',
  category_slug: 'home',
  tags: ['mug'],
  price_minor: 3400,
  price_model: 'one-time',
  services: [],
  includes: [],
  location: { city: 'Portland', region: 'OR', online: false },
  seller_name: 'River Pottery',
  website: 'https://river.example.com',
  outside_buy_url: null,
  phone: '+1 503 555 0100',
  offer_id: 'AAAAAAAAAAAAAAAAAAAAAA',
  cover_path: 'u1/l-AAAAAAAAAAAAAAAAAAAAAA.png',
  gallery_paths: ['u1/l-BBBBBBBBBBBBBBBBBBBBBB.png'],
  ...over,
});
/** Every tag's attribute names (quoted values removed): an on…= among them would be a live event handler. */
const handlerAttrs = (html) => [...html.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0].replace(/"[^"]*"/g, '""')).filter((t) => /\son\w+\s*=/i.test(t));
const ld = (html) => {
  const m = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(m).toHaveLength(1);
  return JSON.parse(m[0][1]);
};

describe('listing page escaping', () => {
  const evil = row({ title: EVIL, tagline: EVIL, description: `${EVIL}\n\n</script><!-- x`, category: EVIL, seller_name: EVIL, services: [{ name: EVIL, priceMinor: 100, duration: EVIL }], includes: [EVIL], location: { city: EVIL, region: EVIL } });
  const html = listingHtml(evil, { origin: ORIGIN, imageUrl, offer: { state: 'active', test: false } });

  it('has no script but the JSON-LD block and no event handlers', () => {
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script type="application/ld+json">');
    expect(handlerAttrs(html)).toEqual([]);
    // the typed handler is text: escaped, so never an attribute
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<!-- x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes the title, og:* and alt attributes', () => {
    expect(html).toMatch(/<title>&quot;&gt;&lt;script&gt;/);
    expect(html).toContain('<meta property="og:title" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;">');
    expect(html).toMatch(/alt="&quot;&gt;&lt;script&gt;.*photo 1"/);
    const data = ld(html);
    expect(data['@graph'][0].name).toBe(EVIL);
  });
});

describe('listing page links and content', () => {
  it('Buy goes to the buy link, outside links are ugc nofollow noopener, no email and no ratings', () => {
    const html = listingHtml(row(), { origin: ORIGIN, imageUrl, offer: { state: 'active', test: false } });
    expect(html).toContain(`<a class="btn" href="${ORIGIN}/b/AAAAAAAAAAAAAAAAAAAAAA" rel="nofollow">Buy</a>`);
    expect(html).toContain('href="https://river.example.com/" rel="ugc nofollow noopener"'.replace('.com/"', '.com"'));
    for (const m of html.matchAll(/<a [^>]*href="https:\/\/(?!yourlocalbusiness\.replit\.app)[^"]*"[^>]*>/g)) expect(m[0]).toContain('rel="ugc nofollow noopener"');
    // the description's address is text, not a link
    expect(html).not.toContain('href="https://link.example');
    expect(html).toContain('href="tel:+15035550100"');
    expect(html).not.toMatch(/mailto:/);
    expect(html).not.toMatch(/aggregateRating|"review"|ratingValue|itemprop="review"/);
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/market/mug-abc123">`);
    expect(html).toContain('<meta name="robots" content="index, follow">');
    expect(html).toContain(`href="${ORIGIN}/market/mug-abc123/report" rel="nofollow"`);
    expect(html).toContain('twitter:card" content="summary_large_image"');
    expect(html).toContain('loading="lazy" decoding="async"');
  });

  it('a paused offer reads “not available”, an archived one shows no Buy', () => {
    const paused = listingHtml(row(), { origin: ORIGIN, imageUrl, offer: { state: 'paused' } });
    expect(paused).toContain('Not available to buy right now');
    expect(paused).not.toContain('/b/AAAA');
    const none = listingHtml(row({ website: null, phone: null }), { origin: ORIGIN, imageUrl, offer: { state: 'none' } });
    expect(none).not.toMatch(/>Buy</);
    expect(none).not.toContain('/b/');
  });

  it('prices read as the app’s labels', () => {
    expect(priceLabel(3400, 'one-time')).toBe('$34');
    expect(priceLabel(3450, 'monthly')).toBe('$34.50/mo');
    expect(priceLabel(3400, 'per-session')).toBe('$34/session');
    expect(priceLabel(3400, 'project')).toBe('From $34');
    expect(priceLabel(null, 'quote')).toBe('Get a quote');
    expect(priceLabel(0, 'one-time')).toBe('Free');
  });
});

describe('JSON-LD', () => {
  const canonical = `${ORIGIN}/market/mug-abc123`;
  it('parses, with a Product, its Offer and a 3-item BreadcrumbList', () => {
    const data = ld(listingHtml(row(), { origin: ORIGIN, imageUrl, offer: { state: 'active' } }));
    expect(data['@context']).toBe('https://schema.org');
    const [product, crumbs] = data['@graph'];
    expect(product).toMatchObject({ '@type': 'Product', name: 'River mug', url: canonical, brand: { '@type': 'Brand', name: 'River Pottery' } });
    expect(product.image.every((u) => /^https:\/\//.test(u))).toBe(true);
    expect(product.offers).toMatchObject({ '@type': 'Offer', priceCurrency: 'USD', availability: 'https://schema.org/InStock', seller: { name: 'River Pottery' }, url: canonical });
    expect(product.offers.price).toMatch(/^\d+\.\d{2}$/);
    expect(product.offers.url).not.toContain('/b/');
    expect(product.aggregateRating).toBeUndefined();
    expect(product.review).toBeUndefined();
    expect(crumbs['@type']).toBe('BreadcrumbList');
    expect(crumbs.itemListElement).toHaveLength(3);
  });

  it('paused or unconfirmed: OutOfStock; quote: no offer; free: 0.00; monthly: a unit price', () => {
    expect(productJsonLd(row(), { canonical, offerState: 'paused' }).offers.availability).toBe('https://schema.org/OutOfStock');
    expect(productJsonLd(row({ price_minor: null, price_model: 'quote' }), { canonical }).offers).toBeUndefined();
    expect(productJsonLd(row({ price_minor: 0, price_model: 'free' }), { canonical }).offers.price).toBe('0.00');
    expect(productJsonLd(row({ price_model: 'monthly' }), { canonical }).offers.priceSpecification).toMatchObject({ '@type': 'UnitPriceSpecification', referenceQuantity: { unitCode: 'MON' } });
  });

  it('keeps </script> inside the block', () => {
    const text = safeJson({ a: '</script><script>alert(1)</script>&\u2028' });
    expect(text).not.toContain('</script>');
    expect(text).not.toContain('<');
    expect(JSON.parse(text).a).toBe('</script><script>alert(1)</script>&\u2028');
  });
});

describe('grid and report form', () => {
  it('escapes q and the category, no script but the data block', () => {
    const html = gridHtml({ origin: ORIGIN, imageUrl, rows: [row({ title: EVIL })], categories: [{ slug: 'home', name: EVIL, count: 3 }], category: { slug: 'home', name: EVIL, count: 3 }, q: EVIL, page: 1, hasNext: true, robots: 'noindex, follow', canonical: `${ORIGIN}/market` });
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(handlerAttrs(html)).toEqual([]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;');
    expect(html).toContain(`<link rel="next" href="${ORIGIN}/market?category=home&amp;q=`);
    const crumbs = ld(html)['@graph'][0];
    expect(crumbs['@type']).toBe('BreadcrumbList');
  });

  it('the report form has no script, a token and a hidden honeypot', () => {
    const html = reportFormHtml(row(), { origin: ORIGIN, token: 'abc.def' });
    expect(html).not.toMatch(/<script(?! type="application\/ld\+json")/);
    expect(html).toContain('name="t" value="abc.def"');
    expect(html).toMatch(/name="website" tabindex="-1" autocomplete="off"/);
    expect(html).toContain('content="noindex, nofollow"');
  });

  it('the CSP allows no scripts', () => {
    const csp = marketCsp('https://abc.supabase.co');
    expect(csp).toMatch(/^default-src 'none'/);
    expect(csp).not.toMatch(/script-src/);
    expect(csp).toContain("img-src 'self' https://abc.supabase.co");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
