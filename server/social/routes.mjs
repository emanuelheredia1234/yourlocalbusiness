// Posting from the app (spec §1.1, §1.7):
//   POST /api/posting/publish            PublishRequest → {job}    (the job is `sending`; the app polls it)
//   GET  /api/posting/jobs/:jobId        → {job}                   a database read only, never a network call
//   POST /api/posting/jobs/:jobId/check  {} → {job}                "Check again" on an `unknown` job: one read of
//                                                                  the post's status at Upload-Post (by the job
//                                                                  id), at most once per 30 s per job; never resends
//   GET  /api/posting/jobs?projectId=    → {jobs}                  the business's last 200
// Checks in order: the app's own page (sameOrigin), a signed-in user, the route's rate limit. Every query names
// the signed-in user; someone else's project, post or job answers 404.
// One attempt per post: an uncertain outcome is `unknown` and is only ever checked with a read, when the user
// presses "Check again". onStart: jobs a restart left `sending` become `unknown`.
//
// Deps (server/integrations/wiring.mjs): {auth, db, connections, send, readJson, rateLimited, limit, corsHeaders,
// sameOrigin, env, fetch, now, log}; tests may add mediaStore.

import { errorBody, fail } from '../integrations/common.mjs';
import { createPosting } from './publish.mjs';

const PREFIX = '/api/posting/';

/** A DbError (server/integrations/db.mjs) in our words, with the migration for the owner. */
function fromDbError(e) {
  if (e?.name !== 'DbError') return e;
  if (e.code === 'NOT_SET_UP') return fail(503, 'NOT_SET_UP', 'Posting from the app isn’t set up yet. Post it yourself for now.', {}, String(e.message || ''));
  return fail(503, 'UNAVAILABLE', 'Something went wrong. Try again shortly.');
}

export function createPostingRoutes(deps = {}) {
  const { auth, db, connections, send, readJson, sameOrigin = () => true, corsHeaders = () => ({}), limit = () => false, env = process.env, fetch = globalThis.fetch, now = () => Date.now(), log = console } = deps;
  const posting = createPosting({ db, connections, env, fetch, now, log, mediaStore: deps.mediaStore });
  const reply = (req, res, status, body) => send(res, status, body, corsHeaders(req));

  async function user(req, res) {
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
  }

  const limited = (bucket, who) => {
    if (limit(bucket, who)) throw fail(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');
  };

  async function body(req) {
    try {
      const b = await readJson(req, 32 * 1024);
      return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    } catch (e) {
      throw e?.status === 413 ? fail(413, 'BAD_REQUEST', 'Request too large.') : fail(400, 'BAD_REQUEST', 'That request isn’t valid JSON.');
    }
  }

  async function route(req, res, url, who) {
    const p = url.pathname;
    if (!db?.enabled) throw fail(503, 'NOT_SET_UP', 'Posting from the app isn’t set up yet. Post it yourself for now.', {}, 'Supabase isn’t set up on this server (SUPABASE_URL and SUPABASE_SECRET_KEY).');
    // no social accounts (UPLOAD_POST_API_KEY unset): nothing can be posted from the app, and no job exists
    if (!connections?.socialEnabled) throw fail(503, 'NOT_SET_UP', 'Posting from the app isn’t switched on yet. Post it yourself, then mark it as posted.', {}, 'Posting is off: add UPLOAD_POST_API_KEY (and UPLOAD_POST_WEBHOOK_SECRET, MEDIA_URL_SECRET) in Replit Secrets.');
    if (p === `${PREFIX}publish` && req.method === 'POST') {
      limited('posting-publish', who.id);
      const out = await posting.publish(who, await body(req));
      return reply(req, res, 200, out);
    }
    if (p === `${PREFIX}jobs` && req.method === 'GET') {
      return reply(req, res, 200, await posting.list(who, url.searchParams.get('projectId')));
    }
    let m = /^\/api\/posting\/jobs\/([^/]+)$/.exec(p);
    if (m && req.method === 'GET') return reply(req, res, 200, await posting.job(who, decodeURIComponent(m[1])));
    m = /^\/api\/posting\/jobs\/([^/]+)\/check$/.exec(p);
    if (m && req.method === 'POST') {
      limited('posting-check', who.id);
      return reply(req, res, 200, await posting.check(who, decodeURIComponent(m[1])));
    }
    throw fail(404, 'NOT_FOUND', 'Not found.');
  }

  return {
    posting,
    async handle(req, res, url) {
      if (!url.pathname.startsWith(PREFIX)) return false;
      const who = await user(req, res);
      if (!who) return true;
      try {
        await route(req, res, url, who);
      } catch (e) {
        const { status, body: out } = errorBody(fromDbError(e), who);
        if (!res.headersSent) reply(req, res, status, out);
      }
      return true;
    },
    /** Startup: jobs a restart left `sending` (older than 11 minutes) become `unknown`, never re-sent. */
    async onStart() {
      if (db?.enabled) await posting.sweepAll();
    },
    // jobs go with the account (on delete cascade); nothing is held anywhere else
    async forgetUser() {},
    async unforgetUser() {},
    async userDeleted() {},
  };
}
