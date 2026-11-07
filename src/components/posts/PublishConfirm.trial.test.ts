// Trial Reels in the confirm (P4b §A4): the request carries the saved Reel mode and "Post as a trial anyway"; a
// refusal is one attempt, never retried, and offers "Post as a regular Reel" (a new confirmation, never automatic).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Post } from '@/lib/types';
import type { PublishRequest } from '@/lib/integrations/types';

const calls = vi.hoisted(() => ({ publish: [] as PublishRequest[], next: [] as (() => unknown)[] }));
vi.mock('@/lib/integrations/api', async (orig) => {
  const real = await orig<typeof import('@/lib/integrations/api')>();
  return {
    ...real,
    publishPost: vi.fn(async (req: PublishRequest) => {
      calls.publish.push(req);
      const answer = calls.next.shift();
      return answer ? answer() : { job: { id: 'job_1', postId: 'a', platform: 'instagram', state: 'sent', requestedAt: '2026-11-05T10:00:00.000Z' } };
    }),
    getJob: vi.fn(async () => {
      throw new Error('not followed');
    }),
  };
});
vi.mock('@/lib/cloud/media', () => ({ ensureUploaded: vi.fn(async () => true), ensureJpegVariant: vi.fn(async (id: string) => id) }));

const { IntegrationApiError } = await import('@/lib/integrations/api');
const { useStore } = await import('@/store/useStore');
const { sendPublish } = await import('./PublishConfirm');

const post = (extra: Partial<Post> = {}) =>
  ({ id: 'a', projectId: 'p1', status: 'scheduled', platform: 'instagram', format: 'video', style: 'minimal', postType: 'tip', headline: 'A', visualPrompt: '', caption: 'Fresh bread', hashtags: [], scheduledAt: '2026-11-10T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, media: { id: 'm1', kind: 'video', mime: 'video/mp4' }, instagram: { shareMode: 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS' }, ...extra }) as Post;

beforeEach(() => {
  calls.publish = [];
  calls.next = [];
  useStore.setState({ posts: [post()], projects: [] });
});

describe('Trial Reels in the confirm', () => {
  it('sends the saved Reel mode, and "Post as a trial anyway" only when ticked', async () => {
    await sendPublish('a', 'req-1');
    expect(calls.publish[0].content.shareMode).toBe('TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS');
    expect(calls.publish[0].trialUnknownOk).toBeUndefined();
    useStore.setState({ posts: [post({ status: 'scheduled', external: undefined })] });
    await sendPublish('a', 'req-2', () => {}, { trialUnknownOk: true });
    expect(calls.publish[1].trialUnknownOk).toBe(true);
  });

  it('not eligible: one attempt, nothing retried, and "Post as a regular Reel" is offered', async () => {
    calls.next.push(() => Promise.reject(new IntegrationApiError(409, { error: 'Trial Reels need 1,000+ followers (this account has 640).', code: 'TRIAL_REEL_NOT_ELIGIBLE', reason: 'followers', followers: 640 })));
    const r = await sendPublish('a', 'req-1');
    expect(r).toMatchObject({ ok: false, error: { title: 'It can’t go out as a Trial Reel', regularReel: true } });
    expect(calls.publish).toHaveLength(1);
  });

  it('followers unreadable: asks for "Post as a trial anyway"', async () => {
    calls.next.push(() => Promise.reject(new IntegrationApiError(409, { error: 'We couldn’t check your followers.', code: 'TRIAL_REEL_NOT_ELIGIBLE', reason: 'unreadable' })));
    const r = await sendPublish('a', 'req-1');
    expect(r).toMatchObject({ ok: false, error: { askAnyway: true } });
    expect(r && !r.ok && r.error.regularReel).toBeFalsy();
  });

  it('the monthly A/B test limit and the 12-hour gap have their own words', async () => {
    calls.next.push(() => Promise.reject(new IntegrationApiError(402, { error: 'You’ve used your 2 A/B tests this month.', code: 'EXPERIMENT_LIMIT' })));
    expect(await sendPublish('a', 'req-1')).toMatchObject({ ok: false, error: { title: 'This month’s A/B tests are used' } });
    calls.next.push(() => Promise.reject(new IntegrationApiError(409, { error: 'Wait 4 more hours.', code: 'TOO_SOON_AFTER_VARIANT' })));
    expect(await sendPublish('a', 'req-2')).toMatchObject({ ok: false, error: { title: 'Too soon after the last version', body: 'Wait 4 more hours.' } });
  });
});
