// Our plain words (server/ads/messages.mjs, spec §11): every code a sentence, fix links only to allowlisted hosts,
// third-party text cut and flattened, the owner's problems never in the customer's words.
import { describe, expect, it } from 'vitest';
import { cut, hasMessage, messageFor, note, OWNER_CODES, safeFixUrl, ZERNIO_CODES } from './messages.mjs';

describe('messages', () => {
  it('has a sentence for every code Zernio’s refusals map to', () => {
    for (const code of new Set(Object.values(ZERNIO_CODES))) expect(hasMessage(code), code).toBe(true);
  });

  it('never names the Zernio plan, add-on, key or allowance to the customer', () => {
    for (const z of OWNER_CODES) expect(ZERNIO_CODES[z]).toBe('ADS_UNAVAILABLE');
    const text = messageFor('ADS_UNAVAILABLE');
    expect(text).not.toMatch(/zernio|plan|add-on|addon|allowance|api key|payment_required/i);
    expect(text).toMatch(/Ads Manager/);
  });

  it('says “may have happened - check status before trying again” for an unconfirmed write', () => {
    expect(messageFor('UNKNOWN', { platform: 'meta' })).toContain('may have happened - check status before trying again');
    expect(messageFor('UNKNOWN_LAUNCH', { platform: 'google' })).toContain('may have happened - check status before trying again');
    expect(messageFor('INTERRUPTED', { platform: 'meta' })).toContain('may have happened - check status before trying again');
  });

  it('formats limits in the account currency', () => {
    expect(messageFor('LIMIT_DAILY', { currency: 'EUR', after: 75, limit: 50 })).toBe('This would put €75.00 a day across your live campaigns; your limit is €50.00. Lower the amount or ask the app owner.');
    expect(messageFor('LIMIT_CURRENCY', { currency: 'EUR' })).toContain('EUR');
  });

  it('passes fix links only for the allowlisted https hosts', () => {
    expect(safeFixUrl('https://business.facebook.com/billing_hub')).toBe('https://business.facebook.com/billing_hub');
    expect(safeFixUrl('https://ads.google.com/aw/billing')).toBe('https://ads.google.com/aw/billing');
    expect(safeFixUrl('/dashboard/ads')).toBeUndefined();
    expect(safeFixUrl('https://zernio.com/dashboard')).toBeUndefined();
    expect(safeFixUrl('http://business.facebook.com/x')).toBeUndefined();
    expect(safeFixUrl('https://evil.example/?u=business.facebook.com')).toBeUndefined();
    expect(note('PAYMENT_REQUIRED', {}, 'https://evil.example/')).not.toHaveProperty('fixUrl');
  });

  it('cuts third-party text and flattens control characters', () => {
    expect(cut('a\nb\u0000c', 200)).toBe('a b c');
    expect(cut('x'.repeat(300), 200)).toHaveLength(200);
    expect(cut({ toString: () => 'no' })).toBe('');
  });

  it('answers the generic refusal for a code it doesn’t know', () => {
    expect(messageFor('SOMETHING_NEW', { platform: 'google' })).toMatch(/^Google refused this/);
  });
});
