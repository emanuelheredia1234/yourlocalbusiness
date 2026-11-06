// The SEO page's six types in the built-in engine and the HTML export: each type's sections, words and
// buttons; the owner's offers, contact details and form setting kept as facts; sections kept (hidden) when
// the type changes; images on offered items; the score; and a landing page exported exactly as before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '@/store/defaults';
import type { ContactData, LeadFormData, MediaRef, OfferItem, OffersData, PageType, Project, PromptImage, SalesPage, SalesSection, SalesSectionType } from '@/lib/types';
import { PAGE_TYPES, sectionPlan } from '@/lib/pageTypes';
import { initials } from '@/lib/utils';
import { buildFacts } from '../text';
import { generateBrandKit } from './brand';
import { generateBusinessModel } from './studio';
// The landing exports saved before page types (and the projects they were made from).
import businessHtml from './__fixtures__/landing-business.html?raw';
import businessJson from './__fixtures__/landing-business.json?raw';
import productHtml from './__fixtures__/landing-product.html?raw';
import productJson from './__fixtures__/landing-product.json?raw';
import {
  ANCHOR,
  SECTION_LABEL,
  SECTION_ORDER,
  exportSalesHtml,
  generateSalesPage,
  generateSalesSection,
  generateSeoMeta,
  heroHref,
  itemTarget,
  keepFacts,
  pageImageIds,
  pageTargets,
  pageText,
  placeImages,
  pruneImages,
  scoreSeo,
  sectionsKeptHidden,
  websiteMenu,
  withKeptSections,
  type PageTargets,
  type SalesHtmlOptions,
} from './seo';

// ── the projects of seo.claims2.test.ts ──
function product(niche: string, category: string, format: Project['format']): Project {
  const p = newProject('product', 'new');
  p.niche = niche;
  p.category = category;
  p.format = format;
  p.studio.price = 29;
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, slug: kit.slug, websiteUrl: '', colors: kit.colors };
  return p;
}

function business(type: string, city = 'Austin'): Project {
  const p = newProject('business', 'new');
  p.niche = type;
  p.category = type;
  p.businessType = type;
  p.location = { city, region: 'TX' };
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, slug: kit.slug, websiteUrl: '', colors: kit.colors };
  const bm = generateBusinessModel(p);
  p.studio.packages = bm.packages;
  p.studio.price = bm.price;
  return p;
}

const PROJECTS = () => [
  product('Personal Finance', 'Freelancer Tax Tracking', 'spreadsheet'),
  product('Fitness', 'Home workouts for beginners', 'course'),
  product('Productivity', 'Notion planning', 'template'),
  business('Home Cleaning'),
  business('Auto Repair'),
  business('Accounting', ''),
  business('Dog grooming'),
];

/** The same as seo.claims2.test.ts: results promised as fact, service standards, owner actions and puffery. */
const PROMISES = /\bhelps? (you|\w+ \w+)|that helps|built to help|without \w|off your plate|finally sorted|the smarter way|made simple|without the stress|turns .+ into a clear|repeatable routine|no more\b|fixes it|you['’]ll\b|we checked|I read every|I['’]ll send|strategy call|start the program|designed so|★|\bstars?\b|rated\b/i;

/** A salon with packages, a booking link and contact details on its listing. */
function salon(): Project {
  const p = business('Hair salon');
  p.id = 'proj_salon';
  p.studio.packages = [
    { id: 'pk1', name: 'Cut & style', price: 65, priceModel: 'per-session', description: 'Wash, cut and blow-dry.', includes: ['Wash', 'Cut'], popular: true },
    { id: 'pk2', name: 'Colour', price: 0, priceModel: 'quote', description: 'Priced after a consultation.', includes: [] },
    { id: 'pk3', name: 'Fringe trim', price: 0, priceModel: 'free', description: '', includes: [] },
  ];
  p.studio.listing = { ...p.studio.listing, bookingType: 'book', buyUrl: 'https://cal.example.com/salon', phone: '(512) 555-0100', contactEmail: 'hi@salon.example.com', hours: 'Tue–Sat 9–6' };
  return p;
}

const as = (p: Project, type: PageType): Project => ({ ...p, marketing: { ...p.marketing, pageType: type } });
const sec = <T extends SalesSectionType>(page: SalesPage, type: T) => page.sections.find((s) => s.type === type) as Extract<SalesSection, { type: T }> | undefined;
const textOf = (page: SalesPage, types: SalesSectionType[]) => JSON.stringify(page.sections.filter((s) => types.includes(s.type)).map((s) => s.data));
/** The page saved on the project (a rewrite reads what the owner has on it). */
const withPage = (p: Project, page: SalesPage, type?: PageType): Project => ({ ...p, marketing: { ...p.marketing, salesPage: page, ...(type ? { pageType: type } : {}) } });
const html = (p: Project, page: SalesPage, opts: SalesHtmlOptions = {}) => exportSalesHtml(page, generateSeoMeta(p), p.brand, p, opts);
const jsonLd = (out: string) => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(out)![1]) as Record<string, unknown> | Record<string, unknown>[];
const mainLd = (out: string) => {
  const ld = jsonLd(out);
  return (Array.isArray(ld) ? ld[0] : ld) as Record<string, unknown>;
};
/** A page with a section's data changed. */
const edit = <T extends SalesSectionType>(page: SalesPage, type: T, fn: (d: Extract<SalesSection, { type: T }>['data']) => Extract<SalesSection, { type: T }>['data'], visible?: boolean): SalesPage => ({
  ...page,
  sections: page.sections.map((s) => (s.type === type ? ({ ...s, data: fn(s.data as never), ...(visible === undefined ? {} : { visible }) } as SalesSection) : s)),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('every type of page, for every kind of project', () => {
  it('follows its plan and states only what the owner provided', () => {
    for (const p of PROJECTS()) {
      for (const type of PAGE_TYPES) {
        for (let v = 0; v < 5; v++) {
          const page = generateSalesPage(p, {}, v, type);
          const label = `${p.businessType || p.category} · ${type} · v${v}`;
          expect(page.sections.map((s) => [s.type, s.visible]), label).toEqual(sectionPlan(type, p).map((x) => [x.type, !x.hidden]));
          const meta = generateSeoMeta(p, {}, v, type);
          const text = textOf(page, ['hero', 'leadForm', 'offers', 'about', 'contact', 'faq']) + JSON.stringify(meta);
          expect(text, label).not.toMatch(PROMISES);
          // well-formed: no empty interpolations or doubled punctuation
          expect(text, label).not.toMatch(/undefined|null|\.\.(?!\.)|\s,|\(\)/);
        }
      }
    }
  });

  it('a landing page is the page every project had before (the same sections and words)', () => {
    for (const p of PROJECTS()) {
      const strip = (page: SalesPage) => page.sections.map((s) => [s.type, s.visible, s.data]);
      expect(strip(generateSalesPage(p, {}, 2, 'landing'))).toEqual(strip(generateSalesPage(p, {}, 2)));
      expect(generateSalesPage(p).sections.map((s) => s.type)).toEqual(SECTION_ORDER);
      expect(generateSeoMeta(p, {}, 1, 'landing')).toEqual(generateSeoMeta(p, {}, 1));
    }
  });

  it('offers are the owner’s packages (or the product), with their prices', () => {
    for (const p of PROJECTS()) {
      for (const type of ['booking', 'website', 'showcase'] as const) {
        const items = (sec(generateSalesPage(p, {}, 0, type), 'offers')!.data as OffersData).items;
        if (p.track === 'business') {
          expect(items.map((i) => i.name)).toEqual(p.studio.packages.map((x) => x.name));
          expect(items.map((i) => i.price)).toEqual(p.studio.packages.map((x) => (x.priceModel === 'free' ? 0 : x.price)));
        } else {
          expect(items).toHaveLength(1);
          expect(items[0]).toMatchObject({ name: buildFacts(p).productShort, price: 29, cta: 'buy' });
        }
      }
    }
    const items = (sec(generateSalesPage(salon(), {}, 0, 'showcase'), 'offers')!.data as OffersData).items;
    expect(items.map((i) => [i.name, i.price, i.priceNote, i.cta])).toEqual([
      ['Cut & style', 65, 'per visit', 'book'],
      ['Colour', 0, '', 'inquire'],
      ['Fringe trim', 0, 'Free', 'book'],
    ]);
    // a booking page books every package that has a price (or is free); a quote is asked for
    expect((sec(generateSalesPage(salon(), {}, 0, 'booking'), 'offers')!.data as OffersData).items.map((i) => i.cta)).toEqual(['book', 'inquire', 'book']);
    // a listing that sells: Buy buttons
    const shop = salon();
    shop.studio.listing.bookingType = 'buy';
    expect((sec(generateSalesPage(shop, {}, 0, 'website'), 'offers')!.data as OffersData).items.map((i) => i.cta)).toEqual(['buy', 'inquire', 'buy']);
    // headings
    expect((sec(generateSalesPage(salon(), {}, 0, 'booking'), 'offers')!.data as OffersData).heading).toBe('Services');
    expect((sec(generateSalesPage(salon(), {}, 0, 'website'), 'offers')!.data as OffersData).heading).toBe('Services');
    expect((sec(generateSalesPage(PROJECTS()[0], {}, 0, 'website'), 'offers')!.data as OffersData).heading).toBe('What we offer');
    expect((sec(generateSalesPage(salon(), {}, 0, 'showcase'), 'offers')!.data as OffersData).heading).toBe('What we offer');
  });

  it('a business without packages gets an empty list (the owner adds items)', () => {
    const p = salon();
    p.studio.packages = [];
    const page = generateSalesPage(p, {}, 0, 'showcase');
    expect((sec(page, 'offers')!.data as OffersData).items).toEqual([]);
    expect(html(as(p, 'showcase'), page)).not.toContain('class="offers"');
  });

  it('contact details come from the listing, and a phone or email that doesn’t check out is left off', () => {
    const p = salon();
    expect(sec(generateSalesPage(p, {}, 0, 'booking'), 'contact')!.data).toEqual({ heading: 'Contact', intro: `${p.brand.name} serves Austin, TX.`, address: 'Austin, TX', hours: 'Tue–Sat 9–6', phone: '(512) 555-0100', email: 'hi@salon.example.com' });
    p.studio.listing = { ...p.studio.listing, phone: '12', contactEmail: 'not-an-email' };
    expect(sec(generateSalesPage(p, {}, 0, 'booking'), 'contact')!.data).toMatchObject({ phone: '', email: '' });
    // a product has no address, and nothing to show is left out of the page
    const prod = PROJECTS()[0];
    const page = generateSalesPage(prod, {}, 0, 'website');
    expect(sec(page, 'contact')!.data).toEqual({ heading: 'Contact', intro: '', address: '', hours: '', phone: '', email: '' });
    expect(html(as(prod, 'website'), page)).not.toContain('class="contact"');
  });

  it('the form’s words fit the type; only a booking page asks for a time', () => {
    const p = salon();
    const form = (type: PageType) => sec(generateSalesPage(p, {}, 0, type), 'leadForm')?.data as LeadFormData | undefined;
    expect(form('booking')).toEqual({ heading: 'Request a time', intro: `Tell ${p.brand.name} when suits you. It’s a request: the time isn’t booked until ${p.brand.name} confirms it.`, buttonLabel: 'Send request', askTime: true });
    expect(form('lead')).toEqual({ heading: `Get in touch with ${p.brand.name}`, intro: 'Leave your name, your email and a short message.', buttonLabel: 'Send', askTime: false });
    expect(form('website')).toMatchObject({ heading: 'Send a message', buttonLabel: 'Send message', askTime: false });
    expect(form('showcase')).toMatchObject({ heading: 'Ask a question or get a quote', buttonLabel: 'Send', askTime: false });
    expect(form('landing')).toBeUndefined();
    const prod = PROJECTS()[0];
    expect((sec(generateSalesPage(prod, {}, 0, 'lead'), 'leadForm')!.data as LeadFormData).heading).toBe(`Ask about ${buildFacts(prod).productShort}`);
  });

  it('the hero, pricing, closing and FAQ words fit the type', () => {
    const p = salon();
    const page = (type: PageType, q = p) => generateSalesPage(q, {}, 0, type);
    const hero = (type: PageType, q = p) => sec(page(type, q), 'hero')!.data.ctaLabel;
    expect(PAGE_TYPES.map((t) => hero(t))).toEqual(['Get in touch', 'Book now', 'Contact us', 'Book now', 'See what we offer', 'Buy now']);
    const noLink = salon();
    noLink.studio.listing = { ...noLink.studio.listing, buyUrl: '' };
    expect(hero('booking', noLink)).toBe('Request a time');
    expect(sec(page('checkout'), 'pricing')!.data).toMatchObject({ heading: 'What’s included', ctaLabel: 'Buy now' });
    expect(sec(page('checkout', PROJECTS()[0]), 'pricing')!.data).toMatchObject({ heading: 'What you get', ctaLabel: 'Buy now' });
    expect(sec(page('checkout'), 'guarantee')!.data).toMatchObject({ finalHeading: `Ready to order from ${p.brand.name}?`, finalCta: 'Buy now' });
    expect(sec(page('landing'), 'guarantee')!.data).toMatchObject({ finalHeading: `Ready to book with ${p.brand.name}?`, finalCta: 'Book now' });
    const lastFaq = (type: PageType, q = p) => sec(page(type, q), 'faq')!.data.items.at(-1);
    expect(lastFaq('booking')).toEqual({ q: 'How do I book?', a: 'Use the Book now button on this page or call (512) 555-0100.' });
    expect(lastFaq('booking', noLink)).toEqual({ q: 'How do I book?', a: 'Send a request with the form on this page or call (512) 555-0100.' });
    expect(lastFaq('lead')).toEqual({ q: 'How do I get in touch?', a: 'Use the form on this page or call (512) 555-0100.' });
    expect(lastFaq('website')).toEqual({ q: 'How do I get in touch?', a: 'Use the contact details or the form on this page.' });
    expect(lastFaq('showcase')).toEqual({ q: 'How do I order or book?', a: 'Use the button under each item, or send a question with the form.' });
    expect(lastFaq('landing')).toEqual({ q: 'How do I book?', a: 'Use the booking button on this page or call (512) 555-0100.' });
  });

  it('About uses the owner’s own words, else a placeholder for them', () => {
    const p = salon();
    expect(sec(generateSalesPage(p, {}, 0, 'website'), 'about')!.data).toEqual({ heading: `About ${p.brand.name}`, body: `[A few lines about ${p.brand.name}: who you are and how you work]` });
    p.brand.pitch = 'A small salon run by two stylists.';
    expect((sec(generateSalesPage(p, {}, 0, 'website'), 'about')!.data as { body: string }).body).toBe('A small salon run by two stylists.');
    p.brand.mission = 'Good haircuts, close to home.';
    expect((sec(generateSalesPage(p, {}, 0, 'website'), 'about')!.data as { body: string }).body).toBe('Good haircuts, close to home.');
  });

  it('the metadata’s last sentence says what the page lets people do', () => {
    const p = salon();
    const end = (type: PageType, q = p) => generateSeoMeta(q, {}, 0, type).metaDescription;
    expect(end('booking')).toMatch(/ Book online\.$/);
    expect(end('lead')).toMatch(/ Get in touch today\.$/);
    expect(end('showcase')).toMatch(/ See services and prices\.$/);
    expect(end('website')).toMatch(/for [^.]+\.$/);
    expect(end('checkout')).not.toMatch(/Buy online/);
    expect(end('checkout', { ...p, marketing: { ...p.marketing, pageLinks: { payment: 'buy.stripe.com/x' } } })).toMatch(/ Buy online\.$/);
    expect(end('landing')).toMatch(/ Book today\.$/);
    const noLink = salon();
    noLink.studio.listing.buyUrl = '';
    expect(end('booking', noLink)).toMatch(/ Request a time online\.$/);
    // a product's description is as it was
    const prod = PROJECTS()[0];
    expect(generateSeoMeta(prod, {}, 0, 'checkout').metaDescription).toBe(generateSeoMeta(prod, {}, 0).metaDescription);
  });

  it('section labels and anchors cover every section', () => {
    expect(SECTION_LABEL).toMatchObject({ leadForm: 'Form', offers: 'Offers & prices', about: 'About', contact: 'Contact details' });
    expect(ANCHOR).toMatchObject({ hero: 'home', leadForm: 'lead-form', offers: 'offers', about: 'about', contact: 'contact', pricing: 'pricing', gallery: 'gallery', faq: 'faq' });
  });
});

describe('the owner’s facts', () => {
  const p = salon();
  const page = generateSalesPage(p, {}, 0, 'booking');

  it('items, contact details and the form’s time setting are put back over an AI answer', () => {
    const offers = sec(page, 'offers')!;
    const aiOffers = { ...offers, data: { heading: 'Our services', intro: 'Pick one.', items: [{ ...offers.data.items[0], price: 1 }, { ...offers.data.items[0], id: 'x', name: 'Invented' }] } } as SalesSection;
    expect(keepFacts(aiOffers, offers).data).toEqual({ heading: 'Our services', intro: 'Pick one.', items: offers.data.items });
    const contact = sec(page, 'contact')!;
    const aiContact = { ...contact, data: { ...contact.data, heading: 'Find us', phone: '555-FAKE', email: 'made@up.com', address: 'Somewhere', hours: '24/7' } } as SalesSection;
    expect(keepFacts(aiContact, contact).data).toEqual({ ...contact.data, heading: 'Find us' });
    const form = sec(page, 'leadForm')!;
    const aiForm = { ...form, data: { ...form.data, heading: 'Ask us', askTime: false } } as SalesSection;
    expect(keepFacts(aiForm, form).data).toEqual({ ...form.data, heading: 'Ask us' });
  });

  it('a rewrite keeps the items and contact details the owner has on the page', () => {
    const mine: SalesPage = edit(edit(page, 'offers', (d) => ({ ...d, items: [{ ...d.items[0], price: 70, duration: '45 min' }, ...d.items.slice(1)] })), 'contact', (d) => ({ ...d, hours: 'By appointment' }));
    const again = generateSalesPage(withPage(p, mine, 'booking'), {}, 3, 'booking');
    expect((sec(again, 'offers')!.data as OffersData).items).toEqual((sec(mine, 'offers')!.data as OffersData).items);
    expect((sec(again, 'contact')!.data as ContactData).hours).toBe('By appointment');
    // the owner turned off "Ask for a preferred time": a rewrite of the same type keeps that
    const noTime = edit(page, 'leadForm', (d) => ({ ...d, askTime: false }));
    expect((sec(generateSalesPage(withPage(p, noTime, 'booking'), {}, 1, 'booking'), 'leadForm')!.data as LeadFormData).askTime).toBe(false);
  });
});

describe('changing the page’s type', () => {
  const p = salon();
  const booking = edit(edit(generateSalesPage(p, {}, 0, 'booking'), 'offers', (d) => ({ ...d, items: d.items.map((it, i) => (i === 0 ? { ...it, duration: '60 min', price: 70 } : it)) })), 'contact', (d) => ({ ...d, hours: 'Weekends' }));
  const landing = edit(edit(generateSalesPage(p, {}, 0, 'landing'), 'guarantee', (d) => ({ ...d, offered: true, heading: 'Our promise', body: 'Not happy? We redo it.' })), 'pricing', (d) => ({ ...d, badge: 'Most booked' }));

  it('keeps sections that hold what the owner entered, hidden at the end', () => {
    const lead = generateSalesPage(withPage(p, booking, 'booking'), {}, 0, 'lead');
    const next = withKeptSections(lead, booking);
    expect(next.sections.map((s) => [s.type, s.visible])).toEqual([
      ['hero', true],
      ['solution', true],
      ['leadForm', true],
      ['proof', true],
      ['faq', true],
      ['offers', false],
      ['contact', false],
    ]);
    expect(sectionsKeptHidden(booking, sectionPlan('lead', p).map((s) => s.type))).toEqual(['offers', 'contact']);
    // from a landing page: the owner's guarantee and the price card's badge
    expect(sectionsKeptHidden(landing, sectionPlan('website', p).map((s) => s.type))).toEqual(['pricing', 'guarantee']);
    // nothing of the owner's: nothing kept
    expect(sectionsKeptHidden(generateSalesPage(p, {}, 0, 'landing'), sectionPlan('lead', p).map((s) => s.type))).toEqual([]);
    expect(withKeptSections(lead, null)).toBe(lead);
    // the same plan again (Rewrite page): nothing extra
    expect(withKeptSections(booking, booking).sections).toHaveLength(booking.sections.length);
  });

  it('switching back finds them again: the services, prices, durations and contact details come back', () => {
    const lead = withKeptSections(generateSalesPage(withPage(p, booking, 'booking'), {}, 0, 'lead'), booking);
    const back = withKeptSections(generateSalesPage(withPage(p, lead, 'lead'), {}, 0, 'booking'), lead);
    expect(back.sections.map((s) => s.type)).toEqual(['hero', 'offers', 'leadForm', 'proof', 'faq', 'contact']);
    expect(sec(back, 'offers')!.data).toEqual(sec(booking, 'offers')!.data);
    expect((sec(back, 'contact')!.data as ContactData).hours).toBe('Weekends');
    // and the landing page's guarantee comes back to a checkout page
    const site = withKeptSections(generateSalesPage(withPage(p, landing, 'landing'), {}, 0, 'website'), landing);
    const checkout = generateSalesPage(withPage(p, site, 'website'), {}, 0, 'checkout');
    expect(sec(checkout, 'guarantee')!.data).toMatchObject({ offered: true, heading: 'Our promise' });
    expect(sec(checkout, 'pricing')!.data).toMatchObject({ badge: 'Most booked' });
  });
});

describe('images on offered items', () => {
  const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, w: 1200, h: 800 });
  const img = (n: number): PromptImage => ({ key: `img-${n}`, media: media(`m${n}`) });
  const p = salon();
  const page = edit(generateSalesPage(p, {}, 0, 'showcase'), 'offers', (d) => ({ ...d, items: d.items.map((it, i) => (i === 0 ? { ...it, imageId: 'm2', imageAlt: '' } : it)) }));

  it('are on the page, and the score asks for their alt text', () => {
    expect(pageImageIds(page)).toEqual(['m2']);
    expect(pageImageIds(edit(page, 'offers', (d) => d, false), { visibleOnly: true })).toEqual([]);
    const meta = generateSeoMeta(p);
    const altCheck = (pg: SalesPage) => scoreSeo(meta, pg, 'showcase').checks.find((c) => c.id === 'img-alt');
    expect(altCheck(page)).toMatchObject({ pass: false });
    expect(altCheck(edit(page, 'offers', (d) => ({ ...d, items: d.items.map((it, i) => (i === 0 ? { ...it, imageAlt: 'A fresh cut' } : it)) })))).toMatchObject({ pass: true });
  });

  it('an image removed from the page’s images leaves the item, without it', () => {
    const pruned = pruneImages(page, [img(1)]);
    const first = (sec(pruned, 'offers')!.data as OffersData).items[0];
    expect(first.name).toBe('Cut & style');
    expect(first).not.toHaveProperty('imageId');
    expect(first).not.toHaveProperty('imageAlt');
    expect(pruneImages(page, [img(2)])).toBe(page);
  });

  it('a new gallery goes after the services or About section', () => {
    const at = (type: PageType) => {
      const placed = placeImages(generateSalesPage(p, {}, 0, type), p, [img(1), img(2)], { hero: 'img-1', gallery: [{ key: 'img-2' }] });
      return placed.sections.map((s) => s.type);
    };
    expect(at('website')).toEqual(['hero', 'offers', 'about', 'gallery', 'proof', 'faq', 'contact', 'leadForm']);
    expect(at('booking')).toEqual(['hero', 'offers', 'gallery', 'leadForm', 'proof', 'faq', 'contact']);
    expect(at('checkout')).toEqual(['hero', 'gallery', 'pricing', 'proof', 'faq', 'guarantee']);
    expect(at('landing')).toEqual(['hero', 'problem', 'solution', 'gallery', 'proof', 'pricing', 'faq', 'guarantee']);
  });

  it('show on the published page with their own alt text', () => {
    const withAlt = edit(page, 'offers', (d) => ({ ...d, items: d.items.map((it, i) => (i === 0 ? { ...it, imageAlt: 'A fresh cut' } : it)) }));
    const out = html(as(p, 'showcase'), withAlt, { imageUrl: (id) => (id === 'm2' ? '{{img-2}}' : undefined), imageSize: () => ({ w: 1200, h: 800 }) });
    expect(out).toContain('<article class="item"><img src="{{img-2}}" alt="A fresh cut" width="1200" height="800" loading="lazy" decoding="async"><h3>Cut &amp; style</h3>');
    // height: auto, or the image's height attribute would win over its 4:3 shape
    expect(out).toContain('.item img { display: block; width: 100%; height: auto; aspect-ratio: 4 / 3; object-fit: cover;');
    // no address for it (a copy of the page that can't load it): no image
    expect(html(as(p, 'showcase'), withAlt)).not.toContain('<img');
  });
});

describe('the score', () => {
  it('asks each type for the words and headings it needs (a landing page as before)', () => {
    const p = salon();
    const meta = generateSeoMeta(p);
    const labels = (type: PageType) => scoreSeo(meta, generateSalesPage(p, {}, 0, type), type).checks.filter((c) => c.id === 'words' || c.id === 'h2').map((c) => c.label);
    expect(labels('landing')).toEqual(['At least 350 words of content', 'At least 3 H2 section headings']);
    expect(scoreSeo(meta, generateSalesPage(p)).checks.find((c) => c.id === 'words')!.label).toBe('At least 350 words of content');
    expect(labels('website')).toEqual(['At least 400 words of content', 'At least 3 H2 section headings']);
    expect(labels('showcase')).toEqual(['At least 250 words of content', 'At least 3 H2 section headings']);
    expect(labels('booking')).toEqual(['At least 250 words of content', 'At least 3 H2 section headings']);
    expect(labels('lead')).toEqual(['At least 180 words of content', 'At least 2 H2 section headings']);
    expect(labels('checkout')).toEqual(['At least 200 words of content', 'At least 2 H2 section headings']);
    // partial credit from the lower number
    const words = (type: PageType, n: number) => {
      const page = edit(generateSalesPage(p, {}, 0, type), 'faq', (d) => ({ ...d, items: [] }));
      const filler = edit(page, 'hero', (d) => ({ ...d, subheadline: `${d.subheadline} ${'word '.repeat(n)}` }));
      return scoreSeo(meta, filler, type).checks.find((c) => c.id === 'words')!;
    };
    expect(words('lead', 200)).toMatchObject({ pass: true });
    expect(words('lead', 40)).toMatchObject({ pass: false });
  });

  it('counts the words the new sections show', () => {
    const p = salon();
    const page = generateSalesPage(p, {}, 0, 'website');
    const t = pageText(page);
    expect(t.h2s).toEqual(expect.arrayContaining(['Services', `About ${p.brand.name}`, 'Contact', 'Send a message']));
    expect(t.all).toContain('Wash, cut and blow-dry.');
    expect(t.all).toContain('Tue–Sat 9–6');
    expect(t.all).toContain(`Write to ${p.brand.name} here.`);
    // left off the page: not counted
    const empty = edit(edit(page, 'offers', (d) => ({ ...d, items: [] })), 'contact', (d) => ({ ...d, address: '', hours: '', phone: '', email: '' }));
    expect(pageText(empty).h2s).not.toEqual(expect.arrayContaining(['Services']));
    expect(pageText(empty).h2s).not.toContain('Contact');
  });
});

describe('buttons', () => {
  const p = salon();
  const t = (extra: Partial<PageTargets> = {}): PageTargets => ({ booking: '', payment: '', hasForm: false, hasContact: false, ...extra });
  const item = (extra: Partial<OfferItem>): OfferItem => ({ id: 'i', name: 'Cut', description: '', price: 50, priceNote: '', duration: '', cta: 'book', ...extra });

  it('each item’s button opens the owner’s own link, the form or the contact details, or isn’t there', () => {
    expect(itemTarget(item({ cta: 'book' }), t({ booking: 'https://cal.example.com' }), true)).toEqual({ href: 'https://cal.example.com', label: 'Book now' });
    expect(itemTarget(item({ cta: 'book' }), t({ hasForm: true }), true)).toEqual({ href: '#lead-form', label: 'Request a time' });
    expect(itemTarget(item({ cta: 'book' }), t(), true)).toBeNull();
    expect(itemTarget(item({ cta: 'buy' }), t(), true)).toBeNull();
    expect(itemTarget(item({ cta: 'buy' }), t({ payment: 'https://buy.stripe.com/a' }), true)).toEqual({ href: 'https://buy.stripe.com/a', label: 'Buy now' });
    // the item's own link wins (and a bad one doesn't count)
    expect(itemTarget(item({ cta: 'buy', link: 'buy.stripe.com/own' }), t({ payment: 'https://buy.stripe.com/a' }), true)).toEqual({ href: 'https://buy.stripe.com/own', label: 'Buy now' });
    expect(itemTarget(item({ cta: 'buy', link: 'javascript:alert(1)' }), t(), true)).toBeNull();
    expect(itemTarget(item({ cta: 'book', link: 'acuity.example.com/cut' }), t({ booking: 'https://cal.example.com' }), true)!.href).toBe('https://acuity.example.com/cut');
    expect(itemTarget(item({ cta: 'inquire', price: 0 }), t({ hasForm: true }), true)).toEqual({ href: '#lead-form', label: 'Get a quote' });
    expect(itemTarget(item({ cta: 'inquire', price: 0, priceNote: 'Free' }), t({ hasContact: true }), true)).toEqual({ href: '#contact', label: 'Ask about this' });
    expect(itemTarget(item({ cta: 'inquire' }), t({ hasForm: true }), true)).toEqual({ href: '#lead-form', label: 'Ask about this' });
    expect(itemTarget(item({ cta: 'inquire', price: 0 }), t({ hasForm: true }), false)!.label).toBe('Ask about this');
    expect(itemTarget(item({ cta: 'inquire' }), t(), true)).toBeNull();
    expect(itemTarget(item({ cta: 'none' }), t({ hasForm: true, booking: 'https://cal.example.com' }), true)).toBeNull();
  });

  it('the hero’s button goes to the first step of the type that’s on the page', () => {
    const hero = (type: PageType, q: Project = p, page = generateSalesPage(q, {}, 0, type)) => heroHref(page, as(q, type), pageTargets(page, as(q, type)));
    const noLink = salon();
    noLink.studio.listing.buyUrl = '';
    expect(hero('lead')).toBe('#lead-form');
    expect(hero('booking')).toBe('https://cal.example.com/salon');
    expect(hero('booking', noLink)).toBe('#lead-form');
    expect(hero('website')).toBe('#contact');
    expect(hero('showcase')).toBe('#offers');
    expect(hero('checkout')).toBe('#pricing');
    expect(hero('checkout', { ...p, marketing: { ...p.marketing, pageLinks: { payment: 'buy.stripe.com/pay' } } })).toBe('https://buy.stripe.com/pay');
    expect(hero('landing')).toBe('#pricing');
    // each step needs its section on the page
    const lead = generateSalesPage(p, {}, 0, 'lead');
    expect(hero('lead', p, edit(lead, 'leadForm', (d) => d, false))).toBe('');
    const site = generateSalesPage(noLink, {}, 0, 'website');
    expect(hero('website', noLink, edit(site, 'contact', (d) => d, false))).toBe('#lead-form');
    const landing = edit(generateSalesPage(p, {}, 0, 'landing'), 'pricing', (d) => d, false);
    expect(hero('landing', p, landing)).toBe('https://cal.example.com/salon');
    expect(hero('landing', noLink, edit(generateSalesPage(noLink, {}, 0, 'landing'), 'pricing', (d) => d, false))).toBe('');
  });

  it('a website’s menu lists the sections it shows', () => {
    const page = generateSalesPage(p, {}, 0, 'website');
    expect(websiteMenu(page, true).map((m) => `${m.label} ${m.anchor}`)).toEqual(['Home #home', 'Services #offers', 'About #about', 'FAQ #faq', 'Contact #contact']);
    expect(websiteMenu(page, false).map((m) => m.label)).toContain('Offers');
    const bare = edit(edit(edit(page, 'faq', (d) => ({ ...d, items: [] })), 'about', (d) => ({ ...d, body: ' ' })), 'contact', (d) => d, false);
    expect(websiteMenu(bare, true).map((m) => `${m.label} ${m.anchor}`)).toEqual(['Home #home', 'Services #offers', 'Contact #lead-form']);
  });
});

describe('the exported page', () => {
  const p = salon();

  it('with a published lead magnet, the form sends its id so the server gives the download after the sign-up', () => {
    const withMagnet: Project = { ...as(p, 'lead'), marketing: { ...p.marketing, pageType: 'lead', leadMagnet: { id: 'lm', type: 'guide', title: 'Free guide', subtitle: '', intro: '', sections: [], cta: '', optInHeadline: '', optInBullets: [], buttonLabel: '', createdAt: 0, delivery: { source: 'pdf', fileId: 'AbCdEfGhIjKlMnOpQrStUv', link: 'https://app.example/m/AbCdEfGhIjKlMnOpQrStUv', gate: true, publishedAt: 1 } } } };
    const out = html(withMagnet, generateSalesPage(withMagnet, {}, 0, 'lead'), { leadAction: '/x/lead' });
    expect(out).toContain('<input type="hidden" name="kind" value="lead"><input type="hidden" name="magnet" value="AbCdEfGhIjKlMnOpQrStUv">');
  });

  it('a form that posts to the published page’s /lead, with the app’s own fields and a hidden trap for bots', () => {
    const page = generateSalesPage(p, {}, 0, 'lead');
    const out = html(as(p, 'lead'), page, { leadAction: '/x/lead' });
    expect(out).toContain('<section class="lead-form" id="lead-form">');
    expect(out).toContain('<form method="post" action="/x/lead" enctype="application/x-www-form-urlencoded" accept-charset="utf-8">');
    expect(out).toContain('<fieldset>');
    expect(out).not.toMatch(/<fieldset disabled|<input[^>]* disabled|<button[^>]* disabled/);
    expect(out).toContain('<label for="lf-name">Your name</label><input id="lf-name" name="name" autocomplete="name" maxlength="120" required>');
    expect(out).toContain('<label for="lf-email">Email</label><input id="lf-email" name="email" type="email" autocomplete="email" maxlength="254" required>');
    expect(out).toContain('<label for="lf-phone">Phone (optional)</label>');
    expect(out).toContain('<label for="lf-message">Message (optional)</label><textarea id="lf-message" name="message" rows="4" maxlength="2000"></textarea>');
    expect(out).toContain('<div class="hp" aria-hidden="true"><label for="lf-website">Leave this empty</label><input id="lf-website" name="website" tabindex="-1" autocomplete="off"></div>');
    expect(out).toContain('<button class="btn" type="submit">Send</button>');
    // the unticked box for emails, and who gets what's sent
    expect(out).toContain(`<label class="consent"><input type="checkbox" name="consent" value="yes"> <span>Email me tips and offers from ${p.brand.name}. I can unsubscribe at any time.</span></label>`);
    expect(out).toContain(`<p class="fine">${p.brand.name} receives what you send here.</p>`);
    expect(out).not.toContain('name="magnet"');
    expect(out).not.toContain('name="time"');
    expect(out).not.toContain('Publish this page to collect leads.');
    // SEO pages run no scripts
    expect(out).not.toMatch(/<script(?! type="application\/ld\+json")/);
    // a booking request asks for a time
    const noLink = salon();
    noLink.studio.listing.buyUrl = '';
    expect(html(as(noLink, 'booking'), generateSalesPage(noLink, {}, 0, 'booking'), { leadAction: '/x/lead' })).toContain(
      '<label for="lf-time">Preferred day and time</label><input id="lf-time" name="time" maxlength="120" required placeholder="For example: Tuesday morning">',
    );
  });

  it('a form that can’t send yet says so, and never pretends', () => {
    const out = html(as(p, 'lead'), generateSalesPage(p, {}, 0, 'lead'));
    expect(out).toContain('<form>');
    expect(out).toContain('<fieldset disabled>');
    expect(out).toContain('<p class="note">Publish this page to collect leads.</p>');
    expect(out).not.toContain('action=');
    // a hidden form is not on the page at all
    const hidden = edit(generateSalesPage(p, {}, 0, 'lead'), 'leadForm', (d) => d, false);
    const none = html(as(p, 'lead'), hidden, { leadAction: '/x/lead' });
    expect(none).not.toContain('<form');
    expect(none).not.toContain('lead-form');
  });

  it('section ids for links within the page (a landing page keeps its markup)', () => {
    const site = html(as(p, 'website'), generateSalesPage(p, {}, 0, 'website'));
    for (const id of ['home', 'offers', 'about', 'faq', 'contact', 'lead-form']) expect(site).toContain(`id="${id}"`);
    expect(site).toContain('<header class="hero" id="home">');
    const booking = html(as(p, 'booking'), generateSalesPage(p, {}, 0, 'booking'));
    expect(booking).toContain('<section class="offers" id="offers">');
    expect(booking).toContain('<section class="contact" id="contact">');
    expect(booking).not.toContain('id="home"');
    expect(booking).toContain('<section class="faq">');
    const landing = html(p, generateSalesPage(p));
    expect(landing).toContain('<header class="hero">');
    expect(landing).toContain('<section class="pricing" id="pricing">');
    expect(landing).not.toMatch(/id="(home|faq|offers|lead-form|contact|about)"/);
    expect(landing).not.toContain('.menu');
    expect(landing).not.toContain('.lead-form');
  });

  it('a website has a menu to the sections it shows', () => {
    const page = generateSalesPage(p, {}, 0, 'website');
    const out = html(as(p, 'website'), page);
    // the brand's mark and name, the links to the sections it shows, and the page's one call to action (the hero's)
    expect(out).toContain(`<nav class="menu" aria-label="Main"><div class="wrap menu-row"><a class="menu-brand" href="#home"><span class="mark" aria-hidden="true">${initials(p.brand.name)}</span>${p.brand.name}</a><ul><li><a href="#home">Home</a></li><li><a href="#offers">Services</a></li><li><a href="#about">About</a></li><li><a href="#faq">FAQ</a></li><li><a href="#contact">Contact</a></li></ul><a class="topbar-cta" href="#contact">`);
    expect(out).toContain('.menu { position: sticky; top: 0;');
    expect(out).toContain('html { scroll-behavior: smooth; }');
    // Gallery only with photos it can show, FAQ only with questions
    const media: MediaRef = { id: 'm1', kind: 'image', name: 'a.jpg', mime: 'image/jpeg', size: 1, createdAt: 0, w: 10, h: 10 };
    const withPhotos = edit(placeImages(page, p, [{ key: 'img-1', media }], { gallery: [{ key: 'img-1', alt: 'Inside' }] }), 'faq', (d) => ({ ...d, items: [] }));
    const shown = html(as(p, 'website'), withPhotos, { imageUrl: () => '{{img-1}}' });
    expect(shown).toContain('<li><a href="#gallery">Gallery</a></li>');
    expect(shown).toContain('<section class="gallery" id="gallery">');
    expect(shown).not.toContain('href="#faq"');
    expect(html(as(p, 'website'), withPhotos)).not.toContain('href="#gallery"');
    // other types have no menu
    expect(html(as(p, 'showcase'), generateSalesPage(p, {}, 0, 'showcase'))).not.toContain('<nav');
  });

  it('the hero, item, pricing and closing buttons open what the type says, or aren’t there', () => {
    const booking = html(as(p, 'booking'), generateSalesPage(p, {}, 0, 'booking'));
    expect(booking).toContain('<a class="btn" href="https://cal.example.com/salon">Book now</a>');
    // the form is hidden (there's a booking link): a quote is asked for through the contact details
    expect(booking).toContain('<a class="btn" href="#contact">Get a quote</a>');
    const noLink = salon();
    noLink.studio.listing.buyUrl = '';
    expect(html(as(noLink, 'booking'), generateSalesPage(noLink, {}, 0, 'booking'))).toContain('<a class="btn" href="#lead-form">Request a time</a>');
    const showcase = html(as(p, 'showcase'), generateSalesPage(p, {}, 0, 'showcase'));
    expect(showcase).toContain('<a class="btn" href="#offers">See what we offer</a>');
    // Buy items: no button without a payment link, the page's link otherwise
    const shop = salon();
    shop.studio.listing.bookingType = 'buy';
    shop.studio.listing.buyUrl = '';
    const buyPage = generateSalesPage(shop, {}, 0, 'showcase');
    expect(html(as(shop, 'showcase'), buyPage)).not.toContain('Buy now');
    const paid = { ...shop, marketing: { ...shop.marketing, pageLinks: { payment: 'https://buy.stripe.com/shop' } } };
    expect(html(as(paid, 'showcase'), buyPage)).toContain('<a class="btn" href="https://buy.stripe.com/shop">Buy now</a>');
    // checkout: Buy now opens the payment link (hero, pricing card and closing)
    const checkout = generateSalesPage(paid, {}, 0, 'checkout');
    const co = html(as(paid, 'checkout'), checkout);
    expect(co.match(/<a class="btn( block)?" href="https:\/\/buy\.stripe\.com\/shop">Buy now<\/a>/g)).toHaveLength(3);
    // a page whose button has nowhere to go has none
    const lead = edit(generateSalesPage(p, {}, 0, 'lead'), 'leadForm', (d) => d, false);
    expect(html(as(p, 'lead'), lead)).not.toContain('<a class="btn"');
  });

  it('prices: $N with its note, the note alone, or “Ask for a quote” / “Free”', () => {
    const out = html(as(p, 'showcase'), generateSalesPage(p, {}, 0, 'showcase'));
    expect(out).toContain('<p class="price-line"><b>$65</b> <span>per visit</span></p>');
    expect(out).toContain('<p class="price-line"><b>Ask for a quote</b></p>');
    expect(out).toContain('<p class="price-line"><b>Free</b></p>');
    const prod = PROJECTS()[0];
    const page = edit(generateSalesPage(prod, {}, 0, 'showcase'), 'offers', (d) => ({ ...d, items: [{ ...d.items[0], price: 0, priceNote: '' }] }));
    expect(html(as(prod, 'showcase'), page)).toContain('<p class="price-line"><b>Free</b></p>');
  });

  it('contact details: a call or email link only when they check out', () => {
    const page = edit(generateSalesPage(p, {}, 0, 'booking'), 'contact', (d) => ({ ...d, phone: 'call the shop', email: 'hi at salon' }));
    const out = html(as(p, 'booking'), page);
    expect(out).toContain('<li><b>Phone:</b> call the shop</li>');
    expect(out).toContain('<li><b>Email:</b> hi at salon</li>');
    expect(out).not.toContain('tel:');
    expect(out).not.toContain('mailto:');
    const ok = html(as(p, 'booking'), generateSalesPage(p, {}, 0, 'booking'));
    expect(ok).toContain('<li><b>Phone:</b> <a href="tel:5125550100">(512) 555-0100</a></li>');
    expect(ok).toContain('<li><b>Email:</b> <a href="mailto:hi@salon.example.com">hi@salon.example.com</a></li>');
  });

  it('structured data: only what the page shows', () => {
    const booking = mainLd(html(as(p, 'booking'), generateSalesPage(p, {}, 0, 'booking')));
    expect(booking).toMatchObject({ '@type': 'LocalBusiness', telephone: '(512) 555-0100', email: 'hi@salon.example.com', address: { addressLocality: 'Austin', addressRegion: 'TX' } });
    const catalog = booking.hasOfferCatalog as { name: string; itemListElement: Record<string, unknown>[] };
    expect(catalog.name).toBe('Services');
    expect(catalog.itemListElement).toEqual([
      { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Cut & style', description: 'Wash, cut and blow-dry.' }, price: 65, priceCurrency: 'USD' },
      { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Colour', description: 'Priced after a consultation.' } },
      { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Fringe trim' } },
    ]);
    // contact hidden, or a phone that doesn't check out: no telephone
    const hidden = mainLd(html(as(p, 'booking'), edit(generateSalesPage(p, {}, 0, 'booking'), 'contact', (d) => d, false)));
    expect(hidden).not.toHaveProperty('telephone');
    expect(hidden).not.toHaveProperty('email');
    const lead = mainLd(html(as(p, 'lead'), generateSalesPage(p, {}, 0, 'lead')));
    expect(lead).not.toHaveProperty('telephone');
    expect(lead).not.toHaveProperty('hasOfferCatalog');
    // a business's checkout page offers its price
    const co = mainLd(html(as(p, 'checkout'), generateSalesPage(p, {}, 0, 'checkout')));
    expect(co.makesOffer).toEqual({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Cut & style' }, price: 65, priceCurrency: 'USD' });
    // a product: its price when there is one, never "availability"
    const prod = PROJECTS()[0];
    const pl = mainLd(html(as(prod, 'showcase'), generateSalesPage(prod, {}, 0, 'showcase')));
    expect(pl).toMatchObject({ '@type': 'Product', name: buildFacts(prod).productShort, offers: { '@type': 'Offer', priceCurrency: 'USD', price: 29 } });
    expect(JSON.stringify(pl)).not.toContain('availability');
    const free = edit(generateSalesPage(prod, {}, 0, 'checkout'), 'pricing', (d) => ({ ...d, price: 0 }));
    expect(mainLd(html(as(prod, 'checkout'), free))).not.toHaveProperty('offers');
    const freeItem = edit(generateSalesPage(prod, {}, 0, 'showcase'), 'offers', (d) => ({ ...d, items: d.items.map((it) => ({ ...it, price: 0 })) }));
    expect(mainLd(html(as(prod, 'showcase'), freeItem))).not.toHaveProperty('offers');
    // the FAQ as before
    const all = jsonLd(html(as(p, 'website'), generateSalesPage(p, {}, 0, 'website')));
    expect(Array.isArray(all) && all[1]['@type']).toBe('FAQPage');
  });

  it('the owner’s words are text, never markup or image tokens', () => {
    const page = edit(
      edit(
        edit(generateSalesPage(p, {}, 0, 'website'), 'offers', (d) => ({ ...d, items: [{ ...d.items[0], name: '<script>alert(1)</script> {{img-1}} "Deluxe"', description: 'A & B </p>', link: 'https://x.example/?a="b"' }] })),
        'contact',
        (d) => ({ ...d, address: '<b>Main St</b>', hours: '{{img-2}}' }),
      ),
      'leadForm',
      (d) => ({ ...d, heading: 'Ask “us” {{img-3}} <i>now</i>', buttonLabel: '<b>Go</b>' }),
    );
    const out = html(as(p, 'website'), page, { leadAction: '/x/lead' });
    expect(out).not.toContain('<script>alert');
    expect(out).not.toMatch(/\{\{img-\d\}\}/);
    expect(out).not.toContain('<b>Main St</b>');
    expect(out).not.toContain('<i>now</i>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;b&gt;Go&lt;/b&gt;');
    expect(out).toContain('Ask “us”');
    // in the structured data too
    expect(out).not.toMatch(/"name": "<script/);
    expect(out).toContain('\\u003cscript>alert(1)\\u003c/script> {\\u007bimg-1}} \\"Deluxe\\"');
  });
});

describe('a landing page’s HTML is exactly what it was before page types', () => {
  it('a business with a booking link', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const p = JSON.parse(businessJson) as Project;
    expect(exportSalesHtml(p.marketing.salesPage!, p.marketing.seo!, p.brand, p)).toBe(businessHtml);
    // the same with the type set, and with a form address passed (it has no form)
    expect(exportSalesHtml(p.marketing.salesPage!, p.marketing.seo!, p.brand, as(p, 'landing'), { leadAction: '/x/lead' })).toBe(businessHtml);
  });

  it('a product with images', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const p = JSON.parse(productJson) as Project;
    const images = p.marketing.seoImages ?? [];
    const opts: SalesHtmlOptions = {
      imageUrl: (id) => {
        const i = images.find((x) => x.media.id === id);
        return i ? `{{${i.key}}}` : undefined;
      },
      imageSize: (id) => {
        const m = images.find((x) => x.media.id === id)?.media;
        return m?.w && m?.h ? { w: m.w, h: m.h } : undefined;
      },
      canonical: 'https://app.example/taxtidy-tracker',
      origin: 'https://app.example',
    };
    expect(exportSalesHtml(p.marketing.salesPage!, p.marketing.seo!, p.brand, p, opts)).toBe(productHtml);
  });
});

describe('a section written on its own', () => {
  it('fits the page’s type', () => {
    const p = salon();
    expect((generateSalesSection(as(p, 'booking'), 'leadForm').data as LeadFormData).heading).toBe('Request a time');
    expect((generateSalesSection(p, 'leadForm', {}, 0, 'website').data as LeadFormData).heading).toBe('Send a message');
    expect(generateSalesSection(p, 'hero', {}, 0, 'checkout').data).toMatchObject({ ctaLabel: 'Buy now' });
    expect(generateSalesSection(p, 'about').type).toBe('about');
    expect(generateSalesSection(p, 'contact').type).toBe('contact');
  });
});
