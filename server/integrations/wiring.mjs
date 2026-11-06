// Everything ai-server.mjs needs for connected accounts, posting, analytics, usage/billing and "publish my
// page to Google", in one place, so the server file doesn't change as each part is built:
//
//   const integrations = createIntegrations({ env, auth, appState, omnisend, send, readJson, rateLimited,
//                                             corsHeaders, sameOrigin, clientKey });
//   integrations.match(url) / handle(req, res, url)      the routes below
//   integrations.appHostExtras(req, res, url)            for pagesFromEnv(..., { appHostExtras }): app-host
//                                                        /sitemap.xml, /robots.txt, the GSC verification file
//   integrations.forgetUser(id) / unforgetUser(id)       before an account is deleted / when that failed
//   integrations.userDeleted(id)                         after it was deleted (e.g. the ledger keeps its rows)
//   integrations.start()                                 the startup sweeps (stuck jobs, stuck runs, pending rows)
//   integrations.notes()                                 startup lines: what's on, which Secrets are missing (names)
//
// Routes (server/integrations/contracts.mjs ROUTE_PREFIXES):
//   /api/integrations/connections…  /api/webhooks/zernio  server/connections/routes.mjs (+ connections/zernio.mjs)
//   /api/integrations/nango…  /api/webhooks/nango         server/connections/nangoRoutes.mjs (+ server/nango.mjs)
//   /api/posting/…                                         server/social/routes.mjs
//   /api/media/public/<token>                              server/media/publicMedia.mjs
//   /api/analytics/…                                       server/analytics/routes.mjs
//   /api/seo/google/…                                      server/seo/google.mjs
//   /api/billing/…                                         server/billing/routes.mjs
//
// Each module's factory gets the same deps: { auth, storage (appState), db (server/integrations/db.mjs),
// connections, treg, omnisend, send, readJson, readRaw, rateLimited, limit, corsHeaders, sameOrigin,
// clientKey, env, fetch, now, log } and returns { handle(req, res, url) → boolean, forgetUser?, unforgetUser?,
// userDeleted?, onStart? }. The webhook and media paths are never logged as they are (redactPath), and nothing
// here reads a request body: the module does (readRaw for the webhook, whose HMAC covers the exact bytes).
//
// Connected accounts (social networks and ad accounts) are Zernio (the owner's choice), switched on by ZERNIO_API_KEY
// alone; CONNECTIONS_PROVIDER=off keeps them off whatever is set. Until then every network reads "Not connected"
// and posting is manual. Nango stays for future non-social integrations (booking tools, CRMs), off unless
// NANGO_SECRET_KEY is set, with no social or ads providers on it.

import { createConnections, nullConnections } from '../connections/index.mjs';
import { createConnectionRoutes } from '../connections/routes.mjs';
import { createZernioConnections } from '../connections/zernio.mjs';
import { createNangoRoutes } from '../connections/nangoRoutes.mjs';
import { createNango, nullNango } from '../nango.mjs';
import { createPostingRoutes } from '../social/routes.mjs';
import { createPublicMediaRoutes } from '../media/publicMedia.mjs';
import { createAnalyticsRoutes } from '../analytics/routes.mjs';
import { createSeoGoogleRoutes } from '../seo/google.mjs';
import { createSitemapRoutes } from '../seo/sitemap.mjs';
import { createBillingRoutes } from '../billing/routes.mjs';
import { createTreg } from '../treg.mjs';
import { dbFromEnv, INTEGRATIONS_MIGRATION } from './db.mjs';
import { createBucketLimiter, readRaw, redactPath, safeLog } from './common.mjs';
import { ROUTE_PREFIXES } from './contracts.mjs';

export const DEFAULT_FACTORIES = Object.freeze({
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
  treg: createTreg,
});

const has = (env, name) => String(env?.[name] ?? '').trim() !== '';

/** Which connections implementation the env asks for: 'zernio' once ZERNIO_API_KEY is set, else null, and why. */
export function selectConnections(env = process.env) {
  const provider = String(env.CONNECTIONS_PROVIDER || '').trim().toLowerCase();
  if (['off', 'none', 'false', '0'].includes(provider)) return { provider: null, reason: 'off' };
  if (provider && provider !== 'zernio') return { provider: null, reason: 'unknown_provider' };
  if (!has(env, 'ZERNIO_API_KEY')) return { provider: null, reason: 'no_key' };
  return { provider: 'zernio', reason: 'key' };
}

/** Which module answers a path ('connections' covers the Zernio webhook, 'nango' its own), or null. */
export function moduleFor(pathname) {
  const p = String(pathname || '');
  const under = (prefix) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix || p.startsWith(`${prefix}/`));
  if (under(ROUTE_PREFIXES.connections) || under(ROUTE_PREFIXES.zernioWebhook)) return 'connections';
  if (under(ROUTE_PREFIXES.nango) || under(ROUTE_PREFIXES.nangoWebhook)) return 'nango';
  if (under(ROUTE_PREFIXES.posting)) return 'posting';
  if (under(ROUTE_PREFIXES.publicMedia)) return 'publicMedia';
  if (under(ROUTE_PREFIXES.analytics)) return 'analytics';
  if (under(ROUTE_PREFIXES.seoGoogle)) return 'seoGoogle';
  if (under(ROUTE_PREFIXES.billing)) return 'billing';
  return null;
}

/**
 * env, auth, appState, omnisend, send, readJson, rateLimited, corsHeaders, sameOrigin(req), clientKey(req): the
 * server's own (ai-server.mjs). fetch, now, log, db, factories: for tests.
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
} = {}) {
  const make = { ...DEFAULT_FACTORIES, ...factories };
  const database = db ?? dbFromEnv(env, fetch);
  const limit = createBucketLimiter({ now });
  const base = { auth, storage: appState, db: database, omnisend, send, readJson, readRaw, rateLimited, limit, corsHeaders, sameOrigin, clientKey, env, fetch, now, log };

  const selected = selectConnections(env);
  const connections = createConnections(selected.provider === 'zernio' ? make.zernio(base) : nullConnections);
  const nango = has(env, 'NANGO_SECRET_KEY') ? make.nango(base) : nullNango;
  const treg = make.treg({ env, fetch, now, db: database, log });
  const deps = { ...base, connections, nango, treg };

  const modules = {
    connections: make.connectionRoutes(deps),
    nango: make.nangoRoutes(deps),
    posting: make.posting(deps),
    publicMedia: make.publicMedia(deps),
    analytics: make.analytics(deps),
    seoGoogle: make.seoGoogle(deps),
    billing: make.billing(deps),
  };
  const sitemap = make.sitemap(deps);
  // a post.* webhook from Zernio finishes its job (sent / failed) the same way "Check again" does
  connections.impl?.setPostListener?.((userId, jobId, outcome) => modules.posting.posting?.fromWebhook?.(userId, jobId, outcome));
  // account deletion: the vendor's connections go first (while their ids are still known), then the rest
  const FORGET_ORDER = ['posting', 'analytics', 'seoGoogle', 'billing', 'publicMedia', 'nango', 'connections'];

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
    /** for tests and the startup notes */
    connectionsProvider: selected.provider,

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
    appHostExtras: (req, res, url) => sitemap.handle(req, res, url),

    /**
     * Before an account is deleted: the connections at the vendor first (Nango deletes each, one attempt), then
     * the stored connection doc, then posting, analytics, SEO and billing. A module that throws stops the
     * deletion (the caller lifts the others with unforgetUser).
     */
    async forgetUser(userId) {
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

    /** What to print at startup: what's on and which Secrets are missing, by name only. */
    notes() {
      const lines = [];
      if (selected.provider === 'zernio') {
        lines.push('Connected accounts (social and ads): on (Zernio).');
        const missing = ['ZERNIO_WEBHOOK_SECRET', 'CUSTOMER_TAG_SECRET'].filter((n) => !has(env, n));
        if (missing.length) lines.push(`Connected accounts also need these Replit Secrets: ${missing.join(', ')}.`);
      } else if (selected.reason === 'off') {
        lines.push('Connected accounts: off (CONNECTIONS_PROVIDER=off). Customers post themselves and mark posts as posted.');
      } else if (selected.reason === 'unknown_provider') {
        lines.push('Connected accounts: off (CONNECTIONS_PROVIDER isn’t "zernio" or "off"). Customers post themselves and mark posts as posted.');
      } else {
        lines.push('Connected accounts: off. Customers post themselves and mark posts as posted (add ZERNIO_API_KEY and ZERNIO_WEBHOOK_SECRET in Replit Secrets to turn them on).');
      }
      lines.push(nango.enabled ? `Other integrations (Nango): on, ${Object.keys(nango.integrations ?? {}).length} listed.` : 'Other integrations (Nango): off (kept for future booking tools and CRMs; add NANGO_SECRET_KEY to turn on).');
      const t = treg.health?.() ?? { setUp: false, billingSetUp: false };
      lines.push(t.setUp ? 'Analytics data (treg): on.' : 'Analytics data (treg): off (add the TREG_TOKEN Secret).');
      if (!t.billingSetUp) lines.push('Per-customer caps and the treg check: add TREG_ADMIN_TOKEN and TREG_ORG_ID in Replit Secrets.');
      if (!has(env, 'CUSTOMER_TAG_SECRET')) lines.push('Usage tracking per customer needs the CUSTOMER_TAG_SECRET Secret (32+ random bytes; never change it).');
      if (database.enabled) lines.push(`Integrations need ${INTEGRATIONS_MIGRATION} and supabase/migrations/20261106000000_zernio.sql in Supabase.`);
      return lines;
    },
  };
}
