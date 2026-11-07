// Our plain words for every ads code (spec §11, §12). A code maps to one sentence here, and a fix link is passed on
// only when its host is on the allowlist (R6). Zernio's, Meta's and Google's own text is shown in two cases only: a
// refusal we have no sentence of our own for, and one whose sentence needs Meta's own number (its minimum budget)
// (refusalOf), cut and as plain text, labelled as the platform's message.

import { formatMoney } from './money.mjs';
import { MANAGER_LABEL, PLATFORM_LABEL } from './contracts.mjs';

/**
 * The exact hosts a customer may be sent to by a refusal's fix link: Meta's and Google's own pages for ad accounts,
 * billing and help. Never any other subdomain (Google and Meta host pages anyone can publish, translators and
 * redirectors under their names). src/lib/ads/launchFormat.ts keeps the same list.
 */
export const FIX_HOSTS = Object.freeze(['facebook.com', 'www.facebook.com', 'business.facebook.com', 'adsmanager.facebook.com', 'www.meta.com', 'transparency.meta.com', 'ads.google.com', 'support.google.com']);
/** Zernio's own docs: kept with a refusal for the owner, never shown (customers have no Zernio login) */
const OWNER_FIX_HOSTS = Object.freeze(['zernio.com', 'docs.zernio.com']);
/** redirectors and login dialogs on those hosts (l.php, /url, the outbound-link warning, OAuth dialogs) */
const REDIRECT_PATH = /^\/(l\.php|url)$|^\/flx\/warn(\/|$)|^\/(v\d+(\.\d+)?\/)?dialog(\/|$)/i;
/** a query value that is a link (https://…, //…): a page that sends the reader on to it */
const LINK_VALUE = /^\s*(https?:|[\\/]{2})/i;

function fixUrlOn(url, hosts) {
  if (typeof url !== 'string' || url.length > 500) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !hosts.includes(u.hostname.toLowerCase()) || REDIRECT_PATH.test(u.pathname)) return undefined;
    for (const v of u.searchParams.values()) if (LINK_VALUE.test(v)) return undefined;
    // the bound holds for the link as kept: percent-encoding can make it several times longer than it came, past
    // what ad_jobs.error_detail may hold (its 4096-byte check), and the app drops a link over 500 anyway
    const out = u.toString();
    return out.length <= 500 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** A fix link we may show the customer (https, one of FIX_HOSTS, no redirect), or undefined. */
export const safeFixUrl = (url) => fixUrlOn(url, FIX_HOSTS);
/** A fix link we may keep with a refusal (FIX_HOSTS, or Zernio's docs for the owner), or undefined. */
export const keptFixUrl = (url) => fixUrlOn(url, [...FIX_HOSTS, ...OWNER_FIX_HOSTS]);

/** half of a surrogate pair on its own (half an emoji): Postgres refuses it in json and text, so the row is lost */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Third-party text as data (R6): control and direction-override characters and lone surrogates out, whitespace
 * flattened, cut to n characters between whole characters (never half an emoji). The result is plain text: the app
 * renders it as text, never as markup or a link.
 */
export function cut(value, n = 200) {
  const t = (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(LONE_SURROGATE, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= n) return t;
  const head = t.slice(0, n - 1);
  return `${/[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head}…`;
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
  // Meta wants the verified beneficiary and payer sent with the ad set (regionalRegulationIdentities), even when
  // they're set in Ads Manager: this app doesn't send them, so verifying again wouldn't help
  VERIFIED_ADVERTISER: 'Ads shown in this country need Meta’s verified beneficiary and payer details, which this app can’t send yet. Use Meta Ads Manager for this one.',
  SECURITY_CHECK: 'Meta has put a security check on the Facebook login connected to this ad account. Log in to facebook.com and follow Meta’s steps. This can take a few days.',
  ACTION_BLOCKED: 'Meta isn’t letting this ad account create ads right now. Open Ads Manager to see why.',
  RECONNECT: (c) => `Reconnect your ${c?.platform === 'google' ? 'Google Ads' : 'Meta ads'} account (Settings → Connected accounts).`,
  PERMISSIONS: 'The Facebook login connected here doesn’t have permission to advertise with this ad account, its Facebook Page or its Instagram account. Ask an admin to give it, or pick another account.',
  ACCOUNT_NOT_SELECTED: (c) => `This ad account wasn’t ticked when ${c?.platform === 'google' ? 'Google Ads' : 'Meta ads'} was connected. Reconnect it (Settings → Connected accounts) and tick this ad account.`,
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
  // why Meta refused a launch or a change, for Zernio's codes (REFUSAL_REASON; the job keeps its category)
  LAUNCH_REFUSED: (c) => `${P(c)} refused the launch.`,
  CHANGE_REFUSED: (c) => `${P(c)} refused this change.`,
  REFUSED_24H: 'Meta needs a daily-budget ad to run more than 24 hours, and this one was set for less. Launch it again with at least 2 days.',
  LEAD_TERMS: 'Your Facebook Page hasn’t accepted Meta’s Lead Ads terms. A Page admin can accept them once in Meta.',
  AD_ACCOUNT_UNUSABLE: 'Meta says this ad account can’t run ads right now: it isn’t active, or the business is restricted from advertising. Check the account’s status in Meta Ads Manager.',
  META_ACTION_BLOCKED: 'Meta has blocked the Facebook login connected here from making ads for now. It usually lifts by itself: wait a few hours before trying again.',
  META_OBJECT_NOT_ACCESSIBLE: 'Meta couldn’t open something this ad uses: it was deleted, or the connected login lost access to it. Check your Page and ad account in Meta, then try again.',
  // a pause or an end Meta refused: the reason without "wait" or "try again", then what to do now (STILL_RUNNING)
  STOP_REFUSED: (c) => `${P(c)} refused to ${c?.action === 'end' ? 'end' : 'pause'} this campaign.`,
  META_ACTION_BLOCKED_STOP: 'Meta has blocked the Facebook login connected here from making ad changes for now.',
  META_OBJECT_NOT_ACCESSIBLE_STOP: 'Meta couldn’t open this campaign: it was deleted, or the connected login lost access to it.',
  IG_UNRESOLVED_STOP: 'Meta couldn’t find the Instagram account linked to your Facebook Page.',
  STILL_RUNNING: (c) => `It’s still running: pause it in ${M(c)} now.`,
  MAY_STILL_RUN: (c) => `If it’s still running, pause it in ${M(c)} now.`,
  // why the rest of a change done in part wasn't made (CHANGE_INCOMPLETE first)
  REST_REFUSED: (c) => `${P(c)} refused the rest.`,
  REST_REFUSED_SEE_WHY: (c) => `${P(c)} refused the rest: open ${M(c)} to see why.`,
  REST_RATE_LIMITED: (c) => `${P(c)} was busy, so the rest wasn’t sent. Try again in a minute.`,
  REST_ACCOUNT_BUSY: 'Another change to this ad account was still going, so the rest wasn’t sent. Try again in a minute.',
  REST_NOT_SENT: 'Review it and try again.',
  IG_UNRESOLVED: 'Meta couldn’t find the Instagram account linked to your Facebook Page. Link an Instagram professional account to the Page in Meta, then try again.',
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
  // CAP_NOT_SET when Meta said why (the refusal's reason follows)
  CAP_REFUSED: (c) => `Created and paused. Meta didn’t accept the ${money(c, 'cap')} spending limit, so we didn’t switch it on.`,
  ACTIVATION_NOT_SENT: (c) => (c?.platform === 'google' ? 'Created and paused. We couldn’t switch it on: press Resume.' : 'Created and paused, with its spending limit. We couldn’t switch it on: press Resume.'),
  ACTIVATION_FAILED: 'Created, but Meta didn’t accept switching some of it on. Those parts stay off; Resume switches them on.',
  PARTIAL_LEFT: 'Meta kept parts of a half-made campaign (no ads in it, so it can’t spend). You can delete them in Meta Ads Manager.',
  NOT_CREATED: (c) => `${P(c)} didn’t create this campaign. Nothing is running. You can launch it again.`,
  CREATE_FAILED: (c) => `${P(c)} refused the launch. Nothing is running.`,
  NOT_CHANGED: (c) => `${P(c)} didn’t make this change. Nothing changed.`,
  // what went through of a change done in part (c.done: the steps that did; c.campaignOff: the campaign's own switch
  // was to come last and didn't); refusalOf adds why the rest didn't
  CHANGE_INCOMPLETE: (c) => {
    const on = Array.isArray(c?.done) && c.done.some((o) => o === 'adSetStatus' || o === 'adStatus');
    if (!on) return 'Only the first part of this change went through (a higher spending limit, which can’t spend by itself).';
    return c?.campaignOff ? 'Only part of this change went through: parts of it were switched on, but the campaign itself is still paused, so it can’t spend yet.' : 'Only part of this change went through: parts of it were switched on, but not all of it.';
  },
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

/**
 * Zernio's codes for the refusals a customer fixes (its ErrorResponse "Meta ads refusals") → our sentence for the
 * reason. Display only: ad_jobs.error_code keeps its category (ZERNIO_CODES), the code itself is in error_detail.
 */
export const REFUSAL_REASON = Object.freeze({
  ad_account_payment_required: 'PAYMENT_REQUIRED',
  ad_account_policy_not_accepted: 'POLICY_NOT_ACCEPTED',
  lead_ads_terms_not_accepted: 'LEAD_TERMS',
  verified_advertiser_required: 'VERIFIED_ADVERTISER',
  ad_account_unusable: 'AD_ACCOUNT_UNUSABLE',
  meta_security_check_required: 'SECURITY_CHECK',
  meta_action_blocked: 'META_ACTION_BLOCKED',
  budget_too_low: 'BUDGET_TOO_LOW',
  meta_object_not_accessible: 'META_OBJECT_NOT_ACCESSIBLE',
  meta_ad_consent_required: 'AD_CONSENT',
  instagram_account_restricted: 'IG_RESTRICTED',
  instagram_business_account_unresolved: 'IG_UNRESOLVED',
  insufficient_permissions: 'PERMISSIONS',
  ad_account_not_selected: 'ACCOUNT_NOT_SELECTED',
  invalid_targeting: 'INVALID_TARGETING',
  linked_account_required: 'NO_PAGE',
});
/** Zernio's codes whose sentence needs Meta's own words too: Meta's minimum budget is only in its message */
const META_WORDS_TOO = new Set(['budget_too_low']);

/** our categories for the refusal of a write that was sent (zernioAds.mjs codeForResponse): a reason to say */
const REFUSAL_CATEGORIES = new Set(['REFUSED', 'RECONNECT', 'IMAGE_UNREACHABLE', 'NOT_FOUND_REMOTE', ...Object.values(ZERNIO_CODES).filter((c) => c !== 'ADS_UNAVAILABLE')]);
const NOTHING_DONE = Object.freeze({ launch: 'Nothing was created and no money was spent.', change: 'Nothing was changed.' });
/** a refused pause or end: these reasons without their "wait" or "try again" (the campaign is still spending) */
const STOP_REASON = Object.freeze({ META_ACTION_BLOCKED: 'META_ACTION_BLOCKED_STOP', META_OBJECT_NOT_ACCESSIBLE: 'META_OBJECT_NOT_ACCESSIBLE_STOP', IG_UNRESOLVED: 'IG_UNRESOLVED_STOP' });
/** a refused pause or end for these may be about a campaign that is gone: "if it's still running" */
const MAY_BE_GONE = new Set(['NOT_FOUND_REMOTE', 'META_OBJECT_GONE', 'META_OBJECT_NOT_ACCESSIBLE']);
/** why the rest of a change done in part wasn't sent, for categories whose own sentence says "Nothing was sent" */
const REST_REASON = Object.freeze({ RATE_LIMITED: 'REST_RATE_LIMITED', AD_ACCOUNT_BUSY: 'REST_ACCOUNT_BUSY' });

const metaWords = (d) => cut([d.metaTitle, d.metaMessage].filter((x) => typeof x === 'string' && x).join(': '), 300);

/**
 * What a failed launch or change says (spec §11, R6), and a launch made but not switched on (its refused step).
 * - A change that went through in part (CHANGE_INCOMPLETE, or any refusal after steps that did: `done`): what went
 *   through, then why the rest didn't. Never "Nothing was changed".
 * - A refused pause or end (kind 'pause' | 'end'): the reason, then "It's still running: pause it in Meta Ads Manager
 *   now." Never "wait" or "try again": the campaign is still spending.
 * - The refusal of a write that was sent: the reason, then what it left (NOTHING_DONE, or for a launch whose objects
 *   Meta kept, `leftBehind`, the half-made campaign that can't spend). Never "open Ads Manager to see why" for a
 *   launch. The reason is our sentence for Zernio's code when we have one (REFUSAL_REASON), else for our category; a
 *   refused Meta launch whose own schedule was 24 hours or less (shortSchedule) names Meta's 24-hour rule.
 * - Anything else (nothing sent, a half-made launch, made but not switched on): its own sentence, then the refused
 *   step's reason when we have one.
 * Zernio's hint (else Meta's own title and message) goes along as `platformSays` when we have no sentence for
 * Zernio's code, and Meta's own words when our sentence needs them (META_WORDS_TOO): third-party text, cut, that the
 * app shows as plain text labelled as the platform's message. A team-level problem (detail.owner: our Zernio plan,
 * add-on, billing, key or rate limits) never gets either, nor its fix link.
 *   detail: ad_jobs.error_detail (zernioAds.mjs refusalDetail); kind: 'launch' | the change's action; done: the
 *   change's steps that went through; campaignOff: its campaign switch was to come last and didn't; leftBehind: how
 *   many objects of a refused launch Meta kept. → { message, platformSays?, fixUrl? }
 */
export function refusalOf({ code, detail = null, kind = 'launch', platform = 'meta', ctx = {}, shortSchedule = false, done = [], campaignOff = false, leftBehind = 0 }) {
  const c = { ...ctx, platform, action: kind };
  const d = detail && typeof detail === 'object' && !Array.isArray(detail) && detail.owner !== true ? detail : null;
  const known = d && typeof d.code === 'string' && Object.hasOwn(REFUSAL_REASON, d.code) ? REFUSAL_REASON[d.code] : null;
  const says = !d ? '' : !known ? cut(d.hint, 300) || metaWords(d) : META_WORDS_TOO.has(d.code) ? metaWords(d) || cut(d.hint, 300) : '';
  const fixUrl = d ? safeFixUrl(d.fix?.url) : undefined;
  const said = (message) => ({ message, ...(says ? { platformSays: says } : {}), ...(fixUrl ? { fixUrl } : {}) });
  const launch = kind === 'launch';
  const stop = kind === 'pause' || kind === 'end';
  const steps = Array.isArray(done) ? done : [];

  if (!launch && !stop && (code === 'CHANGE_INCOMPLETE' || steps.length > 0)) {
    const rest = known
      ? messageFor(known, c)
      : Object.hasOwn(REST_REASON, code)
        ? messageFor(REST_REASON[code], c)
        : code === 'ADS_UNAVAILABLE' || (REFUSAL_CATEGORIES.has(code) && code !== 'REFUSED')
          ? messageFor(code, c)
          : says
            ? messageFor('REST_REFUSED', c)
            : d
              ? messageFor('REST_REFUSED_SEE_WHY', c)
              : messageFor('REST_NOT_SENT', c);
    return said(`${messageFor('CHANGE_INCOMPLETE', { ...c, done: steps, campaignOff })} ${rest}`);
  }
  if (stop) {
    const why = known ? messageFor(STOP_REASON[known] ?? known, c) : code === 'REFUSED' || code === 'CHANGE_INCOMPLETE' ? messageFor('STOP_REFUSED', c) : messageFor(code, c);
    // ADS_UNAVAILABLE's own sentence already says how to pause it now
    if (code === 'ADS_UNAVAILABLE') return said(why);
    return said(`${why} ${messageFor(MAY_BE_GONE.has(known ?? code) ? 'MAY_STILL_RUN' : 'STILL_RUNNING', c)}`);
  }
  if (!REFUSAL_CATEGORIES.has(code)) {
    const own = code === 'CAP_NOT_SET' && (known || says) ? messageFor('CAP_REFUSED', c) : messageFor(code, c);
    return said(known ? `${own} ${messageFor(known, c)}` : own);
  }
  const what = !launch ? NOTHING_DONE.change : leftBehind > 0 ? `${messageFor('PARTIAL_LEFT', c)} No money was spent.` : NOTHING_DONE.launch;
  if (known) return said(`${messageFor(known, c)} ${what}`);
  if (code === 'REFUSED' && launch && shortSchedule) return said(`${messageFor('REFUSED_24H', c)} ${what}`);
  if (code !== 'REFUSED') return said(`${messageFor(code, c)} ${what}`);
  if (launch) return said(`${messageFor('LAUNCH_REFUSED', c)} ${what}`);
  // a change Meta refused without a word: the campaign is there in Ads Manager, so it can say why
  return said(says ? `${messageFor('CHANGE_REFUSED', c)} ${what}` : messageFor('REFUSED', c));
}

/** The platform's own words for a refusal, labelled and quoted as data (the activity log's line). */
export const platformSaysLine = (platform, says) => `${PLATFORM_LABEL[platform] ?? 'Meta'}’s message: “${says}”`;
