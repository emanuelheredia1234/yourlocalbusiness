// Posting from the app (spec §1.7, §9.2 WP2): each network's exact calls, one attempt per post, unknown outcomes,
// "Check again", the stuck-job sweep, caps, ownership and the rules on tokens and media links.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FB_PAGE_TOKEN, IG_USER_ID } from '../test/mock-social-providers.mjs';
import { mediaToken, verifyMediaToken } from './media.mjs';
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
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  t.social.reset();
  t.impl.proxyCalls.length = 0;
  t.impl.violations.length = 0;
});

/** No call anywhere may carry a derived token through the proxy, a token in a URL, or Retries. */
function assertProxyRules() {
  expect(t.impl.violations).toEqual([]);
  for (const c of t.impl.proxyCalls) {
    expect(Object.keys(c.headers)).not.toContain('nango-proxy-authorization');
    expect(Object.keys(c.query).filter((k) => /token|secret|key/i.test(k))).toEqual([]);
    expect(JSON.stringify(c.query)).not.toContain(FB_PAGE_TOKEN);
  }
  for (const c of t.social.calls.filter((x) => x.via === 'proxy')) {
    expect(c.headers.authorization).toBeUndefined();
    expect(c.headers.retries).toBeUndefined();
    expect(c.headers['retry-on']).toBeUndefined();
  }
  expect(t.logs.join('\n')).not.toContain(FB_PAGE_TOKEN);
}

async function publishAndWait(u, post, extra) {
  const r = await t.publish(u, post, extra);
  await t.settled();
  return r;
}

const jobOf = async (u, id) => (await t.call(u, 'GET', `/api/posting/jobs/${id}`)).body.job;

describe('Facebook', () => {
  it('reads the Page token through the proxy, posts straight to Graph with it as a bearer, and adds the first comment', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Fresh sourdough today https://joes.example/menu', linkPlacement: 'comment', firstComment: 'Menu: https://joes.example/menu' });
    const r = await publishAndWait(alice, post, { content: { text: post.caption, hashtags: post.hashtags, firstComment: post.firstComment } });
    expect(r.status).toBe(200);
    expect(r.body.job).toMatchObject({ state: 'sending', postId: post.id, platform: 'facebook' });
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'sent', comment: 'added' });
    expect(job.url).toMatch(/^https:\/\/www\.facebook\.com\//);

    // the proxy saw only the Page-token read, never a write
    expect(t.impl.proxyCalls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v26.0/1029384756']);
    expect(t.impl.proxyCalls[0].query).toEqual({ fields: 'access_token' });
    const feed = t.social.callsTo('POST', '/v26.0/1029384756/feed');
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ via: 'direct' });
    expect(feed[0].headers.authorization).toBe(`Bearer ${FB_PAGE_TOKEN}`);
    expect(feed[0].query).toEqual({});
    expect(feed[0].body).toEqual({ message: 'Fresh sourdough today https://joes.example/menu\n\n#bakery' });
    const comment = t.social.calls.find((c) => /\/comments$/.test(c.path));
    expect(comment).toMatchObject({ via: 'direct', body: { message: 'Menu: https://joes.example/menu' } });
    assertProxyRules();

    // a nango row and no X estimate in the ledger
    const ledger = await t.db.select('usage_ledger', { call_id: job.id });
    expect(ledger.map((x) => [x.vendor, x.endpoint, Number(x.cost_micro), x.outcome])).toEqual([['nango', 'facebook:publish', 0, 'sent']]);
  });

  it('sends a photo as a short-lived link in the POST body, never in a query string', async () => {
    const media = t.file(alice, 'img-fb-1', PNG, 'image/png');
    const post = await t.post(alice, { platform: 'facebook', media });
    await publishAndWait(alice, post);
    const photos = t.social.callsTo('POST', '/v26.0/1029384756/photos');
    expect(photos).toHaveLength(1);
    expect(photos[0].query).toEqual({});
    const link = photos[0].body.url;
    expect(link).toMatch(/^https:\/\/app\.test\/api\/media\/public\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const v = verifyMediaToken(t.env, link.split('/').pop(), t.clock.t);
    expect(v).toMatchObject({ ok: true, userId: alice.id, mediaId: 'img-fb-1', kind: 'image' });
    // an image link lasts 30 minutes
    expect(verifyMediaToken(t.env, link.split('/').pop(), t.clock.t + 30 * 60_000 + 1)).toEqual({ ok: false, why: 'expired' });
    expect(t.logs.join('\n')).not.toContain(link.split('/').pop());
    assertProxyRules();
  });
});

describe('Instagram', () => {
  it('checks the publishing limit, makes the container, then publishes it', async () => {
    const media = t.file(alice, 'img-ig-1.jpg', JPEG, 'image/jpeg');
    const post = await t.post(alice, { platform: 'instagram', media, linkPlacement: 'comment', firstComment: 'Link in bio' });
    const r = await publishAndWait(alice, post, { content: { text: post.caption, mediaIds: [media.id] } });
    expect(r.status).toBe(200);
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'sent', comment: 'added' });
    expect(job.url).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
    expect(t.impl.proxyCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v26.0/${IG_USER_ID}/content_publishing_limit`,
      `POST /v26.0/${IG_USER_ID}/media`,
      `POST /v26.0/${IG_USER_ID}/media_publish`,
      expect.stringMatching(/^GET \/v26\.0\/\d+$/),
      expect.stringMatching(/^POST \/v26\.0\/\d+\/comments$/),
    ]);
    const writes = t.impl.proxyCalls.filter((c) => c.method === 'POST');
    expect(writes.every((c) => c.oneShot)).toBe(true);
    const container = t.social.callsTo('POST', `/v26.0/${IG_USER_ID}/media`)[0];
    expect(container.query).toEqual({});
    expect(container.body.image_url).toMatch(/^https:\/\/app\.test\/api\/media\/public\//);
    expect(container.body.caption).toBe('Fresh sourdough today\n\n#bakery');
    assertProxyRules();
  });

  it('refuses a photo that isn’t a JPEG before anything is sent', async () => {
    const media = t.file(alice, 'img-ig-png', PNG, 'image/png');
    const post = await t.post(alice, { platform: 'instagram', media });
    const r = await t.publish(alice, post);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'MEDIA_UNSUPPORTED', error: expect.stringMatching(/JPEG/) });
    expect(t.impl.proxyCalls).toHaveLength(0);
  });

  it('takes the JPEG copy the app saved beside a PNG', async () => {
    const media = t.file(alice, 'img-ig-2', PNG, 'image/png');
    t.file(alice, 'img-ig-2.jpg', JPEG, 'image/jpeg');
    const post = await t.post(alice, { platform: 'instagram', media });
    const r = await publishAndWait(alice, post, { content: { text: post.caption, mediaIds: ['img-ig-2.jpg'] } });
    expect(r.status).toBe(200);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('sent');
    expect(verifyMediaToken(t.env, t.social.callsTo('POST', `/v26.0/${IG_USER_ID}/media`)[0].body.image_url.split('/').pop(), t.clock.t)).toMatchObject({ mediaId: 'img-ig-2.jpg' });
  });

  it('waits for a Reel to finish processing, reading its status', async () => {
    const media = t.file(alice, 'vid-ig-1', MP4, 'video/mp4');
    t.social.state.igVideoStatus = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    const post = await t.post(alice, { platform: 'instagram', format: 'video', media });
    const r = await publishAndWait(alice, post);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('sent');
    const container = t.social.callsTo('POST', `/v26.0/${IG_USER_ID}/media`)[0];
    expect(container.body).toMatchObject({ media_type: 'REELS' });
    expect(verifyMediaToken(t.env, container.body.video_url.split('/').pop(), t.clock.t)).toMatchObject({ kind: 'video' });
    expect(t.social.calls.filter((c) => c.query.fields === 'status_code')).toHaveLength(3);
  });

  it('answers 429 PLATFORM_LIMIT when the day’s quota is used, with no job', async () => {
    t.social.state.igQuota = { used: 100, total: 100 };
    const media = t.file(alice, 'img-ig-3.jpg', JPEG, 'image/jpeg');
    const post = await t.post(alice, { platform: 'instagram', media });
    const r = await t.publish(alice, post);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('PLATFORM_LIMIT');
    expect(t.social.callsTo('POST', `/v26.0/${IG_USER_ID}/media`)).toHaveLength(0);
    expect(await t.db.select('post_publish_jobs', { user_id: alice.id, post_id: post.id })).toHaveLength(0);
  });
});

describe('TikTok', () => {
  it('asks creator_info first, uploads the bytes straight to upload_url, and polls the status to PUBLISH_COMPLETE', async () => {
    const media = t.file(alice, 'vid-tt-1', MP4, 'video/mp4');
    const post = await t.post(alice, { platform: 'tiktok', format: 'video', media, caption: 'Behind the scenes https://joes.example' });
    const r = await publishAndWait(alice, post);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('sent');
    const order = t.social.calls.map((c) => `${c.via} ${c.method} ${c.path}`);
    expect(order[0]).toBe('proxy POST /v2/post/publish/creator_info/query/');
    expect(order[1]).toBe('proxy POST /v2/post/publish/video/init/');
    expect(order[2]).toMatch(/^direct PUT \/upload\/tiktok\//);
    expect(order.slice(3).every((o) => o === 'proxy POST /v2/post/publish/status/fetch/')).toBe(true);
    const init = t.social.callsTo('POST', '/v2/post/publish/video/init/')[0].body;
    expect(init.post_info).toMatchObject({ title: 'Behind the scenes\n\n#bakery', privacy_level: 'PUBLIC_TO_EVERYONE' });
    expect(init.source_info).toEqual({ source: 'FILE_UPLOAD', video_size: MP4.length, chunk_size: MP4.length, total_chunk_count: 1 });
    expect(t.social.state.uploads).toEqual([{ network: 'tiktok', bytes: MP4.length, range: `bytes 0-${MP4.length - 1}/${MP4.length}` }]);
    assertProxyRules();
  });

  it('a FAILED status ends failed', async () => {
    t.social.state.tiktokStatus = ['PROCESSING_UPLOAD', 'FAILED'];
    const media = t.file(alice, 'vid-tt-2', MP4, 'video/mp4');
    const post = await t.post(alice, { platform: 'tiktok', format: 'video', media });
    const r = await publishAndWait(alice, post);
    expect(await jobOf(alice, r.body.job.id)).toMatchObject({ state: 'failed', errorCode: 'REFUSED' });
  });

  it('still processing after 2 minutes ends unknown, and Check again reads the status', async () => {
    t.social.state.tiktokStatus = ['PROCESSING_UPLOAD'];
    const media = t.file(alice, 'vid-tt-3', MP4, 'video/mp4');
    const post = await t.post(alice, { platform: 'tiktok', format: 'video', media });
    const r = await publishAndWait(alice, post);
    const job = await jobOf(alice, r.body.job.id);
    expect(job.state).toBe('unknown');
    const polls = t.social.callsTo('POST', '/v2/post/publish/status/fetch/').length;
    expect(polls).toBeGreaterThanOrEqual(12);
    expect(polls).toBeLessThanOrEqual(13);
    expect(t.social.callsTo('POST', '/v2/post/publish/video/init/')).toHaveLength(1);
    // it finished after all
    t.social.state.tiktokStatus = ['PUBLISH_COMPLETE'];
    const c = await t.call(alice, 'POST', `/api/posting/jobs/${job.id}/check`, {});
    expect(c.body.job.state).toBe('sent');
  });

  it('posts as SELF_ONLY when the app is still unaudited', async () => {
    t.impl.statuses.splice(3, 1, { platform: 'tiktok', state: 'limited', limitedReason: 'private_only', targetLabel: 'joesbakery' });
    try {
      const media = t.file(alice, 'vid-tt-4', MP4, 'video/mp4');
      const post = await t.post(alice, { platform: 'tiktok', format: 'video', media });
      await publishAndWait(alice, post);
      expect(t.social.callsTo('POST', '/v2/post/publish/video/init/')[0].body.post_info.privacy_level).toBe('SELF_ONLY');
    } finally {
      t.impl.statuses.splice(3, 1, { platform: 'tiktok', state: 'connected', targetLabel: 'joesbakery', targetKind: 'tt_account' });
    }
  });

  it('refuses a privacy TikTok didn’t offer, and a text-only post', async () => {
    const media = t.file(alice, 'vid-tt-5', MP4, 'video/mp4');
    const post = await t.post(alice, { platform: 'tiktok', format: 'video', media });
    expect((await t.publish(alice, post, { privacy: 'FOLLOWER_OF_CREATOR' })).body.code).toBe('BAD_REQUEST');
    const text = await t.post(alice, { platform: 'tiktok' });
    expect((await t.publish(alice, text)).body.code).toBe('MEDIA_UNSUPPORTED');
  });
});

describe('LinkedIn', () => {
  it('initializes the image upload, PUTs the bytes straight to uploadUrl, then posts with the image urn', async () => {
    const media = t.file(alice, 'img-li-1', PNG, 'image/png');
    const post = await t.post(alice, { platform: 'linkedin', media, caption: 'Hiring (bakers)!' });
    const r = await publishAndWait(alice, post);
    const job = await jobOf(alice, r.body.job.id);
    expect(job.state).toBe('sent');
    expect(job.url).toMatch(/^https:\/\/www\.linkedin\.com\/feed\/update\/urn%3Ali%3Ashare%3A/);
    const init = t.impl.proxyCalls.find((c) => c.path === '/rest/images');
    expect(init).toMatchObject({ method: 'POST', oneShot: true, query: { action: 'initializeUpload' }, headers: { 'nango-proxy-linkedin-version': '202610', 'nango-proxy-x-restli-protocol-version': '2.0.0' } });
    const put = t.social.calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({ via: 'direct', bodyLength: PNG.length });
    expect(put.headers.authorization).toBeUndefined();
    const created = t.social.callsTo('POST', '/rest/posts')[0].body;
    expect(created).toMatchObject({ author: 'urn:li:person:aBcD123xyz', commentary: 'Hiring \\(bakers\\)!\n\n{hashtag|\\#|bakery}', content: { media: { id: expect.stringMatching(/^urn:li:image:/) } } });
    assertProxyRules();
  });

  it('a member post that ends unknown has no automatic check: Check again makes no call', async () => {
    const post = await t.post(alice, { platform: 'linkedin' });
    t.social.fail({ path: '/rest/posts', method: 'POST', mode: '500_after_create' });
    const r = await publishAndWait(alice, post);
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'unknown', checkable: false });
    const before = t.social.calls.length;
    const c = await t.call(alice, 'POST', `/api/posting/jobs/${job.id}/check`, {});
    expect(c.status).toBe(200);
    expect(c.body.job).toEqual(job);
    expect(t.social.calls.length).toBe(before);
  });
});

describe('X', () => {
  it('uploads the photo, posts, replies with the first comment, and records the estimated X cost', async () => {
    const media = t.file(alice, 'img-x-1', PNG, 'image/png');
    const post = await t.post(alice, { platform: 'x', media, caption: 'Croissants are back', linkPlacement: 'comment', firstComment: 'Order: https://joes.example/order' });
    const r = await publishAndWait(alice, post);
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'sent', comment: 'added' });
    expect(job.url).toMatch(/^https:\/\/x\.com\/i\/web\/status\/\d+$/);
    expect(t.impl.proxyCalls.map((c) => `${c.method} ${c.path} ${c.baseUrlOverride}`)).toEqual(['POST /2/media/upload https://api.x.com', 'POST /2/tweets https://api.x.com', 'POST /2/tweets https://api.x.com']);
    const tweets = t.social.callsTo('POST', '/2/tweets').map((c) => c.body);
    expect(tweets[0]).toEqual({ text: 'Croissants are back\n\n#bakery', media: { media_ids: [expect.stringMatching(/^\d+$/)] } });
    expect(tweets[1]).toEqual({ text: 'Order: https://joes.example/order', reply: { in_reply_to_tweet_id: job.url.split('/').pop() } });
    const ledger = await t.db.select('usage_ledger', { call_id: job.id }, { order: 'id.asc' });
    expect(ledger.map((x) => [x.vendor, Number(x.cost_micro), x.estimated])).toEqual([
      ['nango', 0, false],
      ['x', 15000, true],
      ['x', 200000, true],
    ]);
    assertProxyRules();
  });

  it('a timeout after the post was created gives unknown, with exactly one create call; Check again finds it', async () => {
    const post = await t.post(alice, { platform: 'x', caption: 'Timeout test post' });
    t.social.fail({ path: '/2/tweets', method: 'POST', mode: 'timeout', delayMs: 10_000 });
    const r = await publishAndWait(alice, post);
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
    expect(job.errorMessage).toMatch(/couldn’t confirm/);
    expect(t.social.callsTo('POST', '/2/tweets')).toHaveLength(1);
    expect(t.impl.proxyCalls.filter((c) => c.path === '/2/tweets')).toHaveLength(1);

    // reading the job is a database read only
    const before = t.social.calls.length;
    expect((await t.call(alice, 'GET', `/api/posting/jobs/${job.id}`)).body.job.state).toBe('unknown');
    expect(t.social.calls.length).toBe(before);

    // Check again: reads only, finds the post
    const c = await t.call(alice, 'POST', `/api/posting/jobs/${job.id}/check`, {});
    expect(c.status).toBe(200);
    expect(c.body.job).toMatchObject({ state: 'sent', url: expect.stringMatching(/^https:\/\/x\.com\//) });
    const after = t.social.calls.slice(before);
    expect(after.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /2/users/me', expect.stringMatching(/^GET \/2\/users\/\d+\/tweets$/)]);
    expect(t.social.callsTo('POST', '/2/tweets')).toHaveLength(1);
    const checks = await t.db.select('usage_ledger', { call_id: job.id, endpoint: 'x:GET /2/users/{id}/tweets' });
    expect(checks).toHaveLength(1);
    expect(checks[0].estimated).toBe(true);
  });

  it('a 400 from X gives failed', async () => {
    const post = await t.post(alice, { platform: 'x', caption: 'Refused post' });
    t.social.fail({ path: '/2/tweets', method: 'POST', mode: '400' });
    const r = await publishAndWait(alice, post);
    expect(await jobOf(alice, r.body.job.id)).toMatchObject({ state: 'failed', errorCode: 'REFUSED' });
    expect(t.social.callsTo('POST', '/2/tweets')).toHaveLength(1);
  });

  it('the 21st X post of the day answers 429 CUSTOMER_CAP; the estimates don’t touch other caps', async () => {
    const carol = await t.user('carol@example.com');
    await t.project(carol);
    for (let i = 0; i < 20; i++) {
      const p = await t.post(carol, { platform: 'x', caption: `Post number ${i}` });
      expect((await t.publish(carol, p)).status).toBe(200);
    }
    await t.settled();
    const p21 = await t.post(carol, { platform: 'x', caption: 'One too many' });
    const r = await t.publish(carol, p21);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: 'CUSTOMER_CAP', period: 'day' });
    expect(t.social.callsTo('POST', '/2/tweets')).toHaveLength(20);
    // other networks still post (their own 50 a day)
    const fb = await t.post(carol, { platform: 'facebook', caption: 'Still fine on Facebook' });
    expect((await t.publish(carol, fb)).status).toBe(200);
    await t.settled();
    const rows = await t.db.select('usage_ledger', { user_id: carol.id, vendor: 'x' });
    expect(rows.every((x) => x.estimated === true && x.feature === 'posting')).toBe(true);
  });
});

describe('YouTube', () => {
  it('opens a resumable session through the proxy and PUTs the bytes straight to it', async () => {
    const media = t.file(alice, 'vid-yt-1', MP4, 'video/mp4');
    const post = await t.post(alice, { platform: 'x', format: 'video', media, headline: 'How we bake', caption: 'A look inside' });
    const r = await publishAndWait(alice, post, { platform: 'youtube', privacy: 'unlisted' });
    expect(r.status).toBe(200);
    const job = await jobOf(alice, r.body.job.id);
    expect(job).toMatchObject({ state: 'sent', platform: 'youtube', url: expect.stringMatching(/^https:\/\/www\.youtube\.com\/watch\?v=/) });
    const session = t.impl.proxyCalls.find((c) => c.path === '/upload/youtube/v3/videos');
    expect(session).toMatchObject({ method: 'POST', oneShot: true, query: { uploadType: 'resumable', part: 'snippet,status' } });
    expect(t.social.callsTo('POST', '/upload/youtube/v3/videos')[0].body).toMatchObject({ snippet: { title: 'How we bake', tags: ['bakery'] }, status: { privacyStatus: 'unlisted' } });
    expect(t.social.calls.find((c) => c.method === 'PUT')).toMatchObject({ via: 'direct', bodyLength: MP4.length });
    assertProxyRules();
  });

  it('refuses a post with no video', async () => {
    const post = await t.post(alice, { platform: 'x', caption: 'No video' });
    expect((await t.publish(alice, post, { platform: 'youtube' })).body.code).toBe('POST_CHANGED');
  });
});

describe('the job', () => {
  it('a second publish of the same post answers 409 ALREADY_PUBLISHING with the job; the same clientRequestId gives the same job', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Once only' });
    const clientRequestId = crypto.randomUUID();
    const a = await t.publish(alice, post, { clientRequestId });
    const again = await t.publish(alice, post, { clientRequestId });
    expect(again.status).toBe(200);
    expect(again.body.job.id).toBe(a.body.job.id);
    await t.settled();
    const b = await t.publish(alice, post);
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ code: 'ALREADY_PUBLISHING', job: { id: a.body.job.id, state: 'sent' } });
    expect(t.social.callsTo('POST', '/v26.0/1029384756/feed')).toHaveLength(1);
  });

  it('refuses a post whose text changed since it was saved (POST_CHANGED), and an unconfirmed request', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Saved text' });
    const r = await t.publish(alice, post, { content: { text: 'Different text the screen still shows' } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('POST_CHANGED');
    expect((await t.publish(alice, post, { confirm: false })).status).toBe(400);
    expect(t.social.calls).toHaveLength(0);
  });

  it('a 5xx after the post was created gives unknown (no second create); Check again finds it on the Page', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Created then 500' });
    t.social.fail({ path: '/v26.0/1029384756/feed', method: 'POST', mode: '500_after_create' });
    const r = await publishAndWait(alice, post);
    const job = await jobOf(alice, r.body.job.id);
    expect(job.state).toBe('unknown');
    expect(t.social.callsTo('POST', '/v26.0/1029384756/feed')).toHaveLength(1);
    const c = await t.call(alice, 'POST', `/api/posting/jobs/${job.id}/check`, {});
    expect(c.body.job.state).toBe('sent');
    expect(t.social.callsTo('POST', '/v26.0/1029384756/feed')).toHaveLength(1);
    const read = t.social.callsTo('GET', '/v26.0/1029384756/feed')[0];
    expect(read).toMatchObject({ via: 'direct', query: { fields: 'id,message,created_time', limit: '10' } });
  });

  it('Check again does one read, and a second press within 30 s answers 429', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Not there yet' });
    t.social.fail({ path: '/v26.0/1029384756/feed', method: 'POST', mode: '500' });
    const r = await publishAndWait(alice, post);
    expect((await jobOf(alice, r.body.job.id)).state).toBe('unknown');
    const before = t.social.calls.length;
    const c1 = await t.call(alice, 'POST', `/api/posting/jobs/${r.body.job.id}/check`, {});
    expect(c1.body.job).toMatchObject({ state: 'unknown', checkedAt: expect.any(String) });
    // reads only: the Page token (through the proxy) and the Page's feed (direct)
    const checked = t.social.calls.slice(before).map((c) => `${c.via} ${c.method} ${c.path}`);
    expect(checked).toEqual(['proxy GET /v26.0/1029384756', 'direct GET /v26.0/1029384756/feed']);
    const c2 = await t.call(alice, 'POST', `/api/posting/jobs/${r.body.job.id}/check`, {});
    expect(c2.status).toBe(429);
    expect(c2.body).toMatchObject({ code: 'RATE_LIMITED', nextAt: expect.any(String) });
    expect(t.social.calls.length - before).toBe(2);
    t.clock.t += 31_000;
    expect((await t.call(alice, 'POST', `/api/posting/jobs/${r.body.job.id}/check`, {})).status).toBe(200);
  });

  it('a `sending` job older than 180 s becomes unknown on read and on startup, with no network call', async () => {
    const base = { user_id: alice.id, project_id: 'proj-1', platform: 'facebook', state: 'sending', provider_ref: {} };
    const old = new Date(t.clock.t - 200_000).toISOString();
    const a = { ...base, id: crypto.randomUUID(), post_id: 'stuck-a', client_request_id: crypto.randomUUID(), requested_at: old };
    const b = { ...base, id: crypto.randomUUID(), post_id: 'stuck-b', client_request_id: crypto.randomUUID(), requested_at: old };
    const fresh = { ...base, id: crypto.randomUUID(), post_id: 'fresh-c', client_request_id: crypto.randomUUID(), requested_at: new Date(t.clock.t - 10_000).toISOString() };
    await t.db.insert('post_publish_jobs', [a, b, fresh]);
    expect(await jobOf(alice, a.id)).toMatchObject({ state: 'unknown', errorCode: 'INTERRUPTED' });
    await t.routes.onStart();
    expect((await t.jobRow(b.id)).state).toBe('unknown');
    expect((await t.jobRow(fresh.id)).state).toBe('sending');
    expect(t.social.calls).toHaveLength(0);
    expect(t.impl.proxyCalls).toHaveLength(0);
  });

  it('lists a business’s jobs, newest first', async () => {
    const r = await t.call(alice, 'GET', '/api/posting/jobs?projectId=proj-1');
    expect(r.status).toBe(200);
    expect(r.body.jobs.length).toBeGreaterThan(3);
    const times = r.body.jobs.map((j) => j.requestedAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(JSON.stringify(r.body)).not.toMatch(/user_id|provider_ref|containerId|publishId/);
  });
});

describe('ownership and access', () => {
  it('someone else’s post, job and business all answer 404', async () => {
    const post = await t.post(alice, { platform: 'facebook', caption: 'Alice only' });
    const r = await publishAndWait(alice, post);
    const id = r.body.job.id;
    expect((await t.call(bob, 'GET', `/api/posting/jobs/${id}`)).status).toBe(404);
    expect((await t.call(bob, 'POST', `/api/posting/jobs/${id}/check`, {})).status).toBe(404);
    const list = await t.call(bob, 'GET', '/api/posting/jobs?projectId=proj-1');
    expect(list.status).toBe(200);
    expect(list.body.jobs.find((j) => j.id === id)).toBeUndefined();
    expect((await t.call(bob, 'GET', '/api/posting/jobs?projectId=nope')).status).toBe(404);
    const stolen = await t.publish(bob, post);
    expect(stolen.status).toBe(404);
    // and a file of Alice's can't be posted by Bob
    t.file(alice, 'img-alice', PNG, 'image/png');
    const bobPost = await t.post(bob, { platform: 'facebook', media: { id: 'img-alice', kind: 'image', mime: 'image/png' } });
    expect((await t.publish(bob, bobPost)).body.code).toBe('MEDIA_UNSUPPORTED');
  });

  it('needs a sign-in, and a connected account', async () => {
    expect((await t.call(null, 'GET', '/api/posting/jobs?projectId=proj-1')).status).toBe(401);
    const post = await t.post(alice, { platform: 'instagram' });
    t.impl.statuses.splice(1, 1, { platform: 'instagram', state: 'not_connected' });
    try {
      const r = await t.publish(alice, post);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('NOT_CONNECTED');
    } finally {
      t.impl.statuses.splice(1, 1, { platform: 'instagram', state: 'connected', targetLabel: '@joesbakery', targetKind: 'ig_account' });
    }
    const re = await t.post(alice, { platform: 'facebook' });
    t.impl.statuses.splice(0, 1, { platform: 'facebook', state: 'needs_reconnect', targetLabel: 'Joe’s Bakery' });
    try {
      expect((await t.publish(alice, re)).body.code).toBe('NEEDS_RECONNECT');
    } finally {
      t.impl.statuses.splice(0, 1, { platform: 'facebook', state: 'connected', targetLabel: 'Joe’s Bakery', targetKind: 'fb_page' });
    }
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
      expect(off.social.calls).toHaveLength(0);
    } finally {
      await off.close();
    }
  });
});

describe('TikTok when TikTok fetches the file itself', () => {
  it('a photo post goes by PULL_FROM_URL with the link in the body; an init that times out is unknown, never resent', async () => {
    const pull = await startPosting({ env: { TIKTOK_UPLOAD_MODE: 'PULL_FROM_URL' } });
    try {
      const u = await pull.user('erin@example.com');
      await pull.project(u);
      const media = pull.file(u, 'img-tt-1', JPEG, 'image/jpeg');
      const post = await pull.post(u, { platform: 'tiktok', media });
      const r = await pull.publish(u, post);
      await pull.settled();
      expect((await pull.call(u, 'GET', `/api/posting/jobs/${r.body.job.id}`)).body.job.state).toBe('sent');
      const init = pull.social.callsTo('POST', '/v2/post/publish/content/init/')[0];
      expect(init.query).toEqual({});
      expect(init.body).toMatchObject({ post_mode: 'DIRECT_POST', media_type: 'PHOTO', source_info: { source: 'PULL_FROM_URL', photo_images: [expect.stringMatching(/^https:\/\/app\.test\/api\/media\/public\//)] } });

      const video = pull.file(u, 'vid-tt-pull', MP4, 'video/mp4');
      const vpost = await pull.post(u, { platform: 'tiktok', format: 'video', media: video });
      pull.social.fail({ path: '/v2/post/publish/video/init/', method: 'POST', mode: 'timeout', delayMs: 10_000 });
      const v = await pull.publish(u, vpost);
      await pull.settled();
      expect((await pull.call(u, 'GET', `/api/posting/jobs/${v.body.job.id}`)).body.job.state).toBe('unknown');
      expect(pull.social.callsTo('POST', '/v2/post/publish/video/init/')).toHaveLength(1);
      expect(pull.social.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    } finally {
      await pull.close();
    }
  });
});
