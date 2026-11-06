// One confirm is one publish request, never retried: the file is saved to the account first, a press while the
// request is on its way sends nothing, and when the server couldn't be reached (or a gateway timed out) the
// next confirm for that post, even from a reopened window, carries the same request id, so the server answers
// with the job it has instead of posting twice.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Post } from '@/lib/types';

const calls = vi.hoisted(() => ({ publish: [] as { clientRequestId: string; mediaIds?: string[] }[], next: [] as (() => unknown)[], uploaded: [] as string[] }));
vi.mock('@/lib/integrations/api', async (orig) => {
  const real = await orig<typeof import('@/lib/integrations/api')>();
  return {
    ...real,
    publishPost: vi.fn(async (req: { clientRequestId: string; content: { mediaIds?: string[] } }) => {
      calls.publish.push({ clientRequestId: req.clientRequestId, mediaIds: req.content.mediaIds });
      const answer = calls.next.shift();
      return answer ? answer() : { job: { id: 'job_1', postId: 'a', platform: 'facebook', state: 'sent', url: 'https://facebook.com/p/1', requestedAt: '2026-11-05T10:00:00.000Z' } };
    }),
    getJob: vi.fn(async () => {
      throw new Error('not followed in these tests');
    }),
  };
});
vi.mock('@/lib/cloud/media', () => ({
  ensureUploaded: vi.fn(async (id: string) => {
    calls.uploaded.push(id);
    return id !== 'missing';
  }),
  ensureJpegVariant: vi.fn(async (id: string) => `${id}-jpg`),
}));

const { IntegrationApiError } = await import('@/lib/integrations/api');
const { useStore } = await import('@/store/useStore');
const { sendPublish, requestIdFor, mayHaveBeenSent } = await import('./PublishConfirm');

const post = (extra: Partial<Post> = {}) =>
  ({ id: 'a', projectId: 'p1', status: 'scheduled', platform: 'facebook', format: 'image', style: 'minimal', postType: 'tip', headline: 'A', visualPrompt: '', caption: 'Fresh bread', hashtags: [], scheduledAt: '2026-11-10T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...extra }) as Post;

beforeEach(() => {
  calls.publish = [];
  calls.next = [];
  calls.uploaded = [];
  useStore.setState({ posts: [post()], projects: [] });
});

describe('one confirm', () => {
  it('sends one request with the window’s id, and puts the job on the post', async () => {
    const r = await sendPublish('a', 'req-1');
    expect(r).toMatchObject({ ok: true });
    expect(calls.publish).toEqual([{ clientRequestId: 'req-1', mediaIds: undefined }]);
    expect(useStore.getState().posts[0]).toMatchObject({ status: 'published', publishedBy: 'api' });
  });

  it('a second press while the first is on its way sends nothing', async () => {
    let release!: () => void;
    calls.next.push(() => new Promise((res) => (release = () => res({ job: { id: 'job_1', postId: 'a', platform: 'facebook', state: 'sent', requestedAt: '2026-11-05T10:00:00.000Z' } }))));
    const first = sendPublish('a', 'req-1');
    await vi.waitFor(() => expect(calls.publish.length).toBe(1));
    expect(await sendPublish('a', 'req-1')).toBeNull();
    release();
    await first;
    expect(calls.publish.length).toBe(1);
  });

  it('a refusal is not retried, and the next window gets a new id', async () => {
    calls.next.push(() => Promise.reject(new IntegrationApiError(409, { error: 'The post changed', code: 'POST_CHANGED' })));
    const r = await sendPublish('a', 'req-1');
    expect(r).toMatchObject({ ok: false, error: { title: 'The post changed' } });
    expect(calls.publish.length).toBe(1);
    expect(requestIdFor('a')).not.toBe('req-1');
  });

  it('no answer from the server: says it may have gone out, and the reopened window reuses the same id', async () => {
    calls.next.push(() => Promise.reject(new IntegrationApiError(0, null)));
    const r = await sendPublish('a', 'req-1');
    expect(r).toMatchObject({ ok: false, error: { uncertain: true } });
    expect(calls.publish.length).toBe(1);
    expect(requestIdFor('a')).toBe('req-1');
    // the owner presses again: the same id, so the server can't post it twice
    await sendPublish('a', requestIdFor('a'));
    expect(calls.publish.map((c) => c.clientRequestId)).toEqual(['req-1', 'req-1']);
    // a definite answer ends it
    expect(requestIdFor('a')).not.toBe('req-1');
  });

  it('a gateway timeout counts as “may have gone out”, never “it wasn’t sent”', async () => {
    const gw = new IntegrationApiError(504, null);
    expect(mayHaveBeenSent(gw)).toBe(true);
    expect(mayHaveBeenSent(new IntegrationApiError(409, { error: 'x', code: 'ALREADY_PUBLISHING' }))).toBe(false);
    calls.next.push(() => Promise.reject(gw));
    const r = await sendPublish('a', 'req-9');
    expect(r).toMatchObject({ ok: false, error: { uncertain: true } });
    expect(r && !r.ok && r.error.title).not.toMatch(/wasn’t sent/);
    expect(requestIdFor('a')).toBe('req-9');
  });

  it('saves the file to the account first; when it can’t, nothing is sent', async () => {
    useStore.setState({ posts: [post({ media: { id: 'm1', kind: 'image', mime: 'image/png' } as Post['media'] })] });
    await sendPublish('a', 'req-1');
    expect(calls.uploaded).toEqual(['m1']);
    expect(calls.publish[0].mediaIds).toEqual(['m1']);
    calls.publish = [];
    useStore.setState({ posts: [post({ media: { id: 'missing', kind: 'image', mime: 'image/png' } as Post['media'] })] });
    const r = await sendPublish('a', 'req-2');
    expect(r).toMatchObject({ ok: false });
    expect(calls.publish).toEqual([]);
  });
});
