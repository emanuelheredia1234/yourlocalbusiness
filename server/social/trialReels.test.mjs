// Instagram Trial Reels (P4b §S4): the upload form (media_type REELS + share_mode for a trial; a regular post's form
// as it was; never share_to_feed or collaborators), what may be a Trial Reel, the saved mode must match the request,
// eligibility by followers (snapshot, one read, cached; unknown needs the customer's tick), and Instagram's refusal
// mapped to our own words with nothing sent again. Nothing here reaches Upload-Post (server/test/mock-uploadpost.mjs).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JOB_MESSAGES } from './jobs.mjs';
import { contentMatches } from './publish.mjs';
import { MP4, JPEG, startPosting } from './test-helpers.mjs';

let t;
let alice;
let bob;
const DONT = 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS';
const IF_LIKED = 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED';

beforeAll(async () => {
  t = await startPosting();
  alice = await t.user('alice-trial@example.com');
  bob = await t.user('bob-trial@example.com');
  await t.project(alice);
  await t.project(bob);
  await t.connect(alice, ['instagram', 'facebook']);
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  expect(t.up.violations).toEqual([]);
  t.trialReels.forget(alice.id, 'proj-1');
  t.up.analytics.clear();
});

const video = (u, id) => t.file(u, id, MP4, 'video/mp4');
async function reel(u, extra = {}, id = `vid-${Math.random().toString(36).slice(2, 8)}.mp4`) {
  return t.post(u, { platform: 'instagram', format: 'video', media: video(u, id), ...extra });
}
async function publishAndWait(u, post, extra = {}) {
  const r = await t.publish(u, post, extra);
  await t.settled();
  return r;
}
const lastForm = () => t.postCalls().at(-1)?.form;

describe('the upload form', () => {
  it('a regular Instagram video sends the same form as before (no media_type, no share_mode)', async () => {
    const post = await reel(alice);
    const r = await publishAndWait(alice, post);
    expect(r.status).toBe(200);
    expect(Object.keys(lastForm()).sort()).toEqual(['async_upload', 'external_id', 'platform[]', 'request_id', 'title', 'user', 'video']);
    // CUSTOM is a regular Reel: the same form
    const custom = await reel(alice, { instagram: { shareMode: 'CUSTOM' } });
    expect((await publishAndWait(alice, custom, { content: { text: custom.caption, hashtags: custom.hashtags, mediaIds: [custom.media.id], shareMode: 'CUSTOM' } })).status).toBe(200);
    expect(Object.keys(lastForm()).sort()).toEqual(['async_upload', 'external_id', 'platform[]', 'request_id', 'title', 'user', 'video']);
  });

  it('a Trial Reel adds media_type REELS and its share_mode, both modes, never share_to_feed or collaborators; the job keeps the mode', async () => {
    for (const mode of [DONT, IF_LIKED]) {
      const post = await reel(alice, { instagram: { shareMode: mode } });
      const r = await publishAndWait(alice, post, { content: { text: post.caption, hashtags: post.hashtags, mediaIds: [post.media.id], shareMode: mode } });
      expect(r.status).toBe(200);
      const form = lastForm();
      expect(form).toMatchObject({ media_type: 'REELS', share_mode: mode });
      expect(form).not.toHaveProperty('share_to_feed');
      expect(form).not.toHaveProperty('collaborators');
      const row = await t.jobRow(r.body.job.id);
      expect(row.state).toBe('sent');
      expect(row.provider_ref.shareMode).toBe(mode);
    }
  });
});

describe('what may be a Trial Reel', () => {
  it('a trial mode on a photo, a text post or another network is refused before anything is sent', async () => {
    const before = t.postCalls().length;
    const photo = await t.post(alice, { platform: 'instagram', media: t.file(alice, 'img-trial.jpg', JPEG, 'image/jpeg'), instagram: { shareMode: DONT } });
    const fb = await t.post(alice, { platform: 'facebook', media: video(alice, 'vid-fb.mp4'), instagram: { shareMode: DONT } });
    const text = await t.post(alice, { platform: 'facebook', instagram: { shareMode: IF_LIKED } });
    for (const p of [photo, fb, text]) {
      const r = await t.publish(alice, p);
      expect([r.status, r.body.code, r.body.error]).toEqual([400, 'BAD_REQUEST', 'Trial Reels are for Instagram videos only.']);
    }
    expect(t.postCalls().length).toBe(before);
  });

  it('a request that names another mode than the saved post is a changed post (409)', async () => {
    const post = await reel(alice);
    const r = await t.publish(alice, post, { content: { text: post.caption, hashtags: post.hashtags, mediaIds: [post.media.id], shareMode: DONT } });
    expect([r.status, r.body.code]).toEqual([409, 'POST_CHANGED']);
    expect(contentMatches({ caption: 'x', instagram: { shareMode: DONT } }, { text: 'x', shareMode: 'CUSTOM' }, 'instagram')).toBe(false);
    expect(contentMatches({ caption: 'x', instagram: { shareMode: DONT } }, { text: 'x', shareMode: DONT }, 'instagram')).toBe(true);
    expect(contentMatches({ caption: 'x' }, { text: 'x', shareMode: 'CUSTOM' }, 'instagram')).toBe(true);
  });
});

describe('eligibility', () => {
  it('under 1,000 followers is refused with the count; 1,000 or more posts', async () => {
    const name = await t.profileOf(alice);
    t.up.analytics.set(name, { followers: 640 });
    const post = await reel(alice, { instagram: { shareMode: DONT } });
    const before = t.postCalls().length;
    const r = await t.publish(alice, post);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'TRIAL_REEL_NOT_ELIGIBLE', reason: 'followers', followers: 640 });
    expect(t.postCalls().length).toBe(before);
    t.trialReels.forget(alice.id, 'proj-1');
    t.up.analytics.set(name, { followers: 1000 });
    expect((await publishAndWait(alice, post)).status).toBe(200);
    expect(await t.trialReels.eligibility(alice.id, 'proj-1')).toMatchObject({ eligible: true, followers: 1000 });
  });

  it('followers that can’t be read need “Post as a trial anyway” (trialUnknownOk)', async () => {
    const name = await t.profileOf(alice);
    t.up.analytics.set(name, { followers: undefined });
    const post = await reel(alice, { instagram: { shareMode: DONT } });
    const r = await t.publish(alice, post);
    expect([r.status, r.body.code, r.body.reason]).toEqual([409, 'TRIAL_REEL_NOT_ELIGIBLE', 'unreadable']);
    const ok = await publishAndWait(alice, post, { trialUnknownOk: true });
    expect(ok.status).toBe(200);
    expect(lastForm().share_mode).toBe(DONT);
  });

  it('not connected, and the snapshot used while fresh, else one read then cached', async () => {
    expect(await t.trialReels.eligibility(bob.id, 'proj-1')).toMatchObject({ eligible: false, reason: 'not_connected' });
    // a fresh snapshot: no read at all
    const reads = () => t.up.calls.filter((c) => c.path.startsWith('/api/analytics/')).length;
    await t.db.upsert('analytics_snapshots', { user_id: alice.id, project_id: 'proj-1', source: 'social', status: 'ok', fetched_at: new Date(t.clock.t - 3_600_000).toISOString(), data: { networks: [{ network: 'instagram', origin: 'own', followers: 2340 }] } }, { onConflict: 'user_id,project_id,source' });
    const n0 = reads();
    expect(await t.trialReels.eligibility(alice.id, 'proj-1')).toMatchObject({ eligible: true, followers: 2340 });
    expect(reads()).toBe(n0);
    // an old snapshot: one read, then the cached count
    t.trialReels.forget(alice.id, 'proj-1');
    await t.db.update('analytics_snapshots', { user_id: alice.id, project_id: 'proj-1', source: 'social' }, { fetched_at: new Date(t.clock.t - 30 * 3_600_000).toISOString() });
    expect(await t.trialReels.eligibility(alice.id, 'proj-1')).toMatchObject({ eligible: true, followers: 1310 });
    expect(await t.trialReels.eligibility(alice.id, 'proj-1')).toMatchObject({ eligible: true, followers: 1310 });
    expect(reads()).toBe(n0 + 1);
    await t.db.remove('analytics_snapshots', { user_id: alice.id });
  });
});

describe('Instagram refusing a Trial Reel', () => {
  it('fails once with our own words, is never sent again, and Instagram’s text is nowhere', async () => {
    const post = await reel(alice, { instagram: { shareMode: IF_LIKED } });
    const before = t.postCalls().length;
    t.up.setUploadOutcome('trial_refused');
    const r = await publishAndWait(alice, post);
    expect(r.status).toBe(200);
    const job = (await t.call(alice, 'GET', `/api/posting/jobs/${r.body.job.id}`)).body.job;
    expect(job).toMatchObject({ state: 'failed', errorCode: 'TRIAL_REEL_REFUSED', errorMessage: JOB_MESSAGES.TRIAL_REEL_REFUSED });
    expect(JOB_MESSAGES.TRIAL_REEL_REFUSED).toMatch(/Nothing was posted\. Post it as a regular Reel instead\?$/);
    expect(t.postCalls().length).toBe(before + 1);
    const all = `${JSON.stringify(job)}\n${t.logs.join('\n')}\n${JSON.stringify(await t.jobRow(job.id))}`;
    expect(all).not.toContain('private detail');
    expect(all).not.toMatch(/not eligible for trial reels/i);
  });
});
