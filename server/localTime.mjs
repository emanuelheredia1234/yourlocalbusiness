// Local time in a business's time zone, with Intl only (no I/O, no tz library): daylight saving, :30 and :45
// offsets and the date line all come from the runtime's tz data. SQL never computes a local time.
//
// The wall-clock helpers moved here from server/videoWeek.mjs unchanged (it imports them back). The "action day"
// rules for the morning action (server/morning/):
//
//   actionDayOf(now, tz)   the date D whose local 05:00 is the latest one at or before now (today after 05:00,
//                          yesterday before it)
//   nextMorningAt(now, tz) the first local 05:00 strictly after now
//   isLate(now, tz)        the 3 hours before 05:00 (02:00–05:00 local): nothing new is made for the day that's ending
//   localToUtc(ymd, h, m)  a local wall time as an instant: a time in a spring-forward gap maps to the first second
//                          after the gap; an ambiguous fall-back time takes the earlier instant

import fs from 'node:fs';

const morning = JSON.parse(fs.readFileSync(new URL('../shared/morning.json', import.meta.url), 'utf8'));

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Whether Intl knows this IANA time zone. */
export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The first valid time zone of the candidates (the business's, then the browser's), else 'UTC'. */
export const zoneOf = (...candidates) => candidates.find(validTimeZone) ?? 'UTC';

const partsFmt = new Map();
/** The wall-clock date and time of `t` in `tz`, as numbers. */
export function wall(t, tz) {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    partsFmt.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour), mi: Number(o.minute), s: Number(o.second), wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(o.weekday) };
}

/** How far `tz` is ahead of UTC at `t`, in ms. */
export function offsetAt(t, tz) {
  const w = wall(t, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

/** The UTC time of a local date's midnight in `tz` (after a daylight-saving gap at midnight: the first time that exists). */
export function midnightUtc(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

/** A UTC instant's calendar date (YYYY-MM-DD). */
export const ymdOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const pad = (n) => String(n).padStart(2, '0');

/** The local calendar date (YYYY-MM-DD) of instant `t` in `tz`. */
export function localDateOf(t, tz) {
  const w = wall(t, zoneOf(tz));
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** Calendar arithmetic on dates (no zone). */
export function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return ymdOf(Date.UTC(y, m - 1, d) + n * DAY_MS);
}

/**
 * The instant of a local wall time `ymd hh:mm` in `tz`, in whole seconds. Candidates are the wall time minus the
 * offset in force a day before, at, and a day after it; the earliest one whose wall time reads back exactly is the
 * answer (an ambiguous fall-back time → the earlier instant). None reads back in a spring-forward gap: the answer is
 * then the first whole second at or after the transition between the candidates (the wall time just past the gap).
 */
export function localToUtc(ymd, hh, mm, tz) {
  const zone = zoneOf(tz);
  const [y, m, d] = String(ymd).split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm, 0);
  const cands = [...new Set([target - offsetAt(target - DAY_MS, zone), target - offsetAt(target, zone), target - offsetAt(target + DAY_MS, zone)])].sort((a, b) => a - b);
  for (const c of cands) {
    const w = wall(c, zone);
    if (Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) === target) return c;
  }
  // a gap: search (in whole seconds) for the first instant whose offset is the later one
  let lo = cands[0];
  let hi = cands[cands.length - 1];
  const after = offsetAt(hi, zone);
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (offsetAt(mid, zone) === after) hi = mid;
    else lo = mid;
  }
  return offsetAt(lo, zone) === after ? lo : hi;
}

/** The hour the action day starts, local (shared/morning.json: 5). */
export const MORNING_HOUR = morning.hour;

/** The date D whose local 05:00 is the latest one at or before `now`. */
export function actionDayOf(now, tz, hour = MORNING_HOUR) {
  const zone = zoneOf(tz);
  const today = localDateOf(now, zone);
  return now >= localToUtc(today, hour, 0, zone) ? today : addDays(today, -1);
}

/** The first local 05:00 strictly after `now` (ms). */
export function nextMorningAt(now, tz, hour = MORNING_HOUR) {
  const zone = zoneOf(tz);
  const today = localDateOf(now, zone);
  const t = localToUtc(today, hour, 0, zone);
  return t > now ? t : localToUtc(addDays(today, 1), hour, 0, zone);
}

/** The late window: less than `lateHours` (3) before the next local 05:00. */
export function isLate(now, tz, lateHours = morning.lateHours, hour = MORNING_HOUR) {
  return nextMorningAt(now, tz, hour) - now < lateHours * HOUR_MS;
}
