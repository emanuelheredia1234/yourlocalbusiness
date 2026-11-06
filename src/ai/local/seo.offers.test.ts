// The SEO checkout page with an attached offer: its Buy buttons are the offer's buy token (publishing makes them
// /b/<id>, a plain link: pages stay sandboxed), and its price is the offer's. And the AI's rule for an asset's
// Buy buttons.
import { afterEach, describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { useOffers } from '@/store/offers';
import type { Offer } from '@/lib/offers';
import { preparePublish } from '@/lib/publish';
import { buyButtonRule } from '@/ai/tasks';
import { ctaLink, exportSalesHtml, generateSalesPage, generateSeoMeta } from './seo';
import { buildListing } from '@/lib/listing';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OFFER: Offer = { id: ID, projectId: 'proj_shop', title: 'Course', priceDisplay: '$19/month', priceMinor: 1900, currency: 'usd', provider: 'whop', status: 'active', environment: 'production', checkoutHost: 'whop.com', clicks: 0, lastClickAt: null, sales: { count: 0, last: null }, createdAt: null, updatedAt: null, link: `https://app.test/b/${ID}` };

function shop(): Project {
  const p = newProject('product', 'new');
  p.id = 'proj_shop';
  p.niche = 'Fitness';
  p.category = 'Home workouts';
  p.studio.price = 29;
  p.marketing.pageType = 'checkout';
  p.marketing.pageLinks = { offerId: ID };
  return p;
}

afterEach(() => useOffers.getState().reset());

describe('a checkout page that sells an offer', () => {
  it('its Buy buttons are plain links to the offer’s buy link; its price is the offer’s', async () => {
    useOffers.getState().put(OFFER);
    const p = shop();
    const page = generateSalesPage(p, {}, 0, 'checkout');
    const out = exportSalesHtml(page, generateSeoMeta(p), p.brand, p);
    expect(out).toContain(`href="{{buy:${ID}}}"`);
    expect(out).toContain('<b>$19/month</b>');
    expect(out).not.toContain('<b>$29</b>');
    const ready = await preparePublish({ html: out, images: [] }, 'shop', undefined, new Set([ID]));
    expect(ready.html).toContain(`href="/b/${ID}"`);
    expect(ready.html).not.toContain('{{buy:');
    expect(ready.html).not.toContain('whop.com');
  });

  it('without the offer loaded, the page keeps its own price', () => {
    const p = shop();
    const out = exportSalesHtml(generateSalesPage(p, {}, 0, 'checkout'), generateSeoMeta(p), p.brand, p);
    expect(out).toContain('<b>$29</b>');
  });
});

describe('the checkout page’s structured data', () => {
  const ld = (html: string) => JSON.stringify([...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])));
  it('says the attached offer’s price and currency, as the page shows', () => {
    useOffers.getState().put({ ...OFFER, priceDisplay: '€49', priceMinor: 4900, currency: 'eur' });
    const p = shop();
    const out = exportSalesHtml(generateSalesPage(p, {}, 0, 'checkout'), generateSeoMeta(p), p.brand, p);
    expect(out).toContain('<b>€49</b>');
    expect(ld(out)).toContain('"priceCurrency":"EUR","price":"49.00"');
    expect(ld(out)).not.toMatch(/"price":29\b|"USD"/);
  });
  it('gives no price when the offer’s isn’t known', () => {
    useOffers.getState().put({ ...OFFER, priceMinor: null });
    const p = shop();
    const out = exportSalesHtml(generateSalesPage(p, {}, 0, 'checkout'), generateSeoMeta(p), p.brand, p);
    expect(ld(out)).not.toMatch(/"price"/);
  });
});

describe('a business listing’s offer, only while its button is Buy', () => {
  const biz = (bookingType: 'buy' | 'book' | 'inquire') => {
    const p = newProject('business', 'new');
    p.id = 'proj_shop';
    p.studio.listing = { ...p.studio.listing, offerId: ID, bookingType, buyUrl: 'https://cal.example.com/me' };
    return p;
  };
  it('a Buy button sells the offer; booking or a contact use the typed link', () => {
    useOffers.getState().put(OFFER);
    expect(buildListing(biz('buy')).buyUrl).toBe(OFFER.link);
    expect(buildListing(biz('buy')).offer?.id).toBe(ID);
    expect(ctaLink(biz('buy'))).toBe(`{{buy:${ID}}}`);
    for (const t of ['book', 'inquire'] as const) {
      expect(buildListing(biz(t)).buyUrl).toBe('https://cal.example.com/me');
      expect(buildListing(biz(t)).offer).toBeUndefined();
      expect(ctaLink(biz(t))).toBe('https://cal.example.com/me');
    }
  });
});

describe('the AI’s rule for Buy buttons', () => {
  it('plain links to the token, no checkout of its own, only the offer’s price', () => {
    const rule = buyButtonRule({ id: ID, title: 'Course', priceDisplay: '$49' });
    expect(rule).toContain(`<a href="{{buy:${ID}}}">`);
    expect(rule).toContain('No JavaScript checkout');
    expect(rule).toContain('“$49”');
    expect(buyButtonRule({ id: ID, title: 'Course', priceDisplay: '' })).toContain('State no price');
    expect(buyButtonRule(undefined)).toBe('');
    expect(buyButtonRule({ id: 'bad', title: 'x', priceDisplay: '' })).toBe('');
  });
});
