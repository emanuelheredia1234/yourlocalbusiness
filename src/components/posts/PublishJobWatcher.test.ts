// Following posts the app is sending: only jobs still sending are picked up again, with GET (a pure read). An
// unknown job is never checked by itself, and nothing is ever sent again. A business's job list (a read) tells a
// post that an earlier failed try was posted after all, so it may be on the network twice: said once.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Post } from '@/lib/types';

const calls = vi.hoisted(() => ({ get: [] as string[], check: [] as string[], publish: 0, answers: [] as string[], list: [] as unknown[], lists: 0 }));
const toasts = vi.hoisted(() => [] as { title: string }[]);
vi.mock('@/store/ui', async (orig) => ({ ...(await orig<typeof import('@/store/ui')>()), toast: (t: { title: string }) => void toasts.push(t) }));
vi.mock('@/lib/integrations/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/api')>()),
  getJob: vi.fn(async (id: string) => {
    calls.get.push(id);
    const state = calls.answers.shift() ?? 'sending';
    return { job: { id, postId: id.replace('job_', ''), platform: 'facebook', state, requestedAt: '2026-11-05T10:00:00.000Z', ...(state === 'sent' ? { url: 'https://facebook.com/p/9', finishedAt: '2026-11-05T10:00:09.000Z' } : {}) } };
  }),
  checkJob: vi.fn(async (id: string) => {
    calls.check.push(id);
    throw new Error('never called by the watcher');
  }),
  publishPost: vi.fn(async () => {
    calls.publish++;
    throw new Error('never called by the watcher');
  }),
  listJobs: vi.fn(async () => {
    calls.lists++;
    return { jobs: calls.list };
  }),
}));

const { useStore } = await import('@/store/useStore');
const { sendingJobs, syncPostedTwice, trackJob } = await import('./PublishJobWatcher');

const ext = (state: NonNullable<Post['external']>['state'], jobId: string) => ({ via: 'api' as const, jobId, network: 'facebook' as const, taskId: jobId, taskUrl: '', mode: 'now' as const, state, message: '', page: '', scheduledFor: '', requestedAt: 1, checkedAt: 1 });
const post = (id: string, extra: Partial<Post> = {}) =>
  ({ id, projectId: 'p1', status: 'scheduled', platform: 'facebook', format: 'image', style: 'minimal', postType: 'tip', headline: id, visualPrompt: '', caption: 'c', hashtags: [], scheduledAt: '2026-11-10T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...extra }) as Post;

beforeEach(() => {
  calls.get = [];
  calls.check = [];
  calls.publish = 0;
  calls.answers = [];
  calls.list = [];
  calls.lists = 0;
  toasts.length = 0;
  useStore.setState({ posts: [] });
});

describe('the job watcher', () => {
  it('picks up only jobs still sending (never unknown, failed, posted or older Manus posts)', () => {
    const posts = [post('a', { external: ext('working', 'job_a') }), post('b', { external: ext('unknown', 'job_b') }), post('c', { external: ext('failed', 'job_c') }), post('d', { external: { ...ext('working', 'x'), via: 'manus', jobId: undefined } }), post('e')];
    expect(sendingJobs(posts)).toEqual([{ postId: 'a', jobId: 'job_a' }]);
  });

  it('reads the job until it’s done and puts it on the post: GET only, nothing sent or checked', async () => {
    useStore.setState({ posts: [post('a', { external: ext('working', 'job_a') })] });
    calls.answers = ['sending', 'sent'];
    await trackJob('a', 'job_a', { intervalMs: 1, maxMs: 1000 });
    expect(calls.get).toEqual(['job_a', 'job_a']);
    expect(calls.check).toEqual([]);
    expect(calls.publish).toBe(0);
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', publishedBy: 'api', postUrl: 'https://facebook.com/p/9', external: { state: 'posted' } });
  });

  it('an unknown answer stays unknown: no check, no resend', async () => {
    useStore.setState({ posts: [post('a', { external: ext('working', 'job_a') })] });
    calls.answers = ['unknown'];
    await trackJob('a', 'job_a', { intervalMs: 1, maxMs: 1000 });
    expect(calls.check).toEqual([]);
    expect(calls.publish).toBe(0);
    expect(useStore.getState().posts[0].external).toMatchObject({ state: 'unknown' });
  });

  it('follows one job once, however many times it’s asked', async () => {
    useStore.setState({ posts: [post('a', { external: ext('working', 'job_a') })] });
    calls.answers = ['sending', 'sent'];
    await Promise.all([trackJob('a', 'job_a', { intervalMs: 1, maxMs: 1000 }), trackJob('a', 'job_a', { intervalMs: 1, maxMs: 1000 })]);
    expect(calls.get).toEqual(['job_a', 'job_a']);
  });
});

describe('a job still sending after the first two minutes', () => {
  it('is read again, slower, until the server says how it ended: GET only', async () => {
    useStore.setState({ posts: [post('a', { external: ext('working', 'job_a') })] });
    // the first follow gives up while it's still sending; the slow one sees the server's "unknown"
    calls.answers = ['sending', 'sending', 'unknown'];
    await trackJob('a', 'job_a', { intervalMs: 1, maxMs: 0, slow: { intervalMs: 1, maxMs: 1000 } });
    expect(calls.get.length).toBe(3);
    expect(calls.check).toEqual([]);
    expect(calls.publish).toBe(0);
    expect(useStore.getState().posts[0].external).toMatchObject({ state: 'unknown' });
  });
});

describe('a failed try the network posted after all (its post may be there twice)', () => {
  const OLD = '2026-11-05T10:00:00.000Z';
  const NEW = '2026-11-05T11:00:00.000Z';
  const job = (id: string, state: string, note: string, requestedAt: string, url: string) => ({ id, postId: 'p9', platform: 'facebook', state, note, noteMessage: 'may now appear twice', requestedAt, url, finishedAt: requestedAt });

  it('the business’s job list puts it on the post, which says so once; nothing is sent or checked', async () => {
    useStore.setState({ posts: [post('p9', { status: 'published', publishedBy: 'api', postUrl: 'https://facebook.com/p/2', external: { ...ext('posted', 'job_new'), requestedAt: Date.parse(NEW) } })] });
    // newest first, as the server lists them
    calls.list = [job('job_new', 'sent', 'MAY_APPEAR_TWICE', NEW, 'https://facebook.com/p/2'), job('job_old', 'sent', 'POSTED_AFTER_ALL', OLD, 'https://facebook.com/p/1')];
    await syncPostedTwice('p1');
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', external: { jobId: 'job_new', state: 'posted', twice: true } });
    expect(toasts.map((t) => t.title)).toEqual(['This post may be on Facebook twice']);
    await syncPostedTwice('p1');
    expect(toasts).toHaveLength(1);
    expect(calls.lists).toBe(2);
    expect(calls.check).toEqual([]);
    expect(calls.publish).toBe(0);
  });

  it('an older try posted after all over a newer one that failed: the post reads posted (it went out)', async () => {
    useStore.setState({ posts: [post('p9', { external: { ...ext('failed', 'job_new'), requestedAt: Date.parse(NEW) } })] });
    calls.list = [job('job_old', 'sent', 'POSTED_AFTER_ALL', OLD, 'https://facebook.com/p/1')];
    await syncPostedTwice('p1');
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', publishedBy: 'api', postUrl: 'https://facebook.com/p/1', external: { jobId: 'job_old', state: 'posted', twice: true } });
  });

  it('other jobs in the list change nothing, and a list that can’t be read is left alone', async () => {
    useStore.setState({ posts: [post('p9', { external: { ...ext('failed', 'job_new'), requestedAt: Date.parse(NEW) } })] });
    calls.list = [{ id: 'job_x', postId: 'p9', platform: 'facebook', state: 'sent', requestedAt: OLD }];
    await syncPostedTwice('p1');
    expect(useStore.getState().posts[0].external).toMatchObject({ jobId: 'job_new', state: 'failed' });
    expect(toasts).toEqual([]);
  });
});
