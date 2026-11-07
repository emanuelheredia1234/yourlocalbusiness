import { describe, expect, it } from 'vitest';
import { canTrialReel, eligibilityView, isTrialMode, shareModeOf, withShareMode } from './trialReels';
import { buildPublishRequest } from './posting';
import type { Post } from './types';

const post = (o: Partial<Post> = {}): Post =>
  ({ id: 'post_1', projectId: 'p1', status: 'draft', platform: 'instagram', format: 'video', style: 'clean', postType: 'tip', headline: 'H', visualPrompt: '', caption: 'Hi', hashtags: [], scheduledAt: '', watermark: false, source: 'composer', createdAt: 0, updatedAt: 0, seed: 1, media: { id: 'm1', kind: 'video', mime: 'video/mp4' }, ...o }) as Post;

describe('Trial Reels in the app', () => {
  it('only Instagram videos get the choice', () => {
    expect(canTrialReel(post())).toBe(true);
    expect(canTrialReel(post({ media: { id: 'm', kind: 'image', mime: 'image/png' } as Post['media'] }))).toBe(false);
    expect(canTrialReel(post({ platform: 'tiktok' }))).toBe(false);
    expect(canTrialReel(post({ media: undefined, format: 'video' }))).toBe(true);
  });

  it('the Reel mode is saved on the post, CUSTOM drops it', () => {
    const t = withShareMode(post(), 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS');
    expect(shareModeOf(t)).toBe('TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS');
    expect(isTrialMode(shareModeOf(t))).toBe(true);
    expect(withShareMode(t, 'CUSTOM').instagram).toBeUndefined();
    expect(shareModeOf(post({ instagram: { shareMode: 'NOPE' as never } }))).toBe('CUSTOM');
  });

  it('the publish request carries shareMode on Instagram videos, and trialUnknownOk only for a trial', () => {
    const t = withShareMode(post(), 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED');
    const req = buildPublishRequest(t, undefined, { clientRequestId: 'r1', trialUnknownOk: true });
    expect(req.content.shareMode).toBe('TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED');
    expect(req.trialUnknownOk).toBe(true);
    const reg = buildPublishRequest(post(), undefined, { clientRequestId: 'r1', trialUnknownOk: true });
    expect(reg.content.shareMode).toBe('CUSTOM');
    expect(reg.trialUnknownOk).toBeUndefined();
    const fb = buildPublishRequest(post({ platform: 'facebook' }), undefined, { clientRequestId: 'r1' });
    expect('shareMode' in fb.content).toBe(false);
  });

  it('eligibility lines', () => {
    expect(eligibilityView({ eligible: true, followers: 2340 })).toMatchObject({ line: 'Trial Reels: available (2,340 followers)', disabled: false });
    expect(eligibilityView({ eligible: false, reason: 'followers', followers: 640 })).toMatchObject({ line: 'Trial Reels need 1,000+ followers (you have 640)', disabled: true });
    expect(eligibilityView({ eligible: 'unknown', reason: 'unreadable' })).toMatchObject({ askAnyway: true, disabled: false });
    expect(eligibilityView({ eligible: false, reason: 'not_connected' }).line).toBe('Connect Instagram to post Trial Reels');
  });
});

describe('the campaign setup switch', () => {
  it('"Post Instagram videos as Trial Reels" sets only the batch’s new Instagram videos (off by default)', async () => {
    const { applyWeekBatch } = await import('@/ai/socialPlan');
    const { useStore } = await import('@/store/useStore');
    const { newProject } = await import('@/store/defaults');
    const p = { ...newProject('business', 'existing'), id: 'p1' };
    useStore.setState({ projects: [p], activeProjectId: 'p1', posts: [] });
    applyWeekBatch([post({ id: 'v1', batchId: 'b1' }), post({ id: 'i1', format: 'image', media: undefined, batchId: 'b1' })], 'p1');
    expect(useStore.getState().posts.every((x) => !x.instagram)).toBe(true);
    useStore.setState({ projects: [{ ...p, marketing: { ...p.marketing, campaign: { ...p.marketing.campaign, instagramTrialReels: true } } }], posts: [] });
    applyWeekBatch([post({ id: 'v1', batchId: 'b1' }), post({ id: 'i1', format: 'image', media: undefined, batchId: 'b1' }), post({ id: 'f1', platform: 'facebook', batchId: 'b1' })], 'p1');
    const by = Object.fromEntries(useStore.getState().posts.map((x) => [x.id, x.instagram?.shareMode]));
    expect(by).toEqual({ v1: 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS', i1: undefined, f1: undefined });
  });
});
