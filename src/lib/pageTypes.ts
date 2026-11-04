// The SEO page's six types: what each is called and is for, the links its buttons need (the owner's own
// booking or payment link: the app never takes payments) and the sections a new page of each type gets.
// A plain module (types only): the page builder, the assistant and the Strategy tab all read it.
import type { PageType, Project, SalesSectionType } from './types';

export const PAGE_TYPES: PageType[] = ['lead', 'booking', 'website', 'landing', 'showcase', 'checkout'];

export const PAGE_TYPE_LABEL: Record<PageType, string> = { lead: 'Lead form page', booking: 'Booking page', website: 'Website', landing: 'Landing page', showcase: 'Showcase page', checkout: 'Checkout page' };

/** One line about each type (the picker, the Page type panel, the Strategy tab). */
export const PAGE_TYPE_DESC: Record<PageType, string> = {
  lead: 'A short pitch and a form. What people send arrives in Email → Leads.',
  booking: 'Your services with prices, and a Book button that opens your booking link (or a “Request a time” form).',
  website: 'One page with a menu: Home, Services, About and Contact.',
  landing: 'One offer and one call to action.',
  showcase: 'What you sell, with prices or “Ask for a quote”, photos and a button for each.',
  checkout: 'One offer: what’s included, the price and Buy now, which opens your own payment link.',
};

/** The links each type's buttons use, which the builder asks for: a booking page books, a checkout page takes payment, a showcase may do both. */
export const PAGE_TYPE_LINKS: Record<PageType, ('booking' | 'payment')[]> = { lead: [], booking: ['booking'], website: [], landing: [], showcase: ['booking', 'payment'], checkout: ['payment'] };

/** The page's type: the owner's choice, else 'landing' (what every page was before). An unknown value reads as 'landing'. */
export function pageTypeOf(project: Pick<Project, 'marketing'>): PageType {
  const t = project.marketing?.pageType;
  return t && (PAGE_TYPES as string[]).includes(t) ? t : 'landing';
}

/** "a lead form page", "a website": for sentences. */
export function pageTypeNoun(type: PageType): string {
  const name = PAGE_TYPE_LABEL[type].toLowerCase();
  return `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
}

export interface PlannedSection {
  type: SalesSectionType;
  /** on the page, but hidden to start with (the owner can show it in Sections) */
  hidden?: boolean;
}

/** The landing page's sections: every page before page types (seo.ts SECTION_ORDER is the same list). */
const LANDING: SalesSectionType[] = ['hero', 'problem', 'solution', 'proof', 'pricing', 'faq', 'guarantee'];

/** The sections a new page of this type gets, in order (the gallery is added once the page has images). */
export function sectionPlan(type: PageType, project: Project): PlannedSection[] {
  const plan = (types: SalesSectionType[]): PlannedSection[] => types.map((t) => ({ type: t }));
  switch (type) {
    case 'lead':
      return plan(['hero', 'solution', 'leadForm', 'proof', 'faq']);
    case 'booking':
      // with a booking link, Book now books: the "Request a time" form is there for when it's needed, hidden
      return [...plan(['hero', 'offers']), bookingLink(project) ? { type: 'leadForm', hidden: true } : { type: 'leadForm' }, ...plan(['proof', 'faq', 'contact'])];
    case 'website':
      return plan(['hero', 'offers', 'about', 'proof', 'faq', 'contact', 'leadForm']);
    case 'showcase':
      return plan(['hero', 'offers', 'proof', 'faq', 'leadForm', ...(project.track === 'business' ? (['contact'] as const) : [])]);
    case 'checkout':
      return plan(['hero', 'pricing', 'proof', 'faq', 'guarantee']);
    case 'landing':
    default:
      return plan(LANDING);
  }
}

/**
 * A web address a button may open: http(s), a host with a dot, no user name; normalized, with no lone
 * trailing slash. '' otherwise. (The listing's safeUrl rule, plus no user name: kept here so this module
 * imports no page code.)
 */
export function webLink(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.') || u.username || u.password) return '';
    const s = u.toString();
    return u.pathname === '/' && !u.search && !u.hash ? s.replace(/\/$/, '') : s;
  } catch {
    return '';
  }
}

/** The booking link the page uses: the one typed in the builder, else the listing's when it's a booking link (business, bookingType 'book'). '' when none. */
export function bookingLink(project: Project): string {
  const own = webLink(project.marketing.pageLinks?.booking);
  if (own) return own;
  const l = project.studio.listing;
  return project.track === 'business' && l.bookingType === 'book' ? webLink(l.buyUrl) : '';
}

/** The payment link the page uses: the one typed in the builder, else the listing's when it's for buying (a product, or bookingType 'buy'). '' when none. */
export function paymentLink(project: Project): string {
  const own = webLink(project.marketing.pageLinks?.payment);
  if (own) return own;
  const l = project.studio.listing;
  return project.track === 'product' || l.bookingType === 'buy' ? webLink(l.buyUrl) : '';
}

/** Whether a link comes from the listing (for "Using your listing’s link" hints). */
export function linkFromListing(project: Project, kind: 'booking' | 'payment'): boolean {
  if (webLink(project.marketing.pageLinks?.[kind])) return false;
  return !!(kind === 'booking' ? bookingLink(project) : paymentLink(project));
}

/** The link this type needs and doesn't have: 'payment' (checkout: needed before writing), 'booking' (optional: the form asks for a time instead), or null. */
export function missingLink(project: Project, type: PageType): 'payment' | 'booking' | null {
  if (type === 'checkout') return paymentLink(project) ? null : 'payment';
  if (type === 'booking') return bookingLink(project) ? null : 'booking';
  return null;
}
