// Following posts the app is sending: only jobs still sending are picked up again, with GET (a pure read). An
// unknown job is never checked by itself, and nothing is ever sent again.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Post } from '@/lib/types';

const calls = vi.hoisted(() => ({ get: [] as string[], check: [] as string[], publish: 0, answers: [] as string[] }));
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
}));

const { useStore } = await import('@/store/useStore');
const { sendingJobs, trackJob } = await import('./PublishJobWatcher');

const ext = (state: NonNullable<Post['external']>['state'], jobId: string) => ({ via: 'api' as const, jobId, network: 'facebook' as const, taskId: jobId, taskUrl: '', mode: 'now' as const, state, message: '', page: '', scheduledFor: '', requestedAt: 1, checkedAt: 1 });
const post = (id: string, extra: Partial<Post> = {}) =>
  ({ id, projectId: 'p1', status: 'scheduled', platform: 'facebook', format: 'image', style: 'minimal', postType: 'tip', headline: id, visualPrompt: '', caption: 'c', hashtags: [], scheduledAt: '2026-11-10T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...extra }) as Post;

beforeEach(() => {
  calls.get = [];
  calls.check = [];
  calls.publish = 0;
  calls.answers = [];
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
