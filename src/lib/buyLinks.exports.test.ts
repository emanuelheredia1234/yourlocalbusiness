// Buy links outside publishing (review fixes): the email exports fill in {{buy:<id>}}; a copy of the SEO page asks
// the business's offers of the server first (so its Buy buttons aren't dead # links); a listing with an offer checks
// it before publishing; and whether a listing changed doesn't flip on whether offers happen to be loaded.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Offer } from '@/lib/offers';

const api = vi.hoisted(() => ({ listOffers: vi.fn() }));
vi.mock('@/lib/offers', async (orig) => ({ ...(await orig<typeof import('@/lib/offers')>()), ...api }));

const { newProject } = await import('@/store/defaults');
const { useOffers, offerIdsForCopy } = await import('@/store/offers');
const { renderBuyLinks, sequenceCsv, sequenceText } = await import('./emailFunnel');
const { generateSalesPage, generateSeoMeta } = await import('@/ai/local/seo');
const { seoFileHtml } = await import('./seoPage');
const { checkListingOffer, listingChanged } = await import('./listingPublish');
const { buildListing } = await import('./listing');

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBB';
const offer = (projectId: string): Offer => ({ id: ID, projectId, title: 'Course', priceDisplay: '$49', priceMinor: 4900, currency: 'usd', provider: 'whop', status: 'active', environment: 'production', checkoutHost: 'whop.com', clicks: 0, lastClickAt: null, sales: { count: 0, last: null }, createdAt: null, updatedAt: null, link: `https://app.test/b/${ID}` });

afterEach(() => {
  api.listOffers.mockReset();
  useOffers.getState().reset();
});

describe('email exports', () => {
  it('fill in each of the business’s buy links; another stays as typed', () => {
    const links = { [`buy:${ID}`]: `https://app.test/b/${ID}` };
    expect(renderBuyLinks(`Go {{ buy:${ID} }} or {{buy:${OTHER}}}`, links)).toBe(`Go https://app.test/b/${ID} or {{buy:${OTHER}}}`);
    const p = newProject('product', 'new');
    p.marketing.emails = [{ id: 'e1', purpose: 'Sell', subject: 'Hi', preview: 'p', body: `Buy: {{buy:${ID}}}`, ctaLabel: 'Buy now', ctaUrl: `{{buy:${ID}}}`, delay: { value: 0, unit: 'days' } } as never];
    const csv = sequenceCsv(p, links);
    expect(csv).not.toContain('{{buy:');
    expect(csv).toContain(`"https://app.test/b/${ID}"`);
    expect(sequenceText(p, links)).toContain(`[Buy now] → https://app.test/b/${ID}`);
    expect(sequenceText(p, links)).not.toContain('{{buy:');
  });
});

describe('a copy of the SEO checkout page', () => {
  const checkout = () => {
    const p = newProject('product', 'new');
    p.id = 'proj_copy';
    p.marketing.pageType = 'checkout';
    p.marketing.pageLinks = { offerId: ID };
    p.marketing.salesPage = generateSalesPage(p, {}, 0, 'checkout');
    p.marketing.seo = generateSeoMeta(p);
    return p;
  };
  it('asks the business’s offers first, so its Buy buttons are the full buy link (not #)', async () => {
    api.listOffers.mockResolvedValue([offer('proj_copy')]);
    const out = await seoFileHtml(checkout());
    expect(api.listOffers).toHaveBeenCalledWith('proj_copy');
    expect(out.html).toMatch(new RegExp(`href="[^"]*/b/${ID}"`));
    expect(out.html).not.toContain('href="#"');
  });
  it('can’t ask: no file with dead buttons, a plain-words error', async () => {
    api.listOffers.mockRejectedValue(new Error('down'));
    await expect(seoFileHtml(checkout())).rejects.toThrow('Couldn’t check this page’s buy links');
    await expect(offerIdsForCopy('proj_copy')).rejects.toThrow('Couldn’t check');
  });
});

describe('a listing that sells an offer', () => {
  const product = () => {
    const p = newProject('product', 'new');
    p.id = 'proj_list';
    p.studio.listing = { ...p.studio.listing, offerId: ID, buyUrl: 'https://old.example.com/buy' };
    return p;
  };
  it('is checked before publishing: its own offer passes, one that isn’t the business’s is refused', async () => {
    await expect(checkListingOffer(product(), async () => new Set([ID]))).resolves.toBeUndefined();
    await expect(checkListingOffer(product(), async () => new Set([OTHER]))).rejects.toThrow('isn’t one of this business’s offers');
    await expect(checkListingOffer(product(), () => Promise.reject(new Error('down')))).rejects.toThrow('Couldn’t check this listing’s buy link');
    // no offer: nothing asked
    const plain = product();
    plain.studio.listing.offerId = undefined;
    const ask = vi.fn();
    await checkListingOffer(plain, ask);
    expect(ask).not.toHaveBeenCalled();
  });
  it('whether it changed doesn’t flip on whether offers are loaded yet', () => {
    const p = product();
    useOffers.getState().put(offer('proj_list'));
    const live = buildListing(p);
    expect(live.buyUrl).toBe(`https://app.test/b/${ID}`);
    expect(listingChanged(p, live)).toBe(false);
    // a fresh load: offers not loaded yet
    useOffers.getState().reset();
    expect(listingChanged(p, live)).toBe(false);
  });
});
