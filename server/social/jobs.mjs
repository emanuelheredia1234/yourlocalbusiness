// The post_publish_jobs state machine (spec §1.7): queued → sending → sent | failed | unknown, and
// unknown → sent | failed only after a read ("Check again") or a definite answer from the network.
//
// - One live job per post and network: the post_publish_jobs_one_live index (queued, sending, sent, unknown)
//   makes a second publish answer 409 ALREADY_PUBLISHING with the job that's there.
// - The same clientRequestId (a double click) gives back the same job.
// - A `sending` job older than 11 minutes (the 120 s write limit + Upload-Post's longest status-polling window,
//   10 minutes for a video) that this process isn't working on was left by a restart: it becomes `unknown`, on
//   startup and on every read. `unknown` never means "send again": it reads "may have been posted - check before
//   trying again", and "Check again" reads the status by the job id.
// Every query names the server-resolved user.

import crypto from 'node:crypto';
import { fail } from '../integrations/common.mjs';

export const STUCK_AFTER_MS = 11 * 60_000;
export const CHECK_EVERY_MS = 30_000;
const LIVE = ['queued', 'sending', 'sent', 'unknown'];

/** Plain words for each error code a job can end with (never a network's own text). */
export const JOB_MESSAGES = Object.freeze({
  REFUSED: 'The network refused the post.',
  NEEDS_RECONNECT: 'The connection to this account needs to be renewed. Reconnect it in Settings → Connected accounts.',
  PERMISSION: 'This account doesn’t allow the app to post. Check its permissions, or post it yourself.',
  PLATFORM_LIMIT: 'This account has reached the network’s posting limit for now. Try again later or post it yourself.',
  MEDIA_REFUSED: 'The network refused the photo or video.',
  MEDIA_UPLOAD_FAILED: 'The photo or video couldn’t be uploaded, so nothing was posted.',
  MEDIA_PROCESSING: 'The network couldn’t finish processing the video, so nothing was posted.',
  MEDIA_MISSING: 'The photo or video isn’t saved to your account, so nothing was posted.',
  NO_TARGET: 'Choose which account to post to in Settings → Connected accounts.',
  INTERRUPTED: 'The app restarted while posting. It may have been posted - check before trying again.',
  UNCONFIRMED: 'We couldn’t confirm the post went out. It may have been posted - check before trying again.',
  NOT_CONNECTED: 'This account isn’t connected any more, so nothing was posted. Connect it in Settings → Connected accounts.',
  DUPLICATE: 'This looks the same as a recent post on this network. Change the text or the photo, then try again.',
  ACCOUNT_CHECK: 'The network wants you to confirm your account. Open its app, then try again.',
  TEMP_RESTRICTED: 'The network has limited this account for now, so nothing was posted. Try again later.',
  TIKTOK_PRIVACY: 'This TikTok account doesn’t allow that audience setting, so nothing was posted. Check the account’s privacy settings in TikTok.',
  TIKTOK_DRAFTS_FULL: 'TikTok paused uploads because there are too many unpublished drafts. Publish or delete drafts in TikTok, then try again.',
  BUSY: 'Posting is busy right now, so nothing was posted. Try again in a minute.',
  NOT_SENT: 'We couldn’t reach the posting service, so nothing was posted. Try again shortly.',
  X_LINKS_USED: 'This month’s X posts with a link are used up for your account, so nothing was posted. Take the link out (or put it in your X bio) and try again, or post it yourself.',
  SERVICE_UNAVAILABLE: 'Posting from the app isn’t available right now, so nothing was posted. We’ve been notified. You can post it yourself.',
});

/** Plain words for a job that was sent but isn't public yet (TikTok put it in the account's drafts). */
export const JOB_NOTES = Object.freeze({
  SENT_TO_DRAFTS: 'Sent to your TikTok drafts. Open TikTok to publish it.',
});

const iso = (ms) => new Date(ms).toISOString();

/** A job as the app sees it (PublishJob): no provider ids, no user id. */
export function jobOut(row) {
  if (!row) return null;
  const ref = row.provider_ref && typeof row.provider_ref === 'object' ? row.provider_ref : {};
  return {
    id: row.id,
    postId: row.post_id,
    platform: row.platform,
    state: row.state,
    ...(typeof row.url === 'string' && /^https:\/\//.test(row.url) ? { url: row.url } : {}),
    ...(row.error_code ? { errorCode: row.error_code, errorMessage: JOB_MESSAGES[row.error_code] ?? JOB_MESSAGES.REFUSED } : {}),
    requestedAt: row.requested_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.checked_at ? { checkedAt: row.checked_at } : {}),
    ...(typeof ref.comment === 'string' ? { comment: ref.comment } : {}),
    ...(ref.checkable === false ? { checkable: false } : {}),
    ...(row.state === 'sent' && ref.outcome === 'drafts' ? { note: 'SENT_TO_DRAFTS', noteMessage: JOB_NOTES.SENT_TO_DRAFTS } : {}),
  };
}

export function createJobs({ db, now = () => Date.now() }) {
  /** jobs this process is working on right now (never swept as stuck) */
  const active = new Set();

  async function byId(userId, jobId) {
    const rows = await db.select('post_publish_jobs', { user_id: userId, id: jobId }, { limit: 1 });
    return rows[0] ?? null;
  }

  async function byClientRequest(userId, clientRequestId) {
    const rows = await db.select('post_publish_jobs', { user_id: userId, client_request_id: clientRequestId }, { limit: 1 });
    return rows[0] ?? null;
  }

  async function liveFor(userId, postId, platform) {
    const rows = await db.select('post_publish_jobs', { user_id: userId, post_id: postId, platform, state: ['in', LIVE] }, { limit: 1 });
    return rows[0] ?? null;
  }

  /**
   * `sending` jobs older than 180 s that nobody here is working on become `unknown` (INTERRUPTED). userId:
   * only that user's (on a read), or everyone's (startup). Returns how many changed.
   */
  async function sweep(userId = null) {
    const cutoff = iso(now() - STUCK_AFTER_MS);
    const filters = { state: 'sending', requested_at: ['lt', cutoff], ...(userId ? { user_id: userId } : {}) };
    const stale = await db.select('post_publish_jobs', filters, { select: 'id,user_id', limit: 500 });
    let changed = 0;
    for (const r of stale) {
      if (active.has(r.id)) continue;
      const got = await db.update('post_publish_jobs', { id: r.id, user_id: r.user_id, state: 'sending' }, { state: 'unknown', error_code: 'INTERRUPTED', finished_at: iso(now()) }, { returning: true });
      changed += got.length;
    }
    return changed;
  }

  return {
    active,
    byId,
    byClientRequest,
    liveFor,
    sweep,

    /**
     * A new job, `queued`. → { row, existing: false } | { row, existing: true, why: 'same_request' | 'live' }.
     */
    async create({ userId, projectId, postId, platform, clientRequestId }) {
      const row = { id: crypto.randomUUID(), user_id: userId, project_id: projectId, post_id: postId, platform, client_request_id: clientRequestId, state: 'queued', provider_ref: {}, requested_at: iso(now()) };
      try {
        const got = await db.insert('post_publish_jobs', row, { returning: true });
        return { row: got[0] ?? row, existing: false };
      } catch (e) {
        if (e?.name !== 'DbError' || e.code !== 'CONFLICT') throw e;
        const same = await byClientRequest(userId, clientRequestId);
        if (same) return { row: same, existing: true, why: 'same_request' };
        const live = await liveFor(userId, postId, platform);
        if (live) return { row: live, existing: true, why: 'live' };
        throw fail(409, 'ALREADY_PUBLISHING', 'This post is already being posted there.');
      }
    },

    /** queued → sending (only from queued). */
    async start(userId, jobId) {
      const got = await db.update('post_publish_jobs', { id: jobId, user_id: userId, state: 'queued' }, { state: 'sending' }, { returning: true });
      return got[0] ?? null;
    },

    /** Merge provider ids into the job while it's under way (so a check after a restart can find the post). */
    async note(userId, jobId, ref) {
      const cur = await byId(userId, jobId);
      if (!cur) return null;
      const got = await db.update('post_publish_jobs', { id: jobId, user_id: userId }, { provider_ref: { ...(cur.provider_ref ?? {}), ...ref } }, { returning: true });
      return got[0] ?? null;
    },

    /**
     * The outcome: sent | failed | unknown, from sending (or from unknown, when the network gave a definite
     * answer later). A job already finished stays as it is, except that `fromFailed` lets a definite "it posted"
     * (Upload-Post's webhook after its own retry) correct a failure, so nobody posts it again.
     */
    async finish(userId, jobId, { state, url, errorCode, ref }, { fromFailed = false } = {}) {
      const cur = await byId(userId, jobId);
      if (!cur) return null;
      if (!['queued', 'sending', 'unknown', ...(fromFailed && state === 'sent' ? ['failed'] : [])].includes(cur.state)) return cur;
      const patch = {
        state,
        finished_at: iso(now()),
        error_code: state === 'sent' ? null : (errorCode ?? (state === 'unknown' ? 'UNCONFIRMED' : 'REFUSED')),
        ...(url ? { url } : {}),
        ...(ref ? { provider_ref: { ...(cur.provider_ref ?? {}), ...ref } } : {}),
      };
      const got = await db.update('post_publish_jobs', { id: jobId, user_id: userId, state: cur.state }, patch, { returning: true });
      return got[0] ?? (await byId(userId, jobId));
    },

    /**
     * Claim a "Check again" slot: at most one per job every 30 s. → the job row (checked_at set now), or
     * throws 429 RATE_LIMITED with nextAt.
     */
    async claimCheck(userId, row) {
      const last = row.checked_at ? Date.parse(row.checked_at) : 0;
      const t = now();
      if (last && t - last < CHECK_EVERY_MS) throw fail(429, 'RATE_LIMITED', 'You just checked. Try again in a few seconds.', { nextAt: iso(last + CHECK_EVERY_MS) });
      const filters = { id: row.id, user_id: userId, checked_at: row.checked_at ? row.checked_at : null };
      const got = await db.update('post_publish_jobs', filters, { checked_at: iso(t) }, { returning: true });
      if (!got[0]) throw fail(429, 'RATE_LIMITED', 'You just checked. Try again in a few seconds.', { nextAt: iso(t + CHECK_EVERY_MS) });
      return got[0];
    },

    /** The user's last 200 jobs for a project, newest first. */
    async list(userId, projectId) {
      return db.select('post_publish_jobs', { user_id: userId, project_id: projectId }, { order: 'requested_at.desc', limit: 200 });
    },

    /** How many posts this user started on these networks since a time (for the daily posting caps). */
    async countSince(userId, platforms, sinceIso) {
      const rows = await db.select('post_publish_jobs', { user_id: userId, platform: ['in', platforms], requested_at: ['gte', sinceIso], state: ['in', LIVE] }, { select: 'id', limit: 1000 });
      return rows.length;
    },
  };
}
