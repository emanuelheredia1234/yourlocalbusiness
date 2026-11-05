// "Publish my SEO page to Google" (WP4 builds this): POST /api/seo/google/publish {projectId, confirm:true} and
// GET /api/seo/google/status?projectId=. App-host pages go through treg's Search Console connection; pages on
// a custom domain through the user's own connected Search Console. Every step is one-shot.
//
// Placeholder until then: every route answers 503 NOT_SET_UP.

import { stubRoutes } from '../integrations/common.mjs';

export function createSeoGoogleRoutes({ send, corsHeaders } = {}) {
  return stubRoutes({ prefixes: '/api/seo/google/', send, corsHeaders, message: 'Sending your page to Google isn’t available yet.' });
}
