// The assistant's chats on this device: per account, the last 40 messages per project, what a reload
// can't keep (cards, buttons), and Log out clearing them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeStorage } from '@/lib/storage';
import { clearDeviceKeys } from '@/lib/cloud/auth';
import { MAX_KEPT, addMessage, addUnread, agentChatOf, askCard, assistantStorageKey, buttonAlive, chatOf, clearChat, clearUnread, flushChats, loadChats, registerButtons, sanitizeAgents, saveChats, setAgentTo, stopTurn, beginTurn, endTurn, updateAgentChat, useAssistant } from './assistant';

const read = (key: string) => JSON.parse(safeStorage.getItem(key) ?? 'null') as { v: number; threads: Record<string, { text: string; card?: { state: string } }[]> } | null;

/** A browser's localStorage stand-in (Object.keys lists what's stored, as in a browser), and its contents. */
function fakeLocalStorage() {
  const store: Record<string, string> = {};
  const api = Object.create({
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => void (store[k] = String(v)),
    removeItem: (k: string) => void delete store[k],
  });
  const storage = new Proxy(api, { ownKeys: () => Object.keys(store), getOwnPropertyDescriptor: (_t, k) => (typeof k === 'string' && k in store ? { value: store[k], enumerable: true, configurable: true } : undefined) });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  return store;
}

beforeEach(() => {
  useAssistant.setState({ key: null, threads: {}, running: false, stage: '', runProjectId: null, agents: {}, unread: {}, sendingTo: {} });
});
afterEach(() => {
  for (const k of ['local', 'u1', 'u2']) safeStorage.removeItem(assistantStorageKey(k));
});

describe('where chats are kept', () => {
  it('uses one key per account on this device', () => {
    expect(assistantStorageKey('u1')).toBe('ylb-assistant:u1');
    expect(assistantStorageKey(null)).toBe('ylb-assistant:local');
    loadChats('u1');
    addMessage('p1', { role: 'user', text: 'Hello from u1' });
    saveChats();
    expect(read('ylb-assistant:u1')?.threads.p1.map((m) => m.text)).toEqual(['Hello from u1']);
    // another account on the same device sees its own chats only
    loadChats('u2');
    expect(chatOf('p1')).toEqual([]);
    loadChats('u1');
    expect(chatOf('p1').map((m) => m.text)).toEqual(['Hello from u1']);
  });

  it('keeps the last 40 messages per project', () => {
    loadChats('u1');
    for (let i = 0; i < 55; i++) addMessage('p1', { role: 'user', text: `m${i}` });
    expect(chatOf('p1')).toHaveLength(MAX_KEPT);
    saveChats();
    const kept = read('ylb-assistant:u1')!.threads.p1;
    expect(kept).toHaveLength(40);
    expect(kept[0].text).toBe('m15');
    clearChat('p1');
    expect(read('ylb-assistant:u1')).toBeNull();
  });

  it('shows a card nobody answered before a reload as expired', () => {
    loadChats('u1');
    askCard('p1', { title: 'Make a video?', what: 'x', who: 'y' });
    saveChats();
    useAssistant.setState({ key: null, threads: {} });
    loadChats('u1');
    expect(chatOf('p1')[0].card?.state).toBe('expired');
  });

  it('keeps chat buttons working only in memory', async () => {
    fakeLocalStorage();
    try {
      loadChats('u1');
      const run = vi.fn();
      const refs = registerButtons([{ label: 'Download CSV', run, icon: 'download' }])!;
      expect(refs).toEqual([{ id: expect.any(String), label: 'Download CSV', icon: 'download' }]);
      expect(buttonAlive(refs[0].id)).toBe(true);
      addMessage('p1', { role: 'activity', text: 'Made the CSV', buttons: refs });
      saveChats();
      // a fresh page: the stored message has the label, but nothing behind it
      vi.resetModules();
      const fresh = await import('./assistant');
      fresh.loadChats('u1');
      expect(fresh.chatOf('p1')[0].buttons?.[0].label).toBe('Download CSV');
      expect(fresh.buttonAlive(refs[0].id)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers a waiting card “no” when the turn stops', async () => {
    loadChats('u1');
    const signal = beginTurn('p1');
    const { answer } = askCard('p1', { title: 'Make a video?', what: 'x', who: 'y' });
    expect(stopTurn()).toBe(true);
    await expect(answer).resolves.toBe(false);
    expect(signal.aborted).toBe(true);
    endTurn(signal);
    expect(useAssistant.getState().running).toBe(false);
  });
});

describe('Manus and Viktor in the chat', () => {
  const THREAD = 'vk_aaaaaaaaaaaaaaaaaaaaaa';

  it('reads a v1 chat (no agents) and a v2 one, and keeps replies from Manus and Viktor as their own kind', () => {
    safeStorage.setItem('ylb-assistant:u1', JSON.stringify({ v: 1, threads: { p1: [{ id: 'a', role: 'user', text: 'hi', at: 1 }] } }));
    loadChats('u1');
    expect(chatOf('p1').map((m) => m.text)).toEqual(['hi']);
    expect(agentChatOf('p1')).toEqual({ to: 'assistant', imageMax: 0 });
    useAssistant.setState({ key: null });
    safeStorage.setItem(
      'ylb-assistant:u1',
      JSON.stringify({
        v: 2,
        threads: { p1: [{ id: 'b', role: 'external', via: 'viktor', from: 'viktor', text: 'From Viktor', at: 2, files: [{ id: '1.1:F1', name: 'page.html', kind: 'html' }] }] },
        agents: { p1: { to: 'viktor', imageMax: 3, viktor: { threadId: THREAD, permalink: 'https://qa.slack.com/p1', startedAt: 1, seen: { '1793723990.000100': '' }, pendingSince: 5 } } },
      }),
    );
    loadChats('u1');
    expect(chatOf('p1')[0]).toMatchObject({ role: 'external', via: 'viktor', files: [{ kind: 'html' }] });
    expect(agentChatOf('p1')).toMatchObject({ to: 'viktor', imageMax: 3, viktor: { threadId: THREAD, pendingSince: 5 } });
  });

  it('saves who each chat sends to, and its task and thread (v2), with no bytes or thumbnails', () => {
    loadChats('u1');
    setAgentTo('p1', 'manus');
    updateAgentChat('p1', (a) => ({ ...a, imageMax: 1, manus: { taskId: 'task000001', taskUrl: 'https://manus.im/app/task000001', startedAt: 1, seen: ['e1'], pendingSince: 2 } }));
    addMessage('p1', { role: 'user', via: 'manus', text: 'hello', delivery: 'sent', images: [{ key: 'img-1', media: { id: 'm1', kind: 'image', name: 'a.jpg', mime: 'image/jpeg', size: 1, createdAt: 0 } }] });
    // a project whose chat is still empty keeps its To: choice too
    setAgentTo('p2', 'viktor');
    saveChats();
    const saved = read('ylb-assistant:u1') as unknown as { v: number; agents: Record<string, { to: string }> };
    expect(saved.v).toBe(2);
    expect(saved.agents.p1).toMatchObject({ to: 'manus', imageMax: 1, manus: { taskId: 'task000001' } });
    expect(saved.agents.p2).toEqual({ to: 'viktor', imageMax: 0 });
    expect(JSON.stringify(saved)).not.toContain('data:image');
  });

  it('drops anything malformed it reads back', () => {
    const agents = sanitizeAgents({
      p1: { to: 'everyone', imageMax: 500, manus: { taskId: 'x' }, viktor: { threadId: 'not-a-thread' } },
      p2: { to: 'manus', imageMax: 2, manus: { taskId: 'task000001', taskUrl: 'javascript:alert(1)', seen: ['e1', 5], waiting: { type: 'messageAskUser', text: 'Which?', answerHere: true } } },
      p3: { to: 'viktor', viktor: { threadId: THREAD, permalink: 'https://qa.slack.com/p1', seen: { '1793723990.000100': '1793723999.000100', bad: 'x', '1793723991.000100': 'nope' } } },
      p4: 'nonsense',
    });
    expect(agents.p1).toEqual({ to: 'assistant', imageMax: 99 });
    expect(agents.p2.manus).toMatchObject({ taskId: 'task000001', taskUrl: '', seen: ['e1'], waiting: { answerHere: true } });
    expect(agents.p3.viktor?.seen).toEqual({ '1793723990.000100': '1793723999.000100', '1793723991.000100': '' });
    expect(agents.p4).toBeUndefined();
  });

  it('a message still on its way when the page closed may have been delivered', () => {
    safeStorage.setItem('ylb-assistant:u1', JSON.stringify({ v: 2, threads: { p1: [{ id: 'u', role: 'user', via: 'viktor', text: 'hi', at: 1, delivery: 'sending', ref: 'ylb-ABCDEF' }] }, agents: {} }));
    loadChats('u1');
    expect(chatOf('p1')[0]).toMatchObject({ delivery: 'unknown', deliveryNote: 'The app closed while sending, so it may have been delivered.' });
  });

  it('New chat forgets the task and thread, keeps To:, and clears the unread count', () => {
    loadChats('u1');
    updateAgentChat('p1', () => ({ to: 'viktor', imageMax: 4, viktor: { threadId: THREAD, permalink: '', startedAt: 1, seen: {} } }));
    addMessage('p1', { role: 'external', via: 'viktor', from: 'viktor', text: 'Hi' });
    addUnread('p1', 2);
    expect(useAssistant.getState().unread.p1).toBe(2);
    clearChat('p1');
    expect(agentChatOf('p1')).toEqual({ to: 'viktor', imageMax: 0 });
    expect(useAssistant.getState().unread.p1).toBeUndefined();
    addUnread('p2', 1);
    clearUnread('p2');
    expect(useAssistant.getState().unread).toEqual({});
  });

  it('a save that’s waiting is written at once when the page closes', () => {
    loadChats('u1');
    setAgentTo('p1', 'manus');
    expect(read('ylb-assistant:u1')).toBeNull();
    flushChats();
    expect((read('ylb-assistant:u1') as unknown as { agents: Record<string, { to: string }> }).agents.p1.to).toBe('manus');
  });
});

describe('Log out', () => {
  it('clears every account’s assistant chats from this device, with the other per-device keys', () => {
    const store = fakeLocalStorage();
    try {
      for (const k of ['ylb-assistant:u1', 'ylb-assistant:local', 'ylb-post-account:p1:x', 'ylb-manus-pending', 'yourlocalbusiness-state', 'ylb-theme']) safeStorage.setItem(k, '1');
      clearDeviceKeys();
      expect(Object.keys(store).sort()).toEqual(['ylb-theme', 'yourlocalbusiness-state']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
