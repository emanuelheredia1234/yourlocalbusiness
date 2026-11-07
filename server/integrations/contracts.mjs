// The server's copy of the shared contracts (src/lib/integrations/types.ts is the app's): the shapes every
// integration route answers with, as JSDoc, plus the constants both sides agree on. A test keeps the lists
// here and in types.ts the same.

/**
 * @typedef {'facebook'|'instagram'|'linkedin'|'tiktok'|'x'|'youtube'|'pinterest'|'google_ads'|'meta_ads'|'linkedin_ads'|'tiktok_ads'|'pinterest_ads'|'x_ads'|'reddit_ads'|'microsoft_ads'} Platform
 * @typedef {'not_connected'|'pending'|'connected'|'limited'|'needs_reconnect'|'coming_soon'} ConnectionState
 * @typedef {'missing_permissions'|'no_page_role'|'app_not_approved'|'insights_unavailable'|'private_only'} LimitedReason
 * @typedef {'fb_page'|'ig_account'|'li_person'|'li_org'|'yt_channel'|'ads_account'|'tt_account'|'x_account'|'pin_account'} TargetKind
 *
 * @typedef {object} ConnectionStatus  What the browser sees of a connection (never its id or token).
 * @property {Platform} platform
 * @property {ConnectionState} state
 * @property {LimitedReason} [limitedReason]
 * @property {string} [targetLabel]
 * @property {TargetKind} [targetKind]
 * @property {number} [targetsAvailable]
 * @property {boolean} [expiresSoon]
 * @property {string} [connectedAt]
 * @property {string} [lastError]
 *
 * @typedef {object} Target
 * @property {string} id  opaque server handle: HMAC of the real id, never the raw id
 * @property {string} label
 * @property {TargetKind} kind
 *
 * @typedef {'queued'|'sending'|'sent'|'failed'|'unknown'} PublishState
 *
 * @typedef {object} PublishRequest
 * @property {string} projectId
 * @property {string} postId
 * @property {'instagram'|'facebook'|'tiktok'|'linkedin'|'x'|'youtube'} platform
 * @property {true} confirm
 * @property {string} clientRequestId  uuid; dedupes double clicks
 * @property {{text: string, hashtags?: string[], link?: string, linkPlacement?: 'in_post'|'first_comment'|'bio'|'none', firstComment?: string, mediaIds?: string[], title?: string}} content
 *
 * @typedef {object} PublishJob
 * @property {string} id
 * @property {string} postId
 * @property {string} platform
 * @property {PublishState} state
 * @property {string} [url]
 * @property {string} [errorCode]
 * @property {string} [errorMessage]
 * @property {string} requestedAt
 * @property {string} [finishedAt]
 * @property {string} [checkedAt]
 *
 * @typedef {'social'|'ads'|'seo'|'email'} AnalyticsSource
 * @typedef {'ok'|'partial'|'error'|'not_connected'|'skipped'|'pending'} SourceStatus
 *
 * @typedef {object} AnalyticsSnapshot
 * @property {string} projectId
 * @property {AnalyticsSource} source
 * @property {SourceStatus} status
 * @property {string} [errorCode]
 * @property {string} [fetchedAt]
 * @property {number} costMicro
 * @property {object} data  SocialData | AdsData | SeoData | EmailData (src/lib/integrations/types.ts)
 *
 * @typedef {object} RefreshRun
 * @property {string} id
 * @property {string} projectId
 * @property {'running'|'done'|'done_with_errors'} state
 * @property {Record<AnalyticsSource, 'queued'|'running'|SourceStatus>} sources
 * @property {string} startedAt
 * @property {string} [finishedAt]
 *
 * @typedef {object} CustomerUsage
 * @property {{costMicro: number, calls: number}} today
 * @property {{costMicro: number, calls: number}} month
 * @property {{dailyCapMicro: number, monthlyCapMicro: number, status: 'active'|'blocked'}} caps
 * @property {{feature: string, costMicro: number, calls: number}[]} byFeature
 * @property {{at: string, feature: string, label: string, costMicro: number, estimated: boolean}[]} recent
 *
 * @typedef {object} ApiError
 * @property {string} error
 * @property {string} code  one of API_ERROR_CODES
 * @property {string} [nextAt]
 * @property {'day'|'month'} [period]
 * @property {string} [hint]  admins only
 */

/**
 * Every account a customer can connect: the social networks through Upload-Post (server/connections/uploadpost.mjs;
 * each business connects its own) and the ad accounts through Zernio (server/connections/zernio.mjs). Search Console is not here: it runs on treg's
 * team connection (server/seo/google.mjs).
 * @type {readonly Platform[]}
 */
export const PLATFORMS = Object.freeze(['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube', 'pinterest', 'google_ads', 'meta_ads', 'linkedin_ads', 'tiktok_ads', 'pinterest_ads', 'x_ads', 'reddit_ads', 'microsoft_ads']);
/** @type {readonly Platform[]} the social networks */
export const SOCIAL_PLATFORMS = Object.freeze(['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube', 'pinterest']);
/** @type {readonly Platform[]} the ad accounts (results are read here; launches and changes go through server/ads/) */
export const AD_PLATFORMS = Object.freeze(['google_ads', 'meta_ads', 'linkedin_ads', 'tiktok_ads', 'pinterest_ads', 'x_ads', 'reddit_ads', 'microsoft_ads']);
/**
 * @type {readonly Platform[]} shown as "Coming soon": Pinterest (posts in the app have no Pinterest format yet) and
 * X Ads (Zernio's X Ads connect needs an X account inside Zernio, and X posting is Upload-Post's)
 */
export const PHASE2_PLATFORMS = Object.freeze(['pinterest', 'x_ads']);
export const PHASE1_PLATFORMS = Object.freeze(PLATFORMS.filter((p) => !PHASE2_PLATFORMS.includes(p)));
export const CONNECTION_STATES = Object.freeze(['not_connected', 'pending', 'connected', 'limited', 'needs_reconnect', 'coming_soon']);
export const LIMITED_REASONS = Object.freeze(['missing_permissions', 'no_page_role', 'app_not_approved', 'insights_unavailable', 'private_only']);
export const PUBLISH_STATES = Object.freeze(['queued', 'sending', 'sent', 'failed', 'unknown']);
export const PUBLISH_PLATFORMS = Object.freeze(['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube']);
export const ANALYTICS_SOURCES = Object.freeze(['social', 'ads', 'seo', 'email']);
export const SOURCE_STATUSES = Object.freeze(['ok', 'partial', 'error', 'not_connected', 'skipped', 'pending']);
export const LEDGER_FEATURES = Object.freeze(['social', 'seo', 'ads', 'gsc', 'email', 'posting', 'connections']);
export const LEDGER_VENDORS = Object.freeze(['treg', 'uploadpost', 'zernio', 'nango', 'x', 'omnisend']);
export const API_ERROR_CODES = Object.freeze([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'NOT_SET_UP',
  'CONNECTIONS_NOT_ENABLED',
  'CONNECTIONS_UNAVAILABLE',
  'BUSINESS_LIMIT',
  'NOT_CONNECTED',
  'NEEDS_RECONNECT',
  'ALREADY_PUBLISHING',
  'POST_CHANGED',
  'MEDIA_UNSUPPORTED',
  'PLATFORM_LIMIT',
  'REFRESH_TOO_SOON',
  'NOTHING_TO_UPDATE',
  'CUSTOMER_CAP',
  'CUSTOMER_BLOCKED',
  'INSPECTION_QUOTA',
  'UNAVAILABLE',
  'RATE_LIMITED',
  'BAD_REQUEST',
  // plans and billing (server/billing/stripe.mjs)
  'PLAN_REQUIRED',
  'PAYMENT_REQUIRED',
  'CREDITS_USED',
  'ALREADY_SUBSCRIBED',
  'CARD_DECLINED',
  'BILLING_PENDING',
  'OWNER_PLAN',
  'NOT_ALLOWED_ON_PLAN',
  // a money change read back and not there (definite); cancelling in the Customer Portal until the P1c migration runs
  'NOT_APPLIED',
  'USE_PORTAL',
  // the morning action asked for in the late window (02:00–05:00 local): { nextAt }
  'NOT_DUE',
  // A/B tests and Trial Reels (server/experiments, P4b)
  'TRIAL_REEL_NOT_ELIGIBLE',
  'EXPERIMENT_LIMIT',
  'EXPERIMENT_RUNNING',
  'TOO_SOON',
  'TOO_SOON_AFTER_VARIANT',
  'VARIANT_NO_FORM',
  'CAMPAIGN_UNCONFIRMED',
]);

/** The route prefixes the server hands to the integration modules (server/integrations/wiring.mjs). */
export const ROUTE_PREFIXES = Object.freeze({
  connections: '/api/integrations/connections',
  zernioWebhook: '/api/webhooks/zernio',
  uploadPostWebhook: '/api/webhooks/upload-post',
  nango: '/api/integrations/nango',
  nangoWebhook: '/api/webhooks/nango',
  posting: '/api/posting/',
  publicMedia: '/api/media/public/',
  analytics: '/api/analytics/',
  seoGoogle: '/api/seo/google/',
  billing: '/api/billing/',
  ads: '/api/ads/',
  stripeWebhook: '/api/webhooks/stripe',
  // offers and buy links (server/offers/index.mjs), the users' own Whop accounts and their webhooks
  offers: '/api/offers',
  whop: '/api/payments/whop',
  whopWebhook: '/api/webhooks/whop/',
  // Stripe Connect for sellers (server/payments/stripeConnect.mjs, through the offers module) and its own webhook: a
  // sibling of /api/webhooks/stripe, never under it (that one is billing's)
  stripePayments: '/api/payments/stripe',
  stripeConnectWebhook: '/api/webhooks/stripe-connect',
  // the morning action (server/morning/index.mjs)
  morning: '/api/morning/',
  // A/B tests and Trial Reels' eligibility (server/experiments/index.mjs)
  experiments: '/api/experiments',
  // the public marketplace's seller and owner routes (server/market/index.mjs; the pages are /market on the app host)
  market: '/api/market',
});

/** Rate-limit buckets (per user unless noted), as `${bucket}:user:<id>` keys for rateLimited(key, factor). */
export const RATE_BUCKETS = Object.freeze({
  connect: 'integrations-connect', // 10 per hour
  release: 'integrations-release', // 60 per hour (a deleted business frees its social slot)
  publish: 'posting-publish', // 30 per hour
  refresh: 'analytics-refresh', // 1 per business per 15 min (analytics_runs) + 10 per hour
  publicMedia: 'media-public', // 120 per minute per IP
  billingRead: 'billing-read', // 60 per minute
  zernioWebhook: 'zernio-webhook', // 600 per minute per IP
  uploadPostWebhook: 'upload-post-webhook', // 600 per minute per IP
  nangoWebhook: 'nango-webhook', // 600 per minute per IP
  postingCheck: 'posting-check', // 1 per job per 30 s + 60 per hour
  adsRead: 'ads-read', // 60 per minute (accounts, targeting search, campaigns, audit, jobs)
  adsPreview: 'ads-preview', // 30 per hour
  adsWrite: 'ads-write', // 20 per hour (launch, resume, budget, end date, creative) + the owner's per-day counts
  adsStop: 'ads-stop', // 120 per hour (pause and end only: stopping is never throttled by ads-write)
  adsCheck: 'ads-check', // 1 per job per 30 s + 60 per hour
  adsRefresh: 'ads-refresh', // 1 per business per 5 minutes
  billingWrite: 'billing-write', // 20 per hour (checkout, portal, businesses, plan changes)
  stripeWebhook: 'stripe-webhook', // 600 per minute per IP
  offersRead: 'offers-read', // 120 per minute (offers, sales, summary, connections)
  offersWrite: 'offers-write', // 60 per hour (create, edit, check, archive, delete)
  whopConnect: 'whop-connect', // 10 per hour (connect, key, webhook secret, check, disconnect)
  whopCatalog: 'whop-catalog', // 30 per minute (products and plans)
  whopWebhook: 'whop-webhook', // 600 per minute per IP
  stripeConnect: 'stripe-connect', // 10 per hour (create a seller account, onboarding links)
  stripeConnectRead: 'stripe-connect-read', // 120 per minute (the account, sync, tax, the owner's view)
  stripeConnectWebhook: 'stripe-connect-webhook', // 600 per minute per IP
  saleLink: 'sale-link', // 30 per hour (a seller's new download link for a buyer)
  morningRead: 'morning-read', // 120 per minute (today's state, the owner's section)
  morningGenerate: 'morning-generate', // 6 per hour, counted only when a generation starts (all the user's businesses)
  morningFeedback: 'morning-feedback', // 60 per hour (Done, Undo, Not useful)
  experiments: 'experiments', // 60 per hour (create, change, start, refresh, stop, use the winner, delete)
  experimentsRead: 'experiments-read', // 120 per minute (the list, one test, usage, Trial Reels eligibility)
  marketWrite: 'market-write', // 30 per hour (put a listing on the web, update it, take it off)
  marketRead: 'market-read', // 120 per minute (the seller's public listings)
  marketReport: 'market-report', // 10 per hour (a signed-in report of a public listing)
  marketAdmin: 'market-admin', // 120 per hour (the owner's moderation and sitemap submit)
});
