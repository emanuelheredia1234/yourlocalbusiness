// Local time for the morning action (server/localTime.mjs): the 5 am rules across daylight saving (Los Angeles,
// Adelaide), :30 / :45 offsets (Kolkata, Kathmandu, Chatham), the date line, the late window, bad zones, and a
// property check over every zone Intl knows for each day of 2026–2027.
import { describe, expect, it } from 'vitest';
import { actionDayOf, addDays, isLate, localDateOf, localToUtc, nextMorningAt, validTimeZone, wall, zoneOf } from './localTime.mjs';
import * as videoWeek from './videoWeek.mjs';

const P = Date.parse;
const I = (t) => new Date(t).toISOString();
const HOUR = 3_600_000;
const LA = 'America/Los_Angeles';

describe('localToUtc, actionDayOf, nextMorningAt', () => {
  it('Los Angeles springs forward on 2026-03-08: a 23-hour day, the gap maps past it', () => {
    const from = P('2026-03-07T13:00:01Z'); // Mar 7 05:00:01 PST
    const next = nextMorningAt(from, LA);
    expect(I(next)).toBe('2026-03-08T12:00:00.000Z'); // Mar 8 05:00 PDT
    expect(next - (from - 1000)).toBe(23 * HOUR);
    expect(actionDayOf(P('2026-03-08T11:59:00Z'), LA)).toBe('2026-03-07');
    expect(actionDayOf(P('2026-03-08T12:00:00Z'), LA)).toBe('2026-03-08');
    expect(I(localToUtc('2026-03-08', 2, 30, LA))).toBe('2026-03-08T10:00:00.000Z'); // 03:00 PDT
  });

  it('Los Angeles falls back on 2026-11-01: a 25-hour day, the ambiguous time is the earlier one', () => {
    const from = P('2026-10-31T12:00:01Z'); // Oct 31 05:00:01 PDT
    const next = nextMorningAt(from, LA);
    expect(I(next)).toBe('2026-11-01T13:00:00.000Z'); // Nov 1 05:00 PST
    expect(next - (from - 1000)).toBe(25 * HOUR);
    for (const t of ['2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z']) {
      expect(actionDayOf(P(t), LA)).toBe('2026-10-31');
      expect(I(nextMorningAt(P(t), LA))).toBe('2026-11-01T13:00:00.000Z');
    }
    expect(I(localToUtc('2026-11-01', 1, 30, LA))).toBe('2026-11-01T08:30:00.000Z');
  });

  it(':30 and :45 offsets', () => {
    expect(I(localToUtc('2026-11-08', 5, 0, 'Asia/Kolkata'))).toBe('2026-11-07T23:30:00.000Z');
    expect(I(localToUtc('2026-11-08', 5, 0, 'Asia/Kathmandu'))).toBe('2026-11-07T23:15:00.000Z');
    expect(I(localToUtc('2026-11-08', 5, 0, 'Pacific/Chatham'))).toBe('2026-11-07T15:15:00.000Z');
    expect(I(nextMorningAt(P('2026-11-07T23:29:59Z'), 'Asia/Kolkata'))).toBe('2026-11-07T23:30:00.000Z');
  });

  it('Adelaide in both seasons and across both of its 2026 changes', () => {
    const A = 'Australia/Adelaide';
    expect(I(localToUtc('2026-11-08', 5, 0, A))).toBe('2026-11-07T18:30:00.000Z');
    expect(I(localToUtc('2026-06-15', 5, 0, A))).toBe('2026-06-14T19:30:00.000Z');
    const april = P('2026-04-03T18:30:01Z');
    expect(I(nextMorningAt(april, A))).toBe('2026-04-04T19:30:00.000Z');
    expect(nextMorningAt(april, A) - (april - 1000)).toBe(25 * HOUR);
    const october = P('2026-10-02T19:30:01Z');
    expect(I(nextMorningAt(october, A))).toBe('2026-10-03T18:30:00.000Z');
    expect(nextMorningAt(october, A) - (october - 1000)).toBe(23 * HOUR);
  });

  it('the date line: one instant, four action days', () => {
    const t = P('2026-11-07T15:30:00Z');
    expect(actionDayOf(t, 'Pacific/Kiritimati')).toBe('2026-11-08');
    expect(actionDayOf(t, 'Pacific/Pago_Pago')).toBe('2026-11-06');
    expect(localDateOf(t, 'Pacific/Pago_Pago')).toBe('2026-11-07'); // 04:30 on Nov 7
    expect(actionDayOf(t, 'Pacific/Auckland')).toBe('2026-11-07'); // 04:30 on Nov 8
    expect(actionDayOf(t, 'Pacific/Honolulu')).toBe('2026-11-07');
    expect(actionDayOf(t, 'Pacific/Tongatapu')).toBe('2026-11-07');
    expect(actionDayOf(t, 'Pacific/Apia')).toBe('2026-11-07');
    expect(actionDayOf(t, 'Pacific/Niue')).toBe('2026-11-06');
  });

  it('the late window is 02:00–05:00 local', () => {
    const at = (hh, mm) => localToUtc('2026-11-07', hh, mm, LA);
    expect(isLate(at(1, 59), LA)).toBe(false);
    expect(isLate(at(2, 1), LA)).toBe(true);
    expect(isLate(at(4, 59), LA)).toBe(true);
    expect(isLate(at(5, 0), LA)).toBe(false);
  });

  it('invalid zones are UTC; addDays is plain calendar arithmetic', () => {
    for (const bad of ['Mars/Olympus', '', null, 'x'.repeat(65)]) {
      expect(validTimeZone(bad)).toBe(false);
      expect(I(nextMorningAt(P('2026-11-07T04:00:00Z'), bad))).toBe('2026-11-07T05:00:00.000Z');
    }
    expect(zoneOf('nope', 'Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    // videoWeek keeps re-exporting the helpers it always had
    expect(videoWeek.validTimeZone).toBe(validTimeZone);
    expect(videoWeek.zoneOf).toBe(zoneOf);
  });
});

describe('every zone, every day of 2026–2027', () => {
  // A day's 05:00 can only go missing or double where the zone's offset changes, so the full check runs on every
  // day next to a change (found from each day's offset at 12:00 UTC) and on every 45th day; the offsets themselves
  // are read for every day.
  it('has exactly one 05:00, the next morning is strictly after now and falls on the action day + 1', { timeout: 120_000 }, () => {
    const zones = Intl.supportedValuesOf('timeZone');
    expect(zones.length).toBeGreaterThan(400);
    const days = [];
    for (let d = '2025-12-31'; d <= '2028-01-01'; d = addDays(d, 1)) days.push(d);
    const bad = [];
    for (const tz of zones) {
      const off = days.map((d) => {
        const w = wall(Date.parse(`${d}T12:00:00Z`), tz);
        return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Date.parse(`${d}T12:00:00Z`);
      });
      for (let i = 1; i < days.length - 1; i++) {
        const near = off[i] !== off[i - 1] || off[i] !== off[i + 1];
        if (!near && i % 45 !== 0) continue;
        const d = days[i];
        const t = localToUtc(d, 5, 0, tz);
        const w = wall(t, tz);
        if (`${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${w.h}:${w.mi}:${w.s}` !== `${d} 5:0:0`) bad.push(`${tz} ${d}: 05:00 reads ${JSON.stringify(w)}`);
        const before = localToUtc(addDays(d, -1), 5, 0, tz);
        // consecutive mornings 22–26 hours apart: no day skipped or doubled
        if (t - before < 22 * HOUR || t - before > 26 * HOUR) bad.push(`${tz} ${d}: ${(t - before) / HOUR} h after the last`);
        const now = t + 7 * HOUR + 1234;
        const next = nextMorningAt(now, tz);
        if (!(next > now) || actionDayOf(now, tz) !== d || next !== localToUtc(addDays(d, 1), 5, 0, tz)) bad.push(`${tz} ${d}: next ${I(next)}, action day ${actionDayOf(now, tz)}`);
        if (actionDayOf(t - 1000, tz) !== addDays(d, -1) || nextMorningAt(t - 1000, tz) !== t) bad.push(`${tz} ${d}: just before 05:00`);
        if (bad.length > 5) break;
      }
      if (bad.length > 5) break;
    }
    expect(bad).toEqual([]);
  });
});
