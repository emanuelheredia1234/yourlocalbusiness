// The morning action's settings: shared/morning.json (read by the app too) and the three plain env settings.
//
//   MORNING_ACTIONS      "off" turns the module off (routes 503 NOT_SET_UP, no jobs)
//   MORNING_PER_TICK     businesses one hourly tick may claim (24; 1–200)
//   MORNING_CONCURRENCY  generations at once within a tick (6; 1–10)
// Bad values fall back to the defaults.

import fs from 'node:fs';

export const MORNING = Object.freeze(JSON.parse(fs.readFileSync(new URL('../../shared/morning.json', import.meta.url), 'utf8')));
export const MORNING_MIGRATION = 'supabase/migrations/20261116000000_morning_action.sql';
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** One claim's lease; the stale sweep's limit. */
export const LEASE_SECONDS = 600;
export const STALE_MS = MORNING.staleMinutes * 60_000;
/** The AI call's own limit (the tick keeps this plus 2 s in hand before claiming another batch). */
export const AI_TIMEOUT_MS = 20_000;
/** A backlog worth an owner alert: businesses still due 3 hours after their 05:00. */
export const BACKLOG_SECONDS = 10_800;

const int = (v, def, lo, hi) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : def;
};

/** { off, perTick, concurrency } from env. */
export function morningSettings(env = process.env) {
  return {
    off: ['off', 'none', 'false', '0'].includes(String(env.MORNING_ACTIONS ?? '').trim().toLowerCase()),
    perTick: int(env.MORNING_PER_TICK, 24, 1, 200),
    concurrency: int(env.MORNING_CONCURRENCY, 6, 1, 10),
  };
}

const iso = (t) => new Date(t).toISOString();
export { iso };
