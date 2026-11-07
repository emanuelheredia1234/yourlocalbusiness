// Sending the app's sitemap to Google for the public marketplace (P7). Market addresses live in the existing
// <app>/sitemap.xml, so the submit is the same one "Submit to Google" makes (server/seo/google.mjs publishApp): to
// GSC_APP_PROPERTY through treg's team connection, one-shot (never retried), under the shared 24-hour claim
// (gsc:app:lastSubmit, server/seo/steps.mjs), with the owner's customer tag.
//
// Triggers (never a listing change): the owner's button (POST /api/market/admin/submit-sitemap) and the daily cron,
// which submits only when the market changed since the last submit (app_state market:changedAt > market:lastSubmit.at)
// and at least one listing is live. A submit whose outcome was unknown is not sent again until a read of the
// property's sitemaps (gsc.sitemaps) shows no submit since the change. treg's team-level errors raise its owner alert
// (treg.mjs does that) and show only in the owner's section; sellers never trigger or see these calls. The cron needs
// an owner's user id for treg's tag: the last owner who opened the market's admin section (market:owner).

import crypto from 'node:crypto';
import { ensureCustomer, notSetUp, safeLog } from '../integrations/common.mjs';
import { createRunner } from '../analytics/runner.mjs';
import { appOrigin } from '../seo/sitemap.mjs';
import { attempt, NEVER_SENT } from '../seo/google.mjs';
import { casDocument, claimSubmit, recordSubmit, releaseSubmit } from '../seo/steps.mjs';

export const CHANGED_KEY = 'market:changedAt';
export const LAST_SUBMIT_KEY = 'market:lastSubmit';
export const OWNER_KEY = 'market:owner';

/** deps: db, storage (appState), treg, connections, env, now, log, hasLive() → whether a listing is live. */
export function createMarketSubmit({ db, storage, treg, connections = null, env = process.env, now = () => Date.now(), log = console, hasLive = async () => true }) {
  const property = () => String(env.GSC_APP_PROPERTY || '').trim();
  const read = async (key) => {
    try {
      const doc = await storage?.get?.(key);
      return doc?.value && typeof doc.value === 'object' ? doc.value : {};
    } catch {
      return {};
    }
  };

  /** Something public changed: the cron's next run submits (no call now). */
  async function markChanged() {
    if (storage?.enabled !== true) return;
    try {
      await storage.put(CHANGED_KEY, { at: new Date(now()).toISOString() });
    } catch {
      safeLog('market_changed_not_saved', {}, log);
    }
  }

  /** Remember an owner's user id for the cron's treg tag. */
  async function rememberOwner(userId) {
    if (storage?.enabled !== true) return;
    try {
      const cur = await read(OWNER_KEY);
      if (cur.id !== userId) await storage.put(OWNER_KEY, { id: userId });
    } catch {
      /* best effort */
    }
  }

  /** The owner's view of the last submit: { lastAt, outcome, changedSince, property }. */
  async function state() {
    const last = await read(LAST_SUBMIT_KEY);
    const changed = await read(CHANGED_KEY);
    return {
      lastAt: typeof last.at === 'string' ? last.at : null,
      outcome: typeof last.outcome === 'string' ? last.outcome : null,
      changedSince: typeof changed.at === 'string' && (!last.at || changed.at > last.at),
      property: !!property(),
    };
  }

  /** Did Google record a submit of our sitemap after `since`? true / false, or null when the read failed. */
  async function submittedSince(runner, since) {
    const feed = `${appOrigin(env)}/sitemap.xml`;
    try {
      const got = await runner.treg('gsc.sitemaps', { siteUrl: property() }, 'gsc');
      const entry = (Array.isArray(got.data?.sitemap) ? got.data.sitemap : []).find((x) => x?.path === feed);
      if (!entry?.lastSubmitted) return false;
      return !since || Date.parse(entry.lastSubmitted) >= Date.parse(since);
    } catch {
      return null;
    }
  }

  /**
   * One submit under the shared claim. userId: the owner's. → { outcome: 'ok' | 'failed' | 'unknown' | 'skipped',
   * alreadySubmittedAt? }.
   */
  async function submit(userId, { trigger = 'owner' } = {}) {
    const prop = property();
    if (!prop) throw notSetUp('Add GSC_APP_PROPERTY (https://yourlocalbusiness.replit.app/) once that Search Console property is verified.', 'Sending the sitemap to Google isn’t set up on this app yet.');
    const changed = await read(CHANGED_KEY);
    const previous = await read(LAST_SUBMIT_KEY);
    const customerTag = await ensureCustomer(db, userId, env);
    const runner = createRunner({ treg, connections, ctx: { userId, projectId: null, runId: crypto.randomUUID(), customerTag } });
    // the last one may have gone through: read before sending again (the cron only; the owner pressed the button)
    if (trigger === 'cron' && previous.outcome === 'unknown') {
      const seen = await submittedSince(runner, changed.at ?? null);
      if (seen !== false) {
        if (seen === true) await storage.put(LAST_SUBMIT_KEY, { ...previous, at: new Date(now()).toISOString(), outcome: 'ok', changedAt: changed.at ?? null }).catch(() => {});
        return { outcome: 'skipped', reason: seen === true ? 'already_submitted' : 'read_failed' };
      }
    }
    const claim = await claimSubmit(storage, now());
    if (!claim.won) return { outcome: 'skipped', alreadySubmittedAt: claim.at };
    const origin = appOrigin(env);
    const got = await attempt(() => runner.treg('gsc.submit', { siteUrl: prop, feedpath: `${origin}/sitemap.xml` }, 'gsc'));
    const neverSent = got.outcome === 'failed' && NEVER_SENT.has(got.value?.kind);
    if (neverSent) await releaseSubmit(storage, claim.at, claim.previous).catch(() => {});
    else await recordSubmit(storage, claim.at, got.outcome).catch(() => {});
    if (!neverSent) await casDocument(storage, LAST_SUBMIT_KEY, () => ({ value: { at: claim.at, outcome: got.outcome, changedAt: changed.at ?? null }, result: true })).catch(() => {});
    safeLog('market_sitemap_submit', { trigger, outcome: got.outcome, kind: got.value?.kind ?? null }, log);
    return { outcome: got.outcome };
  }

  /** The daily job: a submit only when the market changed since the last one and a listing is live. */
  async function cron() {
    if (!property()) return { skipped: 'no_property' };
    const changed = await read(CHANGED_KEY);
    const last = await read(LAST_SUBMIT_KEY);
    if (!changed.at || (last.at && last.at >= changed.at)) return { skipped: 'unchanged' };
    if (!(await hasLive())) return { skipped: 'nothing_live' };
    const owner = await read(OWNER_KEY);
    if (!owner.id) return { skipped: 'no_owner' };
    try {
      return await submit(owner.id, { trigger: 'cron' });
    } catch (e) {
      safeLog('market_sitemap_submit_failed', { code: e?.code ?? e?.name ?? 'Error' }, log);
      return { skipped: 'error' };
    }
  }

  return { submit, cron, state, markChanged, rememberOwner };
}
