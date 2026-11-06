// Connected accounts, vendor-neutral: each app user connects their own Facebook Page, Instagram, LinkedIn, TikTok,
// X and YouTube accounts and their ad accounts (Meta, Google, LinkedIn, TikTok, Pinterest, Reddit, Microsoft).
// Two implementations behind one facade (the owner's choice):
// - social networks: Upload-Post (server/connections/uploadpost.mjs), on with UPLOAD_POST_API_KEY: connecting,
//   posting, post status and social stats, one Upload-Post profile per business (each project), at most
//   UPLOAD_POST_MAX_PROFILES_PER_USER businesses per user;
// - ad accounts: Zernio (server/connections/zernio.mjs), on with ZERNIO_API_KEY: connecting ad accounts and ad results.
// combineConnections({ social, ads }) routes each platform to its side; either side can be off (nullConnections),
// where every network shows "Not connected" and posting stays manual ("Post it yourself", then "Mark as posted").
//
// Nango is not here: it stays for future non-social integrations (booking tools, CRMs) in server/nango.mjs.
//
// Every method takes the server-resolved user id (never a value from the browser). Account ids stay on the
// server: the browser gets ConnectionStatus (server/integrations/contracts.mjs) and opaque target handles only.
// `opts.projectId` (a business of that user) picks whose accounts: for social networks each business has its own
// Upload-Post profile (without a business nothing social is connected); for ad accounts it picks the business's
// ad account (else the default). A project id is only ever looked up among the signed-in user's own businesses.
//
//   status(userId, {projectId}) → ConnectionStatus[]            every platform, phase 2 ones 'coming_soon'
//   connectLink(userId, platform, {projectId}) → {connectLink, expiresAt} | {alreadyConnected: true}
//   reconnectLink(userId, platform, {projectId}) → same
//   check(userId, platform, {projectId}) → ConnectionStatus       reads the accounts again from the vendor
//   disconnect(userId, platform, {projectId}) → void
//   targets(userId, platform, {projectId}) → Target[]
//   setTarget(userId, platform, targetId, {projectId}) → ConnectionStatus
//   insights(userId, platform, {projectId, since, until}) → own stats (reads), or null when nothing is chosen
//   adResults(userId, platform, {projectId, since, until}) → one AdsData.own entry (reads), or null
//   publish(userId, platform, {projectId, jobId, composed, media, loadMedia, privacy}) → {state, url?, errorCode?, ref}
//     one attempt; 'unknown' when it may have gone out
//   postStatus(userId, ref) → {found, url} | {failed} | {pending} | null   a read for "Check again"
//   forgetUser(userId) / unforgetUser(userId)
// and, outside the per-side contract (social only): slots(userId) → {used, cap, projects} (the user's businesses
// with a profile, of their limit) and forgetProject(userId, projectId) → {freed} (a business was deleted: its
// profile goes, with every social account in it).

import { AD_PLATFORMS, PHASE2_PLATFORMS, PLATFORMS, SOCIAL_PLATFORMS } from '../integrations/contracts.mjs';
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

export const SOCIAL_OFF_HINT = 'Social accounts and posting are off: add UPLOAD_POST_API_KEY (and UPLOAD_POST_WEBHOOK_SECRET, CUSTOMER_TAG_SECRET) in Replit Secrets.';
export const ADS_OFF_HINT = 'Ad accounts are off: add ZERNIO_API_KEY (and ZERNIO_WEBHOOK_SECRET) in Replit Secrets.';

/** One side (or both) while its key isn't set: nothing is connected and nothing can be. */
export const nullConnections = Object.freeze({
  enabled: false,
  /** for GET /api/integrations/connections: setUp false, and the owner's hint names the Secret */
  setUp: false,
  hint: `${SOCIAL_OFF_HINT} ${ADS_OFF_HINT}`,
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

/** A project id from a request (undefined when absent or malformed); the implementation looks it up among the user's own. */
export const projectOf = (opts) => (typeof opts?.projectId === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(opts.projectId) && !['__proto__', 'constructor', 'prototype'].includes(opts.projectId) ? opts.projectId : undefined);

const sideOff = (hint) => Object.freeze({ ...nullConnections, hint });

/**
 * One implementation from the two sides: social platforms go to `social` (Upload-Post), ad platforms to `ads`
 * (Zernio). A side that is null or off answers like nullConnections for its platforms. status() merges both.
 * The sides stay reachable as .social and .ads (the webhook routes, the startup jobs, the owner's counts).
 */
export function combineConnections({ social = null, ads = null } = {}) {
  const s = social && social.enabled !== false ? social : sideOff(SOCIAL_OFF_HINT);
  const a = ads && ads.enabled !== false ? ads : sideOff(ADS_OFF_HINT);
  for (const side of [s, a]) for (const m of CONNECTION_METHODS) if (typeof side[m] !== 'function') throw new Error(`connections: a side has no ${m}()`);
  const sideOf = (platform) => (AD_PLATFORMS.includes(platform) ? a : s);
  const socialEnabled = s.enabled !== false;
  const adsEnabled = a.enabled !== false;
  // what the owner still has to add: a side that isn't set up, or a set-up side's warning (e.g. MEDIA_URL_SECRET)
  const hints = [...(socialEnabled && s.setUp !== false ? [s.warning] : [s.hint]), ...(adsEnabled && a.setUp !== false ? [a.warning] : [a.hint])].filter((h) => typeof h === 'string' && h);
  const via = (name) => (userId, platform, ...rest) => sideOf(platform)[name](userId, platform, ...rest);
  return {
    enabled: socialEnabled || adsEnabled,
    socialEnabled,
    adsEnabled,
    setUpSocial: socialEnabled && s.setUp !== false,
    setUpAds: adsEnabled && a.setUp !== false,
    setUp: (socialEnabled && s.setUp !== false) || (adsEnabled && a.setUp !== false),
    hint: hints.join(' '),
    /** the X Links add-on is bought: links stay in X posts (from a monthly allowance every customer shares) */
    xLinks: socialEnabled && s.xLinks === true,
    social: socialEnabled ? s : null,
    ads: adsEnabled ? a : null,
    async status(userId, opts) {
      const [fromSocial, fromAds] = await Promise.all([s.status(userId, opts), a.status(userId, opts)]);
      const pick = (list, p) => (Array.isArray(list) ? list.find((x) => x?.platform === p) : null);
      return PLATFORMS.map((p) => pick(AD_PLATFORMS.includes(p) ? fromAds : fromSocial, p) ?? { platform: p, state: PHASE2_PLATFORMS.includes(p) ? 'coming_soon' : 'not_connected' });
    },
    connectLink: via('connectLink'),
    reconnectLink: via('reconnectLink'),
    check: via('check'),
    disconnect: via('disconnect'),
    targets: via('targets'),
    setTarget: via('setTarget'),
    insights: (userId, platform, opts) => (SOCIAL_PLATFORMS.includes(platform) ? s.insights(userId, platform, opts) : null),
    adResults: (userId, platform, opts) => (AD_PLATFORMS.includes(platform) ? a.adResults(userId, platform, opts) : null),
    publish: (userId, platform, opts) => s.publish(userId, platform, opts),
    postStatus: (userId, ref) => s.postStatus(userId, ref),
    /** The user's businesses with a social profile, of their limit (null when social is off). */
    slots: async (userId) => (typeof s.slots === 'function' ? s.slots(userId) : null),
    /** A business was deleted: its social profile goes (ad accounts aren't per business: nothing changes there). */
    forgetProject: async (userId, projectId) => (typeof s.forgetProject === 'function' ? s.forgetProject(userId, projectId) : { freed: false }),
    /**
     * Social first: it only marks the profile (Upload-Post deletes it in userDeleted, once the account is gone, so a
     * deletion that stops here or later loses no social connection); then the ad accounts at Zernio.
     */
    async forgetUser(userId) {
      await s.forgetUser(userId);
      await a.forgetUser(userId);
    },
    async unforgetUser(userId) {
      await a.unforgetUser(userId);
      await s.unforgetUser(userId);
    },
  };
}

/**
 * The connections every route uses, around an implementation (combineConnections(...) or nullConnections):
 * checks the user id and the platform before the implementation sees them.
 */
export function createConnections(impl = nullConnections) {
  for (const m of CONNECTION_METHODS) if (typeof impl?.[m] !== 'function') throw new Error(`connections: the implementation has no ${m}()`);
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
    /** social networks (Upload-Post) and ad accounts (Zernio) are each on or off by their own key */
    socialEnabled: typeof impl.socialEnabled === 'boolean' ? impl.socialEnabled : impl.enabled !== false,
    adsEnabled: typeof impl.adsEnabled === 'boolean' ? impl.adsEnabled : impl.enabled !== false,
    setUpSocial: typeof impl.setUpSocial === 'boolean' ? impl.setUpSocial : impl.setUp !== false,
    setUpAds: typeof impl.setUpAds === 'boolean' ? impl.setUpAds : impl.setUp !== false,
    /** what the owner is told when it isn't set up, or set up without an optional Secret (names only) */
    hint: typeof impl.hint === 'string' ? impl.hint : '',
    /** the X Links add-on is bought (UPLOAD_POST_X_LINKS) */
    xLinks: impl.xLinks === true,
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
    targets: withOpts('targets'),
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
    async slots(userId) {
      checkUser(userId);
      return typeof impl.slots === 'function' ? impl.slots(userId) : null;
    },
    /** A business was deleted (or its slot given back): only that user's own business is ever touched. */
    async forgetProject(userId, projectId) {
      checkUser(userId);
      const id = projectOf({ projectId });
      if (!id) throw fail(400, 'BAD_REQUEST', 'Which business?');
      return typeof impl.forgetProject === 'function' ? impl.forgetProject(userId, id) : { freed: false };
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
