// Analytics (WP4 builds this): POST /api/analytics/refresh (the Marketing hub's Update), GET
// /api/analytics/runs/:runId, GET /api/analytics/snapshots?projectId=, PUT /api/analytics/settings.
// onStart: runs still `running` after 15 minutes become `done_with_errors` (INTERRUPTED).
//
// Placeholder until then: every route answers 503 NOT_SET_UP.

import { stubRoutes } from '../integrations/common.mjs';

export function createAnalyticsRoutes({ send, corsHeaders } = {}) {
  return stubRoutes({ prefixes: '/api/analytics/', send, corsHeaders, message: 'Analytics aren’t available yet.' });
}
