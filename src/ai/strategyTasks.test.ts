// Strategy's six AI steps: the prompts (marker, rules, size, nothing the claude.ai build can't carry), the
// research hook, and the scripted QA answers (server/test/strategy-qa.mjs, copied in src/test/strategyQa.ts)
// through each merge: what the app keeps and drops (spec §7.4).
import { describe, expect, it } from 'vitest';
import type { Project } from '@/lib/types';
import type { StepInputBase, StrategyState } from '@/lib/strategyTypes';
import { emptyStrategy, readStrategy, STRATEGY_STEPS } from '@/lib/strategy';
import { STRATEGY_CAPS as C, CLAIMS, NUMBER_CLAIM, PREDICTION, URL_RE } from '@/lib/strategyNormalize';
import { QA_SOURCES, STRATEGY_QA, qaEnv, qaMeta, qaProductProject, qaProject, qaResearchMeta, qaSavedStrategy } from '@/test/strategyQa';
import { INPUT_BUDGET, STEP_TASK, STRATEGY_RULES, mapResearchUrls, renormalize, stepInput, stepMarker, strategyResearchTask, unwrapAnswer } from './strategyTasks';
import { ctxFrom } from './strategyTasks';
import type { TaskEnv } from './tasks';

type AnyTask = { local: (i: unknown, env: TaskEnv) => unknown; claude: { prompt: (i: unknown, env: TaskEnv, base: unknown) => string; merge: (raw: unknown, base: unknown, i: unknown, env: TaskEnv) => unknown; research?: (i: unknown, env: TaskEnv) => unknown } };
const task = (step: keyof typeof STEP_TASK) => STEP_TASK[step] as unknown as AnyTask;
const rt = (web = true) => ({ web, posts: [], ads: [], myListings: [] });

/** A strategy filled to every cap, with long owner details: the biggest prompt a step can get. */
function maxed(p: Project): StrategyState {
  const long = (n: number) => 'word '.repeat(Math.ceil(n / 5)).slice(0, n);
  const s = qaSavedStrategy(p);
  const sources = Array.from({ length: C.sources.items }, (_, i) => ({ n: i + 1, url: `https://example.com/${'p'.repeat(300)}/${i}`, title: long(C.sources.title), domain: 'example.com', via: 'search' as const, at: 1 }));
  const ns = sources.map((x) => x.n).slice(0, 4);
  return {
    ...s,
    inputs: { goal: long(C.inputs.goal), budget: long(C.inputs.budget), timePerWeek: long(C.inputs.timePerWeek), competitors: Array.from({ length: 10 }, (_, i) => `${i} ${long(C.inputs.competitor - 2)}`), tried: long(C.inputs.tried), notes: long(C.inputs.notes) },
    sources,
    nextSource: sources.length + 1,
    research: { ...s.research!, summary: long(C.research.summary), findings: Array.from({ length: C.research.findings }, (_, i) => ({ topic: 'buyers' as const, text: `${i} ${long(C.research.text - 3)}`, basis: 'web' as const, sources: ns })) },
    manus: { taskId: 'task_qa_123', taskUrl: 'https://manus.im/app/task_qa_123', state: 'done', requestedAt: 1, doneAt: 2, findings: Array.from({ length: C.manus.findings }, (_, i) => ({ topic: 'social' as const, text: `${i} ${long(C.manus.text - 3)}`, basis: 'web' as const, sources: [ns[0]] })) },
    promote: { ...s.promote!, positioning: { ...s.promote!.positioning, line: long(C.promote.line) }, channels: Array.from({ length: C.promote.channels }, (_, i) => ({ name: `${i} ${long(C.promote.name - 3)}`, channelType: 'partners' as const, priority: 1 as const, why: long(300), how: [], basis: 'ai' as const })) },
    content: { ...s.content!, pillars: Array.from({ length: C.content.pillars }, (_, i) => ({ name: `${i} ${long(C.content.pillarName - 3)}`, why: long(200), ideas: [] })) },
    assets: { ...s.assets!, assets: Array.from({ length: C.assets.items }, (_, i) => ({ id: `as_${i}`, kind: 'code' as const, title: `${i} ${long(C.assets.title - 3)}`, why: long(300), codeKind: 'quiz' as const, leadMagnetType: 'guide' as const, basis: 'ai' as const })) },
    outreach: { ...s.outreach!, templates: Array.from({ length: 3 }, (_, i) => ({ ...s.outreach!.templates[0], id: `tp_${i}`, who: long(C.outreach.who) })) },
  };
}

describe('the prompts', () => {
  const p = qaProject();
  const s = qaSavedStrategy(p);

  it('start their TASK with the step’s marker and carry every rule, and nothing the claude.ai build can’t hold', () => {
    for (const step of STRATEGY_STEPS) {
      const input = stepInput(step, p, s, rt());
      const prompt = task(step).claude.prompt(input, qaEnv(p), undefined);
      expect(prompt).toContain(`TASK: ${stepMarker(step)} `);
      for (const r of STRATEGY_RULES) expect(prompt).toContain(r);
      expect(prompt).not.toMatch(/<\/script/i);
      expect(prompt).not.toMatch(/<\/style/i);
      expect(prompt.includes('<!--') && /<script/i.test(prompt.slice(prompt.indexOf('<!--')))).toBe(false);
      // the model cites source numbers, never sees their URLs
      if (step !== 'research') expect(prompt).not.toContain('example.com/qa-research');
    }
  });

  it('stay within 24,000 characters for a strategy filled to every cap', () => {
    const big = maxed(p);
    // every step of a full plan ticked, with titles at their cap: the plan step gets them all
    const actions = Array.from({ length: C.plan.actions }, (_, i) => ({ ...big.plan!.actions[0], id: `a_max${i}`, title: `${i} ${'word '.repeat(20)}`.slice(0, C.plan.title) }));
    const ticked = { ...big, plan: { ...big.plan!, actions }, ticks: Object.fromEntries(actions.map((a) => [a.id, 1])) };
    expect((stepInput('plan', p, ticked, rt()) as unknown as { earlier: { done: string[] } }).earlier.done).toHaveLength(C.plan.actions);
    for (const step of STRATEGY_STEPS) {
      for (const s of [big, ticked]) {
        const prompt = task(step).claude.prompt(stepInput(step, p, s, rt()), qaEnv(p), undefined);
        expect(prompt.length).toBeLessThanOrEqual(24_000);
      }
    }
  });

  it('plan: the steps of the current plan the owner ticked go in, with the rule to keep them under the same titles', () => {
    const [a, , c] = s.plan!.actions;
    const ticked = { ...s, ticks: { [a.id]: 1, [c.id]: 2 } };
    const input = stepInput('plan', p, ticked, rt()) as unknown as { earlier: Record<string, unknown> };
    expect(input.earlier.done).toEqual([a.title, c.title]);
    const prompt = task('plan').claude.prompt(input, qaEnv(p), undefined);
    expect(prompt).toContain('INPUT.earlier.done lists steps of the current plan the owner already did. Keep each one that still applies in the new plan, with exactly the same title, so it stays marked as done.');
    // nothing ticked: neither the list nor the rule
    const none = stepInput('plan', p, s, rt()) as unknown as { earlier: Record<string, unknown> };
    expect(none.earlier).not.toHaveProperty('done');
    expect(task('plan').claude.prompt(none, qaEnv(p), undefined)).not.toContain('INPUT.earlier.done');
    // other steps never get it
    expect(stepInput('content', p, ticked, rt())).not.toHaveProperty('earlier.done');
  });

  it('a long research is shortened to fit, never the owner’s words', () => {
    const big = maxed(p);
    const input = stepInput('plan', p, big, rt()) as unknown as { owner: Record<string, unknown>; research: { findings: { text: string; sources: number[] }[] }; sources: { n: number }[] };
    expect(JSON.stringify(input, null, 1).length).toBeLessThanOrEqual(INPUT_BUDGET);
    expect(input.owner).toEqual(big.inputs);
    expect(input.research.findings.length).toBeGreaterThan(0);
    expect(input.research.findings.length).toBeLessThan(big.research!.findings.length + big.manus!.findings!.length);
    expect(input.research.findings.every((f) => f.text.length <= 200)).toBe(true);
    // only the sources the kept findings cite are listed
    const cited = new Set(input.research.findings.flatMap((f) => f.sources));
    expect(input.sources.every((x) => cited.has(x.n))).toBe(true);
    // a usual strategy goes in whole
    const usual = stepInput('plan', p, s, rt()) as unknown as { research: { findings: unknown[] } };
    expect(usual.research.findings).toHaveLength(4);
  });

  it('research: searches only with a key that can, and says so in the rules', () => {
    const off = stepInput('research', p, s, rt(false));
    const on = stepInput('research', p, { ...s, maxSearches: 8 }, rt(true));
    const promptOff = task('research').claude.prompt(off, qaEnv(p), undefined);
    const promptOn = task('research').claude.prompt(on, qaEnv(p), undefined);
    expect(promptOff).toContain('You can\'t search the web here.');
    expect(promptOff).not.toContain('Use your web search tool');
    expect(promptOn).toContain('Use your web search tool before answering. Make at most 8 searches.');
    expect(promptOn).toContain(', in Austin, Texas.');
    // the hook asks the server to search only when a key can
    expect(strategyResearchTask.claude!.research!(off as never, qaEnv(p))).toBeNull();
    expect(strategyResearchTask.claude!.research!(on as never, qaEnv(p))).toEqual({ web: true, maxSearches: 8, location: { city: 'Austin', region: 'Texas' } });
    // a product has no place to search for
    const prod = stepInput('research', qaProductProject(), emptyStrategy(), rt());
    expect(prod).toMatchObject({ location: null, locationParts: null });
  });

  it('look at the competitors only when the owner named some', () => {
    const none = task('research').claude.prompt(stepInput('research', p, s, rt()), qaEnv(p), undefined);
    const some = task('research').claude.prompt(stepInput('research', p, { ...s, inputs: { ...s.inputs, competitors: ['Rise Bakery'] } }, rt()), qaEnv(p), undefined);
    expect(none).not.toContain('INPUT.owner.competitors promote themselves');
    expect(some).toContain('Also look at how the businesses in INPUT.owner.competitors promote themselves, from their public pages.');
    expect(some).toContain('"Rise Bakery"');
  });

  it('give later steps the findings by source number and the ids they may use, never the owner’s empty fields', () => {
    const input = stepInput('plan', p, { ...s, inputs: { ...s.inputs, goal: '10 new bookings' } }, rt()) as unknown as Record<string, unknown>;
    expect(input.owner).toEqual({ goal: '10 new bookings' });
    expect(input.sources).toEqual([
      { n: 1, title: 'QA stand-in source 1 (not a real page)', domain: 'example.com' },
      { n: 2, title: 'QA stand-in source 2 (not a real page)', domain: 'example.org' },
    ]);
    expect((input.allowed as StepInputBase['allowed']).codeKinds).not.toContain('testimonials');
    expect((input.allowed as StepInputBase['allowed']).codeKinds).not.toContain('countdown');
    expect(input.earlier).toMatchObject({ page: { pageType: 'booking', secondType: 'lead' }, links: { instagram: 'bio', facebook: 'comment' } });
  });
});

describe('the QA answers through each merge (spec §7.4)', () => {
  const p = qaProject();
  const s = qaSavedStrategy(p);

  it('research: two findings from the web with their sources, the invented address dropped, the unsourced number gone', () => {
    const r = s.research!;
    expect(r).toMatchObject({ mode: 'web', reason: '', searches: 1, queries: ['qa stand-in search'] });
    expect(r.findings).toHaveLength(4);
    expect(r.findings[0]).toEqual({ topic: 'buyers', text: 'QA: buyers compare local options on map listings before they call.', basis: 'web', sources: [1] });
    expect(r.findings[1]).toEqual({ topic: 'social', text: 'QA: short how-to videos get attention in this niche.', basis: 'web', sources: [2] });
    expect(r.findings[2]).toMatchObject({ topic: 'promote', basis: 'ai' });
    expect(r.findings[2].sources).toBeUndefined();
    expect(r.findings[3]).toMatchObject({ topic: 'offers', basis: 'ai' });
    expect(JSON.stringify(r)).not.toContain('73%');
    // stored: the two cited pages, with the provider's own URL string (utm and all), title and date
    expect(s.sources.map((x) => [x.n, x.domain, x.url])).toEqual([
      [1, 'example.com', QA_SOURCES[0].url],
      [2, 'example.org', QA_SOURCES[1].url],
    ]);
    expect(s.sources[0]).toMatchObject({ title: 'QA stand-in source 1 (not a real page)', pageAge: 'October 1, 2026', quote: 'QA stand-in text.', via: 'search' });
    expect(JSON.stringify(s)).not.toContain('invented.example');
  });

  it('research without a search: everything is general knowledge, the number finding dropped', () => {
    const g = qaSavedStrategy(p, { web: false });
    expect(g.research).toMatchObject({ mode: 'general', reason: 'unsupported' });
    expect(g.research!.findings.map((f) => f.basis)).toEqual(['ai', 'ai', 'ai', 'ai']);
    expect(JSON.stringify(g.research)).not.toContain('73%');
    expect(g.sources).toEqual([]);
    // later steps had no source numbers to cite
    expect(g.promote!.positioning.basis).toBe('ai');
  });

  it('only URLs the search returned count, matched however they’re written', () => {
    const meta = qaMeta(qaResearchMeta(true));
    const out = mapResearchUrls(
      [
        { topic: 'buyers', text: 'x', sources: ['http://www.EXAMPLE.com/qa-research/where-buyers-look/', 'https://example.com/qa-research/where-buyers-look#top', 'https://example.net/qa-research/looked-at-not-cited', 'javascript:alert(1)', 'https://invented.example/x'] },
        { topic: 'social', text: 'y', sources: 'https://example.com' },
      ],
      meta,
    );
    expect(out[0].sourceUrls).toEqual([QA_SOURCES[0].url, QA_SOURCES[2].url]);
    expect(out[1].sourceUrls).toEqual([]);
    // no real search: none count
    expect(mapResearchUrls([{ sources: [QA_SOURCES[0].url] }], qaMeta(qaResearchMeta(false)))[0].sourceUrls).toEqual([]);
    expect(mapResearchUrls([{ sources: [QA_SOURCES[0].url] }], undefined)[0].sourceUrls).toEqual([]);
  });

  it('promote: wrong ids fixed, unknown source numbers dropped, links checked', () => {
    const pr = s.promote!;
    expect(pr.positioning).toMatchObject({ line: 'QA: the friendly local option for busy families.', basis: 'web', sources: [1] });
    const bad = pr.channels.find((c) => c.name === 'QA bad channel')!;
    expect(bad).toMatchObject({ channelType: 'other', priority: 3, basis: 'ai' });
    expect(bad.platform).toBeUndefined();
    expect(bad.sources).toBeUndefined();
    expect(pr.channels.find((c) => c.name === 'Instagram')).toMatchObject({ channelType: 'social', platform: 'instagram', priority: 1, basis: 'web', sources: [2] });
    expect(pr.channels.find((c) => c.name === 'Google Business Profile')!.platform).toBeUndefined();
    expect(pr.page).toMatchObject({ pageType: 'booking', secondType: 'lead', basis: 'web', sources: [1] });
    expect(pr.links.instagram).toMatchObject({ placement: 'bio', basis: 'ai' });
    expect(pr.links.facebook).toMatchObject({ placement: 'comment', basis: 'web', sources: [2] });
    // TikTok isn't one of the project's networks: its wrong placement is left out
    expect(pr.links.tiktok).toBeUndefined();
    // when it is, the built-in placement stands in for the wrong one
    const tk: Project = { ...p, marketing: { ...p.marketing, campaign: { ...p.marketing.campaign, platforms: ['instagram', 'facebook', 'tiktok'] } } };
    const tkInput = stepInput('promote', tk, s, rt());
    const merged = task('promote').claude.merge(STRATEGY_QA.promote, undefined, tkInput, qaEnv(tk)) as typeof pr;
    expect(merged.links.tiktok).toMatchObject({ placement: 'bio', basis: 'builtin' });
  });

  it('content: the long idea cut, the unknown network dropped, the campaign checked', () => {
    const c = s.content!;
    const long = c.pillars[0].ideas[1];
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith('…')).toBe(true);
    expect(c.formats.map((f) => f.platform)).toEqual(['instagram']);
    expect(c.formats[0]).toMatchObject({ basis: 'web', sources: [2] });
    expect(c.campaign).toMatchObject({ goal: 'leads', platforms: ['instagram', 'facebook'], postMix: { educational: 2, tip: 3, question: 1, sales: 1, bts: 2 }, videoShare: 'some', basis: 'web' });
    expect(c.campaign.postMix).not.toHaveProperty('memes');
    expect(c.ideas.map((i) => i.postType)).toEqual(['bts', 'tip']);
  });

  it('assets: the unknown kind dropped, the claim out of the SEO angle, keywords lowercased', () => {
    const a = s.assets!;
    expect(a.assets.map((x) => x.kind)).toEqual(['page', 'lead_magnet', 'code']);
    expect(a.assets[2]).toMatchObject({ codeKind: 'calculator', prompt: 'QA: a calculator that estimates the cost of a deep clean from the number of rooms' });
    expect(a.assets[1]).toMatchObject({ leadMagnetType: 'checklist' });
    expect(a.assets[0].prompt).toBeUndefined();
    expect(a.seo.angle).toBe('');
    expect(a.seo.keywords).toEqual(['qa house cleaning austin']);
    expect(a.seo).toMatchObject({ audience: 'QA: busy families nearby', objections: ['QA: Is it safe for pets?'], cta: 'book', basis: 'web', sources: [1] });
  });

  it('outreach: the link becomes a placeholder, the unknown purpose “other”, the promise dropped', () => {
    const [t1, t2] = s.outreach!.templates;
    expect(t1.body).toBe('Hi [Name],\n\nQA stand-in body. See [link to your page] for details.\n\n[Your name]');
    expect(t1.purpose).toBe('partner');
    expect(t2.purpose).toBe('other');
    expect(t2.body).toBe('Hi [Name],\n\nThanks again for choosing us.\n\n[Your name]');
    expect(JSON.stringify(s.outreach)).not.toContain('20%');
    expect(JSON.stringify(s.outreach)).not.toContain('evil.example');
    expect(s.outreach!.email).toMatchObject({ leadMagnetType: 'checklist', idea: 'QA: a move-out cleaning checklist', basis: 'ai' });
  });

  it('plan: the wrong week and kind fixed (no button), the prediction dropped', () => {
    const pl = s.plan!;
    const odd = pl.actions.find((a) => a.title === 'QA: a wrong week and kind')!;
    expect(odd).toMatchObject({ week: 4, kind: 'offline', basis: 'ai' });
    expect(odd).not.toHaveProperty('route');
    expect(pl.measure).toEqual([{ what: 'QA: sign-ups from your page', where: 'app', why: 'QA.' }]);
    expect(pl.actions.find((a) => a.kind === 'build_page')).toMatchObject({ pageType: 'booking', week: 1, basis: 'web', sources: [1] });
    expect(pl.actions.find((a) => a.kind === 'write_post')).toMatchObject({ topic: 'QA: 3 signs your oven needs a deep clean', platform: 'instagram' });
    expect(pl.weeks.map((w) => w.week)).toEqual([1, 2, 3, 4]);
    expect(pl.actions.every((a) => /^a_[a-z0-9]{1,13}$/.test(a.id))).toBe(true);
  });

  it('reads back unchanged (the stored strategy is already normalized)', () => {
    const back = readStrategy({ ...p, strategy: s });
    expect(back).toEqual(s);
  });
});

describe('an answer wrapped in one key', () => {
  const p = qaProject();
  const s = qaSavedStrategy(p);

  it('is read as the answer inside it (one or two levels down), whatever the wrapper is called', () => {
    expect(unwrapAnswer('plan', { plan: STRATEGY_QA.plan })).toBe(STRATEGY_QA.plan);
    expect(unwrapAnswer('plan', { result: { plan: STRATEGY_QA.plan } })).toBe(STRATEGY_QA.plan);
    expect(unwrapAnswer('research', { data: STRATEGY_QA.research })).toBe(STRATEGY_QA.research);
    // the wrapper has the same name as one of the step's own keys
    expect(unwrapAnswer('assets', { assets: STRATEGY_QA.assets })).toBe(STRATEGY_QA.assets);
  });

  it('leaves alone an answer that is already the right shape, or that has nothing to unwrap', () => {
    const findingsOnly = { findings: STRATEGY_QA.research.findings };
    expect(unwrapAnswer('research', findingsOnly)).toBe(findingsOnly);
    const positioningOnly = { positioning: STRATEGY_QA.promote.positioning };
    expect(unwrapAnswer('promote', positioningOnly)).toBe(positioningOnly);
    const campaignOnly = { campaign: STRATEGY_QA.content.campaign };
    expect(unwrapAnswer('content', campaignOnly)).toBe(campaignOnly);
    for (const odd of [{ answer: 'Here is your plan.' }, { plan: [STRATEGY_QA.plan] }, { plan: {} }, [STRATEGY_QA.plan], 'text', null]) expect(unwrapAnswer('plan', odd)).toBe(odd);
    expect(unwrapAnswer('plan', STRATEGY_QA.plan)).toBe(STRATEGY_QA.plan);
  });

  it('each step’s merge reads the answer inside the wrapper', () => {
    for (const step of STRATEGY_STEPS) {
      if (step === 'research') continue;
      const input = stepInput(step, p, s, rt());
      const wrapped = task(step).claude.merge({ [step]: JSON.parse(JSON.stringify(STRATEGY_QA[step])) }, undefined, input, qaEnv(p));
      const plain = task(step).claude.merge(JSON.parse(JSON.stringify(STRATEGY_QA[step])), undefined, input, qaEnv(p));
      expect(wrapped).toEqual(plain);
    }
    const meta = qaMeta(qaResearchMeta());
    const input = stepInput('research', p, s, rt());
    const research = task('research').claude.merge({ research: JSON.parse(JSON.stringify(STRATEGY_QA.research)) }, undefined, input, qaEnv(p, meta)) as { findings: unknown[]; summary: string };
    expect(research.findings).toHaveLength(4);
    expect(research.summary).toBe(STRATEGY_QA.research.summary);
  });
});

describe('the built-in engine through the normalizers', () => {
  for (const make of [qaProject, qaProductProject]) {
    it(`${make().track}: every local step passes through its normalizer unchanged`, () => {
      const p = make();
      const s = emptyStrategy();
      for (const step of STRATEGY_STEPS) {
        const input = stepInput(step, p, s, rt(false));
        const out = task(step).local(input, qaEnv(p));
        const ctx = ctxFrom(input as never, { project: p }, 'builtin', true);
        expect(renormalize(step, out, ctx)).toEqual(out);
        const text = JSON.stringify(out);
        expect(text).not.toMatch(URL_RE);
        for (const re of [CLAIMS, PREDICTION, NUMBER_CLAIM]) expect(text).not.toMatch(re);
      }
    });
  }
});
