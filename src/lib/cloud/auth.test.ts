import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isSameOriginAuthTarget, signOut, startAuth, useAuth } from './auth';
import { beginTurn } from '@/store/assistant';
import { useStrategyJobs } from '@/ai/strategyJob';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: null } }), signOut: async () => ({ error: null }) } }),
}));

describe('Supabase bearer target validation', () => {
  it('allows relative and absolute requests to the app origin', () => {
    expect(isSameOriginAuthTarget('/api/ai/generate', 'https://app.example')).toBe(true);
    expect(isSameOriginAuthTarget('https://app.example/api/ai/generate', 'https://app.example')).toBe(true);
  });

  it('rejects unrelated or malformed server URLs', () => {
    expect(isSameOriginAuthTarget('https://other.example/api/ai/generate', 'https://app.example')).toBe(false);
    expect(isSameOriginAuthTarget('http://[invalid', 'https://app.example')).toBe(false);
  });
});

/** The browser's channel between tabs, in memory: a message reaches the other channels of the same name. */
class FakeChannel {
  static open = new Set<FakeChannel>();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    FakeChannel.open.add(this);
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.open) if (c !== this && c.name === this.name) c.onmessage?.({ data });
  }
  close() {
    FakeChannel.open.delete(this);
  }
}

describe('a tab that lets the workspace go', () => {
  beforeAll(async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.stubGlobal('location', { protocol: 'http:', origin: 'http://app.test', pathname: '/', search: '', hash: '', reload: vi.fn() });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accounts: { enabled: true, url: 'https://db.example', publishableKey: 'pk_test', signInRequired: true, canDeleteAccount: false } }), { status: 200 })));
    await startAuth();
  });
  afterAll(() => vi.unstubAllGlobals());

  /** Signed in, with a Strategy run and an assistant turn under way in this tab. */
  function working() {
    useAuth.getState().set({ phase: 'ready', user: { id: 'u1', email: 'owner@example.com' } });
    const controller = new AbortController();
    useStrategyJobs.setState({ jobs: { p1: { projectId: 'p1', steps: ['research'], index: 0, stage: 'Asking your AI…', startedAt: 1, costUsd: 0, searches: 0, requests: 0, controller } } });
    return { run: controller.signal, turn: beginTurn('p1') };
  }

  it('steps aside when another tab opens the account: its Strategy run and the assistant’s turn stop (nothing more is spent for results it can’t save)', async () => {
    const { run, turn } = working();
    new FakeChannel('ylb-workspace').postMessage({ type: 'claim', userId: 'u1', tab: 'another-tab' });
    expect(useAuth.getState().phase).toBe('elsewhere');
    await vi.waitFor(() => expect(run.aborted).toBe(true));
    expect(turn.aborted).toBe(true);
  });

  it('logs out: the runs stop before it saves and leaves', async () => {
    const { run, turn } = working();
    expect(await signOut({ force: true })).toBe('done');
    expect(run.aborted).toBe(true);
    expect(turn.aborted).toBe(true);
    expect(location.reload).toHaveBeenCalled();
  });
});
