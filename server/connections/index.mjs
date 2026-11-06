// Connected accounts, vendor-neutral: each app user connects their own Facebook Page, Instagram, LinkedIn, TikTok,
// X and YouTube accounts and their ad accounts (Meta, Google, LinkedIn, TikTok, Pinterest, X, Reddit, Microsoft).
// The implementation is Zernio (server/connections/zernio.mjs, the owner's choice): one Zernio profile per customer
// on Zernio's own approved platform apps. Until ZERNIO_API_KEY is set the app uses nullConnections, where every
// network shows "Not connected" and posting stays manual ("Post it yourself", then "Mark as posted").
//
// Nango is not here: it stays for future non-social integrations (booking tools, CRMs) in server/nango.mjs.
//
// Every method takes the server-resolved user id (never a value from the browser). Account ids stay on the
// server: the browser gets ConnectionStatus (server/integrations/contracts.mjs) and opaque target handles only.
// `opts.projectId` (a business of that user) picks the account that business uses; without it, the default.
//
//   status(userId, {projectId}) → ConnectionStatus[]            every platform, phase 2 ones 'coming_soon'
//   connectLink(userId, platform, {projectId}) → {connectLink, expiresAt} | {alreadyConnected: true}
//   reconnectLink(userId, platform, {projectId}) → same
//   check(userId, platform, {projectId}) → ConnectionStatus       reads the accounts again from the vendor
//   disconnect(userId, platform, {projectId}) → void
//   targets(userId, platform) → Target[]
//   setTarget(userId, platform, targetId, {projectId}) → ConnectionStatus
//   insights(userId, platform, {projectId, since, until}) → own stats (reads), or null when nothing is chosen
//   adResults(userId, platform, {projectId, since, until}) → one AdsData.own entry (reads), or null
//   publish(userId, platform, {projectId, jobId, composed, media, loadMedia, privacy}) → {state, url?, errorCode?, ref}
//     one attempt; 'unknown' when it may have gone out
//   postStatus(userId, ref) → {found, url} | {failed} | {pending} | null   a read for "Check again"
//   forgetUser(userId) / unforgetUser(userId)

import { PHASE2_PLATFORMS, PLATFORMS } from '../integrations/contracts.mjs';
import { fail, isUuid } from '../integrations/common.mjs';

export const CONNECTION_METHODS = Object.freeze(['status', 'connectLink', 'reconnectLink', 'check', 'disconnect', 'targets', 'setTarget', 'insights', 'adResults', 'publish', 'postStatus', 'forgetUser', 'unforgetUser']);

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

/** The app until ZERNIO_API_KEY is set: nothing is connected and nothing can be. */
export const nullConnections = Object.freeze({
  enabled: false,
  /** for GET /api/integrations/connections: setUp false, and the owner's hint names the Secret */
  setUp: false,
  hint: 'Connecting social and ad accounts is off: add ZERNIO_API_KEY (and ZERNIO_WEBHOOK_SECRET) in Replit Secrets.',
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
  async insights() {
    return null;
  },
  async adResults() {
    return null;
  },
  async publish() {
    throw notEnabled();
  },
  async postStatus() {
    return null;
  },
  async forgetUser() {
    /* nothing stored */
  },
  async unforgetUser() {
    /* nothing stored */
  },
});

/** A project id from a request ('' when absent); the implementation checks it's the user's own when it matters. */
const projectOf = (opts) => (typeof opts?.projectId === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(opts.projectId) ? opts.projectId : undefined);

/**
 * The connections every route uses, around an implementation (createZernioConnections(...) or nullConnections):
 * checks the user id and the platform before the implementation sees them.
 */
export function createConnections(impl = nullConnections) {
  for (const m of CONNECTION_METHODS) if (typeof impl?.[m] !== 'function') throw new Error(`connections: the implementation has no ${m}()`);
  const perPlatform =
    (name) =>
    async (userId, platform, ...rest) => {
      checkUser(userId);
      checkPlatform(platform);
      return impl[name](userId, platform, ...rest);
    };
  const withOpts =
    (name) =>
    async (userId, platform, opts = {}) => {
      checkUser(userId);
      checkPlatform(platform);
      return impl[name](userId, platform, { ...opts, projectId: projectOf(opts) });
    };
  return Object.freeze({
    enabled: impl.enabled !== false,
    setUp: impl.setUp !== false,
    /** what the owner is told when it isn't set up (Secret names only) */
    hint: typeof impl.hint === 'string' ? impl.hint : '',
    /** the implementation (for the webhook route and the startup jobs) */
    impl,
    async status(userId, opts = {}) {
      checkUser(userId);
      return impl.status(userId, { projectId: projectOf(opts) });
    },
    connectLink: withOpts('connectLink'),
    reconnectLink: withOpts('reconnectLink'),
    check: withOpts('check'),
    disconnect: withOpts('disconnect'),
    targets: perPlatform('targets'),
    async setTarget(userId, platform, targetId, opts = {}) {
      checkUser(userId);
      checkPlatform(platform);
      return impl.setTarget(userId, platform, targetId, { projectId: projectOf(opts) });
    },
    insights: withOpts('insights'),
    adResults: withOpts('adResults'),
    publish: withOpts('publish'),
    async postStatus(userId, ref) {
      checkUser(userId);
      return impl.postStatus(userId, ref);
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
