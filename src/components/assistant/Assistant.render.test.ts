// What the chat shows, rendered to HTML (no browser needed): the chat button, and replies with lists,
// bold and links (app pages open in the app; nothing else becomes a live link).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// A server render reads a store's first state, so the stores are stood in for, set per test.
const fake = vi.hoisted(() => ({ store: {} as Record<string, unknown>, chat: {} as Record<string, unknown> }));
vi.mock('@/store/useStore', () => ({ useStore: Object.assign((sel: (s: unknown) => unknown) => sel(fake.store), { getState: () => fake.store }) }));
vi.mock('@/store/assistant', () => ({ useAssistant: Object.assign((sel: (s: unknown) => unknown) => sel(fake.chat), { getState: () => fake.chat }), loadChats: () => {} }));

import { Assistant } from './Assistant';
import { ChatText, appLink } from './ChatText';

const text = (t: string) => renderToStaticMarkup(createElement(ChatText, { text: t, onOpenPage: () => {} }));

describe('the chat button', () => {
  beforeEach(() => {
    fake.store = { activeProjectId: 'p1' };
    fake.chat = { open: false, running: false, threads: {}, runProjectId: null, setOpen: () => {} };
  });

  it('is a round button at the bottom right, above the page and below windows, named “Open assistant”, with an AI mark', () => {
    const html = renderToStaticMarkup(createElement(Assistant));
    expect(html).toContain('aria-label="Open assistant"');
    expect(html).toContain('aria-controls="assistant-panel"');
    expect(html).toMatch(/class="fixed z-\[45\][^"]*rounded-full/);
    expect(html).toContain('right:max(16px, env(safe-area-inset-right, 0px))');
    expect(html).toContain('bottom:max(16px, env(safe-area-inset-bottom, 0px))');
    expect(html).toMatch(/aria-hidden="true"[^>]*>AI<\/span>/);
  });

  it('shows that it’s working while a turn runs with the panel closed', () => {
    fake.chat = { ...fake.chat, running: true, runProjectId: 'p1' };
    expect(renderToStaticMarkup(createElement(Assistant))).toContain('title="The assistant is working"');
    fake.chat = { ...fake.chat, threads: { p1: [{ id: 'c1', role: 'card', text: 'x', at: 1, card: { title: 'x', what: 'y', who: 'z', confirmLabel: 'Go', state: 'pending' } }] } };
    expect(renderToStaticMarkup(createElement(Assistant))).toContain('title="The assistant is waiting for you to confirm"');
  });

  it('isn’t shown without a project', () => {
    fake.store = { activeProjectId: null };
    expect(renderToStaticMarkup(createElement(Assistant))).toBe('');
  });
});

describe('a reply', () => {
  it('has paragraphs, lists and bold', () => {
    const html = text('You have **2 posts** due:\n- Monday tip\n- Friday sale\n\n1. Post them\n2. Mark them posted\n\n## Next\nThat’s all.');
    expect(html).toContain('<p>You have <strong class="font-semibold text-ink">2 posts</strong> due:</p>');
    expect(html).toContain('<ul class="flex flex-col gap-1 pl-5 list-disc"><li>Monday tip</li><li>Friday sale</li></ul>');
    expect(html).toContain('<ol class="flex flex-col gap-1 pl-5 list-decimal"><li>Post them</li><li>Mark them posted</li></ol>');
    expect(html).toContain('<p class="font-semibold text-ink">Next</p>');
  });

  it('links app pages in the app, and https pages in a new tab', () => {
    const html = text('Open the [calendar](#calendar), [AI settings](#workspace-settings/ai) or [Manus](https://manus.im).');
    expect(html).toContain('<a href="#calendar" class="link">calendar</a>');
    expect(html).toContain('<a href="#workspace-settings" class="link">AI settings</a>');
    expect(html).toMatch(/<a href="https:\/\/manus.im" target="_blank" rel="noopener noreferrer"[^>]*>Manus/);
    expect(appLink('#workspace-settings/ai')).toEqual({ route: 'workspace-settings', tab: 'ai' });
    expect(appLink('#marketing-social:create')).toEqual({ route: 'marketing-social', tab: 'create' });
    expect(appLink('#onboarding')).toBeNull();
    expect(appLink('#nowhere')).toBeNull();
  });

  it('keeps merge tags and snake_case names as they are; _a word_ is italic', () => {
    const html = text('Set the button link to {{lead_magnet_link}} (export_file ads_text), and *one* _last_ thing.');
    expect(html).toContain('{{lead_magnet_link}} (export_file ads_text)');
    expect(html).toContain('<em>one</em> <em>last</em> thing');
  });

  it('never renders HTML or script links from a reply', () => {
    const html = text('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [data](data:text/html,hi)');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('href="data');
    expect(html).toContain('click');
  });
});
