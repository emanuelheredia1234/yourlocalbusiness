// The checks every analytics and "Submit to Google" route makes, in the order the integration routes use:
// the app's own page (sameOrigin), then a signed-in user (auth.identify), then the route's rate limit. Errors go
// out as { error, code } (plus the owner's hint for an admin), never with a provider's or the database's text.

import { errorBody, fail } from '../integrations/common.mjs';

/** A DbError (server/integrations/db.mjs) as a route error: our words, and the migration name for the owner. */
export function fromDbError(e) {
  if (e?.name !== 'DbError') return e;
  if (e.code === 'NOT_SET_UP') return fail(503, 'NOT_SET_UP', 'This isn’t set up on this app yet.', {}, String(e.message || ''));
  if (e.code === 'CONFLICT') return fail(409, 'UNAVAILABLE', 'That changed in another request. Try again.');
  return fail(503, 'UNAVAILABLE', 'Something went wrong. Try again shortly.');
}

export function createKit({ auth, send, readJson, sameOrigin = () => true, corsHeaders = () => ({}), rateLimited = () => false, limit = () => false }) {
  const reply = (req, res, status, body) => send(res, status, body, corsHeaders(req));
  return {
    reply,
    /** The signed-in user, or null after answering (403 cross-site, 401 not signed in, 503 sign-in unavailable). */
    async user(req, res) {
      if (!sameOrigin(req)) {
        reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
        return null;
      }
      if (!auth?.enabled) {
        reply(req, res, 503, { error: 'Sign-in isn’t set up on this app.', code: 'NOT_SET_UP' });
        return null;
      }
      let who = null;
      try {
        who = await auth.identify(req);
      } catch {
        reply(req, res, 503, { error: 'Couldn’t check your sign-in. Try again shortly.', code: 'UNAVAILABLE' });
        return null;
      }
      if (!who?.id) {
        reply(req, res, 401, { error: 'Sign in first.', code: 'AUTH_REQUIRED' });
        return null;
      }
      return who;
    },
    /** Over a limit: answered with 429 here (true). bucket: a createBucketLimiter bucket, or a per-minute key. */
    limited(req, res, { bucket, key, factor = 1 }, who) {
      const over = bucket ? limit(bucket, who) : rateLimited(key, factor);
      if (over) reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED' });
      return over;
    },
    /** The JSON body (a bad or too-large body is a 400 / 413 IntegrationError). */
    async body(req, max = 16 * 1024) {
      try {
        const b = await readJson(req, max);
        return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
      } catch (e) {
        throw e?.status === 413 ? fail(413, 'BAD_REQUEST', 'Request too large.') : fail(400, 'BAD_REQUEST', 'That request isn’t valid JSON.');
      }
    },
    /** Answer an error (ours as it is, a DbError in our words, anything else a plain 500). */
    failWith(req, res, e, who) {
      const { status, body } = errorBody(fromDbError(e), who);
      if (!res.headersSent) reply(req, res, status, body);
      return true;
    },
  };
}
