// The one wrapper for every treg call (WP3 builds it): public social data, competitor ads, Google rank and
// Maps position, and Search Console for app-host pages, each tagged with the customer (X-Treg-Meta) and
// written to the usage ledger, success or failure.
//
//   const treg = createTreg({ env, fetch, now, ledger, log });
//   treg.call(endpointId, { method, query, body }, ctx, opts) → { ok, status, data, meta } | throws TregError
//     ctx  = { userId, projectId, feature: 'social'|'seo'|'ads'|'gsc'|'email', runId }  (server-resolved only)
//     opts = { maxCostUsd, idempotencyKey, maxAgeS, preferProvider, noCache, timeoutMs }
//   treg.health() → { setUp, billingSetUp }
//
// The token goes in X-Treg-Token only, never Authorization (treg relays that header to the provider).
// createTreg never reads TREG_ADMIN_TOKEN: that's server/billing/tregAdmin.mjs, for server/billing/* only.
//
// Placeholder until then: call() throws TregError('config').

/** TregError.kind: what went wrong, in the terms the routes and the UI use (docs/integrations-setup.md). */
export const TREG_ERROR_KINDS = Object.freeze(['customer_blocked', 'customer_cap', 'team_unavailable', 'not_found', 'too_expensive', 'busy', 'unavailable', 'in_progress', 'uncertain', 'config', 'bad_request', 'upstream', 'timeout']);

export class TregError extends Error {
  /** kind: one of TREG_ERROR_KINDS. extra: { status, period, callId } (never treg's own text or amounts). */
  constructor(kind, message = kind, extra = {}) {
    super(message);
    this.name = 'TregError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function createTreg({ env = process.env } = {}) {
  return {
    stub: true,
    async call() {
      throw new TregError('config', 'treg isn’t built into this copy of the app yet.');
    },
    health() {
      return { setUp: Boolean(env.TREG_TOKEN), billingSetUp: Boolean(env.TREG_ADMIN_TOKEN && env.TREG_ORG_ID) };
    },
  };
}
