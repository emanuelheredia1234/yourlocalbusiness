// What a buyer can do with a listing: go to the seller's own page to buy or book, or contact them.
// This app takes no payments and sends no messages: every action opens the seller's own channel.
import type { Listing } from '@/lib/types';

export interface ListingAction {
  kind: 'buy' | 'book' | 'website' | 'email' | 'phone';
  label: string;
  href: string;
  /** shown under the button: where it goes */
  hint: string;
}

/** A link we're willing to open: http(s) only. */
export function safeUrl(raw: string | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') ? u.toString() : null;
  } catch {
    return null;
  }
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
export const safeEmail = (raw: string | undefined) => (raw && EMAIL.test(raw.trim()) ? raw.trim() : null);
export const safePhone = (raw: string | undefined) => {
  const t = (raw ?? '').trim();
  const tel = t.replace(/[^\d+]/g, '');
  const digits = tel.replace(/\D/g, '').length;
  return digits >= 6 && digits <= 15 ? { label: t, tel } : null;
};

/** The listing's ways to buy, book or get in touch, most direct first. */
export function listingActions(l: Listing): ListingAction[] {
  const out: ListingAction[] = [];
  const buy = safeUrl(l.buyUrl);
  const site = safeUrl(l.website);
  const email = safeEmail(l.contactEmail);
  const phone = safePhone(l.phone);
  if (buy) {
    const biz = l.kind === 'business';
    const label = biz && l.bookingType === 'book' ? 'Book' : biz && l.bookingType === 'inquire' ? 'Get in touch' : 'Buy';
    out.push({ kind: biz && l.bookingType === 'book' ? 'book' : 'buy', label, href: buy, hint: `On ${hostOf(buy)}` });
  }
  if (site && site !== buy) out.push({ kind: 'website', label: 'Website', href: site, hint: hostOf(site) });
  if (email) out.push({ kind: 'email', label: 'Email', href: `mailto:${email}?subject=${encodeURIComponent(`About “${l.title}”`)}`, hint: email });
  if (phone) out.push({ kind: 'phone', label: 'Call', href: `tel:${phone.tel}`, hint: phone.label });
  return out;
}
