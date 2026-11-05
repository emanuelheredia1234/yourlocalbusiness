// The connected-accounts routes (spec §1.1):
//   GET    /api/integrations/connections                       {connections, available, setUp, hint? (admins)}
//   POST   /api/integrations/connections/:platform/connect     {connectLink, expiresAt}
//   POST   /api/integrations/connections/:platform/reconnect   same
//   POST   /api/integrations/connections/:platform/check       {connection}
//   DELETE /api/integrations/connections/:platform             {ok: true}
//   GET    /api/integrations/connections/:platform/targets     {targets}
//   PUT    /api/integrations/connections/:platform/target      {connection}   body {targetId}
//   POST   /api/webhooks/nango   no sameOrigin, no bearer: the raw body (readRaw, 64 KB) and its HMAC
//
// Every route but the webhook: sameOrigin, then a signed-in user (auth.identify), then a rate-limit bucket.
// The user is always the server's (a user id in a body is never read). Answers are {error, code}, never a
// provider's or Nango's text. While connecting is off (no NANGO_SECRET_KEY) the list reads "Not connected"
// everywhere, everything else answers 503 CONNECTIONS_NOT_ENABLED, and the webhook 503 without reading the body.

import { PHASE1_PLATFORMS, PLATFORMS } from '../integrations/contracts.mjs';
import { errorBody, fail, safeLog } from '../integrations/common.mjs';
import { nangoFor } from '../nango.mjs';

export const CONNECTIONS_PREFIX = '/api/integrations/connections';
export const NANGO_WEBHOOK_PATH = '/api/webhooks/nango';
const WEBHOOK_LIMIT = 65_536;
const NO_STORE = { 'cache-control': 'no-store' };

/**
 * deps: the integration deps (server/integrations/wiring.mjs). nango: the implementation answering the webhook
 * (default: the one wiring built for the same storage, found with nangoFor).
 */
export function createConnectionRoutes(deps = {}) {
  const { auth, connections, send, sameOrigin = () => true, rateLimited = () => false, limit = () => false, corsHeaders = () => ({}), readRaw, readJson, clientKey = (req) => req.socket?.remoteAddress || 'unknown', log = console } = deps;
  const nango = deps.nango ?? (connections?.enabled ? nangoFor(deps) : null);
  const reply = (req, res, status, body, headers = {}) => send(res, status, body, { ...corsHeaders(req), ...NO_STORE, ...headers });

  async function webhook(req, res) {
    if (req.method !== 'POST') {
      reply(req, res, 405, { error: 'Method not allowed.', code: 'BAD_REQUEST' }, { allow: 'POST' });
      return true;
    }
    if (!nango || typeof nango.webhook !== 'function') {
      reply(req, res, 503, { error: 'Not set up.', code: 'NOT_SET_UP' });
      return true;
    }
    if (limit('nango-webhook', clientKey(req))) {
      reply(req, res, 429, { error: 'Too many requests.', code: 'RATE_LIMITED' });
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
      result = await nango.webhook(raw, req.headers);
    } catch {
      result = { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' }, after: null };
    }
    reply(req, res, result.status, result.body);
    // the accounts are read after the reply (Nango waits 20 s at most)
    result.after?.catch?.(() => safeLog('nango_after_failed', {}, log));
    return true;
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (path === NANGO_WEBHOOK_PATH || path.startsWith(`${NANGO_WEBHOOK_PATH}/`)) {
      if (path !== NANGO_WEBHOOK_PATH) {
        reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
        return true;
      }
      return webhook(req, res);
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
      if (path === CONNECTIONS_PREFIX) {
        if (req.method !== 'GET') throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
        const list = await connections.status(who.id);
        reply(req, res, 200, {
          connections: list,
          available: connections.enabled ? [...PHASE1_PLATFORMS] : [],
          setUp: connections.setUp === true,
          ...(who.isAdmin === true && connections.setUp !== true && connections.hint ? { hint: connections.hint } : {}),
        });
        return true;
      }
      const m = /^\/api\/integrations\/connections\/([a-z_]+)(?:\/(connect|reconnect|check|targets|target))?$/.exec(path);
      if (!m || !PLATFORMS.includes(m[1])) throw fail(404, 'NOT_FOUND', 'Not found.');
      const [, platform, action = ''] = m;
      if (!connections.enabled) throw fail(503, 'CONNECTIONS_NOT_ENABLED', 'Connecting accounts is coming soon. You can still post yourself and mark posts as posted.');
      const route = `${req.method} ${action}`;
      if (route === 'POST connect' || route === 'POST reconnect') {
        // the request body is never read: who connects is the signed-in user, nothing else
        if (limit('integrations-connect', who.id)) throw fail(429, 'RATE_LIMITED', 'Too many connect attempts. Try again later.');
        const link = action === 'connect' ? await connections.connectLink(who.id, platform) : await connections.reconnectLink(who.id, platform);
        reply(req, res, 200, { connectLink: link.connectLink, expiresAt: link.expiresAt });
        return true;
      }
      if (route === 'POST check') {
        reply(req, res, 200, { connection: await connections.check(who.id, platform) });
        return true;
      }
      if (route === 'DELETE ') {
        await connections.disconnect(who.id, platform);
        reply(req, res, 200, { ok: true });
        return true;
      }
      if (route === 'GET targets') {
        reply(req, res, 200, { targets: await connections.targets(who.id, platform) });
        return true;
      }
      if (route === 'PUT target') {
        let body = null;
        try {
          body = await readJson(req);
        } catch {
          throw fail(400, 'BAD_REQUEST', 'Bad request.');
        }
        const targetId = typeof body?.targetId === 'string' ? body.targetId : '';
        if (!targetId || targetId.length > 100) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed accounts.');
        reply(req, res, 200, { connection: await connections.setTarget(who.id, platform, targetId) });
        return true;
      }
      throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
    } catch (e) {
      const { status, body } = errorBody(e, who);
      reply(req, res, status, body);
      return true;
    }
  }

  return {
    handle,
    async forgetUser() {},
    async unforgetUser() {},
    async userDeleted() {},
    /** The monthly connection-cost rows, on start and once a day. */
    async onStart() {
      if (!nango?.meterIfDue) return;
      const run = () => nango.meterIfDue().catch(() => safeLog('nango_meter_failed', {}, log));
      void run();
      const t = setInterval(run, 24 * 3_600_000);
      t.unref?.();
    },
  };
}
