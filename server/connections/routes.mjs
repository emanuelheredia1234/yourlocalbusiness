// The connected-accounts routes (WP1 builds them out):
//   GET    /api/integrations/connections                       {connections, available, setUp, hint? (admins)}
//   POST   /api/integrations/connections/:platform/connect     {connectLink, expiresAt}
//   POST   /api/integrations/connections/:platform/reconnect   same
//   POST   /api/integrations/connections/:platform/check       {connection}
//   DELETE /api/integrations/connections/:platform             {ok: true}
//   GET    /api/integrations/connections/:platform/targets     {targets}
//   PUT    /api/integrations/connections/:platform/target      {connection}
//   POST   /api/webhooks/nango   no sameOrigin, no bearer: the raw body (readRaw, 64 KB) and its HMAC
//
// Already here: the list (every account "Not connected" while connecting is off, so the app can show it) and,
// for the rest, 503 CONNECTIONS_NOT_ENABLED while it's off, else NOT_SET_UP. The webhook answers 503 without
// reading the body.

import { PHASE1_PLATFORMS } from '../integrations/contracts.mjs';
import { errorBody } from '../integrations/common.mjs';

export const CONNECTIONS_PREFIX = '/api/integrations/connections';
export const NANGO_WEBHOOK_PATH = '/api/webhooks/nango';

export function createConnectionRoutes({ auth, connections, send, sameOrigin = () => true, rateLimited = () => false, corsHeaders = () => ({}) } = {}) {
  const reply = (req, res, status, body) => send(res, status, body, corsHeaders(req));

  async function handle(req, res, url) {
    const path = url.pathname;
    if (path === NANGO_WEBHOOK_PATH || path.startsWith(`${NANGO_WEBHOOK_PATH}/`)) {
      reply(req, res, 503, { error: 'Not set up.', code: 'NOT_SET_UP' });
      return true;
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
      if (path === CONNECTIONS_PREFIX && req.method === 'GET') {
        const list = await connections.status(who.id);
        reply(req, res, 200, {
          connections: list,
          available: connections.enabled ? [...PHASE1_PLATFORMS] : [],
          setUp: connections.setUp === true,
          ...(who.isAdmin === true && connections.setUp !== true && connections.hint ? { hint: connections.hint } : {}),
        });
        return true;
      }
      if (!connections.enabled) reply(req, res, 503, { error: 'Connecting accounts is coming soon. You can still post yourself and mark posts as posted.', code: 'CONNECTIONS_NOT_ENABLED' });
      else reply(req, res, 503, { error: 'Connecting accounts isn’t available yet.', code: 'NOT_SET_UP' });
      return true;
    } catch (e) {
      const { status, body } = errorBody(e, who);
      reply(req, res, status, body);
      return true;
    }
  }

  return { handle, async forgetUser() {}, async unforgetUser() {}, async userDeleted() {}, async onStart() {} };
}
