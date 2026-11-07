// What the build window and the build cards show (rendered once, as on the server: no effects run). The window: who
// builds it, the kind, the website, the owner's words with their counter, images, the facts that go, the agent's
// options; disabled with the reason when the agent isn't set up; then the confirm with who does it, what it costs
// and the exact message. The cards: what each state says and offers. The Modal and the stores are stood in for.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentBuild, AgentsHealth } from '@/lib/agentTypes';
import type { MediaRef, Project, PromptImage } from '@/lib/types';

const fake = vi.hoisted(() => ({ store: {} as Record<string, unknown>, runtime: {} as Record<string, unknown> }));
vi.mock('@/store/useStore', async (orig) => {
  const real = await orig<typeof import('@/store/useStore')>();
  const useStore = Object.assign((sel: (s: unknown) => unknown) => sel(fake.store), { getState: () => fake.store, setState: () => {}, subscribe: () => () => {} });
  const active = () => (fake.store.projects as Project[])[0] ?? null;
  return { ...real, useStore, useActiveProject: active, getActiveProject: active };
});
vi.mock('@/lib/platform', async (orig) => {
  const real = await orig<typeof import('@/lib/platform')>();
  const state = () => ({ ...real.useRuntime.getState(), ...fake.runtime });
  return { ...real, useRuntime: Object.assign((sel: (s: unknown) => unknown) => sel(state()), { getState: state, setState: () => {}, subscribe: () => () => {} }) };
});
vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, subtitle, children, footer }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), createElement('p', null, subtitle), children, createElement('footer', null, footer)),
}));
// the text boxes size themselves in a layout effect, which a server render skips (and React says so)
const consoleError = console.error;
vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
  if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) consoleError(...args);
});

const { defaultSettings, newProject } = await import('@/store/defaults');
// rows have a ⋯ menu with a tooltip: the app mounts the tooltip provider in main.tsx
const { TooltipProvider } = await import('@/components/ui/shadcn/tooltip');
const { BuildForm, BuildConfirm, checkWebsite, confirmWhat } = await import('./AgentBuildWindow');
const { BuildCard } = await import('./AgentBuildList');
const { AgentButtons } = await import('./AgentButtons');

const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, thumb: 'data:image/jpeg;base64,AAAA' });
const img = (n: number, note?: string): PromptImage => ({ key: `img-${n}`, media: media(`m${n}`), ...(note ? { note } : {}) });
const ready = { ready: true, reason: 'ok' };
const health = (patch: Partial<AgentsHealth> = {}): AgentsHealth => ({ manus: { build: ready, chat: ready, own: false, profile: 'standard' }, viktor: { ...ready, where: 'dm', place: '' }, ...patch });

let project: Project;
beforeEach(() => {
  project = { ...newProject('business', 'new'), id: 'p1', onboarded: true, location: { city: 'Austin', region: 'TX' } };
  project.brand = { ...project.brand, name: 'Calm Studio', websiteUrl: 'https://calm.example' };
  project.businessType = 'Yoga studio';
  project.studio.listing = { ...project.studio.listing, contactEmail: 'hello@calm.example' };
  fake.store = { projects: [project], activeProjectId: 'p1', settings: defaultSettings() };
  fake.runtime = { server: 'ok', ai: { reachable: true, ready: true, providers: [], routing: {}, agents: health() } };
});

const fields = (patch = {}) => ({ via: 'viktor' as const, kind: 'booking', website: 'https://calm.example', request: 'A booking widget for my yoga classes', images: [img(1, 'our studio'), img(2)], unticked: [], profile: '', ...patch });
const form = (f = fields(), target: 'asset' | 'seo' = 'asset') => renderToStaticMarkup(createElement(BuildForm, { project, target, f, onNext: () => {} }));
const confirm = (f = fields(), target: 'asset' | 'seo' = 'asset') => renderToStaticMarkup(createElement(BuildConfirm, { project, target, f, onBack: () => {} }));
const nextButton = (html: string) => html.match(/<button[^>]*>Next<\/button>/)?.[0] ?? '';

describe('the build window, step 1', () => {
  it('asks who builds it, what, the website, the owner’s words (with a counter), images and the facts that go', () => {
    const html = form();
    expect(html).toContain('Build an asset with Manus or Viktor');
    expect(html).toContain('<legend class="label">Who builds it</legend>');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>.*Viktor/);
    expect(html).toMatch(/<option value="booking" selected="">Booking widget<\/option>/);
    expect(html).toContain('value="https://calm.example"');
    expect(html).toContain('Viktor opens it only to see your colors, fonts and style. They don’t sign in or change anything there.');
    expect(html).toContain('What to build and the features you want');
    expect(html).toContain('36 / 1,500');
    expect(html).toContain('value="our studio"');
    expect(html).toContain('Your images go to Slack with your request. The page shows each one as {{img-N}}; add a note to say where it goes.');
    expect(html).toContain('<legend class="label">Facts Viktor may use</legend>');
    // each fact is a checkbox, its value under its name
    expect(html).toMatch(/role="checkbox" aria-checked="true"[\s\S]*?Business name<\/span><span[^>]*><span[^>]*>Calm Studio<\/span>/);
    expect(html).toContain('Only these facts go: the page must not add reviews, prices or numbers of its own.');
    expect(html).toContain('In your DM with Viktor.');
    expect(nextButton(html)).not.toContain('disabled');
  });

  it('Manus: the counter is 4,000 and the agent can be chosen (the Settings default first)', () => {
    const html = form(fields({ via: 'manus' }));
    expect(html).toContain('36 / 4,000');
    expect(html).toContain('<option value="" selected="">Standard (your Settings default)</option>');
    expect(html).toContain('<option value="max-high">Max · high</option>');
    expect(html).toContain('Your images go to Manus with your request.');
  });

  it('an agent that isn’t set up is disabled and says why, with Settings', () => {
    fake.runtime = { server: 'ok', ai: { reachable: true, ready: true, providers: [], routing: {}, agents: health({ manus: { build: { ready: false, reason: 'no_key' }, chat: { ready: false, reason: 'no_key' }, own: false, profile: '' } }) } };
    const html = form(fields({ via: 'manus' }));
    expect(html).toContain('Add a Manus API key in Settings › AI keys.');
    expect(html).toContain('Open Settings › AI keys');
    expect(nextButton(html)).toContain('disabled');
  });

  it('a website that isn’t a public https address, or words over the cap, stop it', () => {
    expect(nextButton(form(fields({ website: 'http://localhost:3000' })))).toContain('disabled');
    expect(form(fields({ request: 'x'.repeat(1501) }))).toContain('Your words are too long for Viktor: at most 1,500 characters.');
    expect(checkWebsite('calm.example')).toEqual({ url: 'https://calm.example', error: '' });
    for (const bad of ['http://calm.example', 'https://127.0.0.1', 'https://printer.local', 'https://me:pw@calm.example', 'https://calm.example/<x>']) expect(checkWebsite(bad).error).toBe('Use your website’s https address, like https://example.com');
    expect(checkWebsite('')).toEqual({ url: '', error: '' });
  });

  it('the SEO page: the page types, and a checkout page waits for the owner’s payment link', () => {
    const html = form(fields({ kind: 'checkout' }), 'seo');
    expect(html).toContain('Build your SEO page with Manus or Viktor');
    expect(html).toContain('<legend class="label">What kind of page?</legend>');
    expect(html).toContain('Add your payment link first. The app never takes payments: Buy now opens your own link.');
    expect(nextButton(html)).toContain('disabled');
  });
});

describe('the build window, step 2', () => {
  it('says what goes, who does the work and what it costs, offers the exact message, then Send', () => {
    const html = confirm();
    expect(html).toContain('Send this to Viktor?');
    expect(html).toContain('Build a booking widget from your words, 2 images, 4 facts and your website.');
    expect(html).toContain('Viktor, the AI employee from viktor.com in your Slack workspace, builds it. The app posts your request as you in your DM with Viktor and reads Viktor’s replies in that thread.');
    expect(html).toContain('Viktor’s work counts toward your viktor.com plan. This app can’t see how much it uses.');
    expect(html).toContain('Show the exact message');
    expect(html).toMatch(/<button[^>]*>.*Send to Viktor<\/button>/);
  });

  it('Manus: its own who and cost', () => {
    const html = confirm(fields({ via: 'manus' }));
    expect(html).toContain('Manus, an AI agent with its own computer and browser, builds it in your Manus account. It usually takes a few minutes.');
    expect(html).toContain('Uses your Manus credits. How many depends on the work (a Max profile uses more); you’ll see what it used when it’s done.');
  });

  it('what it builds, in words', () => {
    expect(confirmWhat('seo', 'booking', { words: true, images: 0, facts: 3, website: false })).toBe('Build a booking page from your words and 3 facts.');
    expect(confirmWhat('asset', 'faq', { words: false, images: 1, facts: 1, website: true })).toBe('Build a faq accordion from 1 image, 1 fact and your website.');
  });
});

const build = (patch: Partial<AgentBuild> = {}): AgentBuild => ({
  id: 'b1',
  via: 'viktor',
  target: 'asset',
  kind: 'booking',
  request: 'A booking widget',
  website: '',
  images: [],
  state: 'working',
  requestedAt: Date.now() - 60_000,
  lastSentAt: Date.now() - 60_000,
  ref: 'ylb-AAAAAA',
  rounds: 1,
  threadId: 'vk_aaaaaaaaaaaaaaaaaaaaaa',
  permalink: 'https://slack.example/p1',
  ...patch,
});
const card = (b: AgentBuild) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BuildCard, { projectId: 'p1', build: b })));

describe('the build cards', () => {
  it('sending', () => {
    expect(card(build({ state: 'sending' }))).toContain('Sending to Viktor…');
  });

  it('may have been delivered: Check now, Open, and for Manus “I checked: it didn’t start”', () => {
    const html = card(build({ state: 'unknown_start', message: 'May have been delivered. Checking Slack…' }));
    expect(html).toContain('May have been delivered. Checking Slack…');
    expect(html).toContain('Check now');
    expect(html).toContain('href="https://slack.example/p1"');
    expect(card(build({ state: 'unknown_start', via: 'manus', taskUrl: 'https://manus.im/app/t1' }))).toContain('I checked: it didn’t start');
  });

  it('working: Open, Check now, and Stop (Manus) or Stop waiting (Viktor)', () => {
    expect(card(build())).toMatch(/Viktor is working[\s\S]*Open in Slack[\s\S]*Check now[\s\S]*Stop waiting/);
    expect(card(build({ via: 'manus', taskId: 't1', taskUrl: 'https://manus.im/app/t1', threadId: undefined }))).toMatch(/Manus is working[\s\S]*Open in Manus[\s\S]*>Stop</);
  });

  it('needs you: the reason and the agent’s words as plain text, Answer and Ask for the page as one file', () => {
    const html = card(build({ state: 'needs_you', message: 'Viktor replied without the page.', said: 'Which colors? <a href="#workspace-settings">click</a>' }));
    expect(html).toContain('Viktor replied without the page.');
    // untrusted: shown as text, never as HTML or app links
    expect(html).toContain('Which colors? &lt;a href=&quot;#workspace-settings&quot;&gt;click&lt;/a&gt;');
    expect(html).toContain('>Answer<');
    expect(html).toContain('Ask for the page as one file');
  });

  it('built: Preview, Use this, Ask for changes, Dismiss (and the credits Manus used)', () => {
    const html = card(build({ state: 'built', result: { at: '1.1', filename: 'page.html', bytes: 900, source: 'code' } }));
    for (const s of ['Viktor built your booking widget', 'Preview', 'Use this', 'Ask for changes', 'Dismiss']) expect(html).toContain(s);
    expect(card(build({ state: 'built', via: 'manus', taskId: 't1', threadId: undefined, credits: 41, result: { at: 'e1:0', filename: 'page.html', bytes: 900, source: 'file' } }))).toContain('used 41 Manus credits');
    expect(card(build({ state: 'built', target: 'seo', kind: 'booking', result: { at: '1.1', filename: 'page.html', bytes: 900, source: 'code' } }))).toContain('Use as my SEO page');
  });

  it('used: what it became, Ask for changes, Dismiss', () => {
    expect(card(build({ state: 'imported', target: 'seo', imported: { at: 1, result: '1.1', seo: true } }))).toMatch(/Used as your SEO page[\s\S]*Ask for changes[\s\S]*Dismiss/);
  });

  it('failed: the reason, Open, Try again, Dismiss', () => {
    expect(card(build({ state: 'failed', message: 'This request was deleted in Slack.' }))).toMatch(/This request was deleted in Slack\.[\s\S]*Open in Slack[\s\S]*Try again[\s\S]*Dismiss/);
  });

  it('stopped: Check again, Dismiss', () => {
    expect(card(build({ state: 'stopped' }))).toMatch(/Stopped[\s\S]*Check again[\s\S]*Dismiss/);
  });
});

describe('the buttons', () => {
  it('Build with Manus and Build with Viktor; one that isn’t set up is disabled, says why, and offers Set up', () => {
    fake.runtime = { server: 'ok', ai: { reachable: true, ready: true, providers: [], routing: {}, agents: health({ viktor: { ready: false, reason: 'no_token', where: '', place: '' } }) } };
    const html = renderToStaticMarkup(createElement(AgentButtons, { target: 'asset' }));
    expect(html).toMatch(/<button[^>]*class="btn btn-secondary btn-sm"[^>]*>.*Build with Manus<\/button>/);
    expect(html).toMatch(/title="Connect Slack in Settings › AI keys › Viktor \(Slack\)\."[^>]*><button[^>]*disabled=""/);
    expect(html).toContain('Set up');
  });

  it('Viktor is hidden for anyone but the owner; Rebuild… on a page that exists', () => {
    fake.runtime = { server: 'ok', ai: { reachable: true, ready: true, providers: [], routing: {}, agents: health({ viktor: { ready: false, reason: 'owner_only', where: '', place: '' } }) } };
    const html = renderToStaticMarkup(createElement(AgentButtons, { target: 'seo', rebuild: true }));
    expect(html).toContain('Rebuild with Manus');
    expect(html).not.toContain('Viktor');
  });

  it('none in the claude.ai build', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    try {
      expect(renderToStaticMarkup(createElement(AgentButtons, { target: 'asset' }))).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('emails and lead magnets (P5)', () => {
  it('the window has its own title, kinds and words for each', () => {
    const email = renderToStaticMarkup(createElement(BuildForm, { project, target: 'email', f: fields({ kind: 'welcome', request: 'Design this email.' }), onNext: () => {} }));
    expect(email).toContain('Design an email with Manus or Viktor');
    expect(email).toContain('Welcome email');
    expect(email).toContain('Offer email');
    const magnet = renderToStaticMarkup(createElement(BuildForm, { project, target: 'leadMagnet', f: fields({ kind: 'checklist', request: '' }), onNext: () => {} }));
    expect(magnet).toContain('Make your lead magnet with Manus or Viktor');
    expect(magnet).toContain('7-day workbook');
    expect(confirmWhat('email', 'offer', { words: true, images: 0, facts: 2, website: false })).toBe('Build an offer email from your words and 2 facts.');
  });

  it('the per-email buttons show their lead words (clicking them: AgentButtons.dom.test.ts)', async () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AgentButtons, { target: 'email', stepId: 'em_1', kind: 'welcome', lead: 'or design it with' })));
    expect(html).toContain('or design it with');
    expect(html).toContain('Manus');
  });

  it('a lead magnet build takes no images (its PDF is the app’s design); an email build does', () => {
    const email = renderToStaticMarkup(createElement(BuildForm, { project, target: 'email', f: fields({ kind: 'welcome', request: 'Design this email.' }), onNext: () => {} }));
    expect(email).toContain('Your images go to');
    const magnet = renderToStaticMarkup(createElement(BuildForm, { project, target: 'leadMagnet', f: fields({ kind: 'checklist', request: 'A checklist', images: [] }), onNext: () => {} }));
    expect(magnet).not.toContain('Your images go to');
    expect(magnet).not.toContain('Paste or drop images');
  });

  it('prefills an email build with the email’s words, cut at a paragraph to fit', async () => {
    const { emailRequestOf } = await import('./buildWindow');
    expect(emailRequestOf('Hi', 'One.\n\nTwo.', 4000)).toBe('Design this email. Subject: Hi\n\nThe email’s words:\nOne.\n\nTwo.');
    const long = emailRequestOf('Hi', `${'a'.repeat(900)}\n\n${'b'.repeat(900)}`, 1500);
    expect(long.length).toBeLessThanOrEqual(1500);
    expect(long).toContain('a'.repeat(900));
    expect(long).not.toContain('b'.repeat(900));
    expect(long).toContain('(The rest of the email is left out: keep it short.)');
  });
});
