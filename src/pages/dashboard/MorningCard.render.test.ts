// Today's action card, drawn with fixed data in every state: loading, being made, ready (AI pick, from your plan,
// built in), Not useful, done, dismissed, failed with and without attempts, before 5 am, plan paused, error. Never a
// filled button inside it (the page's one filled button is on the next post), and AI trouble only in our words.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { MorningAction, MorningToday } from '@/lib/integrations/types';
import { newProject } from '@/store/defaults';
import { MorningCardView, fallbackLine, zoneNote, type MorningViewProps } from './MorningCard';

const project = { ...newProject('business', 'existing'), id: 'p1', timeZone: 'America/Chicago' };
const cands = [
  { key: 'plan:a_1', kind: 'build_page' as const, title: 'Build your booking page', why: 'It’s on your plan for week 1. Doing it today keeps the plan moving.', steps: ['Pick the page type', 'Add your services'], target: { pageType: 'booking' as const, planActionId: 'a_1' }, from: 'plan' as const },
  { key: 'leads:2026-11-06', kind: 'leads' as const, title: 'Reply to your 2 new leads', why: '2 people got in touch recently. A quick reply today turns them into customers.', target: {}, from: 'rule' as const },
  { key: 'offline', kind: 'offline' as const, title: 'Reply to comments and messages for 15 minutes', why: 'Answering comments quickly builds trust with the people who follow you.', target: {}, from: 'rule' as const },
];
const action = (o: Partial<MorningAction> = {}): MorningAction => ({ id: '11111111-1111-4111-8111-111111111111', projectId: 'p1', localDate: '2026-11-07', timeZone: 'America/Chicago', state: 'ready', source: 'cron', engine: 'ai', chosen: 0, candidates: cands, feedback: [], fallback: null, credits: 2, ownKey: false, generatedAt: '2026-11-07T11:07:00.000Z', doneAt: null, ...o });
const today = (o: Partial<MorningToday> = {}): MorningToday => ({ actionDay: '2026-11-07', timeZone: 'America/Chicago', action: action(), dueNow: false, late: false, nextAt: '2026-11-08T11:00:00.000Z', attemptsLeft: 3, plan: 'active', ...o });
const entry = (o: Partial<MorningViewProps['entry']> = {}): MorningViewProps['entry'] => ({ today: today(), loading: false, starting: false, error: '', notice: '', locked: null, stalled: false, ...o });
const noop = () => {};
const draw = (o: Partial<MorningViewProps> = {}) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(MorningCardView, { project, local: false, entry: entry(), browserZone: 'America/Chicago', onStart: noop, onRefresh: noop, onFeedback: () => true, onUpgrade: noop, ...o })));

const FILLED = [/\bbtn-primary\b/, /\bbtn-ai\b(?!-)/];
function check(html: string) {
  expect(html).toContain('aria-label="Today&#x27;s action"');
  expect(html).toContain('aria-live="polite"');
  for (const re of FILLED) expect(html, String(re)).not.toMatch(re);
}

describe('the card', () => {
  it('loading: three skeleton lines', () => {
    const html = draw({ entry: entry({ today: null, loading: true }) });
    check(html);
    expect(html).toContain('Today’s action');
    expect((html.match(/skeleton/gi) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it('being made: the thinking strip with no Stop', () => {
    const html = draw({ entry: entry({ today: today({ action: action({ state: 'generating', chosen: null, engine: null, candidates: [] }) }) }) });
    check(html);
    expect(html).toContain('Picking today’s action…');
    expect(html).not.toContain('>Stop<');
  });
  it('ready, AI pick: title, why, steps, Do it as the AI outline button, Done, Not useful, area and the credits tip', () => {
    const html = draw();
    check(html);
    for (const t of ['AI pick', 'Build your booking page', 'Pick the page type', 'Build this page', 'Done', 'Not useful', 'Your page', 'Tomorrow’s comes at 5:00 AM', 'How today’s action was picked', 'clamp-2', 'clamp-3', 'btn-ai-outline']) expect(html, t).toContain(t);
    expect(html).not.toContain('Idea ');
  });
  it('ready, from your plan, with a fallback in our words only; Do it as a secondary button for a page', () => {
    const html = draw({ entry: entry({ today: today({ action: action({ engine: 'rules', chosen: 1, credits: null, fallback: 'credits', feedback: [{ i: 0, at: '2026-11-07T12:00:00.000Z' }] }) }) }) });
    check(html);
    for (const t of ['From your plan', 'Reply to your 2 new leads', 'Open your leads', 'btn-secondary', 'Idea 2 of 3', 'This month’s AI credits are used up, so this one is from your plan.']) expect(html, t).toContain(t);
    expect(html).not.toContain('How today’s action was picked');
    expect(fallbackLine({ fallback: 'own_key' })).toBe('Your own AI key didn’t answer, so this one is from your plan.');
    expect(fallbackLine({ fallback: 'daily_limit' })).toBe('Today’s AI limit is reached, so this one is from your plan.');
    for (const f of ['no_ai', 'ai_error', 'invalid_output', 'refused'] as const) expect(fallbackLine({ fallback: f })).toBe('');
    const own = draw({ entry: entry({ today: today({ action: action({ engine: 'rules', credits: null, fallback: 'own_key', ownKey: true }) }) }) });
    expect(own).toContain('Settings › AI keys');
  });
  it('an action done outside the app: no Do it, “Ask the assistant how”', () => {
    const html = draw({ entry: entry({ today: today({ action: action({ engine: 'rules', chosen: 2 }) }) }) });
    expect(html).toContain('Ask the assistant how');
    expect(html).toContain('Outside the app');
    expect(html).not.toContain('btn-secondary');
  });
  it('Not useful (open): reason chips with aria-pressed, a note, Send and Skip', () => {
    const html = draw({ asking: true });
    check(html);
    for (const t of ['Doesn’t fit my business', 'Already done', 'No time today', 'Not clear what to do', 'Something else', 'aria-pressed="false"', 'Tell us more', 'maxLength="200"', 'Send', 'Skip']) expect(html, t).toContain(t);
  });
  it('done, dismissed', () => {
    const done = draw({ entry: entry({ today: today({ action: action({ state: 'done', doneAt: '2026-11-07T15:00:00.000Z' }) }) }) });
    check(done);
    for (const t of ['Done. Nice work.', 'Undo', 'Tomorrow’s action comes at 5:00 AM.']) expect(done, t).toContain(t);
    const dismissed = draw({ entry: entry({ today: today({ action: action({ state: 'dismissed', feedback: [{ i: 0, at: 'x' }, { i: 1, at: 'x' }, { i: 2, at: 'x' }] }) }) }) });
    expect(dismissed).toContain('Thanks. We’ll pick differently tomorrow at 5:00 AM.');
    const nothing = draw({ entry: entry({ today: today({ action: action({ state: 'dismissed', candidates: [], chosen: null }) }) }) });
    expect(nothing).toContain('Nothing new for today. Tomorrow’s action comes at 5:00 AM.');
  });
  it('failed: “Get today’s action” (secondary) while attempts are left, else “Try again tomorrow.”', () => {
    const failed = draw({ entry: entry({ today: today({ action: action({ state: 'failed', chosen: null, engine: null, candidates: [] }), attemptsLeft: 2 }) }) });
    check(failed);
    expect(failed).toContain('Today’s action didn’t come through.');
    expect(failed).toContain('Get today’s action');
    expect(failed).toContain('btn-secondary');
    const out = draw({ entry: entry({ today: today({ action: action({ state: 'failed', chosen: null, engine: null, candidates: [] }), attemptsLeft: 0 }) }) });
    expect(out).toContain('Try again tomorrow.');
    expect(out).not.toContain('Get today’s action');
    // missing and due after the visit couldn't start it
    const missing = draw({ entry: entry({ today: today({ action: null, dueNow: true }), notice: 'Try again in a few minutes.' }) });
    expect(missing).toContain('Get today’s action');
    expect(missing).toContain('Try again in a few minutes.');
  });
  it('before 5 am: the next time, no button; the zone’s city when it isn’t the browser’s', () => {
    const html = draw({ entry: entry({ today: today({ action: null, late: true }) }), browserZone: 'Europe/London' });
    check(html);
    expect(html).toContain('Your next action comes at 5:00 AM (Chicago time).');
    expect(html).not.toContain('Get today’s action');
    expect(zoneNote('America/Chicago', 'America/Chicago')).toBe('');
    expect(zoneNote('America/Argentina/Buenos_Aires', 'UTC')).toBe(' (Buenos Aires time)');
  });
  it('plan paused: the trial or card prompt, opened only from its own button', () => {
    const trial = draw({ entry: entry({ locked: 'PLAN_REQUIRED' }) });
    check(trial);
    expect(trial).toContain('Your morning action is part of every plan.');
    expect(trial).toContain('Start your free trial');
    expect(draw({ entry: entry({ locked: 'PAYMENT_REQUIRED' }) })).toContain('Update your card');
  });
  it('error: plain words and Try again', () => {
    const html = draw({ entry: entry({ today: null, error: 'Couldn’t reach the app’s server.' }) });
    check(html);
    expect(html).toContain('Couldn’t load today’s action.');
    expect(html).toContain('Try again');
  });
  it('the built-in version: “Built in”, no credits and no “Get today’s action”', () => {
    const html = draw({ local: true, entry: entry({ today: today({ action: action({ engine: 'rules', credits: null, source: 'visit' }) }) }) });
    check(html);
    expect(html).toContain('Built in');
    expect(html).toContain('Built in: from your plan');
    expect(html).not.toContain('AI pick');
    expect(html).not.toContain('How today’s action was picked');
    expect(html).not.toContain('Get today’s action');
  });
});
