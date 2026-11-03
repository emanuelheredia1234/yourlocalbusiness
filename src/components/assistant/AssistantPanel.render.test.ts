// The chat panel, rendered to HTML (no browser needed): every kind of message, the starters, and
// what it says without an AI.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@/store/assistant';

// A server render reads a store's first state, so the stores are stood in for, set per test.
const fake = vi.hoisted(() => ({ store: {} as Record<string, unknown>, chat: {} as Record<string, unknown> }));
vi.mock('@/store/useStore', () => {
  const useStore = Object.assign((sel: (s: unknown) => unknown) => sel(fake.store), { getState: () => fake.store, setState: () => {}, subscribe: () => () => {} });
  const active = () => (fake.store.projects as { id: string }[])[0] ?? null;
  return { useStore, useActiveProject: active, getActiveProject: active };
});
vi.mock('@/store/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/assistant')>()),
  useAssistant: Object.assign((sel: (s: unknown) => unknown) => sel(fake.chat), { getState: () => fake.chat, setState: () => {} }),
}));

import { newProject } from '@/store/defaults';
import { defaultSettings } from '@/store/defaults';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import AssistantPanel from './AssistantPanel';

const m = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m-${role}-${text.length}`, role, text, at: 1, ...extra });
const render = () => renderToStaticMarkup(createElement(AssistantPanel, { onClose: () => {} }));

beforeEach(() => {
  const project = { ...newProject('business', 'existing'), id: 'p1', onboarded: true };
  project.brand.name = 'Copper Kettle';
  fake.store = { projects: [project], activeProjectId: 'p1', posts: [], notices: [], myListings: [], ads: [], skills: [], settings: defaultSettings() };
  fake.chat = { threads: {}, running: false, stage: '', runProjectId: null, open: true };
  useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { assistant: ['openai'] } } });
});

describe('the chat panel', () => {
  it('is a labelled window with New chat, Close, starters and an input that says how Enter works', () => {
    const html = render();
    expect(html).toContain('id="assistant-panel" role="dialog" aria-modal="false" aria-labelledby="assistant-title"');
    expect(html).toContain('<h2 id="assistant-title"');
    expect(html).toContain('For Copper Kettle');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Start over with an empty chat"/);
    expect(html).toContain('aria-label="Close assistant"');
    expect(html).toContain('role="log" aria-live="polite"');
    expect(html).toContain('Help me write my first post');
    expect(html).toContain('<label for="assistant-input" class="sr-only">Message the assistant</label>');
    expect(html).toContain('Enter sends, Shift+Enter starts a new line.');
    // a full-height sheet on phones, about 400×600 at the bottom right from tablets up
    expect(html).toMatch(/class="fixed inset-0 z-\[45\][^"]*sm:bottom-4 sm:right-4 sm:h-\[600px\][^"]*sm:w-\[400px\]/);
  });

  it('shows each kind of message', () => {
    fake.chat = {
      ...fake.chat,
      running: true,
      runProjectId: 'p1',
      stage: 'Thinking…',
      threads: {
        p1: [
          m('user', 'What is due?'),
          m('assistant', 'You have **1 post** due. See the [calendar](#calendar).'),
          m('activity', 'Wrote new copy', { tool: 'write_copy', status: 'ok', ai: 'used', buttons: [{ id: 'gone', label: 'Download CSV', icon: 'download' }] }),
          m('activity', 'API keys are changed only by you', { tool: 'change_ai_settings', status: 'refused' }),
          m('card', 'Make a 5-second video?', { card: { title: 'Make a 5-second video?', what: 'For your Friday post', who: 'OpenRouter', cost: 'About $0.18', confirmLabel: 'Make the video', state: 'declined' } }),
          m('error', 'No API key powers the Assistant yet.', { settings: true }),
          m('notice', 'Stopped.'),
        ],
      },
    };
    const html = render();
    expect(html).toContain('What is due?</p>');
    expect(html).toContain('<a href="#calendar" class="link">calendar</a>');
    expect(html).toContain('<span class="sr-only">Done:</span>');
    expect(html).toContain('Used your AI');
    // a button from before a reload can't be pressed
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="This button expired when the page reloaded. Ask again."/);
    expect(html).toContain('<span class="sr-only">Not something I do:</span>');
    expect(html).toContain('role="group" aria-label="Make a 5-second video?"');
    expect(html).toContain('About $0.18');
    expect(html).toContain('You said no.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Open Settings → AI');
    expect(html).toContain('Stopped.');
    expect(html).toContain('Thinking…');
    expect(html).toContain('aria-label="Stop the assistant"');
  });

  it('says plainly when there’s no AI, links Settings → AI, and still offers pages', () => {
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: false, routing: {} } });
    const html = render();
    expect(html).toContain('No API key powers the Assistant yet.');
    expect(html).toContain('Open the content calendar');
    expect(html).toContain('Create a post');
    expect(html).toContain('Open Settings → AI');
    expect(html).toContain('placeholder="Name a page to open…"');
  });
});
