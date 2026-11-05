// Connected accounts, vendor-neutral: each app user connects their own Facebook Page, Instagram, LinkedIn,
// TikTok, X, YouTube, Google Ads, Meta Ads and Search Console. The implementation that holds their logins is
// Nango (server/nango.mjs); until NANGO_SECRET_KEY is set the app uses nullConnections, where every network
// shows "Not connected" and posting stays manual ("Post it yourself", then "Mark as posted").
//
// Every method takes the server-resolved user id (never a value from the browser). Connection ids, target ids
// and tokens stay on the server: the browser gets ConnectionStatus (server/integrations/contracts.mjs) only.
//
//   status(userId) → ConnectionStatus[]                     every platform, phase 2 ones 'coming_soon'
//   connectLink(userId, platform) → {connectLink, expiresAt}
//   reconnectLink(userId, platform) → {connectLink, expiresAt}
//   check(userId, platform) → ConnectionStatus
//   disconnect(userId, platform) → void
//   targets(userId, platform) → Target[]
//   setTarget(userId, platform, targetId) → ConnectionStatus
//   request(userId, platform, {method, path, query, body, headers, baseUrlOverride, oneShot, timeoutMs}) → {status, headers, body}
//     oneShot=true: exactly one attempt (no Retries / Retry-On). Reads may pass oneShot=false: one retry after
//     Retry-After on a 429 only.
//   credentials(userId, platform) → {accessToken}           only microsoft_ads and tiktok_ads (phase 2), for direct
//                                                           server calls; never returned to a route
//   forgetUser(userId)                                      deletes every connection at the vendor (one attempt
//                                                           each), then the stored doc
//   unforgetUser(userId)
//
// Instagram's status is derived: connected when Facebook is connected and the chosen Page has an Instagram
// professional account (the implementation decides; see docs/integrations-setup.md).

import { PHASE2_PLATFORMS, PLATFORMS } from '../integrations/contracts.mjs';
import { fail, isUuid } from '../integrations/common.mjs';

export const CONNECTION_METHODS = Object.freeze(['status', 'connectLink', 'reconnectLink', 'check', 'disconnect', 'targets', 'setTarget', 'request', 'credentials', 'forgetUser', 'unforgetUser']);
/** The only platforms credentials() answers for (their APIs aren't reachable through the proxy). */
export const CREDENTIAL_PLATFORMS = Object.freeze(['microsoft_ads', 'tiktok_ads']);

const notEnabled = () => fail(503, 'CONNECTIONS_NOT_ENABLED', 'Connecting accounts is coming soon. You can still post yourself and mark posts as posted.');

function checkUser(userId) {
  if (!isUuid(userId)) throw fail(401, 'AUTH_REQUIRED', 'Sign in first.');
}

function checkPlatform(platform) {
  if (!PLATFORMS.includes(platform)) throw fail(404, 'NOT_FOUND', 'Unknown account type.');
}

/** Every platform as not connected (phase 2 ones: coming soon). */
export function notConnectedStatuses() {
  return PLATFORMS.map((platform) => ({ platform, state: PHASE2_PLATFORMS.includes(platform) ? 'coming_soon' : 'not_connected' }));
}

/** The app until NANGO_SECRET_KEY is set: nothing is connected and nothing can be. */
export const nullConnections = Object.freeze({
  enabled: false,
  /** for GET /api/integrations/connections: setUp false, and the owner's hint names the Secret */
  setUp: false,
  hint: 'Connecting accounts is off: add NANGO_SECRET_KEY (and NANGO_WEBHOOK_SIGNING_KEY) in Replit Secrets.',
  async status() {
    return notConnectedStatuses();
  },
  async connectLink() {
    throw notEnabled();
  },
  async reconnectLink() {
    throw notEnabled();
  },
  async check(_userId, platform) {
    return { platform, state: PHASE2_PLATFORMS.includes(platform) ? 'coming_soon' : 'not_connected' };
  },
  async disconnect() {
    /* nothing is connected */
  },
  async targets() {
    throw notEnabled();
  },
  async setTarget() {
    throw notEnabled();
  },
  async request() {
    throw notEnabled();
  },
  async credentials() {
    throw notEnabled();
  },
  async forgetUser() {
    /* nothing stored */
  },
  async unforgetUser() {
    /* nothing stored */
  },
});

/**
 * The connections every route uses, around an implementation (createNango(...) or nullConnections): checks the
 * user id and the platform before the implementation sees them, and keeps credentials() to its two platforms.
 */
export function createConnections(impl = nullConnections) {
  for (const m of CONNECTION_METHODS) if (typeof impl?.[m] !== 'function') throw new Error(`connections: the implementation has no ${m}()`);
  const perPlatform = (name) => async (userId, platform, ...rest) => {
    checkUser(userId);
    checkPlatform(platform);
    return impl[name](userId, platform, ...rest);
  };
  return Object.freeze({
    enabled: impl.enabled !== false,
    setUp: impl.setUp !== false,
    /** what the owner is told when it isn't set up (Secret names only) */
    hint: typeof impl.hint === 'string' ? impl.hint : '',
    async status(userId) {
      checkUser(userId);
      return impl.status(userId);
    },
    connectLink: perPlatform('connectLink'),
    reconnectLink: perPlatform('reconnectLink'),
    check: perPlatform('check'),
    disconnect: perPlatform('disconnect'),
    targets: perPlatform('targets'),
    setTarget: perPlatform('setTarget'),
    request: perPlatform('request'),
    async credentials(userId, platform) {
      checkUser(userId);
      if (!CREDENTIAL_PLATFORMS.includes(platform)) throw fail(403, 'FORBIDDEN', 'Not available for this account type.');
      return impl.credentials(userId, platform);
    },
    async forgetUser(userId) {
      if (!isUuid(userId)) return;
      return impl.forgetUser(userId);
    },
    async unforgetUser(userId) {
      if (!isUuid(userId)) return;
      return impl.unforgetUser(userId);
    },
  });
}
