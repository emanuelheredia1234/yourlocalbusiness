// Usage and billing (WP3 builds this): GET /api/billing/me (each user's own usage), and for the owner
// GET /api/billing/customers, PUT /api/billing/customers/:tag/cap, PUT /api/billing/defaults,
// GET /api/billing/reconcile, GET /api/billing/invoice.csv. onStart: settle `pending` treg rows.
// userDeleted(userId): clear user_id in the ledger rows (they stay, by customer_tag, for invoices).
//
// Placeholder until then: every route answers 503 NOT_SET_UP.

import { stubRoutes } from '../integrations/common.mjs';

export function createBillingRoutes({ send, corsHeaders } = {}) {
  return stubRoutes({ prefixes: '/api/billing/', send, corsHeaders, message: 'Usage isn’t available yet.' });
}
