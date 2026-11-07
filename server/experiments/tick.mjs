// The hourly `experiment-results` job (server/cron runs it once per hour behind its own claim).
//
// One run: flush the page split's counters → claim running post and email tests due a read (ylb_experiment_claim_reads:
// `for update skip locked` + a lease), up to EXPERIMENT_READS_PER_TICK → for each: read its posted variants' numbers
// (Upload-Post's per-post analytics, 3-hourly in the first 72 h after posting, 12-hourly up to the deadline, never
// after it + 24 h) or its Omnisend results (6-hourly), recompute the verdict, finish it past its deadline, release
// the claim with the read time. When the analytics limit is used up the run stops reading: the rest are released
// unread and wait for the next tick. A failed read keeps the old numbers (reads may be tried again; writes never
// are). Then page splits past their deadline are finished. A summary (counts only) goes to the log.

import { safeLog } from '../integrations/common.mjs';
import { EXPERIMENTS_MIGRATION, READ_LEASE_SECONDS, iso } from './config.mjs';

/** deps: { store, social, split, email, settings: { readsPerTick }, now, log }. */
export function createExperimentJobs(deps) {
  const { store, social, split, email, settings, now = () => Date.now(), log = console } = deps;
  let notSetUpLogged = false;

  async function run(ctx = {}) {
    const counts = { claimed: 0, read: 0, failed: 0, waiting: 0, finished: 0, pages: 0 };
    await split.flush().catch(() => {});
    let claims;
    try {
      claims = await store.claimReads(settings.readsPerTick, READ_LEASE_SECONDS);
    } catch (e) {
      if (e?.code === 'NOT_SET_UP') {
        if (!notSetUpLogged) safeLog('experiments_not_set_up', { hint: `run ${EXPERIMENTS_MIGRATION}` }, log);
        notSetUpLogged = true;
        return { notSetUp: 1 };
      }
      throw e;
    }
    counts.claimed = claims.length;
    const deadline = Number.isFinite(ctx.deadline) ? ctx.deadline : Infinity;
    let busy = false;
    for (const c of claims) {
      if (busy || ctx.signal?.aborted || deadline - now() < 3_000) {
        // not read this time: released as it was, so the next tick picks it again
        await store.release(c.id, c.read_claim, {}).catch(() => {});
        counts.waiting += 1;
        continue;
      }
      try {
        const e = await store.byIdAny(c.id);
        if (!e || e.state !== 'running') {
          await store.release(c.id, c.read_claim, {}).catch(() => {});
          continue;
        }
        const got = e.kind === 'post' ? await social.readPostTest(e) : await email.readEmailTest(e, { force: true });
        if (got.busy) {
          busy = true;
          await store.release(c.id, c.read_claim, {}).catch(() => {});
          counts.waiting += 1;
          continue;
        }
        await store.release(c.id, c.read_claim, { last_read_at: iso(now()) });
        counts.read += 1;
        if (got.row?.state === 'finished') counts.finished += 1;
      } catch (e) {
        counts.failed += 1;
        safeLog('experiment_read_failed', { code: e?.code || e?.name || 'Error' }, log);
        await store.release(c.id, c.read_claim, { last_read_at: iso(now()) }).catch(() => {});
      }
    }
    try {
      for (const e of await store.pagesDue(now())) {
        const row = await split.recompute(e);
        if (row?.state === 'finished') counts.pages += 1;
      }
    } catch (e) {
      if (e?.code !== 'NOT_SET_UP') safeLog('experiment_pages_due_failed', { code: e?.code || e?.name || 'Error' }, log);
    }
    safeLog('experiment_results_run', counts, log);
    return counts;
  }

  return { run };
}
