// The built-in morning action (claude.ai build, no accounts, guests): made in the browser for the business's own
// action day, the same day rules as the server, due posts before habits, the plan first when there is none, Not
// useful ideas kept away for 30 days, and never a request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Post, Project } from '@/lib/types';
import { newProject } from '@/store/defaults';
import { safeStorage } from '@/lib/storage';
import { actionDayOf as serverDay, nextMorningAt as serverNext, localToUtc as serverLocal } from '../../../server/localTime.mjs';
import { localCandidates, localFeedback, localKey, localMorning } from './local';
import { actionDayOf, isLate, localToUtc, nextMorningAt } from './localTime';

const Z = (s: string) => Date.parse(s);
const ctxAt = (now: number, posts: Post[] = []) => ({ posts, ads: [], myListings: [], now });

function project(tz: string, o: Partial<Project> = {}): Project {
  const p = { ...newProject('business', 'existing'), id: 'p1', onboarded: true, timeZone: tz, ...o };
  p.brand = { ...p.brand, name: 'Copper Kettle' };
  return p;
}
const post = (id: string, scheduledAt: string): Post => ({ id, projectId: 'p1', status: 'scheduled', platform: 'instagram', format: 'image', style: 'minimal', postType: 'tip', headline: `Headline ${id}`, visualPrompt: '', caption: '', hashtags: [], scheduledAt, watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1 }) as Post;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  safeStorage.removeItem(localKey('p1'));
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchSpy).not.toHaveBeenCalled();
});

describe('the clock', () => {
  it('agrees with the server’s 5 am rules (both Los Angeles changes, :30 and :45 zones, the date line)', () => {
    const zones = ['America/Los_Angeles', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Chatham', 'Australia/Adelaide', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'];
    const instants = ['2026-03-08T11:59:00Z', '2026-03-08T12:00:00Z', '2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', '2026-11-07T15:30:00Z', '2026-04-03T18:30:01Z', '2026-10-02T19:30:01Z'].map(Z);
    for (const tz of zones) for (const t of instants) {
      expect(actionDayOf(t, tz), `${tz} ${t}`).toBe(serverDay(t, tz));
      expect(nextMorningAt(t, tz), `${tz} ${t}`).toBe(serverNext(t, tz));
    }
    expect(localToUtc('2026-03-08', 2, 30, 'America/Los_Angeles')).toBe(serverLocal('2026-03-08', 2, 30, 'America/Los_Angeles'));
    expect(localToUtc('2026-11-01', 1, 30, 'America/Los_Angeles')).toBe(Z('2026-11-01T08:30:00Z'));
    expect(isLate(Z('2026-11-07T10:01:00Z'), 'America/Los_Angeles')).toBe(true); // 02:01 PST
    expect(isLate(Z('2026-11-07T09:59:00Z'), 'America/Los_Angeles')).toBe(false); // 01:59
  });
});

describe('localMorning', () => {
  it('is the same all day, and a date-line business flips at its own 5 am', () => {
    const p = project('Pacific/Kiritimati');
    const before = localMorning(p, ctxAt(Z('2026-11-07T11:59:00Z'))); // 01:59 on the 8th there
    expect(before.actionDay).toBe('2026-11-07');
    expect(before.action).toMatchObject({ localDate: '2026-11-07' });
    const again = localMorning(p, ctxAt(Z('2026-11-07T14:59:30Z'))); // 04:59: late, the day's one still shows
    expect(again.action).toEqual(before.action);
    const after = localMorning(p, ctxAt(Z('2026-11-07T15:00:00Z')));
    expect(after.actionDay).toBe('2026-11-08');
    expect(after.timeZone).toBe('Pacific/Kiritimati');
    expect(after.action).toMatchObject({ state: 'ready', engine: 'rules', chosen: 0, credits: null, localDate: '2026-11-08' });
    expect(after.attemptsLeft).toBe(0);
    // Pago Pago, the same instant: still the 6th
    safeStorage.removeItem(localKey('p1'));
    expect(localMorning(project('Pacific/Pago_Pago'), ctxAt(Z('2026-11-07T15:30:00Z'))).actionDay).toBe('2026-11-06');
  });
  it('02:00–05:00 makes nothing new for the ending day (as the server); a day already made still shows', () => {
    const p = project('America/Los_Angeles');
    const late = localMorning(p, ctxAt(Z('2026-11-07T11:00:00Z'))); // 03:00 PST
    expect(late).toMatchObject({ actionDay: '2026-11-06', action: null, late: true, dueNow: false });
    expect(safeStorage.getItem(localKey('p1'))).toBeNull();
    // 05:00: the new day's one action
    expect(localMorning(p, ctxAt(Z('2026-11-07T13:00:00Z'))).action).toMatchObject({ localDate: '2026-11-07', state: 'ready' });
    // made at 01:00 for the 6th, it still shows at 03:00
    safeStorage.removeItem(localKey('p1'));
    const early = localMorning(p, ctxAt(Z('2026-11-07T09:00:00Z'))); // 01:00 PST
    expect(early.action).toMatchObject({ localDate: '2026-11-06' });
    expect(localMorning(p, ctxAt(Z('2026-11-07T11:00:00Z'))).action).toEqual(early.action);
  });
  it('before 05:00 a post from the action day is due; one for the coming calendar day isn’t', () => {
    const p = project('America/Los_Angeles');
    const now = Z('2026-11-07T09:00:00Z'); // 01:00 PST on the 7th: the action day is the 6th
    const c = localCandidates(p, ctxAt(now, [post('post_8', '2026-11-07T18:00:00Z')]), '2026-11-06', now);
    expect(c.some((x) => x.rule === 'post_due')).toBe(false);
    const d = localCandidates(p, ctxAt(now, [post('post_7', '2026-11-07T06:00:00Z')]), '2026-11-06', now); // 22:00 on the 6th
    expect(d[0]).toMatchObject({ rule: 'post_due', target: { postId: 'post_7' } });
  });
  it('without a plan, planning comes first; a due post beats the plan and the habits', () => {
    const now = Z('2026-11-07T15:00:00Z'); // 07:00 in Chicago
    const p = project('America/Chicago');
    const none = localCandidates(p, ctxAt(now), '2026-11-07');
    expect(none[0]).toMatchObject({ rule: 'no_plan', kind: 'strategy', key: 'strategy' });
    expect(none.some((c) => c.rule === 'habit')).toBe(true);
    const due = localCandidates(p, ctxAt(now, [post('post_9', '2026-11-07T14:00:00Z')]), '2026-11-07');
    expect(due[0]).toMatchObject({ rule: 'post_due', kind: 'calendar', target: { postId: 'post_9' }, key: 'post:post_9' });
    expect(due[0].why).toContain('Headline post_9');
    // never leads, sales or numbers: those are the server’s
    expect(due.map((c) => c.rule)).not.toEqual(expect.arrayContaining(['new_leads', 'new_sale', 'offer_no_sales', 'stale_numbers']));
  });
  it('Not useful shows the next idea, then dismisses; those ideas stay away for 30 days', () => {
    const p = project('UTC');
    const d1 = localMorning(p, ctxAt(Z('2026-11-07T06:00:00Z')));
    const first = d1.action!.candidates[0].key;
    const second = d1.action!.candidates[1].key;
    const a1 = localFeedback(p, 'not_useful', 'doesnt_fit', 'not for us', Z('2026-11-07T06:01:00Z'))!;
    expect(a1).toMatchObject({ chosen: 1, state: 'ready', feedback: [{ i: 0, reason: 'doesnt_fit', note: 'not for us' }] });
    localFeedback(p, 'not_useful', undefined, undefined, Z('2026-11-07T06:02:00Z'));
    const a3 = localFeedback(p, 'not_useful', undefined, undefined, Z('2026-11-07T06:03:00Z'))!;
    expect(a3.state).toBe('dismissed');
    const keys = (d: string) => localMorning(p, ctxAt(Z(`${d}T06:00:00Z`))).action!.candidates.map((c) => c.key);
    expect(keys('2026-11-08')).not.toContain(first);
    expect(keys('2026-12-06')).not.toContain(second); // day 29
    expect(keys('2026-12-08')).toContain(first); // day 31: back
  });
  it('Done and Undo are kept on this device; Undo only on the same action day', () => {
    const p = project('UTC');
    localMorning(p, ctxAt(Z('2026-11-07T06:00:00Z')));
    expect(localFeedback(p, 'done', undefined, undefined, Z('2026-11-07T07:00:00Z'))).toMatchObject({ state: 'done' });
    expect(localMorning(p, ctxAt(Z('2026-11-07T08:00:00Z'))).action!.state).toBe('done');
    expect(localFeedback(p, 'undo', undefined, undefined, Z('2026-11-07T09:00:00Z'))).toMatchObject({ state: 'ready', doneAt: null });
    localFeedback(p, 'done', undefined, undefined, Z('2026-11-07T09:00:00Z'));
    expect(localFeedback(p, 'undo', undefined, undefined, Z('2026-11-08T06:00:00Z'))).toMatchObject({ state: 'done' });
  });
});

describe('the server calls in the claude.ai build', () => {
  it('refuse before any request', async () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const api = await import('@/lib/integrations/api');
    const { morningConfig, morningModeOf } = await import('./config');
    await expect(api.getMorningToday('p1', 'UTC')).rejects.toMatchObject({ code: 'NOT_SET_UP' });
    await expect(api.startMorning('p1', 'manual', 'UTC')).rejects.toMatchObject({ code: 'NOT_SET_UP' });
    await expect(api.sendMorningFeedback('x', 'done')).rejects.toMatchObject({ code: 'NOT_SET_UP' });
    await expect(api.getMorningOwner()).rejects.toMatchObject({ code: 'NOT_SET_UP' });
    expect(await morningConfig()).toEqual({ enabled: false, reachable: false });
    expect(morningModeOf('ready', { enabled: true, reachable: true }, true)).toBe('local');
  });
});

describe('the mode', () => {
  it('server when signed in and the server has it; local without accounts or as a guest; otherwise off', async () => {
    const { morningModeOf } = await import('./config');
    expect(morningModeOf('ready', { enabled: true, reachable: true }, false)).toBe('server');
    expect(morningModeOf('ready', { enabled: false, reachable: true }, false)).toBe('off');
    expect(morningModeOf('ready', null, false)).toBe('off');
    expect(morningModeOf('off', null, false)).toBe('local');
    expect(morningModeOf('guest', null, false)).toBe('local');
    for (const ph of ['loading', 'signed-out', 'opening', 'failed']) expect(morningModeOf(ph, { enabled: true, reachable: true }, false)).toBe('off');
  });
});
