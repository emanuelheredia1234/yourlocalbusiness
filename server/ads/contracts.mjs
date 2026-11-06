// The ads launch contracts (src/lib/ads/launchTypes.ts is the app's copy): the shapes /api/ads/* answers with, as
// JSDoc, and the constants both sides agree on. Platforms are 'meta' and 'google' in the API, the database and the
// app; CONNECTION_OF maps them to the connected-account ids (server/connections/zernio.mjs, analytics).

/**
 * @typedef {'meta'|'google'} AdsPlatform
 * @typedef {'PAUSED'|'ACTIVE'} LaunchChoice
 * @typedef {'launching'|'in_review'|'active'|'paused'|'rejected'|'with_issues'|'completed'|'ended'|'failed'|'unknown'} CampaignState
 * @typedef {'queued'|'sending'|'done'|'failed'|'unknown'} AdJobState
 * @typedef {'launch'|'pause'|'resume'|'end'|'budget'|'end_date'|'creative'} AdJobKind
 *
 * @typedef {object} AdAccountOption  an ad account inside the business's connection (never a Zernio id)
 * @property {string} ref        adacct_<32 hex>: resolves only against a fresh list of that user's ad accounts
 * @property {AdsPlatform} platform
 * @property {string} name
 * @property {string} idTail     last 4 of the act_… / customer id
 * @property {string} currency
 * @property {string} timezone
 * @property {boolean} usable
 * @property {string} [reason]   a SetupCode
 * @property {string} [message]  our words for the reason
 * @property {number} [minDailyBudget]
 *
 * @typedef {object} SetupCheck
 * @property {string} id
 * @property {'ok'|'warn'|'missing'|'unknown'} state
 * @property {string} message
 * @property {string} [fixUrl]   only hosts on the allowlist (messages.mjs)
 *
 * @typedef {object} TargetOption
 * @property {string} ref        signed, bound to the user and platform (tref_…)
 * @property {string} name
 * @property {'city'|'region'|'zip'|'country'|'interest'|'other'} kind
 * @property {string[]} path
 *
 * @typedef {object} LaunchPreviewRequest
 * @property {string} projectId
 * @property {string} planId
 * @property {AdsPlatform} platform
 * @property {LaunchChoice} status       no default: required
 * @property {string} [startDate]        YYYY-MM-DD; omitted = as soon as approved
 * @property {'asap'|string} [startTime] 'HH:MM' (Meta) or 'asap'
 * @property {number} dailyBudget        whole units of the account currency, this platform only
 * @property {number} durationDays
 * @property {string[]} locations        TargetOption.ref
 * @property {number} [radiusMi]
 * @property {string[]} [interests]      TargetOption.ref (Meta)
 * @property {string[]} [creativeIds]    Meta: 1-3 of the plan's picked creatives
 * @property {string[]} [languages]      Google: ISO 639-1
 * @property {string[]} [claimsConfirmed]
 * @property {'none'|'yes'} specialCategory
 *
 * @typedef {object} PlainNote
 * @property {string} code
 * @property {string} message
 * @property {string} [fixUrl]
 *
 * @typedef {object} AdJob
 * @property {string} id
 * @property {AdJobKind} kind
 * @property {AdsPlatform} platform
 * @property {AdJobState} state
 * @property {string} [code]
 * @property {string} message           ours
 * @property {string} requestedAt
 * @property {string} [finishedAt]
 * @property {string} [checkedAt]
 * @property {string} [canCheckAt]
 *
 * @typedef {object} LiveAdRow  a campaign whose switch is on, or may be on (delete account / disconnect warnings)
 * @property {string} id
 * @property {string} name
 * @property {AdsPlatform} platform
 * @property {number} daily
 * @property {string} currency
 * @property {string} idTail
 */

export const ADS_PLATFORMS = Object.freeze(['meta', 'google']);
/** The last 4 digits of an ad account id (act_123456789 → 6789), what the app shows to tell accounts apart. */
export const idTailOf = (id) => String(id ?? '').replace(/^act_/, '').slice(-4);
/** our ads platform → the connected-account platform (server/connections/zernio.mjs, analytics) */
export const CONNECTION_OF = Object.freeze({ meta: 'meta_ads', google: 'google_ads' });
/** our ads platform → the `platform` field Zernio's update bodies take */
export const ZERNIO_UPDATE_PLATFORM = Object.freeze({ meta: 'facebook', google: 'google' });
export const PLATFORM_LABEL = Object.freeze({ meta: 'Meta', google: 'Google' });
export const MANAGER_LABEL = Object.freeze({ meta: 'Meta Ads Manager', google: 'Google Ads' });
export const LAUNCH_CHOICES = Object.freeze(['PAUSED', 'ACTIVE']);
export const CAMPAIGN_STATES = Object.freeze(['launching', 'in_review', 'active', 'paused', 'rejected', 'with_issues', 'completed', 'ended', 'failed', 'unknown']);
export const JOB_STATES = Object.freeze(['queued', 'sending', 'done', 'failed', 'unknown']);
export const CHANGE_ACTIONS = Object.freeze(['pause', 'resume', 'end', 'budget', 'end_date', 'creative']);
export const JOB_KINDS = Object.freeze(['launch', ...CHANGE_ACTIONS]);
/** jobs that only stop spend: never blocked by limits, the kill switch, the plan gate or the ads-write bucket */
export const STOP_ACTIONS = Object.freeze(['pause', 'end']);
/** campaign states that can't spend any more and are never counted or offered Resume */
export const FINAL_STATES = Object.freeze(['ended', 'completed', 'failed']);
/** live job states: one per campaign (ad_jobs_one_live) */
export const LIVE_JOB_STATES = Object.freeze(['queued', 'sending', 'unknown']);
/** the Zernio webhook events that go to the ads listener */
export const AD_EVENTS = Object.freeze(['ad.review.approved', 'ad.review.rejected', 'ad.status_changed', 'ad.delivery_issue', 'ad_account.status_changed']);
