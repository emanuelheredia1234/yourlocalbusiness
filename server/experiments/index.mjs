// A/B tests (P4b): "Make variations" of a post, an email or the SEO page, and which one did better.
// docs/integrations-setup.md §14; spec P4b §S3.
//
//   GET    /api/experiments?projectId=&kind=&state=   → { experiments: [... with variants (no HTML), result], usage }
//   GET    /api/experiments/usage                     → { used, limit, resetsAt }
//   GET    /api/experiments/trial-reels/eligibility?projectId= → { eligible: true|false|'unknown', reason?, followers?, checkedAt }
//   GET    /api/experiments/<id>                      → { experiment }
//   POST   /api/experiments                           { projectId, kind, mode, changed, network?, metric?, subjectRef,
//                                                       name?, variants: [{ key, label, postId?, plannedAt?, shareMode? }] }
//                                                     → { experiment } (a draft)
//   PATCH  /api/experiments/<id>                      a draft: name, labels, planned times, adding or removing C;
//                                                     running: only planned times of variants not yet posted
//   POST   /api/experiments/<id>/page                 { html, sha256 } → version B stored, the split starts
//   POST   /api/experiments/<id>/email                { variants: { a, b }, settings } → the Omnisend A/B draft
//   POST   /api/experiments/<id>/refresh              "Update results": one read now (409 TOO_SOON within 15 minutes)
//   POST   /api/experiments/<id>/stop                 running → stopped (a page goes back to A); a draft → cancelled
//   POST   /api/experiments/<id>/winner               { key, override? } "Use the winner" → { experiment, learning }
//   DELETE /api/experiments/<id>                      a draft or a cancelled test
//
// Every route: same site, signed in, the business the user's own (404 otherwise), errors as { error, code } in our
// words (the owner also gets the migration's name), a rate bucket per user. Nothing here posts or sends: posts go
// out through Post now (server/social/publish.mjs, with this module's postingHooks), email drafts are only drafts.
// The hourly `experiment-results` job (tick.mjs) reads results; the page split is server/experiments/pages.mjs.
// Env: EXPERIMENTS (off), EXPERIMENT_READS_PER_TICK (40), EXPERIMENT_COOKIE_SECRET (optional).

import { createKit, fromDbError } from '../analytics/http.mjs';
import { errorBody, fail, notSetUp, safeLog, stubRoutes } from '../integrations/common.mjs';
import { ROUTE_PREFIXES, RATE_BUCKETS } from '../integrations/contracts.mjs';
import { CHANGED, EXPERIMENTS_MIGRATION, HOUR_MS, KEYS, KINDS, METRICS, MODES, NETWORKS, POST_ID_RE, PROJECT_ID_RE, REFRESH_EVERY_MS, SHARE_MODES, UUID_RE, experimentSettings, isTrialMode, iso, ms } from './config.mjs';
import { createExperimentStore } from './store.mjs';
import { createSocialExperiments, postEndsAt } from './social.mjs';
import { createPageSplit } from './pages.mjs';
import { createEmailExperiments } from './email.mjs';
import { usageFor } from './start.mjs';
import { createExperimentJobs } from './tick.mjs';

const NETWORK_NAMES = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', linkedin: 'LinkedIn', x: 'X', youtube: 'YouTube' };
const DIMENSION = { hook: 'hooks', caption: 'captions', visual: 'visuals', cta: 'calls to action', time: 'posting times', subject: 'subject lines', opening: 'openings', headline: 'headlines', hero: 'heroes' };
const METRIC_WORD = { engagement_rate: 'engagement', views: 'views', reach: 'reach', open_rate: 'opens', click_rate: 'clicks', lead_rate: 'leads' };
const clip = (s, n) => Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');

/** The default metric for a test. */
export function defaultMetric(kind, mode, changed) {
  if (kind === 'page') return 'lead_rate';
  if (kind === 'email') return changed === 'opening' ? 'click_rate' : 'open_rate';
  return mode === 'trial_reels' ? 'views' : 'engagement_rate';
}

/** What the app sees of a test (camelCase; never a page version's HTML, the claim or the counted window's key). */
export function describeExperiment(e, variants = []) {
  if (!e) return null;
  const result = e.result && typeof e.result === 'object' ? e.result : {};
  return {
    id: e.id,
    projectId: e.project_id,
    kind: e.kind,
    mode: e.mode,
    changed: e.changed,
    network: e.network ?? null,
    metric: e.metric,
    subjectRef: e.subject_ref,
    name: e.name ?? '',
    state: e.state,
    startedAt: e.started_at ?? null,
    endsAt: e.ends_at ?? null,
    result,
    delayed: result.delayed === true || variants.some((v) => v.metrics_error === 'delayed'),
    winner: e.winner ?? null,
    winnerUsedAt: e.winner_used_at ?? null,
    counted: !!e.counted_month,
    lastReadAt: e.last_read_at ?? null,
    refreshAt: e.last_read_at ? iso(ms(e.last_read_at) + REFRESH_EVERY_MS) : null,
    createdAt: e.created_at ?? null,
    variants: variants
      .filter((v) => v.experiment_id === e.id)
      .sort((x, y) => (x.key < y.key ? -1 : 1))
      .map((v) => ({
        key: v.key,
        label: v.label ?? '',
        postId: v.post_id ?? null,
        jobId: v.job_id ?? null,
        plannedAt: v.planned_at ?? null,
        shareMode: v.share_mode ?? null,
        hasHtml: !!v.html_sha256,
        omnisendCampaignId: v.omnisend_campaign_id ?? null,
        metrics: v.metrics && typeof v.metrics === 'object' ? v.metrics : {},
        metricsAt: v.metrics_at ?? null,
        metricsError: v.metrics_error ?? null,
        visitors: Number(v.visitors) || 0,
        views: Number(v.views) || 0,
        leads: Number(v.leads) || 0,
      })),
  };
}

/** The short "learned" line the app saves as a Brain skill (built without AI). */
export function learningOf(e, variants, key, { override = false } = {}) {
  const label = (k) => clip(variants.find((v) => v.key === k)?.label || `Version ${k.toUpperCase()}`, 80);
  const winnerLabel = label(key);
  const loserLabels = variants.map((v) => v.key).filter((k) => k !== key).map(label);
  const lift = override ? null : Number.isFinite(e.result?.lift) ? e.result.lift : null;
  const where = e.kind === 'post' ? ` on ${NETWORK_NAMES[e.network] ?? 'social'}` : e.kind === 'page' ? ' on the page' : ' in email';
  const how = lift != null ? `: +${lift}% ${METRIC_WORD[e.metric] ?? ''}`.trimEnd() : override ? ' (your pick)' : '';
  const summary = clip(`${DIMENSION[e.changed] ?? 'Versions'}: “${winnerLabel}” beat “${loserLabels.join('”, “')}”${where}${how}`, 240);
  return { changed: e.changed, winnerLabel, loserLabels, metric: e.metric, lift, summary, ...(override ? { override: true } : {}) };
}

/**
 * deps: the integration modules' own (server/integrations/wiring.mjs): auth, db, send, readJson, limit,
 * corsHeaders, sameOrigin, env, now, log, billing, connections, trialReels, omnisend, storage.
 */
export function createExperiments(deps) {
  const { auth, db, send, readJson, limit = () => false, rateLimited = () => false, corsHeaders = () => ({}), sameOrigin = () => true, env = process.env, now = () => Date.now(), log = console, billing = null, connections = null, trialReels = null, omnisend = null } = deps;
  const settings = experimentSettings(env);
  const enabled = !settings.off && !!db?.enabled && !!auth?.enabled;
  const config = () => ({ enabled });
  const notes = () => {
    if (settings.off) return ['A/B tests: off (EXPERIMENTS=off). Pages serve one version.'];
    if (!enabled) return ['A/B tests: off (they need accounts and SUPABASE_URL and SUPABASE_SECRET_KEY).'];
    return [`A/B tests: on (needs ${EXPERIMENTS_MIGRATION}); up to ${settings.readsPerTick} tests’ results read per hourly tick. Page splits sign their cookies with ${settings.ownSecret ? 'EXPERIMENT_COOKIE_SECRET' : 'a key derived from SUPABASE_SECRET_KEY'}.`];
  };
  if (!enabled) {
    const stub = stubRoutes({ prefixes: [ROUTE_PREFIXES.experiments], send, corsHeaders, message: 'A/B tests aren’t set up on this app yet.' });
    return { ...stub, enabled: false, config, notes, cronJobs: () => [], postingHooks: null, pageHooks: null, setPages() {} };
  }

  const store = createExperimentStore({ db });
  const ctx = { store, billing, connections, now, log };
  const social = createSocialExperiments(ctx);
  const split = createPageSplit({ ...ctx, db, secret: settings.cookieSecret });
  const email = createEmailExperiments({ ...ctx, omnisend });
  const jobs = createExperimentJobs({ ...ctx, social, split, email, settings });
  const kit = createKit({ auth, send, readJson, sameOrigin, corsHeaders, rateLimited, limit });
  const reply = (req, res, status, body) => send(res, status, body, { ...corsHeaders(req), 'cache-control': 'no-store' });

  const dbError = (e) => {
    if (e?.name === 'DbError' && e.code === 'NOT_SET_UP') {
      safeLog('experiments_not_set_up', { hint: `run ${EXPERIMENTS_MIGRATION}` }, log);
      return notSetUp(`Run ${EXPERIMENTS_MIGRATION} in Supabase → SQL Editor.`);
    }
    if (e?.name === 'DbError' && e.code === 'CONFLICT' && /experiment_variants_one_per_post/.test(String(e.constraint ?? ''))) return fail(409, 'BAD_REQUEST', 'One of these posts is already a version in another A/B test.');
    return fromDbError(e);
  };

  const notFound = () => fail(404, 'NOT_FOUND', 'That A/B test isn’t in your account.');
  const projectOf = (v) => {
    if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) throw fail(404, 'NOT_FOUND', 'That business isn’t in your account.');
    return v;
  };
  async function business(userId, projectId) {
    if (!(await store.project(userId, projectOf(projectId)))) throw fail(404, 'NOT_FOUND', 'That business isn’t in your account.');
    return projectId;
  }
  async function own(who, id) {
    if (!UUID_RE.test(String(id))) throw notFound();
    const e = await store.byId(who.id, id);
    if (!e) throw notFound();
    return e;
  }
  const out = async (who, e) => describeExperiment(e, await store.variants(who.id, e.id));
  const plannedOf = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const t = ms(v);
    if (t == null) throw fail(400, 'BAD_REQUEST', 'A planned time isn’t a time.');
    return iso(t);
  };
  const labelOf = (v) => {
    if (v !== undefined && typeof v !== 'string') throw fail(400, 'BAD_REQUEST', 'A label must be text.');
    const s = clip(v ?? '', 81);
    if (Array.from(s).length > 80) throw fail(400, 'BAD_REQUEST', 'A label can be at most 80 characters.');
    return s;
  };

  /** Check a post variant's post: the user's, in that business, on that network (a Trial Reel: an Instagram video). */
  async function checkPosts(who, e, list) {
    const ids = list.map((v) => v.postId);
    if (ids.some((id) => typeof id !== 'string' || !POST_ID_RE.test(id))) throw fail(400, 'BAD_REQUEST', 'Each version needs its saved post.');
    if (new Set(ids).size !== ids.length) throw fail(400, 'BAD_REQUEST', 'Each version needs a post of its own.');
    const posts = await store.posts(who.id, ids);
    for (const id of ids) {
      const p = posts.find((x) => x.id === id)?.data;
      if (!p || p.projectId !== e.project_id) throw fail(404, 'NOT_FOUND', 'That post isn’t in your account.');
      const videoForYouTube = e.network === 'youtube' && p.media?.kind === 'video';
      if (p.platform !== e.network && !videoForYouTube) throw fail(400, 'BAD_REQUEST', `Every version must be a post for ${NETWORK_NAMES[e.network]}.`);
      if (e.mode === 'trial_reels' && !(p.media?.kind === 'video' || p.format === 'video')) throw fail(400, 'BAD_REQUEST', 'Trial Reels are for Instagram videos only.');
    }
    const used = await store.variantsOfPosts(who.id, ids);
    if (used.some((u) => u.experiment_id !== e.id)) throw fail(409, 'BAD_REQUEST', 'One of these posts is already a version in another A/B test.');
  }

  async function create(req, res, who) {
    const b = await kit.body(req);
    const projectId = await business(who.id, b.projectId);
    const kind = KINDS.includes(b.kind) ? b.kind : null;
    if (!kind) throw fail(400, 'BAD_REQUEST', 'Say what to test: a post, an email or the page.');
    if (!MODES[kind].includes(b.mode)) throw fail(400, 'BAD_REQUEST', 'That way of testing doesn’t fit.');
    if (!CHANGED[kind].includes(b.changed)) throw fail(400, 'BAD_REQUEST', 'Choose the one thing that differs.');
    const metric = b.metric === undefined || b.metric === null ? defaultMetric(kind, b.mode, b.changed) : b.metric;
    if (!METRICS[kind].includes(metric)) throw fail(400, 'BAD_REQUEST', 'That measure doesn’t fit this test.');
    let network = null;
    if (kind === 'post') {
      network = NETWORKS.includes(b.network) ? b.network : null;
      if (!network) throw fail(400, 'BAD_REQUEST', 'Which network?');
      if (b.mode === 'trial_reels' && network !== 'instagram') throw fail(400, 'BAD_REQUEST', 'Trial Reels are for Instagram videos only.');
    }
    const subjectRef = typeof b.subjectRef === 'string' ? b.subjectRef : '';
    if (!subjectRef || subjectRef.length > 120) throw fail(400, 'BAD_REQUEST', 'What does this test?');
    if (kind === 'page' && subjectRef !== `seo:${projectId}`) throw fail(400, 'BAD_REQUEST', 'Page tests are for this business’s SEO page.');
    if (kind === 'email' && !/^[A-Za-z0-9_-]{1,60}:[A-Za-z0-9_-]{1,59}$/.test(subjectRef)) throw fail(400, 'BAD_REQUEST', 'Which email step?');
    const name = typeof b.name === 'string' ? clip(b.name, 120) : '';
    const list = Array.isArray(b.variants) ? b.variants : [];
    const max = kind === 'post' ? 3 : 2;
    if (list.length < 2 || list.length > max) throw fail(400, 'BAD_REQUEST', kind === 'post' ? 'A test has the original and one or two new versions.' : 'A test has the original and one new version.');
    if (list.some((v, i) => v?.key !== KEYS[i])) throw fail(400, 'BAD_REQUEST', 'Versions are A, B and C, in order.');
    const rows = list.map((v) => {
      const shareMode = v.shareMode === undefined || v.shareMode === null ? (b.mode === 'trial_reels' ? 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS' : null) : v.shareMode;
      if (shareMode !== null && !SHARE_MODES.includes(shareMode)) throw fail(400, 'BAD_REQUEST', 'That Reel mode isn’t one Instagram has.');
      if (b.mode === 'trial_reels' && !isTrialMode(shareMode)) throw fail(400, 'BAD_REQUEST', 'Each version of a Trial Reels test is a Trial Reel.');
      if (b.mode !== 'trial_reels' && isTrialMode(shareMode)) throw fail(400, 'BAD_REQUEST', 'Trial Reels go in a Trial Reels test.');
      return { key: v.key, user_id: who.id, label: labelOf(v.label), post_id: kind === 'post' ? v.postId : null, planned_at: kind === 'post' ? plannedOf(v.plannedAt) : null, share_mode: shareMode };
    });
    const draft = { user_id: who.id, project_id: projectId, kind, mode: b.mode, changed: b.changed, network, metric, subject_ref: subjectRef, name, state: 'draft' };
    if (kind === 'post') {
      if (subjectRef !== list[0].postId) throw fail(400, 'BAD_REQUEST', 'Version A is the original post.');
      await checkPosts(who, draft, list);
    }
    if (kind === 'post' && b.mode === 'trial_reels' && trialReels) draft.result = { eligibility: await trialReels.eligibility(who.id, projectId) };
    const e = await store.insert(draft);
    try {
      await store.insertVariants(rows.map((r) => ({ ...r, experiment_id: e.id })));
    } catch (err) {
      await store.remove(who.id, e.id, ['draft']).catch(() => {});
      throw err;
    }
    return reply(req, res, 201, { experiment: await out(who, e) });
  }

  async function patch(req, res, who, id) {
    const b = await kit.body(req);
    const e = await own(who, id);
    const variants = await store.variants(who.id, e.id);
    if (e.state === 'draft') {
      if (b.name !== undefined) await store.patch(who.id, e.id, { name: typeof b.name === 'string' ? clip(b.name, 120) : '' });
      if (b.removeVariant !== undefined) {
        if (b.removeVariant !== 'c' || !variants.some((v) => v.key === 'c')) throw fail(400, 'BAD_REQUEST', 'Only version C can be taken out.');
        await store.removeVariant(who.id, e.id, 'c');
      }
      if (b.addVariant !== undefined) {
        const v = b.addVariant;
        if (e.kind !== 'post' || variants.some((x) => x.key === 'c') || v?.key !== 'c') throw fail(400, 'BAD_REQUEST', 'A test can have one more version, C.');
        const shareMode = v.shareMode ?? (e.mode === 'trial_reels' ? 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS' : null);
        if (e.mode === 'trial_reels' ? !isTrialMode(shareMode) : shareMode !== null && shareMode !== 'CUSTOM') throw fail(400, 'BAD_REQUEST', 'That Reel mode doesn’t fit this test.');
        await checkPosts(who, e, [...variants.filter((x) => x.key !== 'c').map((x) => ({ postId: x.post_id })), { postId: v.postId }]);
        await store.insertVariants([{ experiment_id: e.id, key: 'c', user_id: who.id, label: labelOf(v.label), post_id: v.postId, planned_at: plannedOf(v.plannedAt), share_mode: shareMode }]);
      }
    } else if (e.state === 'running') {
      if (b.name !== undefined || b.addVariant !== undefined || b.removeVariant !== undefined || (Array.isArray(b.variants) && b.variants.some((v) => v.label !== undefined))) throw fail(409, 'BAD_REQUEST', 'Only the planned times of versions not posted yet can change while the test runs.');
    } else throw fail(409, 'BAD_REQUEST', 'This A/B test has ended.');
    if (Array.isArray(b.variants)) {
      for (const v of b.variants.slice(0, 3)) {
        const cur = variants.find((x) => x.key === v?.key);
        if (!cur) throw fail(400, 'BAD_REQUEST', 'No such version.');
        const change = {};
        if (v.label !== undefined) change.label = labelOf(v.label);
        if (v.plannedAt !== undefined) {
          if (e.kind !== 'post') throw fail(400, 'BAD_REQUEST', 'Only posts have planned times.');
          if (e.state === 'running' && cur.job_id) throw fail(409, 'BAD_REQUEST', 'That version has been posted.');
          change.planned_at = plannedOf(v.plannedAt);
        }
        if (Object.keys(change).length) await store.patchVariant(who.id, e.id, cur.key, change);
      }
      // a running "different times" test: its deadline follows the last planned time
      if (e.state === 'running' && e.mode === 'times') await store.patch(who.id, e.id, { ends_at: iso(postEndsAt(e, await store.variants(who.id, e.id), ms(e.started_at) ?? now())) });
    }
    return reply(req, res, 200, { experiment: await out(who, await store.byId(who.id, e.id)) });
  }

  async function refresh(req, res, who, id) {
    const e = await own(who, id);
    const last = ms(e.last_read_at);
    const t = now();
    if (last != null && t - last < REFRESH_EVERY_MS) throw fail(409, 'TOO_SOON', 'Results were updated a few minutes ago. Try again shortly.', { nextAt: iso(last + REFRESH_EVERY_MS) });
    if (e.state !== 'running' && e.state !== 'finished') return reply(req, res, 200, { experiment: await out(who, e) });
    // claim the read (a compare-and-swap on the last read time): two presses make one read
    const claimed = await db.update('experiments', { id: e.id, user_id: who.id, last_read_at: e.last_read_at ?? null }, { last_read_at: iso(t) }, { returning: true });
    if (!claimed.length) throw fail(409, 'TOO_SOON', 'Results were updated a moment ago.', { nextAt: iso(t + REFRESH_EVERY_MS) });
    let row = claimed[0];
    if (e.kind === 'post') {
      const got = await social.readPostTest(row, { force: true });
      if (got.busy) throw fail(429, 'RATE_LIMITED', 'Results are busy right now. Try again in a few minutes.');
      row = got.row;
    } else if (e.kind === 'email') row = (await email.readEmailTest(row, { force: true })).row;
    else row = await split.recompute(row);
    return reply(req, res, 200, { experiment: await out(who, row) });
  }

  async function stop(req, res, who, id) {
    const e = await own(who, id);
    let row = null;
    if (e.state === 'draft') row = await store.swap(who.id, e.id, 'draft', { state: 'cancelled' });
    else if (e.state === 'running') {
      if (e.kind === 'page') await split.flush().catch(() => {});
      row = await store.swap(who.id, e.id, 'running', { state: 'stopped', result: { ...(e.result ?? {}), stoppedBy: 'you', stoppedAt: iso(now()) } });
      if (row && e.kind === 'page') split.forget(row);
    } else return reply(req, res, 200, { experiment: await out(who, e) });
    return reply(req, res, 200, { experiment: await out(who, row ?? (await store.byId(who.id, e.id))) });
  }

  async function winner(req, res, who, id) {
    const b = await kit.body(req);
    const e = await own(who, id);
    const key = KEYS.includes(b.key) ? b.key : null;
    const variants = await store.variants(who.id, e.id);
    if (!key || !variants.some((v) => v.key === key)) throw fail(400, 'BAD_REQUEST', 'Which version?');
    const override = b.override === true;
    if (e.winner && e.winner !== key) throw fail(409, 'BAD_REQUEST', `Version ${e.winner.toUpperCase()} is already the winner of this test.`);
    if (!e.winner) {
      if (!['running', 'finished', 'stopped'].includes(e.state)) throw fail(409, 'BAD_REQUEST', 'This A/B test hasn’t started.');
      const r = e.result ?? {};
      const clear = r.verdict === 'winner' && r.winner === key;
      const anyway = override && ['too_close', 'tie'].includes(r.verdict);
      if (!clear && !anyway) throw fail(409, 'BAD_REQUEST', r.verdict === 'winner' ? `The winner is version ${String(r.winner).toUpperCase()}.` : 'There’s no clear winner yet. When the test is too close to call, you can pick one anyway.');
    }
    if (e.kind === 'page' && e.state === 'running') await split.flush().catch(() => {});
    const t = iso(now());
    let row = e.winner ? e : await store.swap(who.id, e.id, ['running', 'finished', 'stopped'], { winner: key, winner_used_at: t, state: e.state === 'running' ? 'finished' : e.state, result: { ...(e.result ?? {}), ...(override ? { pickedByYou: true } : {}) } });
    if (!row) throw fail(409, 'BAD_REQUEST', 'This A/B test changed. Try again.');
    if (e.kind === 'page') {
      split.forget(row);
      // version B won: the page itself is republished with it (one call, never retried by itself)
      if (key === 'b') await split.useB(who, row);
    }
    row = (await store.byId(who.id, e.id)) ?? row;
    return reply(req, res, 200, { experiment: await out(who, row), learning: learningOf(row, variants, key, { override: !!row.result?.pickedByYou }) });
  }

  async function remove(req, res, who, id) {
    const e = await own(who, id);
    if (!['draft', 'cancelled'].includes(e.state)) throw fail(409, 'BAD_REQUEST', e.state === 'running' ? 'Stop the test first.' : 'An A/B test that ran is kept with its results.');
    await store.remove(who.id, e.id, ['draft', 'cancelled']);
    return reply(req, res, 200, { ok: true });
  }

  async function list(req, res, url, who) {
    const projectId = await business(who.id, url.searchParams.get('projectId'));
    const kind = url.searchParams.get('kind');
    const state = url.searchParams.get('state');
    if (kind && !KINDS.includes(kind)) throw fail(400, 'BAD_REQUEST', 'Unknown kind.');
    if (state && !['draft', 'running', 'finished', 'stopped', 'cancelled'].includes(state)) throw fail(400, 'BAD_REQUEST', 'Unknown state.');
    const rows = await store.list(who.id, projectId, { kind, state });
    const variants = await store.variants(who.id, rows.map((r) => r.id));
    return reply(req, res, 200, { experiments: rows.map((r) => describeExperiment(r, variants)), usage: await usageFor(ctx, who) });
  }

  async function one(req, res, who, id) {
    let e = await own(who, id);
    // a page split's numbers are counted here, not read: its verdict is worked out on each look
    if (e.kind === 'page' && e.state === 'running') e = await split.recompute(e);
    return reply(req, res, 200, { experiment: await out(who, e) });
  }

  async function eligibility(req, res, url, who) {
    const projectId = await business(who.id, url.searchParams.get('projectId'));
    if (!trialReels) return reply(req, res, 200, { eligible: false, reason: 'not_connected', checkedAt: iso(now()) });
    return reply(req, res, 200, await trialReels.eligibility(who.id, projectId));
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    const base = ROUTE_PREFIXES.experiments;
    if (p !== base && !p.startsWith(`${base}/`)) return false;
    const who = await kit.user(req, res);
    if (!who) {
      req.resume?.();
      return true;
    }
    try {
      const rest = p.slice(base.length).replace(/^\//, '');
      const m = req.method;
      const bucket = m === 'GET' ? RATE_BUCKETS.experimentsRead : RATE_BUCKETS.experiments;
      if (kit.limited(req, res, { bucket }, who.id)) return true;
      if (rest === '' && m === 'GET') return void (await list(req, res, url, who)) || true;
      if (rest === '' && m === 'POST') return void (await create(req, res, who)) || true;
      if (rest === 'usage' && m === 'GET') return void reply(req, res, 200, await usageFor(ctx, who)) || true;
      if (rest === 'trial-reels/eligibility' && m === 'GET') return void (await eligibility(req, res, url, who)) || true;
      const parts = /^([^/]+)(?:\/(page|email|refresh|stop|winner))?$/.exec(rest);
      if (parts) {
        const [, id, action] = parts;
        if (!action && m === 'GET') return void (await one(req, res, who, id)) || true;
        if (!action && m === 'PATCH') return void (await patch(req, res, who, id)) || true;
        if (!action && m === 'DELETE') return void (await remove(req, res, who, id)) || true;
        if (action === 'page' && m === 'POST') {
          const e = await own(who, id);
          const b = await kit.body(req, 1_700_000);
          const row = await split.startSplit(who, e, b);
          return void reply(req, res, 200, { experiment: await out(who, row) }) || true;
        }
        if (action === 'email' && m === 'POST') {
          const e = await own(who, id);
          const b = await kit.body(req, 160 * 1024);
          const got = await email.createDraft(who, e, b);
          return void reply(req, res, 201, { experiment: await out(who, got.row), campaign: got.campaign, ...(got.split ? { split: got.split } : {}) }) || true;
        }
        if (action === 'refresh' && m === 'POST') return void (await refresh(req, res, who, id)) || true;
        if (action === 'stop' && m === 'POST') return void (await stop(req, res, who, id)) || true;
        if (action === 'winner' && m === 'POST') return void (await winner(req, res, who, id)) || true;
      }
      reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
    } catch (e) {
      if (!(e?.name === 'IntegrationError' || e?.name === 'DbError')) safeLog('experiments_route_failed', { error: e?.name || 'Error', code: e?.code }, log);
      const { status, body } = errorBody(dbError(e), who);
      if (!res.headersSent) reply(req, res, status, body);
    }
    return true;
  }

  return {
    enabled: true,
    handle,
    config,
    notes,
    /** server/social/publish.mjs: a variant's order, gap, start and refund */
    postingHooks: social.postingHooks,
    /** server/pages.mjs and server/leads.mjs: the page split (serving, counting, lead attribution) */
    pageHooks: split.pageHooks,
    /** the pages module, for republishing a page with version B ("Use the winner") */
    setPages: (pages) => split.setPages(pages),
    /** for tests */
    store,
    social,
    split,
    email,
    jobs,
    cronJobs: () => [{ name: 'experiment-results', everyMs: HOUR_MS, leaveMs: 2_000, minMs: 8_000, run: (c) => jobs.run(c) }],
    async onStart() {
      split.startTimer();
    },
    // rows go with the account (foreign keys); nothing is held anywhere else
    async forgetUser() {},
    async unforgetUser() {},
    async userDeleted(userId) {
      split.forgetUser(userId);
    },
  };
}
