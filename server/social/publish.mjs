// Posting a saved post on a connected account (spec §1.7): checks, the job, the adapter run, the ledger.
//
//   const posting = createPosting({ db, connections, env, fetch, now, log });
//   await posting.publish(who, body)  → { status: 200, job }    (the job is `sending`; it finishes in the background)
//   await posting.check(who, jobId)   → { job }                 ("Check again" on an `unknown` job: one read)
//   await posting.job(who, jobId)     → { job }                 (a database read only)
//   await posting.list(who, projectId)→ { jobs }
//
// What it never does: send a post twice by itself, use text from the request as the post (the post is re-read
// from the user's account and must match), or put a token or a media link in a log.

import { ensureCustomer, fail, isUuid, notSetUp, safeLog, utcDay } from '../integrations/common.mjs';
import { PUBLISH_PLATFORMS } from '../integrations/contracts.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { proxyRead, proxyWrite } from './adapters/common.mjs';
import { cleanHashtags, composeFor, placementOf, xPostCost } from './caption.mjs';
import { createDirect } from './direct.mjs';
import { createJobs, jobOut } from './jobs.mjs';
import { canMakePublicLinks, createMediaStore, formatProblem, MEDIA_ID_RE, mediaKind, publicMediaUrl } from './media.mjs';

export const DEFAULT_TIMING = Object.freeze({
  writeMs: 120_000,
  readMs: 30_000,
  igPollMs: 60_000,
  igVideoMaxMs: 5 * 60_000,
  tiktokPollMs: 10_000,
  tiktokMaxMs: 2 * 60_000,
  xVideoMaxMs: 2 * 60_000,
});
/** The posting caps when billing_caps has no row at all (the migration's '*' row says the same). */
export const DEFAULT_POST_CAPS = Object.freeze({ postsPerDay: 50, xPostsPerDay: 20 });
/** X's list price for a "Check again" (one user read + up to 5 post reads), an estimate in micro-USD. */
const X_CHECK_COST_MICRO = 35_000;

const NETWORK = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', youtube: 'YouTube' };
/** networks whose posts go to a chosen Page, account or organization */
const NEEDS_TARGET = new Set(['facebook', 'instagram', 'linkedin']);
/** networks that fetch the file from our short-lived link */
const pullsMedia = (platform, env, kind) => platform === 'instagram' || (platform === 'facebook' && kind === 'image') || (platform === 'tiktok' && (kind === 'image' || String(env.TIKTOK_UPLOAD_MODE || '').toUpperCase() === 'PULL_FROM_URL'));

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const idOf = (v, max = 120) => (typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9._:-]+$/.test(v) ? v : null);
const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();

/** The user's own project row (404 when it isn't theirs). */
export async function loadProject(db, userId, projectId) {
  const rows = await db.select('user_docs', { user_id: userId, kind: 'project', id: projectId }, { select: 'id,data', limit: 1 });
  if (!isObj(rows[0]?.data)) throw fail(404, 'NOT_FOUND', 'That business isn’t in your account.');
  return rows[0].data;
}

/** The user's own saved post (404 when it isn't theirs or isn't in that business). */
export async function loadPost(db, userId, postId, projectId) {
  const rows = await db.select('user_docs', { user_id: userId, kind: 'post', id: postId }, { select: 'id,data', limit: 1 });
  const post = rows[0]?.data;
  if (!isObj(post) || (projectId && post.projectId !== projectId)) throw fail(404, 'NOT_FOUND', 'That post isn’t in your account.');
  return post;
}

/**
 * Whether the request describes the post as it's saved: the text, and anything else the request names. The
 * provider payload is built from the saved post; this only stops a stale screen from posting something else.
 */
export function contentMatches(post, content, platform) {
  if (!isObj(content)) return false;
  if (norm(content.text) !== norm(post.caption)) return false;
  if (content.hashtags !== undefined && cleanHashtags(content.hashtags).join(' ') !== cleanHashtags(post.hashtags).join(' ')) return false;
  if (content.firstComment !== undefined && norm(content.firstComment) !== norm(post.firstComment)) return false;
  if (content.linkPlacement !== undefined && post.linkPlacement !== undefined && placementOf(content.linkPlacement) !== placementOf(post.linkPlacement)) return false;
  if (content.title !== undefined && norm(content.title) !== norm(post.headline)) return false;
  if (content.link !== undefined && content.link !== '' && !`${post.caption ?? ''}\n${post.firstComment ?? ''}`.includes(String(content.link))) return false;
  if (content.mediaIds !== undefined) {
    if (!Array.isArray(content.mediaIds) || content.mediaIds.length > 1) return false;
    const want = post.media?.id;
    const got = content.mediaIds[0];
    if (!want) return got === undefined;
    if (got !== want && !(platform === 'instagram' && got === `${want}.jpg`)) return false;
  }
  return true;
}

/** Whether a connection may post, or the refusal in plain words. */
function connectionProblem(platform, status) {
  const name = NETWORK[platform];
  const state = status?.state;
  if (state === 'connected' || (state === 'limited' && ['private_only', 'insights_unavailable'].includes(status.limitedReason))) {
    if (NEEDS_TARGET.has(platform) && !status.targetLabel) return fail(409, 'NOT_CONNECTED', `Choose which ${platform === 'linkedin' ? 'profile or page' : 'Page'} to post to in Settings → Connected accounts.`);
    return null;
  }
  if (state === 'needs_reconnect' || (state === 'limited' && status.limitedReason === 'missing_permissions')) return fail(409, 'NEEDS_RECONNECT', `Reconnect ${name} in Settings → Connected accounts, or post it yourself.`);
  if (state === 'limited') return fail(403, 'FORBIDDEN', `${name} doesn’t let the app post for this account yet. Post it yourself for now.`);
  return fail(409, 'NOT_CONNECTED', `Connect ${name} to post from here, or post it yourself.`);
}

export function createPosting({ db, connections, env = process.env, fetch = globalThis.fetch, now = () => Date.now(), log = console, sleep, timing = {}, mediaStore, direct } = {}) {
  const T = { ...DEFAULT_TIMING, ...timing };
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const jobs = createJobs({ db, now });
  const store = mediaStore ?? createMediaStore({ env, fetch });
  const directCalls = direct ?? createDirect({ env, fetch, timeouts: { readMs: T.readMs, writeMs: T.writeMs } });
  /** background runs, for tests (settled()) */
  const running = new Set();

  async function statusFor(userId, platform) {
    const all = await connections.status(userId);
    return (Array.isArray(all) ? all : []).find((s) => s?.platform === platform) ?? { platform, state: 'not_connected' };
  }

  async function ledger(row) {
    try {
      await db.insert('usage_ledger', { feature: 'posting', estimated: false, cost_micro: 0, ...row });
    } catch (e) {
      safeLog('posting_ledger_failed', { code: e?.code, endpoint: row.endpoint }, log);
    }
  }

  /** The posting caps for this customer: their own row over the '*' defaults. */
  async function capsFor(tag) {
    let rows = [];
    try {
      rows = await db.select('billing_caps', { customer_tag: ['in', ['*', tag]] }, { select: 'customer_tag,posts_per_day,x_posts_per_day,status' });
    } catch (e) {
      if (e?.code === 'NOT_SET_UP') throw e;
    }
    const own = rows.find((r) => r.customer_tag === tag) ?? {};
    const def = rows.find((r) => r.customer_tag === '*') ?? {};
    const pick = (k, d) => (Number.isFinite(own[k]) && own[k] !== null ? own[k] : Number.isFinite(def[k]) && def[k] !== null ? def[k] : d);
    return { postsPerDay: pick('posts_per_day', DEFAULT_POST_CAPS.postsPerDay), xPostsPerDay: pick('x_posts_per_day', DEFAULT_POST_CAPS.xPostsPerDay), blocked: own.status === 'blocked' };
  }

  /** The context an adapter works with (adapters/common.mjs). */
  function contextFor({ userId, platform, status, composed, media, privacy, job, extra = {} }) {
    return {
      userId,
      platform,
      status,
      composed,
      media,
      privacy,
      job,
      env,
      timing: T,
      connections,
      direct: directCalls,
      mediaStore: store,
      sleep: wait,
      now,
      requestedAt: job?.requested_at,
      read: (req) => proxyRead(connections, userId, platform, req, T.readMs),
      write: (req) => proxyWrite(connections, userId, platform, req, T.writeMs),
      publicUrl: () => publicMediaUrl(env, { userId, mediaId: media.id, kind: media.kind }, now()),
      note: (ref) => (job ? jobs.note(userId, job.id, ref).catch(() => null) : null),
      ...extra,
    };
  }

  /** Run the adapter for a job that is `sending`, and record how it ended. Never throws, never resends. */
  async function run(ctx, row, tag) {
    const { userId, platform } = ctx;
    jobs.active.add(row.id);
    let outcome;
    try {
      outcome = await ADAPTERS[platform].publish(ctx);
    } catch (e) {
      // anything unexpected after the job started: it may have gone out
      safeLog('posting_adapter_error', { platform, error: e?.name || 'Error', code: e?.code }, log);
      outcome = { state: 'unknown' };
    }
    if (!outcome || !['sent', 'failed', 'unknown'].includes(outcome.state)) outcome = { state: 'unknown' };
    const ref = { ...(outcome.ref ?? {}), ...(outcome.comment ? { comment: outcome.comment } : {}) };
    let finished = null;
    try {
      finished = await jobs.finish(userId, row.id, { state: outcome.state, url: outcome.url, errorCode: outcome.errorCode, ref });
    } catch (e) {
      safeLog('posting_finish_failed', { platform, code: e?.code }, log);
    } finally {
      jobs.active.delete(row.id);
    }
    const base = { customer_tag: tag, user_id: userId, project_id: row.project_id, call_id: row.id, outcome: outcome.state };
    await ledger({ ...base, vendor: 'nango', endpoint: `${platform}:publish` });
    if (platform === 'x' && outcome.state !== 'failed') {
      await ledger({ ...base, vendor: 'x', endpoint: 'x:POST /2/tweets', cost_micro: xPostCost(ctx.composed), estimated: true });
      if (outcome.comment === 'added') await ledger({ ...base, vendor: 'x', endpoint: 'x:POST /2/tweets (reply)', cost_micro: xPostCost({ hasUrl: /https?:\/\//i.test(ctx.composed.comment ?? '') }), estimated: true });
    }
    safeLog('posting_job_done', { platform, state: outcome.state, error: outcome.errorCode ?? null }, log);
    return finished;
  }

  return {
    jobs,
    /** For tests: wait until every background run has finished. */
    async settled() {
      while (running.size) await Promise.allSettled([...running]);
    },

    async publish(who, body) {
      const userId = who.id;
      if (!isObj(body)) throw fail(400, 'BAD_REQUEST', 'That request isn’t valid.');
      if (body.confirm !== true) throw fail(400, 'BAD_REQUEST', 'Confirm the post first.');
      const clientRequestId = String(body.clientRequestId ?? '');
      if (!isUuid(clientRequestId)) throw fail(400, 'BAD_REQUEST', 'That request isn’t valid.');
      const platform = String(body.platform ?? '');
      if (!PUBLISH_PLATFORMS.includes(platform)) throw fail(400, 'BAD_REQUEST', 'That network isn’t supported.');
      const projectId = idOf(body.projectId);
      const postId = idOf(body.postId);
      if (!projectId || !postId) throw fail(400, 'BAD_REQUEST', 'That request isn’t valid.');

      // a double click: the same job back
      const same = await jobs.byClientRequest(userId, clientRequestId);
      if (same) {
        if (same.post_id !== postId || same.platform !== platform) throw fail(409, 'BAD_REQUEST', 'That request was already used for another post.');
        return { job: jobOut(same) };
      }

      await loadProject(db, userId, projectId);
      const post = await loadPost(db, userId, postId, projectId);
      const videoForYouTube = platform === 'youtube' && post.media?.kind === 'video';
      if (post.platform !== platform && !videoForYouTube) throw fail(409, 'POST_CHANGED', `This post is for ${NETWORK[post.platform] ?? 'another network'}. Save the post first.`);
      if (!contentMatches(post, body.content, platform)) throw fail(409, 'POST_CHANGED', 'The post changed since you opened it. Save the post first.');

      if (!connections.enabled) throw fail(503, 'CONNECTIONS_NOT_ENABLED', 'Connecting accounts is coming soon. You can still post yourself and mark posts as posted.');
      const status = await statusFor(userId, platform);
      const problem = connectionProblem(platform, status);
      if (problem) throw problem;

      const composed = composeFor(platform, post);
      if (composed.error === 'TEXT_TOO_LONG') throw fail(400, 'BAD_REQUEST', 'This post is too long for X (280 characters, a link counts as 23). Shorten it and save it first.');
      if (composed.error) throw fail(400, 'BAD_REQUEST', 'That network isn’t supported.');

      // the file: the saved post's, or (Instagram) its JPEG copy the app saved beside it
      let media = null;
      const mediaId = Array.isArray(body.content?.mediaIds) && body.content.mediaIds[0] ? String(body.content.mediaIds[0]) : post.media?.id;
      if (mediaId) {
        if (!MEDIA_ID_RE.test(mediaId)) throw fail(400, 'BAD_REQUEST', 'That request isn’t valid.');
        const head = await store.head(userId, mediaId);
        if (!head) throw fail(400, 'MEDIA_UNSUPPORTED', 'The photo or video isn’t saved to your account yet. Open the app while signed in so it can upload, then try again.');
        media = { id: mediaId, type: head.type, size: head.size, kind: mediaKind(head.type) };
      }
      const why = formatProblem(platform, media);
      if (why) throw fail(400, 'MEDIA_UNSUPPORTED', why);
      if (media && pullsMedia(platform, env, media.kind) && !canMakePublicLinks(env)) {
        throw notSetUp('Add MEDIA_URL_SECRET (32+ random bytes) in Replit Secrets.', 'Posting photos and videos from the app isn’t set up yet. Post it yourself for now.');
      }

      // the customer's daily posting cap (X bills each post)
      const tag = await ensureCustomer(db, userId, env);
      const caps = await capsFor(tag);
      if (caps.blocked) throw fail(403, 'CUSTOMER_BLOCKED', 'Posting from the app is paused on this account. Post it yourself for now.');
      const cap = platform === 'x' ? caps.xPostsPerDay : caps.postsPerDay;
      const today = `${utcDay(now())}T00:00:00.000Z`;
      if ((await jobs.countSince(userId, [platform], today)) >= cap) {
        throw fail(429, 'CUSTOMER_CAP', `You’ve reached today’s limit of ${cap} posts on ${NETWORK[platform]} from the app. Post it yourself, or try again tomorrow.`, { period: 'day' });
      }

      const live = await jobs.liveFor(userId, postId, platform);
      if (live) throw fail(409, 'ALREADY_PUBLISHING', `This post is already ${live.state === 'sent' ? 'posted' : 'being posted'} on ${NETWORK[platform]}.`, { job: jobOut(live) });

      const privacy = typeof body.privacy === 'string' ? body.privacy.slice(0, 40) : undefined;
      const ctx = contextFor({ userId, platform, status, composed, media, privacy, job: null });
      const pre = (await ADAPTERS[platform].preflight?.(ctx)) ?? {};

      const made = await jobs.create({ userId, projectId, postId, platform, clientRequestId });
      if (made.existing && made.why === 'same_request') return { job: jobOut(made.row) };
      if (made.existing) throw fail(409, 'ALREADY_PUBLISHING', `This post is already being posted on ${NETWORK[platform]}.`, { job: jobOut(made.row) });
      const row = (await jobs.start(userId, made.row.id)) ?? made.row;
      const runCtx = { ...contextFor({ userId, platform, status, composed, media, privacy, job: row }), ...pre };
      const p = run(runCtx, row, tag).finally(() => running.delete(p));
      running.add(p);
      return { job: jobOut(row) };
    },

    async job(who, jobId) {
      if (!isUuid(jobId)) throw fail(404, 'NOT_FOUND', 'No such post job.');
      await jobs.sweep(who.id);
      const row = await jobs.byId(who.id, jobId);
      if (!row) throw fail(404, 'NOT_FOUND', 'No such post job.');
      return { job: jobOut(row) };
    },

    async list(who, projectId) {
      const id = idOf(projectId);
      if (!id) throw fail(400, 'BAD_REQUEST', 'Which business?');
      await loadProject(db, who.id, id);
      await jobs.sweep(who.id);
      return { jobs: (await jobs.list(who.id, id)).map(jobOut) };
    },

    /** "Check again" on an `unknown` job: one read-only check, at most once per 30 s. Never resends. */
    async check(who, jobId) {
      const userId = who.id;
      if (!isUuid(jobId)) throw fail(404, 'NOT_FOUND', 'No such post job.');
      await jobs.sweep(userId);
      const row = await jobs.byId(userId, jobId);
      if (!row) throw fail(404, 'NOT_FOUND', 'No such post job.');
      if (row.state !== 'unknown') return { job: jobOut(row) };
      // a LinkedIn member's own posts can't be read back: nothing to call
      if (row.provider_ref?.checkable === false) return { job: jobOut(row) };
      const claimed = await jobs.claimCheck(userId, row);
      let post;
      try {
        post = await loadPost(db, userId, row.post_id, row.project_id);
      } catch {
        return { job: jobOut(claimed) };
      }
      const platform = row.platform;
      const adapter = ADAPTERS[platform];
      if (!adapter || !connections.enabled) return { job: jobOut(claimed) };
      const status = await statusFor(userId, platform);
      const ctx = contextFor({ userId, platform, status, composed: composeFor(platform, post), media: null, job: claimed });
      let found = null;
      try {
        found = await adapter.check(ctx, claimed);
      } catch (e) {
        safeLog('posting_check_error', { platform, error: e?.name || 'Error' }, log);
      }
      if (found === null) return { job: jobOut(claimed) };
      let tag = null;
      try {
        tag = await ensureCustomer(db, userId, env);
      } catch {
        /* no tag: the check still answers */
      }
      if (tag) {
        const base = { customer_tag: tag, user_id: userId, project_id: row.project_id, call_id: row.id, outcome: found.found ? 'sent' : 'unknown' };
        await ledger({ ...base, vendor: 'nango', endpoint: `${platform}:check` });
        if (platform === 'x') await ledger({ ...base, vendor: 'x', endpoint: 'x:GET /2/users/{id}/tweets', cost_micro: X_CHECK_COST_MICRO, estimated: true });
      }
      if (found.found) return { job: jobOut(await jobs.finish(userId, row.id, { state: 'sent', url: found.url, ref: found.ref })) };
      if (found.failed) return { job: jobOut(await jobs.finish(userId, row.id, { state: 'failed', errorCode: 'REFUSED', ref: found.ref })) };
      return { job: jobOut((await jobs.byId(userId, row.id)) ?? claimed) };
    },

    /** Startup: jobs a restart left `sending` become `unknown`. */
    async sweepAll() {
      return jobs.sweep(null);
    },
  };
}
