// treg's admin calls (WP3 builds them), with the separate admin-role token TREG_ADMIN_TOKEN. Only
// server/billing/* imports this file; no /call/ request ever carries that token.
//
//   const admin = createTregAdmin({ env, fetch });
//   admin.budgets.putDefault(fields) · budgets.put(tag, fields) · budgets.delete(tag) · budgets.list()
//   admin.usageByTag(days) · admin.balance() · admin.call(callId) · admin.settings(fields)
//
// Never call POST /orgs/<org_id>/public-token. Placeholder until then: every call throws TregError('config').

import { TregError } from '../treg.mjs';

export function createTregAdmin() {
  const notBuilt = async () => {
    throw new TregError('config', 'treg billing isn’t built into this copy of the app yet.');
  };
  return {
    stub: true,
    budgets: { putDefault: notBuilt, put: notBuilt, delete: notBuilt, list: notBuilt },
    usageByTag: notBuilt,
    balance: notBuilt,
    call: notBuilt,
    settings: notBuilt,
  };
}
