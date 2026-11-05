// Who builds or answers, whether they're ready, and what it costs: the words on every button, window and card.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import type { AgentsHealth } from '@/lib/agentTypes';
import { agentCost, agentPlace, agentReady, agentWho } from './who';

const agents = (o: { manus?: Partial<AgentsHealth['manus']>; viktor?: Partial<AgentsHealth['viktor']> } = {}): AgentsHealth => ({
  manus: { build: { ready: true, reason: 'ok' }, chat: { ready: true, reason: 'ok' }, own: false, profile: 'standard', ...o.manus },
  viktor: { ready: true, reason: 'ok', where: 'dm', place: '', ...o.viktor },
});
const serve = (a?: AgentsHealth) => useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, ...(a ? { agents: a } : {}) } });

afterEach(() => {
  useRuntime.getState().set({ server: 'unknown', ai: NO_AI_SERVER });
  vi.unstubAllGlobals();
});

describe('readiness', () => {
  it('is hidden in the claude.ai artifact', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    serve(agents());
    expect(agentReady('manus', 'build')).toMatchObject({ show: false, ready: false });
    expect(agentReady('viktor', 'chat')).toMatchObject({ show: false, ready: false });
  });

  it('says when the server is down, still being checked, or too old', () => {
    useRuntime.getState().set({ server: 'down' });
    expect(agentReady('manus', 'build')).toMatchObject({ show: true, ready: false, text: 'Your AI server isn’t running.' });
    useRuntime.getState().set({ server: 'unknown', ai: NO_AI_SERVER });
    expect(agentReady('viktor', 'build').text).toBe('Checking your AI server…');
    serve();
    expect(agentReady('viktor', 'build')).toMatchObject({ ready: false, reason: 'old_server' });
  });

  it('reads the server’s reasons, with the fix to make', () => {
    serve(agents({ manus: { build: { ready: false, reason: 'not_ticked' }, chat: { ready: false, reason: 'no_key' } }, viktor: { ready: false, reason: 'no_place' } }));
    expect(agentReady('manus', 'build')).toMatchObject({ show: true, ready: false, settings: true, text: 'Tick “Building pages & assets” for your Manus key in Settings › AI keys.' });
    expect(agentReady('manus', 'chat').text).toBe('Add a Manus API key in Settings › AI keys.');
    expect(agentReady('viktor', 'chat').text).toBe('Choose where to talk to Viktor (your DM or a channel) in Settings › AI keys › Viktor (Slack).');
    serve(agents());
    expect(agentReady('viktor', 'build')).toEqual({ show: true, ready: true, reason: 'ok', text: '', settings: false });
  });

  it('hides Viktor from anyone but the owner', () => {
    serve(agents({ viktor: { ready: false, reason: 'owner_only', where: '', place: '' } }));
    expect(agentReady('viktor', 'chat')).toMatchObject({ show: false, ready: false });
  });
});

describe('who and what it costs', () => {
  it('names the place in Slack, the own key, and never makes up a price', () => {
    serve(agents({ viktor: { where: 'channel', place: '#viktor-builds' }, manus: { own: true } }));
    expect(agentPlace()).toBe('#viktor-builds');
    expect(agentWho('viktor', 'build')).toBe('Viktor, the AI employee from viktor.com in your Slack workspace, builds it. The app posts your request as you in #viktor-builds and reads Viktor’s replies in that thread.');
    expect(agentWho('manus', 'build')).toBe('Manus, an AI agent with its own computer and browser, builds it in your Manus account (your own key). It usually takes a few minutes.');
    serve(agents());
    expect(agentWho('viktor', 'chat')).toBe('Viktor answers in Slack. The app posts your messages as you in your DM with Viktor, in one thread for this chat.');
    expect(agentWho('manus', 'chat')).toBe('Manus, an AI agent with its own computer and browser, answers in one task in your Manus account.');
    expect(agentCost('manus')).toBe('Uses your Manus credits. How many depends on the work (a Max profile uses more); you’ll see what it used when it’s done.');
    expect(agentCost('viktor')).toBe('Viktor’s work counts toward your viktor.com plan. This app can’t see how much it uses.');
    expect(`${agentCost('manus')} ${agentCost('viktor')}`).not.toMatch(/\d/);
  });
});
