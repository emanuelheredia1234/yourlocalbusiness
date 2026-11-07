// Our plain words (server/ads/messages.mjs, spec §11): every code a sentence, fix links only to allowlisted hosts,
// third-party text cut and flattened, the owner's problems never in the customer's words.
import { describe, expect, it } from 'vitest';
import { BILLING_HUB_URL, cut, fixUrlFor, hasMessage, keptFixUrl, messageFor, note, OWNER_CODES, paymentSettingsUrl, POLICY_ADMIN_URL, POLICY_PERSONAL_URL, REFUSAL_REASON, refusalOf, safeFixUrl, ZERNIO_CODES } from './messages.mjs';

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
      verified_advertiser_required: 'verified beneficiary and payer details, which this app can’t send yet. Use Meta Ads Manager for this one.',
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
      // our sentence: never Zernio's hint, nor Meta's own words except Meta's minimum budget (only Meta says it)
      if (code === 'budget_too_low') expect(r.platformSays).toBe('META-OWN-WORDS');
      else {
        expect(r, code).not.toHaveProperty('platformSays');
        expect(JSON.stringify(r), code).not.toMatch(/META-OWN-WORDS/);
      }
      expect(JSON.stringify(r), code).not.toMatch(/zernio-hint/);
      // the policy: always where a business admin accepts it (Zernio's link only records the signed-in person's own)
      expect(r.fixUrl, code).toBe(code === 'ad_account_policy_not_accepted' ? POLICY_ADMIN_URL : 'https://www.facebook.com/help/1');
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
    expect(refusalOf({ code: 'REFUSED', kind: 'budget', platform: 'google' }).message).toBe('Google refused this. Nothing was changed. Open Google Ads to see why.');
  });

  it('keeps team-level problems and failures that aren’t refusals as they were: no hint, no link', () => {
    const team = { status: 403, code: 'ads_allowance_exceeded', type: 'permission_error', owner: true, hint: 'SECRET', fix: { url: 'https://www.facebook.com/x' } };
    expect(refusalOf({ code: 'ADS_UNAVAILABLE', detail: team, kind: 'launch' })).toEqual({ message: messageFor('ADS_UNAVAILABLE') });
    expect(refusalOf({ code: 'RATE_LIMITED', detail: { status: 429, owner: true }, kind: 'launch', platform: 'meta' })).toEqual({ message: messageFor('RATE_LIMITED', { platform: 'meta' }) });
    expect(refusalOf({ code: 'LIMIT_DAILY', kind: 'launch', ctx: { currency: 'USD', after: 75, limit: 50 } }).message).toBe(messageFor('LIMIT_DAILY', { currency: 'USD', after: 75, limit: 50 }));
    expect(refusalOf({ code: 'NOT_CREATED', kind: 'launch', platform: 'meta' }).message).toBe(messageFor('NOT_CREATED', { platform: 'meta' }));
  });
});

describe('review fixes: what a refusal says, and where its fix link may go', () => {
  const NOW = 'Only the first part of this change went through (a higher spending limit, which can’t spend by itself).';
  const blocked = { status: 400, code: 'meta_action_blocked', type: 'platform_error', hint: 'zernio-hint', metaMessage: 'META-OWN-WORDS' };

  it('a change that went through in part never says nothing was changed: what went through, then why the rest didn’t', () => {
    // a budget increase: the spending limit went up, then Meta refused the budget
    const budget = refusalOf({ code: 'ACTION_BLOCKED', detail: blocked, kind: 'budget', platform: 'meta', done: ['cap'] });
    expect(budget).toEqual({ message: `${NOW} ${messageFor('META_ACTION_BLOCKED')}` });
    // a resume: the ad set and an ad were switched on, then the campaign's own switch was refused
    const resume = refusalOf({ code: 'PAYMENT_REQUIRED', detail: { code: 'ad_account_payment_required', fix: { url: 'https://business.facebook.com/billing_hub' } }, kind: 'resume', platform: 'meta', done: ['cap', 'adSetStatus', 'adStatus'], campaignOff: true });
    expect(resume).toEqual({ message: `Only part of this change went through: parts of it were switched on, but the campaign itself is still paused, so it can’t spend yet. ${messageFor('PAYMENT_REQUIRED')}`, fixUrl: 'https://business.facebook.com/billing_hub' });
    // a resume of a campaign already on (ads Meta left off): no claim that it can't spend
    expect(refusalOf({ code: 'REFUSED', detail: { status: 400 }, kind: 'resume', done: ['adSetStatus'] }).message).toBe('Only part of this change went through: parts of it were switched on, but not all of it. Meta refused the rest: open Meta Ads Manager to see why.');
    // a category with no code of Zernio's says its own sentence; the "Nothing was sent" ones say the rest wasn't
    expect(refusalOf({ code: 'BUDGET_LEVEL', detail: { status: 409, code: 'BUDGET_LEVEL_MISMATCH' }, kind: 'budget', done: ['cap'] }).message).toBe(`${NOW} ${messageFor('BUDGET_LEVEL')}`);
    expect(refusalOf({ code: 'AD_ACCOUNT_BUSY', detail: { status: 429, code: 'rate_limited' }, kind: 'end_date', done: ['cap'] }).message).toBe(`${NOW} Another change to this ad account was still going, so the rest wasn’t sent. Try again in a minute.`);
    expect(refusalOf({ code: 'RATE_LIMITED', detail: { status: 429, owner: true }, kind: 'budget', done: ['cap'] })).toEqual({ message: `${NOW} Meta was busy, so the rest wasn’t sent. Try again in a minute.` });
    // a team-level problem stays the owner's: its safe sentence, no words, no link
    expect(refusalOf({ code: 'ADS_UNAVAILABLE', detail: { status: 403, code: 'ads_allowance_exceeded', owner: true, hint: 'SECRET', fix: { url: 'https://www.facebook.com/x' } }, kind: 'budget', done: ['cap'] })).toEqual({ message: `${NOW} ${messageFor('ADS_UNAVAILABLE')}` });
    // Meta refused the rest with no code of ours: its words as data, else where to see why
    expect(refusalOf({ code: 'CHANGE_INCOMPLETE', detail: { status: 400, code: 'platform_api_error', hint: 'Use a smaller budget.' }, kind: 'budget', done: ['cap'] })).toEqual({ message: `${NOW} Meta refused the rest.`, platformSays: 'Use a smaller budget.' });
    // a check that found only an earlier step done (nothing refused): as before
    expect(refusalOf({ code: 'CHANGE_INCOMPLETE', kind: 'budget' }).message).toBe(`${NOW} Review it and try again.`);
    for (const r of [budget, resume]) expect(r.message).not.toMatch(/Nothing was (changed|sent)/);
  });

  it('a refused pause or end says it’s still running and to pause it in Ads Manager now, never “wait” or “try again”', () => {
    expect(refusalOf({ code: 'ACTION_BLOCKED', detail: blocked, kind: 'pause', platform: 'meta' })).toEqual({ message: 'Meta has blocked the Facebook login connected here from making ad changes for now. It’s still running: pause it in Meta Ads Manager now.' });
    for (const z of Object.keys(REFUSAL_REASON))
      for (const kind of ['pause', 'end']) {
        const r = refusalOf({ code: ZERNIO_CODES[z] ?? 'REFUSED', detail: { status: 400, code: z }, kind, platform: 'meta' });
        expect(r.message, `${kind} ${z}`).toMatch(/pause it in Meta Ads Manager now\.$/);
        expect(r.message, `${kind} ${z}`).not.toMatch(/wait a few hours|try again|Nothing was changed/i);
      }
    // no word of Zernio's: Meta refused to pause (or end) it, its words as data
    expect(refusalOf({ code: 'REFUSED', detail: { status: 400, code: 'platform_api_error', hint: 'Some words.' }, kind: 'end', platform: 'meta' })).toEqual({ message: 'Meta refused to end this campaign. It’s still running: pause it in Meta Ads Manager now.', platformSays: 'Some words.' });
    expect(refusalOf({ code: 'REFUSED', kind: 'pause', platform: 'google' }).message).toBe('Google refused to pause this campaign. It’s still running: pause it in Google Ads now.');
    // a campaign Meta can't find any more may not be running
    expect(refusalOf({ code: 'NOT_FOUND_REMOTE', detail: { status: 404, code: 'not_found' }, kind: 'pause' }).message).toBe(`${messageFor('NOT_FOUND_REMOTE', { platform: 'meta' })} If it’s still running, pause it in Meta Ads Manager now.`);
    // nothing sent, or a check that found it not done: still running
    expect(refusalOf({ code: 'RATE_LIMITED', detail: { status: 429, owner: true }, kind: 'pause' }).message).toBe(`${messageFor('RATE_LIMITED', { platform: 'meta' })} It’s still running: pause it in Meta Ads Manager now.`);
    expect(refusalOf({ code: 'NOT_CHANGED', kind: 'end' }).message).toBe('Meta didn’t make this change. Nothing changed. It’s still running: pause it in Meta Ads Manager now.');
    // the app being unavailable already says how to pause it now
    expect(refusalOf({ code: 'ADS_UNAVAILABLE', detail: { status: 402, owner: true }, kind: 'pause' })).toEqual({ message: messageFor('ADS_UNAVAILABLE') });
  });

  it('a refused launch whose objects Meta kept says so and never “Nothing was created”', () => {
    const fix = 'https://www.facebook.com/business/help/422289316306981';
    expect(refusalOf({ code: 'ACTION_BLOCKED', detail: { status: 422, code: 'ad_account_unusable', fix: { url: fix } }, kind: 'launch', platform: 'meta', leftBehind: 2 })).toEqual({ message: `${messageFor('AD_ACCOUNT_UNUSABLE')} ${messageFor('PARTIAL_LEFT')} No money was spent.`, fixUrl: fix });
    expect(refusalOf({ code: 'REFUSED', kind: 'launch', leftBehind: 1 }).message).toBe(`Meta refused the launch. ${messageFor('PARTIAL_LEFT')} No money was spent.`);
    expect(refusalOf({ code: 'REFUSED', kind: 'launch', leftBehind: 0 }).message).toBe('Meta refused the launch. Nothing was created and no money was spent.');
  });

  it('a launch made but not switched on says why when Meta said (ACTIVATION_NOT_SENT, CAP_NOT_SET)', () => {
    const pay = { status: 403, code: 'ad_account_payment_required', fix: { url: 'https://business.facebook.com/billing_hub/payment_settings' } };
    expect(refusalOf({ code: 'ACTIVATION_NOT_SENT', detail: pay, kind: 'launch' })).toEqual({ message: `${messageFor('ACTIVATION_NOT_SENT', { platform: 'meta' })} ${messageFor('PAYMENT_REQUIRED')}`, fixUrl: 'https://business.facebook.com/billing_hub/payment_settings' });
    // a refused spending limit: Meta's reason, not the guess about Meta's smallest limit
    expect(refusalOf({ code: 'CAP_NOT_SET', detail: pay, kind: 'launch', ctx: { currency: 'USD', cap: 350 } }).message).toBe(`Created and paused. Meta didn’t accept the $350.00 spending limit, so we didn’t switch it on. ${messageFor('PAYMENT_REQUIRED')}`);
    expect(refusalOf({ code: 'CAP_NOT_SET', kind: 'launch', ctx: { currency: 'USD', cap: 350 } }).message).toBe(messageFor('CAP_NOT_SET', { currency: 'USD', cap: 350 }));
  });

  it('budget_too_low passes on Meta’s own words (only they hold Meta’s minimum), labelled; never for a team-level problem', () => {
    const d = { status: 400, code: 'budget_too_low', type: 'platform_error', hint: 'zernio-hint', metaTitle: 'Budget too low', metaMessage: 'The minimum daily budget for this ad set is $1.00.' };
    expect(refusalOf({ code: 'BUDGET_TOO_LOW', detail: d, kind: 'launch' })).toEqual({ message: `${messageFor('BUDGET_TOO_LOW', { platform: 'meta' })} Nothing was created and no money was spent.`, platformSays: 'Budget too low: The minimum daily budget for this ad set is $1.00.' });
    expect(refusalOf({ code: 'BUDGET_TOO_LOW', detail: { code: 'budget_too_low', hint: 'Raise it to $1.00.' }, kind: 'budget' }).platformSays).toBe('Raise it to $1.00.');
    expect(refusalOf({ code: 'ADS_UNAVAILABLE', detail: { ...d, owner: true }, kind: 'launch' })).toEqual({ message: messageFor('ADS_UNAVAILABLE') });
  });

  it('names the Page and the Instagram account for insufficient_permissions, and reconnecting for an ad account not ticked', () => {
    expect(refusalOf({ code: 'PERMISSIONS', detail: { code: 'insufficient_permissions' }, kind: 'launch' }).message).toMatch(/^The Facebook login connected here doesn’t have permission to advertise with this ad account, its Facebook Page or its Instagram account\./);
    expect(refusalOf({ code: 'PERMISSIONS', detail: { code: 'ad_account_not_selected' }, kind: 'launch' }).message).toBe('This ad account wasn’t ticked when Meta ads was connected. Reconnect it (Settings → Connected accounts) and tick this ad account. Nothing was created and no money was spent.');
    expect(refusalOf({ code: 'PERMISSIONS', detail: { code: 'ad_account_not_selected' }, kind: 'budget', platform: 'google' }).message).toMatch(/^This ad account wasn’t ticked when Google Ads was connected\./);
  });

  it('verified_advertiser_required says the app can’t send the verified beneficiary and payer (verifying again wouldn’t help)', () => {
    const r = refusalOf({ code: 'VERIFIED_ADVERTISER', detail: { code: 'verified_advertiser_required', param: 'regionalRegulationIdentities' }, kind: 'launch' });
    expect(r.message).toBe('Ads shown in this country need Meta’s verified beneficiary and payer details, which this app can’t send yet. Use Meta Ads Manager for this one. Nothing was created and no money was spent.');
    expect(r.message).not.toMatch(/verify your business/);
  });

  it('fix links go to an exact list of Meta’s and Google’s hosts: no other subdomain, translator, redirector or page anyone can publish', () => {
    for (const ok of ['https://facebook.com/', 'https://www.facebook.com/business/help/422289316306981', 'https://business.facebook.com/billing_hub/payment_settings', 'https://adsmanager.facebook.com/adsmanager/manage/accounts?act=123456789012345', 'https://www.meta.com/help/', 'https://transparency.meta.com/policies', 'https://ads.google.com/aw/billing', 'https://support.google.com/google-ads/answer/1'])
      expect(safeFixUrl(ok), ok).toBe(ok);
    for (const bad of [
      'https://translate.google.com/translate?u=https://evil.example/pay',
      'https://colab.research.google.com/drive/1',
      'https://lookerstudio.google.com/reporting/1',
      'https://www.google.com/maps/d/viewer?mid=1',
      'https://www.google.com/amp/s/evil.example/',
      'https://www.facebook.com/flx/warn/?u=https%3A%2F%2Fevil.example',
      'https://www.facebook.com/dialog/oauth?client_id=1',
      'https://www.facebook.com/v19.0/dialog/oauth?client_id=1',
      'https://business.facebook.com/settings?next=https%3A%2F%2Fevil.example',
      'https://support.google.com/x?continue=//evil.example',
      'https://m.facebook.com/x',
      'https://developers.facebook.com/x',
      'https://about.meta.com/x',
    ]) {
      expect(safeFixUrl(bad), bad).toBeUndefined();
      expect(keptFixUrl(bad), bad).toBeUndefined();
    }
    // Zernio's docs are kept for the owner, never shown
    expect(keptFixUrl('https://zernio.com/x')).toBe('https://zernio.com/x');
    expect(keptFixUrl('https://app.zernio.com/x')).toBeUndefined();
    expect(note('PAYMENT_REQUIRED', {}, 'https://translate.google.com/translate?u=https://evil.example')).not.toHaveProperty('fixUrl');
  });

  it('keeps a fix link to 500 characters as it is kept, not only as it came (percent-encoding makes it longer)', () => {
    const grows = `https://www.facebook.com/${'中'.repeat(100)}`;
    expect(grows.length).toBeLessThan(500);
    expect(new URL(grows).toString().length).toBeGreaterThan(500);
    expect(safeFixUrl(grows)).toBeUndefined();
    expect(keptFixUrl(grows)).toBeUndefined();
    const fits = `https://www.facebook.com/${'中'.repeat(10)}`;
    expect(safeFixUrl(fits)).toBe(new URL(fits).toString());
    const exactly = `https://www.facebook.com/${'a'.repeat(475)}`;
    expect(exactly).toHaveLength(500);
    expect(keptFixUrl(exactly)).toBe(exactly);
  });

  it('never cuts an emoji in half, and drops a lone half from the text (Postgres refuses it, losing the row)', () => {
    const smile = '😀';
    const at298 = cut(`${'a'.repeat(298)}${smile}tail`, 300);
    expect(at298).toBe(`${'a'.repeat(298)}…`);
    expect(cut(`${'a'.repeat(297)}${smile}tail`, 300)).toBe(`${'a'.repeat(297)}${smile}…`);
    expect(cut(`x${String.fromCharCode(0xd83d)}y${String.fromCharCode(0xde00)}z`)).toBe('xyz');
    expect(cut(`ok ${smile}`)).toBe(`ok ${smile}`);
    // the stored JSON has no half character in it
    for (const t of [at298, cut(`${'b'.repeat(199)}${smile}`, 200)]) expect(JSON.stringify(t)).not.toMatch(/\\ud[89ab]/i);
  });
});

describe('our own fix links: the policy and one ad account’s payment settings', () => {
  it('builds the payment settings link from the ad account id, digits only', () => {
    expect(paymentSettingsUrl('act_1106745002143814')).toBe('https://business.facebook.com/billing_hub/payment_settings/?asset_id=1106745002143814');
    expect(paymentSettingsUrl('1106745002143814')).toBe('https://business.facebook.com/billing_hub/payment_settings/?asset_id=1106745002143814');
    // anything else in the id: Billing Hub, where the user picks the account (never the id in the link)
    for (const bad of ['act_12&x=https://evil.example', 'act_', 'act_123456789012345678901', '', null, undefined, 'act_12/../x', ' act_1']) expect(paymentSettingsUrl(bad), String(bad)).toBe(BILLING_HUB_URL);
  });

  it('every link we build passes safeFixUrl unchanged (Meta’s own hosts, no redirect)', () => {
    for (const url of [POLICY_ADMIN_URL, POLICY_PERSONAL_URL, BILLING_HUB_URL, paymentSettingsUrl('act_1106745002143814')]) expect(safeFixUrl(url), url).toBe(url);
    expect(new URL(POLICY_ADMIN_URL).hostname).toBe('business.facebook.com');
    expect(new URL(paymentSettingsUrl('act_1')).hostname).toBe('business.facebook.com');
  });

  it('the policy always gets Business Settings; a payment method the ad account’s own settings when the account is known; else Zernio’s safe link', () => {
    expect(fixUrlFor('ad_account_policy_not_accepted', 'https://www.facebook.com/certification/nondiscrimination', 'act_9')).toBe(POLICY_ADMIN_URL);
    expect(fixUrlFor('ad_account_policy_not_accepted', undefined)).toBe(POLICY_ADMIN_URL);
    expect(fixUrlFor('ad_account_payment_required', 'https://business.facebook.com/billing_hub/payment_settings', 'act_1106745002143814')).toBe('https://business.facebook.com/billing_hub/payment_settings/?asset_id=1106745002143814');
    expect(fixUrlFor('ad_account_payment_required', 'https://business.facebook.com/billing_hub/payment_settings')).toBe('https://business.facebook.com/billing_hub/payment_settings');
    expect(fixUrlFor('meta_action_blocked', 'https://evil.example/x', 'act_1')).toBeUndefined();
    expect(fixUrlFor('meta_action_blocked', 'https://www.facebook.com/help/1', 'act_1')).toBe('https://www.facebook.com/help/1');
  });

  it('a refused launch for the policy says where an admin accepts it, with that link; a payment one links the campaign’s ad account', () => {
    const policy = refusalOf({ code: 'POLICY_NOT_ACCEPTED', detail: { code: 'ad_account_policy_not_accepted', fix: { url: 'https://www.facebook.com/certification/nondiscrimination' } }, kind: 'launch', platform: 'meta' });
    expect(policy.message).toBe('A business admin needs to accept Meta’s non-discrimination policy: in Meta Business Settings → Users → System users, click “Review policy” (or “Add”), then “I accept”. Nothing was created and no money was spent.');
    expect(policy.fixUrl).toBe(POLICY_ADMIN_URL);
    const pay = refusalOf({ code: 'PAYMENT_REQUIRED', detail: { code: 'ad_account_payment_required' }, kind: 'launch', platform: 'meta', ctx: { adAccountId: 'act_1106745002143814' } });
    expect(pay.fixUrl).toBe('https://business.facebook.com/billing_hub/payment_settings/?asset_id=1106745002143814');
    // a team-level refusal never gets a link, ours included
    expect(refusalOf({ code: 'ADS_UNAVAILABLE', detail: { code: 'ad_account_policy_not_accepted', owner: true }, kind: 'launch', platform: 'meta' })).not.toHaveProperty('fixUrl');
  });
});
