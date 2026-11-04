// Test data for the Strategy tests (not shipped: only tests import it). STRATEGY_QA and QA_SOURCES are
// copies of server/test/strategy-qa.mjs, the provider mock's scripted answers (spec §7.4): made-up
// findings on reserved example domains, each answer holding mistakes on purpose that the app's merges
// must fix. qaResearchMeta() is what the server sends back for them after a search (§7.1).
import type { Project } from '@/lib/types';
import type { AIMeta, ResearchMeta } from '@/ai/meta';
import type { StrategyState } from '@/lib/strategyTypes';
import type { TaskEnv } from '@/ai/tasks';
import { newProject } from '@/store/defaults';
import { capStrategy, emptyStrategy, strategyFactsHash, STRATEGY_STEPS } from '@/lib/strategy';
import { compactMeta } from '@/ai/meta';
import { STEP_TASK, stepInput } from '@/ai/strategyTasks';
import { saveStep } from '@/ai/strategyJob';

export const QA_SOURCES = [
  { url: 'https://example.com/qa-research/where-buyers-look', title: 'QA stand-in source 1 (not a real page)', page_age: 'October 1, 2026' },
  { url: 'https://example.org/qa-research/content-that-works?utm_source=qa', title: 'QA stand-in source 2 (not a real page)' },
  { url: 'https://example.net/qa-research/looked-at-not-cited', title: 'QA stand-in source 3 (looked at, not cited)' },
];

export const STRATEGY_QA = {
  research: {
    summary: 'QA stand-in research: made-up findings for testing, not real research.',
    findings: [
      { topic: 'buyers', text: 'QA: buyers compare local options on map listings before they call.', sources: ['https://example.com/qa-research/where-buyers-look'] },
      { topic: 'social', text: 'QA: short how-to videos get attention in this niche.', sources: ['https://example.org/qa-research/content-that-works'] },
      { topic: 'promote', text: 'QA: this cites a made-up address the search never returned.', sources: ['https://invented.example/not-a-source'] },
      { topic: 'offers', text: 'QA: no source, so this is general knowledge.', sources: [] },
      { topic: 'seo', text: 'QA: 73% of buyers search on their phone.', sources: [] },
    ],
  },
  promote: {
    positioning: { line: 'QA: the friendly local option for busy families.', who: 'QA: busy families nearby', why: 'QA stand-in.', sources: [1] },
    channels: [
      { name: 'Google Business Profile', channelType: 'search', platform: '', priority: 1, why: 'QA: buyers compare map listings.', how: ['QA: add photos', 'QA: add your booking link'], sources: [1] },
      { name: 'Instagram', channelType: 'social', platform: 'instagram', priority: 1, why: 'QA: short videos get attention.', how: ['QA: post short how-tos'], sources: [2] },
      { name: 'Local Facebook groups', channelType: 'community', platform: 'facebook', priority: 2, why: 'QA: general knowledge.', how: ['QA: answer questions'], sources: [] },
      { name: 'QA bad channel', channelType: 'spaceship', platform: 'myspace', priority: 7, why: 'QA: wrong ids get fixed.', how: [], sources: [99] },
    ],
    page: { pageType: 'booking', why: 'QA: people want to pick a time.', secondType: 'lead', secondWhy: 'QA: for questions first.', sources: [1] },
    links: {
      instagram: { placement: 'bio', why: 'QA: captions don’t make links clickable.', sources: [] },
      facebook: { placement: 'comment', why: 'QA stand-in.', sources: [2] },
      tiktok: { placement: 'sidebar', why: 'QA: a wrong placement.', sources: [] },
    },
  },
  content: {
    pillars: [
      { name: 'QA quick wins', why: 'QA stand-in.', ideas: ['QA: 3 signs your oven needs a deep clean', 'QA: this idea is far too long for a post topic because it keeps on going and going until the app has to cut it short'] },
      { name: 'QA behind the scenes', why: 'QA stand-in.', ideas: ['QA: a morning at the shop'] },
    ],
    formats: [
      { platform: 'instagram', what: 'QA: short how-to videos', why: 'QA.', sources: [2] },
      { platform: 'myspace', what: 'QA: a network the app doesn’t know', why: 'QA.', sources: [] },
    ],
    campaign: { goal: 'leads', platforms: ['instagram', 'facebook', 'myspace'], postMix: { educational: 2, tip: 3, question: 1, sales: 1, bts: 2, memes: 3 }, videoShare: 'some', why: 'QA stand-in.', sources: [2] },
    ideas: [
      { headline: 'QA: before and after of a kitchen', postType: 'bts', platform: 'instagram', why: 'QA.' },
      { headline: 'QA: an unknown post type becomes a tip', postType: 'rant', platform: 'instagram', why: 'QA.' },
    ],
  },
  assets: {
    assets: [
      { kind: 'page', title: 'QA: a booking page', why: 'QA.', codeKind: '', leadMagnetType: '', prompt: '', sources: [1] },
      { kind: 'lead_magnet', title: 'QA: a checklist', why: 'QA.', codeKind: '', leadMagnetType: 'checklist', prompt: '', sources: [] },
      { kind: 'code', title: 'QA: a price calculator', why: 'QA.', codeKind: 'calculator', leadMagnetType: '', prompt: 'QA: a calculator that estimates the cost of a deep clean from the number of rooms', sources: [] },
      { kind: 'hologram', title: 'QA: an unknown kind', why: 'QA.', codeKind: '', leadMagnetType: '', prompt: '', sources: [] },
    ],
    seo: { audience: 'QA: busy families nearby', angle: 'QA: trusted by 500 families.', objections: ['QA: Is it safe for pets?'], keywords: ['QA House Cleaning Austin'], cta: 'book', why: 'QA.', sources: [1] },
  },
  outreach: {
    email: { leadMagnetType: 'checklist', idea: 'QA: a move-out cleaning checklist', welcomeAngle: 'QA: practical tips first', why: 'QA.', sources: [] },
    templates: [
      { who: 'QA: property managers nearby', purpose: 'partner', subject: 'QA: a quick question about move-out cleans', body: 'Hi [Name],\n\nQA stand-in body. See https://evil.example/now for details.\n\n[Your name]', followUp: 'QA: a short nudge.', why: 'QA.' },
      { who: 'QA: past customers', purpose: 'fans', subject: 'QA: thank you', body: 'Hi [Name],\n\nYou will get 20% off forever. Thanks again for choosing us.\n\n[Your name]', followUp: '', why: 'QA.' },
    ],
  },
  plan: {
    summary: 'QA stand-in plan.',
    weeks: [
      { week: 1, focus: 'QA: get ready', goal: 'QA.' },
      { week: 2, focus: 'QA: launch', goal: 'QA.' },
      { week: 3, focus: 'QA: show up', goal: 'QA.' },
      { week: 4, focus: 'QA: follow up', goal: 'QA.' },
    ],
    actions: [
      { week: 1, title: 'QA: build your booking page', detail: 'QA.', kind: 'build_page', pageType: 'booking', topic: '', codeKind: '', leadMagnetType: '', platform: '', sources: [1] },
      { week: 1, title: 'QA: set where your link goes', detail: 'QA.', kind: 'link_settings', pageType: '', topic: '', codeKind: '', leadMagnetType: '', platform: '', sources: [] },
      { week: 2, title: 'QA: write a how-to post', detail: 'QA.', kind: 'write_post', pageType: '', topic: 'QA: 3 signs your oven needs a deep clean', codeKind: '', leadMagnetType: '', platform: 'instagram', sources: [2] },
      { week: 2, title: 'QA: email five property managers', detail: 'QA.', kind: 'outreach', pageType: '', topic: '', codeKind: '', leadMagnetType: '', platform: '', sources: [] },
      { week: 9, title: 'QA: a wrong week and kind', detail: 'QA: the app gives it no button.', kind: 'launch_rocket', pageType: '', topic: '', codeKind: '', leadMagnetType: '', platform: '', sources: [], route: '#workspace-settings' },
    ],
    habits: ['QA: reply to messages the same day'],
    measure: [
      { what: 'QA: sign-ups from your page', where: 'app', why: 'QA.' },
      { what: 'QA: you will get 40 bookings', where: 'app', why: 'QA.' },
    ],
  },
};

/** meta.research as the server sends it after the stand-in search: cited first, numbered from 1, the original URL strings. */
export function qaResearchMeta(web = true): ResearchMeta {
  if (!web) return { web: false, reason: 'unsupported', searches: 0, queries: [], sources: [], errors: [] };
  return {
    web: true,
    reason: '',
    searches: 1,
    queries: ['qa stand-in search'],
    sources: [
      { n: 1, url: QA_SOURCES[0].url, title: QA_SOURCES[0].title, domain: 'example.com', cited: true, quote: 'QA stand-in text.', pageAge: 'October 1, 2026' },
      { n: 2, url: QA_SOURCES[1].url, title: QA_SOURCES[1].title, domain: 'example.org', cited: false },
      { n: 3, url: QA_SOURCES[2].url, title: QA_SOURCES[2].title, domain: 'example.net', cited: false },
    ],
    errors: [],
  };
}

/** The meta of a reply from an Anthropic key (research: with the search's meta.research). */
export function qaMeta(research?: ResearchMeta): AIMeta {
  return {
    provider: 'anthropic',
    providerLabel: 'Anthropic Claude',
    fn: 'strategy',
    kind: 'text',
    model: 'claude-opus-5-5',
    effort: 'medium',
    effortLabel: 'Medium',
    effortField: 'output_config.effort',
    ms: 1200,
    usage: { input: 9000, output: 900, reasoning: null },
    cost: { usd: research?.web ? 0.0612 : 0.0412, source: 'estimate' },
    credits: null,
    params: null,
    note: '',
    ...(research ? { research, searches: research.searches } : {}),
  };
}

/** A business project like the browser QA's: "QA Bakery", a sourdough bakery in Austin, Texas. */
export function qaProject(id = 'p1'): Project {
  const p = newProject('business', 'existing');
  return {
    ...p,
    id,
    onboarded: true,
    niche: 'qa bakery',
    category: 'sourdough',
    businessType: 'Bakery',
    location: { city: 'Austin', region: 'Texas' },
    brand: { ...p.brand, name: 'QA Bakery', audience: 'busy families nearby' },
  };
}

/** A digital product project (a spreadsheet about freelancer taxes). */
export function qaProductProject(id = 'p2'): Project {
  const p = newProject('product', 'new');
  return { ...p, id, onboarded: true, niche: 'Personal Finance', category: 'Freelancer Tax Tracking', format: 'spreadsheet', brand: { ...p.brand, name: 'Tax Tracker', audience: 'freelancers' } };
}


export const qaEnv = (project: Project, meta?: AIMeta): TaskEnv => ({ project, directives: {}, brainPrompt: '', variation: 0, ...(meta ? { meta } : {}) });

/**
 * A strategy written from the QA answers, as a run on your server saves it: each step's answer through
 * its task's merge (research with the stand-in search's meta when `web`), then saved by the runner.
 */
export function qaSavedStrategy(p: Project, o: { web?: boolean; at?: number; base?: StrategyState } = {}): StrategyState {
  const web = o.web ?? true;
  let s: StrategyState = { ...(o.base ?? emptyStrategy()), run: { startedAt: o.at ?? 1_700_000_000_000, steps: [...STRATEGY_STEPS], done: [] } };
  let at = o.at ?? 1_700_000_000_000;
  for (const step of STRATEGY_STEPS) {
    const input = stepInput(step, p, s, { web, posts: [], ads: [], myListings: [] });
    const meta = step === 'research' ? qaMeta(qaResearchMeta(web)) : qaMeta();
    const task = STEP_TASK[step] as unknown as { claude: { merge: (raw: unknown, base: unknown, input: unknown, env: TaskEnv) => unknown } };
    const out = task.claude.merge(JSON.parse(JSON.stringify(STRATEGY_QA[step])), undefined, input, qaEnv(p, meta));
    at += 1000;
    const researchAt = step !== 'research' && s.research ? s.research.at : undefined;
    s = saveStep(s, step, out as never, { at, provider: 'server', meta: compactMeta(meta), factsHash: strategyFactsHash(p, s.inputs), ...(researchAt ? { researchAt } : {}) }, meta, 'server');
  }
  return capStrategy({ ...s, run: { ...s.run!, finishedAt: at + 1 }, updatedAt: at + 1 });
}
