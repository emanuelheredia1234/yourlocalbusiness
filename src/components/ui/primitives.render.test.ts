// The design system's primitives and AI moments as they first render (on the server: no effects run).
// The hand-made controls keep the exact ARIA markup page tests rely on; the new primitives render their
// structure; the AI layer shows the aura only through its own components.
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge, Callout, Empty, OptionCards, PageHeader, ProgressBar, Section, Segmented, StatStrip, StatusDot, Stepper, Tabs, Toggle } from './primitives';
import { AIThinking, AiCard, GenerateButton } from '../ai/AI';
import { Spark } from '../ai/Spark';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('hand-made controls keep their markup', () => {
  it('Tabs: buttons with role="tab" and aria-selected, a plain mono count, no icons', () => {
    const out = html(h(Tabs, { tabs: [{ id: 'a', label: 'Plan', icon: h('svg', { 'data-icon': '' }) }, { id: 'b', label: 'Research', count: 4 }], value: 'a', onChange: () => {} }));
    expect(out).toContain('role="tablist"');
    expect(out).toMatch(/<button role="tab" aria-selected="true"[^>]*>Plan<\/button>/);
    expect(out).toMatch(/<button role="tab" aria-selected="false"[^>]*>Research<span class="num font-mono text-caption text-muted">4<\/span><\/button>/);
    expect(out).not.toContain('data-icon');
  });

  it('Segmented: a radiogroup of role="radio" buttons with the label right inside', () => {
    const out = html(h(Segmented, { options: [{ id: 'x', label: '7 days' }, { id: 'y', label: '30 days' }], value: 'y', onChange: () => {} }));
    expect(out).toContain('role="radiogroup"');
    expect(out).toMatch(/role="radio" aria-checked="true"[^>]*>30 days<\/button>/);
  });

  it('Toggle: a switch whose tag says "disabled" only when it is', () => {
    expect(html(h(Toggle, { checked: false, onChange: () => {}, label: 'Brain on' }))).toMatch(/role="switch" aria-checked="false"(?![^>]*disabled)/);
    expect(html(h(Toggle, { checked: true, onChange: () => {}, disabled: true }))).toMatch(/role="switch" aria-checked="true" disabled=""/);
  });
});

describe('page structure', () => {
  it('PageHeader: one h1, a one-line description, and the actions', () => {
    const out = html(h(PageHeader, { title: 'Content calendar', description: '10 planned · 2 posted', actions: h('button', { className: 'btn btn-primary' }, 'Create post') }));
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('>Content calendar</h1>');
    expect(out).toMatch(/<p class="[^"]*truncate[^"]*" title="10 planned · 2 posted">10 planned · 2 posted<\/p>/);
    expect(out).toContain('Create post');
  });

  it('PageHeader: actions span the meta row only when there is meta (no empty grid row under the title)', () => {
    const bare = html(h(PageHeader, { title: 'Brain', actions: h('button', { className: 'btn btn-primary' }, 'New skill') }));
    expect(bare).not.toContain('md:row-span-2');
    const withMeta = html(h(PageHeader, { title: 'Strategy', meta: 'Updated today', actions: h('button', { className: 'btn btn-primary' }, 'Run') }));
    expect(withMeta).toMatch(/class="[^"]*ml-auto md:row-span-2[^"]*"><button/);
  });

  it('PageHeader: a caller’s margin replaces the default (classes merge)', () => {
    const out = html(h(PageHeader, { title: 'Strategy', className: 'mb-4' }));
    expect(out).toContain('<header class="mb-4">');
  });

  it('Section, StatStrip, StatusDot, Badge, Callout, ProgressBar and Stepper render their parts', () => {
    expect(html(h(Section, { title: 'Up next', children: 'rows' }))).toMatch(/<section class="mt-10 first:mt-0"><div[^>]*><div[^>]*><h2 class="text-h2 text-ink">Up next<\/h2>/);
    const strip = html(h(StatStrip, { items: [{ label: 'Planned', value: 10, sub: 'Next: Thu' }, { label: 'Posted', value: 2, delta: null }] }));
    expect(strip).toContain('>10<');
    expect(strip).not.toContain('↑');
    expect(html(h(StatStrip, { items: [{ label: 'Posted', value: 3, delta: 2 }] }))).toContain('↑ 2');
    expect(html(h(StatusDot, { tone: 'good', children: 'Live' }))).toContain('bg-good-solid');
    expect(html(h(Badge, { tone: 'warn', children: 'Waiting for DNS' }))).toContain('bg-warn-soft text-warn');
    expect(html(h(Badge, { tone: 'ai', children: 'AI draft' }))).toContain('url(#ylb-aura)');
    expect(html(h(Callout, { tone: 'bad', children: 'Didn’t post' }))).toContain('role="alert"');
    expect(html(h(ProgressBar, { value: 3, max: 5, label: '3 of 5' }))).toMatch(/role="progressbar" aria-valuemin="0" aria-valuemax="5" aria-valuenow="3"/);
    const steps = html(h(Stepper, { steps: [{ title: 'Create the app', summary: 'Done in Slack', state: 'done' }, { title: 'Add the token', state: 'current', content: 'form' }, { title: 'Pick a channel', state: 'upcoming', content: 'not-yet-shown' }] }));
    expect(steps).toContain('Done in Slack');
    expect(steps).toContain('aria-current="step"');
    expect(steps).toContain('form');
    expect(steps).not.toContain('not-yet-shown');
  });

  it('Empty: no dashed border; the AI variant uses the aura tile and a Spark', () => {
    const section = html(h(Empty, { title: 'No leads yet', body: 'They show up here.' }));
    expect(section).not.toContain('dashed');
    const ai = html(h(Empty, { variant: 'ai', title: 'Plan how Hearth Bakehouse gets customers', summary: 'Bakery · Denver' }));
    expect(ai).toContain('aura-edge');
    expect(ai).toContain('url(#ylb-aura)');
    expect(ai).toContain('Bakery · Denver');
  });

  it('OptionCards: a labelled radio group', () => {
    const out = html(h(OptionCards, { 'aria-label': 'Asset type', value: 'a', onChange: () => {}, options: [{ value: 'a', title: 'Landing hero' }, { value: 'b', title: 'Price table' }] }));
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain('aria-label="Asset type"');
    expect(out).toMatch(/role="radio" aria-checked="true"/);
  });
});

describe('AI moments', () => {
  it('GenerateButton: the outline AI style by default, the ink + aura style only when asked', () => {
    expect(html(h(GenerateButton, { onClick: () => {}, children: 'Rewrite page' }))).toMatch(/class="btn btn-ai-outline"/);
    expect(html(h(GenerateButton, { onClick: () => {}, variant: 'ai', children: 'Plan my strategy' }))).toMatch(/class="btn btn-ai"/);
    expect(html(h(GenerateButton, { onClick: () => {}, variant: 'ai-ghost', size: 'sm', children: 'Write it' }))).toMatch(/class="btn btn-ghost btn-sm"/);
  });

  it('GenerateButton running: keeps going with the orb and a task verb, busy and not pressable', () => {
    const out = html(h(GenerateButton, { onClick: () => {}, running: true, runningLabel: 'Writing…', children: 'Write page' }));
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('is-running');
    expect(out).toContain('class="orb"');
    expect(out).toContain('Writing…');
    expect(out).not.toContain('Write page');
  });

  it('AIThinking: a strip whose stage text is the status, the step and a timer kept out of it, and Stop', () => {
    const out = html(h(AIThinking, { running: true, stage: 'Researching where your customers are…', step: 'Step 2 of 6', onStop: () => {} }));
    expect(out).toMatch(/<div class="thinking"><span class="orb"/);
    expect(out).toMatch(/<p class="[^"]*" role="status" aria-live="polite">Researching where your customers are…<\/p>/);
    expect(out).toMatch(/aria-hidden="true"><span class="max-sm:hidden">Step 2 of 6 · <\/span>0:00<\/span>/);
    expect(out).toContain('Stop');
    expect(html(h(AIThinking, { running: false, stage: 'x' }))).toBe('');
  });

  it('AiCard and Spark', () => {
    expect(html(h(AiCard, { children: 'plan' }))).toBe('<div class="ai-card p-4 sm:p-5">plan</div>');
    expect(html(h(Spark, { size: 18 }))).toMatch(/<svg width="18" height="18"[^>]*aria-hidden="true"/);
    expect(html(h(Spark, { mono: true }))).toContain('fill="currentColor"');
  });
});
