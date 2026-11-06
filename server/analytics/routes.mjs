// Analytics routes (spec §1.1): the Marketing hub's Update and what the Analytics tabs read.
//   POST /api/analytics/refresh {projectId, sources?}   → {run}   (starts in the background; 1 per business per
//                                                                  15 min, 10 per hour per user)
//   GET  /api/analytics/runs/:runId                     → {run}   (a run still running after 15 min ends
//                                                                  done_with_errors, INTERRUPTED)
//   GET  /api/analytics/snapshots?projectId=            → {snapshots}
//   PUT  /api/analytics/settings {projectId, keywords?, city?, competitors?} → {settings}
// Every query names the signed-in user; someone else's project or run answers 404.
// onStart: runs left `running` by a restart are ended the same way.

import { fail, isUuid, notSetUp } from '../integrations/common.mjs';
import { createKit } from './http.mjs';
import { createRefresher } from './refresh.mjs';
import { cleanSettings, loadProject, projectIdFrom, readRun, readSettings, readSnapshots, runOut, sweepStuckRuns, writeSettings } from './snapshots.mjs';

const PREFIX = '/api/analytics/';

export function createAnalyticsRoutes(deps = {}) {
  const { db, storage = null, treg, connections, omnisend = null, env = process.env, now = () => Date.now(), log = console, fetch = globalThis.fetch } = deps;
  const kit = createKit(deps);
  const refresher = createRefresher({ db, storage, treg, connections, omnisend, env, now, log, fetch });

  async function route(req, res, url, who) {
    const p = url.pathname;
    if (p === `${PREFIX}refresh` && req.method === 'POST') {
      // a paused plan refuses before any vendor call (402 PLAN_REQUIRED / PAYMENT_REQUIRED; a no-op without plans)
      await deps.billing?.requireActive?.(who, 'analytics');
      if (kit.limited(req, res, { bucket: 'analytics-refresh' }, who.id)) return;
      const body = await kit.body(req);
      const projectId = projectIdFrom(body.projectId);
      const sources = body.sources === undefined ? undefined : Array.isArray(body.sources) ? body.sources.map(String) : [];
      const run = await refresher.start(who, projectId, sources);
      return kit.reply(req, res, 202, { run });
    }
    const m = /^\/api\/analytics\/runs\/([^/]+)$/.exec(p);
    if (m && req.method === 'GET') {
      if (kit.limited(req, res, { key: `analytics-read:user:${who.id}`, factor: 3 })) return;
      const runId = decodeURIComponent(m[1]);
      const row = isUuid(runId) ? await readRun(db, who.id, runId, now()) : null;
      if (!row) throw fail(404, 'NOT_FOUND', 'No such update.');
      return kit.reply(req, res, 200, { run: runOut(row) });
    }
    if (p === `${PREFIX}snapshots` && req.method === 'GET') {
      if (kit.limited(req, res, { key: `analytics-read:user:${who.id}`, factor: 3 })) return;
      const projectId = projectIdFrom(url.searchParams.get('projectId'));
      await loadProject(db, who.id, projectId);
      return kit.reply(req, res, 200, { snapshots: await readSnapshots(db, who.id, projectId) });
    }
    if (p === `${PREFIX}settings` && req.method === 'PUT') {
      if (kit.limited(req, res, { key: `analytics-settings:user:${who.id}` })) return;
      const body = await kit.body(req);
      const projectId = projectIdFrom(body.projectId);
      await loadProject(db, who.id, projectId);
      const current = await readSettings(db, who.id, projectId);
      const settings = cleanSettings(body, current.settings);
      // a competitor whose name changed is looked up again
      await writeSettings(db, who.id, projectId, settings, current.resolved, now());
      return kit.reply(req, res, 200, { settings: { keywords: settings.keywords, competitors: settings.competitors, ...(settings.city ? { city: settings.city } : {}) } });
    }
    throw fail(404, 'NOT_FOUND', 'Not found.');
  }

  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith(PREFIX)) return false;
      const who = await kit.user(req, res);
      if (!who) return true;
      try {
        // everything here reads through treg (server/treg.mjs): until that wrapper is in this copy of the app,
        // these routes are plainly not set up (the owner's hint says why)
        if (treg?.stub) throw notSetUp('The treg wrapper (server/treg.mjs) isn’t built into this copy of the app yet.', 'Analytics aren’t available yet.');
        await route(req, res, url, who);
      } catch (e) {
        kit.failWith(req, res, e, who);
      }
      return true;
    },
    /** Startup: runs a restart left `running` for 15 minutes become done_with_errors (never re-run). */
    async onStart() {
      if (db?.enabled) await sweepStuckRuns(db, now());
    },
    /** server/cron: the same sweep once an hour, each hourly tick (never re-run). */
    cronJobs: () => (db?.enabled ? [{ name: 'analytics-sweep', everyMs: 60 * 60_000, run: async () => ({ ended: await sweepStuckRuns(db, now()) }) }] : []),
    // analytics rows go with the account (on delete cascade); nothing is held anywhere else
    async forgetUser() {},
    async unforgetUser() {},
    /** for tests */
    refresher,
  };
}
