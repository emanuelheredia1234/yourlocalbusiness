// Our plain words for every ads code (spec §11, §12). Zernio's, Meta's and Google's own text is never shown: a code
// maps to one sentence here, and a fix link is passed on only when its host is on the allowlist (R6).

import { formatMoney } from './money.mjs';
import { MANAGER_LABEL, PLATFORM_LABEL } from './contracts.mjs';

/** Hosts a fix link may point at (Zernio dashboard paths and anything else are dropped: customers have no Zernio login). */
export const FIX_HOSTS = Object.freeze(['facebook.com', 'www.facebook.com', 'business.facebook.com', 'ads.google.com', 'support.google.com']);

/** A fix link we may show (https, allowlisted host), or undefined. */
export function safeFixUrl(url) {
  if (typeof url !== 'string' || url.length > 500) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || !FIX_HOSTS.includes(u.hostname)) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Third-party text as data: control characters out, cut to n characters (R6). */
export function cut(value, n = 200) {
  const t = (typeof value === 'string' || typeof value === 'number' ? String(value) : '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const P = (ctx) => PLATFORM_LABEL[ctx?.platform] ?? 'Meta';
const M = (ctx) => MANAGER_LABEL[ctx?.platform] ?? 'Meta Ads Manager';
const money = (ctx, k) => formatMoney(ctx?.[k], ctx?.currency);

const MESSAGES = {
  // account and setup (§11, §12)
  NOT_CONNECTED: (c) => (c?.platform === 'google' ? 'Connect your Google Ads account first.' : 'Connect your Meta ads account first.'),
  NEEDS_RECONNECT: (c) => `Reconnect your ${c?.platform === 'google' ? 'Google Ads' : 'Meta ads'} account (Settings → Connected accounts).`,
  NO_AD_ACCOUNTS: (c) => `We couldn’t find an ad account you can use. Create one in ${M(c)}, then reconnect.`,
  ACCOUNT_NOT_CHOSEN: 'Pick the ad account to launch on.',
  ACCOUNT_CHANGED: 'The ad account for this business changed. Review it again.',
  ACCOUNT_UNUSABLE: (c) => `This ad account can’t run ads right now. Open ${M(c)} to see why.`,
  ACCOUNT_DISABLED: 'Meta has disabled this ad account. Open Meta Ads Manager to see why.',
  ACCOUNT_RISK_REVIEW: 'Meta is reviewing this ad account. New ads can’t start until the review is done.',
  ACCOUNT_CLOSED: (c) => `This ad account is closed in ${M(c)}.`,
  ACCOUNT_UNSETTLED: 'Meta reports an unpaid balance on this ad account. Ads still run, but pay it in Ads Manager → Billing soon.',
  ACCOUNT_GRACE: 'This ad account is in Meta’s grace period for a payment. Ads still run; check Ads Manager → Billing.',
  ACCOUNT_SETTLEMENT: 'Meta is waiting for an unpaid balance on this ad account. New ads can’t start until it’s paid in Ads Manager → Billing.',
  PAYMENT_REQUIRED: 'Add a payment method in Meta Ads Manager (Billing). Meta bills your ads to it; this app never charges for ad spend.',
  PAYMENT_UNKNOWN: 'We can’t see your payment method. If your business pays through Business Billing Hub, that’s fine.',
  GOOGLE_BILLING_PENDING: 'Google Ads needs an approved payment setup before ads can run. Add or finish it in Google Ads → Billing.',
  GOOGLE_BILLING_UNKNOWN: 'We can’t see your Google payment setup from here. Ads won’t run until billing is set up in Google Ads → Billing.',
  GOOGLE_BILLING_OK: 'Google Ads has an approved payment setup.',
  GOOGLE_REVIEW: 'Google reviews every ad against its advertising policies.',
  GOOGLE_MANAGER: 'This is a manager account. Pick the Google Ads account the ads run in.',
  GOOGLE_TEST_ACCOUNT: 'This is a Google Ads test account: its ads never run.',
  GOOGLE_NO_TIMEZONE: 'We can’t read this account’s time zone, so the dates can’t be set. Try again later.',
  NO_PAGE: 'Meta ads run as a Facebook Page. Connect a Page to your Meta ads account.',
  PAGE_OK: 'A Facebook Page is linked.',
  AD_CONSENT: 'Your Page or Instagram account is set to Meta without ads. Change that in Meta’s settings to advertise with it.',
  IG_RESTRICTED: 'Meta has restricted the Instagram account these ads would run as. Open Instagram to see why, or launch on Facebook only.',
  NO_INSTAGRAM: 'Your ads will show on Facebook only: no Instagram professional account is linked to your Page.',
  INSTAGRAM_OK: 'An Instagram professional account is linked, so ads can show on Instagram too.',
  META_OBJECT_GONE: 'Meta can’t find part of this campaign any more (it may have been deleted in Ads Manager). Refresh the Campaigns tab.',
  POLICY_NOT_ACCEPTED: 'A business admin needs to accept Meta’s non-discrimination policy in Ads Manager.',
  VERIFIED_ADVERTISER: 'Meta needs you to verify your business before running ads here.',
  SECURITY_CHECK: 'Meta has put a security hold on this ad account. Log in to facebook.com and follow Meta’s steps. This can take a few days.',
  ACTION_BLOCKED: 'Meta isn’t letting this ad account create ads right now. Open Ads Manager to see why.',
  RECONNECT: (c) => `Reconnect your ${c?.platform === 'google' ? 'Google Ads' : 'Meta ads'} account (Settings → Connected accounts).`,
  PERMISSIONS: 'Your login doesn’t have permission to advertise on this ad account. Ask its admin, or pick another account.',
  ACCOUNT_SPEND_CAP: 'Your ad account’s spending limit is reached, so ads won’t show until you raise it in Ads Manager.',
  ACCOUNT_OK: 'The ad account is active.',
  CONNECTED_OK: (c) => `${c?.platform === 'google' ? 'Google Ads' : 'Meta ads'} is connected.`,
  // what Zernio or the platform refused
  BUDGET_TOO_LOW: (c) => (Number.isFinite(c?.min) ? `${P(c)}’s minimum daily budget for this account is ${money({ ...c, a: c.min }, 'a')}. Try a larger daily amount.` : `${P(c)}’s minimum daily budget for this account is higher. Try a larger daily amount.`),
  BUDGET_INVALID: 'Enter the daily amount as a whole number of 1 or more.',
  INVALID_TARGETING: (c) => `${P(c)} didn’t accept the places or interests picked. Try fewer or larger places.`,
  IMAGE_UNREACHABLE: 'Meta couldn’t fetch the ad image. Make the image again and retry the launch.',
  ADS_UNAVAILABLE: 'Launching and changing ads from the app isn’t available right now. The app owner has been told. To pause a campaign now, use Open in Ads Manager.',
  IDEMPOTENCY_MISMATCH: 'Nothing was sent. Review the launch again.',
  LIVE_CHANGED: 'This campaign was changed in Ads Manager since you looked. Review it again.',
  LIFETIME_BUDGET: 'This campaign now has a total budget set in Ads Manager. Change it there.',
  SHARED_BUDGET: 'This budget is shared with other campaigns in Google Ads; change it there.',
  BUDGET_LEVEL: 'This campaign’s budget is set up differently in Ads Manager now. Change it there.',
  RATE_LIMITED: (c) => (c?.platform === 'google' ? 'Google is limiting requests right now. Nothing was sent. Try again in a minute.' : 'Meta is busy with this ad account. Nothing was sent. Try again in a minute.'),
  AD_ACCOUNT_BUSY: (c) => (c?.platform === 'google' ? 'Another change to this ad account is still going. Nothing was sent.' : 'Another change to this ad account is still going. Nothing was sent.'),
  TOO_MANY_CHANGES: 'Too many ad changes this hour. Nothing was sent.',
  REFUSED: (c) => `${P(c)} refused this. Nothing was changed. Open ${M(c)} to see why.`,
  NOT_FOUND_REMOTE: (c) => `${P(c)} can’t find this campaign any more. Refresh the Campaigns tab.`,
  // what the plan or the request is missing (§6)
  SPECIAL_CATEGORY: 'Ads about housing, jobs, credit, financial products, politics or gambling need special settings this app doesn’t support yet. Use Meta Ads Manager for this one.',
  SPECIAL_CATEGORY_UNANSWERED: 'Answer whether this ad is about housing, jobs, credit, financial products, politics or gambling.',
  EU_TARGETING: 'Ads shown in the EU need extra payer details that this app doesn’t support yet.',
  CLAIM_UNCONFIRMED: (c) => `This says “${cut(c?.phrase, 60)}”. Ads must only claim what’s true for your business. Tick it if it’s true and you can show it, or edit the plan.`,
  TEXT_TOO_LONG: (c) => `${c?.field ?? 'This text'} is longer than ${P(c)} allows (${c?.max ?? ''} characters). Shorten it in the plan.`,
  TOO_FEW_HEADLINES: 'Add at least 3 headlines and 2 descriptions so Google doesn’t write any for you.',
  TOO_MANY_HEADLINES: 'Google takes at most 15 headlines and 4 descriptions. Remove some in the plan.',
  NO_KEYWORDS: 'Add at least one keyword to the search ad.',
  NO_SEARCH_AD: 'This plan has no Google search ad yet.',
  NO_IMAGE: 'This ad needs its image. Make the image or pick your own photo first.',
  NO_IMAGE_LINKS: 'Ad images can’t be shared with Meta yet: the app owner needs to add MEDIA_URL_SECRET.',
  VIDEO_NOT_READY: 'Video ads need a finished video. Pick an image creative.',
  NO_CREATIVE: 'Pick 1 to 3 of the plan’s ads to launch.',
  TEXT_MISSING: (c) => `${c?.field ?? 'This ad'} needs a headline and its text. Add them in the plan.`,
  HEADLINE_LONG: (c) => `${c?.field ?? 'This ad'}’s headline is over 40 characters: Meta may cut it on small screens.`,
  CTA_DEFAULTED: (c) => `${c?.field ?? 'This ad'}’s button isn’t one Meta offers, so it shows “Learn more”.`,
  NO_LOCATION: 'Pick at least one place.',
  NO_FINAL_URL: 'Add the https page your ads send people to (not a link shortener).',
  START_IN_PAST: 'The start date has passed. Pick today or a later day.',
  BAD_DATES: 'Pick a start date and a number of days between 1 and 90.',
  META_DAILY_24H: (c) => `Meta needs a daily-budget ad to run more than 24 hours. Choose at least ${Number.isInteger(c?.days) && c.days > 1 ? c.days : 2} days.`,
  RADIUS_RAISED: 'Meta’s smallest city radius is 10 miles, so the radius is 10 miles.',
  COUNTRY_DROPPED: (c) => `${cut(c?.name, 60)} was left out because a place inside it is picked (Meta refuses both together).`,
  GOAL_NOTE: 'Meta and Google will optimise for clicks to your page. Lead forms and sales tracking aren’t set up from this app.',
  GOOGLE_NO_RADIUS: 'Google targets the places you picked, not a radius.',
  GOOGLE_NO_AGE: 'Google Search doesn’t target by age or interests here.',
  INTEREST_UNMATCHED: (c) => `“${cut(c?.name, 60)}” wasn’t matched to a Meta interest, so it’s left out.`,
  START_DAY_COUNTS: 'The start day counts as a day even if the ad is approved late that day.',
  // limits (§10)
  ADS_OFF: 'Launching ads isn’t turned on for your account. Ask the app owner.',
  KILL_SWITCH: 'Launching ads and raising budgets is switched off on this app right now. Pausing and ending still work.',
  BLOCKED: 'Your account can’t launch ads or raise budgets right now. Ask the app owner. Pausing and ending still work.',
  PLAN_REQUIRED: 'Launching ads is part of Grow and Scale.',
  LIMIT_DAILY: (c) => `This would put ${money(c, 'after')} a day across your live campaigns; your limit is ${money(c, 'limit')}. Lower the amount or ask the app owner.`,
  LIMIT_CHANGE: (c) => `That’s ${money(c, 'amount')} a day; one launch or increase can be at most ${money(c, 'limit')} a day. Lower it or ask the app owner.`,
  LIMIT_TOTAL: (c) => `This campaign would come to ${money(c, 'amount')} in total; your limit for one campaign is ${money(c, 'limit')}. Shorten it, lower the amount or ask the app owner.`,
  LIMIT_LAUNCHES: (c) => `You’ve launched ${c?.limit ?? 'the most'} campaigns today, your daily limit. Try again tomorrow.`,
  LIMIT_CHANGES: (c) => `You’ve made ${c?.limit ?? 'the most'} ad changes today, your daily limit. Pausing and ending still work.`,
  LIMIT_CURRENCY: (c) => `Your ad account uses ${c?.currency ?? 'another currency'}. Ask the app owner to set your ad limit in ${c?.currency ?? 'that currency'}.`,
  PLAN_CHANGED: 'The plan changed after you reviewed it. Review it again.',
  LIMITS_CHANGED: 'Your ad limits changed since you reviewed this. Review it again.',
  REVIEW_EXPIRED: 'Something changed since you reviewed this. Review it again.',
  CONFIRM_REQUIRED: 'Confirm the spend first.',
  ALREADY_LAUNCHED: (c) => `This plan is already live on ${P(c)}. Manage it on the Campaigns tab.`,
  JOB_LIVE: 'A change to this campaign is still going or not confirmed yet. Check its status first.',
  ENDED: 'This campaign’s dates are over. Launch the plan again.',
  REJECTED_RESUME: 'This ad wasn’t approved. Swap the ad first, or open Ads Manager to ask for another review.',
  GOOGLE_NO_DATES: 'Google doesn’t allow changing the dates after launch. Pause or end it instead.',
  NOTHING_TO_CHANGE: 'That’s already how it is. Nothing to send.',
  CANT_CHANGE: 'This campaign can’t be changed from the app right now.',
  END_DATE_PAST: 'Pick an end date from today on.',
  LEARNING_RESTART: 'Big changes restart Meta’s learning.',
  BACK_TO_REVIEW: 'The ad goes back to review and may stop showing until it’s approved.',
  LEARNING: 'Meta is still learning who to show this to. Costs move around for the first days.',
  LEARNING_LIMITED: 'Learning limited: Meta isn’t getting enough results. A bigger area, a bigger budget or fewer ads can help.',
  CAP_MINIMUM: (c) => `Meta’s smallest spending limit is ${money(c, 'cap')}, so the limit is set to that. The daily budget and the last day keep the spend to about ${money(c, 'amount')}.`,
  GOOGLE_BUDGET_LAG: (c) => `Google last reported ${money(c, 'amount')} a day, but the app set ${money({ ...c, a: c.ours }, 'a')} since; Google’s figures can lag, so the change is counted from ${money({ ...c, a: c.ours }, 'a')}.`,
  SWAP_SPENDS: (c) => `This campaign is switched on: once the new ad is approved it spends up to ${money(c, 'amount')} a day.`,
  ADS_NOT_APPROVED: (c) => `${c?.count ?? 1} of ${c?.of ?? 1} ads ${Number(c?.count) === 1 ? 'was' : 'were'} not approved; the others can still run.`,
  REQUEST_MISMATCH: 'This confirm was already used for another change. Close the window and open it again.',
  REVIEW_USED: 'This review was already sent. Review it again to make another change.',
  NO_SPEND_CAP: 'This campaign has no spending limit on Meta yet: resuming sets one first (what’s spent so far plus the rest of the plan).',
  // outcomes of a launch or change (§7.5, §8)
  CAP_NOT_SET: (c) => `Created and paused. Meta didn’t accept the ${money(c, 'cap')} spending limit (Meta refuses limits under about 100 US dollars), so we didn’t switch it on. Run it longer or raise the budget, then resume.`,
  ACTIVATION_NOT_SENT: (c) => (c?.platform === 'google' ? 'Created and paused. We couldn’t switch it on: press Resume.' : 'Created and paused, with its spending limit. We couldn’t switch it on: press Resume.'),
  ACTIVATION_FAILED: 'Created, but Meta didn’t accept switching some of it on. Those parts stay off; Resume switches them on.',
  PARTIAL_LEFT: 'Meta kept parts of a half-made campaign (no ads in it, so it can’t spend). You can delete them in Meta Ads Manager.',
  NOT_CREATED: (c) => `${P(c)} didn’t create this campaign. Nothing is running. You can launch it again.`,
  CREATE_FAILED: (c) => `${P(c)} refused the launch. Nothing is running.`,
  NOT_CHANGED: (c) => `${P(c)} didn’t make this change. Nothing changed.`,
  CHANGE_INCOMPLETE: 'Only the first part of this change went through (a higher spending limit, which can’t spend by itself). Review it and try again.',
  INTERRUPTED: (c) => `The app restarted while sending this to ${P(c)}. It may have happened - check status before trying again.`,
  UNKNOWN: (c) => `We don’t know yet whether ${P(c)} made this change. Nothing will be sent again by itself. It may have happened - check status before trying again.`,
  UNKNOWN_LAUNCH: (c) => `We don’t know yet whether ${P(c)} created this campaign. Nothing will be sent again by itself. It may have happened - check status before trying again.`,
  STILL_UNKNOWN_META: 'Meta may still be working on it. Check again in a few minutes.',
  STILL_UNKNOWN_GOOGLE: 'Google results reach us 15 to 60 minutes late. Check again later.',
  THIRD_VALUE: (c) => `The budget is now ${money(c, 'amount')}, which is neither the old nor the new amount. Check in Ads Manager.`,
  DONE: 'Done.',
  SENDING: 'Sending…',
  UNAVAILABLE: 'Something went wrong. Try again shortly.',
  NOT_SET_UP: 'Launching ads from the app isn’t set up yet.',
  NOT_SET_UP_STOP: 'The app can’t reach your ad account right now. Open Ads Manager to pause it.',
};

/** Our sentence for a code (ctx: { platform, currency, amount, limit, … }); unknown codes get the generic one. */
export function messageFor(code, ctx = {}) {
  const m = Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : null;
  if (typeof m === 'function') return m(ctx);
  if (typeof m === 'string') return m;
  return typeof MESSAGES.REFUSED === 'function' ? MESSAGES.REFUSED(ctx) : 'Something went wrong.';
}

export const hasMessage = (code) => Object.hasOwn(MESSAGES, code);

/** A PlainNote: { code, message, fixUrl? }. */
export function note(code, ctx = {}, fixUrl) {
  const safe = safeFixUrl(fixUrl);
  return { code, message: messageFor(code, ctx), ...(safe ? { fixUrl: safe } : {}) };
}

/**
 * Zernio's machine codes (create and update refusals, health blockers) → ours. Anything not listed is REFUSED.
 * Owner/team problems (plan, add-on, allowance, key) are ADS_UNAVAILABLE: the customer never sees them.
 */
export const ZERNIO_CODES = Object.freeze({
  ad_account_payment_required: 'PAYMENT_REQUIRED',
  ad_account_policy_not_accepted: 'POLICY_NOT_ACCEPTED',
  verified_advertiser_required: 'VERIFIED_ADVERTISER',
  ad_account_unusable: 'ACTION_BLOCKED',
  ad_account_not_selected: 'PERMISSIONS',
  meta_security_check_required: 'SECURITY_CHECK',
  meta_action_blocked: 'ACTION_BLOCKED',
  meta_ad_consent_required: 'AD_CONSENT',
  instagram_account_restricted: 'IG_RESTRICTED',
  instagram_business_account_unresolved: 'NO_INSTAGRAM',
  insufficient_permissions: 'PERMISSIONS',
  invalid_targeting: 'INVALID_TARGETING',
  budget_too_low: 'BUDGET_TOO_LOW',
  meta_object_not_accessible: 'META_OBJECT_GONE',
  linked_account_required: 'NO_PAGE',
  no_pages_granted: 'NO_PAGE',
  reconnect_required: 'RECONNECT',
  ads_connection_required: 'RECONNECT',
  google_ads_no_ad_accounts: 'NO_AD_ACCOUNTS',
  ads_addon_required: 'ADS_UNAVAILABLE',
  ads_allowance_exceeded: 'ADS_UNAVAILABLE',
  feature_not_available: 'ADS_UNAVAILABLE',
  payment_required: 'ADS_UNAVAILABLE',
  PAYMENT_REQUIRED: 'ADS_UNAVAILABLE',
  BUDGET_LEVEL_MISMATCH: 'BUDGET_LEVEL',
  shared_budget: 'SHARED_BUDGET',
});
/** the codes that are the owner's to fix (the customer reads ADS_UNAVAILABLE; the owner gets an alert) */
export const OWNER_CODES = Object.freeze(['ads_addon_required', 'ads_allowance_exceeded', 'feature_not_available', 'payment_required', 'PAYMENT_REQUIRED']);
