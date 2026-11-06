// Posting from the app through Zernio (spec §1.7, owner decision): one POST /v1/posts per post with an
// Idempotency-Key, the file uploaded to Zernio first, unknown outcomes checked only by a read ("Check again"),
// post.* webhooks finishing a job, the stuck-job sweep, caps, ownership, and nothing ever sent twice.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mediaToken } from './media.mjs';
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
  // the rules every test keeps: no post without its key, none sent twice, no key on an upload or in a query
  expect(t.zernio.violations).toEqual([]);
  expect(t.logs.join('\n')).not.toContain(t.env.ZERNIO_API_KEY);
});

async function publishAndWait(u, post, extra) {
  const r = await t.publish(u, post, extra);
  await t.settled();
  return r;
}

const jobOf = async (u, id) => (await t.call(u, 'GET', `/api/posting/jobs/${id}`)).body.job;

describe('posting a saved post', () => {
  it('posts once on the chosen account with the job id as Idempotency-Key and in the metadata; the job is sent with its address', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Fresh sourdough today', linkPlacement: 'comment', firstComment: 'Order: https://joes.example/order' });
    const before = t.postCalls().length;
    const r = await publishAndWait(alice, post, { content: { text: post.caption, hashtags: post.hashtags, firstComment: post.firstComment } });
    expect(r.status).toBe(200);
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'sent', url: expect.stringMatching(/^https:\/\/social\.example\/facebook\/p\//) });
    const calls = t.postCalls().slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0].idempotencyKey).toBe(job.id);
    expect(calls[0].body).toMatchObject({ content: 'Fresh sourdough today\n\n#bakery', publishNow: true, metadata: { ylbJob: job.id }, platforms: [{ platform: 'facebook', platformSpecificData: { firstComment: 'Order: https://joes.example/order' } }] });
    // the account id came from the stored doc, never from the request
    expect(calls[0].body.platforms[0].accountId).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(job)).not.toContain(calls[0].body.platforms[0].accountId);
    // the ledger has the customer's Zernio row
    const ledger = await t.db.select('usage_ledger', { call_id: job.id });
    expect(ledger.map((x) => [x.vendor, x.feature, x.endpoint, x.outcome])).toEqual([['zernio', 'posting', 'facebook:POST /v1/posts', 'ok']]);
  });

  it('uploads a photo to Zernio’s storage first (no key on it), then posts it as a media item', async () => {
    const media = t.file(alice, 'img-ig-1.jpg', JPEG, 'image/jpeg');
    const post = await t.post(alice, { platform: 'instagram', media });
    const r = await publishAndWait(alice, post);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('sent');
    const presign = t.zernio.calls.filter((c) => c.path === '/api/v1/media/presign').pop();
    expect(presign.body).toMatchObject({ contentType: 'image/jpeg' });
    const put = t.zernio.calls.filter((c) => c.method === 'PUT').pop();
    expect(put).toMatchObject({ auth: null, bytes: JPEG.length });
    expect(t.postCalls().pop().body.mediaItems).toEqual([{ type: 'image', url: expect.stringContaining('/__media/') }]);
  });

  it('refuses an Instagram photo that isn’t a JPEG before anything is sent', async () => {
    const media = t.file(alice, 'img-ig-png', PNG, 'image/png');
    const post = await t.post(alice, { platform: 'instagram', media });
    const before = t.zernio.calls.length;
    const r = await t.publish(alice, post);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('MEDIA_UNSUPPORTED');
    expect(t.zernio.calls.length).toBe(before);
  });

  it('posts a YouTube video with its title, and a TikTok video with TikTok’s settings', async () => {
    const video = t.file(alice, 'vid-yt-1', MP4, 'video/mp4');
    const yt = await t.post(alice, { platform: 'youtube', format: 'video', media: video, headline: 'Our sourdough, start to finish' });
    expect((await jobOf(alice, (await publishAndWait(alice, yt, { platform: 'youtube' })).body.job.id)).state).toBe('sent');
    expect(t.postCalls().pop().body.platforms[0]).toMatchObject({ platform: 'youtube', platformSpecificData: { title: 'Our sourdough, start to finish', visibility: 'public' } });
    const tv = t.file(alice, 'vid-tt-1', MP4, 'video/mp4');
    const tt = await t.post(alice, { platform: 'tiktok', format: 'video', media: tv });
    expect((await jobOf(alice, (await publishAndWait(alice, tt)).body.job.id)).state).toBe('sent');
    expect(t.postCalls().pop().body.tiktokSettings).toMatchObject({ privacy_level: 'PUBLIC_TO_EVERYONE', content_preview_confirmed: true });
  });

  it('a network refusal ends failed with a plain message', async () => {
    const post = await t.post(alice, { platform: 'linkedin', caption: 'Refused one' });
    t.zernio.setPostOutcome('failed');
    const job = await jobOf(alice, (await publishAndWait(alice, post)).body.job.id);
    expect(job).toMatchObject({ state: 'failed', errorCode: 'REFUSED', errorMessage: expect.any(String) });
  });
});

describe('unknown outcomes and Check again', () => {
  it('a 5xx after Zernio took the post is unknown (one create only); Check again finds it by the job id, with reads only', async () => {
    const post = await t.post(alice, { platform: 'x', caption: 'Created then 502' });
    t.zernio.setPostOutcome('accepted_then_500');
    const before = t.postCalls().length;
    const r = await publishAndWait(alice, post);
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
    expect(t.postCalls().length - before).toBe(1);
    const reads = t.zernio.calls.length;
    const c = await t.call(alice, 'POST', `/api/posting/jobs/${job.id}/check`, {});
    expect(c.body.job.state).toBe('sent');
    expect(t.zernio.calls.slice(reads).every((x) => x.method === 'GET')).toBe(true);
    expect(t.postCalls().length - before).toBe(1);
  });

  it('a 500 with nothing created stays unknown after Check again (never “send again”), and a second press within 30 s answers 429', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Not there' });
    t.zernio.setPostOutcome('error500');
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

  it('a post.published webhook finishes an unknown job (routed by the customer and the job id)', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Finished by webhook' });
    t.zernio.setPostOutcome('error500');
    const r = await publishAndWait(alice, post);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('unknown');
    const doc = (await t.storage.get([...t.storage.documents.keys()].find((k) => k.startsWith('zernio:user:')))).value;
    const evt = t.zernio.signed({ event: 'post.published', profiles: t.zernio.profileRef(doc.profileId), post: { id: 'dddddddddddddddddddddddd', status: 'published', metadata: { ylbJob: r.body.job.id }, platforms: [{ platform: 'facebook', status: 'published', publishedUrl: 'https://facebook.com/joe/posts/9' }] } });
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    expect(await jobOf(alice, r.body.job.id)).toMatchObject({ state: 'sent', url: 'https://facebook.com/joe/posts/9' });
    // Bob's job can't be finished by an event for Alice's profile
    expect(await t.routes.posting.fromWebhook(bob.id, r.body.job.id, { state: 'failed' })).toBeNull();
  });

  it('a `sending` job older than 180 s becomes unknown on read and on startup, with no network call', async () => {
    const base = { user_id: alice.id, project_id: 'proj-1', platform: 'facebook', state: 'sending', provider_ref: {} };
    const old = new Date(t.clock.t - 200_000).toISOString();
    const a = { ...base, id: crypto.randomUUID(), post_id: 'stuck-a', client_request_id: crypto.randomUUID(), requested_at: old };
    const b = { ...base, id: crypto.randomUUID(), post_id: 'stuck-b', client_request_id: crypto.randomUUID(), requested_at: old };
    const fresh = { ...base, id: crypto.randomUUID(), post_id: 'fresh-c', client_request_id: crypto.randomUUID(), requested_at: new Date(t.clock.t - 10_000).toISOString() };
    await t.db.insert('post_publish_jobs', [a, b, fresh]);
    const calls = t.zernio.calls.length;
    expect(await jobOf(alice, a.id)).toMatchObject({ state: 'unknown', errorCode: 'INTERRUPTED' });
    await t.routes.onStart();
    expect((await t.jobRow(b.id)).state).toBe('unknown');
    expect((await t.jobRow(fresh.id)).state).toBe('sending');
    expect(t.zernio.calls.length).toBe(calls);
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
    const before = t.zernio.calls.length;
    const r = await t.publish(alice, post, { content: { text: 'Different text the screen still shows' } });
    expect(r.body.code).toBe('POST_CHANGED');
    expect((await t.publish(alice, post, { confirm: false })).status).toBe(400);
    expect(t.zernio.calls.length).toBe(before);
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
    expect(JSON.stringify(r.body)).not.toMatch(/user_id|provider_ref|accountRef|idempotencyKey|ylbJob/);
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
    const before = t.zernio.calls.length;
    const r = await t.publish(bob, post);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_CONNECTED');
    expect(t.zernio.calls.length).toBe(before);
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
      expect(off.zernio.calls).toHaveLength(0);
    } finally {
      await off.close();
    }
  });
});
