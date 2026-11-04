// The SEO page's six types: their names, the links their buttons open (the owner's own: the app never takes
// payments), the sections a new page of each type gets, and opening the builder with a type chosen.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingType, PageType, Project } from './types';
import { newProject } from '@/store/defaults';
import { useUI } from '@/store/ui';
import { navigate } from '@/lib/router';
import { PAGE_TYPES, PAGE_TYPE_DESC, PAGE_TYPE_LABEL, bookingLink, linkFromListing, missingLink, pageTypeNoun, pageTypeOf, paymentLink, sectionPlan, webLink } from './pageTypes';

// pages change through the router; here it only records where it was asked to go
vi.mock('@/lib/router', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/router')>()), navigate: vi.fn(async () => true) }));

function project(track: 'business' | 'product', listing: { bookingType?: BookingType; buyUrl?: string } = {}, pageLinks?: { booking?: string; payment?: string }): Project {
  const p = newProject(track, 'new');
  p.studio.listing = { ...p.studio.listing, ...listing };
  if (pageLinks) p.marketing.pageLinks = pageLinks;
  return p;
}

describe('the six page types', () => {
  it('have their names and one line each', () => {
    expect(PAGE_TYPES).toEqual(['lead', 'booking', 'website', 'landing', 'showcase', 'checkout']);
    expect(PAGE_TYPE_LABEL).toEqual({ lead: 'Lead form page', booking: 'Booking page', website: 'Website', landing: 'Landing page', showcase: 'Showcase page', checkout: 'Checkout page' });
    for (const t of PAGE_TYPES) expect(PAGE_TYPE_DESC[t]).toMatch(/^[A-Z].{20,}\.$/);
    expect(PAGE_TYPE_DESC.lead).toContain('Email → Leads');
    expect(PAGE_TYPE_DESC.checkout).toContain('your own payment link');
    expect(PAGE_TYPES.map(pageTypeNoun)).toEqual(['a lead form page', 'a booking page', 'a website', 'a landing page', 'a showcase page', 'a checkout page']);
  });

  it('a page without a type (or with one the app doesn’t know) is a landing page', () => {
    const p = newProject('business', 'new');
    expect(pageTypeOf(p)).toBe('landing');
    p.marketing.pageType = 'booking';
    expect(pageTypeOf(p)).toBe('booking');
    p.marketing.pageType = 'brochure' as PageType;
    expect(pageTypeOf(p)).toBe('landing');
    expect(pageTypeOf({ marketing: undefined } as unknown as Project)).toBe('landing');
  });
});

describe('web links for buttons', () => {
  it('takes only http(s) addresses with a real host and no user name', () => {
    for (const bad of ['', '   ', 'mailto:x@y.z', 'javascript:alert(1)', 'localhost:3000', 'http://localhost', 'http://user@x.com', 'https://user:pw@x.com', 'ftp://x.com', 'data:text/html,hi', 'not a link']) expect(webLink(bad), bad).toBe('');
    expect(webLink(undefined)).toBe('');
  });

  it('normalizes: https added, a lone trailing slash dropped, paths and queries kept', () => {
    expect(webLink('www.x.com/')).toBe('https://www.x.com');
    expect(webLink(' buy.stripe.com/test_1 ')).toBe('https://buy.stripe.com/test_1');
    expect(webLink('http://Cal.com/me/')).toBe('http://cal.com/me/');
    expect(webLink('https://x.com/?a=1')).toBe('https://x.com/?a=1');
  });
});

describe('the links the page’s buttons open', () => {
  it('booking: the one typed in the builder wins, else the listing’s, but only a business’s booking link', () => {
    expect(bookingLink(project('business', { bookingType: 'book', buyUrl: 'cal.com/me' }))).toBe('https://cal.com/me');
    expect(bookingLink(project('business', { bookingType: 'buy', buyUrl: 'cal.com/me' }))).toBe('');
    expect(bookingLink(project('business', { bookingType: 'inquire', buyUrl: 'cal.com/me' }))).toBe('');
    expect(bookingLink(project('product', { bookingType: 'book', buyUrl: 'cal.com/me' }))).toBe('');
    expect(bookingLink(project('business', { bookingType: 'book', buyUrl: 'javascript:alert(1)' }))).toBe('');
    expect(bookingLink(project('business', { bookingType: 'book', buyUrl: 'cal.com/me' }, { booking: 'https://acuity.example.com/x' }))).toBe('https://acuity.example.com/x');
    expect(bookingLink(project('product', {}, { booking: 'acuity.example.com/x' }))).toBe('https://acuity.example.com/x');
    // a link that isn't one doesn't count: the listing's is used
    expect(bookingLink(project('business', { bookingType: 'book', buyUrl: 'cal.com/me' }, { booking: 'not a link' }))).toBe('https://cal.com/me');
  });

  it('payment: the one typed in the builder wins, else the listing’s buy link (a product, or a business that sells)', () => {
    expect(paymentLink(project('product', { buyUrl: 'gum.co/x' }))).toBe('https://gum.co/x');
    expect(paymentLink(project('business', { bookingType: 'buy', buyUrl: 'buy.stripe.com/1' }))).toBe('https://buy.stripe.com/1');
    expect(paymentLink(project('business', { bookingType: 'book', buyUrl: 'cal.com/me' }))).toBe('');
    expect(paymentLink(project('business', { bookingType: 'inquire', buyUrl: 'x.com' }))).toBe('');
    expect(paymentLink(project('business', { bookingType: 'book', buyUrl: 'cal.com/me' }, { payment: 'buy.stripe.com/2' }))).toBe('https://buy.stripe.com/2');
    expect(paymentLink(project('product', { buyUrl: 'gum.co/x' }, { payment: 'https://buy.stripe.com/3' }))).toBe('https://buy.stripe.com/3');
    expect(paymentLink(project('product'))).toBe('');
  });

  it('says when a link comes from the listing', () => {
    expect(linkFromListing(project('business', { bookingType: 'book', buyUrl: 'cal.com/me' }), 'booking')).toBe(true);
    expect(linkFromListing(project('business', { bookingType: 'book', buyUrl: 'cal.com/me' }, { booking: 'acuity.example.com' }), 'booking')).toBe(false);
    expect(linkFromListing(project('business'), 'booking')).toBe(false);
    expect(linkFromListing(project('product', { buyUrl: 'gum.co/x' }), 'payment')).toBe(true);
    expect(linkFromListing(project('product', { buyUrl: 'gum.co/x' }, { payment: 'buy.stripe.com/1' }), 'payment')).toBe(false);
  });

  it('a checkout page needs a payment link; a booking page can do without its booking link', () => {
    expect(missingLink(project('business'), 'checkout')).toBe('payment');
    expect(missingLink(project('business', {}, { payment: 'buy.stripe.com/1' }), 'checkout')).toBeNull();
    expect(missingLink(project('product', { buyUrl: 'gum.co/x' }), 'checkout')).toBeNull();
    expect(missingLink(project('business'), 'booking')).toBe('booking');
    expect(missingLink(project('business', { bookingType: 'book', buyUrl: 'cal.com/me' }), 'booking')).toBeNull();
    for (const t of ['lead', 'website', 'landing', 'showcase'] as const) expect(missingLink(project('business'), t)).toBeNull();
  });
});

describe('the sections a new page gets', () => {
  const plan = (t: PageType, p: Project) => sectionPlan(t, p).map((s) => (s.hidden ? `${s.type} (hidden)` : s.type));

  it('one plan per type, landing as every page was before', () => {
    const p = project('business');
    expect(plan('lead', p)).toEqual(['hero', 'solution', 'leadForm', 'proof', 'faq']);
    expect(plan('booking', p)).toEqual(['hero', 'offers', 'leadForm', 'proof', 'faq', 'contact']);
    expect(plan('website', p)).toEqual(['hero', 'offers', 'about', 'proof', 'faq', 'contact', 'leadForm']);
    expect(plan('landing', p)).toEqual(['hero', 'problem', 'solution', 'proof', 'pricing', 'faq', 'guarantee']);
    expect(plan('showcase', p)).toEqual(['hero', 'offers', 'proof', 'faq', 'leadForm', 'contact']);
    expect(plan('checkout', p)).toEqual(['hero', 'pricing', 'proof', 'faq', 'guarantee']);
  });

  it('a booking page with a booking link has its “Request a time” form, hidden', () => {
    expect(plan('booking', project('business', { bookingType: 'book', buyUrl: 'cal.com/me' }))).toEqual(['hero', 'offers', 'leadForm (hidden)', 'proof', 'faq', 'contact']);
    expect(plan('booking', project('business', {}, { booking: 'cal.com/me' }))).toContain('leadForm (hidden)');
  });

  it('a showcase has contact details only for a business', () => {
    expect(plan('showcase', project('product'))).toEqual(['hero', 'offers', 'proof', 'faq', 'leadForm']);
  });
});

describe('opening the builder with a type chosen', () => {
  beforeEach(() => {
    vi.mocked(navigate).mockClear().mockResolvedValue(true);
    useUI.setState({ seoPreset: undefined });
  });

  it('opens the SEO page, then hands it the type (a new request each time); nothing is written', async () => {
    useUI.getState().openSeoBuilder({ pageType: 'booking' });
    expect(navigate).toHaveBeenCalledWith('marketing-seo');
    await vi.waitFor(() => expect(useUI.getState().seoPreset).toMatchObject({ pageType: 'booking' }));
    const n = useUI.getState().seoPreset!.n;
    useUI.getState().openSeoBuilder({ pageType: 'booking' });
    await vi.waitFor(() => expect(useUI.getState().seoPreset!.n).toBe(n + 1));
  });

  it('without a type, or when the owner stays where they are, just opens (or doesn’t)', async () => {
    useUI.getState().openSeoBuilder();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(useUI.getState().seoPreset).toBeUndefined();
    vi.mocked(navigate).mockResolvedValue(false);
    useUI.getState().openSeoBuilder({ pageType: 'checkout' });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(useUI.getState().seoPreset).toBeUndefined();
  });
});
