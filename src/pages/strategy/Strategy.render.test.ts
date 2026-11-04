// The Strategy page rendered to HTML (no browser): the first visit, a saved strategy's labels and sources,
// no thumbs, safe links, and the Brain switch when the Brain is off for the whole app.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project, Skill } from '@/lib/types';
import { defaultSettings } from '@/store/defaults';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import { newSkill } from '@/ai/brain';
import { qaProject, qaSavedStrategy } from '@/test/strategyQa';

// the store as the page reads it, set per test (a server render reads a store's first state, so it's stood in for)
const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/store/useStore', () => {
  const useStore = Object.assign((sel: (s: unknown) => unknown) => sel(fake.state), { getState: () => fake.state, setState: () => {} });
  const active = () => (fake.state.projects as Project[])[0];
  return { useStore, useActiveProject: active, getActiveProject: active };
});

import { StrategyPage } from './Strategy';
import { ResearchTab } from './ResearchTab';
import { OutreachTab } from './OutreachTab';

const voice: Skill = { ...newSkill({ name: 'QA Bakery brand voice', scope: ['all'], instructions: 'Warm and plain.', projectId: 'p1' }), id: 'skill_voice' };

function render(project: Project, o: { useBrain?: boolean } = {}) {
  fake.state = { projects: [project], skills: [voice], posts: [], ads: [], myListings: [], settings: { ...defaultSettings(), ai: { ...defaultSettings().ai, useBrain: o.useBrain ?? true } } };
  return renderToStaticMarkup(createElement(StrategyPage, { project }));
}

beforeEach(() => {
  useRuntime.getState().set({
    server: 'ok',
    ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { strategy: ['anthropic'] }, providers: [{ id: 'anthropic', label: 'Anthropic Claude', ready: true, models: { text: 'claude-opus-5-5' }, effort: { text: { id: 'medium', label: 'Medium' } }, research: { perSearch: 0.01 } }] },
  });
});

describe('the Strategy page', () => {
  it('first visit: your details, who does it and the cost, the Brain line, and the free starter checklist', () => {
    const html = render(qaProject('p1'));
    expect(html).toContain('How QA Bakery gets clients');
    expect(html).toContain('What do you want in the next 30 days?');
    expect(html).toContain('Who else sells this near you or online?');
    expect(html).toContain('Anthropic Claude writes your strategy with claude-opus-5-5 (effort Medium): 6 steps, 6 requests.');
    expect(html).toContain('Step 1 searches the web: up to 5 searches at $0.01 each (list price)');
    expect(html).toContain('Use my Brain skills here');
    expect(html).toContain('QA Bakery brand voice');
    expect(html).toContain('Free starter checklist');
    expect(html).toContain('Built-in guidance, not research');
    expect(html).toContain('Built-in guidance');
    expect(html).toContain('Build this page');
    expect(html).toContain('Plan my strategy');
    // no tabs before anything is written
    expect(html).not.toContain('role="tablist"');
  });

  it('a saved strategy: labels and sources, nothing invented, no thumbs, safe links', () => {
    const p = qaProject('p1');
    const project = { ...p, strategy: qaSavedStrategy(p) };
    const html = render(project);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('Your plan to win clients');
    expect(html).toContain('From the web');
    expect(html).toContain('[1] example.com');
    expect(html).toContain('AI’s general knowledge');
    expect(html).toContain('Build this page first: Booking page');
    expect(html).toContain('Guide my other tabs with this strategy');
    expect(html).not.toContain('aria-label="Needs work"');
    expect(html).not.toMatch(/thumbs/i);
    for (const m of html.matchAll(/<a [^>]*href="https?:[^"]*"[^>]*>/g)) expect(m[0]).toContain('rel="noopener noreferrer nofollow"');

    const research = renderToStaticMarkup(createElement(ResearchTab, { project, s: project.strategy }));
    expect(research).toContain('Searched the web on');
    expect(research).toContain('From the web');
    expect(research).toContain('[1] example.com');
    expect(research).toContain('[2] example.org');
    expect(research).toContain('AI’s general knowledge');
    expect(research).toContain('QA stand-in source 1 (not a real page)');
    expect(research).not.toContain('invented.example');
    expect(research).not.toContain('73%');
    expect(research).toContain('href="https://example.org/qa-research/content-that-works?utm_source=qa"');
    for (const m of research.matchAll(/<a [^>]*href="https?:[^"]*"[^>]*>/g)) expect(m[0]).toContain('rel="noopener noreferrer nofollow"');
  });

  it('outreach: the emails as written, with [link to your page] for the owner to fill in', () => {
    const p = qaProject('p1');
    const project = { ...p, strategy: qaSavedStrategy(p) };
    const html = renderToStaticMarkup(createElement(OutreachTab, { project, s: project.strategy }));
    expect(html).toContain('[link to your page]');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('20%');
    expect(html).toContain('The app never sends email.');
  });

  it('with the Brain off for the whole app, the switch is disabled and says so', () => {
    const html = render(qaProject('p1'), { useBrain: false });
    expect(html).toMatch(/role="switch" aria-checked="true" disabled=""/);
    expect(html).toContain('The Brain is off for the whole app. Turn it on in the Brain.');
  });

  it('with no key for Strategy: the built-in engine, free, and where to set a key', () => {
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: {} } });
    const html = render(qaProject('p1'));
    expect(html).toContain('No API key powers Strategy yet, so the built-in engine writes a starter plan: free, general guidance, not research.');
    expect(html).toContain('Open Settings → AI');
  });
});
