// The Marketing hub's Update: one run per business at most every 15 minutes (claimed atomically in the database),
// four sources fetched in the background, each writing its own snapshot (a failed source keeps its previous good
// data), a history row per source, and the run row updated as each source finishes.
//
//   const refresher = createRefresher({ db, storage, treg, connections, omnisend, env, now, log });
//   await refresher.start(user, projectId, sources?) → RefreshRun (the background work goes on)
//   refresher.idle() → a promise that settles when no run is in progress (tests)

import crypto from 'node:crypto';
import { ensureCustomer, fail, safeLog, seoPageIdFor } from '../integrations/common.mjs';
import { readSteps } from '../seo/steps.mjs';
import { ANALYTICS_SOURCES } from '../integrations/contracts.mjs';
import { appOrigin } from '../seo/sitemap.mjs';
import { createRunner, publicCode } from './runner.mjs';
import { handlesOf } from './handles.mjs';
import { socialPlan, socialSource } from './sources/social.mjs';
import { adsPlan, adsSource } from './sources/ads.mjs';
import { seoSource } from './sources/seo.mjs';
import { emailSource } from './sources/email.mjs';
import { appendHistory, latestRun, loadProject, ownSeoPage, readSettings, readSnapshot, runOut, saveResolved, writeSnapshot, STUCK_RUN_MS } from './snapshots.mjs';

export const RUN_EVERY_MS = 15 * 60_000;
/** The least an Update is expected to cost (one metered call): the pre-check blocks when even that won't fit. */
const MIN_ESTIMATE_MICRO = 5000;
const iso = (ms) => new Date(ms).toISOString();

/** A source's outcome code from a thrown error (a TregError kind, a DbError or anything else). */
function codeOf(e) {
  return publicCode(e) ?? 'UNAVAILABLE';
}

/**
 * The app-side cap pre-check (spec §3.1): treg spend (vendor 'treg' rows only; estimated Upload-Post, Zernio, Nango and X rows never
 * count) today and this month, and today's treg calls, against the customer's caps (their row, else '*').
 */
export async function precheckCaps(db, customerTag, now, estimateMicro = MIN_ESTIMATE_MICRO) {
  const caps = await db.select('billing_caps', { customer_tag: ['in', [customerTag, '*']] }, { limit: 2 }).catch(() => []);
  const own = caps.find((c) => c.customer_tag === customerTag) ?? {};
  const def = caps.find((c) => c.customer_tag === '*') ?? {};
  const pick = (k) => (own[k] ?? def[k] ?? null);
  if ((own.status ?? def.status) === 'blocked') throw fail(403, 'CUSTOMER_BLOCKED', 'Analytics are paused for your account. Contact support.');
  const daily = pick('daily_cap_micro');
  const monthly = pick('monthly_cap_micro');
  const calls = pick('calls_per_day');
  if (daily == null && monthly == null && calls == null) return;
  const d = new Date(now);
  const monthStart = iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const dayStart = iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const rows = await db.select('usage_ledger', { customer_tag: customerTag, vendor: 'treg', estimated: false, created_at: ['gte', monthStart] }, { select: 'cost_micro,created_at', limit: 20000 });
  let month = 0;
  let today = 0;
  let todayCalls = 0;
  for (const r of rows) {
    const c = Number(r.cost_micro) || 0;
    month += c;
    if (String(r.created_at) >= dayStart) {
      today += c;
      todayCalls += 1;
    }
  }
  if ((daily != null && today + estimateMicro > Number(daily)) || (calls != null && todayCalls >= Number(calls))) {
    throw fail(429, 'CUSTOMER_CAP', 'You’ve reached today’s analytics limit. It resets at midnight UTC.', { period: 'day' });
  }
  if (monthly != null && month + estimateMicro > Number(monthly)) throw fail(429, 'CUSTOMER_CAP', 'You’ve reached this month’s analytics limit.', { period: 'month' });
}

export function createRefresher({ db, storage = null, treg, connections, omnisend = null, env = process.env, now = () => Date.now(), log = console, fetch = globalThis.fetch }) {
  const running = new Set();

  /** Everything a run reads up front (server-side only: never from the request body). */
  async function gather(userId, projectId) {
    const project = await loadProject(db, userId, projectId);
    const { settings, resolved } = await readSettings(db, userId, projectId);
    const statuses = await connections.status(userId, { projectId }).catch(() => []);
    const page = await ownSeoPage(db, userId, projectId, appOrigin(env));
    // a custom domain is read from the owner's Search Console property once the owner has verified it there
    const customVerified = page?.host === 'custom' ? (await readSteps(db, userId, seoPageIdFor(projectId)).catch(() => ({}))).verify?.outcome === 'ok' : false;
    const emailOn = typeof omnisend?.connected === 'function' ? await omnisend.connected(userId).catch(() => false) : false;
    return { project, settings, resolved, statuses, page, emailOn, customVerified };
  }

  /** What there is to fetch; empty means 422 NOTHING_TO_UPDATE (and nothing is spent). */
  function whatToFetch(g) {
    const social = socialPlan(g.project, g.statuses).networks.length > 0;
    const ads = (() => {
      const p = adsPlan(g.settings, g.statuses);
      return p.own.length > 0 || p.competitors.length > 0;
    })();
    const seo = (g.settings.keywords || []).length > 0 || !!g.page;
    const email = g.emailOn;
    return { social, ads, seo, email };
  }

  async function runSources(ctx, g, which) {
    const runner = createRunner({ treg, connections, ctx });
    const sources = Object.fromEntries(ANALYTICS_SOURCES.map((s) => [s, which.includes(s) ? 'queued' : 'skipped']));
    let chain = Promise.resolve();
    // one writer for the run row at a time, so sources finishing together don't overwrite each other
    const saveRun = (patch = {}) => {
      chain = chain.then(() => db.update('analytics_runs', { id: ctx.runId, user_id: ctx.userId }, { sources: { ...sources }, ...patch }).catch(() => safeLog('analytics_run_not_saved', {}, log)));
      return chain;
    };
    let resolvedPatch = {};

    const SOURCES = {
      social: () => socialSource({ project: g.project, statuses: g.statuses, runner, resolved: g.resolved, now: now() }),
      ads: () => adsSource({ settings: g.settings, statuses: g.statuses, runner, resolved: g.resolved, now: now() }),
      seo: () => seoSource({ db, userId: ctx.userId, projectId: ctx.projectId, project: g.project, settings: g.settings, resolved: g.resolved, page: g.page, property: String(env.GSC_APP_PROPERTY || '').trim(), origin: appOrigin(env), gscStatus: g.customVerified ? { state: 'connected' } : undefined, runner, now: now(), storage, customerTag: ctx.customerTag }),
      email: async () => emailSource({ db, userId: ctx.userId, projectId: ctx.projectId, omnisend, previous: await readSnapshot(db, ctx.userId, ctx.projectId, 'email').catch(() => null), now: now() }),
    };

    await Promise.all(
      which.map(async (source) => {
        sources[source] = 'running';
        await saveRun();
        const before = runner.costMicro();
        let result;
        try {
          result = await SOURCES[source]();
        } catch (e) {
          result = { status: 'error', errorCode: codeOf(e) };
        }
        // the cost of this source alone is not separable when sources overlap: the run's total grows; a snapshot
        // shows what was spent while it ran
        const cost = Math.max(0, runner.costMicro() - before);
        try {
          await writeSnapshot(db, ctx.userId, ctx.projectId, source, { status: result.status, errorCode: result.errorCode ? publicCode(result.errorCode) : null, data: result.data, costMicro: cost, fetchedAt: result.fetchedAt }, now());
          if ((result.status === 'ok' || result.status === 'partial') && result.summary) await appendHistory(db, ctx.userId, ctx.projectId, source, result.summary, now());
          if (result.resolved) resolvedPatch = { ...resolvedPatch, ...result.resolved };
        } catch (e) {
          result = { status: 'error', errorCode: codeOf(e) };
        }
        sources[source] = result.status;
        await saveRun();
      }),
    );
    if (Object.keys(resolvedPatch).length) await saveResolved(db, ctx.userId, ctx.projectId, resolvedPatch, now()).catch(() => {});
    // done only when every source it ran is ok or partial (spec §1.5 step 7); skipped, not_connected and error
    // all end done_with_errors, so the app shows the per-source note
    const failed = which.some((s) => sources[s] !== 'ok' && sources[s] !== 'partial');
    await saveRun({ state: failed ? 'done_with_errors' : 'done', finished_at: iso(now()), cost_micro: runner.costMicro() });
  }

  return {
    async start(user, projectId, requested) {
      const which = Array.isArray(requested) && requested.length ? ANALYTICS_SOURCES.filter((s) => requested.includes(s)) : [...ANALYTICS_SOURCES];
      if (!which.length) throw fail(400, 'BAD_REQUEST', 'Unknown source.');
      const g = await gather(user.id, projectId);
      const can = whatToFetch(g);
      const doable = which.filter((s) => can[s]);
      if (!doable.length) {
        throw fail(422, 'NOTHING_TO_UPDATE', 'Add your social handles, keywords or connect an account to see analytics.', {
          missing: ['handles', 'keywords', 'competitors', 'connections'].filter((k) => (k === 'handles' ? !Object.keys(handlesOf(g.project)).length : k === 'keywords' ? !(g.settings.keywords || []).length : k === 'competitors' ? !(g.settings.competitors || []).length : true)),
        });
      }
      const customerTag = await ensureCustomer(db, user.id, env);
      await precheckCaps(db, customerTag, now());
      const runId = crypto.randomUUID();
      const sourcesJson = Object.fromEntries(ANALYTICS_SOURCES.map((s) => [s, doable.includes(s) ? 'queued' : 'skipped']));
      const claimed = await db.rpc('claim_analytics_run', { p_user: user.id, p_project: projectId, p_id: runId, p_sources: sourcesJson });
      const row = Array.isArray(claimed) ? claimed[0] : null;
      if (!row) {
        const last = await latestRun(db, user.id, projectId).catch(() => null);
        const started = Date.parse(last?.started_at);
        const nextAt = iso((Number.isFinite(started) ? started : now()) + RUN_EVERY_MS);
        throw fail(429, 'REFRESH_TOO_SOON', 'Updated a few minutes ago. You can update again shortly.', { nextAt });
      }
      const ctx = { userId: user.id, projectId, runId, customerTag };
      const work = runSources(ctx, g, doable)
        .catch((e) => safeLog('analytics_run_failed', { error: e?.name || 'Error', code: e?.code }, log))
        .finally(() => running.delete(work));
      running.add(work);
      return runOut(row);
    },

    /** Settles when every run started here has finished (tests; and a clean shutdown). */
    async idle() {
      while (running.size) await Promise.allSettled([...running]);
    },

    STUCK_RUN_MS,
  };
}
