// The morning action's clock in the browser, the same rules as server/localTime.mjs (Intl only, so daylight saving,
// :30 and :45 offsets and the date line come from the browser's tz data). The server's dates win when they differ;
// the app uses these for the claude.ai build's local action and for showing times.

import { MORNING } from './contract';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function valid(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}
const zoneOf = (tz: unknown) => (valid(tz) ? tz : 'UTC');

const fmts = new Map<string, Intl.DateTimeFormat>();
function wall(t: number, tz: string) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmts.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour), mi: Number(o.minute), s: Number(o.second) };
}
function offsetAt(t: number, tz: string) {
  const w = wall(t, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}
const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar date (YYYY-MM-DD) of `t` in `tz`. */
export function localDateOf(t: number, tz: string): string {
  const w = wall(t, zoneOf(tz));
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** Calendar arithmetic on dates (no zone). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** A local wall time as an instant (a gap → just past it; an overlap → the earlier one). */
export function localToUtc(ymd: string, hh: number, mm: number, tz: string): number {
  const zone = zoneOf(tz);
  const [y, m, d] = ymd.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm, 0);
  const cands = [...new Set([target - offsetAt(target - DAY_MS, zone), target - offsetAt(target, zone), target - offsetAt(target + DAY_MS, zone)])].sort((a, b) => a - b);
  for (const c of cands) {
    const w = wall(c, zone);
    if (Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) === target) return c;
  }
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

/** The date whose local 05:00 is the latest one at or before `now`. */
export function actionDayOf(now: number, tz: string): string {
  const today = localDateOf(now, tz);
  return now >= localToUtc(today, MORNING.hour, 0, tz) ? today : addDays(today, -1);
}

/** The first local 05:00 strictly after `now`. */
export function nextMorningAt(now: number, tz: string): number {
  const today = localDateOf(now, tz);
  const t = localToUtc(today, MORNING.hour, 0, tz);
  return t > now ? t : localToUtc(addDays(today, 1), MORNING.hour, 0, tz);
}

/** 02:00–05:00 local: nothing new is made for the day that's ending. */
export const isLate = (now: number, tz: string) => nextMorningAt(now, tz) - now < MORNING.lateHours * HOUR_MS;

/** Days between two dates (b − a). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
