import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTimeZone, fillTimeZones, isValidTimeZone, looksLikeTimeZone, projectTimeZone, timeZoneLabel, timeZoneNames, utcOffsetLabel } from './timeZone';
import { newProject } from '@/store/defaults';
import { useStore } from '@/store/useStore';
import { cleanWorkspace } from '@/store/cleanup';

afterEach(() => vi.restoreAllMocks());

describe('time zones', () => {
  it('validates IANA names with Intl', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Asia/Kathmandu')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('America/Chicago; drop table')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('the browser’s zone, or UTC when Intl can’t say', () => {
    expect(isValidTimeZone(browserTimeZone())).toBe(true);
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no Intl');
    });
    expect(browserTimeZone()).toBe('UTC');
  });

  it('lists zones (sorted, UTC and the saved one included) and labels them', () => {
    const names = timeZoneNames(['America/Chicago']);
    expect(names).toContain('UTC');
    expect(names).toContain('America/Chicago');
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    expect(timeZoneLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires (America/Argentina)');
    expect(timeZoneLabel('UTC')).toBe('UTC');
    // half-hour and quarter-hour offsets, and daylight saving
    expect(utcOffsetLabel('Asia/Kolkata', Date.parse('2026-01-15T00:00:00Z'))).toBe('UTC+05:30');
    expect(utcOffsetLabel('Asia/Kathmandu', Date.parse('2026-01-15T00:00:00Z'))).toBe('UTC+05:45');
    expect(utcOffsetLabel('America/New_York', Date.parse('2026-01-15T12:00:00Z'))).toBe('UTC−05:00');
    expect(utcOffsetLabel('America/New_York', Date.parse('2026-07-15T12:00:00Z'))).toBe('UTC−04:00');
    expect(utcOffsetLabel('UTC')).toBe('UTC+00:00');
  });

  it('new businesses start with the browser’s zone', () => {
    expect(newProject().timeZone).toBe(browserTimeZone());
  });

  it('fills missing zones, keeps the ones set (even one this browser doesn’t know), and returns the same array when nothing changes', () => {
    const a = { ...newProject(), timeZone: 'Europe/Paris' };
    const b = { ...newProject(), timeZone: undefined };
    const c = { ...newProject(), timeZone: 'not a zone!' };
    const d = { ...newProject(), timeZone: 'America/Some_New_Zone' };
    const out = fillTimeZones([a, b, c, d], 'America/Denver');
    expect(out.map((p) => p.timeZone)).toEqual(['Europe/Paris', 'America/Denver', 'America/Denver', 'America/Some_New_Zone']);
    expect(out[0]).toBe(a);
    const same = [a, d];
    expect(fillTimeZones(same, 'UTC')).toBe(same);
    expect(looksLikeTimeZone('America/Some_New_Zone')).toBe(true);
    expect(projectTimeZone({ timeZone: 'America/Some_New_Zone' })).toBe(browserTimeZone());
    expect(projectTimeZone({ timeZone: 'Asia/Tokyo' })).toBe('Asia/Tokyo');
  });

  it('projects saved before time zones get the browser’s on first open, once', () => {
    const old = { ...newProject(), timeZone: undefined };
    useStore.setState({ projects: [old], activeProjectId: old.id });
    expect(cleanWorkspace()).toBe(true);
    expect(useStore.getState().projects[0].timeZone).toBe(browserTimeZone());
    expect(cleanWorkspace()).toBe(false);
  });
});
