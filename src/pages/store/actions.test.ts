// Buyers go to the seller's own page, email or phone; only safe links are ever offered.
import { describe, expect, it } from 'vitest';
import { listingActions, safeEmail, safePhone, safeUrl } from './actions';

const base = { id: 'l', kind: 'product', title: 'Budget Planner', origin: 'community', seller: { name: 'S' } } as never as Parameters<typeof listingActions>[0];

describe('a listing’s actions', () => {
  it('offers the seller’s own checkout first, then website, email and phone', () => {
    const a = listingActions({ ...base, buyUrl: 'buy.stripe.com/abc', website: 'https://maya.example', contactEmail: 'hi@maya.example', phone: '(555) 123-4567' });
    expect(a.map((x) => [x.kind, x.label, x.href])).toEqual([
      ['buy', 'Buy', 'https://buy.stripe.com/abc'],
      ['website', 'Website', 'https://maya.example/'],
      ['email', 'Email', 'mailto:hi@maya.example?subject=About%20%E2%80%9CBudget%20Planner%E2%80%9D'],
      ['phone', 'Call', 'tel:5551234567'],
    ]);
    expect(a[0].hint).toBe('On buy.stripe.com');
  });

  it('names the action after how a business takes customers', () => {
    expect(listingActions({ ...base, kind: 'business', bookingType: 'book', buyUrl: 'https://calendly.com/x' })[0]).toMatchObject({ kind: 'book', label: 'Book' });
    expect(listingActions({ ...base, kind: 'business', bookingType: 'inquire', buyUrl: 'https://x.example/contact' })[0].label).toBe('Get in touch');
  });

  it('never offers unsafe or broken links', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,hi')).toBeNull();
    expect(safeUrl('localhost')).toBeNull();
    expect(safeUrl('')).toBeNull();
    expect(safeEmail('not an email')).toBeNull();
    expect(safeEmail('a@b.co?bcc=x@y.z')).toBeNull();
    expect(safePhone('12')).toBeNull();
    expect(listingActions({ ...base, buyUrl: 'javascript:alert(1)', contactEmail: 'nope' })).toEqual([]);
  });
});
