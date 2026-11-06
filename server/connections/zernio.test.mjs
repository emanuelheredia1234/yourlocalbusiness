// Ad accounts through Zernio (server/connections/zernio.mjs + server/zernio.mjs) against server/test/mock-zernio.mjs:
// one profile per customer (externalId = the customer tag), white-label ads connect links, isolation per user and per
// business, signed account webhooks routed by externalId, ad results (reads only), the key kept out of logs, and the
// monthly ad-account counts. Social accounts, posting and social stats are Upload-Post's (uploadpost.test.mjs): this
// side refuses them.
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

  it('a write never waits long for a rate-limit slot: no slot within 15 s answers a local 429 and sends nothing', async () => {
    let clock = 1_000_000;
    const slept = [];
    const client = createZernioClient({ env: { ZERNIO_API_KEY: TEST_ZERNIO_KEY, ZERNIO_BASE_URL: mock.apiBase, ZERNIO_RPM: '1' }, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; }, log: makeLog() });
    expect((await client.call('GET', '/accounts/ffffffffffffffffffffffff')).status).toBe(404);
    const before = mock.calls.length;
    const res = await client.call('POST', '/posts', { body: { content: 'x' }, headers: { 'Idempotency-Key': 'k-rate' } });
    expect(res).toMatchObject({ status: 429, local: true });
    expect(mock.calls.length).toBe(before);
    expect(slept).toEqual([]);
    // a read waits for its slot (up to a minute) and then goes
    expect((await client.call('GET', '/accounts/ffffffffffffffffffffffff')).status).toBe(404);
    expect(slept.length).toBe(1);
    expect(mock.calls.length).toBe(before + 1);
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
    const link = await t.connections.connectLink(ALICE, 'meta_ads');
    expect(link.connectLink).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__connect\?platform=facebook&.*ads=1/);
    const tag = customerTag(ALICE, t.env);
    const mine = mock.profiles.filter((p) => p.externalId === tag);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).not.toMatch(/@/);
    // a second connect, and a fresh server with no stored profile id, both use the same profile
    await t.connections.connectLink(ALICE, 'google_ads');
    const t2 = setup();
    await t2.connections.connectLink(ALICE, 'tiktok_ads');
    expect(mock.profiles.filter((p) => p.externalId === tag)).toHaveLength(1);
  });

  it('asks for the white-label welcome screen with our brand and the app as the redirect', async () => {
    const t = setup({ env: { ZERNIO_BRAND_NAME: 'Joe’s Toolkit', ZERNIO_BRAND_LOGO_URL: 'https://cdn.example/logo.png', ZERNIO_BRAND_COLOR: '#1D4ED8' } });
    const before = mock.calls.length;
    await t.connections.connectLink(ALICE, 'linkedin_ads');
    const call = mock.calls.slice(before).find((c) => c.path === '/api/v1/connect/linkedin/ads');
    expect(call.query).toMatchObject({ welcome: 'true', brandName: 'Joe’s Toolkit', logoUrl: 'https://cdn.example/logo.png', primaryColor: '#1D4ED8', redirect_url: 'https://yourlocalbusiness.replit.app/?connected=linkedin_ads' });
    expect(call.query.profileId).toMatch(/^[0-9a-f]{24}$/);
  });

  it('connects ad accounts through the ads connect; X Ads and Pinterest are coming soon', async () => {
    const t = setup();
    const before = mock.calls.length;
    await t.connections.connectLink(ALICE, 'google_ads');
    await t.connections.connectLink(ALICE, 'meta_ads');
    const paths = mock.calls.slice(before).map((c) => c.path);
    expect(paths).toContain('/api/v1/connect/googleads/ads');
    expect(paths).toContain('/api/v1/connect/facebook/ads');
    const list = await t.connections.status(ALICE);
    expect(list.find((s) => s.platform === 'x_ads').state).toBe('coming_soon');
    expect(list.find((s) => s.platform === 'pinterest').state).toBe('coming_soon');
    await expect(t.connections.connectLink(ALICE, 'x_ads')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses social networks (they are Upload-Post’s): nothing is asked of Zernio', async () => {
    const t = setup();
    const before = mock.calls.length;
    await expect(t.connections.connectLink(ALICE, 'instagram')).rejects.toMatchObject({ status: 404 });
    expect(await t.connections.insights(ALICE, 'instagram', {})).toBeNull();
    expect(await t.connections.publish(ALICE, 'facebook', { jobId: '81111111-2222-4333-8444-555555555555', composed: { text: 'x' } })).toMatchObject({ state: 'failed' });
    expect(mock.calls.length).toBe(before);
  });

  it('is not set up without the webhook secret or the tag secret, and says which Secret (names only)', async () => {
    const t = setup({ env: { ZERNIO_WEBHOOK_SECRET: '' } });
    expect(t.impl.setUp).toBe(false);
    expect(t.impl.hint).toContain('ZERNIO_WEBHOOK_SECRET');
    expect(t.impl.hint).not.toContain(TEST_ZERNIO_KEY);
    await expect(t.connections.connectLink(ALICE, 'meta_ads')).rejects.toMatchObject({ code: 'NOT_SET_UP' });
  });
});

describe('ad accounts, isolation and choices', () => {
  it('a connected ad account shows as connected with its label; the browser never sees a Zernio id', async () => {
    const t = setup();
    const { account } = await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    const meta = (await t.connections.status(ALICE)).find((s) => s.platform === 'meta_ads');
    expect(meta).toMatchObject({ state: 'connected', targetLabel: 'joesbakery page', targetKind: 'ads_account' });
    expect(JSON.stringify(await t.connections.status(ALICE))).not.toContain(account._id);
    const targets = await t.connections.targets(ALICE, 'meta_ads');
    expect(targets[0].id).toMatch(/^tgt_[0-9a-f]{32}$/);
    expect(JSON.stringify(targets)).not.toContain(account._id);
  });

  it('keeps users apart: a webhook for one customer never changes another’s accounts', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'google_ads', { zPlatform: 'googleads' });
    expect((await t.connections.status(BOB)).find((s) => s.platform === 'google_ads').state).toBe('not_connected');
    // Bob's handle for Alice's account is refused
    await t.connections.connectLink(BOB, 'google_ads');
    const aliceTarget = (await t.connections.targets(ALICE, 'google_ads'))[0].id;
    await expect(t.connections.setTarget(BOB, 'google_ads', aliceTarget)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('lets each business choose its own ad account; the business that connected gets the new one', async () => {
    const t = setup();
    await connectVia(t, '61111111-2222-4333-8444-555555555555', 'meta_ads', { projectId: 'bakery', username: 'bakery', zPlatform: 'metaads' });
    await connectVia(t, '61111111-2222-4333-8444-555555555555', 'meta_ads', { projectId: 'gym', username: 'gym', zPlatform: 'metaads' });
    const forBakery = (await t.connections.status('61111111-2222-4333-8444-555555555555', { projectId: 'bakery' })).find((s) => s.platform === 'meta_ads');
    const forGym = (await t.connections.status('61111111-2222-4333-8444-555555555555', { projectId: 'gym' })).find((s) => s.platform === 'meta_ads');
    expect(forBakery).toMatchObject({ targetLabel: expect.stringMatching(/^bakery/), targetsAvailable: 2 });
    expect(forGym).toMatchObject({ targetLabel: expect.stringMatching(/^gym/), targetsAvailable: 2 });
    expect((await t.connections.status('61111111-2222-4333-8444-555555555555')).find((s) => s.platform === 'meta_ads').targetLabel).toMatch(/^bakery/);
    const bakeryHandle = (await t.connections.targets('61111111-2222-4333-8444-555555555555', 'meta_ads')).find((x) => x.label.startsWith('bakery')).id;
    await t.connections.setTarget('61111111-2222-4333-8444-555555555555', 'meta_ads', bakeryHandle, { projectId: 'gym' });
    expect((await t.connections.status('61111111-2222-4333-8444-555555555555', { projectId: 'gym' })).find((s) => s.platform === 'meta_ads').targetLabel).toMatch(/^bakery/);
  });

  it('check reads the accounts back; an inactive one or the needsReconnection flag needs a reconnect, and reconnect forces it', async () => {
    const t = setup();
    const { account } = await connectVia(t, ALICE, 'tiktok_ads', { zPlatform: 'tiktokads' });
    account.isActive = false;
    expect((await t.connections.check(ALICE, 'tiktok_ads')).state).toBe('needs_reconnect');
    account.isActive = true;
    account.needsReconnection = true;
    expect(await t.connections.check(ALICE, 'tiktok_ads')).toMatchObject({ state: 'needs_reconnect' });
    account.needsReconnection = false;
    expect(await t.connections.check(ALICE, 'tiktok_ads')).toMatchObject({ state: 'connected' });
    const before = mock.calls.length;
    await t.connections.reconnectLink(ALICE, 'tiktok_ads');
    expect(mock.calls.slice(before).find((c) => c.path === '/api/v1/connect/tiktok/ads').query.force).toBe('true');
  });

  it('ignores social accounts in the profile (they are Upload-Post’s)', async () => {
    const t = setup();
    const { profileId } = await connectVia(t, '62111111-2222-4333-8444-555555555555', 'google_ads', { zPlatform: 'googleads' });
    mock.addAccount({ platform: 'instagram', profileId, username: 'joe' });
    await t.connections.check('62111111-2222-4333-8444-555555555555', 'google_ads');
    expect(await t.impl.accountCount('62111111-2222-4333-8444-555555555555')).toBe(1);
    expect((await t.connections.status('62111111-2222-4333-8444-555555555555')).find((s) => s.platform === 'instagram').state).toBe('not_connected');
  });

  it('disconnect removes the chosen ad account at Zernio, once', async () => {
    const t = setup();
    const { account } = await connectVia(t, ALICE, 'microsoft_ads', { zPlatform: 'microsoftads' });
    const before = mock.calls.length;
    await t.connections.disconnect(ALICE, 'microsoft_ads');
    expect(mock.calls.slice(before).filter((c) => c.method === 'DELETE')).toEqual([expect.objectContaining({ path: `/api/v1/accounts/${account._id}` })]);
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'microsoft_ads').state).toBe('not_connected');
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
    await t.connections.connectLink(ALICE, 'reddit_ads');
    const doc = (await t.storage.get(`zernio:user:${sha256(ALICE)}`)).value;
    const acct = mock.addAccount({ platform: 'redditads', profileId: doc.profileId, username: 'joe' });
    const evt = mock.signed({ event: 'account.connected', profiles: mock.profileRef(doc.profileId), account: { accountId: acct._id, platform: 'redditads', username: 'joe' } });
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    expect((await t.impl.webhook(evt.raw, evt.headers)).body).toMatchObject({ duplicate: true });
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'reddit_ads').state).toBe('connected');
    const stranger = mock.signed({ event: 'account.connected', profiles: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', externalId: 'cust_000000000000000000000000' }], account: { accountId: 'bbbbbbbbbbbbbbbbbbbbbbbb', platform: 'metaads' } });
    expect((await t.impl.webhook(stranger.raw, stranger.headers)).status).toBe(200);
    expect((await t.connections.status(BOB)).find((s) => s.platform === 'meta_ads').state).toBe('not_connected');
  });

  it('an unintentional disconnect asks for a reconnect; an intentional one removes the account', async () => {
    const t = setup();
    const { account, profileId } = await connectVia(t, ALICE, 'linkedin_ads', { zPlatform: 'linkedinads' });
    const lost = mock.signed({ event: 'account.disconnected', profiles: mock.profileRef(profileId), account: { accountId: account._id, profileId, platform: 'linkedinads', username: 'joesbakery', disconnectionType: 'unintentional', reason: 'token expired' } });
    await t.impl.webhook(lost.raw, lost.headers);
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'linkedin_ads').state).toBe('needs_reconnect');
    const gone = mock.signed({ event: 'account.disconnected', profiles: mock.profileRef(profileId), account: { accountId: account._id, profileId, platform: 'linkedinads', username: 'joesbakery', disconnectionType: 'intentional', reason: 'Removed' } });
    await t.impl.webhook(gone.raw, gone.headers);
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'linkedin_ads').state).toBe('not_connected');
  });

  it('ignores an account event whose account sits in another profile, even when the event lists this customer', async () => {
    const t = setup();
    const { account, profileId } = await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    const other = mock.signed({ event: 'account.disconnected', profiles: mock.profileRef(profileId), account: { accountId: account._id, profileId: 'abcdefabcdefabcdefabcdef', platform: 'metaads', username: 'x', disconnectionType: 'intentional', reason: 'r' } });
    expect((await t.impl.webhook(other.raw, other.headers)).status).toBe(200);
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'meta_ads').state).toBe('connected');
  });

  it('ignores post events (posting is Upload-Post’s)', async () => {
    const t = setup();
    const { profileId } = await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    const evt = mock.signed({ event: 'post.published', profiles: mock.profileRef(profileId), post: { id: 'cccccccccccccccccccccccc', status: 'published', metadata: { ylbJob: '11111111-2222-4333-8444-555555555555' } } });
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    expect(t.impl.setPostListener).toBeUndefined();
  });
});

describe('ad results (reads)', () => {
  it('reads ad results (spend, clicks, series, campaigns) for a connected ad account, and changes nothing', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads', username: 'Joe ads' });
    const before = mock.calls.length;
    const got = await t.connections.adResults(ALICE, 'meta_ads', {});
    expect(got).toMatchObject({ platform: 'meta_ads', currency: 'USD', spend: 20, clicks: 50, impressions: 4000, conversions: 3 });
    expect(got.series).toHaveLength(2);
    expect(got.campaigns[0]).toMatchObject({ id: '120200001', name: 'Autumn bread', spend: 20 });
    expect(mock.calls.slice(before).every((c) => c.method === 'GET')).toBe(true);
    expect(t.db.rows('usage_ledger').every((r) => r.vendor === 'zernio' && r.feature === 'ads' && r.customer_tag === customerTag(ALICE, t.env))).toBe(true);
  });

  it('answers null when nothing is chosen, and { kind: reconnect } when the account needs one', async () => {
    const t = setup();
    expect(await t.connections.adResults('63111111-2222-4333-8444-555555555555', 'google_ads', {})).toBeNull();
    const { account } = await connectVia(t, '63111111-2222-4333-8444-555555555555', 'google_ads', { zPlatform: 'googleads' });
    account.isActive = false;
    await t.connections.check('63111111-2222-4333-8444-555555555555', 'google_ads');
    await expect(t.connections.adResults('63111111-2222-4333-8444-555555555555', 'google_ads', {})).rejects.toMatchObject({ kind: 'reconnect' });
  });
});

describe('deleting an account and the monthly counts', () => {
  it('forgetUser disconnects every account in the customer’s profile (the hidden Facebook account Meta Ads made too), then deletes the profile, then reads as not connected', async () => {
    const t = setup();
    const { profileId } = await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    await connectVia(t, ALICE, 'google_ads', { zPlatform: 'googleads' });
    const hidden = mock.addAccount({ platform: 'facebook', profileId, username: 'joe', enabled: false });
    await t.connections.forgetUser(ALICE);
    expect(mock.accounts.filter((a) => a.profileId === profileId)).toEqual([]);
    expect(mock.accounts.some((a) => a._id === hidden._id)).toBe(false);
    expect(mock.profiles.some((p) => p._id === profileId)).toBe(false);
    expect((await t.connections.status(ALICE)).every((s) => s.state === 'not_connected' || s.state === 'coming_soon')).toBe(true);
  });

  it('disconnecting Meta Ads also removes the hidden Facebook account its classic connect made (it holds the customer’s token)', async () => {
    const t = setup();
    const USER = '64111111-2222-4333-8444-555555555555';
    await t.connections.connectLink(USER, 'meta_ads');
    const profileId = (await t.storage.get(`zernio:user:${sha256(USER)}`)).value.profileId;
    const res = await fetch(`${mock.base}/__complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'facebook', profileId, ads: true, hiddenParent: true }) });
    const { account } = await res.json();
    await t.connections.check(USER, 'meta_ads');
    const parent = mock.accounts.find((a) => a._id === account.parentAccountId);
    expect(parent).toMatchObject({ platform: 'facebook', enabled: false });
    await t.connections.disconnect(USER, 'meta_ads');
    expect(mock.accounts.some((a) => a._id === account._id || a._id === parent._id)).toBe(false);
  });

  it('writes one estimated ad-accounts row per customer for last month, once', async () => {
    let at = Date.parse('2026-10-10T00:00:00Z');
    const t = setup({ now: () => at });
    await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    await connectVia(t, ALICE, 'tiktok_ads', { zPlatform: 'tiktokads' });
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
    const { account, link } = await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    await t.connections.adResults(ALICE, 'meta_ads', {});
    const text = t.log.text();
    expect(text).not.toContain(TEST_ZERNIO_KEY);
    expect(text).not.toContain(link.connectLink);
    expect(text).not.toContain(account._id);
  });
});

describe('ad events go to the ads side (server/ads/webhook.mjs)', () => {
  const adEvent = (profileId, accountId, extra = {}) => mock.signed({ event: 'ad.review.rejected', profiles: mock.profileRef(profileId), account: { accountId, profileId, platform: 'metaads' }, adObject: { level: 'AD', platformId: '120200000000001', platformAdAccountId: 'act_1', adId: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'x' }, review: { status: 'rejected', raw: 'DISAPPROVED', reasons: [] }, ...extra });

  it('hands an event about one of the customer’s own connections to the listener, once per event id', async () => {
    const t = setup();
    const got = [];
    t.impl.setAdsListener(async (userId, zid, evt) => void got.push({ userId, zid, event: evt.event }));
    const { account, profileId } = await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    const evt = adEvent(profileId, account._id);
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    expect((await t.impl.webhook(evt.raw, evt.headers)).body).toMatchObject({ duplicate: true });
    expect(got).toEqual([{ userId: ALICE, zid: account._id, event: 'ad.review.rejected' }]);
  });

  it('drops an event whose connection isn’t that customer’s (not_ours): the listener never sees it', async () => {
    const t = setup();
    const got = [];
    t.impl.setAdsListener(async (userId, zid) => void got.push({ userId, zid }));
    const alice = await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    const bob = await connectVia(t, BOB, 'meta_ads', { zPlatform: 'metaads', username: 'bobsbikes' });
    const evt = adEvent(alice.profileId, bob.account._id);
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    expect(got).toEqual([]);
    expect(t.log.lines.at(-1)).toContain('"outcome":"not_ours"');
  });

  it('answers 500 when the listener throws, so Zernio delivers it again (and it is applied then)', async () => {
    const t = setup();
    let fail = true;
    const got = [];
    t.impl.setAdsListener(async () => {
      if (fail) throw new Error('db down');
      got.push(1);
    });
    const { account, profileId } = await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    const evt = adEvent(profileId, account._id);
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(500);
    fail = false;
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    expect(got).toHaveLength(1);
  });

  it('exposes the business’s connection, the one client and nothing else for ads', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'meta_ads', { zPlatform: 'metaads' });
    const doc = (await t.storage.get(`zernio:user:${sha256(ALICE)}`)).value;
    const got = await t.impl.adsAccountFor(ALICE, 'meta_ads', 'proj-1');
    expect(got.tag).toBe(customerTag(ALICE, t.env));
    expect(doc.accounts[got.zid]?.platform).toBe('meta_ads');
    await expect(t.impl.adsAccountFor(ALICE, 'google_ads', 'proj-1')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(t.impl.adsAccountFor(ALICE, 'tiktok_ads', 'proj-1')).rejects.toMatchObject({ status: 404 });
    expect(t.impl.client.enabled).toBe(true);
  });
});
