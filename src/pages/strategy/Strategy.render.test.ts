// The Strategy page rendered to HTML (no browser): the first visit, a saved strategy's labels and sources,
// no thumbs, safe links, what the header's Details holds (who writes it, the cost, the Brain switch, a
// stopped step's estimate), and the run button while it checks your AI server.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project, Skill } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { defaultSettings } from '@/store/defaults';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import { newSkill } from '@/ai/brain';
import { strategyWho } from '@/ai/strategyWho';
import { qaProject, qaSavedStrategy } from '@/test/strategyQa';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';

// the stores as the page reads them, set per test (a server render reads a store's first state, so they're stood in for)
const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown>, unsaved: {} as Record<string, unknown>, checking: {} as Record<string, string> }));
vi.mock('@/store/useStore', () => {
  const useStore = Object.assign((sel: (s: unknown) => unknown) => sel(fake.state), { getState: () => fake.state, setState: () => {} });
  const active = () => (fake.state.projects as Project[])[0];
  return { useStore, useActiveProject: active, getActiveProject: active };
});
vi.mock('@/ai/strategyJob', async (orig) => ({ ...(await orig<typeof import('@/ai/strategyJob')>()), useUnsavedCost: (pid: string) => fake.unsaved[pid] }));
vi.mock('./runs', async (orig) => ({ ...(await orig<typeof import('./runs')>()), useCheckingServer: (pid: string) => fake.checking[pid] ?? null }));

import { StarterChecklist, StrategyPage } from './Strategy';
import { ResearchTab } from './ResearchTab';
import { OutreachTab } from './OutreachTab';
import { RunDetails } from './RunPanel';
import { DetailsForm } from './DetailsDrawer';

const voice: Skill = { ...newSkill({ name: 'QA Bakery brand voice', scope: ['all'], instructions: 'Warm and plain.', projectId: 'p1' }), id: 'skill_voice' };

function use(project: Project, o: { useBrain?: boolean } = {}) {
  fake.state = { projects: [project], skills: [voice], posts: [], ads: [], myListings: [], settings: { ...defaultSettings(), ai: { ...defaultSettings().ai, useBrain: o.useBrain ?? true } } };
}
const html = (el: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
function render(project: Project, o: { useBrain?: boolean } = {}) {
  use(project, o);
  return html(createElement(StrategyPage, { project }));
}
/** What the header's Details holds, for this project and its strategy. */
function details(project: Project, s: StrategyState, o: { useBrain?: boolean } = {}) {
  use(project, o);
  return html(createElement(RunDetails, { project, s, who: strategyWho({ maxSearches: s.maxSearches }) }));
}
const emptyStrategy = (p: Project): StrategyState => ({ ...qaSavedStrategy(p), research: undefined, promote: undefined, content: undefined, assets: undefined, outreach: undefined, plan: undefined, run: undefined, sources: [] });

beforeEach(() => {
  useRuntime.getState().set({
    server: 'ok',
    ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { strategy: ['anthropic'] }, providers: [{ id: 'anthropic', label: 'Anthropic Claude', ready: true, models: { text: 'claude-opus-5-5' }, effort: { text: { id: 'medium', label: 'Medium' } }, research: { perSearch: 0.01 } }] },
  });
  fake.unsaved = {};
  fake.checking = {};
});

describe('the Strategy page', () => {
  it('first visit: one AI hero with your details as a line, Plan my strategy, and the free checklist folded under it', () => {
    const p = qaProject('p1');
    const page = render(p);
    expect(page).toContain('>Strategy</h1>');
    expect(page).toContain('Plan how QA Bakery gets customers');
    expect(page).toContain('Research, where to promote, and a 4-week plan. About two minutes.');
    expect(page).toContain('Austin');
    expect(page).toContain('for busy families nearby');
    expect(page).toContain('Edit details');
    // the button the QA and the seed click: inside the "Plan my strategy" region
    expect(page).toMatch(/<section aria-label="Plan my strategy">[\s\S]*<button type="button"[^>]*class="btn btn-ai btn-lg"[^>]*>[\s\S]*Plan my strategy<\/button>/);
    expect(page).toContain('Start without AI');
    expect(page).toContain('Who writes it and the cost');
    // no tabs before anything is written
    expect(page).not.toContain('role="tablist"');

    // who writes it and the cost, the Brain line: behind the header's Details
    const d = details(p, emptyStrategy(p));
    expect(d).toContain('Anthropic Claude writes your strategy with claude-opus-5-5 (effort Medium): 6 steps, 6 requests.');
    expect(d).toContain('Step 1 searches the web: up to 5 searches at $0.01 each (list price)');
    expect(d).toContain('Use my Brain skills here');
    expect(d).toContain('QA Bakery brand voice');
    expect(d).toContain('Web searches');

    // your details: in the drawer's form
    use(p);
    const form = html(createElement(DetailsForm, { project: p, d: { draft: emptyStrategy(p).inputs, set: () => {}, save: () => {} } }));
    expect(form).toContain('What do you want in the next 30 days?');
    expect(form).toContain('Who else sells this near you or online?');

    // the free starter checklist: built-in guidance, with each step's button
    use(p);
    const free = html(createElement(StarterChecklist, { project: p, s: emptyStrategy(p) }));
    expect(free).toContain('aria-label="Built-in guidance"');
    expect(free).toContain('Build this page');
  });

  it('a saved strategy: labels and sources, nothing invented, no thumbs, safe links', () => {
    const p = qaProject('p1');
    const project = { ...p, strategy: qaSavedStrategy(p) };
    const page = render(project);
    expect(page).toContain('role="tablist"');
    expect(page).toContain('How QA Bakery gets clients');
    expect(page).toContain('Your plan to win clients');
    // sources as superscript numbers that open the page; the AI's general knowledge behind an ⓘ
    expect(page).toMatch(/<sup[^>]*>[\s\S]*?<a href="https:\/\/example\.com\/qa-research\/where-buyers-look"[^>]*aria-label="Source 1: QA stand-in source 1 \(not a real page\), example\.com \(opens in a new tab\)"/);
    expect(page).toContain('aria-label="Based on general knowledge"');
    expect(page).toContain('Build this page first');
    expect(page).toContain('Booking page');
    expect(page).toContain('Guide my other tabs with this strategy');
    // the plan's regions keep their names (sections, not boxes, but still named)
    for (const name of ['The page to build first', 'This week', 'Your plan', 'All 4 weeks', 'Guide my other tabs with this strategy', 'Sources']) expect(page).toContain(`aria-label="${name}"`);
    // a step you tick yourself: the round check is still the "I did this" box, described by the step's title
    const tick = /<input type="checkbox"[^>]*aria-label="I did this" aria-describedby="([^"]+)"/.exec(page);
    expect(tick).not.toBeNull();
    expect(page).toContain(`id="${tick![1]}"`);
    expect(page).toContain('QA stand-in source 1 (not a real page)');
    expect(page).not.toContain('aria-label="Needs work"');
    expect(page).not.toMatch(/thumbs/i);
    for (const m of page.matchAll(/<a [^>]*href="https?:[^"]*"[^>]*>/g)) expect(m[0]).toContain('rel="noopener noreferrer nofollow"');

    const research = html(createElement(ResearchTab, { project, s: project.strategy }));
    expect(research).toContain('Searched the web on');
    expect(research).toContain('aria-label="Source 1: QA stand-in source 1 (not a real page), example.com (opens in a new tab)"');
    expect(research).toContain('aria-label="Source 2: QA stand-in source 2 (not a real page), example.org (opens in a new tab)"');
    expect(research).toMatch(/aria-label="(Based on general knowledge|About these sources)"/);
    expect(research).toContain('QA stand-in source 1 (not a real page)');
    expect(research).not.toContain('invented.example');
    expect(research).not.toContain('73%');
    expect(research).toContain('href="https://example.org/qa-research/content-that-works?utm_source=qa"');
    for (const m of research.matchAll(/<a [^>]*href="https?:[^"]*"[^>]*>/g)) expect(m[0]).toContain('rel="noopener noreferrer nofollow"');
  });

  it('outreach: the emails as written, with [link to your page] for the owner to fill in', () => {
    const p = qaProject('p1');
    const project = { ...p, strategy: qaSavedStrategy(p) };
    use(project);
    const out = html(createElement(OutreachTab, { project, s: project.strategy }));
    expect(out).toContain('[link to your page]');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('20%');
    expect(out).toContain('The app never sends email.');
  });

  it('with the Brain off for the whole app, the switch is disabled and says so', () => {
    const p = qaProject('p1');
    const d = details(p, emptyStrategy(p), { useBrain: false });
    expect(d).toMatch(/role="switch" aria-checked="true" disabled=""/);
    expect(d).toContain('The Brain is off for the whole app. Turn it on in the Brain.');
  });

  it('with no key for Strategy: the built-in engine, free, and where to set a key', () => {
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: {} } });
    const p = qaProject('p1');
    const d = details(p, emptyStrategy(p));
    expect(d).toContain('No API key powers Strategy yet, so the built-in engine writes a starter plan: free, general guidance, not research.');
    expect(d).toContain('Open Settings › AI keys');
  });

  it('the last run in Details: a web research step stopped unsaved shows what it may still cost', () => {
    const p = qaProject('p1');
    const saved = qaSavedStrategy(p);
    const s: StrategyState = { ...saved, run: { startedAt: 1_800_000_000_000, steps: ['research', 'promote', 'content', 'assets', 'outreach', 'plan'], done: [], stoppedAt: 'research' } };
    // another run's estimate isn't this one's
    fake.unsaved = { p1: { runAt: 1, step: 'research', usd: 0.05, estimate: true, searches: 5, perSearch: 0.01 } };
    expect(details(p, s)).not.toContain('estimated');
    fake.unsaved = { p1: { runAt: 1_800_000_000_000, step: 'research', usd: 0.05, estimate: true, searches: 5, perSearch: 0.01 } };
    const d = details(p, s);
    expect(d).toContain('Last run');
    expect(d).toContain('≈$0.050 or more, estimated');
    expect(d).toContain('Step 1 stopped before it was saved, but its web searches may already be billed: up to 5 at $0.01 each (list price), plus the pages it read.');
    // a finished run's cost, from its steps
    expect(details(p, saved)).toMatch(/Cost<\/dt><dd[^>]*>≈\$0\.\d+/);
  });

  it('while a run checks your AI server first, its button says so', () => {
    fake.checking = { p1: 'all' };
    const page = render(qaProject('p1'));
    expect(page).toMatch(/<button type="button" disabled="" aria-busy="true" class="btn btn-ai btn-lg is-running">[\s\S]*Checking your AI server…<\/button>/);
  });
});
