// Nothing in the app marks a post published by itself: only the server's publish job after you confirmed
// (applyPublishJob), an older Manus report, or you. Workspaces saved by older versions get their made-up
// "published" posts back on the calendar.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './useStore';
import { cleanWorkspace, isInventedNotice, purgeInventedData } from './cleanup';
import { defaultSettings, newProject } from './defaults';

const post = (id: string, extra: object = {}) =>
  ({ id, projectId: 'p1', status: 'scheduled', platform: 'facebook', format: 'image', style: 'minimal', postType: 'tip', headline: id, visualPrompt: '', caption: '', hashtags: [], scheduledAt: '2026-11-03T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...extra }) as never;
// an older post sent with Manus (read-only now)
const ext = (state: string) => ({ via: 'manus', network: 'facebook', mode: 'now', taskId: 't', taskUrl: 'https://manus.im/app/t', state, message: '', page: '', scheduledFor: '', requestedAt: 1, checkedAt: 1 });
// a post the app sent through the connected account
const apiExt = (state: string, jobId = 'job_1') => ({ via: 'api', jobId, network: 'facebook', mode: 'now', taskId: jobId, taskUrl: '', state, message: '', page: '', scheduledFor: '', requestedAt: 1, checkedAt: 1 });
const job = (state: string, extra: object = {}) => ({ id: 'job_1', postId: 'a', platform: 'facebook', state, requestedAt: '2026-11-05T10:00:00.000Z', ...extra }) as never;

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

describe('what the server says about a post the app sent', () => {
  it('follows the job: sending, then posted by the app with its link', () => {
    useStore.setState({ posts: [post('a')] });
    useStore.getState().applyPublishJob('a', job('sending'));
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'scheduled', external: { via: 'api', jobId: 'job_1', state: 'working', network: 'facebook' } });
    useStore.getState().applyPublishJob('a', job('sent', { url: 'https://facebook.com/p/1', finishedAt: '2026-11-05T10:00:05.000Z' }));
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', publishedBy: 'api', publishedAt: '2026-11-05T10:00:05.000Z', postUrl: 'https://facebook.com/p/1', statusBeforePosted: 'scheduled', external: { via: 'api', state: 'posted', url: 'https://facebook.com/p/1' } });
    // a post the app posted isn't the owner's mark to undo
    useStore.getState().unmarkPosted('a');
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', publishedBy: 'api' });
  });

  it('keeps failed and unknown apart, with the server’s plain reason', () => {
    useStore.setState({ posts: [post('a')] });
    useStore.getState().applyPublishJob('a', job('failed', { errorCode: 'MEDIA_UNSUPPORTED', errorMessage: 'Facebook refused the image format' }));
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'scheduled', external: { state: 'failed', message: 'Facebook refused the image format' } });
    useStore.getState().applyPublishJob('a', job('unknown'));
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'scheduled', external: { state: 'unknown' } });
  });

  it('a TikTok post that landed in drafts: sent, marked as drafts (not public), never sent again', () => {
    useStore.setState({ posts: [post('a', { platform: 'tiktok' })] });
    useStore.getState().applyPublishJob('a', job('sent', { note: 'SENT_TO_DRAFTS', noteMessage: 'Sent to your TikTok drafts. Open TikTok to publish it.' }));
    const p = useStore.getState().posts[0];
    expect(p).toMatchObject({ status: 'published', publishedBy: 'api', external: { via: 'api', state: 'posted', drafts: true } });
    expect(p.postUrl).toBeUndefined();
    // a normal sent job has no drafts flag
    useStore.setState({ posts: [post('b')] });
    useStore.getState().applyPublishJob('b', job('sent', { url: 'https://facebook.com/p/1', postId: 'b' }));
    expect(useStore.getState().posts[0].external).not.toHaveProperty('drafts');
  });

  it('ignores another post’s job and an older job', () => {
    useStore.setState({ posts: [post('a', { external: { ...apiExt('working', 'job_new'), requestedAt: Date.parse('2026-11-05T11:00:00.000Z') } })] });
    useStore.getState().applyPublishJob('a', job('failed'));
    expect(useStore.getState().posts[0].external).toMatchObject({ jobId: 'job_new', state: 'working' });
    useStore.getState().applyPublishJob('a', { ...(job('sent') as object), postId: 'b' } as never);
    expect(useStore.getState().posts[0].status).toBe('scheduled');
  });

  it('a post you marked yourself while it was unknown stays yours when the check finds it', () => {
    useStore.setState({ posts: [post('a', { external: apiExt('unknown') })] });
    useStore.getState().markPosted('a', { url: 'https://facebook.com/mine' });
    useStore.getState().applyPublishJob('a', job('sent', { url: 'https://facebook.com/p/1' }));
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', publishedBy: 'manual', postUrl: 'https://facebook.com/mine', external: { state: 'posted' } });
  });
});

describe('cleaning up what older versions made up', () => {
  it('puts pretend-published posts back on the calendar and keeps real ones', () => {
    useStore.setState({
      posts: [
        post('fake', { status: 'published', publishedAt: '2026-11-01T10:00:00.000Z' }),
        post('fbscheduled', { status: 'published', publishedAt: '2026-11-01T10:00:00.000Z', external: { ...ext('scheduled'), mode: 'schedule' } }),
        post('manus', { status: 'published', publishedAt: '2026-11-01T10:00:00.000Z', external: ext('posted') }),
        post('app', { status: 'published', publishedBy: 'api', publishedAt: '2026-11-01T10:00:00.000Z', external: apiExt('posted') }),
        post('mine', { status: 'published', publishedBy: 'manual', publishedAt: '2026-11-01T10:00:00.000Z' }),
        post('sample', { status: 'published', source: 'sample' }),
        post('draft', { status: 'draft' }),
      ],
    });
    expect(cleanWorkspace()).toBe(true);
    const byId = Object.fromEntries(useStore.getState().posts.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(['app', 'draft', 'fake', 'fbscheduled', 'manus', 'mine']);
    expect(byId.app).toMatchObject({ status: 'published', publishedBy: 'api' });
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
