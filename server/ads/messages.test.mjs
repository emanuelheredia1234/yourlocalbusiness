// Our plain words (server/ads/messages.mjs, spec §11): every code a sentence, fix links only to allowlisted hosts,
// third-party text cut and flattened, the owner's problems never in the customer's words.
import { describe, expect, it } from 'vitest';
import { cut, hasMessage, keptFixUrl, messageFor, note, OWNER_CODES, REFUSAL_REASON, refusalOf, safeFixUrl, ZERNIO_CODES } from './messages.mjs';

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

  it('keeps fix links on Meta’s, Google’s and Zernio’s own sites; shows the customer only Meta’s and Google’s', () => {
    expect(keptFixUrl('https://docs.zernio.com/guides/error-handling')).toBe('https://docs.zernio.com/guides/error-handling');
    expect(safeFixUrl('https://docs.zernio.com/guides/error-handling')).toBeUndefined();
    for (const ok of ['https://www.facebook.com/ads/leadgen/tos', 'https://www.meta.com/help/', 'https://transparency.meta.com/policies', 'https://support.google.com/google-ads/answer/1'])
      expect(safeFixUrl(ok)).toBe(ok);
    // link shims, pages anyone can publish, look-alikes and other ports are never fix links
    for (const bad of ['https://l.facebook.com/l.php?u=https%3A%2F%2Fevil.example', 'https://www.facebook.com/l.php?u=x', 'https://www.google.com/url?q=https://evil.example', 'https://docs.google.com/document/d/1', 'https://sites.google.com/view/x', 'https://facebook.com.evil.example/', 'https://evilfacebook.com/', 'https://business.facebook.com:8443/x', 'javascript:alert(1)'])
      expect(keptFixUrl(bad), bad).toBeUndefined();
  });

  it('drops direction overrides and C1 control characters from third-party text', () => {
    const rlo = String.fromCharCode(0x202e);
    expect(cut(`gnp${rlo}.exe${String.fromCharCode(0x85)}x`)).toBe('gnp.exe x');
  });
});

describe('why a launch or change was refused (refusalOf)', () => {
  const META = { code: 'meta_action_blocked', type: 'platform_error', hint: 'zernio-hint', metaMessage: 'META-OWN-WORDS', fix: { label: 'x', url: 'https://www.facebook.com/help/1' } };

  it('says our own sentence for each of Zernio’s Meta refusal codes, then that nothing was created, with the fix link', () => {
    const cases = {
      ad_account_payment_required: 'Add a payment method in Meta Ads Manager (Billing).',
      ad_account_policy_not_accepted: 'non-discrimination policy',
      lead_ads_terms_not_accepted: 'Lead Ads terms',
      verified_advertiser_required: 'verify your business',
      ad_account_unusable: 'can’t run ads right now: it isn’t active, or the business is restricted from advertising',
      meta_security_check_required: 'security check',
      meta_action_blocked: 'blocked the Facebook login connected here',
      budget_too_low: 'minimum daily budget',
      meta_object_not_accessible: 'couldn’t open something this ad uses',
    };
    for (const [code, words] of Object.entries(cases)) {
      const r = refusalOf({ code: ZERNIO_CODES[code] ?? 'REFUSED', detail: { ...META, code }, kind: 'launch', platform: 'meta' });
      expect(r.message, code).toContain(words);
      expect(r.message, code).toMatch(/ Nothing was created and no money was spent\.$/);
      expect(r.message, code).not.toMatch(/to see why/);
      // our sentence: never Zernio's hint or Meta's own words
      expect(r, code).not.toHaveProperty('platformSays');
      expect(JSON.stringify(r), code).not.toMatch(/zernio-hint|META-OWN-WORDS/);
      expect(r.fixUrl, code).toBe('https://www.facebook.com/help/1');
    }
    expect(REFUSAL_REASON).toMatchObject(Object.fromEntries(Object.keys(cases).map((c) => [c, expect.any(String)])));
    for (const code of new Set(Object.values(REFUSAL_REASON))) expect(hasMessage(code), code).toBe(true);
  });

  it('a change says nothing was changed', () => {
    expect(refusalOf({ code: 'ACTION_BLOCKED', detail: { ...META }, kind: 'budget', platform: 'meta' }).message).toMatch(/ Nothing was changed\.$/);
  });

  it('a refusal it has no sentence for passes Zernio’s hint on as the platform’s words (else Meta’s own), never as ours', () => {
    const unknown = { code: 'platform_api_error', type: 'platform_error', hint: 'Use an image Meta can read.', metaTitle: 'Invalid image', metaMessage: 'The image could not be used.' };
    expect(refusalOf({ code: 'REFUSED', detail: unknown, kind: 'launch', platform: 'meta' })).toEqual({ message: 'Meta refused the launch. Nothing was created and no money was spent.', platformSays: 'Use an image Meta can read.' });
    const { hint, ...noHint } = unknown;
    void hint;
    expect(refusalOf({ code: 'REFUSED', detail: noHint, kind: 'launch', platform: 'meta' }).platformSays).toBe('Invalid image: The image could not be used.');
    expect(refusalOf({ code: 'REFUSED', detail: unknown, kind: 'resume', platform: 'meta' })).toMatchObject({ message: 'Meta refused this change. Nothing was changed.', platformSays: 'Use an image Meta can read.' });
    // and it is cut, whatever was stored
    expect(refusalOf({ code: 'REFUSED', detail: { hint: 'x'.repeat(900) }, kind: 'launch' }).platformSays).toHaveLength(300);
  });

  it('names Meta’s 24-hour rule for a refused launch whose own schedule was that short', () => {
    expect(refusalOf({ code: 'REFUSED', detail: null, kind: 'launch', platform: 'meta', shortSchedule: true }).message).toBe('Meta needs a daily-budget ad to run more than 24 hours, and this one was set for less. Launch it again with at least 2 days. Nothing was created and no money was spent.');
    // a code of Zernio's own still wins
    expect(refusalOf({ code: 'PAYMENT_REQUIRED', detail: { code: 'ad_account_payment_required' }, kind: 'launch', shortSchedule: true }).message).toMatch(/^Add a payment method/);
  });

  it('a refused launch with nothing kept says so plainly; a refused change keeps “open Ads Manager” (the campaign is there)', () => {
    expect(refusalOf({ code: 'REFUSED', kind: 'launch', platform: 'meta' }).message).toBe('Meta refused the launch. Nothing was created and no money was spent.');
    expect(refusalOf({ code: 'REFUSED', kind: 'pause', platform: 'google' }).message).toBe('Google refused this. Nothing was changed. Open Google Ads to see why.');
  });

  it('keeps team-level problems and failures that aren’t refusals as they were: no hint, no link', () => {
    const team = { status: 403, code: 'ads_allowance_exceeded', type: 'permission_error', owner: true, hint: 'SECRET', fix: { url: 'https://www.facebook.com/x' } };
    expect(refusalOf({ code: 'ADS_UNAVAILABLE', detail: team, kind: 'launch' })).toEqual({ message: messageFor('ADS_UNAVAILABLE') });
    expect(refusalOf({ code: 'RATE_LIMITED', detail: { status: 429, owner: true }, kind: 'launch', platform: 'meta' })).toEqual({ message: messageFor('RATE_LIMITED', { platform: 'meta' }) });
    expect(refusalOf({ code: 'LIMIT_DAILY', kind: 'launch', ctx: { currency: 'USD', after: 75, limit: 50 } }).message).toBe(messageFor('LIMIT_DAILY', { currency: 'USD', after: 75, limit: 50 }));
    expect(refusalOf({ code: 'NOT_CREATED', kind: 'launch', platform: 'meta' }).message).toBe(messageFor('NOT_CREATED', { platform: 'meta' }));
  });
});
