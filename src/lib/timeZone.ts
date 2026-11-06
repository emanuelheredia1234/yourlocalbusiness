// Each business keeps its own IANA time zone (Project.timeZone), e.g. "America/Chicago". New businesses start
// with the browser's zone; businesses saved before this field existed get the browser's zone the first time the
// workspace opens (fillTimeZones, run by cleanWorkspace). The owner changes it in Settings › Brand › Business
// details. Later features (the 5 am morning action) work out local times from it with Intl, so daylight saving
// is handled.

import type { Project } from './types';

const FALLBACK = 'UTC';
/** IANA names: letters, digits and _+-/ only (e.g. "America/Argentina/Buenos_Aires", "Etc/GMT+5"). */
const SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/** Whether this browser knows the zone (its Intl accepts it). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !SHAPE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The browser's zone, or UTC when it can't tell. */
export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/** A few zones for browsers without Intl.supportedValuesOf. */
const COMMON = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Bogota',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'Europe/Athens',
  'Europe/Istanbul',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Africa/Cairo',
  'Africa/Nairobi',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Manila',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Perth',
  'Australia/Adelaide',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/** Every zone this browser knows, sorted, with `include` (e.g. the saved one) kept even if it isn't listed. */
export function timeZoneNames(include: string[] = []): string[] {
  let names: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof supported === 'function') names = supported('timeZone');
  } catch {
    names = [];
  }
  if (!names.length) names = COMMON;
  const all = new Set([...names, 'UTC', ...include.filter(isValidTimeZone)]);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** "UTC−05:00" for the zone at `at` (ms). */
export function utcOffsetLabel(tz: string, at = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value;
    if (!part || part === 'GMT') return 'UTC+00:00';
    return part.replace('GMT', 'UTC').replace('-', '−');
  } catch {
    return '';
  }
}

/**
 * What the time zone list searches: the IANA name, the label and the offset, with the offset also in ASCII
 * ("UTC-05:00" next to the displayed "UTC−05:00") so typing "-5" or "UTC-05" finds zones west of UTC.
 */
export function timeZoneSearchValue(tz: string, label: string, offset: string): string {
  const ascii = offset.replace(/\u2212/g, '-');
  return ascii === offset ? `${tz} ${label} ${offset}` : `${tz} ${label} ${offset} ${ascii}`;
}

/** "America/New_York" → "New York (America)", for the list; the IANA name stays the value. */
export function timeZoneLabel(tz: string): string {
  const parts = tz.split('/');
  if (parts.length < 2) return tz;
  const city = parts[parts.length - 1].replace(/_/g, ' ');
  return `${city} (${parts.slice(0, -1).join('/').replace(/_/g, ' ')})`;
}

/** The business's zone: its own when valid, else the browser's. */
export function projectTimeZone(p: Pick<Project, 'timeZone'> | null | undefined): string {
  return isValidTimeZone(p?.timeZone) ? p!.timeZone! : browserTimeZone();
}

/** Shaped like an IANA name (another browser may know a zone this one doesn't, so this doesn't ask Intl). */
export const looksLikeTimeZone = (tz: unknown): tz is string => typeof tz === 'string' && SHAPE.test(tz);

/**
 * Businesses with no zone (saved before the field existed, or holding something that isn't a zone name) get
 * `fallback` (the browser's). A well-formed name this browser doesn't know is kept: another device chose it.
 * Returns the same array when nothing changed, so the store and sync see no edit.
 */
export function fillTimeZones<P extends Pick<Project, 'timeZone'>>(projects: P[], fallback = browserTimeZone()): P[] {
  if (projects.every((p) => looksLikeTimeZone(p.timeZone))) return projects;
  return projects.map((p) => (looksLikeTimeZone(p.timeZone) ? p : { ...p, timeZone: fallback }));
}
