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

import { afterEach } from 'vitest';
import type { AgentsHealth } from '@/lib/agentTypes';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import { newProject } from '@/store/defaults';
import { defaultSettings } from '@/store/defaults';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import AssistantPanel from './AssistantPanel';

const m = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m-${role}-${text.length}`, role, text, at: 1, ...extra });
// the panel's icon buttons have tooltips: the app mounts their provider in main.tsx
const render = () => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AssistantPanel, { onClose: () => {} })));

beforeEach(() => {
  const project = { ...newProject('business', 'existing'), id: 'p1', onboarded: true };
  project.brand.name = 'Copper Kettle';
  project.brand.websiteUrl = 'https://copperkettle.example';
  fake.store = { projects: [project], activeProjectId: 'p1', posts: [], notices: [], myListings: [], ads: [], skills: [], settings: defaultSettings() };
  fake.chat = { threads: {}, running: false, stage: '', runProjectId: null, open: true, agents: {}, unread: {}, sendingTo: {} };
  useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { assistant: ['openai'] } } });
});
afterEach(() => vi.unstubAllGlobals());

const agents = (o: { viktor?: Partial<AgentsHealth['viktor']>; manusChat?: AgentsHealth['manus']['chat'] } = {}): AgentsHealth => ({
  manus: { build: { ready: true, reason: 'ok' }, chat: o.manusChat ?? { ready: true, reason: 'ok' }, own: false, profile: 'standard' },
  viktor: { ready: true, reason: 'ok', where: 'dm', place: '', ...o.viktor },
});
const serve = (a: AgentsHealth) => useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { assistant: ['openai'] }, agents: a } });
const chatWith = (msgs: ChatMessage[], extra: Record<string, unknown> = {}) => (fake.chat = { ...fake.chat, threads: { p1: msgs }, ...extra });
/** The markup without React's separators between neighbouring bits of text. */
const flat = (html: string) => html.replace(/<!-- -->/g, '');

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
    // full screen on phones, a 400px sheet at the right from 640px, docked beside the stage from 1440px (no scrim)
    expect(html).toMatch(/class="fixed inset-0 z-overlay[^"]*sm:bottom-2 sm:right-2 sm:top-2 sm:w-\[400px\][^"]*sm:shadow-dialog min-\[1440px\]:shadow-xs/);
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
    expect(html).toMatch(/<a href="#calendar" class="link">calendar<svg/);
    expect(html).toContain('<span class="sr-only">Done:</span>');
    expect(html).toContain('Used your AI');
    // a button from before a reload can't be pressed
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="This button expired when the page reloaded. Ask again."/);
    expect(html).toContain('<span class="sr-only">Not something I do:</span>');
    expect(html).toContain('role="group" aria-label="Make a 5-second video?"');
    expect(html).toContain('About $0.18');
    expect(html).toContain('You said no.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Open Settings › AI keys');
    expect(html).toContain('Stopped.');
    expect(html).toContain('Thinking…');
    expect(html).toContain('aria-label="Stop the assistant"');
  });

  it('says plainly when there’s no AI, links Settings › AI keys, and still offers pages', () => {
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: false, routing: {} } });
    const html = render();
    expect(html).toContain('No API key powers the Assistant yet.');
    expect(html).toContain('Open the content calendar');
    expect(html).toContain('Create a post');
    expect(html).toContain('Open Settings › AI keys');
    expect(html).toContain('placeholder="Name a page to open…"');
  });
});

describe('talking to Manus and Viktor', () => {
  it('has a To: switch (Assistant · Manus · Viktor) above the box', () => {
    serve(agents());
    const html = flat(render());
    expect(html).toMatch(/<span id="[^"]+-label"[^>]*>To:<\/span><div role="radiogroup" aria-labelledby="[^"]+-label"/);
    for (const name of ['Assistant', 'Manus', 'Viktor']) expect(html).toMatch(new RegExp(`role="radio" aria-checked="(true|false)"[^>]*>(<svg[\\s\\S]*?</svg>)?${name}</button>`));
    // the assistant is chosen until the owner picks another: its own box and hint
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>(<svg[\s\S]*?<\/svg>)?Assistant</);
    expect(html).toContain('<label for="assistant-input" class="sr-only">Message the assistant</label>');
  });

  it('offers Viktor only to the owner, shows an agent that isn’t ready disabled with why, and hides it all in claude.ai', () => {
    serve(agents({ viktor: { ready: false, reason: 'owner_only' } }));
    expect(render()).not.toMatch(/>Viktor<\/button>/);
    serve(agents({ viktor: { ready: false, reason: 'no_place' }, manusChat: { ready: false, reason: 'not_ticked' } }));
    const html = flat(render());
    expect(html).toContain('title="Choose where to talk to Viktor (your DM or a channel) in Settings › AI keys › Viktor (Slack)."');
    expect(html).toMatch(/aria-checked="false" disabled=""[^>]*>(<svg[\s\S]*?<\/svg>)?Viktor</);
    expect(html).toContain('Tick “Chat with Manus” for your Manus key in Settings › AI keys.');
    expect(html).toMatch(/<button type="button" class="link[^"]*">Set up<\/button>/);
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    serve(agents());
    expect(render()).not.toContain('role="radiogroup"');
  });

  it('To: Viktor: the box says who it goes to, who answers and what it costs, with a counter, images and the website', () => {
    serve(agents());
    fake.chat = { ...fake.chat, agents: { p1: { to: 'viktor', imageMax: 0 } } };
    const html = flat(render());
    expect(html).toContain('placeholder="Message Viktor…"');
    expect(html).toContain('aria-label="Send to Viktor"');
    expect(html).toContain('<label for="assistant-input" class="sr-only">Message Viktor</label>');
    expect(html).toContain('aria-label="Attach images for Viktor"');
    expect(html).toContain('Add my website');
    expect(html).toContain('0 / 3,500');
    expect(html).toContain('Viktor answers in Slack. The app posts your messages as you in your DM with Viktor, in one thread for this chat.');
    expect(html).toContain('Viktor’s work counts toward your viktor.com plan. This app can’t see how much it uses.');
    expect(html).not.toContain('Enter sends, Shift+Enter starts a new line.');
    fake.chat = { ...fake.chat, agents: { p1: { to: 'manus', imageMax: 0, manus: { taskId: 'task000001', taskUrl: '', startedAt: 1, seen: [], credits: 41 } } } };
    const manus = flat(render());
    expect(manus).toContain('0 / 6,000');
    expect(manus).toContain('Credits used in this chat: 41.');
    expect(manus).toContain('Uses your Manus credits.');
  });

  it('shows the owner’s messages to them: where they went, drafted or not, and whether they arrived', () => {
    serve(agents());
    chatWith([
      m('user', 'Build me a page', { id: 'u1', via: 'viktor', delivery: 'sent', website: true }),
      m('user', 'Please make it darker.', { id: 'u2', via: 'viktor', delivery: 'sent', drafted: true }),
      m('user', 'Are you there?', { id: 'u3', via: 'manus', delivery: 'unknown', deliveryNote: 'May have been delivered: the connection dropped after your message left. The app is checking Manus.' }),
      m('user', 'Hello?', { id: 'u4', via: 'viktor', delivery: 'failed', undelivered: true, deliveryNote: 'Not delivered: it isn’t in Slack. You can send it again.' }),
      m('user', 'Too long', { id: 'u5', via: 'viktor', delivery: 'failed', deliveryNote: 'Too long for one Slack message (3,612 of 3,500 characters). Shorten your words.' }),
    ]);
    const html = flat(render());
    expect(html).toContain('To Viktor');
    expect(html).toContain('To Viktor · Drafted by the assistant · sent by you');
    expect(html).toContain('With your website');
    expect(html).toContain('Sent<span class="sr-only"> to Viktor</span>');
    expect(html).toContain('May have been delivered: the connection dropped after your message left. The app is checking Manus.');
    expect(html).toMatch(/ Check<\/button>/);
    expect(html).toContain('Not delivered: it isn’t in Slack. You can send it again.');
    expect(html.match(/Send again<\/button>/g)).toHaveLength(1);
    expect(html).toContain('Too long for one Slack message');
  });

  it('shows their replies as their own messages: text only (no app links, no HTML), with images, pages and files', () => {
    serve(agents());
    chatWith([
      m('external', 'See [Settings](#workspace-settings/ai) or [the page](https://example.com/p) <img src=x onerror=alert(1)>', {
        id: 'x1',
        via: 'viktor',
        from: 'viktor',
        agentRef: { ts: '1.1', threadId: 'vk_aaaaaaaaaaaaaaaaaaaaaa', edited: '1.2', url: 'https://qa.slack.com/p1' },
        html: { at: '1.1', source: 'code', bytes: 9400, complete: true },
        files: [{ id: '1.1:F1', name: 'notes.pdf', kind: 'other', bytes: 2048 }],
      }),
      m('external', 'Here is part of it', { id: 'x2', via: 'viktor', from: 'viktor', agentRef: { ts: '1.3', threadId: 'vk_aaaaaaaaaaaaaaaaaaaaaa' }, html: { at: '1.3', source: 'code', bytes: 5000, complete: false } }),
      m('external', 'Gone now', { id: 'x3', via: 'viktor', from: 'viktor', gone: true, agentRef: { ts: '1.4', threadId: 'vk_aaaaaaaaaaaaaaaaaaaaaa' }, html: { at: '1.4', source: 'code', bytes: 900, complete: true } }),
      m('external', 'typed in Slack', { id: 'x4', via: 'viktor', from: 'you-in-slack', agentRef: { ts: '1.5' } }),
      m('external', 'Someone else wrote in this thread.', { id: 'x5', via: 'viktor', from: 'other', agentRef: { ts: '1.6' } }),
    ]);
    const html = flat(render());
    expect(html).toContain('role="group" aria-label="From Viktor"');
    expect(html).toContain('· edited in Slack');
    // an app link from outside the app stays text; an https link opens in a new tab; HTML is never rendered
    expect(html).not.toContain('href="#workspace-settings"');
    expect(html).toMatch(/See Settings or <a href="https:\/\/example.com\/p" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src="x"');
    // a page: Preview, Open as asset, Use as my SEO page; a part of one says why instead
    expect(html).toContain('page.html');
    expect(html).toContain('9.2 KB');
    expect(html.match(/ Preview<\/button>/g)).toHaveLength(1);
    expect(html).toMatch(/Open as asset<\/button>/);
    expect(html).toMatch(/Use as my SEO page<\/button>/);
    expect(html).toContain('Viktor sent only part of the page: ask for the whole page as one file.');
    expect(html).toContain('aria-label="Download notes.pdf"');
    expect(html).toContain('Deleted in Slack');
    expect(html).toContain('It was deleted in Slack.');
    expect(html).toContain('aria-label="You (in Slack)"');
    expect(html).toContain('aria-label="Someone in the thread"');
  });

  it('Manus: the newest question’s choices are buttons; opening and progress messages fold once a result came', () => {
    serve(agents());
    const ref = { taskId: 'task000001' };
    chatWith([
      m('external', 'On it.', { id: 'o1', via: 'manus', from: 'manus', deliveryKind: 'opening', agentRef: { eventId: 'e2', ...ref } }),
      m('external', 'Working…', { id: 'o2', via: 'manus', from: 'manus', deliveryKind: 'progress', agentRef: { eventId: 'e3', ...ref } }),
      m('external', 'Done: here are three ideas.', { id: 'o3', via: 'manus', from: 'manus', deliveryKind: 'result', agentRef: { eventId: 'e4', ...ref } }),
      m('external', 'Which color should the button be?', { id: 'o4', via: 'manus', from: 'manus', options: ['Blue', 'Green'], agentRef: { eventId: 'e5', ...ref } }),
      m('notice', 'Manus is waiting for you to approve something in Manus: “Please sign in”. Sending a message here skips that step.', { id: 'n1', via: 'manus', agentRef: { ...ref, url: 'https://manus.im/app/task000001' } }),
    ]);
    const html = flat(render());
    expect(html.match(/Manus is working: show/g)).toHaveLength(2);
    expect(html).not.toContain('On it.');
    expect(html).toContain('Done: here are three ideas.');
    expect(html).toContain('aria-label="Answer Manus"');
    expect(html).toMatch(/>Blue<\/button>/);
    expect(html).toContain('Or answer in your own words below.');
    expect(html).toMatch(/<a href="https:\/\/manus.im\/app\/task000001" target="_blank" rel="noopener noreferrer"[^>]*>Open in Manus/);
    // answered: no more buttons
    chatWith([m('external', 'Which color should the button be?', { id: 'o4', via: 'manus', from: 'manus', options: ['Blue', 'Green'], agentRef: { eventId: 'e5', ...ref } }), m('user', 'Blue', { id: 'u9', via: 'manus', delivery: 'sent' })]);
    expect(flat(render())).not.toContain('aria-label="Answer Manus"');
  });

  it('a card can show the exact text that goes, in full, with Copy', () => {
    chatWith([m('card', 'Send this to Viktor?', { id: 'c1', card: { title: 'Send this to Viktor?', what: 'The assistant drafted this message for you.', quote: 'Please make it darker.\nThanks!', who: 'Viktor answers in Slack.', cost: 'Your viktor.com plan.', confirmLabel: 'Send to Viktor', state: 'confirmed' } })]);
    const html = flat(render());
    expect(html).toMatch(/aria-label="The exact message">Please make it darker.\nThanks!<\/p>/);
    expect(html).toMatch(/>Copy<\/button>/);
  });
});
