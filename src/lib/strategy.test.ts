// Reading a stored strategy safely, keeping it small, its sources, the URL rules (the same table as the
// server's research.test.mjs, spec §7.5), the plan's weeks and what's stale.
import { describe, expect, it } from 'vitest';
import type { Project } from './types';
import type { StrategyState } from './strategyTypes';
import { STRATEGY_CAPS as C } from './strategyNormalize';
import { addSource, capStrategy, citedSources, currentWeek, derivedDone, emptyStrategy, gcSources, isHttpUrl, readStrategy, sourceKey, stale, strategyFactsHash, strategyProgress, strategyStatusLine } from './strategy';
import { qaProject, qaSavedStrategy } from '@/test/strategyQa';

const p = qaProject();
const ctx = { posts: [], ads: [], myListings: [], now: Date.now() };
const withStrategy = (s: unknown): Project => ({ ...p, strategy: s as StrategyState });

describe('the URL rules (identical on the server)', () => {
  it('isHttpUrl', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com/x', 'https://user:pw@example.com/', 'https://localhost/x', `https://example.com/${'a'.repeat(2000)}`, '', 'not a url']) expect(isHttpUrl(bad)).toBe(false);
  });
  it('sourceKey', () => {
    expect(sourceKey('https://www.Example.com/path/?utm_source=x&b=2#frag')).toBe('example.com/path?b=2');
    expect(sourceKey('http://example.com/path?b=2')).toBe('example.com/path?b=2');
    expect(sourceKey('https://example.org/qa?gclid=1')).toBe('example.org/qa');
    expect(sourceKey('not a url')).toBe('');
  });
});

describe('readStrategy', () => {
  it('copes with nothing and with garbage', () => {
    expect(readStrategy(p)).toEqual(emptyStrategy());
    for (const junk of [42, 'strategy', [1, 2], null, true]) expect(readStrategy(withStrategy(junk))).toEqual(emptyStrategy());
    const odd = readStrategy(withStrategy({ inputs: { goal: 7, competitors: 'Rise', notes: null }, useBrain: 'no', maxSearches: 99, sources: 'x', research: { at: 'yesterday' }, promote: [], plan: { at: 5, provider: 'server', actions: 'x', weeks: null }, ticks: [], applied: 'x', run: { startedAt: 1 } }));
    expect(odd.inputs).toEqual({ goal: '7', budget: '', timePerWeek: '', competitors: [], tried: '', notes: '' });
    // anything but false keeps the Brain on; an unknown number of searches is the default
    expect(odd).toMatchObject({ useBrain: true, maxSearches: 5, sources: [], ticks: {}, applied: {} });
    expect(odd.research).toBeUndefined();
    expect(odd.promote).toBeUndefined();
    expect(odd.run).toBeUndefined();
    // a plan with nothing usable still reads as a plan (4 weeks, no actions)
    expect(odd.plan?.weeks).toHaveLength(4);
    expect(odd.plan?.actions).toEqual([]);
  });

  it('keeps "from the web" only with a source that exists', () => {
    const s = qaSavedStrategy(p);
    const tampered = JSON.parse(JSON.stringify(s)) as StrategyState;
    tampered.research!.findings[2] = { ...tampered.research!.findings[2], basis: 'web', sources: [77] };
    tampered.promote!.positioning.sources = [1, 77];
    const back = readStrategy(withStrategy(tampered));
    expect(back.research!.findings[2].basis).toBe('ai');
    expect(back.research!.findings[2].sources).toBeUndefined();
    expect(back.promote!.positioning).toMatchObject({ basis: 'web', sources: [1] });
    // a stored "web" with no sources at all is the AI's general knowledge
    tampered.research!.findings[3] = { ...tampered.research!.findings[3], basis: 'web' };
    expect(readStrategy(withStrategy(tampered)).research!.findings[3].basis).toBe('ai');
  });

  it('keeps ticks only for the plan’s actions, with good keys', () => {
    const s = qaSavedStrategy(p);
    const id = s.plan!.actions[0].id;
    const back = readStrategy(withStrategy({ ...s, ticks: { [id]: 5, a_gone: 6, 'bad key': 7, a_x: 'yes' } }));
    expect(back.ticks).toEqual({ [id]: 5 });
  });

  it('keeps Manus only with a real task id and an https link', () => {
    const s = qaSavedStrategy(p);
    const m = { taskId: 'task_abc123', taskUrl: 'https://manus.im/app/task_abc123', state: 'working', requestedAt: 1 };
    expect(readStrategy(withStrategy({ ...s, manus: m })).manus).toMatchObject({ taskId: 'task_abc123', state: 'working' });
    for (const bad of [{ ...m, taskId: 'x' }, { ...m, taskId: '../../etc' }, { ...m, taskUrl: 'http://manus.im/app/x' }, { ...m, taskUrl: 'javascript:alert(1)' }]) expect(readStrategy(withStrategy({ ...s, manus: bad })).manus).toBeUndefined();
    // Manus's findings are pages' words: one without its page is dropped
    const withFindings = readStrategy(withStrategy({ ...s, manus: { ...m, state: 'done', findings: [{ topic: 'buyers', text: 'kept', basis: 'web', sources: [1] }, { topic: 'buyers', text: 'no page', basis: 'web', sources: [] }] } }));
    expect(withFindings.manus!.findings!.map((f) => f.text)).toEqual(['kept']);
  });
});

/** A strategy with every list and text at its cap, every point citing sources. */
function maxed(): StrategyState {
  const t = (n: number, tag = '') => `${tag}${'abcd '.repeat(n)}`.slice(0, n).trim();
  const s = qaSavedStrategy(p);
  const sources = Array.from({ length: C.sources.items }, (_, i) => ({ n: i + 1, url: `https://example.com/${i}/${'p'.repeat(C.sources.url - 30)}`, title: t(C.sources.title, `${i} `), domain: t(C.sources.domain, `d${i}`), quote: t(C.sources.quote), pageAge: t(C.sources.pageAge), via: 'search' as const, at: 1 }));
  const cite = (i: number) => [1 + (i % 24), 1 + ((i + 5) % 24), 1 + ((i + 11) % 24), 1 + ((i + 17) % 24)];
  const meta = s.promote!.meta;
  const info = (at: number) => ({ at, provider: 'server' as const, meta, note: t(C.step.note), factsHash: 'abc', researchAt: at, skills: Array.from({ length: 6 }, (_, i) => t(C.step.skill, `${i}`)) });
  return {
    ...s,
    inputs: { goal: t(C.inputs.goal), budget: t(C.inputs.budget), timePerWeek: t(C.inputs.timePerWeek), competitors: Array.from({ length: 10 }, (_, i) => t(C.inputs.competitor, `${i} `)), tried: t(C.inputs.tried), notes: t(C.inputs.notes) },
    sources,
    nextSource: 25,
    research: { ...s.research!, ...info(1), summary: t(C.research.summary), findings: Array.from({ length: 16 }, (_, i) => ({ topic: 'buyers' as const, text: t(C.research.text, `${i} `), basis: 'web' as const, sources: cite(i) })), queries: Array.from({ length: 8 }, (_, i) => t(200, `${i}`)), checks: Array.from({ length: 6 }, (_, i) => t(200, `${i}`)) },
    manus: { taskId: 'task_abc123', taskUrl: 'https://manus.im/app/task_abc123', state: 'done', requestedAt: 1, doneAt: 2, message: t(300), findings: Array.from({ length: 12 }, (_, i) => ({ topic: 'social' as const, text: t(300, `${i} `), basis: 'web' as const, sources: cite(i + 3) })) },
    promote: { ...s.promote!, ...info(2), positioning: { line: t(200), who: t(160), why: t(300), basis: 'web', sources: cite(1) }, channels: Array.from({ length: 8 }, (_, i) => ({ name: t(60, `${i} `), channelType: 'partners' as const, priority: 1 as const, why: t(300), how: [t(160, 'a'), t(160, 'b'), t(160, 'c'), t(160, 'd')], basis: 'web' as const, sources: cite(i) })) },
    content: { ...s.content!, ...info(3), pillars: Array.from({ length: 5 }, (_, i) => ({ name: t(40, `${i} `), why: t(200), ideas: [t(90, 'a'), t(90, 'b'), t(90, 'c'), t(90, 'd')] })), formats: Array.from({ length: 8 }, (_, i) => ({ platform: 'instagram' as const, what: t(80, `${i} `), why: t(200), basis: 'web' as const, sources: cite(i) })), ideas: Array.from({ length: 10 }, (_, i) => ({ headline: t(90, `${i} `), postType: 'tip' as const, why: t(200) })) },
    assets: { ...s.assets!, ...info(4), assets: Array.from({ length: 8 }, (_, i) => ({ id: `as_${i}`, kind: 'code' as const, title: t(90, `${i} `), why: t(300), codeKind: 'quiz' as const, prompt: t(600), basis: 'web' as const, sources: cite(i) })), seo: { audience: t(200), angle: t(200), objections: [t(160, 'a'), t(160, 'b'), t(160, 'c'), t(160, 'd')], keywords: [t(80, 'a'), t(80, 'b'), t(80, 'c'), t(80, 'd'), t(80, 'e')], cta: 'book', why: t(300), basis: 'web', sources: cite(2) } },
    outreach: { ...s.outreach!, ...info(5), templates: Array.from({ length: 3 }, (_, i) => ({ id: `tp_${i}`, who: t(80), purpose: 'partner' as const, subject: t(90, `${i} `), body: t(1200), followUp: t(400), why: t(200) })) },
    plan: { ...s.plan!, ...info(6), summary: t(400), actions: Array.from({ length: 24 }, (_, i) => ({ id: `a_${i.toString(36)}`, week: (1 + (i % 4)) as 1 | 2 | 3 | 4, title: t(90, `${i} `), detail: t(300), kind: 'write_post' as const, topic: t(90), basis: 'web' as const, sources: cite(i) })), habits: Array.from({ length: 5 }, (_, i) => t(160, `${i}`)), measure: Array.from({ length: 6 }, (_, i) => ({ what: t(120, `${i}`), where: 'app' as const, why: t(160) })) },
    ticks: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`a_${i.toString(36)}`, 1000 + i])),
    useBrain: false,
    maxSearches: 8,
  };
}

describe('capStrategy', () => {
  it('keeps a strategy filled to every cap within 60,000 characters, keeps the owner’s facts, and is idempotent', () => {
    const big = maxed();
    expect(JSON.stringify(big).length).toBeGreaterThan(C.json);
    const once = capStrategy(big);
    expect(JSON.stringify(once).length).toBeLessThanOrEqual(C.json);
    expect(capStrategy(once)).toEqual(once);
    expect(once.inputs).toEqual(big.inputs);
    expect(once.ticks).toEqual(big.ticks);
    expect(once).toMatchObject({ useBrain: false, maxSearches: 8 });
    // what's left still cites only sources that exist, and a point that lost all of them isn't "web"
    const ns = new Set(once.sources.map((x) => x.n));
    const points = [...once.research!.findings, ...once.promote!.channels, ...(once.plan?.actions ?? [])];
    for (const x of points) {
      for (const n of x.sources ?? []) expect(ns.has(n)).toBe(true);
      if (x.basis === 'web') expect(x.sources?.length).toBeGreaterThan(0);
    }
    // read back the same way
    expect(JSON.stringify(readStrategy(withStrategy(big))).length).toBeLessThanOrEqual(C.json);
  });

  /** `s` after a search that found `count` new pages, cited two to a finding by the new research, saved during `run`. */
  const searched = (s: StrategyState, count: number, run: StrategyState['run']): StrategyState => {
    const ns = Array.from({ length: count }, (_, i) => s.nextSource + i);
    const sources = [...s.sources, ...ns.map((n) => ({ n, url: `https://site${n}.example/page`, title: `Page ${n}`, domain: `site${n}.example`, via: 'search' as const, at: 2 }))];
    const findings = Array.from({ length: Math.ceil(count / 2) }, (_, i) => ({ topic: 'buyers' as const, text: `Finding ${i}: buyers compare listings first.`, basis: 'web' as const, sources: ns.slice(i * 2, i * 2 + 2) }));
    return { ...s, sources, nextSource: s.nextSource + count, research: { ...s.research!, findings }, run };
  };
  /** Every citation points at a source that's there, and every source is cited. */
  const consistent = (s: StrategyState) => {
    const ns = new Set(s.sources.map((x) => x.n));
    for (const n of citedSources(s)) expect(ns.has(n)).toBe(true);
    expect([...ns].every((n) => citedSources(s).has(n))).toBe(true);
  };
  const withNumber = (s: StrategyState): StrategyState => ({ ...s, promote: { ...s.promote!, channels: s.promote!.channels.map((c, i) => (i === 0 ? { ...c, why: 'QA: 60% of buyers compare map listings.' } : c)) } });

  it('keeps the sources something cites: uncited ones go first, and "Search again" never takes the plan’s', () => {
    const s = withNumber(qaSavedStrategy(p));
    expect(s.sources.map((x) => x.n)).toEqual([1, 2]);
    const searchOnly = { startedAt: 3, steps: ['research' as const], done: ['research' as const] };
    // 24 new pages, 8 of them cited only by findings past the 16 kept: those go, not the plan's
    const r24 = searched(s, 24, searchOnly);
    const roomy = capStrategy({ ...r24, research: { ...r24.research!, findings: Array.from({ length: 24 }, (_, i) => ({ topic: 'buyers' as const, text: `Finding ${i}.`, basis: 'web' as const, sources: [3 + i] })) } });
    expect(roomy.sources.map((x) => x.n)).toEqual([1, 2, ...Array.from({ length: 16 }, (_, i) => 3 + i)]);
    consistent(roomy);
    // 30 new pages, all cited: still 24 sources, the plan's and the other sections' first, then the newest
    const full = capStrategy(searched(s, 30, searchOnly));
    expect(full.sources.map((x) => x.n)).toEqual([1, 2, ...Array.from({ length: 22 }, (_, i) => 11 + i)]);
    consistent(full);
    for (const x of [full, readStrategy(withStrategy(full))]) {
      expect(x.promote!.positioning).toMatchObject({ basis: 'web', sources: [1] });
      expect(x.promote!.channels.slice(0, 2).map((c) => [c.basis, c.sources])).toEqual([['web', [1]], ['web', [2]]]);
      expect(x.promote!.channels[0].why).toBe('QA: 60% of buyers compare map listings.');
      expect(x.plan!.actions.filter((a) => a.basis === 'web').map((a) => a.sources)).toEqual([[1], [2]]);
      expect(x.content!.formats[0]).toMatchObject({ basis: 'web', sources: [2] });
      expect(x.assets!.seo).toMatchObject({ basis: 'web', sources: [1] });
      // past the room, the new research's findings that lost both their pages are the AI's general knowledge (never citing a page that's gone)
      expect(x.research!.findings.map((f) => f.basis)).toEqual([...Array(4).fill('ai'), ...Array(11).fill('web')]);
      expect(x.research!.findings.slice(0, 4).every((f) => f.sources === undefined)).toBe(true);
    }
    expect(capStrategy(full)).toEqual(full);
  });

  it('while a run writes the sections again, the new research keeps its pages before theirs', () => {
    const s = withNumber(qaSavedStrategy(p));
    // "Update everything": the research is saved, the five sections after it are next
    const all = capStrategy(searched(s, 23, { startedAt: 3, steps: ['research', 'promote', 'content', 'assets', 'outreach', 'plan'], done: ['research'] }));
    expect(all.sources.map((x) => x.n)).toEqual([2, ...Array.from({ length: 23 }, (_, i) => 3 + i)]);
    expect(all.research!.findings.every((f) => f.basis === 'web')).toBe(true);
    // the old sections' citations of the page that went go with it
    expect(all.promote!.channels.slice(0, 2).map((c) => [c.basis, c.sources])).toEqual([['ai', undefined], ['web', [2]]]);
    consistent(all);
    // the same run stopped: what's left is the owner's, kept first again
    const stopped = capStrategy(searched(s, 23, { startedAt: 3, steps: ['research', 'promote', 'content', 'assets', 'outreach', 'plan'], done: ['research'], stoppedAt: 'promote' }));
    expect(stopped.sources.map((x) => x.n)).toEqual([1, 2, ...Array.from({ length: 22 }, (_, i) => 4 + i)]);
    consistent(stopped);
  });

  it('reads a stored strategy with more sources than it keeps without losing the cited ones (an older build’s)', () => {
    const s = withNumber(qaSavedStrategy(p));
    // 30 stored: 1-2 cited by the sections, 3-20 by the research, 21-30 by nothing
    const raw = searched(s, 28, undefined);
    raw.research!.findings = raw.research!.findings.slice(0, 9);
    expect(raw.sources).toHaveLength(30);
    const back = readStrategy(withStrategy(raw));
    expect(back.sources.map((x) => x.n)).toEqual(Array.from({ length: 20 }, (_, i) => 1 + i));
    expect(back.promote!.channels[0]).toMatchObject({ basis: 'web', sources: [1], why: 'QA: 60% of buyers compare map listings.' });
    expect(back.research!.findings).toHaveLength(9);
    consistent(back);
  });
});

describe('sources', () => {
  it('gcSources keeps what something cites and drops the rest', () => {
    const s = qaSavedStrategy(p);
    const extra = { ...s, sources: [...s.sources, { n: 9, url: 'https://example.net/x', title: 'x', domain: 'example.net', via: 'search' as const, at: 1 }] };
    expect(gcSources(extra).sources.map((x) => x.n)).toEqual([1, 2]);
    expect(gcSources(s)).toBe(s);
  });

  it('addSource reuses the number of the same page and never gives out a removed one', () => {
    const s = emptyStrategy();
    expect(addSource(s, { url: 'https://example.com/a?utm_source=x' }, 'search', 1)).toBe(1);
    expect(addSource(s, { url: 'https://www.example.com/a/', title: 'A page' }, 'search', 2)).toBe(1);
    expect(s.sources[0].title).toBe('A page');
    expect(addSource(s, { url: 'https://example.com/b' }, 'search', 3)).toBe(2);
    expect(addSource(s, { url: 'javascript:alert(1)' }, 'search', 3)).toBeNull();
    const gone = { ...s, sources: s.sources.filter((x) => x.n !== 2) };
    expect(addSource(gone, { url: 'https://example.com/c' }, 'manus', 4)).toBe(3);
    expect(gone.sources.at(-1)).toMatchObject({ n: 3, via: 'manus', domain: 'example.com' });
  });

  it('keep every URL the server passes on: the same 400-character limit (server/providers/research.test.mjs)', () => {
    const at = (n: number) => `https://example.com/${'a'.repeat(n - 'https://example.com/'.length)}`;
    expect(C.sources.url).toBe(400);
    const s = emptyStrategy();
    expect(addSource(s, { url: at(400) }, 'search', 1)).toBe(1);
    expect(addSource(s, { url: at(401) }, 'search', 1)).toBeNull();
    expect(readStrategy(withStrategy({ ...s, sources: [...s.sources, { n: 2, url: at(401), title: 't', domain: 'example.com', via: 'search', at: 1 }] })).sources.map((x) => x.url)).toEqual([at(400)]);
  });
});

describe('weeks, progress and what changed', () => {
  it('currentWeek: 1 on the first day, 2 after seven days, 5 after four weeks', () => {
    const startAt = Date.UTC(2026, 10, 1);
    const day = 86_400_000;
    expect(currentWeek({ startAt }, startAt)).toBe(1);
    expect(currentWeek({ startAt }, startAt - day)).toBe(1);
    expect(currentWeek({ startAt }, startAt + 7 * day - 1)).toBe(1);
    expect(currentWeek({ startAt }, startAt + 7 * day)).toBe(2);
    expect(currentWeek({ startAt }, startAt + 28 * day - 1)).toBe(4);
    expect(currentWeek({ startAt }, startAt + 28 * day)).toBe(5);
    expect(currentWeek({ startAt }, startAt + 400 * day)).toBe(5);
  });

  it('strategyFactsHash changes with the owner’s details and the city', () => {
    const s = emptyStrategy();
    const h = strategyFactsHash(p, s.inputs);
    expect(strategyFactsHash(p, { ...s.inputs, goal: '10 new bookings' })).not.toBe(h);
    expect(strategyFactsHash({ ...p, location: { city: 'Dallas', region: 'Texas' } }, s.inputs)).not.toBe(h);
    expect(strategyFactsHash({ ...p }, { ...s.inputs })).toBe(h);
  });

  it('stale: details changed, and sections written before newer research or Manus findings', () => {
    const s = qaSavedStrategy(p);
    expect(stale(p, s)).toEqual({ details: false, beforeResearch: [] });
    expect(stale(p, { ...s, inputs: { ...s.inputs, notes: 'new' } }).details).toBe(true);
    const later = { ...s, research: { ...s.research!, at: s.plan!.at + 10 } };
    expect(stale(p, later).beforeResearch).toEqual(['promote', 'content', 'assets', 'outreach', 'plan']);
    const manus = { ...s, manus: { taskId: 'task_abc123', taskUrl: 'https://manus.im/app/x', state: 'done' as const, requestedAt: 1, doneAt: s.plan!.at + 5 } };
    expect(stale(p, manus).beforeResearch).toContain('plan');
  });

  it('"Set where links go" is done when each link already goes where the strategy says, by default or by the owner’s setting', () => {
    const s = qaSavedStrategy(p);
    const action = { kind: 'link_settings' as const };
    const same = { ...s, promote: { ...s.promote!, links: { instagram: { placement: 'bio' as const, why: 'x', basis: 'builtin' as const }, facebook: { placement: 'post' as const, why: 'y', basis: 'builtin' as const } } } };
    // nothing set: Instagram's link goes in the bio and Facebook's in the post by default, as advised
    expect(p.marketing.linkPlacement).toBeUndefined();
    expect(derivedDone(action, p, same, ctx)).toBe(true);
    // the QA strategy wants Facebook's in the first comment
    expect(s.promote!.links).toMatchObject({ instagram: { placement: 'bio' }, facebook: { placement: 'comment' } });
    expect(derivedDone(action, p, s, ctx)).toBe(false);
    const set = (linkPlacement: Project['marketing']['linkPlacement']): Project => ({ ...p, marketing: { ...p.marketing, linkPlacement } });
    expect(derivedDone(action, set({ facebook: 'comment' }), s, ctx)).toBe(true);
    expect(derivedDone(action, set({ instagram: 'comment' }), same, ctx)).toBe(false);
    // no advice: nothing to see done
    expect(derivedDone(action, p, { ...s, promote: { ...s.promote!, links: {} } }, ctx)).toBe(false);
  });

  it('progress and the Dashboard line', () => {
    const s = qaSavedStrategy(p);
    expect(strategyProgress(p, s, ctx)).toEqual({ done: 0, total: 5 });
    const ticked = { ...s, ticks: { [s.plan!.actions[3].id]: 1 } };
    expect(strategyProgress(p, ticked, ctx)).toEqual({ done: 1, total: 5 });
    expect(strategyStatusLine(withStrategy(ticked), ctx)).toBe('1/5 steps done');
    expect(strategyStatusLine(p, ctx)).toBe('Not started');
    expect(strategyStatusLine(withStrategy({ ...s, plan: undefined }), ctx)).toMatch(/^Researched /);
  });
});
