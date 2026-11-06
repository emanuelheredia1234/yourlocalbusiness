// Other integrations through Nango (future booking tools and CRMs; never social or ads), server/nango.mjs:
//   GET    /api/integrations/nango                 {enabled, setUp, integrations: [{key, label, category, state, …}], hint? (admins)}
//   POST   /api/integrations/nango/:key/connect    {connectLink, expiresAt}
//   DELETE /api/integrations/nango/:key            {ok: true}
//   POST   /api/webhooks/nango                     no sameOrigin, no bearer: the raw body (64 KB) and its HMAC
//
// Off (NANGO_SECRET_KEY unset): the list answers {enabled: false, integrations: []}, so the app shows nothing,
// everything else 503 NOT_SET_UP, and the webhook 503 without reading the body.

import { errorBody, fail } from '../integrations/common.mjs';

export const NANGO_PREFIX = '/api/integrations/nango';
export const NANGO_WEBHOOK_PATH = '/api/webhooks/nango';
const WEBHOOK_LIMIT = 65_536;
const NO_STORE = { 'cache-control': 'no-store' };

export function createNangoRoutes(deps = {}) {
  const { auth, nango, send, sameOrigin = () => true, rateLimited = () => false, limit = () => false, corsHeaders = () => ({}), readRaw, clientKey = (req) => req.socket?.remoteAddress || 'unknown' } = deps;
  const reply = (req, res, status, body, headers = {}) => send(res, status, body, { ...corsHeaders(req), ...NO_STORE, ...headers });

  async function webhook(req, res) {
    if (req.method !== 'POST') return reply(req, res, 405, { error: 'Method not allowed.', code: 'BAD_REQUEST' }, { allow: 'POST' });
    if (!nango?.enabled) return reply(req, res, 503, { error: 'Not set up.', code: 'NOT_SET_UP' });
    if (limit('nango-webhook', clientKey(req))) return reply(req, res, 429, { error: 'Too many requests.', code: 'RATE_LIMITED' });
    if (Number(req.headers['content-length']) > WEBHOOK_LIMIT) {
      reply(req, res, 413, { error: 'Request too large.', code: 'BAD_REQUEST' }, { connection: 'close' });
      req.resume();
      return;
    }
    let raw;
    try {
      raw = await readRaw(req, WEBHOOK_LIMIT);
    } catch (e) {
      return reply(req, res, e?.status === 413 ? 413 : 400, { error: 'Bad request.', code: 'BAD_REQUEST' });
    }
    let result;
    try {
      result = await nango.webhook(raw, req.headers);
    } catch {
      result = { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    reply(req, res, result.status, result.body);
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (path === NANGO_WEBHOOK_PATH || path.startsWith(`${NANGO_WEBHOOK_PATH}/`)) {
      if (path !== NANGO_WEBHOOK_PATH) reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
      else await webhook(req, res);
      return true;
    }
    if (path !== NANGO_PREFIX && !path.startsWith(`${NANGO_PREFIX}/`)) return false;
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
      if (path === NANGO_PREFIX) {
        if (req.method !== 'GET') throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
        if (!nango?.enabled) {
          reply(req, res, 200, { enabled: false, setUp: false, integrations: [] });
          return true;
        }
        reply(req, res, 200, { enabled: true, setUp: nango.setUp === true, integrations: await nango.list(who.id), ...(who.isAdmin === true && nango.hint ? { hint: nango.hint } : {}) });
        return true;
      }
      const m = /^\/api\/integrations\/nango\/([a-z][a-z0-9_]{1,30})(?:\/(connect))?$/.exec(path);
      if (!m) throw fail(404, 'NOT_FOUND', 'Not found.');
      if (!nango?.enabled) throw fail(503, 'NOT_SET_UP', 'This integration isn’t available yet.');
      const [, key, action = ''] = m;
      if (req.method === 'POST' && action === 'connect') {
        if (limit('integrations-connect', who.id)) throw fail(429, 'RATE_LIMITED', 'Too many connect attempts. Try again later.');
        const link = await nango.connectLink(who.id, key);
        reply(req, res, 200, { connectLink: link.connectLink, expiresAt: link.expiresAt });
        return true;
      }
      if (req.method === 'DELETE' && !action) {
        await nango.disconnect(who.id, key);
        reply(req, res, 200, { ok: true });
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
    async forgetUser(userId) {
      await nango?.forgetUser?.(userId);
    },
    async unforgetUser(userId) {
      await nango?.unforgetUser?.(userId);
    },
    async userDeleted() {},
  };
}
