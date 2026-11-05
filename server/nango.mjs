// The connections implementation that holds each customer's own logins: Nango (WP1 builds it; see
// docs/integrations-setup.md). Selected by server/integrations/wiring.mjs once NANGO_SECRET_KEY is set
// (CONNECTIONS_PROVIDER=off keeps it off); until then the app uses nullConnections and posting stays manual.
//
//   const nango = createNango({ env, fetch, now, storage, db, log });
//   → the methods of server/connections/index.mjs (status, connectLink, …, forgetUser, unforgetUser)
//
// The webhook POST /api/webhooks/nango is answered by server/connections/routes.mjs with the raw body
// (readRaw), HMAC-checked before anything else.
//
// Placeholder until then: every account reads "Not connected"; anything else answers 503 NOT_SET_UP.

import { notConnectedStatuses } from './connections/index.mjs';
import { notSetUp } from './integrations/common.mjs';

export function createNango() {
  const notBuilt = async () => {
    throw notSetUp('Connecting accounts isn’t built into this copy of the app yet (server/nango.mjs).', 'Connecting accounts is coming soon. You can still post yourself and mark posts as posted.');
  };
  return {
    stub: true,
    enabled: false,
    setUp: false,
    hint: 'Connecting accounts isn’t built into this copy of the app yet.',
    async status() {
      return notConnectedStatuses();
    },
    connectLink: notBuilt,
    reconnectLink: notBuilt,
    async check(_userId, platform) {
      return notConnectedStatuses().find((s) => s.platform === platform);
    },
    async disconnect() {},
    targets: notBuilt,
    setTarget: notBuilt,
    request: notBuilt,
    credentials: notBuilt,
    async forgetUser() {},
    async unforgetUser() {},
  };
}
