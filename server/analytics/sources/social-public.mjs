// Public stats for a handle through treg: the profile (followers, posts) and recent posts (likes, comments,
// shares, views), normalized per serving provider. Ids found once (Instagram user_id, TikTok sec_uid, YouTube
// channel_id) are kept in analytics_settings.resolved with the handle they belong to.

import { postsFrom, profileFrom, profileMissing } from '../normalize/index.mjs';

/** A TregError's kind as a network note (null: not a per-network note; the caller treats it as an error). */
export function noteFor(error) {
  switch (error?.kind) {
    case 'not_found':
      return 'not_found';
    case 'too_expensive':
      return 'over_cost';
    case 'busy':
    case 'in_progress':
    case 'unavailable':
    case 'upstream':
    case 'timeout':
    case 'uncertain':
    case 'bad_request':
      return 'busy';
    default:
      return null;
  }
}

export const engagementOf = (posts) => posts.reduce((a, p) => a + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0), 0);

function stats(network, handle, profile, posts, note) {
  const top = [...posts].sort((a, b) => (b.likes ?? 0) + (b.comments ?? 0) + (b.shares ?? 0) - ((a.likes ?? 0) + (a.comments ?? 0) + (a.shares ?? 0))).slice(0, 10);
  const views = posts.reduce((a, p) => a + (p.views ?? 0), 0);
  return {
    network,
    origin: 'public',
    handle,
    ...(profile.followers !== undefined ? { followers: profile.followers } : {}),
    ...(profile.postsCount !== undefined ? { postsCount: profile.postsCount } : {}),
    ...(posts.length ? { engagement: engagementOf(posts), topPosts: top } : {}),
    ...(views ? { views } : {}),
    ...(note ? { note } : {}),
  };
}

/** The calls for one network (keys in TREG_ENDPOINTS): profile, then posts with what the profile gave. */
const PLANS = {
  instagram: {
    profile: (h) => ['ig.profile', { username: h }],
    posts: (h, ids) => ['ig.posts', { username: h, ...(ids.userId ? { user_id: ids.userId } : {}) }],
  },
  facebook: {
    profile: (h) => ['fb.profile', { profile: h }],
    posts: (h) => ['fb.posts', { url: `https://www.facebook.com/${h}` }],
  },
  tiktok: {
    profile: (h) => ['tt.profile', { username: h }],
    posts: (_h, ids) => (ids.secUid ? ['tt.videos', { sec_uid: ids.secUid, limit: 10 }] : null),
  },
  linkedin: {
    profile: (h) => ['li.profile', { linkedin_handle: h }],
    posts: (h) => ['li.posts', { companyUniversalName: h, page: 1 }],
  },
  x: {
    profile: (h) => ['x.profile', { username: h }],
    posts: (h) => ['x.posts', { username: h }],
  },
  youtube: {
    profile: (_h, ids) => (ids.channelId ? ['yt.profile', { channel_id: ids.channelId }] : null),
    posts: (_h, ids) => (ids.channelId ? ['yt.videos', { channel: ids.channelId, limit: 15 }] : null),
  },
};

/**
 * One network's public stats. resolved: analytics_settings.resolved (read only here). Returns { stats,
 * resolved: patch to merge (or null) }. A cap or block (a TregError the runner stops on) is thrown.
 */
export async function publicStats(runner, network, handle, resolved = {}, { note: forcedNote } = {}) {
  const plan = PLANS[network];
  const known = resolved?.[network]?.handle === handle ? resolved[network] : {};
  const ids = { userId: known.userId, secUid: known.secUid, channelId: known.channelId };
  let patch = null;
  try {
    // YouTube: the routed tools take a channel id only, found once from the @handle
    if (network === 'youtube' && !ids.channelId) {
      if (/^UC[A-Za-z0-9_-]{22}$/.test(handle)) ids.channelId = handle;
      else {
        const got = await runner.treg('yt.resolve', { channel: handle }, 'social');
        const p = profileFrom(got.data);
        if (!p.channelId) return { stats: stats(network, handle, {}, [], 'not_found'), resolved: null };
        ids.channelId = p.channelId;
      }
      patch = { [network]: { handle, channelId: ids.channelId } };
    }
    const [profileKey, profileParams] = plan.profile(handle, ids);
    const prof = await runner.treg(profileKey, profileParams, 'social');
    if (profileMissing(prof.data)) return { stats: stats(network, handle, {}, [], 'not_found'), resolved: patch };
    const profile = profileFrom(prof.data);
    if (network === 'instagram' && profile.userId && profile.userId !== ids.userId) {
      ids.userId = profile.userId;
      patch = { [network]: { handle, userId: profile.userId } };
    }
    if (network === 'tiktok' && profile.secUid && profile.secUid !== ids.secUid) {
      ids.secUid = profile.secUid;
      patch = { [network]: { handle, secUid: profile.secUid } };
    }
    if (profile.isPrivate) return { stats: stats(network, handle, profile, [], 'private'), resolved: patch };
    const postsCall = plan.posts(handle, ids);
    let posts = [];
    let note = forcedNote;
    if (postsCall) {
      try {
        const got = await runner.treg(postsCall[0], postsCall[1], 'social');
        posts = postsFrom(got.data, got.servedBy);
      } catch (e) {
        const n = noteFor(e);
        if (!n) throw e;
        // the profile numbers still stand; the posts are missing this time
        note = note ?? n;
      }
    }
    return { stats: stats(network, handle, profile, posts, note), resolved: patch };
  } catch (e) {
    const n = noteFor(e);
    if (!n) throw e;
    return { stats: stats(network, handle, {}, [], n), resolved: patch };
  }
}
