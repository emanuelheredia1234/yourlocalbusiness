// The connected-accounts routes (social networks through Upload-Post, ad accounts through Zernio):
//   GET    /api/integrations/connections[?projectId=]               {connections, available, setUp, setUpSocial,
//                                                                    setUpAds, provider: {social, ads}, xLinks,
//                                                                    slots? ({used, cap, projects}: the user's
//                                                                    businesses with social accounts, of their limit),
//                                                                    hint? (admins: a Secret still missing)}
//   DELETE /api/integrations/connections?projectId=[&gone=1]       {ok, freed}  a business was deleted: its social
//                                                                    profile goes, with every account in it (60 an
//                                                                    hour; gone=1: 409 while the business is saved)
//   POST   /api/integrations/connections/:platform/connect          {connectLink, expiresAt} | {alreadyConnected: true}
//                                                                    body {projectId?}: the business that connects it
//   POST   /api/integrations/connections/:platform/reconnect        same
//   POST   /api/integrations/connections/:platform/check            {connection}   body {projectId?}
//   DELETE /api/integrations/connections/:platform[?projectId=][&ackLiveAds=1]   {ok: true} | 409 ADS_LIVE {live}
//                                                                    (Meta ads / Google Ads while a campaign launched
//                                                                    from the app is on: after disconnecting the app
//                                                                    can't pause it, so the customer acknowledges it)
//   GET    /api/integrations/connections/:platform/targets[?projectId=]  {targets}
//   PUT    /api/integrations/connections/:platform/target           {connection}   body {targetId, projectId?}
//   POST   /api/webhooks/upload-post   no sameOrigin, no bearer: the raw body (readRaw, 256 KB), its HMAC over
//                                       "<timestamp>.<body>" and a 300 s window (social accounts, upload_completed)
//   POST   /api/webhooks/zernio        same, Zernio's HMAC (ad accounts)
//
// Every route but the webhook: sameOrigin, then a signed-in user (auth.identify), then a rate-limit bucket. The
// user is always the server's (a user id in a body is never read); a projectId only picks which of that user's own
// businesses (each has its own social accounts), never anyone else's. Answers are {error, code}, never Upload-Post's, Zernio's or a network's text. A side
// that is off (no UPLOAD_POST_API_KEY for social, no ZERNIO_API_KEY for ads) lists "Not connected" for its
// platforms, refuses the rest with 503 CONNECTIONS_NOT_ENABLED, and its webhook answers 503 without reading the body.

import { AD_PLATFORMS, PHASE2_PLATFORMS, PLATFORMS } from '../integrations/contracts.mjs';
import { errorBody, fail } from '../integrations/common.mjs';

export const CONNECTIONS_PREFIX = '/api/integrations/connections';
export const ZERNIO_WEBHOOK_PATH = '/api/webhooks/zernio';
export const UPLOAD_POST_WEBHOOK_PATH = '/api/webhooks/upload-post';
const WEBHOOK_LIMIT = 262_144;
const NO_STORE = { 'cache-control': 'no-store' };
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

/** deps: the integration deps (server/integrations/wiring.mjs). connections.impl's sides answer the webhooks. */
export function createConnectionRoutes(deps = {}) {
  const { auth, connections, liveAdsGuard = null, send, sameOrigin = () => true, rateLimited = () => false, limit = () => false, corsHeaders = () => ({}), readRaw, readJson, clientKey = (req) => req.socket?.remoteAddress || 'unknown' } = deps;
  const impl = connections?.enabled ? connections.impl : null;
  // the webhooks: Upload-Post's goes to the social side, Zernio's to the ads side (or a plain Zernio impl)
  const socialImpl = connections?.socialEnabled ? (impl?.social ?? null) : null;
  const adsImpl = connections?.adsEnabled ? (impl?.ads ?? (impl && !('social' in impl) ? impl : null)) : null;
  const reply = (req, res, status, body, headers = {}) => send(res, status, body, { ...corsHeaders(req), ...NO_STORE, ...headers });

  async function webhook(req, res, target, bucket) {
    if (req.method !== 'POST') {
      reply(req, res, 405, { error: 'Method not allowed.', code: 'BAD_REQUEST' }, { allow: 'POST' });
      return true;
    }
    if (!target || typeof target.webhook !== 'function') {
      reply(req, res, 503, { error: 'Not set up.', code: 'NOT_SET_UP' });
      return true;
    }
    if (limit(bucket, clientKey(req))) {
      reply(req, res, 429, { error: 'Too many requests.', code: 'RATE_LIMITED' });
      return true;
    }
    if (Number(req.headers['content-length']) > WEBHOOK_LIMIT) {
      reply(req, res, 413, { error: 'Request too large.', code: 'BAD_REQUEST' }, { connection: 'close' });
      req.resume();
      return true;
    }
    let raw;
    try {
      raw = await readRaw(req, WEBHOOK_LIMIT);
    } catch (e) {
      reply(req, res, e?.status === 413 ? 413 : 400, { error: 'Bad request.', code: 'BAD_REQUEST' });
      return true;
    }
    let result;
    try {
      result = await target.webhook(raw, req.headers);
    } catch {
      result = { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    reply(req, res, result.status, result.body);
    return true;
  }

  async function body(req) {
    try {
      const b = await readJson(req);
      return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    } catch {
      throw fail(400, 'BAD_REQUEST', 'Bad request.');
    }
  }

  const projectFrom = (v) => (typeof v === 'string' && PROJECT_ID.test(v) && !RESERVED_KEYS.includes(v) ? v : undefined);

  async function handle(req, res, url) {
    const path = url.pathname;
    for (const [hookPath, target, bucket] of [
      [ZERNIO_WEBHOOK_PATH, adsImpl, 'zernio-webhook'],
      [UPLOAD_POST_WEBHOOK_PATH, socialImpl, 'upload-post-webhook'],
    ]) {
      if (path !== hookPath && !path.startsWith(`${hookPath}/`)) continue;
      if (path !== hookPath) {
        reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
        return true;
      }
      return webhook(req, res, target, bucket);
    }
    if (path !== CONNECTIONS_PREFIX && !path.startsWith(`${CONNECTIONS_PREFIX}/`)) return false;
    if (!sameOrigin(req)) {
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return true;
    }
    let who = null;
    try {
      who = auth?.enabled ? await auth.identify(req) : null;
    } catch {
      reply(req, res, 503, { error: 'Could not verify your sign-in. Try again shortly.', code: 'UNAVAILABLE' });
      return true;
    }
    if (!who?.id) {
      reply(req, res, 401, { error: 'Sign in first.', code: 'AUTH_REQUIRED' });
      return true;
    }
    if (rateLimited(`integrations-read:user:${who.id}`, 3)) {
      reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED' });
      return true;
    }
    try {
      if (path === CONNECTIONS_PREFIX && req.method === 'DELETE') {
        // a business was deleted in the app: its social profile (and every account in it) goes, its slot comes back
        const projectId = projectFrom(url.searchParams.get('projectId'));
        if (!projectId) throw fail(400, 'BAD_REQUEST', 'Which business?');
        if (limit('integrations-release', who.id)) throw fail(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
        // ?gone=1: "Free it" for a slot the app thinks a deleted business holds (refused while the business is saved)
        const onlyIfGone = url.searchParams.get('gone') === '1';
        const out = connections.socialEnabled ? await connections.forgetProject(who.id, projectId, { onlyIfGone }) : { freed: false };
        reply(req, res, 200, { ok: true, freed: out?.freed === true });
        return true;
      }
      if (path === CONNECTIONS_PREFIX) {
        if (req.method !== 'GET') throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
        const list = await connections.status(who.id, { projectId: projectFrom(url.searchParams.get('projectId')) });
        const on = (p) => (AD_PLATFORMS.includes(p) ? connections.adsEnabled : connections.socialEnabled);
        // how many of the user's businesses have social accounts, of their limit (each business has its own)
        const slots = connections.socialEnabled && connections.setUpSocial ? await connections.slots(who.id).catch(() => null) : null;
        reply(req, res, 200, {
          connections: list,
          available: connections.enabled ? PLATFORMS.filter((p) => !PHASE2_PLATFORMS.includes(p) && on(p)) : [],
          setUp: connections.setUp === true,
          setUpSocial: connections.setUpSocial === true,
          setUpAds: connections.setUpAds === true,
          provider: { social: connections.socialEnabled ? 'upload_post' : null, ads: connections.adsEnabled ? 'zernio' : null },
          // whether links stay in X posts (the X Links add-on); without it Upload-Post takes them out
          xLinks: connections.xLinks === true,
          ...(slots && Number.isFinite(slots.used) && Number.isFinite(slots.cap) ? { slots: { used: slots.used, cap: slots.cap, projects: Array.isArray(slots.projects) ? slots.projects : [], orphans: Array.isArray(slots.orphans) ? slots.orphans : [] } } : {}),
          // the owner reads which Secret a side still needs (names only), whichever side it is, set up or not
          ...(who.isAdmin === true && connections.hint ? { hint: connections.hint } : {}),
        });
        return true;
      }
      const m = /^\/api\/integrations\/connections\/([a-z_]+)(?:\/(connect|reconnect|check|targets|target))?$/.exec(path);
      if (!m || !PLATFORMS.includes(m[1])) throw fail(404, 'NOT_FOUND', 'Not found.');
      const [, platform, action = ''] = m;
      if (!connections.enabled || !(AD_PLATFORMS.includes(platform) ? connections.adsEnabled : connections.socialEnabled)) throw fail(503, 'CONNECTIONS_NOT_ENABLED', 'Connecting accounts is coming soon. You can still post yourself and mark posts as posted.');
      const route = `${req.method} ${action}`;
      if (route === 'POST connect' || route === 'POST reconnect') {
        // only the business id is read from the body: who connects is the signed-in user, nothing else
        const projectId = projectFrom((await body(req)).projectId);
        if (limit('integrations-connect', who.id)) throw fail(429, 'RATE_LIMITED', 'Too many connect attempts. Try again later.');
        const link = action === 'connect' ? await connections.connectLink(who.id, platform, { projectId }) : await connections.reconnectLink(who.id, platform, { projectId });
        reply(req, res, 200, link.alreadyConnected ? { alreadyConnected: true } : { connectLink: link.connectLink, expiresAt: link.expiresAt });
        return true;
      }
      if (route === 'POST check') {
        const projectId = projectFrom((await body(req)).projectId);
        reply(req, res, 200, { connection: await connections.check(who.id, platform, { projectId }) });
        return true;
      }
      if (route === 'DELETE ') {
        // R12: never lose the way to pause a launched campaign without saying so (server/ads/ liveOn)
        if ((platform === 'meta_ads' || platform === 'google_ads') && typeof liveAdsGuard === 'function' && url.searchParams.get('ackLiveAds') !== '1') {
          const live = await liveAdsGuard(who.id, platform);
          if (Array.isArray(live) && live.length) throw fail(409, 'ADS_LIVE', 'These campaigns are still on. After disconnecting, the app can’t pause them: they keep running until you pause them in Ads Manager.', { live });
        }
        await connections.disconnect(who.id, platform, { projectId: projectFrom(url.searchParams.get('projectId')) });
        reply(req, res, 200, { ok: true });
        return true;
      }
      if (route === 'GET targets') {
        reply(req, res, 200, { targets: await connections.targets(who.id, platform, { projectId: projectFrom(url.searchParams.get('projectId')) }) });
        return true;
      }
      if (route === 'PUT target') {
        const b = await body(req);
        const targetId = typeof b.targetId === 'string' ? b.targetId : '';
        if (!targetId || targetId.length > 100) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed accounts.');
        reply(req, res, 200, { connection: await connections.setTarget(who.id, platform, targetId, { projectId: projectFrom(b.projectId) }) });
        return true;
      }
      throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
    } catch (e) {
      const { status, body: out } = errorBody(e, who);
      reply(req, res, status, out);
      return true;
    }
  }

  return {
    handle,
    async forgetUser() {},
    async unforgetUser() {},
    /** After the account is gone: its Upload-Post profile (and every social account in it) is deleted now. */
    async userDeleted(userId) {
      await socialImpl?.userDeleted?.(userId);
    },
    /**
     * server/cron: the monthly estimated rows per customer (Upload-Post and Zernio) and Upload-Post's daily
     * reconcile, once a day from the cron tick. Each also keeps its own app_state claim (per month / per UTC day).
     */
    cronJobs() {
      const jobs = [];
      if (typeof socialImpl?.meterIfDue === 'function') jobs.push({ name: 'uploadpost-meter', dailyAtUtc: '02:10', run: () => socialImpl.meterIfDue() });
      if (typeof socialImpl?.reconcileIfDue === 'function') jobs.push({ name: 'uploadpost-reconcile', dailyAtUtc: '03:10', run: () => socialImpl.reconcileIfDue() });
      if (typeof adsImpl?.meterIfDue === 'function') jobs.push({ name: 'zernio-meter', dailyAtUtc: '02:20', run: () => adsImpl.meterIfDue() });
      return jobs;
    },
  };
}
