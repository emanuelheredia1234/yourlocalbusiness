// Database access for analytics (supabase/migrations/20261105000000_integrations.sql): the user's own project and
// sales page, analytics_settings, analytics_snapshots, analytics_runs and analytics_history. Every query names the
// server-resolved user id; a project or row of someone else's reads as missing (404 at the route), never 403.

import { fail, seoPageIdFor } from '../integrations/common.mjs';
import { ANALYTICS_SOURCES } from '../integrations/contracts.mjs';

export const HISTORY_DAYS = 90;
/** A run still `running` this long after it started is over (its sources: INTERRUPTED). */
export const STUCK_RUN_MS = 15 * 60_000;
const PROJECT_ID_RE = /^[A-Za-z0-9_:.-]{1,80}$/;

const iso = (ms) => new Date(ms).toISOString();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A project id from a request (shape only; ownership is checked against user_docs). */
export function projectIdFrom(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!PROJECT_ID_RE.test(id)) throw fail(400, 'BAD_REQUEST', 'Pick a business first.');
  return id;
}

/** The user's own project (user_docs, kind 'project'), or 404. */
export async function loadProject(db, userId, projectId) {
  const rows = await db.select('user_docs', { user_id: userId, kind: 'project', id: projectId }, { select: 'id,data', limit: 1 });
  const data = rows[0]?.data;
  if (!isObj(data)) throw fail(404, 'NOT_FOUND', 'That business isn’t in your account.');
  return data;
}

/**
 * The project's own published sales page: the one published_pages row with this user and page_id
 * seoPageIdFor(projectId) (never another business's page). { slug, domain, home, updatedAt, url, host } or null.
 * A page on a custom domain counts as on that domain only once the domain is verified.
 */
export async function ownSeoPage(db, userId, projectId, origin) {
  const rows = await db.select('published_pages', { user_id: userId, page_id: seoPageIdFor(projectId), kind: 'seo' }, { select: 'slug,domain,home,updated_at', limit: 1 });
  const row = rows[0];
  if (!row?.slug) return null;
  let domain = typeof row.domain === 'string' && row.domain ? row.domain : null;
  if (domain) {
    const owned = await db.select('published_domains', { domain, user_id: userId }, { select: 'domain,verified_at', limit: 1 });
    if (!owned[0]?.verified_at) domain = null;
  }
  if (domain) return { slug: row.slug, domain, home: row.home === true, updatedAt: row.updated_at, url: `https://${domain}/${row.home ? '' : row.slug}`, host: 'custom' };
  return { slug: row.slug, domain: null, home: false, updatedAt: row.updated_at, url: `${origin}/${row.slug}`, host: 'app' };
}

/** How many leads the project's sales page has had in the last `days` days (first-party data). */
export async function leadCount(db, userId, projectId, now, days = 30) {
  const rows = await db.select('page_leads', { user_id: userId, page_id: seoPageIdFor(projectId), created_at: ['gte', iso(now - days * 86_400_000)] }, { select: 'id', limit: 1000 });
  return rows.length;
}

// ───────────── settings ─────────────

const emptySettings = () => ({ keywords: [], competitors: [] });

/** analytics_settings for this project: { settings, resolved } (empty when there is none). */
export async function readSettings(db, userId, projectId) {
  const rows = await db.select('analytics_settings', { user_id: userId, project_id: projectId }, { limit: 1 });
  const row = rows[0];
  return {
    settings: isObj(row?.settings) ? { ...emptySettings(), ...row.settings } : emptySettings(),
    resolved: isObj(row?.resolved) ? row.resolved : {},
    exists: !!row,
  };
}

/** Clean PUT /api/analytics/settings input: keywords ≤ 10, competitors ≤ 3, plain text only. */
export function cleanSettings(body, current) {
  const next = { ...current };
  const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
  if (body.keywords !== undefined) {
    if (!Array.isArray(body.keywords) || body.keywords.length > 10) throw fail(400, 'BAD_REQUEST', 'Up to 10 keywords.');
    const seen = new Set();
    next.keywords = body.keywords.map((k) => str(k, 80)).filter((k) => k && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()));
  }
  if (body.city !== undefined) {
    const city = str(body.city, 80);
    if (city) next.city = city;
    else delete next.city;
  }
  if (body.competitors !== undefined) {
    if (!Array.isArray(body.competitors) || body.competitors.length > 3) throw fail(400, 'BAD_REQUEST', 'Track up to 3 competitors.');
    next.competitors = body.competitors.map((c) => {
      if (!isObj(c)) throw fail(400, 'BAD_REQUEST', 'Each competitor needs a name.');
      const name = str(c.name, 100);
      if (!name) throw fail(400, 'BAD_REQUEST', 'Each competitor needs a name.');
      const pageId = str(c.pageId, 40);
      if (pageId && !/^\d{3,30}$/.test(pageId)) throw fail(400, 'BAD_REQUEST', 'A Facebook page id is a number.');
      const domain = str(c.domain, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      if (domain && !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw fail(400, 'BAD_REQUEST', 'That website doesn’t look right (example.com).');
      return { name, ...(pageId ? { pageId } : {}), ...(domain ? { domain } : {}) };
    });
  }
  return next;
}

export async function writeSettings(db, userId, projectId, settings, resolved, now) {
  await db.upsert('analytics_settings', { user_id: userId, project_id: projectId, settings, resolved, updated_at: iso(now) }, { onConflict: 'user_id,project_id' });
}

/** Merge into analytics_settings.resolved (ids found once and kept). */
export async function saveResolved(db, userId, projectId, resolved, now) {
  const current = await readSettings(db, userId, projectId);
  await writeSettings(db, userId, projectId, current.settings, { ...current.resolved, ...resolved }, now);
}

// ───────────── snapshots and history ─────────────

/** A snapshot row as the app sees it (AnalyticsSnapshot). */
export function snapshotOut(row) {
  return {
    projectId: row.project_id,
    source: row.source,
    status: row.status,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.fetched_at ? { fetchedAt: row.fetched_at } : {}),
    costMicro: Number(row.cost_micro) || 0,
    data: isObj(row.data) ? row.data : {},
  };
}

export async function readSnapshots(db, userId, projectId) {
  const rows = await db.select('analytics_snapshots', { user_id: userId, project_id: projectId }, { limit: 10 });
  return rows.filter((r) => ANALYTICS_SOURCES.includes(r.source)).map(snapshotOut);
}

export async function readSnapshot(db, userId, projectId, source) {
  const rows = await db.select('analytics_snapshots', { user_id: userId, project_id: projectId, source }, { limit: 1 });
  return rows[0] ?? null;
}

/**
 * Store a source's result. ok / partial replace the data; any other status keeps the previous good data and
 * changes only the status and error code (and leaves fetched_at: the data's "as of" time).
 */
export async function writeSnapshot(db, userId, projectId, source, { status, errorCode = null, data, costMicro = 0, fetchedAt }, now) {
  const good = status === 'ok' || status === 'partial';
  const prev = await readSnapshot(db, userId, projectId, source);
  const row = {
    user_id: userId,
    project_id: projectId,
    source,
    status,
    error_code: errorCode,
    fetched_at: good ? fetchedAt ?? iso(now) : prev?.fetched_at ?? null,
    data: good ? data ?? {} : prev?.data ?? data ?? {},
    // what this update of the source spent (shown as "about $0.02" next to it)
    cost_micro: Math.max(0, Math.round(Number(costMicro) || 0)),
    updated_at: iso(now),
  };
  await db.upsert('analytics_snapshots', row, { onConflict: 'user_id,project_id,source' });
  return row;
}

/** One summary row per source per update; rows older than 90 days are pruned. */
export async function appendHistory(db, userId, projectId, source, summary, now) {
  await db.insert('analytics_history', { user_id: userId, project_id: projectId, source, fetched_at: iso(now), summary });
  await db.remove('analytics_history', { user_id: userId, project_id: projectId, source, fetched_at: ['lt', iso(now - HISTORY_DAYS * 86_400_000)] });
}

/** The newest history summary for a source (the "previous update"), or null. */
export async function lastHistory(db, userId, projectId, source) {
  const rows = await db.select('analytics_history', { user_id: userId, project_id: projectId, source }, { order: 'fetched_at.desc', limit: 1 });
  return rows[0]?.summary ?? null;
}

// ───────────── runs ─────────────

/** A run row as the app sees it (RefreshRun). */
export function runOut(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    state: row.state,
    sources: isObj(row.sources) ? row.sources : {},
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

/** A run still `running` 15 minutes after it started is ended: done_with_errors, unfinished sources INTERRUPTED. */
export function interruptedPatch(row, now) {
  const sources = { ...(isObj(row.sources) ? row.sources : {}) };
  const codes = {};
  for (const s of ANALYTICS_SOURCES) {
    if (!sources[s] || sources[s] === 'queued' || sources[s] === 'running') {
      sources[s] = 'error';
      codes[s] = 'INTERRUPTED';
    }
  }
  return { patch: { state: 'done_with_errors', sources, finished_at: iso(now) }, interrupted: Object.keys(codes) };
}

export const isStuck = (row, now) => row?.state === 'running' && now - Date.parse(row.started_at) > STUCK_RUN_MS;

/** End a stuck run (and mark its unfinished sources' snapshots INTERRUPTED). Returns the row as it is now. */
export async function settleStuck(db, row, now) {
  if (!isStuck(row, now)) return row;
  const { patch, interrupted } = interruptedPatch(row, now);
  const updated = await db.update('analytics_runs', { id: row.id, user_id: row.user_id, state: 'running' }, patch, { returning: true });
  for (const source of interrupted) {
    await writeSnapshot(db, row.user_id, row.project_id, source, { status: 'error', errorCode: 'INTERRUPTED' }, now).catch(() => {});
  }
  return updated[0] ?? { ...row, ...patch };
}

export async function readRun(db, userId, runId, now) {
  const rows = await db.select('analytics_runs', { id: runId, user_id: userId }, { limit: 1 });
  if (!rows[0]) return null;
  return settleStuck(db, rows[0], now);
}

/** Every user's runs still `running` after 15 minutes (startup sweep). */
export async function sweepStuckRuns(db, now) {
  const rows = await db.select('analytics_runs', { state: 'running', started_at: ['lt', iso(now - STUCK_RUN_MS)] }, { limit: 500 });
  for (const row of rows) await settleStuck(db, row, now);
  return rows.length;
}

/** The latest run for a business (for REFRESH_TOO_SOON's nextAt). */
export async function latestRun(db, userId, projectId) {
  const rows = await db.select('analytics_runs', { user_id: userId, project_id: projectId }, { order: 'started_at.desc', limit: 1 });
  return rows[0] ?? null;
}
