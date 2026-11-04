// The built-in engine for Strategy: which page to build first, where links go, and that its free starter
// notes never carry claims, predictions, made-up numbers or links, and are always labelled built-in.
import { describe, expect, it } from 'vitest';
import type { Project } from '@/lib/types';
import { CLAIMS, NUMBER_CLAIM, PREDICTION, URL_RE } from '@/lib/strategyNormalize';
import { emptyStrategy, STRATEGY_STEPS } from '@/lib/strategy';
import { stepInput } from '../strategyTasks';
import { qaProductProject, qaProject } from '@/test/strategyQa';
import { defaultLinkPlacement, localAssets, localContent, localOutreach, localPlan, localPromote, localResearch, recommendPageType, starterChecklist } from './strategy';

const biz = (businessType: string, niche = businessType): Project => ({ ...qaProject(), businessType, niche, category: '' });
const product = (price: number, payment = ''): Project => {
  const p = qaProductProject();
  return { ...p, studio: { ...p.studio, price }, marketing: { ...p.marketing, pageLinks: payment ? { payment } : undefined } };
};
const rt = { web: false, posts: [], ads: [], myListings: [] };
const GEN = { research: localResearch, promote: localPromote, content: localContent, assets: localAssets, outreach: localOutreach, plan: localPlan } as const;

/** Every point's basis in a step's output. */
function bases(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => bases(x, out));
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.basis === 'string') out.push(o.basis);
    Object.values(o).forEach((x) => bases(x, out));
  }
  return out;
}

describe('recommendPageType', () => {
  it('follows the track, the price and how people book or buy', () => {
    expect(recommendPageType(product(29, 'https://buy.stripe.com/abc'))).toMatchObject({ pageType: 'checkout', secondType: 'landing', basis: 'builtin' });
    expect(recommendPageType(product(29))).toMatchObject({ pageType: 'landing', secondType: 'checkout' });
    expect(recommendPageType(product(0))).toMatchObject({ pageType: 'lead', secondType: 'landing' });
    expect(recommendPageType(biz('House cleaning'))).toMatchObject({ pageType: 'booking', secondType: 'lead' });
    expect(recommendPageType(biz('Bakery'))).toMatchObject({ pageType: 'showcase', secondType: 'checkout' });
    expect(recommendPageType(biz('Landscaping'))).toMatchObject({ pageType: 'lead', secondType: 'showcase' });
    expect(recommendPageType(biz('House cleaning')).why).toBe('People can pick a time and book with your own booking link, straight from a post.');
  });
});

describe('defaultLinkPlacement', () => {
  it('bio where captions can’t link, the post where they can', () => {
    expect(defaultLinkPlacement('instagram')).toMatchObject({ placement: 'bio', basis: 'builtin' });
    expect(defaultLinkPlacement('tiktok')).toMatchObject({ placement: 'bio' });
    expect(defaultLinkPlacement('facebook')).toMatchObject({ placement: 'post' });
    expect(defaultLinkPlacement('linkedin')).toMatchObject({ placement: 'post' });
    expect(defaultLinkPlacement('x')).toMatchObject({ placement: 'post', why: 'X shows links in posts as clickable links; keep the post short.' });
  });
});

describe('the starter notes', () => {
  for (const [name, p] of [
    ['a business that books', biz('House cleaning')],
    ['a bakery', qaProject()],
    ['a product with a price', product(29)],
    ['a free product', product(0)],
  ] as [string, Project][]) {
    it(`${name}: no claims, predictions, unsourced numbers or links, every point built-in`, () => {
      for (const step of STRATEGY_STEPS) {
        const out = GEN[step](p, stepInput(step, p, emptyStrategy(), rt));
        const text = JSON.stringify(out);
        expect(text).not.toMatch(URL_RE);
        expect(text).not.toMatch(CLAIMS);
        expect(text).not.toMatch(PREDICTION);
        expect(text).not.toMatch(NUMBER_CLAIM);
        expect(bases(out).every((b) => b === 'builtin')).toBe(true);
      }
    });
  }

  it('never suggests testimonials or a countdown, and no booking widget for a product', () => {
    for (const p of [biz('House cleaning'), qaProject(), product(29), product(0)]) {
      const kinds = [...localAssets(p, stepInput('assets', p, emptyStrategy(), rt)).assets.map((a) => a.codeKind), ...localPlan(p, stepInput('plan', p, emptyStrategy(), rt)).actions.map((a) => a.codeKind)].filter(Boolean);
      expect(kinds).not.toContain('testimonials');
      expect(kinds).not.toContain('countdown');
      if (p.track === 'product') expect(kinds).not.toContain('booking');
    }
    expect(localAssets(biz('House cleaning'), stepInput('assets', biz('House cleaning'), emptyStrategy(), rt)).assets.find((a) => a.kind === 'code')?.codeKind).toBe('booking');
  });

  it('research says it isn’t research, and gives things to check yourself', () => {
    const r = localResearch(qaProject(), stepInput('research', qaProject(), emptyStrategy(), rt));
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatch(/^No research yet: these are things to check yourself/);
    expect(r.checks[0]).toBe('Search “café & bakery near Austin” on Google and Maps. Note who shows up first and what their profiles show: photos, booking links, how they reply to people.');
  });

  it('skips what the project already has', () => {
    const p = qaProject();
    p.marketing.leadMagnet = { type: 'checklist', title: 'x' } as never;
    p.studio.packages = [{ id: 'k', name: 'Box', price: 20, description: '', includes: [] } as never];
    const plan = localPlan(p, stepInput('plan', p, emptyStrategy(), rt));
    expect(plan.actions.map((a) => a.kind)).not.toContain('lead_magnet');
    expect(plan.actions.map((a) => a.kind)).not.toContain('packages');
    expect(localAssets(p, stepInput('assets', p, emptyStrategy(), rt)).assets.map((a) => a.kind)).not.toContain('lead_magnet');
  });

  it('the starter checklist is the built-in plan’s first two weeks, with the page to build first', () => {
    const p = biz('House cleaning');
    const list = starterChecklist(p, stepInput('plan', p, emptyStrategy(), rt).has);
    expect(list.length).toBeGreaterThan(3);
    expect(list.every((a) => a.week <= 2 && a.basis === 'builtin')).toBe(true);
    expect(list[0]).toMatchObject({ kind: 'build_page', pageType: 'booking', title: 'Build your booking page' });
  });
});
