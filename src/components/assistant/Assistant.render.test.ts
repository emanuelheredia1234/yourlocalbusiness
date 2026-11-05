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

  it('is a round button at the bottom right (phones only), above the page and below windows, named “Open assistant”, with the AI mark and no badge', () => {
    const html = renderToStaticMarkup(createElement(Assistant));
    expect(html).toContain('aria-label="Open assistant"');
    expect(html).toContain('aria-controls="assistant-panel"');
    expect(html).toMatch(/class="fixed z-launcher[^"]*rounded-full[^"]*md:hidden/);
    expect(html).toContain('right:max(16px, env(safe-area-inset-right, 0px))');
    expect(html).toContain('bottom:max(16px, env(safe-area-inset-bottom, 0px))');
    // the Spark in the aura, and no "AI" badge that reads like a count
    expect(html).toContain('fill="url(#ylb-aura)"');
    expect(html).not.toMatch(/>AI<\/span>/);
  });

  it('shows that it’s working while a turn runs with the panel closed', () => {
    fake.chat = { ...fake.chat, running: true, runProjectId: 'p1' };
    expect(renderToStaticMarkup(createElement(Assistant))).toContain('title="The assistant is working"');
    fake.chat = { ...fake.chat, threads: { p1: [{ id: 'c1', role: 'card', text: 'x', at: 1, card: { title: 'x', what: 'y', who: 'z', confirmLabel: 'Go', state: 'pending' } }] } };
    expect(renderToStaticMarkup(createElement(Assistant))).toContain('title="The assistant is waiting for you to confirm"');
  });

  it('has a dot for a reply from Manus or Viktor that came while the chat was closed', () => {
    expect(renderToStaticMarkup(createElement(Assistant))).not.toContain('data-unread');
    fake.chat = { ...fake.chat, unread: { p1: 2 }, threads: { p1: [{ id: 'x', role: 'external', via: 'viktor', from: 'viktor', text: 'Hi', at: 1 }] } };
    const html = renderToStaticMarkup(createElement(Assistant));
    expect(html).toContain('aria-label="Open assistant: new reply from viktor"');
    expect(html).toContain('title="New reply from Viktor"');
    expect(html).toContain('data-unread=""');
    // another project's replies don't put a dot on this one
    fake.chat = { ...fake.chat, unread: { p2: 1 } };
    expect(renderToStaticMarkup(createElement(Assistant))).not.toContain('data-unread');
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
    // an app page opens in the app, with an arrow after its name
    expect(html).toMatch(/<a href="#calendar" class="link">calendar<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><\/a>/);
    expect(html).toMatch(/<a href="#workspace-settings" class="link">AI settings<svg/);
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

  it('with app links off (text from Manus or Viktor), an app link is plain text and only https links work', () => {
    const html = renderToStaticMarkup(createElement(ChatText, { text: 'Open [Settings](#workspace-settings/ai), [the page](https://example.com) or [x](javascript:alert(1))', appLinks: false }));
    expect(html).not.toContain('href="#');
    expect(html).toContain('Open Settings, ');
    expect(html).toMatch(/<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
    expect(html).not.toContain('javascript');
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
