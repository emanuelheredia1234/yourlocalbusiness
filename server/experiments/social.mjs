// Post A/B tests (P4b §S3 "Publish integration", §S5): the posting route's hooks for a variant, and reading each
// posted variant's own numbers from Upload-Post's per-post analytics (our job id is its request_id).
//
// Variants are never posted by the server: the customer presses Post now on each. "Same network, different times"
// (mode times) goes in key order, each at least 12 hours after the one before; Trial Reels may go back to back. The
// first variant posted starts the test (counted in the month's limit) before its job exists; if that job certainly
// failed and nothing else went out, the test goes back to a draft and isn't counted (an `unknown` job never refunds).
// Reads are not writes: a failed read keeps the old numbers and the next tick tries again.

import { fail, safeLog } from '../integrations/common.mjs';
import { CADENCE, GAP_MS, KEYS, UUID_RE, WINDOW, iso, ms } from './config.mjs';
import { startTest } from './start.mjs';
import { decide } from './math.mjs';

/** A job that went out, or may have (it counts as posted for the order, the gap and the refund rule). */
const OUT = ['queued', 'sending', 'sent', 'unknown'];
const isTrial = (m) => m === 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED' || m === 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS';
const NAMES = { a: 'A', b: 'B', c: 'C' };

/** When a post test's deadline is: 7 days after the last planned time (times), 72 h after the last one out (Trial Reels). */
export function postEndsAt(e, variants, now) {
  if (e.mode === 'trial_reels') return null;
  const planned = variants.map((v) => ms(v.planned_at)).filter((t) => t != null);
  return Math.max(now, ...planned) + WINDOW.postTimes;
}

/**
 * deps: { store, billing, connections, now, log }.
 * → { postingHooks: { beforePublish, undoStart, jobCreated, jobFinished }, readPostTest(e, { force }) }
 */
export function createSocialExperiments(deps) {
  const { store, connections, now = () => Date.now(), log = console } = deps;

  async function beforePublish(who, { post, postId, projectId, platform }) {
    const ref = post.experiment;
    const id = typeof ref?.id === 'string' && UUID_RE.test(ref.id) ? ref.id : null;
    const key = KEYS.includes(ref?.key) ? ref.key : null;
    if (!id || !key) throw fail(409, 'POST_CHANGED', 'This post’s A/B test isn’t valid. Save the post first.');
    const e = await store.byId(who.id, id);
    if (!e || e.project_id !== projectId || e.kind !== 'post') throw fail(404, 'NOT_FOUND', 'That A/B test isn’t in your account.');
    const variants = await store.variants(who.id, e.id);
    const v = variants.find((x) => x.key === key);
    if (!v || v.post_id !== postId) throw fail(409, 'POST_CHANGED', 'This post isn’t that version of the A/B test. Save the post first.');
    if (e.network !== platform) throw fail(409, 'POST_CHANGED', 'This A/B test is for another network. Save the post first.');
    if (!['draft', 'running'].includes(e.state)) throw fail(409, 'BAD_REQUEST', 'This A/B test has ended, so its versions can’t be posted from it. Take the post out of the test to post it on its own.');
    if (e.mode === 'trial_reels' && !isTrial(post.instagram?.shareMode)) throw fail(409, 'POST_CHANGED', 'This version is part of a Trial Reels test: save it as a Trial Reel first.');
    const jobs = await store.jobs(who.id, variants.map((x) => x.job_id).filter(Boolean));
    const out = (x) => jobs.some((j) => j.id === x.job_id && OUT.includes(j.state));
    if (e.mode === 'times') {
      const earlier = variants.filter((x) => x.key < key);
      const waiting = earlier.find((x) => !out(x));
      if (waiting) throw fail(409, 'TOO_SOON_AFTER_VARIANT', `Post version ${NAMES[waiting.key]} first: versions go out in order.`);
      const last = Math.max(0, ...earlier.map((x) => ms(jobs.find((j) => j.id === x.job_id)?.requested_at) ?? 0));
      const t = now();
      if (last && t - last < GAP_MS) throw fail(409, 'TOO_SOON_AFTER_VARIANT', 'Versions go out at least 12 hours apart, so each gets its own audience.', { nextAt: iso(last + GAP_MS) });
    }
    if (e.state === 'draft') {
      const { row, started } = await startTest(deps, who, e, { endsAt: e.mode === 'times' ? postEndsAt(e, variants, now()) : null });
      if (row?.state !== 'running') throw fail(409, 'BAD_REQUEST', 'This A/B test can’t start now.');
      return { id: e.id, key, started, mode: e.mode };
    }
    return { id: e.id, key, started: false, mode: e.mode };
  }

  /** The job wasn't made (a double click, the post already live): a start made for it is given back. */
  async function undoStart(userId, ctx) {
    if (!ctx?.started) return;
    const variants = await store.variants(userId, ctx.id);
    if (variants.some((v) => v.job_id)) return;
    await store.swap(userId, ctx.id, 'running', { state: 'draft', started_at: null, counted_month: null, ends_at: null });
  }

  async function jobCreated(userId, ctx, jobId) {
    await store.patchVariant(userId, ctx.id, ctx.key, { job_id: jobId, metrics: {}, metrics_at: null, metrics_error: null });
    // Trial Reels: the deadline is 72 hours after the last one went out
    if (ctx.mode === 'trial_reels') await store.patch(userId, ctx.id, { ends_at: iso(now() + WINDOW.trialReels) });
  }

  /**
   * A variant's job ended. The refund: the test's only job so far certainly failed (never `unknown`) and nothing else
   * went out → back to a draft, not counted.
   */
  async function jobFinished(userId, job) {
    const ref = job?.provider_ref?.experiment;
    if (!ref || !UUID_RE.test(String(ref.id ?? '')) || job.state !== 'failed') return;
    const e = await store.byId(userId, ref.id);
    if (!e || e.state !== 'running' || e.kind !== 'post') return;
    const variants = await store.variants(userId, e.id);
    const others = variants.filter((v) => v.job_id && v.job_id !== job.id);
    const jobs = await store.jobs(userId, others.map((v) => v.job_id));
    if (jobs.some((j) => j.state !== 'failed')) return;
    const back = await store.swap(userId, e.id, 'running', { state: 'draft', started_at: null, counted_month: null, ends_at: null, result: {} });
    if (back) safeLog('experiment_refunded', { reason: 'first_job_failed' }, log);
  }

  /**
   * Read a post test's results (the hourly job, or "Update results" with force) and recompute its verdict.
   * → { row, busy?: true } (busy: the analytics limit is used up; the rest waits for the next tick).
   */
  async function readPostTest(e, { force = false } = {}) {
    const t = now();
    const userId = e.user_id;
    const variants = await store.variants(userId, e.id);
    const jobs = await store.jobs(userId, variants.map((v) => v.job_id).filter(Boolean));
    const posts = await store.posts(userId, variants.map((v) => v.post_id).filter(Boolean));
    const endsAt = ms(e.ends_at);
    let busy = false;
    for (const v of variants) {
      const job = jobs.find((j) => j.id === v.job_id);
      if (!job || job.state !== 'sent' || busy) continue;
      const postedAt = ms(job.finished_at) ?? ms(job.requested_at) ?? t;
      if (endsAt != null && t > endsAt + CADENCE.after) continue;
      const every = t - postedAt < CADENCE.earlyFor ? CADENCE.early : CADENCE.late;
      const last = ms(v.metrics_at);
      if (!force && last != null && t - last < every) continue;
      let got;
      try {
        got = await connections.postMetrics(userId, e.network, { projectId: e.project_id, requestId: job.id });
      } catch (err) {
        if (err?.kind === 'busy') {
          busy = true;
          continue;
        }
        got = { error: 'unavailable' };
      }
      if (!got) continue;
      if (got.metrics) await store.patchVariant(userId, e.id, v.key, { metrics: got.metrics, metrics_at: iso(t), metrics_error: null });
      else await store.patchVariant(userId, e.id, v.key, { metrics_error: String(got.error ?? 'unavailable').slice(0, 40) });
    }
    const fresh = await store.variants(userId, e.id);
    const result = postResult(e, fresh, jobs, posts, t);
    const finished = endsAt != null && t >= endsAt && !['keep_going'].includes(result.verdict) && result.reason !== 'not_posted';
    const row = (await store.patch(userId, e.id, { result, ...(finished && e.state === 'running' ? { state: 'finished' } : {}) })) ?? e;
    return { row, ...(busy ? { busy: true } : {}) };
  }

  /** The verdict from the variants as they are (posts gone or jobs failed are missing; unposted ones wait). */
  function postResult(e, variants, jobs, posts, t) {
    const endsAt = ms(e.ends_at);
    const ended = endsAt != null && t >= endsAt;
    const rows = variants.map((v) => {
      const job = jobs.find((j) => j.id === v.job_id);
      const gone = v.post_id && !posts.some((p) => p.id === v.post_id);
      const failed = job && job.state !== 'sent';
      return { key: v.key, metrics: v.metrics ?? {}, missing: !!(gone || failed || (!job && ended)), waiting: !job };
    });
    const delayed = variants.some((v) => v.metrics_error === 'delayed');
    if (!rows.some((r) => r.missing) && rows.some((r) => r.waiting)) return { verdict: 'keep_going', reason: 'not_posted', metric: e.metric, computedAt: iso(t), perVariant: {}, minimums: null, ...(delayed ? { delayed: true } : {}) };
    const out = decide({ kind: 'post', mode: e.mode, changed: e.changed, metric: e.metric, endsAt, now: t, variants: rows });
    return delayed ? { ...out, delayed: true } : out;
  }

  return { postingHooks: { beforePublish, undoStart, jobCreated, jobFinished }, readPostTest, postResult };
}
