// The facts Manus or Viktor may use when they build a page: only what the owner entered in the workspace (the
// business name, what it is, where, what it sells, the booking and payment links, email, phone, opening hours),
// each one line. The owner unticks any they don't want sent. Nothing here is made up: an empty field is left out.

import type { BuildFact, BuildFactId } from '@/lib/agentTypes';
import type { Project, ServicePriceModel } from '@/lib/types';
import { fmtMoney } from '@/lib/utils';
import { bookingLink, paymentLink } from '@/lib/pageTypes';
import { contactEmail, contactTel } from '@/ai/local/seo';
import { FORMATS } from '@/ai/knowledge';

export interface BuildFactLine extends BuildFact {
  label: string;
}

/** The labels the server's template uses too (server/agents/templates.mjs). */
export const FACT_LABEL: Record<BuildFactId, string> = {
  name: 'Business name',
  what: 'What it is',
  place: 'Where',
  offer: 'Sells',
  booking: 'Booking link',
  payment: 'Payment link',
  email: 'Email',
  phone: 'Phone',
  hours: 'Opening hours',
};

/** At most this many offer lines go (the server keeps 8 too). */
export const MAX_OFFERS = 8;

/** How a package's price is charged, in a few words ('' when the price says it all). */
const MODEL_WORD: Record<ServicePriceModel, string> = { 'one-time': '', monthly: 'per month', yearly: 'per year', 'per-session': 'per session', project: 'per project', quote: 'starting price', free: '' };

/** One line: whitespace runs collapsed, no delimiters the server's template uses, at most `max` characters. */
const line = (s: string | null | undefined, max = 200) => {
  const t = (s ?? '').replace(/<{3,}|>{3,}/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() : t;
};

/** A package as one offer line: "Name — $120 per session", "Name — free", or just its name. */
function packageLine(name: string, price: number, model: ServicePriceModel): string {
  if (model === 'free') return `${name} — free`;
  if (!(price > 0)) return name;
  const word = MODEL_WORD[model];
  return `${name} — ${fmtMoney(price)}${word ? ` ${word}` : ''}`;
}

/** The owner's facts for a build, each one line, in a fixed order; empty ones are left out. */
export function buildFacts(p: Project): BuildFactLine[] {
  const out: BuildFactLine[] = [];
  const add = (id: BuildFactId, value: string, max = 200) => {
    const v = line(value, max);
    if (v) out.push({ id, label: FACT_LABEL[id], value: v });
  };
  const business = p.track === 'business';
  add('name', p.brand.name);
  if (business) add('what', p.businessType || p.category);
  else {
    const format = p.format ? FORMATS[p.format]?.short ?? '' : '';
    const niche = (p.niche || p.category || '').trim();
    add('what', format && niche ? `${format} about ${niche}` : format || niche);
  }
  if (business) add('place', [p.location?.city, p.location?.region].map((x) => (x ?? '').trim()).filter(Boolean).join(', '));
  const offers: string[] = [];
  if (business) {
    for (const pkg of p.studio.packages) {
      const name = line(pkg.name, 120);
      if (name) offers.push(packageLine(name, pkg.price, pkg.priceModel));
    }
  } else if (p.studio.price > 0) {
    const name = line(p.studio.listing.title, 120) || line(p.brand.name, 120);
    if (name) offers.push(`${name} — ${fmtMoney(p.studio.price)}`);
  }
  for (const o of offers.slice(0, MAX_OFFERS)) add('offer', o, 160);
  add('booking', bookingLink(p));
  add('payment', paymentLink(p));
  add('email', contactEmail(p.studio.listing.contactEmail));
  add('phone', contactTel(p.studio.listing.phone) ? (p.studio.listing.phone ?? '').trim() : '');
  add('hours', p.studio.listing.hours);
  return out;
}

/** The facts that go: all of them but the ones the owner unticked. */
export function chosenFacts(p: Project, unticked: readonly BuildFactId[]): BuildFact[] {
  // offers are unticked as a group: "Sells" is one choice in the window
  return buildFacts(p)
    .filter((f) => !unticked.includes(f.id))
    .map(({ id, value }) => ({ id, value }));
}
