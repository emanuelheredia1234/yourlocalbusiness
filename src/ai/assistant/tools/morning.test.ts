// The assistant and today's action: it reads it (never makes one) and marks it done only when it's ready, on the
// server's path and with the built-in version kept on this device. The catalog lists both.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/integrations/api', async (original) => ({
  ...(await original<typeof import('@/lib/integrations/api')>()),
  getMorningToday: vi.fn(),
  startMorning: vi.fn(),
  sendMorningFeedback: vi.fn(),
}));

const api = await import('@/lib/integrations/api');
const { useAuth } = await import('@/lib/cloud/auth');
const { useMorningConfig } = await import('@/lib/morning/config');
const { localKey } = await import('@/lib/morning/local');
const { safeStorage } = await import('@/lib/storage');
const { useMorningStore } = await import('@/store/morning');
const { fakeHost, runTool, seedWorkspace, TEST_PROJECT } = await import('../testing');
const { registry } = await import('.');
const { toolCatalog } = await import('../catalog');
const { TOOL_GROUPS } = await import('.');
import type { MorningAction, MorningToday } from '@/lib/integrations/types';

const get = vi.mocked(api.getMorningToday);
const start = vi.mocked(api.startMorning);
const fb = vi.mocked(api.sendMorningFeedback);

const action = (o: Partial<MorningAction> = {}): MorningAction => ({
  id: '11111111-1111-4111-8111-111111111111',
  projectId: TEST_PROJECT,
  localDate: '2026-11-07',
  timeZone: 'UTC',
  state: 'ready',
  source: 'cron',
  engine: 'ai',
  chosen: 0,
  candidates: [
    { key: 'leads:x', kind: 'leads', title: 'Reply to your 2 new leads', why: '2 people got in touch recently. Reply today.', target: {}, from: 'rule' },
    { key: 'strategy', kind: 'strategy', title: 'Plan your marketing strategy', why: 'A short plan tells you what to post.', target: {}, from: 'rule' },
  ],
  feedback: [],
  fallback: null,
  credits: 1,
  ownKey: false,
  generatedAt: null,
  doneAt: null,
  ...o,
});
const today = (o: Partial<MorningToday> = {}): MorningToday => ({ actionDay: '2026-11-07', timeZone: 'UTC', action: action(), dueNow: false, late: false, nextAt: '2026-11-08T05:00:00.000Z', attemptsLeft: 3, plan: 'active', ...o });

let host: ReturnType<typeof fakeHost>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  seedWorkspace({ project: { timeZone: 'UTC' } });
  useMorningStore.getState().reset();
  get.mockReset();
  start.mockReset();
  fb.mockReset();
  safeStorage.removeItem(localKey(TEST_PROJECT));
  host = fakeHost();
});
afterEach(() => {
  host.restore();
  vi.useRealTimers();
  useAuth.setState({ phase: 'loading' });
  useMorningConfig.setState({ config: null });
});

const serverMode = () => {
  useAuth.setState({ phase: 'ready', user: { id: 'u1', email: 'a@b.c' } });
  useMorningConfig.setState({ config: { enabled: true, reachable: true } });
};

describe('the server’s path', () => {
  beforeEach(serverMode);
  it('get_todays_action reads today (a read, never a start) and says where Do it goes', async () => {
    get.mockResolvedValue(today());
    const r = await runTool('get_todays_action');
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ date: '2026-11-07', state: 'ready', title: 'Reply to your 2 new leads', kind: 'leads', page: 'Email › Leads', from: 'AI pick', ideasLeft: 1, done: false });
    expect(get).toHaveBeenCalledWith(TEST_PROJECT, 'UTC');
    expect(start).not.toHaveBeenCalled();
  });
  it('says why there’s none: before 5 am, not made yet, needs a plan', async () => {
    get.mockResolvedValueOnce(today({ action: null, late: true }));
    expect((await runTool('get_todays_action')).result).toEqual({ none: true, why: 'before 5 am' });
    useMorningStore.getState().reset();
    get.mockResolvedValueOnce(today({ action: null, dueNow: true }));
    expect((await runTool('get_todays_action')).result).toEqual({ none: true, why: 'not made yet: the Dashboard card makes it' });
    useMorningStore.getState().reset();
    get.mockResolvedValueOnce(today({ action: null, plan: 'paused', planCode: 'PLAN_REQUIRED' }));
    expect((await runTool('get_todays_action')).result).toEqual({ none: true, why: 'needs a plan' });
    expect(start).not.toHaveBeenCalled();
  });
  it('mark_todays_action_done sends done for a ready action, and refuses otherwise', async () => {
    expect(registry.get('mark_todays_action_done')).toMatchObject({ class: 'L' });
    get.mockResolvedValue(today());
    fb.mockResolvedValue({ action: action({ state: 'done' }) });
    const r = await runTool('mark_todays_action_done');
    expect(r.ok).toBe(true);
    expect(fb).toHaveBeenCalledWith(action().id, 'done', undefined, undefined);
    useMorningStore.getState().reset();
    get.mockResolvedValue(today({ action: action({ state: 'done' }) }));
    const again = await runTool('mark_todays_action_done');
    expect(again.ok).toBe(false);
    expect(again.error).toContain('already done');
    expect(fb).toHaveBeenCalledTimes(1);
  });
});

describe('the built-in version (no accounts, the claude.ai build)', () => {
  it('reads and marks done on this device, with no request', async () => {
    useAuth.setState({ phase: 'off' });
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await runTool('get_todays_action');
    expect(r.result).toMatchObject({ state: 'ready', from: 'built in', done: false });
    const d = await runTool('mark_todays_action_done');
    expect(d.ok).toBe(true);
    expect((await runTool('get_todays_action')).result).toMatchObject({ state: 'done', done: true });
    expect(get).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('off: says so', async () => {
    useAuth.setState({ phase: 'signed-out' });
    expect((await runTool('get_todays_action')).result).toEqual({ none: true, why: 'The morning action isn’t on here.' });
    expect((await runTool('mark_todays_action_done')).ok).toBe(false);
  });
});

describe('the catalog', () => {
  it('lists both tools in full on every page', () => {
    expect(registry.get('get_todays_action')).toMatchObject({ class: 'R' });
    const c = toolCatalog(TOOL_GROUPS, { route: 'calendar', message: 'hi' });
    expect(c.full).toContain('get_todays_action');
    expect(c.full).toContain('mark_todays_action_done');
  });
});
