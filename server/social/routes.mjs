// Posting from the app (WP2 builds this): POST /api/posting/publish, GET /api/posting/jobs/:jobId,
// POST /api/posting/jobs/:jobId/check, GET /api/posting/jobs?projectId=. One attempt per post; an uncertain
// outcome is 'unknown' and is only ever checked with a read when the user presses "Check again".
//
// Placeholder until then: every route answers 503 NOT_SET_UP. The factory's deps are the integration deps
// (server/integrations/wiring.mjs): {auth, storage, db, connections, send, readJson, rateLimited, limit,
// corsHeaders, sameOrigin, clientKey, env, fetch, now, log}. onStart: the sweep that turns `sending` jobs older
// than 180 s into `unknown`.

import { stubRoutes } from '../integrations/common.mjs';

export function createPostingRoutes({ send, corsHeaders } = {}) {
  return stubRoutes({ prefixes: '/api/posting/', send, corsHeaders, message: 'Posting from the app isn’t available yet. Post it yourself, then mark it as posted.' });
}
