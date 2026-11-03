// The assistant's chats on this device: per account, the last 40 messages per project, what a reload
// can't keep (cards, buttons), and Log out clearing them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeStorage } from '@/lib/storage';
import { clearDeviceKeys } from '@/lib/cloud/auth';
import { MAX_KEPT, addMessage, askCard, assistantStorageKey, buttonAlive, chatOf, clearChat, loadChats, registerButtons, saveChats, stopTurn, beginTurn, endTurn, useAssistant } from './assistant';

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
  useAssistant.setState({ key: null, threads: {}, running: false, stage: '', runProjectId: null });
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
