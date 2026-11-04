// "Do it": every action kind has a label and lands on a real page and tab (the AI never picks a route), and
// each "done in the app" check is false on a new project and true after the matching change.
import { describe, expect, it } from 'vitest';
import type { AdCampaign, Listing, Post, Project } from './types';
import type { ActionKind, StrategyAction, StrategyState } from './strategyTypes';
import { ROUTES } from './router';
import { tabsOf } from './pageTabs';
import { emptyStrategy, type ActionCtx } from './strategy';
import { ACTION_KINDS } from '@/ai/local/strategyDefaults';
import { newProject } from '@/store/defaults';
import { qaSavedStrategy } from '@/test/strategyQa';
import { ACTION_LABEL, ACTION_TARGET, actionDone, actionTarget, assetTarget, channelTarget, derivedDone } from './strategyActions';

const base = (): Project => ({ ...newProject('business', 'existing'), id: 'p1' });
const noCtx: ActionCtx = { posts: [], ads: [], myListings: [], now: Date.now() };
const act = (kind: ActionKind, extra: Partial<StrategyAction> = {}): StrategyAction => ({ id: 'a_x', week: 1, title: 'Do it', detail: '', kind, basis: 'ai', ...extra });

describe('targets', () => {
  it('every kind has a label, and every page target is a real route and tab', () => {
    for (const k of ACTION_KINDS) expect(ACTION_LABEL[k]).toBeTruthy();
    for (const t of Object.values(ACTION_TARGET)) {
      expect(ROUTES).toContain(t.route);
      if (t.tab) expect(tabsOf(t.route)).toContain(t.tab);
    }
    const p = base();
    const s = emptyStrategy();
    for (const k of ACTION_KINDS) {
      const t = actionTarget(act(k), p, s);
      if (k === 'offline') {
        expect(t).toBeNull();
        continue;
      }
      expect(t).not.toBeNull();
      if (t!.target.kind === 'page') {
        expect(ROUTES).toContain(t!.target.route);
        if (t!.target.tab) expect(tabsOf(t!.target.route)).toContain(t!.target.tab);
      }
      if (t!.target.kind === 'strategy') expect(tabsOf('strategy')).toContain(t!.target.tab);
    }
  });

  it('build_page opens the builder with the page type; write_post the composer with the topic; product files are packages on a business', () => {
    const p = base();
    const s = qaSavedStrategy(p);
    expect(actionTarget(act('build_page'), p, s)!.target).toEqual({ kind: 'seo', pageType: 'booking' });
    expect(actionTarget(act('build_page', { pageType: 'lead' }), p, s)!.target).toEqual({ kind: 'seo', pageType: 'lead' });
    expect(actionTarget(act('write_post', { topic: 'Our sourdough starter' }), p, s)!.target).toEqual({ kind: 'composer', topic: 'Our sourdough starter' });
    expect(actionTarget(act('write_post'), p, s)!.target).toEqual({ kind: 'composer', topic: 'Do it' });
    expect(actionTarget(act('link_settings'), p, s)!.target).toEqual({ kind: 'strategy', tab: 'promote', anchor: 'strategy-links' });
    expect(actionTarget(act('product_file'), p, s)).toMatchObject({ label: 'Set your packages', target: { kind: 'page', route: 'studio', tab: 'structure' } });
    expect(actionTarget(act('product_file'), { ...p, track: 'product' }, s)).toMatchObject({ label: 'Open Product files' });
  });

  it('channels: the app’s own tools only, ads only with a budget', () => {
    const s = emptyStrategy();
    expect(channelTarget({ channelType: 'social', platform: 'instagram', name: 'Instagram' }, s)).toMatchObject({ label: 'See what to post' });
    expect(channelTarget({ channelType: 'social', platform: 'youtube', name: 'YouTube' }, s)).toBeNull();
    expect(channelTarget({ channelType: 'email', name: 'Your list' }, s)).toMatchObject({ label: 'Open the emails' });
    expect(channelTarget({ channelType: 'ads', name: 'Meta ads' }, s)).toEqual({ label: '', hint: 'Set a budget in Your details first.' });
    expect(channelTarget({ channelType: 'ads', name: 'Meta ads' }, { ...s, inputs: { ...s.inputs, budget: '$50 a month' } })).toMatchObject({ label: 'Plan an ad' });
    expect(channelTarget({ channelType: 'marketplace', name: 'The app’s Marketplace' }, s)).toMatchObject({ label: 'Open Listing & publish' });
    expect(channelTarget({ channelType: 'marketplace', name: 'Etsy marketplace' }, s)).toBeNull();
    expect(channelTarget({ channelType: 'directory', name: 'Yelp' }, s)).toBeNull();
  });
});

describe('done in the app', () => {
  const post = (x: Partial<Post>): Post => ({ id: 'x', projectId: 'p1', status: 'draft', source: 'composer', format: 'image', ...x }) as Post;
  const cases: [ActionKind, (p: Project, s: StrategyState, c: ActionCtx) => [Project, StrategyState, ActionCtx], Partial<StrategyAction>?][] = [
    ['build_page', (p, s, c) => [{ ...p, marketing: { ...p.marketing, salesPage: {} as never, pageType: 'booking' } }, s, c], { pageType: 'booking' }],
    ['publish_page', (p, s, c) => [{ ...p, marketing: { ...p.marketing, seoPublished: { url: 'https://x.example/qa' } as never } }, s, c]],
    ['campaign_setup', (p, s, c) => [p, { ...s, applied: { campaign: { at: 1, from: 1 } } }, c]],
    ['plan_30', (p, s, c) => [{ ...p, marketing: { ...p.marketing, plan: {} as never } }, s, c]],
    ['batch_7', (p, s, c) => [p, s, { ...c, posts: [post({ source: 'batch' })] }]],
    ['calendar', (p, s, c) => [p, s, { ...c, posts: [post({ status: 'scheduled' })] }]],
    ['lead_magnet', (p, s, c) => [{ ...p, marketing: { ...p.marketing, leadMagnet: {} as never } }, s, c]],
    ['welcome_emails', (p, s, c) => [{ ...p, marketing: { ...p.marketing, emails: Array.from({ length: 5 }, () => ({}) as never) } }, s, c]],
    ['code_asset', (p, s, c) => [{ ...p, studio: { ...p.studio, codeAssets: [{ kind: 'quiz' } as never] } }, s, c], { codeKind: 'quiz' }],
    ['listing', (p, s, c) => [p, s, { ...c, myListings: [{ projectId: 'p1' } as Listing] }]],
    ['listing_images', (p, s, c) => [{ ...p, studio: { ...p.studio, listing: { ...p.studio.listing, coverImageId: 'img1' } } }, s, c]],
    ['packages', (p, s, c) => [{ ...p, studio: { ...p.studio, packages: [{} as never] } }, s, c]],
    ['socials', (p, s, c) => [{ ...p, brand: { ...p.brand, socials: { instagram: '@qa' } } }, s, c]],
    ['website', (p, s, c) => [{ ...p, brand: { ...p.brand, websiteUrl: 'https://qa.example' } }, s, c]],
    ['ads', (p, s, c) => [p, s, { ...c, ads: [{ projectId: 'p1' } as AdCampaign] }]],
  ];
  for (const [kind, change, extra] of cases) {
    it(kind, () => {
      const p = base();
      const s = emptyStrategy();
      expect(derivedDone(act(kind, extra), p, s, noCtx)).toBe(false);
      const [p2, s2, c2] = change(p, s, noCtx);
      expect(derivedDone(act(kind, extra), p2, s2, c2)).toBe(true);
      expect(actionDone(act(kind, extra), p2, s2, c2)).toEqual({ done: true, by: 'app' });
    });
  }

  it('link_settings: when every network the strategy names is set that way', () => {
    const p = base();
    const s = qaSavedStrategy(p);
    expect(derivedDone(act('link_settings'), p, s, noCtx)).toBe(false);
    expect(derivedDone(act('link_settings'), { ...p, marketing: { ...p.marketing, linkPlacement: { instagram: 'bio', facebook: 'comment' } } }, s, noCtx)).toBe(true);
  });

  it('a code asset of another kind doesn’t count; a product’s file does', () => {
    const p = { ...base(), studio: { ...base().studio, codeAssets: [{ kind: 'faq' } as never] } };
    expect(derivedDone(act('code_asset', { codeKind: 'quiz' }), p, emptyStrategy(), noCtx)).toBe(false);
    const prod: Project = { ...newProject('product', 'new'), id: 'p1' };
    expect(derivedDone(act('product_file'), prod, emptyStrategy(), noCtx)).toBe(false);
    expect(derivedDone(act('product_file'), { ...prod, studio: { ...prod.studio, productFiles: [{} as never] } }, emptyStrategy(), noCtx)).toBe(true);
  });

  it('kinds the app can’t see are the owner’s ticks; a derived done wins over a tick', () => {
    const p = base();
    for (const kind of ['write_post', 'outreach', 'brain', 'offline'] as const) {
      expect(actionDone(act(kind), p, emptyStrategy(), noCtx)).toEqual({ done: false, by: null });
      expect(actionDone(act(kind), p, { ...emptyStrategy(), ticks: { a_x: 1 } }, noCtx)).toEqual({ done: true, by: 'owner' });
    }
    const site = { ...p, brand: { ...p.brand, websiteUrl: 'https://qa.example' } };
    expect(actionDone(act('website'), site, { ...emptyStrategy(), ticks: { a_x: 1 } }, noCtx)).toEqual({ done: true, by: 'app' });
  });

  it('assets: their buttons, and a video counts once a video post exists', () => {
    const p = base();
    const s = emptyStrategy();
    expect(assetTarget({ kind: 'other', title: 'x' }, p, s, noCtx)).toEqual({ button: null, done: false });
    expect(assetTarget({ kind: 'video', title: 'x' }, p, s, noCtx)).toMatchObject({ button: { label: 'Make a video post', target: { kind: 'page', route: 'marketing-social', tab: 'create' } }, done: false });
    expect(assetTarget({ kind: 'video', title: 'x' }, p, s, { ...noCtx, posts: [post({ format: 'video' })] }).done).toBe(true);
    expect(assetTarget({ kind: 'code', codeKind: 'calculator', title: 'x' }, p, s, noCtx).button).toMatchObject({ label: 'Open Code & assets' });
  });
});
