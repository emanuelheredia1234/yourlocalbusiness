// Posting from the app through Upload-Post (spec §1.7, owner decision): one upload per post with our job id as
// request_id, Idempotency-Key and external_id, the media as our short-lived public link, the platform's own result
// deciding (never the top-level success), background answers read from /uploadposts/status, unknown outcomes checked
// only by a read ("Check again"), upload_completed webhooks finishing a job, the stuck-job sweep, caps, ownership,
// and nothing ever sent twice. Nothing here reaches Upload-Post (server/test/mock-uploadpost.mjs).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mediaToken } from './media.mjs';
import { STUCK_AFTER_MS } from './jobs.mjs';
import { JPEG, MP4, PNG, startPosting } from './test-helpers.mjs';

let t;
let alice;
let bob;

beforeAll(async () => {
  t = await startPosting();
  alice = await t.user('alice@example.com');
  bob = await t.user('bob@example.com');
  await t.project(alice);
  await t.project(bob);
  await t.connect(alice);
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  // the rules every test keeps: no upload without its key, none sent twice, no key in a query, Pages asked per profile
  expect(t.up.violations).toEqual([]);
  expect(t.logs.join('\n')).not.toContain(t.env.UPLOAD_POST_API_KEY);
  expect(t.logs.join('\n')).not.toContain('/api/media/public/');
});

async function publishAndWait(u, post, extra) {
  const r = await t.publish(u, post, extra);
  await t.settled();
  return r;
}

const jobOf = async (u, id) => (await t.call(u, 'GET', `/api/posting/jobs/${id}`)).body.job;

describe('posting a saved post', () => {
  it('posts once with the job id as request_id, Idempotency-Key and external_id, on the business’s Page; the job is sent with its address', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Fresh sourdough today', linkPlacement: 'comment', firstComment: 'Order: https://joes.example/order' });
    const before = t.postCalls().length;
    const r = await publishAndWait(alice, post, { content: { text: post.caption, hashtags: post.hashtags, firstComment: post.firstComment } });
    expect(r.status).toBe(200);
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'sent', url: expect.stringMatching(/^https:\/\/social\.example\/facebook\/p\//) });
    const calls = t.postCalls().slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/api/upload_text', idempotencyKey: job.id });
    const profile = await t.profileOf(alice);
    expect(calls[0].form).toMatchObject({ user: profile, 'platform[]': ['facebook'], request_id: job.id, external_id: job.id, title: expect.stringMatching(/^Fresh sourdough today\r?\n\r?\n#bakery$/), first_comment: 'Order: https://joes.example/order', facebook_page_id: expect.stringMatching(/^page_/) });
    // the profile and the Page came from the stored doc, never from the request, and the browser sees neither
    expect(JSON.stringify(job)).not.toContain(profile);
    expect(JSON.stringify(job)).not.toContain(calls[0].form.facebook_page_id);
    const ledger = await t.db.select('usage_ledger', { call_id: job.id });
    expect(ledger.map((x) => [x.vendor, x.feature, x.endpoint, x.outcome])).toEqual([['uploadpost', 'posting', 'facebook:POST /upload_text', 'ok']]);
  });

  it('sends a photo as our short-lived public link (Upload-Post fetches it), and that link serves the file', async () => {
    const media = t.file(alice, 'img-ig-1.jpg', JPEG, 'image/jpeg');
    const post = await t.post(alice, { platform: 'instagram', media });
    const r = await publishAndWait(alice, post);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('sent');
    const call = t.postCalls().pop();
    expect(call.path).toBe('/api/upload_photos');
    const [link] = call.form['photos[]'];
    expect(link).toMatch(/^https:\/\/app\.test\/api\/media\/public\//);
    const fetched = await t.call(null, 'GET', new URL(link).pathname);
    expect(fetched.status).toBe(200);
  });

  it('refuses an Instagram photo that isn’t a JPEG before anything is sent', async () => {
    const media = t.file(alice, 'img-ig-png', PNG, 'image/png');
    const post = await t.post(alice, { platform: 'instagram', media });
    const before = t.up.calls.length;
    const r = await t.publish(alice, post);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('MEDIA_UNSUPPORTED');
    expect(t.up.calls.length).toBe(before);
  });

  it('posts a YouTube video with its title in the background (status reads by the job id), and a TikTok video with the account’s own audience', async () => {
    const video = t.file(alice, 'vid-yt-1', MP4, 'video/mp4');
    const yt = await t.post(alice, { platform: 'youtube', format: 'video', media: video, headline: 'Our sourdough, start to finish' });
    const r = await publishAndWait(alice, yt, { platform: 'youtube' });
    expect(await jobOf(alice, r.body.job.id)).toMatchObject({ state: 'sent', url: expect.stringMatching(/^https:\/\//) });
    expect(t.postCalls().pop()).toMatchObject({ path: '/api/upload', form: { async_upload: 'true', youtube_title: 'Our sourdough, start to finish', privacyStatus: 'public' } });
    expect(t.up.calls.some((c) => c.path === '/api/uploadposts/status' && c.query.request_id === r.body.job.id)).toBe(true);
    const tv = t.file(alice, 'vid-tt-1', MP4, 'video/mp4');
    const tt = await t.post(alice, { platform: 'tiktok', format: 'video', media: tv });
    expect((await jobOf(alice, (await publishAndWait(alice, tt)).body.job.id)).state).toBe('sent');
    // no audience sent: TikTok uses the account's own default, the only one that works on every account
    expect(t.postCalls().pop().form.privacy_level).toBeUndefined();
  });

  it('a TikTok that went to the account’s drafts is sent with a note and no address', async () => {
    const tv = t.file(alice, 'vid-tt-2', MP4, 'video/mp4');
    const tt = await t.post(alice, { platform: 'tiktok', format: 'video', media: tv, caption: 'Drafts one' });
    t.up.setUploadOutcome('inbox');
    const job = await jobOf(alice, (await publishAndWait(alice, tt)).body.job.id);
    expect(job).toMatchObject({ state: 'sent', note: 'SENT_TO_DRAFTS', noteMessage: 'Sent to your TikTok drafts. Open TikTok to publish it.' });
    expect(job.url).toBeUndefined();
  });

  it('this platform failing ends failed with our words (top-level success is not trusted); not connected there reads plainly', async () => {
    const post = await t.post(alice, { platform: 'linkedin', caption: 'Refused one' });
    t.up.setUploadOutcome('platform_failed');
    const job = await jobOf(alice, (await publishAndWait(alice, post)).body.job.id);
    expect(job).toMatchObject({ state: 'failed', errorCode: 'REFUSED', errorMessage: expect.any(String) });
    expect(JSON.stringify(job)).not.toContain('raw text');
    const post2 = await t.post(alice, { platform: 'linkedin', caption: 'Skipped one' });
    t.up.setUploadOutcome('skipped');
    expect(await jobOf(alice, (await publishAndWait(alice, post2)).body.job.id)).toMatchObject({ state: 'failed', errorCode: 'NOT_CONNECTED' });
  });

  it('a daily cap is the network’s limit; our key or plan trouble reads as a safe message (the owner is told)', async () => {
    const p1 = await t.post(alice, { platform: 'x', caption: 'Capped' });
    t.up.setUploadOutcome('hard_cap');
    expect(await jobOf(alice, (await publishAndWait(alice, p1)).body.job.id)).toMatchObject({ state: 'failed', errorCode: 'PLATFORM_LIMIT' });
    const p2 = await t.post(alice, { platform: 'x', caption: 'Plan cap' });
    t.up.setUploadOutcome('scheduled_limit');
    const job = await jobOf(alice, (await publishAndWait(alice, p2)).body.job.id);
    expect(job).toMatchObject({ state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' });
    expect(JSON.stringify(job)).not.toMatch(/upload-post|plan|upgrade|40000/i);
  });
});

describe('unknown outcomes and Check again', () => {
  it('a 5xx after Upload-Post took the post is unknown (one upload only); Check again finds it by the job id, with reads only', async () => {
    const post = await t.post(alice, { platform: 'x', caption: 'Created then 502' });
    t.up.setUploadOutcome('accepted_then_500');
    const before = t.postCalls().length;
    const r = await publishAndWait(alice, post);
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED', errorMessage: expect.stringContaining('may have been posted - check before trying again') });
    expect(t.postCalls().length - before).toBe(1);
    const reads = t.up.calls.length;
    const c = await t.call(alice, 'POST', `/api/posting/jobs/${job.id}/check`, {});
    expect(c.body.job.state).toBe('sent');
    expect(t.up.calls.slice(reads).every((x) => x.method === 'GET')).toBe(true);
    expect(t.up.calls.slice(reads).some((x) => x.path === '/api/uploadposts/status' && x.query.request_id === job.id)).toBe(true);
    expect(t.postCalls().length - before).toBe(1);
    expect((await t.db.select('usage_ledger', { call_id: job.id })).map((x) => x.endpoint)).toContain('x:GET /uploadposts/status');
  });

  it('a 500 with nothing created stays unknown after Check again (never “send again”), and a second press within 30 s answers 429', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Not there' });
    t.up.setUploadOutcome('error500');
    const r = await publishAndWait(alice, post);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('unknown');
    const c1 = await t.call(alice, 'POST', `/api/posting/jobs/${r.body.job.id}/check`, {});
    expect(c1.body.job).toMatchObject({ state: 'unknown', checkedAt: expect.any(String) });
    const c2 = await t.call(alice, 'POST', `/api/posting/jobs/${r.body.job.id}/check`, {});
    expect(c2.status).toBe(429);
    expect(c2.body).toMatchObject({ code: 'RATE_LIMITED', nextAt: expect.any(String) });
    t.clock.t += 31_000;
    expect((await t.call(alice, 'POST', `/api/posting/jobs/${r.body.job.id}/check`, {})).status).toBe(200);
  });

  it('an upload_completed webhook finishes an unknown job (routed by the customer’s profile and the job id)', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Finished by webhook' });
    t.up.setUploadOutcome('error500');
    const r = await publishAndWait(alice, post);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('unknown');
    const evt = t.up.signed({ event: 'upload_completed', request_id: r.body.job.id, profile_username: await t.profileOf(alice), platform: 'facebook', result: { success: true, url: 'https://facebook.com/joe/posts/9', post_id: '9' } }, { ts: Math.floor(t.clock.t / 1000) });
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    await t.impl.settled();
    expect(await jobOf(alice, r.body.job.id)).toMatchObject({ state: 'sent', url: 'https://facebook.com/joe/posts/9' });
    // Bob's job can't be finished by an event for Alice's profile, nor a job on another platform
    expect(await t.routes.posting.fromWebhook(bob.id, r.body.job.id, { state: 'failed' })).toBeNull();
    expect(await t.routes.posting.fromWebhook(alice.id, r.body.job.id, { state: 'failed', platform: 'x' })).toBeNull();
  });

  it('a success webhook after a failure (Upload-Post retried it by itself) is a new answer, not a repeat: the job reads “Posted”, so it isn’t posted again', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Retried by Upload-Post' });
    t.up.setUploadOutcome('platform_failed');
    const r = await publishAndWait(alice, post);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('failed');
    const profile = await t.profileOf(alice);
    const ts = Math.floor(t.clock.t / 1000);
    const failed = t.up.signed({ event: 'upload_completed', request_id: r.body.job.id, profile_username: profile, platform: 'facebook', result: { success: false, error: 'temporary' } }, { ts });
    expect((await t.impl.webhook(failed.raw, failed.headers)).status).toBe(200);
    const posted = t.up.signed({ event: 'upload_completed', request_id: r.body.job.id, profile_username: profile, platform: 'facebook', result: { success: true, url: 'https://facebook.com/joe/posts/11', post_id: '11' } }, { ts });
    expect((await t.impl.webhook(posted.raw, posted.headers)).body.duplicate).toBeUndefined();
    await t.impl.settled();
    expect(await jobOf(alice, r.body.job.id)).toMatchObject({ state: 'sent', url: 'https://facebook.com/joe/posts/11' });
    // a failure never overwrites a post that went out
    expect(await t.routes.posting.fromWebhook(alice.id, r.body.job.id, { state: 'failed' })).toBeNull();
  });

  it('a success webhook for an old failed try after the customer posted it again: the old try reads “posted after all”, the live one says the post may now appear twice; one live job stays, and nothing is sent again', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Failed, then posted again' });
    t.up.setUploadOutcome('platform_failed');
    const first = await publishAndWait(alice, post);
    expect((await jobOf(alice, first.body.job.id)).state).toBe('failed');
    // the customer presses Try again: a new try goes out
    const second = await publishAndWait(alice, post);
    expect((await jobOf(alice, second.body.job.id)).state).toBe('sent');
    const before = t.postCalls().length;
    // Upload-Post's own retry posted the first try after all
    const late = t.up.signed({ event: 'upload_completed', request_id: first.body.job.id, profile_username: await t.profileOf(alice), platform: 'facebook', result: { success: true, url: 'https://facebook.com/joe/posts/21', post_id: '21' } }, { ts: Math.floor(t.clock.t / 1000) });
    expect((await t.impl.webhook(late.raw, late.headers)).status).toBe(200);
    await t.impl.settled();
    expect(await jobOf(alice, first.body.job.id)).toMatchObject({ state: 'sent', url: 'https://facebook.com/joe/posts/21', note: 'POSTED_AFTER_ALL', noteMessage: expect.stringMatching(/may now appear twice/) });
    expect(await jobOf(alice, second.body.job.id)).toMatchObject({ state: 'sent', note: 'MAY_APPEAR_TWICE', noteMessage: expect.stringMatching(/may now appear twice/) });
    // still one live job for the post on Facebook: the old row stays out of the live set, and says what happened
    const rows = await t.db.select('post_publish_jobs', { user_id: alice.id, post_id: post.id, platform: 'facebook' });
    expect(rows.filter((r) => ['queued', 'sending', 'sent', 'unknown'].includes(r.state)).map((r) => r.id)).toEqual([second.body.job.id]);
    expect(rows.find((r) => r.id === first.body.job.id)).toMatchObject({ state: 'failed', error_code: 'POSTED_AFTER_ALL', url: 'https://facebook.com/joe/posts/21' });
    // the same news again (another delivery) changes nothing; nothing was sent; a third publish is refused
    const again = t.up.signed({ event: 'upload_completed', request_id: first.body.job.id, profile_username: await t.profileOf(alice), platform: 'facebook', result: { success: true, url: 'https://facebook.com/joe/posts/22', post_id: '22' } }, { ts: Math.floor(t.clock.t / 1000) });
    await t.impl.webhook(again.raw, again.headers);
    await t.impl.settled();
    expect((await jobOf(alice, first.body.job.id)).url).toBe('https://facebook.com/joe/posts/21');
    expect(t.postCalls().length).toBe(before);
    expect((await t.publish(alice, post)).status).toBe(409);
    // the app reads both in the business's job list
    const list = await t.call(alice, 'GET', '/api/posting/jobs?projectId=proj-1');
    expect(list.body.jobs.filter((j) => j.postId === post.id).map((j) => j.note).sort()).toEqual(['MAY_APPEAR_TWICE', 'POSTED_AFTER_ALL']);
    // even once the new try is no longer live (say it's found to have failed), the post went out: never a third copy
    await t.db.update('post_publish_jobs', { id: second.body.job.id }, { state: 'failed', error_code: 'REFUSED' });
    const fourth = await t.publish(alice, post);
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({ code: 'ALREADY_PUBLISHING', job: { id: first.body.job.id, state: 'sent', note: 'POSTED_AFTER_ALL' } });
    expect(t.postCalls().length).toBe(before);
  });

  it('the old try’s late success while the new try is still being sent: the new one still ends saying it may appear twice', async () => {
    const post = await t.post(alice, { platform: 'linkedin', caption: 'Racing tries' });
    t.up.setUploadOutcome('platform_failed');
    const first = await publishAndWait(alice, post);
    expect((await jobOf(alice, first.body.job.id)).state).toBe('failed');
    let release;
    t.up.setUploadOutcome({ waitFor: new Promise((r) => (release = r)), then: 'ok' });
    const second = await t.publish(alice, post);
    for (let i = 0; i < 200 && !t.postCalls().some((c) => c.idempotencyKey === second.body.job.id); i += 1) await new Promise((res) => setTimeout(res, 5));
    const late = t.up.signed({ event: 'upload_completed', request_id: first.body.job.id, profile_username: await t.profileOf(alice), platform: 'linkedin', result: { success: true, url: 'https://linkedin.com/feed/update/1', post_id: 'li1' } }, { ts: Math.floor(t.clock.t / 1000) });
    expect((await t.impl.webhook(late.raw, late.headers)).status).toBe(200);
    await t.impl.settled();
    release();
    await t.settled();
    expect(await jobOf(alice, first.body.job.id)).toMatchObject({ state: 'sent', note: 'POSTED_AFTER_ALL' });
    expect(await jobOf(alice, second.body.job.id)).toMatchObject({ state: 'sent', note: 'MAY_APPEAR_TWICE' });
  });

  it('a failed try posted after all with nothing posted since simply reads “Posted” (it’s the live one now)', async () => {
    const post = await t.post(alice, { platform: 'x', caption: 'Posted after all, alone' });
    t.up.setUploadOutcome('platform_failed');
    const first = await publishAndWait(alice, post);
    const late = t.up.signed({ event: 'upload_completed', request_id: first.body.job.id, profile_username: await t.profileOf(alice), platform: 'x', result: { success: true, url: 'https://x.com/joe/status/5', post_id: '5' } }, { ts: Math.floor(t.clock.t / 1000) });
    await t.impl.webhook(late.raw, late.headers);
    await t.impl.settled();
    const job = await jobOf(alice, first.body.job.id);
    expect(job).toMatchObject({ state: 'sent', url: 'https://x.com/joe/status/5' });
    expect(job.note).toBeUndefined();
  });

  it('each business posts through its own profile, and an upload_completed through one business’s profile never finishes another business’s job', async () => {
    await t.project(alice, 'proj-2');
    await t.connect(alice, ['facebook'], { projectId: 'proj-2' });
    const p1 = await t.profileOf(alice, 'proj-1');
    const p2 = await t.profileOf(alice, 'proj-2');
    expect(p2).not.toBe(p1);
    const post2 = await t.post(alice, { projectId: 'proj-2', platform: 'facebook', caption: 'From the second business' });
    const r2 = await publishAndWait(alice, post2);
    expect((await jobOf(alice, r2.body.job.id)).state).toBe('sent');
    expect(t.postCalls().pop().form).toMatchObject({ user: p2, facebook_page_id: `page_${p2.slice(-8)}` });
    // a post of the first business whose answer was unclear
    const post1 = await t.post(alice, { platform: 'facebook', caption: 'From the first business' });
    t.up.setUploadOutcome('error500');
    const r1 = await publishAndWait(alice, post1);
    expect((await jobOf(alice, r1.body.job.id)).state).toBe('unknown');
    const wrong = t.up.signed({ event: 'upload_completed', request_id: r1.body.job.id, profile_username: p2, platform: 'facebook', result: { success: true, url: 'https://facebook.com/joe/posts/31' } }, { ts: Math.floor(t.clock.t / 1000) });
    await t.impl.webhook(wrong.raw, wrong.headers);
    await t.impl.settled();
    expect((await jobOf(alice, r1.body.job.id)).state).toBe('unknown');
    const right = t.up.signed({ event: 'upload_completed', request_id: r1.body.job.id, profile_username: p1, platform: 'facebook', result: { success: true, url: 'https://facebook.com/joe/posts/32' } }, { ts: Math.floor(t.clock.t / 1000) });
    await t.impl.webhook(right.raw, right.headers);
    await t.impl.settled();
    expect(await jobOf(alice, r1.body.job.id)).toMatchObject({ state: 'sent', url: 'https://facebook.com/joe/posts/32' });
  });

  it('an upload_completed that arrives while the post is still being sent finishes the job when the answer is unclear', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Webhook before the answer' });
    let release;
    t.up.setUploadOutcome({ waitFor: new Promise((r) => (release = r)), then: 'error500' });
    const r = await t.publish(alice, post);
    for (let i = 0; i < 200 && !t.postCalls().some((c) => c.idempotencyKey === r.body.job.id); i += 1) await new Promise((res) => setTimeout(res, 5));
    const evt = t.up.signed({ event: 'upload_completed', request_id: r.body.job.id, profile_username: await t.profileOf(alice), platform: 'facebook', result: { success: true, url: 'https://facebook.com/joe/posts/10' } }, { ts: Math.floor(t.clock.t / 1000) });
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    await t.impl.settled();
    expect((await jobOf(alice, r.body.job.id)).state).toBe('sending');
    release();
    await t.settled();
    expect(await jobOf(alice, r.body.job.id)).toMatchObject({ state: 'sent', url: 'https://facebook.com/joe/posts/10' });
  });

  it('a `sending` job older than the polling window becomes unknown on read and on startup, with no network call', async () => {
    const base = { user_id: alice.id, project_id: 'proj-1', platform: 'facebook', state: 'sending', provider_ref: {} };
    const old = new Date(t.clock.t - STUCK_AFTER_MS - 20_000).toISOString();
    const a = { ...base, id: crypto.randomUUID(), post_id: 'stuck-a', client_request_id: crypto.randomUUID(), requested_at: old };
    const b = { ...base, id: crypto.randomUUID(), post_id: 'stuck-b', client_request_id: crypto.randomUUID(), requested_at: old };
    const fresh = { ...base, id: crypto.randomUUID(), post_id: 'fresh-c', client_request_id: crypto.randomUUID(), requested_at: new Date(t.clock.t - 200_000).toISOString() };
    await t.db.insert('post_publish_jobs', [a, b, fresh]);
    const calls = t.up.calls.length;
    expect(await jobOf(alice, a.id)).toMatchObject({ state: 'unknown', errorCode: 'INTERRUPTED' });
    await t.routes.onStart();
    expect((await t.jobRow(b.id)).state).toBe('unknown');
    expect((await t.jobRow(fresh.id)).state).toBe('sending');
    expect(t.up.calls.length).toBe(calls);
  });
});

describe('the job', () => {
  it('a second publish of the same post answers 409 ALREADY_PUBLISHING; the same clientRequestId gives the same job', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Once only' });
    const clientRequestId = crypto.randomUUID();
    const before = t.postCalls().length;
    const a = await t.publish(alice, post, { clientRequestId });
    const again = await t.publish(alice, post, { clientRequestId });
    expect(again.body.job.id).toBe(a.body.job.id);
    await t.settled();
    const b = await t.publish(alice, post);
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ code: 'ALREADY_PUBLISHING', job: { id: a.body.job.id, state: 'sent' } });
    expect(t.postCalls().length - before).toBe(1);
  });

  it('refuses a post whose text changed since it was saved (POST_CHANGED), and an unconfirmed request', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Saved text' });
    const before = t.up.calls.length;
    const r = await t.publish(alice, post, { content: { text: 'Different text the screen still shows' } });
    expect(r.body.code).toBe('POST_CHANGED');
    expect((await t.publish(alice, post, { confirm: false })).status).toBe(400);
    expect(t.up.calls.length).toBe(before);
  });

  it('the 21st X post of the day answers 429 CUSTOMER_CAP', async () => {
    const u = await t.user('carol@example.com');
    await t.project(u);
    await t.connect(u, ['x']);
    const tag = (await t.db.select('billing_customers', { user_id: u.id }))[0].customer_tag;
    await t.db.upsert('billing_caps', { customer_tag: tag, x_posts_per_day: 1 }, { onConflict: 'customer_tag' });
    const p1 = await t.post(u, { platform: 'x', caption: 'First of the day' });
    expect((await publishAndWait(u, p1)).status).toBe(200);
    const p2 = await t.post(u, { platform: 'x', caption: 'Second of the day' });
    const r = await t.publish(u, p2);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: 'CUSTOMER_CAP', period: 'day' });
  });

  it('lists a business’s jobs, newest first, with no provider ids', async () => {
    const r = await t.call(alice, 'GET', '/api/posting/jobs?projectId=proj-1');
    expect(r.status).toBe(200);
    expect(r.body.jobs.length).toBeGreaterThan(3);
    const times = r.body.jobs.map((j) => j.requestedAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(JSON.stringify(r.body)).not.toMatch(/user_id|provider_ref|accountRef|idempotencyKey|requestId|ylb_/);
  });
});

describe('ownership and access', () => {
  it('someone else’s post, job and business all answer 404', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Alice only' });
    const r = await publishAndWait(alice, post);
    const id = r.body.job.id;
    expect((await t.call(bob, 'GET', `/api/posting/jobs/${id}`)).status).toBe(404);
    expect((await t.call(bob, 'POST', `/api/posting/jobs/${id}/check`, {})).status).toBe(404);
    expect((await t.call(bob, 'GET', '/api/posting/jobs?projectId=nope')).status).toBe(404);
    expect((await t.publish(bob, post)).status).toBe(404);
    t.file(alice, 'img-alice', PNG, 'image/png');
    await t.connect(bob, ['facebook']);
    const bobPost = await t.post(bob, { platform: 'facebook', media: { id: 'img-alice', kind: 'image', mime: 'image/png' } });
    expect((await t.publish(bob, bobPost)).body.code).toBe('MEDIA_UNSUPPORTED');
  });

  it('needs a sign-in, and an account connected for that network', async () => {
    expect((await t.call(null, 'GET', '/api/posting/jobs?projectId=proj-1')).status).toBe(401);
    const post = await t.post(bob, { platform: 'tiktok', media: t.file(bob, 'img-bob.jpg', JPEG, 'image/jpeg') });
    const before = t.up.calls.length;
    const r = await t.publish(bob, post);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_CONNECTED');
    expect(t.up.calls.length).toBe(before);
  });
});

describe('connections switched off', () => {
  it('answers 503 NOT_SET_UP on every posting route and the media link, and sends nothing', async () => {
    const off = await startPosting({ enabled: false });
    try {
      const u = await off.user('dave@example.com');
      await off.project(u);
      const post = await off.post(u, { platform: 'facebook' });
      const r = await off.publish(u, post);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('NOT_SET_UP');
      expect(r.body.hint).toBeUndefined();
      expect((await off.call(u, 'GET', '/api/posting/jobs?projectId=proj-1')).status).toBe(503);
      const token = mediaToken(off.env, { userId: u.id, mediaId: 'any', kind: 'image' }, off.clock.t);
      expect((await off.call(null, 'GET', `/api/media/public/${token}`)).status).toBe(503);
      expect(off.up.calls).toHaveLength(0);
    } finally {
      await off.close();
    }
  });
});

describe('photo and video posts without MEDIA_URL_SECRET', () => {
  it('are refused before a job is made (nothing sent), the owner is told, and text posts still go', async () => {
    const s = await startPosting({ env: { MEDIA_URL_SECRET: '' } });
    try {
      const u = await s.user('erin@example.com');
      await s.project(u);
      await s.connect(u, ['instagram', 'facebook']);
      const post = await s.post(u, { platform: 'instagram', media: s.file(u, 'img-nosecret.jpg', JPEG, 'image/jpeg') });
      const before = s.postCalls().length;
      const r = await s.publish(u, post);
      expect(r).toMatchObject({ status: 503, body: { code: 'SERVICE_UNAVAILABLE' } });
      expect(r.body.error).not.toMatch(/MEDIA_URL_SECRET|secret/i);
      expect(s.postCalls().length).toBe(before);
      expect(await s.db.select('post_publish_jobs', { user_id: u.id })).toHaveLength(0);
      await s.impl.settled();
      expect(Object.keys((await s.storage.get('uploadpost:alerts')).value)).toContain('media_secret');
      const text = await s.post(u, { platform: 'facebook', caption: 'Text still goes' });
      const ok = await s.publish(u, text);
      await s.settled();
      expect((await s.call(u, 'GET', `/api/posting/jobs/${ok.body.job.id}`)).body.job.state).toBe('sent');
    } finally {
      await s.close();
    }
  });
});
