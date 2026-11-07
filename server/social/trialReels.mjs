// Instagram Trial Reels (P4b §S4): whether a business's Instagram account may post one.
//
// A Trial Reel needs a public Instagram account with at least 1,000 followers. Upload-Post doesn't say whether an
// account is professional or public, but Instagram's API only connects Business and Creator accounts, and those
// can't be private: a connected account is professional and public, so the app explains that part instead of
// checking it. The follower count is checked: from the business's own analytics snapshot when it is under 24 hours
// old, otherwise one read of its own stats (insights(), inside the analytics limit), kept 6 hours per business.
//
//   const trial = createTrialReels({ db, connections, now });
//   await trial.eligibility(userId, projectId)
//     → { eligible: true, followers, checkedAt } | { eligible: false, reason: 'not_connected' | 'needs_reconnect' |
//       'followers', followers?, checkedAt } | { eligible: 'unknown', reason: 'unreadable', checkedAt }
//
// The publish route refuses a Trial Reel only when eligible is false; with 'unknown' it posts after the customer
// ticked "Post as a trial anyway". If Instagram refuses, the post fails once (TRIAL_REEL_REFUSED) and is never retried.

import { safeLog } from '../integrations/common.mjs';

export const TRIAL_MIN_FOLLOWERS = 1000;
const SNAPSHOT_FRESH_MS = 24 * 3_600_000;
const CACHE_MS = 6 * 3_600_000;
const MAX_CACHED = 5000;

const iso = (t) => new Date(t).toISOString();
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

export function createTrialReels({ db, connections, now = () => Date.now(), log = console } = {}) {
  /** `${userId}:${projectId}` → { at, followers } (followers undefined: the read failed; not kept) */
  const cache = new Map();

  async function fromSnapshot(userId, projectId, t) {
    try {
      const [snap] = await db.select('analytics_snapshots', { user_id: userId, project_id: projectId, source: 'social' }, { select: 'fetched_at,data', limit: 1 });
      const at = Date.parse(snap?.fetched_at ?? '');
      if (!Number.isFinite(at) || t - at > SNAPSHOT_FRESH_MS) return undefined;
      const ig = (Array.isArray(snap?.data?.networks) ? snap.data.networks : []).find((n) => n?.network === 'instagram' && n?.origin === 'own');
      return count(ig?.followers);
    } catch {
      return undefined;
    }
  }

  async function fresh(userId, projectId) {
    try {
      const got = await connections.insights(userId, 'instagram', { projectId });
      return count(got?.followers);
    } catch (e) {
      safeLog('trial_reels_followers_unreadable', { kind: e?.kind || e?.code || e?.name || 'Error' }, log);
      return undefined;
    }
  }

  async function eligibility(userId, projectId) {
    const t = now();
    const checkedAt = iso(t);
    const all = await connections.status(userId, { projectId });
    const st = (Array.isArray(all) ? all : []).find((s) => s?.platform === 'instagram');
    const state = st?.state;
    if (state === 'needs_reconnect' || (state === 'limited' && st?.limitedReason === 'missing_permissions')) return { eligible: false, reason: 'needs_reconnect', checkedAt };
    if (state !== 'connected' && state !== 'limited') return { eligible: false, reason: 'not_connected', checkedAt };
    const key = `${userId}:${projectId}`;
    const kept = cache.get(key);
    let followers = kept && t - kept.at < CACHE_MS ? kept.followers : undefined;
    if (followers === undefined) {
      followers = (await fromSnapshot(userId, projectId, t)) ?? (await fresh(userId, projectId));
      if (followers !== undefined) {
        cache.delete(key);
        cache.set(key, { at: t, followers });
        while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
      }
    }
    if (followers === undefined) return { eligible: 'unknown', reason: 'unreadable', checkedAt };
    if (followers < TRIAL_MIN_FOLLOWERS) return { eligible: false, reason: 'followers', followers, checkedAt };
    return { eligible: true, followers, checkedAt };
  }

  return {
    eligibility,
    /** A business's cached count goes (its account changed). */
    forget(userId, projectId) {
      cache.delete(`${userId}:${projectId}`);
    },
  };
}
