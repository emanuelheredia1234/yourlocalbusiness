// The facts a build may use: only what the owner entered (one line each, empty ones left out), prices written the
// app's way, at most 8 offers, and the owner's choice of which go.
import { describe, expect, it } from 'vitest';
import type { Project, ServicePackage } from '@/lib/types';
import { newProject } from '@/store/defaults';
import { FACT_LABEL, MAX_OFFERS, buildFacts, chosenFacts } from './facts';

const pkg = (name: string, price: number, priceModel: ServicePackage['priceModel']): ServicePackage => ({ id: name, name, price, priceModel, description: '', includes: [] });

function business(): Project {
  const p = newProject('business', 'new');
  p.brand = { ...p.brand, name: 'Calm Studio' };
  p.businessType = 'Yoga studio';
  p.location = { city: 'Austin', region: 'TX' };
  p.studio.packages = [pkg('Drop-in class', 25, 'per-session'), pkg('Monthly pass', 120, 'monthly'), pkg('Intro chat', 0, 'free'), pkg('Private class', 0, 'quote'), pkg('  ', 50, 'one-time')];
  p.studio.listing = { ...p.studio.listing, contactEmail: 'hello@calm.example', phone: '+1 (512) 555-0100', hours: 'Mon–Fri 7am–8pm', bookingType: 'book', buyUrl: 'calendly.com/calm' };
  p.marketing.pageLinks = { payment: 'https://buy.stripe.com/abc' };
  return p;
}

describe('buildFacts', () => {
  it('takes only the owner’s own entries, each on one line, in a fixed order', () => {
    expect(buildFacts(business())).toEqual([
      { id: 'name', label: 'Business name', value: 'Calm Studio' },
      { id: 'what', label: 'What it is', value: 'Yoga studio' },
      { id: 'place', label: 'Where', value: 'Austin, TX' },
      { id: 'offer', label: 'Sells', value: 'Drop-in class — $25 per session' },
      { id: 'offer', label: 'Sells', value: 'Monthly pass — $120 per month' },
      { id: 'offer', label: 'Sells', value: 'Intro chat — free' },
      // no price: just its name
      { id: 'offer', label: 'Sells', value: 'Private class' },
      { id: 'booking', label: 'Booking link', value: 'https://calendly.com/calm' },
      { id: 'payment', label: 'Payment link', value: 'https://buy.stripe.com/abc' },
      { id: 'email', label: 'Email', value: 'hello@calm.example' },
      { id: 'phone', label: 'Phone', value: '+1 (512) 555-0100' },
      { id: 'hours', label: 'Opening hours', value: 'Mon–Fri 7am–8pm' },
    ]);
  });

  it('leaves out what’s empty or not valid (never a guess)', () => {
    const p = newProject('business', 'new');
    p.brand = { ...p.brand, name: 'Bare', websiteUrl: '' };
    p.studio.listing = { ...p.studio.listing, contactEmail: 'not an email', phone: '12', hours: '  ' };
    expect(buildFacts(p)).toEqual([{ id: 'name', label: 'Business name', value: 'Bare' }]);
  });

  it('a product: what it is from its format and niche, its price as the offer', () => {
    const p = newProject('product', 'new');
    p.brand = { ...p.brand, name: 'Budget Bites' };
    p.format = 'pdf';
    p.niche = 'meal prep for busy parents';
    p.studio.price = 19;
    p.studio.listing = { ...p.studio.listing, title: 'The 30-Minute Meal Prep Guide', buyUrl: 'https://gum.co/x' };
    const facts = buildFacts(p);
    expect(facts.find((f) => f.id === 'what')?.value).toBe('Guide about meal prep for busy parents');
    expect(facts.filter((f) => f.id === 'offer').map((f) => f.value)).toEqual(['The 30-Minute Meal Prep Guide — $19']);
    expect(facts.find((f) => f.id === 'payment')?.value).toBe('https://gum.co/x');
    expect(facts.some((f) => f.id === 'place' || f.id === 'booking')).toBe(false);
  });

  it('at most 8 offers; long values cut, never past the template’s delimiters', () => {
    const p = business();
    p.studio.packages = Array.from({ length: 12 }, (_, i) => pkg(`Class ${i + 1}`, 10 + i, 'per-session'));
    p.brand = { ...p.brand, name: `Calm >>> Studio <<< ${'x'.repeat(300)}` };
    const facts = buildFacts(p);
    expect(facts.filter((f) => f.id === 'offer')).toHaveLength(MAX_OFFERS);
    const name = facts.find((f) => f.id === 'name')!.value;
    expect(name).not.toMatch(/<<<|>>>/);
    expect(name.length).toBeLessThanOrEqual(200);
  });

  it('every fact has the server template’s label', () => {
    for (const f of buildFacts(business())) expect(f.label).toBe(FACT_LABEL[f.id]);
  });
});

describe('chosenFacts', () => {
  it('sends all but the ones unticked (offers as one choice), without labels', () => {
    const facts = chosenFacts(business(), ['offer', 'phone']);
    expect(facts.some((f) => f.id === 'offer' || f.id === 'phone')).toBe(false);
    expect(facts[0]).toEqual({ id: 'name', value: 'Calm Studio' });
  });
});
