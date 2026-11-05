// GET /api/media/public/<token> (WP2 builds this): a short-lived, MAC'd link to one of a user's media files,
// for networks that fetch the image or video themselves (Instagram, Facebook photos, TikTok PULL_FROM_URL).
// No sign-in and no same-origin check: the token is the permission. The path is never logged as it is
// (server/integrations/common.mjs redactPath).
//
// Placeholder until then: 503 NOT_SET_UP, and the token isn't read.

import { stubRoutes } from '../integrations/common.mjs';

export function createPublicMediaRoutes({ send, corsHeaders } = {}) {
  return stubRoutes({ prefixes: '/api/media/public/', send, corsHeaders });
}
