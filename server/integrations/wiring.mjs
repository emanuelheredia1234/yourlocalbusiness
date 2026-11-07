// Everything ai-server.mjs needs for connected accounts, posting, analytics, usage/billing and "publish my
// page to Google", in one place, so the server file doesn't change as each part is built:
//
//   const integrations = createIntegrations({ env, auth, appState, omnisend, send, readJson, rateLimited,
//                                             corsHeaders, sameOrigin, clientKey });
//   integrations.match(url) / handle(req, res, url)      the routes below
//   integrations.appHostExtras(req, res, url)            for pagesFromEnv(..., { appHostExtras }): app-host
//                                                        /sitemap.xml, /robots.txt, the GSC verification file
//   integrations.forgetUser(id, {ackLiveAds}) / unforgetUser(id)   before an account is deleted / when that failed
//                                                        (409 ADS_LIVE while a launched campaign is on, unless acked)
//   integrations.userDeleted(id)                         after it was deleted (e.g. the ledger keeps its rows)
//   integrations.start()                                 the startup sweeps (stuck jobs, stuck runs, pending rows)
//   integrations.cronJobs()                              the periodic jobs for server/cron (POST /api/cron/tick)
//   integrations.notes()                                 startup lines: what's on, which Secrets are missing (names)
//   integrations.billing                                 the plans (server/billing/stripe.mjs): entitlement(userId, who),
//                                                        requireActive(who, feature), businessLimit(userId),
//                                                        pagesServeUntil(userId), config() — for ai-server.mjs and pages
//
// Routes (server/integrations/contracts.mjs ROUTE_PREFIXES):
//   /api/integrations/connections…  /api/webhooks/upload-post  /api/webhooks/zernio
//                                                          server/connections/routes.mjs (+ connections/uploadpost.mjs
//                                                          for social, connections/zernio.mjs for ads)
//   /api/integrations/nango…  /api/webhooks/nango         server/connections/nangoRoutes.mjs (+ server/nango.mjs)
//   /api/posting/…                                         server/social/routes.mjs
//   /api/media/public/<token>                              server/media/publicMedia.mjs
//   /api/analytics/…                                       server/analytics/routes.mjs
//   /api/seo/google/…                                      server/seo/google.mjs
//   /api/billing/…  /api/webhooks/stripe                   server/billing/routes.mjs (+ billing/stripe.mjs: plans,
//                                                          Checkout, the portal, businesses, the Stripe webhook)
//   /api/ads/…                                             server/ads/routes.mjs (launching and changing campaigns;
//                                                          ad events arrive on /api/webhooks/zernio)
//   /api/offers…  /api/payments/whop…  /api/webhooks/whop/<id>   server/offers/index.mjs
//   /api/payments/stripe…  /api/webhooks/stripe-connect        (Stripe Connect, through the offers module) (offers and buy links, the
//                                                          users' own Whop accounts; /b/<id> through pages.mjs with
//                                                          integrations.offers.buy)
//   /api/morning/…                                         server/morning/index.mjs (the morning action; its hourly job
//                                                          runs first in each tick; aiText: the AI routes' generateText)
//   /api/experiments…                                      server/experiments/index.mjs (A/B tests and Trial Reels'
//                                                          eligibility; posting's variant hooks; the page split's
//                                                          hooks for pages.mjs: integrations.experimentPages)
//   /api/market…                                           server/market/index.mjs (the public marketplace: sellers'
//                                                          "Public on the web", reports, the owner's moderation; its
//                                                          pages /market… on the app host: integrations.marketPublic)
//
// Each module's factory gets the same deps: { auth, storage (appState), db (server/integrations/db.mjs),
// connections, treg, omnisend, send, readJson, readRaw, rateLimited, limit, corsHeaders, sameOrigin,
// clientKey, env, fetch, now, log } and returns { handle(req, res, url) → boolean, forgetUser?, unforgetUser?,
// userDeleted?, onStart?, cronJobs? }. The webhook and media paths are never logged as they are (redactPath), and nothing
// here reads a request body: the module does (readRaw for the webhook, whose HMAC covers the exact bytes).
//
// Connected accounts are two sides (the owner's choice): social networks, posting and social stats through
// Upload-Post, switched on by UPLOAD_POST_API_KEY; ad accounts and ad results through Zernio, switched on by
// ZERNIO_API_KEY. CONNECTIONS_PROVIDER=off keeps both off whatever is set. A side that is off reads "Not connected"
// and posting is manual. Facebook groups stay with Manus. Nango stays for future non-social integrations (booking
// tools, CRMs), off unless NANGO_SECRET_KEY is set, with no social or ads providers on it.

import { combineConnections, createConnections } from '../connections/index.mjs';
import { createConnectionRoutes } from '../connections/routes.mjs';
import { createZernioConnections } from '../connections/zernio.mjs';
import { createUploadPostConnections } from '../connections/uploadpost.mjs';
import { createNangoRoutes } from '../connections/nangoRoutes.mjs';
import { createNango, nullNango } from '../nango.mjs';
import { createPostingRoutes } from '../social/routes.mjs';
import { createPublicMediaRoutes } from '../media/publicMedia.mjs';
import { createAnalyticsRoutes } from '../analytics/routes.mjs';
import { createSeoGoogleRoutes } from '../seo/google.mjs';
import { createSitemapRoutes } from '../seo/sitemap.mjs';
import { createBillingRoutes } from '../billing/routes.mjs';
import { createAdsRoutes } from '../ads/routes.mjs';
import { createOffers } from '../offers/index.mjs';
import { createMorning } from '../morning/index.mjs';
import { createExperiments } from '../experiments/index.mjs';
import { createMarket } from '../market/index.mjs';
import { createTreg } from '../treg.mjs';
import { createTrialReels } from '../social/trialReels.mjs';
import { dbFromEnv, INTEGRATIONS_MIGRATION } from './db.mjs';
import { createBucketLimiter, readRaw, redactPath, safeLog } from './common.mjs';
import { ROUTE_PREFIXES } from './contracts.mjs';
import { entitlementOf } from '../billing/entitlement.mjs';

/** Plans not wired (tests with a stub billing module): everything as before plans. */
const LEGACY = Object.freeze(entitlementOf(null, { enforce: false }));

/**
 * The plans, late-bound: modules made before the billing module (Upload-Post's connections) and after it (ads) ask
 * this; it answers "not enforced" until the billing module exists or when it has no plans.
 */
export function billingFacade(get) {
  const impl = () => get()?.plans ?? null;
  return {
    entitlement: async (userId, who = null) => (impl() ? impl().entitlement(userId, who) : LEGACY),
    requireActive: async (who, feature = null) => (impl() ? impl().requireActive(who, feature) : null),
    requireSlot: async (who, projectId) => (impl()?.requireSlot ? impl().requireSlot(who, projectId) : null),
    businessLimit: async (userId, who = null) => (impl() ? impl().businessLimit(userId, who) : null),
    pagesServeUntil: async (userId) => (impl() ? impl().pagesServeUntil(userId) : null),
    /** the owner's views: an account's email (Supabase Auth's admin API, cached), or '' */
    emailFor: async (userId) => (get()?.emailFor ? get().emailFor(userId) : ''),
    tregCapsFor: async (tag) => (impl() ? impl().tregCapsFor(tag) : null),
    config: () => (impl() ? impl().config() : { enabled: false, enforce: false }),
    notes: () => impl()?.notes?.() ?? [],
  };
}

export const DEFAULT_FACTORIES = Object.freeze({
  uploadPost: createUploadPostConnections,
  zernio: createZernioConnections,
  nango: createNango,
  connectionRoutes: createConnectionRoutes,
  nangoRoutes: createNangoRoutes,
  posting: createPostingRoutes,
  publicMedia: createPublicMediaRoutes,
  analytics: createAnalyticsRoutes,
  seoGoogle: createSeoGoogleRoutes,
  sitemap: createSitemapRoutes,
  billing: createBillingRoutes,
  ads: createAdsRoutes,
  offers: createOffers,
  morning: createMorning,
  experiments: createExperiments,
  market: createMarket,
  treg: createTreg,
});

const has = (env, name) => String(env?.[name] ?? '').trim() !== '';

/**
 * Which connections the env asks for: { social: 'upload_post' | null, ads: 'zernio' | null, reason } — social on
 * with UPLOAD_POST_API_KEY, ads on with ZERNIO_API_KEY, both off with CONNECTIONS_PROVIDER=off. `provider` names
 * what is on ('upload_post+zernio', 'upload_post', 'zernio' or null) for the startup notes and tests.
 */
export function selectConnections(env = process.env) {
  const provider = String(env.CONNECTIONS_PROVIDER || '').trim().toLowerCase();
  if (['off', 'none', 'false', '0'].includes(provider)) return { provider: null, social: null, ads: null, reason: 'off' };
  if (provider && !['on', 'auto', 'upload_post', 'zernio'].includes(provider)) return { provider: null, social: null, ads: null, reason: 'unknown_provider' };
  const social = has(env, 'UPLOAD_POST_API_KEY') ? 'upload_post' : null;
  const ads = has(env, 'ZERNIO_API_KEY') ? 'zernio' : null;
  const name = [social, ads].filter(Boolean).join('+') || null;
  return { provider: name, social, ads, reason: name ? 'key' : 'no_key' };
}

/** Which module answers a path ('connections' covers the Upload-Post and Zernio webhooks, 'nango' its own), or null. */
export function moduleFor(pathname) {
  const p = String(pathname || '');
  const under = (prefix) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix || p.startsWith(`${prefix}/`));
  if (under(ROUTE_PREFIXES.connections) || under(ROUTE_PREFIXES.zernioWebhook) || under(ROUTE_PREFIXES.uploadPostWebhook)) return 'connections';
  if (under(ROUTE_PREFIXES.nango) || under(ROUTE_PREFIXES.nangoWebhook)) return 'nango';
  if (under(ROUTE_PREFIXES.posting)) return 'posting';
  if (under(ROUTE_PREFIXES.publicMedia)) return 'publicMedia';
  if (under(ROUTE_PREFIXES.analytics)) return 'analytics';
  if (under(ROUTE_PREFIXES.seoGoogle)) return 'seoGoogle';
  if (under(ROUTE_PREFIXES.billing) || under(ROUTE_PREFIXES.stripeWebhook)) return 'billing';
  if (under(ROUTE_PREFIXES.ads)) return 'ads';
  if (under(ROUTE_PREFIXES.offers) || under(ROUTE_PREFIXES.whop) || under(ROUTE_PREFIXES.whopWebhook) || under(ROUTE_PREFIXES.stripePayments) || under(ROUTE_PREFIXES.stripeConnectWebhook)) return 'offers';
  if (under(ROUTE_PREFIXES.morning)) return 'morning';
  if (under(ROUTE_PREFIXES.experiments)) return 'experiments';
  if (under(ROUTE_PREFIXES.market)) return 'market';
  return null;
}

/**
 * env, auth, appState, omnisend, send, readJson, rateLimited, corsHeaders, sameOrigin(req), clientKey(req): the
 * server's own (ai-server.mjs). aiText(who, fn, prompt, opts): server-side writing through the AI routes' gate (the
 * morning action; null: rules only); aiPowered(): some ready key powers Morning action. fetch, now, log, db,
 * factories: for tests.
 */
export function createIntegrations({
  env = process.env,
  auth,
  appState,
  omnisend = null,
  send,
  readJson,
  rateLimited = () => false,
  corsHeaders = () => ({}),
  sameOrigin = () => true,
  clientKey = (req) => req.socket?.remoteAddress || 'unknown',
  fetch = globalThis.fetch,
  now = () => Date.now(),
  log = console,
  db = null,
  factories = {},
  aiText = null,
  aiPowered = () => false,
} = {}) {
  const make = { ...DEFAULT_FACTORIES, ...factories };
  const database = db ?? dbFromEnv(env, fetch);
  const limit = createBucketLimiter({ now });
  // the billing module is made below; everything made before it asks through this facade
  let billingModule = null;
  const billing = billingFacade(() => billingModule);
  const base = { auth, storage: appState, db: database, omnisend, send, readJson, readRaw, rateLimited, limit, corsHeaders, sameOrigin, clientKey, env, fetch, now, log, billing };

  const selected = selectConnections(env);
  const connections = createConnections(combineConnections({ social: selected.social ? make.uploadPost(base) : null, ads: selected.ads ? make.zernio(base) : null }));
  const nango = has(env, 'NANGO_SECRET_KEY') ? make.nango(base) : nullNango;
  // the tier layer of each customer's treg caps comes from the plans (late-bound: the billing module is made below)
  const treg = make.treg({ env, fetch, now, db: database, log, tierFor: (tag) => billing.tregCapsFor(tag) });
  // the disconnect route asks the ads module which launched campaigns are still on (R12); the module is made below
  let adsModule = null;
  // Instagram Trial Reels' eligibility (posting and the experiments module share its 6-hour follower cache); the A/B
  // tests' posting hooks are late-bound (the experiments module is made after posting)
  const trialReels = createTrialReels({ db: database, connections, now, log });
  let experimentsModule = null;
  const deps = { ...base, connections, nango, treg, trialReels, experimentHooks: () => experimentsModule?.postingHooks ?? null, liveAdsGuard: (userId, platform) => adsModule?.liveOn?.(userId, platform) ?? [] };

  const modules = {
    connections: make.connectionRoutes(deps),
    nango: make.nangoRoutes(deps),
    posting: make.posting(deps),
    publicMedia: make.publicMedia(deps),
    analytics: make.analytics(deps),
    seoGoogle: make.seoGoogle(deps),
    billing: make.billing(deps),
    ads: make.ads(deps),
    offers: make.offers(deps),
    // last: its hourly job runs after the quick sweeps in each tick
    morning: make.morning({ ...deps, aiText, aiPowered }),
    // A/B tests: after morning (its hourly results job runs after the morning action's)
    experiments: make.experiments(deps),
    // the public marketplace: after offers and billing (it reads both)
    market: make.market(deps),
  };
  experimentsModule = modules.experiments;
  adsModule = modules.ads;
  billingModule = modules.billing;
  // P6: our fee events reach the P1 Stripe endpoint (the platform's); Stripe Connect handles them
  modules.billing.plans?.setPlatformEventHandler?.((evt) => modules.offers.connectPlatformEvent?.(evt) ?? 'ignored');
  const sitemap = make.sitemap(deps);
  // the sitemap lists the market's live listings; the market drops the sitemap's cache when one changes
  sitemap.setMarket?.(modules.market);
  modules.market.setSitemap?.(sitemap);
  // an upload_completed webhook from Upload-Post finishes its job (sent / failed) the same way "Check again" does
  // (only a job of the business whose profile the event came through)
  connections.impl?.social?.setPostListener?.((userId, jobId, outcome, where) => modules.posting.posting?.fromWebhook?.(userId, jobId, outcome, where));
  // ad events from Zernio's webhook (only those about one of the customer's own connections) update launched campaigns
  connections.impl?.ads?.setAdsListener?.((userId, zid, evt) => modules.ads.fromWebhook?.(userId, zid, evt));
  // account deletion: the vendor's connections go first (while their ids are still known), then the rest
  // (offers before billing: each Whop webhook gets its one removal attempt while the keys are still there)
  const FORGET_ORDER = ['ads', 'posting', 'analytics', 'seoGoogle', 'market', 'offers', 'billing', 'publicMedia', 'experiments', 'nango', 'connections'];

  const crashed = (req, res, path, e) => {
    safeLog('integration_error', { path: redactPath(path), error: e?.name || 'Error', code: e?.code }, log);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Try again shortly.', code: 'UNAVAILABLE' }, corsHeaders(req));
    else res.destroy();
  };

  return {
    connections,
    nango,
    treg,
    db: database,
    billing,
    /** offers and buy links: .buy for pages.mjs (/b/<id>), .config() for /api/config */
    offers: modules.offers,
    offersConfig: () => modules.offers.config?.() ?? { enabled: false, whop: { sandbox: false, production: false } },
    /** the morning action, for /api/config */
    morningConfig: () => modules.morning.config?.() ?? { enabled: false },
    /** A/B tests, for /api/config */
    experimentsConfig: () => modules.experiments.config?.() ?? { enabled: false },
    /** the page split's hooks for pages.mjs and leads.mjs (null when A/B tests are off) */
    experimentPages: modules.experiments.pageHooks ?? null,
    /** the public marketplace's pages (/market… on the app's host only), for ai-server.mjs */
    marketPublic: modules.market.publicRoutes ?? { match: () => false, handle: async () => {} },
    /** the public marketplace, for /api/config: { enabled, publicUrl } */
    marketConfig: () => modules.market.config?.() ?? { enabled: false, publicUrl: null },
    /** pages.mjs, once made: "Use the winner" republishes a page with version B through it */
    setPages: (pages) => modules.experiments.setPages?.(pages),
    /** for tests and the startup notes */
    connectionsProvider: selected.provider,
    connectionsSelected: selected,

    match: (url) => moduleFor(url.pathname) !== null,

    async handle(req, res, url) {
      const name = moduleFor(url.pathname);
      if (!name) return false;
      try {
        const handled = await modules[name].handle(req, res, url);
        if (handled === false && !res.headersSent) send(res, 404, { error: 'Not found.', code: 'NOT_FOUND' }, corsHeaders(req));
      } catch (e) {
        crashed(req, res, url.pathname, e);
      }
      return true;
    },

    /** pages.mjs's appHostExtras hook: the sitemap module's paths on the app's own host. */
    appHostExtras: (req, res, url) => modules.offers.connectPages?.(req, res, url) || sitemap.handle(req, res, url),

    /**
     * Before an account is deleted: the connections at the vendor first (Nango deletes each, one attempt), then
     * the stored connection doc, then posting, analytics, SEO and billing. A module that throws stops the
     * deletion (the caller lifts the others with unforgetUser).
     */
    async forgetUser(userId, opts = {}) {
      // launched campaigns first: once the Zernio connections are gone nothing could pause them (409 ADS_LIVE
      // while one is on, unless the customer acknowledged it with ackLiveAds)
      await modules.ads.beforeForget?.(userId, opts);
      // then a live plan subscription is cancelled (409 BILLING_PENDING when that can't be confirmed): before any
      // vendor connection goes, so a stopped deletion leaves everything as it was
      await modules.billing.beforeForget?.(userId, opts);
      await connections.forgetUser(userId);
      for (const name of FORGET_ORDER) await modules[name].forgetUser?.(userId);
    },

    /** The deletion didn't happen: lift what forgetUser blocked (best effort, newest first). */
    async unforgetUser(userId) {
      for (const name of [...FORGET_ORDER].reverse()) {
        try {
          await modules[name].unforgetUser?.(userId);
        } catch {
          safeLog('integration_unforget_failed', { module: name }, log);
        }
      }
      try {
        await connections.unforgetUser(userId);
      } catch {
        safeLog('integration_unforget_failed', { module: 'connections' }, log);
      }
    },

    /** After the account is gone (best effort): e.g. the ledger clears user_id and keeps the customer tag. */
    async userDeleted(userId) {
      for (const name of FORGET_ORDER) {
        try {
          await modules[name].userDeleted?.(userId);
        } catch {
          safeLog('integration_user_deleted_failed', { module: name }, log);
        }
      }
    },

    /** The startup sweeps (stuck `sending` jobs → unknown, stuck runs → done_with_errors, pending treg rows). */
    async start() {
      for (const [name, m] of Object.entries(modules)) {
        try {
          await m.onStart?.();
        } catch (e) {
          safeLog('integration_start_failed', { module: name, error: e?.name || 'Error', code: e?.code }, log);
        }
      }
    },

    /**
     * The periodic jobs each module asks for (server/cron registers them; POST /api/cron/tick runs them): the treg
     * settle, Upload-Post's and Zernio's daily metering and reconcile, and the stuck-job sweeps.
     */
    cronJobs() {
      const out = [];
      for (const [name, m] of Object.entries(modules)) {
        try {
          out.push(...(m.cronJobs?.() ?? []));
        } catch (e) {
          safeLog('integration_cron_jobs_failed', { module: name, error: e?.name || 'Error' }, log);
        }
      }
      return out;
    },

    /** What to print at startup: what's on and which Secrets are missing, by name only. */
    notes() {
      const lines = [];
      if (selected.reason === 'off') {
        lines.push('Connected accounts: off (CONNECTIONS_PROVIDER=off). Customers post themselves and mark posts as posted.');
      } else if (selected.reason === 'unknown_provider') {
        lines.push('Connected accounts: off (CONNECTIONS_PROVIDER isn’t "off" or empty). Customers post themselves and mark posts as posted.');
      } else {
        if (selected.social) {
          lines.push('Social accounts and posting: on (Upload-Post).');
          const missing = ['UPLOAD_POST_WEBHOOK_SECRET', 'CUSTOMER_TAG_SECRET', 'MEDIA_URL_SECRET'].filter((n) => !has(env, n));
          if (missing.length) lines.push(`Social accounts and posting also need these Replit Secrets: ${missing.join(', ')}.`);
        } else lines.push('Social accounts and posting: off. Customers post themselves and mark posts as posted (add UPLOAD_POST_API_KEY and UPLOAD_POST_WEBHOOK_SECRET in Replit Secrets to turn them on).');
        if (selected.ads) {
          lines.push('Ad accounts: on (Zernio).');
          const missing = ['ZERNIO_WEBHOOK_SECRET', 'CUSTOMER_TAG_SECRET'].filter((n) => !has(env, n));
          if (missing.length) lines.push(`Ad accounts also need these Replit Secrets: ${missing.join(', ')}.`);
          lines.push(String(env.ADS_LAUNCH_ENABLED ?? '').trim() === '1' ? 'Launching ads: on (ADS_LAUNCH_ENABLED=1); each customer still needs ads turned on in Owner → Billing → Ad limits.' : 'Launching ads: off (ADS_LAUNCH_ENABLED isn’t 1). Pausing and ending launched campaigns still work.');
          if (!has(env, 'ADS_REVIEW_SECRET')) lines.push('Launching ads: ADS_REVIEW_SECRET isn’t set, so review tokens fall back to CUSTOMER_TAG_SECRET.');
          if (!has(env, 'MEDIA_URL_SECRET')) lines.push('Launching ads on Meta needs MEDIA_URL_SECRET (Meta fetches the ad images from the app).');
        } else lines.push('Ad accounts: off (add ZERNIO_API_KEY and ZERNIO_WEBHOOK_SECRET in Replit Secrets to turn them on).');
      }
      lines.push(nango.enabled ? `Other integrations (Nango): on, ${Object.keys(nango.integrations ?? {}).length} listed.` : 'Other integrations (Nango): off (kept for future booking tools and CRMs; add NANGO_SECRET_KEY to turn on).');
      const t = treg.health?.() ?? { setUp: false, billingSetUp: false };
      lines.push(t.setUp ? 'Analytics data (treg): on.' : 'Analytics data (treg): off (add the TREG_TOKEN Secret).');
      if (!t.billingSetUp) lines.push('Per-customer caps and the treg check: add TREG_ADMIN_TOKEN and TREG_ORG_ID in Replit Secrets.');
      if (!has(env, 'CUSTOMER_TAG_SECRET')) lines.push('Usage tracking per customer needs the CUSTOMER_TAG_SECRET Secret (32+ random bytes; never change it).');
      lines.push(...billing.notes());
      lines.push(...(modules.offers.notes?.() ?? []));
      lines.push(...(modules.morning.notes?.() ?? []));
      lines.push(...(modules.experiments.notes?.() ?? []));
      lines.push(...(modules.market.notes?.() ?? []));
      if (database.enabled) lines.push(`Integrations need ${INTEGRATIONS_MIGRATION}, supabase/migrations/20261106000000_zernio.sql, supabase/migrations/20261107000000_upload_post.sql, supabase/migrations/20261108000000_ads_launch.sql, supabase/migrations/20261110000000_billing.sql, supabase/migrations/20261111000000_video_week.sql, supabase/migrations/20261116000000_morning_action.sql and supabase/migrations/20261117000000_experiments.sql in Supabase.`);
      return lines;
    },
  };
}
