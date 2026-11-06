// Connected accounts through Zernio (server/connections/zernio.mjs + server/zernio.mjs) against
// server/test/mock-zernio.mjs: one profile per customer (externalId = the customer tag), white-label connect links,
// isolation per user and per business, signed webhooks routed by externalId, own stats and ad results, one-attempt
// posting with unknown outcomes checked by a read, the key kept out of logs, and the monthly account counts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createZernioConnections } from './zernio.mjs';
import { createConnections } from './index.mjs';
import { createZernioClient, zernioBase, ZERNIO_BASE_URL } from '../zernio.mjs';
import { customerTag, sha256 } from '../integrations/common.mjs';
import { createMockZernio, signWebhook, TEST_ZERNIO_KEY, TEST_ZERNIO_WEBHOOK_SECRET } from '../test/mock-zernio.mjs';
import { makeDb, makeLog, makeStorage } from '../test/fakes.mjs';

const ALICE = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';
const BOB = '7d1e2b3c-4a5f-4b6c-8d7e-9f0a1b2c3d4e';
const TAG_SECRET = 'test-customer-tag-secret-0123456789';

let mock;
beforeAll(async () => {
  mock = await createMockZernio().start();
});
afterAll(async () => {
  await mock.close();
});

function setup({ env = {}, now } = {}) {
  const storage = makeStorage();
  const db = makeDb();
  const log = makeLog();
  const fullEnv = { ZERNIO_API_KEY: TEST_ZERNIO_KEY, ZERNIO_WEBHOOK_SECRET: TEST_ZERNIO_WEBHOOK_SECRET, ZERNIO_BASE_URL: mock.apiBase, ZERNIO_RPM: '10000', CUSTOMER_TAG_SECRET: TAG_SECRET, GSC_APP_PROPERTY: 'https://yourlocalbusiness.replit.app/', ...env };
  const impl = createZernioConnections({ env: fullEnv, storage, db, log, ...(now ? { now } : {}) });
  return { impl, connections: createConnections(impl), storage, db, log, env: fullEnv };
}

/** Connect a network for a user the way a customer does: the link, then Zernio's account.connected webhook. */
async function connectVia(t, userId, platform, { projectId, username = 'joesbakery', ads = false, zPlatform } = {}) {
  const link = await t.connections.connectLink(userId, platform, projectId ? { projectId } : {});
  const doc = (await t.storage.get(`zernio:user:${sha256(userId)}`)).value;
  const account = mock.addAccount({ platform: zPlatform ?? platform, profileId: doc.profileId, username });
  const evt = mock.signed({ event: 'account.connected', profiles: mock.profileRef(doc.profileId), account: { accountId: account._id, profileId: doc.profileId, platform: zPlatform ?? platform, username, displayName: `${username} page` } });
  const res = await t.impl.webhook(evt.raw, evt.headers);
  expect(res.status).toBe(200);
  void ads;
  return { link, account, profileId: doc.profileId };
}

describe('the client (server/zernio.mjs)', () => {
  it('uses Zernio’s base unless a local test base or an https one is given', () => {
    expect(zernioBase({})).toBe(ZERNIO_BASE_URL);
    expect(zernioBase({ ZERNIO_BASE_URL: 'http://evil.example/api/v1' })).toBe(ZERNIO_BASE_URL);
    expect(zernioBase({ ZERNIO_BASE_URL: 'http://127.0.0.1:9/api/v1' })).toBe('http://127.0.0.1:9/api/v1');
  });

  it('sends the key only in Authorization, and never logs it', async () => {
    const log = makeLog();
    const client = createZernioClient({ env: { ZERNIO_API_KEY: TEST_ZERNIO_KEY, ZERNIO_BASE_URL: mock.apiBase }, log });
    const before = mock.calls.length;
    const res = await client.call('GET', '/accounts/ffffffffffffffffffffffff', {});
    expect(res.status).toBe(404);
    const call = mock.calls[before];
    expect(call.auth).toBe('bearer');
    expect(JSON.stringify(call.query)).not.toContain(TEST_ZERNIO_KEY);
    expect(log.text()).not.toContain(TEST_ZERNIO_KEY);
    expect(log.text()).not.toContain('ffffffffffffffffffffffff');
  });

  it('checks the webhook signature on the exact bytes, with the current or previous secret', () => {
    const client = createZernioClient({ env: { ZERNIO_API_KEY: 'k', ZERNIO_WEBHOOK_SECRET: 'new-secret', ZERNIO_WEBHOOK_SECRET_PREVIOUS: TEST_ZERNIO_WEBHOOK_SECRET } });
    const raw = Buffer.from('{"event":"webhook.test"}');
    expect(client.verifySignature(raw, signWebhook(raw, 'new-secret'))).toBe(true);
    expect(client.verifySignature(raw, signWebhook(raw))).toBe(true);
    expect(client.verifySignature(Buffer.from('{"event":"webhook.test" }'), signWebhook(raw, 'new-secret'))).toBe(false);
    expect(client.verifySignature(raw, 'nope')).toBe(false);
  });
});

describe('profiles and connect links', () => {
  it('makes one profile per customer with externalId = the customer tag, and finds it again (never a second)', async () => {
    const t = setup();
    const link = await t.connections.connectLink(ALICE, 'instagram');
    expect(link.connectLink).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__connect\?platform=instagram/);
    const tag = customerTag(ALICE, t.env);
    const mine = mock.profiles.filter((p) => p.externalId === tag);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).not.toMatch(/@/);
    // a second connect, and a fresh server with no stored profile id, both use the same profile
    await t.connections.connectLink(ALICE, 'facebook');
    const t2 = setup();
    await t2.connections.connectLink(ALICE, 'tiktok');
    expect(mock.profiles.filter((p) => p.externalId === tag)).toHaveLength(1);
  });

  it('asks for the white-label welcome screen with our brand and the app as the redirect', async () => {
    const t = setup({ env: { ZERNIO_BRAND_NAME: 'Joe’s Toolkit', ZERNIO_BRAND_LOGO_URL: 'https://cdn.example/logo.png', ZERNIO_BRAND_COLOR: '#1D4ED8' } });
    const before = mock.calls.length;
    await t.connections.connectLink(ALICE, 'linkedin');
    const call = mock.calls.slice(before).find((c) => c.path === '/api/v1/connect/linkedin');
    expect(call.query).toMatchObject({ welcome: 'true', brandName: 'Joe’s Toolkit', logoUrl: 'https://cdn.example/logo.png', primaryColor: '#1D4ED8', redirect_url: 'https://yourlocalbusiness.replit.app/?connected=linkedin' });
    expect(call.query.profileId).toMatch(/^[0-9a-f]{24}$/);
  });

  it('connects ad accounts through the ads connect, and needs the X account before X Ads', async () => {
    const t = setup();
    const before = mock.calls.length;
    await t.connections.connectLink(ALICE, 'google_ads');
    await t.connections.connectLink(ALICE, 'meta_ads');
    const paths = mock.calls.slice(before).map((c) => c.path);
    expect(paths).toContain('/api/v1/connect/googleads/ads');
    expect(paths).toContain('/api/v1/connect/facebook/ads');
    await expect(t.connections.connectLink(ALICE, 'x_ads')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('shows Pinterest as coming soon and refuses to connect it', async () => {
    const t = setup();
    const list = await t.connections.status(ALICE);
    expect(list.find((s) => s.platform === 'pinterest').state).toBe('coming_soon');
    await expect(t.connections.connectLink(ALICE, 'pinterest')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('is not set up without the webhook secret or the tag secret, and says which Secret (names only)', async () => {
    const t = setup({ env: { ZERNIO_WEBHOOK_SECRET: '' } });
    expect(t.impl.setUp).toBe(false);
    expect(t.impl.hint).toContain('ZERNIO_WEBHOOK_SECRET');
    expect(t.impl.hint).not.toContain(TEST_ZERNIO_KEY);
    await expect(t.connections.connectLink(ALICE, 'facebook')).rejects.toMatchObject({ code: 'NOT_SET_UP' });
  });
});

describe('accounts, isolation and choices', () => {
  it('a connected account shows as connected with its label; the browser never sees a Zernio id', async () => {
    const t = setup();
    const { account } = await connectVia(t, ALICE, 'facebook');
    const fb = (await t.connections.status(ALICE)).find((s) => s.platform === 'facebook');
    expect(fb).toMatchObject({ state: 'connected', targetLabel: 'joesbakery page', targetKind: 'fb_page' });
    expect(JSON.stringify(await t.connections.status(ALICE))).not.toContain(account._id);
    const targets = await t.connections.targets(ALICE, 'facebook');
    expect(targets[0].id).toMatch(/^tgt_[0-9a-f]{32}$/);
    expect(JSON.stringify(targets)).not.toContain(account._id);
  });

  it('keeps users apart: a webhook for one customer never changes another’s accounts', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const bob = await t.connections.status(BOB);
    expect(bob.find((s) => s.platform === 'instagram').state).toBe('not_connected');
    // Bob's handle for Alice's account is refused
    await t.connections.connectLink(BOB, 'instagram');
    const aliceTarget = (await t.connections.targets(ALICE, 'instagram'))[0].id;
    await expect(t.connections.setTarget(BOB, 'instagram', aliceTarget)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('lets each business choose its own account; the business that connected gets the new one', async () => {
    const t = setup();
    const a = await connectVia(t, ALICE, 'facebook', { projectId: 'bakery', username: 'bakery' });
    const b = await connectVia(t, ALICE, 'facebook', { projectId: 'gym', username: 'gym' });
    const forBakery = (await t.connections.status(ALICE, { projectId: 'bakery' })).find((s) => s.platform === 'facebook');
    const forGym = (await t.connections.status(ALICE, { projectId: 'gym' })).find((s) => s.platform === 'facebook');
    expect(forBakery).toMatchObject({ targetLabel: 'bakery page', targetsAvailable: 2 });
    expect(forGym).toMatchObject({ targetLabel: 'gym page', targetsAvailable: 2 });
    // the default (any other business) is the first connected
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'facebook').targetLabel).toBe('bakery page');
    // the gym switches to the bakery's page: only the gym changes
    const bakeryHandle = (await t.connections.targets(ALICE, 'facebook')).find((x) => x.label === 'bakery page').id;
    await t.connections.setTarget(ALICE, 'facebook', bakeryHandle, { projectId: 'gym' });
    expect((await t.connections.status(ALICE, { projectId: 'gym' })).find((s) => s.platform === 'facebook').targetLabel).toBe('bakery page');
    void a;
    void b;
  });

  it('check reads the accounts back; an inactive one needs a reconnect, and reconnect names it', async () => {
    const t = setup();
    const { account } = await connectVia(t, ALICE, 'tiktok');
    account.isActive = false;
    const st = await t.connections.check(ALICE, 'tiktok');
    expect(st.state).toBe('needs_reconnect');
    const before = mock.calls.length;
    await t.connections.reconnectLink(ALICE, 'tiktok');
    expect(mock.calls.slice(before).find((c) => c.path === '/api/v1/connect/tiktok').query.reconnectAccountId).toBe(account._id);
  });

  it('disconnect removes the chosen account at Zernio, once', async () => {
    const t = setup();
    const { account } = await connectVia(t, ALICE, 'youtube');
    const before = mock.calls.length;
    await t.connections.disconnect(ALICE, 'youtube');
    expect(mock.calls.slice(before).filter((c) => c.method === 'DELETE')).toEqual([expect.objectContaining({ path: `/api/v1/accounts/${account._id}` })]);
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'youtube').state).toBe('not_connected');
  });
});

describe('the webhook', () => {
  it('refuses a bad signature without reading anything', async () => {
    const t = setup();
    const evt = mock.signed({ event: 'account.connected' }, 'wrong-secret');
    const calls = t.db.calls.length;
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(401);
    expect(t.db.calls.length).toBe(calls);
  });

  it('applies an event once (dedupe by event id) and ignores events for profiles that aren’t ours', async () => {
    const t = setup();
    await t.connections.connectLink(ALICE, 'x');
    const doc = (await t.storage.get(`zernio:user:${sha256(ALICE)}`)).value;
    const acct = mock.addAccount({ platform: 'twitter', profileId: doc.profileId, username: 'joe' });
    const evt = mock.signed({ event: 'account.connected', profiles: mock.profileRef(doc.profileId), account: { accountId: acct._id, platform: 'twitter', username: 'joe' } });
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    expect((await t.impl.webhook(evt.raw, evt.headers)).body).toMatchObject({ duplicate: true });
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'x').state).toBe('connected');
    const stranger = mock.signed({ event: 'account.connected', profiles: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', externalId: 'cust_000000000000000000000000' }], account: { accountId: 'bbbbbbbbbbbbbbbbbbbbbbbb', platform: 'facebook' } });
    expect((await t.impl.webhook(stranger.raw, stranger.headers)).status).toBe(200);
    expect((await t.connections.status(BOB)).find((s) => s.platform === 'facebook').state).toBe('not_connected');
  });

  it('an unintentional disconnect asks for a reconnect; an intentional one removes the account', async () => {
    const t = setup();
    const { account, profileId } = await connectVia(t, ALICE, 'linkedin');
    const lost = mock.signed({ event: 'account.disconnected', disconnectionType: 'token_expired', profiles: mock.profileRef(profileId), account: { accountId: account._id, platform: 'linkedin' } });
    await t.impl.webhook(lost.raw, lost.headers);
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'linkedin').state).toBe('needs_reconnect');
    const gone = mock.signed({ event: 'account.disconnected', disconnectionType: 'intentional', profiles: mock.profileRef(profileId), account: { accountId: account._id, platform: 'linkedin' } });
    await t.impl.webhook(gone.raw, gone.headers);
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'linkedin').state).toBe('not_connected');
  });

  it('routes a post event to the job named in the post’s metadata', async () => {
    const t = setup();
    const { profileId } = await connectVia(t, ALICE, 'facebook');
    const seen = [];
    t.impl.setPostListener((userId, jobId, outcome) => seen.push({ userId, jobId, outcome }));
    const jobId = '11111111-2222-4333-8444-555555555555';
    const evt = mock.signed({ event: 'post.published', profiles: mock.profileRef(profileId), post: { id: 'cccccccccccccccccccccccc', status: 'published', metadata: { ylbJob: jobId }, platforms: [{ platform: 'facebook', status: 'published', publishedUrl: 'https://facebook.com/p/1' }] } });
    await t.impl.webhook(evt.raw, evt.headers);
    expect(seen).toEqual([{ userId: ALICE, jobId, outcome: expect.objectContaining({ state: 'sent', url: 'https://facebook.com/p/1' }) }]);
  });
});

describe('own stats and ad results (reads)', () => {
  it('normalizes daily metrics, followers and top posts for the business’s account', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const got = await t.connections.insights(ALICE, 'instagram', { since: Date.parse('2026-10-03'), until: Date.parse('2026-11-02') });
    expect(got).toMatchObject({ followers: 1310, reach: 1000, views: 700, engagement: 52 + 8 + 3 + 1, postsCount: 1 });
    expect(got.series.find((d) => d.date === '2026-11-02')).toMatchObject({ followers: 1310, reach: 300 });
    expect(got.topPosts[0]).toMatchObject({ likes: 40, comments: 6, shares: 3 });
    expect(typeof got.topPosts[0].text).toBe('string');
    // each read is in the customer's ledger as a zernio row
    expect(t.db.rows('usage_ledger').every((r) => r.vendor === 'zernio' && r.customer_tag === customerTag(ALICE, t.env))).toBe(true);
  });

  it('answers null when nothing is chosen, and { kind: reconnect } when the account needs one', async () => {
    const t = setup();
    expect(await t.connections.insights(ALICE, 'tiktok', {})).toBeNull();
    const { account } = await connectVia(t, ALICE, 'tiktok');
    account.isActive = false;
    await t.connections.check(ALICE, 'tiktok');
    await expect(t.connections.insights(ALICE, 'tiktok', {})).rejects.toMatchObject({ kind: 'reconnect' });
  });

  it('reads ad results (spend, clicks, series, campaigns) for a connected ad account, and changes nothing', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads', username: 'Joe ads' });
    const before = mock.calls.length;
    const got = await t.connections.adResults(ALICE, 'meta_ads', {});
    expect(got).toMatchObject({ platform: 'meta_ads', currency: 'USD', spend: 20, clicks: 50, impressions: 4000, conversions: 3 });
    expect(got.series).toHaveLength(2);
    expect(got.campaigns[0]).toMatchObject({ id: '120200001', name: 'Autumn bread', spend: 20 });
    expect(mock.calls.slice(before).every((c) => c.method === 'GET')).toBe(true);
  });
});

describe('posting (one attempt)', () => {
  const composed = { text: 'Fresh bread today #bread', commentSupported: true, hasUrl: false };

  it('posts once with an Idempotency-Key and our job id in the metadata, and returns the post’s address', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'facebook');
    const jobId = '21111111-2222-4333-8444-555555555555';
    const out = await t.connections.publish(ALICE, 'facebook', { jobId, composed: { ...composed, comment: 'Order: https://joes.example' } });
    expect(out.state).toBe('sent');
    expect(out.url).toMatch(/^https:\/\/social\.example\/facebook\/p\//);
    const call = mock.calls.filter((c) => c.path === '/api/v1/posts' && c.method === 'POST').pop();
    expect(call.idempotencyKey).toBe(jobId);
    expect(call.body).toMatchObject({ publishNow: true, metadata: { ylbJob: jobId }, platforms: [{ platform: 'facebook', platformSpecificData: { firstComment: 'Order: https://joes.example' } }] });
    expect(mock.violations).toEqual([]);
  });

  it('uploads the file to Zernio’s storage first (no key on the upload), then posts it', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const out = await t.connections.publish(ALICE, 'instagram', { jobId: '31111111-2222-4333-8444-555555555555', composed, media: { id: 'm1.jpg', type: 'image/jpeg', size: 4, kind: 'image' }, loadMedia: async () => Buffer.from([1, 2, 3, 4]) });
    expect(out.state).toBe('sent');
    const post = mock.posts.at(-1);
    expect(post.mediaItems[0]).toMatchObject({ type: 'image' });
    expect(mock.violations).toEqual([]);
  });

  it('a refused post is failed with our code; a 5xx is unknown and nothing is sent again', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'x', { zPlatform: 'twitter' });
    mock.setPostOutcome('failed');
    const failed = await t.connections.publish(ALICE, 'x', { jobId: '41111111-2222-4333-8444-555555555555', composed });
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'REFUSED' });
    mock.setPostOutcome('error500');
    const posts = mock.calls.filter((c) => c.path === '/api/v1/posts' && c.method === 'POST').length;
    const unknown = await t.connections.publish(ALICE, 'x', { jobId: '51111111-2222-4333-8444-555555555555', composed });
    expect(unknown).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
    expect(mock.calls.filter((c) => c.path === '/api/v1/posts' && c.method === 'POST').length).toBe(posts + 1);
  });

  it('“Check again” finds a post by the job id when no post id came back (a read only)', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'linkedin');
    const jobId = '61111111-2222-4333-8444-555555555555';
    mock.setPostOutcome('accepted_then_500');
    const out = await t.connections.publish(ALICE, 'linkedin', { jobId, composed });
    expect(out.state).toBe('unknown');
    const before = mock.calls.length;
    const found = await t.connections.postStatus(ALICE, { jobId, requestedAt: new Date().toISOString(), platform: 'linkedin' });
    expect(found).toMatchObject({ found: true });
    expect(mock.calls.slice(before).every((c) => c.method === 'GET')).toBe(true);
    expect(mock.violations).toEqual([]);
  });

  it('refuses to post (failed, nothing sent) when the business has no account there', async () => {
    const t = setup();
    await t.connections.connectLink(ALICE, 'youtube');
    const posts = mock.calls.filter((c) => c.path === '/api/v1/posts').length;
    const out = await t.connections.publish(ALICE, 'youtube', { jobId: '71111111-2222-4333-8444-555555555555', composed });
    expect(out).toMatchObject({ state: 'failed', errorCode: 'NO_TARGET' });
    expect(mock.calls.filter((c) => c.path === '/api/v1/posts').length).toBe(posts);
  });
});

describe('deleting an account and the monthly counts', () => {

  it('forgetUser disconnects every account at Zernio, then reads as not connected', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'facebook');
    await connectVia(t, ALICE, 'google_ads', { zPlatform: 'googleads' });
    await t.connections.forgetUser(ALICE);
    expect((await t.connections.status(ALICE)).every((s) => s.state === 'not_connected' || s.state === 'coming_soon')).toBe(true);
  });

  it('writes one estimated connected-accounts row per customer for last month, once', async () => {
    let at = Date.parse('2026-10-10T00:00:00Z');
    const t = setup({ now: () => at });
    await connectVia(t, ALICE, 'facebook');
    await connectVia(t, ALICE, 'tiktok');
    at = Date.parse('2026-11-02T00:00:00Z');
    expect((await t.impl.meterIfDue()).rows).toBe(1);
    expect((await t.impl.meterIfDue()).skipped).toBe(true);
    const row = t.db.rows('usage_ledger').find((r) => r.feature === 'connections');
    expect(row).toMatchObject({ vendor: 'zernio', estimated: true, endpoint: 'zernio_accounts 2026-10 (2)' });
    expect(row.cost_micro).toBeGreaterThan(0);
    expect(await t.impl.accountCount(ALICE)).toBe(2);
  });

  it('never logs the API key, a connect link or an account id', async () => {
    const t = setup();
    const { account, link } = await connectVia(t, ALICE, 'facebook');
    await t.connections.publish(ALICE, 'facebook', { jobId: '81111111-2222-4333-8444-555555555555', composed: { text: 'Hi', commentSupported: true, hasUrl: false } });
    const text = t.log.text();
    expect(text).not.toContain(TEST_ZERNIO_KEY);
    expect(text).not.toContain(link.connectLink);
    expect(text).not.toContain(account._id);
  });
});
