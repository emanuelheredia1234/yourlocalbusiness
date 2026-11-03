// Nothing in the app marks a post published by itself any more: only Manus's report, or you.
// Workspaces saved by older versions get their made-up "published" posts back on the calendar.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './useStore';
import { cleanWorkspace, isInventedNotice, purgeInventedData } from './cleanup';
import { defaultSettings, newProject } from './defaults';

const post = (id: string, extra: object = {}) =>
  ({ id, projectId: 'p1', status: 'scheduled', platform: 'facebook', format: 'image', style: 'minimal', postType: 'tip', headline: id, visualPrompt: '', caption: '', hashtags: [], scheduledAt: '2026-11-03T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...extra }) as never;
const ext = (state: string) => ({ via: 'manus', network: 'facebook', mode: 'now', taskId: 't', taskUrl: 'https://manus.im/app/t', state, message: '', page: '', scheduledFor: '', requestedAt: 1, checkedAt: 1 });

beforeEach(() => {
  const project = { ...newProject('product', 'new'), id: 'p1' };
  useStore.setState({ projects: [project], activeProjectId: 'p1', posts: [], notices: [], settings: defaultSettings() });
});

describe('marking posts posted', () => {
  it('marks a post you posted yourself, with its link, and can undo it', () => {
    useStore.setState({ posts: [post('a')] });
    useStore.getState().markPosted('a', { url: 'https://www.instagram.com/p/1/', at: '2026-11-03T09:00:00.000Z' });
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', publishedBy: 'manual', publishedAt: '2026-11-03T09:00:00.000Z', postUrl: 'https://www.instagram.com/p/1/' });
    useStore.getState().unmarkPosted('a');
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'scheduled', publishedBy: undefined, publishedAt: undefined, postUrl: undefined });
  });

  it('puts an unmarked post back where it was, and forgets a failed Manus try once you posted it', () => {
    useStore.setState({ posts: [post('d', { status: 'draft', external: { ...ext('failed') } })] });
    useStore.getState().markPosted('d');
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', statusBeforePosted: 'draft', external: undefined });
    useStore.getState().unmarkPosted('d');
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'draft', statusBeforePosted: undefined });
  });

  it('never unmarks a post Manus reported posted', () => {
    useStore.setState({ posts: [post('m', { status: 'published', publishedBy: 'manus', publishedAt: 'x', external: ext('posted') })] });
    useStore.getState().unmarkPosted('m');
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', publishedBy: 'manus' });
  });

  it('has no way to publish by itself', () => {
    const s = useStore.getState() as unknown as Record<string, unknown>;
    expect(s.publishPost).toBeUndefined();
    expect(s.autoPublishDue).toBeUndefined();
    expect(s.connectAccount).toBeUndefined();
  });
});

describe('cleaning up what older versions made up', () => {
  it('puts pretend-published posts back on the calendar and keeps real ones', () => {
    useStore.setState({
      posts: [
        post('fake', { status: 'published', publishedAt: '2026-11-01T10:00:00.000Z' }),
        post('fbscheduled', { status: 'published', publishedAt: '2026-11-01T10:00:00.000Z', external: { ...ext('scheduled'), mode: 'schedule' } }),
        post('manus', { status: 'published', publishedAt: '2026-11-01T10:00:00.000Z', external: ext('posted') }),
        post('mine', { status: 'published', publishedBy: 'manual', publishedAt: '2026-11-01T10:00:00.000Z' }),
        post('sample', { status: 'published', source: 'sample' }),
        post('draft', { status: 'draft' }),
      ],
    });
    expect(cleanWorkspace()).toBe(true);
    const byId = Object.fromEntries(useStore.getState().posts.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(['draft', 'fake', 'fbscheduled', 'manus', 'mine']);
    expect(byId.fake).toMatchObject({ status: 'scheduled', publishedAt: undefined });
    expect(byId.fbscheduled).toMatchObject({ status: 'scheduled', publishedAt: undefined, external: { state: 'scheduled' } });
    expect(byId.manus).toMatchObject({ status: 'published', publishedBy: 'manus', publishedAt: '2026-11-01T10:00:00.000Z' });
    expect(byId.mine).toMatchObject({ status: 'published', publishedBy: 'manual' });
    expect(byId.draft.status).toBe('draft');
    // running it again changes nothing
    expect(cleanWorkspace()).toBe(false);
  });

  it('keeps the handles of pretend connections in the brand, and drops the rest', () => {
    const settings = { ...defaultSettings(), accounts: { instagram: { connected: true, handle: 'sumari', followers: 2100 }, x: { connected: true, handle: '@sumari', followers: 900 }, facebook: { connected: false, handle: '', followers: 0 }, tiktok: { connected: true, handle: 'other', followers: 5 } } } as never;
    const p1 = useStore.getState().projects[0];
    useStore.setState({ settings, projects: [{ ...p1, brand: { ...p1.brand, socials: { tiktok: '@mine' } } }] });
    cleanWorkspace();
    const s = useStore.getState();
    expect(s.settings.accounts).toBeUndefined();
    expect('accounts' in s.settings).toBe(false);
    expect(s.projects[0].brand.socials).toEqual({ instagram: '@sumari', x: '@sumari', tiktok: '@mine' });
    expect(purgeInventedData(s)).toBeNull();
  });

  it('removes notices about pretend publishing only', () => {
    const n = (title: string) => ({ id: title, title, kind: 'post' as const, createdAt: 1, read: false });
    useStore.setState({ notices: [n('Published to Instagram'), n('3 scheduled posts just went live'), n('Manus posted it on Facebook'), n('Your brand is ready')] });
    cleanWorkspace();
    expect(useStore.getState().notices.map((x) => x.title)).toEqual(['Manus posted it on Facebook', 'Your brand is ready']);
    expect(isInventedNotice({ title: 'Manus scheduled your TikTok post' })).toBe(false);
  });

  it('removes made-up listing numbers, demo settings and their notices', () => {
    const p1 = useStore.getState().projects[0];
    useStore.setState({
      myListings: [{ id: 'l1', projectId: 'p1', title: 'Planner', rating: 4.8, reviews: 212, sales: 5, seller: { name: 'Me', verified: true } } as never, { id: 'l2', projectId: 'p1', title: 'Clean', seller: { name: 'Me' } } as never],
      projects: [{ ...p1, marketing: { ...p1.marketing, subscribers: [{ id: 's1', source: 'sample' }, { id: 's2', source: 'test' }, { id: 's3', source: 'optin', step: 3, opened: [1], clicked: [], converted: true }] as never, plan: { summary: { total: 3, estReach: 24000 } } as never } }],
      ads: [{ id: 'ad1', status: 'active', launchedAt: 5, seed: 9, projections: { spend: 1 }, audiences: [{ id: 'a', name: 'Core', description: 'd', size: '1.2M–2.4M', interests: [] }] } as never],
      notices: ['Simulated sale: Planner', 'Order YLB-123456 confirmed', 'New sale: Planner', 'Inquiry sent to Copper & Crumb', 'Planner is live on the Marketplace', 'Test subscriber added: Me', 'Ad campaign live (simulated): Launch', 'Your brand is ready'].map((title, i) => ({ id: `n${i}`, title, kind: 'info' as const, createdAt: i, read: false })),
      settings: { ...defaultSettings(), marketActivity: true, showSampleListings: true, ai: { serverUrl: '', useBrain: true, simulateLatency: true } } as never,
    });
    cleanWorkspace();
    const s = useStore.getState();
    expect(s.myListings[0]).toEqual({ id: 'l1', projectId: 'p1', title: 'Planner', seller: { name: 'Me' } });
    expect(s.myListings[1]).toEqual({ id: 'l2', projectId: 'p1', title: 'Clean', seller: { name: 'Me' } });
    expect(s.projects[0].marketing.subscribers).toEqual([{ id: 's3', source: 'optin' }]);
    expect(s.ads[0]).toEqual({ id: 'ad1', status: 'draft', audiences: [{ id: 'a', name: 'Core', description: 'd', interests: [] }] });
    expect(s.projects[0].marketing.plan?.summary).toEqual({ total: 3 });
    expect(s.notices.map((n) => n.title)).toEqual(['Your brand is ready']);
    expect('marketActivity' in s.settings || 'showSampleListings' in s.settings).toBe(false);
    expect('simulateLatency' in s.settings.ai).toBe(false);
    expect(cleanWorkspace()).toBe(false);
  });

  it('cleans claims an older version made up once per project, and never a project made now', () => {
    const p1 = useStore.getState().projects[0];
    const old = { ...p1, id: 'old', legacyCleaned: undefined, idea: { title: 'Planner', score: 91, revenueLow: 900, revenueHigh: 4000, signals: ['Steady search interest'] } } as never;
    const fresh = { ...p1, id: 'new', idea: { title: 'Kept as is', score: 77 } } as never;
    useStore.setState({ projects: [old, fresh] });
    cleanWorkspace();
    const [a, b] = useStore.getState().projects as unknown as Record<string, unknown>[];
    expect(a.legacyCleaned).toBe(1);
    expect(a.idea).not.toHaveProperty('score');
    expect(a.idea).not.toHaveProperty('signals');
    // a project made by this version is the owner's own work: untouched
    expect(b.idea).toHaveProperty('score', 77);
    expect(cleanWorkspace()).toBe(false);
  });
});
