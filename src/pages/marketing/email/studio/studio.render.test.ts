// @vitest-environment happy-dom
// The email studio (P5 §A9): adding, moving and removing blocks, an inspector edit reaching the preview iframe,
// the link picker's disabled choices with what fixes them, the custom block's sanitizer notes, and the claude.ai
// build without uploads or AI pictures. Nothing leaves the test: fetch is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';

const { newProject } = await import('@/store/defaults');
const { useStore } = await import('@/store/useStore');
const { generateEmailSequence } = await import('@/ai/local/email');
const { EmailStudio } = await import('./EmailStudio');
const { linkChoices } = await import('./LinkPicker');
const { cleanCustom } = await import('./inspectors/LayoutInspectors');
const { BlockInspector } = await import('./inspectors');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const p = newProject('business');
  p.brand.name = 'Copper & Comb';
  p.marketing.emails = generateEmailSequence(p, null);
  useStore.setState({ projects: [p], activeProjectId: p.id });
  return p;
}
const project = (id: string) => useStore.getState().projects.find((x) => x.id === id)!;

function Live({ id }: { id: string }) {
  const p = useStore((s) => s.projects.find((x) => x.id === id)!);
  return createElement(EmailStudio, { project: p, step: p.marketing.emails[0], index: 0, total: 5 });
}
async function render(id: string) {
  await act(async () => root.render(createElement(TooltipProvider, null, createElement(Live, { id }))));
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
const rows = () => [...host.querySelectorAll('[data-testid="block-list"] > li')].map((li) => li.textContent ?? '');
const settle = () => act(async () => void vi.advanceTimersByTime(200));

describe('the block list', () => {
  it('starts from the plain words without writing, and the first edit writes the doc', async () => {
    const p = setup();
    await render(p.id);
    expect(rows()).toHaveLength(2);
    expect(project(p.id).marketing.emails[0].doc).toBeUndefined();
    await act(async () => button('Move Button up')!.click());
    const doc = project(p.id).marketing.emails[0].doc!;
    expect(doc.blocks.map((b) => b.type)).toEqual(['button', 'text']);
  });

  it('duplicates and deletes blocks', async () => {
    const p = setup();
    await render(p.id);
    await act(async () => button('Duplicate Text')!.click());
    expect(project(p.id).marketing.emails[0].doc!.blocks.map((b) => b.type)).toEqual(['text', 'text', 'button']);
    await act(async () => button('Delete Button')!.click());
    expect(project(p.id).marketing.emails[0].doc!.blocks.map((b) => b.type)).toEqual(['text', 'text']);
  });

  it('an inspector edit reaches the preview iframe', async () => {
    const p = setup();
    await render(p.id);
    // the button row
    await act(async () => (host.querySelectorAll('[data-testid="block-list"] > li button[aria-pressed]')[1] as HTMLButtonElement).click());
    const input = host.querySelector('[data-testid="inspector"] input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'Grab the guide now');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const frame = host.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
    expect(frame.getAttribute('srcdoc')).toContain('Grab the guide now');
    expect(frame.getAttribute('srcdoc')).not.toContain('<script');
  });
});

describe('the link picker', () => {
  it('disables what can’t work yet, saying what fixes it', () => {
    const p = setup();
    const c = linkChoices(p, false);
    expect(c.find((x) => x.kind === 'magnet')?.disabled).toContain('Publish your download');
    expect(c.find((x) => x.kind === 'page')?.disabled).toContain('Add your website');
    expect(c.find((x) => x.kind === 'asset')?.disabled).toBe('Publish one in Studio › Code & assets first');
    expect(c.some((x) => x.kind === 'offer')).toBe(false);
    expect(c.find((x) => x.kind === 'url')?.disabled).toBe('');
    p.brand.websiteUrl = 'https://copperandcomb.com';
    expect(linkChoices(p, true).find((x) => x.kind === 'page')?.disabled).toBe('');
    expect(linkChoices(p, true).some((x) => x.kind === 'offer')).toBe(true);
  });
});

describe('custom HTML', () => {
  it('is cleaned for email, and what was removed shows under the editor', async () => {
    const r = cleanCustom('<p onclick="x()">Hi</p><script>alert(1)</script><img src="https://track.example/p.gif" alt="">', '');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toBe('<p>Hi</p>');
    expect(r.notes.join(' ')).toMatch(/script/i);
    const p = setup();
    await act(async () =>
      root.render(createElement(BlockInspector, { project: p, block: { id: 'b_aaaaaaaaaa', type: 'custom', html: r.html, source: 'owner', notes: r.notes }, onChange: () => {} })),
    );
    expect(host.querySelector('[data-testid="custom-notes"]')?.textContent).toMatch(/script/i);
  });
});

describe('in the claude.ai build', () => {
  it('offers an image address instead of uploads and AI pictures', async () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const p = setup();
    await act(async () => root.render(createElement(BlockInspector, { project: p, block: { id: 'b_bbbbbbbbbb', type: 'image', src: '', alt: '', width: 'full', origin: 'url' }, onChange: () => {} })));
    expect(host.textContent).toContain('Image address');
    expect(host.textContent).not.toContain('Upload');
    expect(host.textContent).not.toContain('Generate with AI');
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });

  it('shows uploads and AI pictures in the app', async () => {
    const p = setup();
    await act(async () => root.render(createElement(BlockInspector, { project: p, block: { id: 'b_bbbbbbbbbb', type: 'image', src: '', alt: '', width: 'full', origin: 'url' }, onChange: () => {} })));
    expect(host.querySelector('input[type="file"]')).not.toBeNull();
    expect(host.textContent).toContain('Generate with AI');
  });
});
