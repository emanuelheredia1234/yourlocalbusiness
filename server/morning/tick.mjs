// The hourly `morning-actions` job (server/cron runs it once per hour behind its own claim) and the daily
// `morning-prune` job.
//
// One run (first in the tick; its deadline leaves LEAVE_FOR_OTHERS_MS of the tick to the other jobs): sweep stale
// `generating` rows to failed (INTERRUPTED; never re-run) → claim due businesses in small batches (ylb_morning_claim:
// `for update skip locked` + a lease), up to MORNING_PER_TICK, while more than 22 s (the AI's limit + 2 s) are left
// before that deadline and it isn't stopped; the rest wait for the next tick (or the first Dashboard visit) → for each:
// late window → skipped; P1's entitlement and slot re-checked → skipped (a read that fails throws instead, leaving
// the business claimed until the lease ends, so the next tick tries again before any AI call); else the day's row
// is inserted (one per business per day), next_action_at moved on and the claim released BEFORE any AI call (a
// failed release is only logged: the row blocks a second action and the next tick's `exists` path releases it),
// then the action is made →
// the backlog check when the run stopped early → a summary (counts only) in app_state `morning:last` and the log.

import { safeLog } from '../integrations/common.mjs';
import { actionDayOf, addDays, isLate, nextMorningAt, zoneOf } from '../localTime.mjs';
import { AI_TIMEOUT_MS, BACKLOG_SECONDS, LEASE_SECONDS, MORNING, MORNING_MIGRATION, iso } from './config.mjs';
import { LAST_KEY } from './alerts.mjs';
import { makeAction, outcomeOf } from './generate.mjs';

/**
 * deps: { store, db, billing, aiText, alerts, storage (app_state), settings: { perTick, concurrency }, now, log }.
 * → { run(ctx), prune(ctx) }.
 */
export function createMorningJobs(deps) {
  const { store, billing, alerts, storage = null, settings, now = () => Date.now(), log = console } = deps;
  let notSetUpLogged = false;

  /** One claimed business. → 'late' | 'skipped' | 'exists' | 'ai' | 'rules' | 'failed' */
  async function handleOne(c, ctx) {
    const tz = zoneOf(c.doc_time_zone, c.time_zone);
    const t = now();
    const release = (patch) => store.advance(c.user_id, c.project_id, c.claim_id, { time_zone: tz, last_run_at: iso(t), ...patch });
    if (isLate(t, tz)) {
      await release({ next_action_at: iso(nextMorningAt(t, tz)), last_outcome: 'skipped_late' });
      return 'late';
    }
    // a failed read throws (counted failed): no skip recorded, the lease runs out, the next tick tries again
    const ent = await billing.entitlement(c.user_id);
    if (!ent?.active) {
      await release({ next_action_at: iso(nextMorningAt(t, tz)), last_outcome: 'skipped_plan' });
      return 'skipped';
    }
    const who = { id: c.user_id, email: '', isAdmin: ent.plan === 'owner' };
    try {
      await billing.requireSlot(who, c.project_id);
    } catch (e) {
      if (e?.status === 402) {
        await release({ next_action_at: iso(nextMorningAt(t, tz)), last_outcome: 'skipped_slot' });
        return 'skipped';
      }
      throw e;
    }
    const row = await store.begin({ userId: c.user_id, projectId: c.project_id, localDate: actionDayOf(t, tz), timeZone: tz, source: 'cron', now: t });
    // move on and release before any AI call: from here the day's row is the record, a crash leaves it `generating`
    const moveOn = { next_action_at: iso(nextMorningAt(t, tz)), ...(row ? {} : { last_outcome: 'exists' }) };
    if (!row) {
      await release(moveOn);
      return 'exists';
    }
    try {
      await release(moveOn);
    } catch (e) {
      // the day's row is there: make it anyway (the lease ends, the next tick finds the row and releases)
      safeLog('morning_release_failed', { code: e?.code || e?.name || 'Error' }, log);
    }
    const done = await makeAction(deps, { who, row, now, signal: ctx.signal });
    const outcome = outcomeOf(done);
    await store.patchSettings(c.user_id, c.project_id, { last_outcome: outcome }).catch(() => {});
    return outcome === 'ready' ? 'ai' : outcome;
  }

  async function run(ctx = {}) {
    const counts = { claimed: 0, ai: 0, rules: 0, failed: 0, skipped: 0, exists: 0, late: 0, backlog: 0, swept: 0 };
    try {
      counts.swept = await store.sweep(now());
    } catch (e) {
      if (e?.code === 'NOT_SET_UP') {
        if (!notSetUpLogged) safeLog('morning_not_set_up', { hint: `run ${MORNING_MIGRATION}` }, log);
        notSetUpLogged = true;
        return { notSetUp: 1 };
      }
      throw e;
    }
    let stoppedEarly = false;
    const deadline = Number.isFinite(ctx.deadline) ? ctx.deadline : Infinity;
    while (counts.claimed < settings.perTick) {
      if (ctx.signal?.aborted || deadline - now() <= AI_TIMEOUT_MS + 2000) {
        stoppedEarly = true;
        break;
      }
      const batch = await store.claim(Math.min(settings.concurrency, settings.perTick - counts.claimed), LEASE_SECONDS);
      if (!batch.length) break;
      counts.claimed += batch.length;
      const results = await Promise.all(
        batch.map((c) =>
          handleOne(c, ctx).catch((e) => {
            safeLog('morning_business_failed', { code: e?.code || e?.name || 'Error' }, log);
            return 'failed';
          }),
        ),
      );
      for (const r of results) counts[r] += 1;
    }
    if (counts.claimed >= settings.perTick) stoppedEarly = true;
    if (stoppedEarly) {
      try {
        counts.backlog = Number(await store.backlog(BACKLOG_SECONDS)) || 0;
        if (counts.backlog > 0) await alerts.raise('backlog', counts.backlog);
      } catch {
        /* the next run checks again */
      }
    }
    const summary = { at: iso(now()), ...counts };
    safeLog('morning_run', counts, log);
    try {
      if (storage?.enabled) await storage.put(LAST_KEY, summary);
    } catch {
      /* the log line has it */
    }
    return counts;
  }

  /** Delete actions older than keepDays, by local date. */
  async function prune() {
    try {
      return { deleted: await store.prune(addDays(new Date(now()).toISOString().slice(0, 10), -MORNING.keepDays)) };
    } catch (e) {
      if (e?.code === 'NOT_SET_UP') return { notSetUp: 1 };
      throw e;
    }
  }

  return { run, prune, handleOne };
}
