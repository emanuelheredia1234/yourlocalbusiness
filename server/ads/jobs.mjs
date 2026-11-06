// The ad_jobs state machine (spec §7.5, §8), a copy of the posting pattern (server/social/jobs.mjs) for ads:
// queued → sending → done | failed | unknown, and unknown → done | failed only after a read (Check status).
//
// - One live job per campaign (ad_jobs_one_live: queued, sending, unknown): an unknown write blocks the next change
//   until it is checked.
// - The same clientRequestId (a double press) gives back the same job (ads_begin_launch / ads_begin_change).
// - A `sending` job older than 300 s (longer than one job's step timeouts) that this process isn't running was left
//   by a restart: it becomes `unknown` INTERRUPTED (its campaign too, when it was launching), on startup and on every
//   read. Nothing is ever sent again by itself: `unknown` reads "may have happened - check status before trying again".
// Every query names the server-resolved user.

import { fail } from '../integrations/common.mjs';
import { messageFor } from './messages.mjs';

export const STUCK_AFTER_MS = 300_000;
export const CHECK_EVERY_MS = 30_000;

const iso = (ms) => new Date(ms).toISOString();

/** A job as the app sees it (AdJob): our message, no provider ids. */
export function jobOut(row, platform) {
  if (!row) return null;
  const p = platform ?? row.platform ?? 'meta';
  const code = row.error_code ?? null;
  const unknownCode = row.kind === 'launch' ? 'UNKNOWN_LAUNCH' : 'UNKNOWN';
  const req = row.request ?? {};
  const said = { platform: p, currency: req.account?.currency ?? req.currency, cap: req.spendCap ?? req.newSpendCap };
  const message =
    row.state === 'unknown'
      ? messageFor(code === 'INTERRUPTED' ? 'INTERRUPTED' : code && code !== 'UNKNOWN' ? code : unknownCode, said)
      : row.state === 'failed' || (row.state === 'done' && code)
        ? messageFor(code ?? 'REFUSED', said)
        : row.state === 'done'
          ? messageFor('DONE')
          : messageFor('SENDING');
  const checked = row.checked_at ? Date.parse(row.checked_at) : 0;
  return {
    id: row.id,
    kind: row.kind,
    platform: p,
    state: row.state,
    ...(code ? { code } : {}),
    message,
    actor: row.actor ?? 'customer',
    requestedAt: row.requested_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.checked_at ? { checkedAt: row.checked_at } : {}),
    ...(row.state === 'unknown' ? { canCheckAt: iso(Math.max(checked + CHECK_EVERY_MS, 0)) } : {}),
    ...(Array.isArray(row.provider_ref?.leftBehind) && row.provider_ref.leftBehind.length ? { leftBehind: row.provider_ref.leftBehind.map((o) => `${o.type} …${String(o.id).slice(-4)}`) } : {}),
  };
}

export function createAdJobs({ db, now = () => Date.now() }) {
  /** jobs this process is running right now (never swept as stuck) */
  const active = new Set();

  async function byId(userId, jobId) {
    const rows = await db.select('ad_jobs', { user_id: userId, id: jobId }, { limit: 1 });
    return rows[0] ?? null;
  }

  async function byClientRequest(userId, clientRequestId) {
    const rows = await db.select('ad_jobs', { user_id: userId, client_request_id: clientRequestId }, { limit: 1 });
    return rows[0] ?? null;
  }

  async function liveFor(userId, campaignId) {
    const rows = await db.select('ad_jobs', { user_id: userId, campaign_id: campaignId, state: ['in', ['queued', 'sending', 'unknown']] }, { limit: 1 });
    return rows[0] ?? null;
  }

  /** `sending` jobs older than 300 s nobody here is running → unknown INTERRUPTED (and a launching campaign → unknown). */
  async function sweep(userId = null) {
    const cutoff = iso(now() - STUCK_AFTER_MS);
    const stale = await db.select('ad_jobs', { state: 'sending', requested_at: ['lt', cutoff], ...(userId ? { user_id: userId } : {}) }, { select: 'id,user_id,campaign_id,kind', limit: 500 });
    let changed = 0;
    for (const r of stale) {
      if (active.has(r.id)) continue;
      const got = await db.update('ad_jobs', { id: r.id, user_id: r.user_id, state: 'sending' }, { state: 'unknown', error_code: 'INTERRUPTED', finished_at: iso(now()) }, { returning: true });
      changed += got.length;
      if (got.length && r.kind === 'launch') await db.update('ad_campaigns', { id: r.campaign_id, user_id: r.user_id, state: 'launching' }, { state: 'unknown', updated_at: iso(now()) });
    }
    return changed;
  }

  /** Merge into provider_ref while the job runs (the step it is on, the ids made so far). */
  async function note(userId, jobId, ref) {
    const cur = await byId(userId, jobId);
    if (!cur) return null;
    const got = await db.update('ad_jobs', { id: jobId, user_id: userId }, { provider_ref: { ...(cur.provider_ref ?? {}), ...ref } }, { returning: true });
    return got[0] ?? null;
  }

  /** sending|unknown → done | failed | unknown. A finished job stays as it is. */
  async function finish(userId, jobId, { state, code = null, ref }) {
    const cur = await byId(userId, jobId);
    if (!cur) return null;
    if (!['queued', 'sending', 'unknown'].includes(cur.state)) return cur;
    const patch = { state, finished_at: iso(now()), error_code: code ?? (state === 'unknown' ? 'UNKNOWN' : state === 'failed' ? 'REFUSED' : null), ...(ref ? { provider_ref: { ...(cur.provider_ref ?? {}), ...ref } } : {}) };
    const got = await db.update('ad_jobs', { id: jobId, user_id: userId, state: cur.state }, patch, { returning: true });
    return got[0] ?? (await byId(userId, jobId));
  }

  /** At most one Check status per job every 30 s. → the row (checked_at now), or 429 with nextAt. */
  async function claimCheck(userId, row) {
    const last = row.checked_at ? Date.parse(row.checked_at) : 0;
    const t = now();
    if (last && t - last < CHECK_EVERY_MS) throw fail(429, 'RATE_LIMITED', 'You just checked. Try again in a few seconds.', { nextAt: iso(last + CHECK_EVERY_MS) });
    const got = await db.update('ad_jobs', { id: row.id, user_id: userId, checked_at: row.checked_at ? row.checked_at : null }, { checked_at: iso(t) }, { returning: true });
    if (!got[0]) throw fail(429, 'RATE_LIMITED', 'You just checked. Try again in a few seconds.', { nextAt: iso(t + CHECK_EVERY_MS) });
    return got[0];
  }

  /** The newest job of each of these campaigns (for the Campaigns tab). */
  async function latestFor(userId, campaignIds) {
    if (!campaignIds.length) return new Map();
    const rows = await db.select('ad_jobs', { user_id: userId, campaign_id: ['in', campaignIds] }, { order: 'requested_at.desc', limit: 1000 });
    const out = new Map();
    for (const r of rows) if (!out.has(r.campaign_id)) out.set(r.campaign_id, r);
    return out;
  }

  return { active, byId, byClientRequest, liveFor, sweep, note, finish, claimCheck, latestFor };
}
