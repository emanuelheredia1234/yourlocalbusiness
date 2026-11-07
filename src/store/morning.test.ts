// The morning action's store: keyed by business (a late answer for A never shows on B), the first visit starts
// the day's action once per business per day and never for a row that exists (so never a failed one), only the
// owner's press re-runs a failed day, polling gives up after 90 s, a 402 locks the card, another account resets
// everything, and the claude.ai build makes no request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/integrations/api', async (original) => ({
  ...(await original<typeof import('@/lib/integrations/api')>()),
  getMorningToday: vi.fn(),
  startMorning: vi.fn(),
  sendMorningFeedback: vi.fn(),
}));

const api = await import('@/lib/integrations/api');
const { IntegrationApiError } = api;
const { POLL_FOR_MS, POLL_MS, STILL_WORKING, entryOf, useMorningStore } = await import('./morning');
import type { MorningAction, MorningToday } from '@/lib/integrations/types';

const get = vi.mocked(api.getMorningToday);
const post = vi.mocked(api.startMorning);
const fb = vi.mocked(api.sendMorningFeedback);

const action = (o: Partial<MorningAction> = {}): MorningAction => ({
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'pA',
  localDate: '2026-11-07',
  timeZone: 'America/Chicago',
  state: 'ready',
  source: 'visit',
  engine: 'rules',
  chosen: 0,
  candidates: [{ key: 'strategy', kind: 'strategy', title: 'Plan your marketing strategy', why: 'A short plan tells you what to post.', target: {}, from: 'rule' }],
  feedback: [],
  fallback: 'no_ai',
  credits: null,
  ownKey: false,
  generatedAt: null,
  doneAt: null,
  ...o,
});
const today = (o: Partial<MorningToday> = {}): MorningToday => ({ actionDay: '2026-11-07', timeZone: 'America/Chicago', action: null, dueNow: false, late: false, nextAt: '2026-11-08T11:00:00.000Z', attemptsLeft: 3, plan: 'active', ...o });
const entry = (id: string) => entryOf(useMorningStore.getState(), id);

beforeEach(() => {
  useMorningStore.getState().reset();
  get.mockReset();
  post.mockReset();
  fb.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loading', () => {
  it('keeps each business apart: a slow answer for A lands on A only', async () => {
    let releaseA!: (t: MorningToday) => void;
    get.mockImplementation((pid) => (pid === 'pA' ? new Promise((r) => (releaseA = r)) : Promise.resolve(today({ action: action({ projectId: 'pB', id: '22222222-2222-4222-8222-222222222222' }) }))));
    const a = useMorningStore.getState().load('pA', 'America/Chicago');
    await useMorningStore.getState().load('pB', 'Europe/Paris');
    expect(entry('pB').today?.action?.projectId).toBe('pB');
    releaseA(today({ action: action() }));
    await a;
    expect(entry('pA').today?.action?.projectId).toBe('pA');
    expect(entry('pB').today?.action?.projectId).toBe('pB');
    expect(get).toHaveBeenCalledWith('pB', 'Europe/Paris');
  });
  it('sends the business’s zone, and starts a due day once per business per day', async () => {
    get.mockResolvedValue(today({ dueNow: true }));
    post.mockResolvedValue({ action: action() });
    await useMorningStore.getState().load('pA', 'America/Chicago');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('pA', 'visit', 'America/Chicago');
    expect(entry('pA').today?.action?.state).toBe('ready');
    await useMorningStore.getState().load('pA', 'America/Chicago');
    expect(post).toHaveBeenCalledTimes(1);
    // the next day is started again
    get.mockResolvedValue(today({ dueNow: true, actionDay: '2026-11-08' }));
    await useMorningStore.getState().load('pA', 'America/Chicago');
    expect(post).toHaveBeenCalledTimes(2);
  });
  it('never starts by itself for a row that exists, a failed one included; the owner’s press does', async () => {
    get.mockResolvedValue(today({ action: action({ state: 'failed', chosen: null, candidates: [], attempts: 1 }), attemptsLeft: 2 }));
    await useMorningStore.getState().load('pA', 'America/Chicago');
    expect(post).not.toHaveBeenCalled();
    post.mockResolvedValue({ action: action({ attempts: 2, source: 'manual' }) });
    await useMorningStore.getState().start('pA', 'manual', 'America/Chicago');
    expect(post).toHaveBeenCalledWith('pA', 'manual', 'America/Chicago');
    expect(entry('pA').today?.action?.state).toBe('ready');
  });
  it('the third failure leaves no attempts; a 429 that says tomorrow shows it', async () => {
    get.mockResolvedValue(today({ action: action({ state: 'failed', chosen: null, attempts: 2 }), attemptsLeft: 1 }));
    await useMorningStore.getState().load('pA', 'UTC');
    post.mockResolvedValue({ action: action({ state: 'failed', chosen: null, attempts: 3 }) });
    await useMorningStore.getState().start('pA', 'manual', 'UTC');
    expect(entry('pA').today?.attemptsLeft).toBe(0);
    post.mockRejectedValue(new IntegrationApiError(429, { error: 'Try again tomorrow.', code: 'RATE_LIMITED' }));
    await useMorningStore.getState().start('pA', 'manual', 'UTC');
    expect(entry('pA').today?.attemptsLeft).toBe(0);
    post.mockRejectedValue(new IntegrationApiError(429, { error: 'Try again in a few minutes.', code: 'RATE_LIMITED' }));
    get.mockResolvedValue(today({ dueNow: false }));
    await useMorningStore.getState().load('pB', 'UTC');
    await useMorningStore.getState().start('pB', 'manual', 'UTC');
    expect(entry('pB').notice).toBe('Try again in a few minutes.');
  });
  it('a 402 locks the card (the prompt opens only from its button); GET’s paused plan does too; 409 shows the next time', async () => {
    get.mockResolvedValue(today({ dueNow: false, plan: 'paused', planCode: 'PAYMENT_REQUIRED' }));
    await useMorningStore.getState().load('pA', 'UTC');
    expect(entry('pA').locked).toBe('PAYMENT_REQUIRED');
    get.mockResolvedValue(today({ dueNow: true }));
    post.mockRejectedValue(new IntegrationApiError(402, { error: 'This needs a plan.', code: 'PLAN_REQUIRED' }));
    await useMorningStore.getState().load('pB', 'UTC');
    expect(entry('pB').locked).toBe('PLAN_REQUIRED');
    post.mockRejectedValue(new IntegrationApiError(409, { error: 'Your next action comes at 5:00 AM.', code: 'NOT_DUE', nextAt: '2026-11-08T05:00:00.000Z' }));
    await useMorningStore.getState().start('pB', 'manual', 'UTC');
    expect(entry('pB').today).toMatchObject({ late: true, dueNow: false, nextAt: '2026-11-08T05:00:00.000Z' });
  });
  it('a network failure is plain words', async () => {
    get.mockRejectedValue(new IntegrationApiError(0, null, 'Couldn’t reach the app’s server. Check your connection and try again.'));
    await useMorningStore.getState().load('pA', 'UTC');
    expect(entry('pA').error).toContain('Couldn’t reach');
  });
});

describe('while it’s being made', () => {
  it('asks again every 3 s, then stops after 90 s with a note', async () => {
    vi.useFakeTimers();
    get.mockResolvedValue(today({ action: action({ state: 'generating', chosen: null, candidates: [] }) }));
    await useMorningStore.getState().load('pA', 'UTC');
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_FOR_MS + POLL_MS * 2);
    const calls = get.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(2 + POLL_FOR_MS / POLL_MS + 1);
    expect(entry('pA')).toMatchObject({ stalled: true, notice: STILL_WORKING });
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(get.mock.calls.length).toBe(calls);
  });
  it('stops as soon as it’s ready', async () => {
    vi.useFakeTimers();
    get.mockResolvedValueOnce(today({ action: action({ state: 'generating', chosen: null, candidates: [] }) })).mockResolvedValue(today({ action: action() }));
    await useMorningStore.getState().load('pA', 'UTC');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(entry('pA').today?.action?.state).toBe('ready');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('feedback, accounts and the claude.ai build', () => {
  it('feedback replaces the action with the answer', async () => {
    get.mockResolvedValue(today({ action: action() }));
    await useMorningStore.getState().load('pA', 'UTC');
    fb.mockResolvedValue({ action: action({ state: 'done', doneAt: '2026-11-07T15:00:00.000Z' }) });
    expect(await useMorningStore.getState().feedback('pA', action().id, 'done')).toBe(true);
    expect(fb).toHaveBeenCalledWith(action().id, 'done', undefined, undefined);
    expect(entry('pA').today?.action?.state).toBe('done');
  });
  it('another account resets everything, and an answer from before is dropped', async () => {
    let release!: (t: MorningToday) => void;
    get.mockImplementation(() => new Promise((r) => (release = r)));
    const p = useMorningStore.getState().load('pA', 'UTC');
    useMorningStore.getState().reset();
    release(today({ action: action() }));
    await p;
    expect(useMorningStore.getState().byProject).toEqual({});
  });
  it('makes no request in the claude.ai build', async () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await useMorningStore.getState().load('pA', 'UTC');
    await useMorningStore.getState().start('pA', 'manual', 'UTC');
    expect(await useMorningStore.getState().feedback('pA', 'x', 'done')).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
});
