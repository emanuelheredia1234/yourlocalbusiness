// Social accounts through Upload-Post (server/connections/uploadpost.mjs + server/uploadpost.mjs) against
// server/test/mock-uploadpost.mjs: the client's key handling, budget and bad-key guard, one profile per customer
// (ylb_ + the customer tag), the profile cap kept from customers, the hosted connect page with full branding,
// Pages always asked with profile=, signed webhooks (timestamp window, replays), one-attempt posting with the
// per-platform result, background status reads and no resend, social stats, deletion, the monthly estimate and the
// daily reconcile. Nothing here reaches Upload-Post.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUploadPostConnections, outcomeOfEntry } from './uploadpost.mjs';
import { combineConnections, createConnections } from './index.mjs';
import { createUploadPostClient, UPLOAD_POST_BASE_URL, uploadPostBase, upError } from '../uploadpost.mjs';
import { customerTag, errorBody, sha256 } from '../integrations/common.mjs';
import { createMockUploadPost, signUploadPost, TEST_UPLOAD_POST_KEY, TEST_UPLOAD_POST_WEBHOOK_SECRET } from '../test/mock-uploadpost.mjs';
import { makeDb, makeLog, makeStorage } from '../test/fakes.mjs';

const ALICE = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';
const BOB = '7d1e2b3c-4a5f-4b6c-8d7e-9f0a1b2c3d4e';
const TAG_SECRET = 'test-customer-tag-secret-0123456789';
const JOB = () => crypto.randomUUID();

let mock;
beforeAll(async () => {
  mock = await createMockUploadPost().start();
});
afterAll(async () => {
  await mock.close();
});

function setup({ env = {}, start = Date.now() } = {}) {
  const storage = makeStorage();
  const db = makeDb();
  const log = makeLog();
  const clock = { t: start };
  const fullEnv = {
    UPLOAD_POST_API_KEY: TEST_UPLOAD_POST_KEY,
    UPLOAD_POST_WEBHOOK_SECRET: TEST_UPLOAD_POST_WEBHOOK_SECRET,
    UPLOAD_POST_BASE_URL: mock.base,
    UPLOAD_POST_RPM: '900',
    UPLOAD_POST_BRAND_LOGO_URL: 'https://cdn.example/logo.png',
    CUSTOMER_TAG_SECRET: TAG_SECRET,
    MEDIA_URL_SECRET: 'test-media-url-secret-abcdef0123456789',
    MEDIA_PUBLIC_BASE_URL: 'https://app.test',
    GSC_APP_PROPERTY: 'https://yourlocalbusiness.replit.app/',
    ...env,
  };
  const impl = createUploadPostConnections({ env: fullEnv, storage, db, log, now: () => clock.t, sleep: async (ms) => void (clock.t += ms) });
  return { impl, connections: createConnections(combineConnections({ social: impl })), storage, db, log, env: fullEnv, clock };
}

const docOf = async (t, userId) => (await t.storage.get(`uploadpost:user:${sha256(userId)}`))?.value;

/** Connect a network the way a customer does: the link, the hosted page (mock), then the signed webhook. */
async function connectVia(t, userId, platform, account = {}) {
  const link = await t.connections.connectLink(userId, platform);
  const { username } = await docOf(t, userId);
  const acct = mock.connect(username, platform, account);
  const evt = mock.signed({ event: 'social_account_connected', profile_username: username, platform, account_name: acct.handle, status: 'connected' }, { ts: Math.floor(t.clock.t / 1000) });
  const res = await t.impl.webhook(evt.raw, evt.headers);
  expect(res.status).toBe(200);
  return { link, username, acct };
}

describe('the client (server/uploadpost.mjs)', () => {
  it('uses Upload-Post’s base unless a local test base or an https one is given', () => {
    expect(uploadPostBase({})).toBe(UPLOAD_POST_BASE_URL);
    expect(uploadPostBase({ UPLOAD_POST_BASE_URL: 'http://evil.example/api' })).toBe(UPLOAD_POST_BASE_URL);
    expect(uploadPostBase({ UPLOAD_POST_BASE_URL: 'http://127.0.0.1:9/api' })).toBe('http://127.0.0.1:9/api');
  });

  it('sends the key only as `Authorization: Apikey`, never in a query or a log', async () => {
    const log = makeLog();
    const client = createUploadPostClient({ env: { UPLOAD_POST_API_KEY: TEST_UPLOAD_POST_KEY, UPLOAD_POST_BASE_URL: mock.base }, log });
    const before = mock.calls.length;
    expect((await client.call('GET', '/uploadposts/users/ylb_ffffffffffffffffffffffff')).status).toBe(404);
    expect(mock.calls[before].auth).toBe('apikey');
    expect(JSON.stringify(mock.calls[before].query)).not.toContain(TEST_UPLOAD_POST_KEY);
    expect(log.text()).not.toContain(TEST_UPLOAD_POST_KEY);
    expect(log.text()).not.toContain('ffffffffffffffffffffffff');
  });

  it('a write never waits long for a slot: no slot within 15 s answers a local 429 and sends nothing', async () => {
    let clock = 1_000_000;
    const slept = [];
    const client = createUploadPostClient({ env: { UPLOAD_POST_API_KEY: TEST_UPLOAD_POST_KEY, UPLOAD_POST_BASE_URL: mock.base, UPLOAD_POST_RPM: '1' }, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; }, log: makeLog() });
    await client.call('GET', '/uploadposts/me');
    const before = mock.calls.length;
    const res = await client.call('POST', '/upload_text', { form: { user: 'x', 'platform[]': ['x'], title: 'hi' }, headers: { 'Idempotency-Key': 'k-rate' } });
    expect(res).toMatchObject({ status: 429, local: true });
    expect(mock.calls.length).toBe(before);
    expect(slept).toEqual([]);
    // a read waits for its slot and then goes; each profile adds 2 a minute to the budget
    client.setProfileCount(5);
    expect((await client.call('GET', '/uploadposts/me')).status).toBe(200);
    expect(mock.calls.length).toBe(before + 1);
  });

  it('after a 401 sends nothing for 60 s (the bad-key lockout guard) and tells the owner', async () => {
    let clock = 5_000_000;
    const alerts = [];
    const client = createUploadPostClient({ env: { UPLOAD_POST_API_KEY: 'up_wrong_key_0000', UPLOAD_POST_BASE_URL: mock.base }, now: () => clock, log: makeLog(), onAlert: (k) => alerts.push(k) });
    expect((await client.call('GET', '/uploadposts/me')).status).toBe(401);
    const before = mock.calls.length;
    expect(await client.call('GET', '/uploadposts/me')).toMatchObject({ status: 401, local: true });
    expect(mock.calls.length).toBe(before);
    expect(alerts).toEqual(['auth']);
    clock += 61_000;
    await client.call('GET', '/uploadposts/me');
    expect(mock.calls.length).toBe(before + 1);
  });

  it('checks the webhook signature over "<timestamp>.<raw body>", within 300 s, with the current or previous secret; unsigned is refused', () => {
    const at = 1_800_000_000;
    const client = createUploadPostClient({ env: { UPLOAD_POST_API_KEY: 'k', UPLOAD_POST_WEBHOOK_SECRET: 'whsec_new', UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS: TEST_UPLOAD_POST_WEBHOOK_SECRET }, now: () => at * 1000 });
    const raw = Buffer.from('{"event":"upload_completed"}');
    expect(client.verifySignature(raw, signUploadPost(raw, { secret: 'whsec_new', ts: at }))).toBe(true);
    expect(client.verifySignature(raw, signUploadPost(raw, { ts: at - 10 }))).toBe(true);
    expect(client.verifySignature(Buffer.from('{"event":"upload_completed" }'), signUploadPost(raw, { secret: 'whsec_new', ts: at }))).toBe(false);
    expect(client.verifySignature(raw, signUploadPost(raw, { secret: 'whsec_new', ts: at - 301 }))).toBe(false);
    expect(client.verifySignature(raw, signUploadPost(raw, { secret: 'whsec_new', ts: at + 301 }))).toBe(false);
    expect(client.verifySignature(raw, {})).toBe(false);
    expect(client.verifySignature(raw, { 'x-upload-post-signature': 'nope', 'x-upload-post-timestamp': String(at) })).toBe(false);
  });

  it('keeps only machine-readable error fields, never Upload-Post’s text', () => {
    const e = upError({ status: 403, headers: {}, body: { success: false, message: 'You hit PROFILE_LIMIT_REACHED on plan Advanced (owner@example.com)' } });
    expect(e).toEqual({ status: 403, code: 'PROFILE_LIMIT_REACHED', violations: [] });
    expect(JSON.stringify(upError({ status: 429, headers: {}, body: { violations: [{ platform: 'instagram', type: 'hard_cap', cap: 50, message: 'Daily cap reached for instagram' }] } }))).not.toContain('Daily cap');
  });
});

describe('profiles and the connect page', () => {
  it('makes one profile per customer named ylb_ + the customer tag, once, and never sends our user id or an email', async () => {
    const t = setup();
    await t.connections.connectLink(ALICE, 'facebook');
    await t.connections.connectLink(ALICE, 'instagram');
    const { username } = await docOf(t, ALICE);
    expect(username).toBe(`ylb_${customerTag(ALICE, t.env).slice(5)}`);
    expect(username).toMatch(/^ylb_[0-9a-f]{24}$/);
    const creates = mock.calls.filter((c) => c.method === 'POST' && c.path === '/api/uploadposts/users' && c.body?.username === username);
    expect(creates).toHaveLength(1);
    expect(JSON.stringify(creates[0].body)).not.toContain(ALICE);
    expect(creates[0].body.display_name).toMatch(/^Customer [0-9a-f]{8}$/);
  });

  it('a profile that already exists (409) is fine, and a missing one is made again once on connect', async () => {
    const t = setup();
    mock.addProfile(`ylb_${customerTag(BOB, t.env).slice(5)}`);
    await t.connections.connectLink(BOB, 'x');
    const { username } = await docOf(t, BOB);
    mock.profiles.delete(username);
    const r = await t.connections.connectLink(BOB, 'x');
    expect(r.connectLink).toMatch(/\/connect\?token=/);
    expect(mock.profiles.has(username)).toBe(true);
  });

  it('opens the hosted page with the full branding on every call, for that one network, and the app as the back button', async () => {
    const t = setup({ env: { UPLOAD_POST_CONNECT_TITLE: 'Connect Joe’s accounts' } });
    const a = await t.connections.connectLink(ALICE, 'linkedin');
    const b = await t.connections.connectLink(ALICE, 'tiktok');
    expect(a.connectLink).not.toBe(b.connectLink);
    expect(Date.parse(a.expiresAt) - t.clock.t).toBe(48 * 3_600_000);
    const [first, second] = mock.jwtBodies.slice(-2);
    for (const body of [first, second]) {
      expect(body).toMatchObject({ redirect_url: 'https://yourlocalbusiness.replit.app/settings?tab=accounts&from=connect', logo_image: 'https://cdn.example/logo.png', connect_title: 'Connect Joe’s accounts', redirect_button_text: expect.any(String), connect_description: expect.any(String), show_calendar: false, readonly_calendar: false, connect_theme: 'light' });
    }
    expect(first.platforms).toEqual(['linkedin']);
    expect(second.platforms).toEqual(['tiktok']);
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'linkedin').state).toBe('pending');
  });

  it('the profile cap: the customer reads a safe message, the owner gets the hint and an alert; nothing is created', async () => {
    const t = setup();
    mock.cap = mock.profiles.size;
    try {
      const err = await t.connections.connectLink('11111111-2222-4333-8444-555555555555', 'facebook').catch((e) => e);
      expect(err).toMatchObject({ status: 503, code: 'CONNECTIONS_UNAVAILABLE' });
      const customer = JSON.stringify(errorBody(err, null).body);
      expect(customer).not.toMatch(/upload-post|plan|add-on|owner@|PROFILE_LIMIT/i);
      expect(errorBody(err, { isAdmin: true }).body.hint).toMatch(/profile/i);
      expect((await t.storage.get('uploadpost:alert')).value.kind).toBe('profile_cap');
    } finally {
      mock.cap = 75;
    }
  });

  it('a 403 PROFILE_LIMIT_REACHED from the create itself (the list was stale) reads the same safe way', async () => {
    const t = setup();
    const before = mock.profiles.size;
    await t.impl.ownerView(); // caches the list with room
    mock.cap = before;
    try {
      const err = await t.connections.connectLink('21111111-2222-4333-8444-555555555555', 'facebook').catch((e) => e);
      expect(err).toMatchObject({ code: 'CONNECTIONS_UNAVAILABLE' });
      expect(errorBody(err, null).body.error).not.toMatch(/upload|plan/i);
    } finally {
      mock.cap = 75;
    }
  });

  it('a blocked profile (403 PROFILE_BLOCKED) tells the owner, not the customer', async () => {
    const t = setup();
    await t.connections.connectLink(ALICE, 'youtube');
    const { username } = await docOf(t, ALICE);
    mock.blocked.add(username);
    try {
      const err = await t.connections.connectLink(ALICE, 'x').catch((e) => e);
      expect(err).toMatchObject({ status: 503, code: 'CONNECTIONS_UNAVAILABLE' });
      expect(errorBody(err, null).body.error).not.toMatch(/blocked|plan|upload/i);
      expect((await t.storage.get('uploadpost:alert')).value.kind).toBe('profile_blocked');
    } finally {
      mock.blocked.delete(username);
    }
  });

  it('Pinterest is coming soon; ad platforms aren’t this side’s', async () => {
    const t = setup();
    await expect(t.connections.connectLink(ALICE, 'pinterest')).rejects.toMatchObject({ status: 400 });
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'pinterest').state).toBe('coming_soon');
    await expect(t.connections.connectLink(ALICE, 'meta_ads')).rejects.toMatchObject({ code: 'CONNECTIONS_NOT_ENABLED' });
  });

  it('is not set up without the webhook secret or the tag secret, and names only the Secrets', async () => {
    const t = setup({ env: { UPLOAD_POST_WEBHOOK_SECRET: '', CUSTOMER_TAG_SECRET: '' } });
    expect(t.impl.setUp).toBe(false);
    expect(t.impl.hint).toContain('UPLOAD_POST_WEBHOOK_SECRET');
    expect(t.impl.hint).toContain('CUSTOMER_TAG_SECRET');
    expect(t.impl.hint).not.toContain(TEST_UPLOAD_POST_KEY);
    await expect(t.connections.connectLink(ALICE, 'facebook')).rejects.toMatchObject({ code: 'NOT_SET_UP' });
  });
});

describe('accounts, Pages and isolation', () => {
  it('a connected account shows with its label; the browser never sees a profile name or an account id', async () => {
    const t = setup();
    const { username, acct } = await connectVia(t, ALICE, 'instagram', { id: 'ig_1789_secret', display_name: 'Joe’s Bakery IG' });
    const list = await t.connections.status(ALICE);
    expect(list.find((s) => s.platform === 'instagram')).toMatchObject({ state: 'connected', targetLabel: 'Joe’s Bakery IG', targetKind: 'ig_account' });
    const text = JSON.stringify(list) + JSON.stringify(await t.connections.targets(ALICE, 'instagram'));
    expect(text).not.toContain(username);
    expect(text).not.toContain(acct.username);
  });

  it('lists Facebook Pages with profile= only, lets each business choose its Page, and a pinned Page wins', async () => {
    const t = setup();
    const u = `ylb_${customerTag(ALICE, t.env).slice(5)}`;
    mock.addProfile(u);
    mock.pages.facebook.set(u, [{ id: '1001', name: 'Joe’s Bakery' }, { id: '1002', name: 'Joe’s Catering' }]);
    mock.pages.facebook.set('ylb_someoneelse0000000000000', [{ id: '9999', name: 'Not Alice’s' }]);
    await connectVia(t, ALICE, 'facebook');
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'facebook')).toMatchObject({ state: 'connected', targetsAvailable: 2 });
    const targets = await t.connections.targets(ALICE, 'facebook');
    expect(targets.map((x) => x.label)).toEqual(['Joe’s Bakery', 'Joe’s Catering']);
    expect(JSON.stringify(targets)).not.toMatch(/1001|1002|9999/);
    await t.connections.setTarget(ALICE, 'facebook', targets[1].id, { projectId: 'proj-b' });
    await t.connections.setTarget(ALICE, 'facebook', targets[0].id, { projectId: 'proj-a' });
    expect((await t.connections.status(ALICE, { projectId: 'proj-b' })).find((s) => s.platform === 'facebook').targetLabel).toBe('Joe’s Catering');
    expect((await t.connections.status(ALICE, { projectId: 'proj-a' })).find((s) => s.platform === 'facebook').targetLabel).toBe('Joe’s Bakery');
    // the hosted page pinned a Page: every business uses it, and choosing another is refused
    mock.pins.facebook.set(u, '1002');
    await t.connections.check(ALICE, 'facebook');
    expect((await t.connections.status(ALICE, { projectId: 'proj-a' })).find((s) => s.platform === 'facebook').targetLabel).toBe('Joe’s Catering');
    await expect(t.connections.setTarget(ALICE, 'facebook', targets[0].id, { projectId: 'proj-a' })).rejects.toMatchObject({ status: 409 });
    expect(mock.violations).toEqual([]);
    mock.pins.facebook.delete(u);
  });

  it('check reads the profile back: a reauth flag needs a reconnect; disconnect removes it at Upload-Post once (404 is fine)', async () => {
    const t = setup();
    const { username } = await connectVia(t, BOB, 'tiktok');
    mock.connect(username, 'tiktok', { reauth_required: true });
    expect(await t.connections.check(BOB, 'tiktok')).toMatchObject({ state: 'needs_reconnect', lastError: 'reconnect' });
    const before = mock.calls.length;
    await t.connections.disconnect(BOB, 'tiktok');
    const del = mock.calls.slice(before).filter((c) => c.method === 'DELETE');
    expect(del).toEqual([expect.objectContaining({ path: '/api/uploadposts/users/social', body: { profile_username: username, social_platform: 'tiktok' } })]);
    expect((await t.connections.status(BOB)).find((s) => s.platform === 'tiktok').state).toBe('not_connected');
  });

  it('keeps customers apart: an event for one customer’s profile never changes another’s', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'x');
    const before = JSON.stringify(await docOf(t, ALICE));
    await t.connections.connectLink(BOB, 'x');
    const { username: bobs } = await docOf(t, BOB);
    mock.connect(bobs, 'x');
    const evt = mock.signed({ event: 'social_account_connected', profile_username: bobs, platform: 'x' });
    await t.impl.webhook(evt.raw, evt.headers);
    expect(JSON.stringify(await docOf(t, ALICE))).toBe(before);
    // a profile that isn't one of our customers' is ignored
    const stranger = mock.signed({ event: 'social_account_connected', profile_username: 'ylb_000000000000000000000000', platform: 'x' });
    expect((await t.impl.webhook(stranger.raw, stranger.headers)).status).toBe(200);
  });
});

describe('the webhook', () => {
  it('refuses a bad, stale or missing signature without reading anything', async () => {
    const t = setup();
    const evt = mock.signed({ event: 'upload_completed', profile_username: 'ylb_000000000000000000000000' });
    const reads = t.db.calls?.length ?? 0;
    expect((await t.impl.webhook(evt.raw, { ...evt.headers, 'x-upload-post-signature': `sha256=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await t.impl.webhook(evt.raw, signUploadPost(evt.raw, { ts: Math.floor(t.clock.t / 1000) - 400 }))).status).toBe(401);
    expect((await t.impl.webhook(evt.raw, {})).status).toBe(401);
    expect(t.db.calls?.length ?? 0).toBe(reads);
  });

  it('applies an upload_completed once (a replay with a new delivery id is a duplicate) and routes it to the job', async () => {
    const t = setup();
    const { username } = await connectVia(t, ALICE, 'instagram');
    const seen = [];
    t.impl.setPostListener((userId, jobId, outcome) => seen.push({ userId, jobId, outcome }));
    const jobId = JOB();
    const evt = mock.signed({ event: 'upload_completed', request_id: jobId, profile_username: username, platform: 'instagram', result: { success: true, url: 'https://instagram.com/p/abc', post_id: '1798' } });
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    const again = await t.impl.webhook(evt.raw, signUploadPost(evt.raw, { event: 'upload_completed' }));
    expect(again.body).toMatchObject({ duplicate: true });
    expect(seen).toEqual([{ userId: ALICE, jobId, outcome: { state: 'sent', platform: 'instagram', url: 'https://instagram.com/p/abc' } }]);
  });
});

describe('posting (one attempt)', () => {
  it('posts a text once with our job id as request_id, Idempotency-Key and external_id; the platform’s own result decides', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'linkedin');
    const jobId = JOB();
    const out = await t.connections.publish(ALICE, 'linkedin', { jobId, composed: { text: 'Fresh sourdough today', comment: 'Order: https://joes.example' } });
    expect(out).toMatchObject({ state: 'sent', url: expect.stringMatching(/^https:\/\/social\.example\/linkedin\/p\//), ref: { via: 'upload_post', requestId: jobId, platform: 'linkedin' } });
    const call = mock.uploadCalls().pop();
    expect(call).toMatchObject({ path: '/api/upload_text', idempotencyKey: jobId });
    expect(call.form).toMatchObject({ 'platform[]': ['linkedin'], request_id: jobId, external_id: jobId, title: 'Fresh sourdough today', first_comment: 'Order: https://joes.example' });
    expect(t.db.rows('usage_ledger').find((r) => r.call_id === jobId)).toMatchObject({ vendor: 'uploadpost', feature: 'posting', endpoint: 'linkedin:POST /upload_text', outcome: 'ok' });
  });

  it('sends a photo as our short-lived public link (Upload-Post fetches it), never the bytes', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const out = await t.connections.publish(ALICE, 'instagram', { jobId: JOB(), composed: { text: 'Look' }, media: { id: 'img-1.jpg', kind: 'image', type: 'image/jpeg', size: 2000 } });
    expect(out.state).toBe('sent');
    const call = mock.uploadCalls().pop();
    expect(call.path).toBe('/api/upload_photos');
    expect(call.form['photos[]']).toEqual([expect.stringMatching(/^https:\/\/app\.test\/api\/media\/public\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)]);
  });

  it('a video goes in the background: status reads by the job id until it’s done; the address comes back', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'youtube');
    const jobId = JOB();
    mock.setUploadOutcome('async');
    const out = await t.connections.publish(ALICE, 'youtube', { jobId, composed: { text: 'desc', title: 'Our sourdough', description: 'desc', tags: ['bread'] }, media: { id: 'vid-1', kind: 'video', type: 'video/mp4', size: 6000 } });
    expect(out).toMatchObject({ state: 'sent', url: expect.stringMatching(/^https:\/\/social\.example\/youtube\//) });
    const call = mock.uploadCalls().pop();
    expect(call.form).toMatchObject({ async_upload: 'true', youtube_title: 'Our sourdough', privacyStatus: 'public', 'tags[]': ['bread'] });
    expect(mock.calls.filter((c) => c.path === '/api/uploadposts/status' && c.query.request_id === jobId).length).toBeGreaterThanOrEqual(2);
    expect(mock.uploadCalls().filter((c) => c.idempotencyKey === jobId)).toHaveLength(1);
  });

  it('a status that never settles ends unknown after the window, with one upload only', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'x');
    const jobId = JOB();
    mock.setUploadOutcome('async_pending');
    const out = await t.connections.publish(ALICE, 'x', { jobId, composed: { text: 'Pending forever' } });
    expect(out).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
    expect(mock.uploadCalls().filter((c) => c.idempotencyKey === jobId)).toHaveLength(1);
  });

  it('top-level success with this platform failed is a failure; skipped is “not connected”; reauth needs a reconnect', async () => {
    const t = setup();
    await connectVia(t, BOB, 'facebook', {});
    const u = (await docOf(t, BOB)).username;
    mock.pages.facebook.set(u, [{ id: '2001', name: 'Bob’s Page' }]);
    await t.connections.check(BOB, 'facebook');
    mock.setUploadOutcome('platform_failed');
    expect(await t.connections.publish(BOB, 'facebook', { jobId: JOB(), composed: { text: 'a' } })).toMatchObject({ state: 'failed', errorCode: 'REFUSED' });
    expect(mock.uploadCalls().pop().form.facebook_page_id).toBe('2001');
    mock.setUploadOutcome('skipped');
    expect(await t.connections.publish(BOB, 'facebook', { jobId: JOB(), composed: { text: 'b' } })).toMatchObject({ state: 'failed', errorCode: 'NOT_CONNECTED' });
    mock.setUploadOutcome('reauth');
    expect(await t.connections.publish(BOB, 'facebook', { jobId: JOB(), composed: { text: 'c' } })).toMatchObject({ state: 'failed', errorCode: 'NEEDS_RECONNECT' });
    expect((await t.connections.status(BOB)).find((s) => s.platform === 'facebook').state).toBe('needs_reconnect');
  });

  it('TikTok: the account’s audience options are read first; drafts (inbox fallback) end sent with no address', async () => {
    const t = setup();
    const { username } = await connectVia(t, ALICE, 'tiktok');
    mock.setUploadOutcome('inbox');
    const out = await t.connections.publish(ALICE, 'tiktok', { jobId: JOB(), composed: { text: 'Bread' }, media: { id: 'vid-tt', kind: 'video', type: 'video/mp4', size: 6000 } });
    expect(out).toMatchObject({ state: 'sent', ref: { outcome: 'drafts' } });
    expect(out.url).toBeUndefined();
    expect(mock.uploadCalls().pop().form.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    // a private account with no public option: refused before anything is sent
    mock.tiktokPrivacy.set(username, ['SELF_ONLY']);
    const before = mock.uploadCalls().length;
    expect(await t.connections.publish(ALICE, 'tiktok', { jobId: JOB(), composed: { text: 'Bread' }, media: { id: 'vid-tt', kind: 'video', type: 'video/mp4', size: 6000 } })).toMatchObject({ state: 'failed', errorCode: 'TIKTOK_PRIVACY' });
    expect(mock.uploadCalls().length).toBe(before);
    mock.tiktokPrivacy.delete(username);
  });

  it('caps and team limits: a daily cap is PLATFORM_LIMIT; the scheduled-post cap and our key are the owner’s (safe code, alert)', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const photo = { id: 'img-2.jpg', kind: 'image', type: 'image/jpeg', size: 10 };
    mock.setUploadOutcome('hard_cap');
    expect(await t.connections.publish(ALICE, 'instagram', { jobId: JOB(), composed: { text: 'a' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'PLATFORM_LIMIT' });
    mock.setUploadOutcome('scheduled_limit');
    expect(await t.connections.publish(ALICE, 'instagram', { jobId: JOB(), composed: { text: 'b' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' });
    expect((await t.storage.get('uploadpost:alert')).value.kind).toBe('scheduled_limit');
    mock.setUploadOutcome('unauthorized');
    expect(await t.connections.publish(ALICE, 'instagram', { jobId: JOB(), composed: { text: 'c' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' });
    expect((await t.storage.get('uploadpost:alert')).value.kind).toBe('auth');
    expect(t.log.text()).not.toMatch(/upgrade at|40000 pending/);
  });

  it('a 5xx after Upload-Post took it is unknown (nothing resent); “Check again” reads the status by the job id and finds it', async () => {
    const t = setup();
    await connectVia(t, BOB, 'x');
    const jobId = JOB();
    mock.setUploadOutcome('accepted_then_500');
    expect(await t.connections.publish(BOB, 'x', { jobId, composed: { text: 'Created then 502' } })).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
    const reads = mock.calls.length;
    const found = await t.connections.postStatus(BOB, { via: 'upload_post', requestId: jobId, platform: 'x', jobId });
    expect(found).toMatchObject({ found: true, url: expect.stringMatching(/^https:\/\/social\.example\/x\//) });
    expect(mock.calls.slice(reads).every((c) => c.method === 'GET')).toBe(true);
    expect(mock.uploadCalls().filter((c) => c.idempotencyKey === jobId)).toHaveLength(1);
    // nothing created at all: still pending (never "send again")
    expect(await t.connections.postStatus(BOB, { requestId: JOB(), platform: 'x' })).toMatchObject({ pending: true });
  });

  it('refuses (nothing sent) when the business has no account there', async () => {
    const t = setup();
    const before = mock.uploadCalls().length;
    expect(await t.connections.publish('31111111-2222-4333-8444-555555555555', 'facebook', { jobId: JOB(), composed: { text: 'x' } })).toMatchObject({ state: 'failed', errorCode: 'NO_TARGET' });
    expect(mock.uploadCalls().length).toBe(before);
  });
});

describe('social stats (reads)', () => {
  it('reads the account’s numbers (Facebook with its Page), the reach series and cached top posts; a missing key is unknown', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const got = await t.connections.insights(ALICE, 'instagram', {});
    expect(got).toMatchObject({ followers: 1310, reach: 1000, views: 700, engagement: 64, series: [{ date: '2026-11-01', reach: 700 }, { date: '2026-11-02', reach: 300 }] });
    expect(got.postsCount).toBeUndefined();
    expect(got.topPosts[0]).toMatchObject({ id: 'pid_1', likes: 40, url: 'https://social.example/p/1' });
    expect(t.db.rows('usage_ledger').filter((r) => r.feature === 'social').every((r) => r.vendor === 'uploadpost')).toBe(true);
    const u = (await docOf(t, ALICE)).username;
    mock.pages.facebook.set(u, [{ id: '3001', name: 'Alice’s Page' }]);
    await connectVia(t, ALICE, 'facebook');
    expect((await t.connections.insights(ALICE, 'facebook', {})).followers).toBe(1310);
    expect(mock.calls.filter((c) => c.path === `/api/analytics/${u}` && c.query.platforms === 'facebook').pop().query).toMatchObject({ page_id: '3001', days: '30' });
  });

  it('answers null when nothing is connected, and { kind: reconnect } when the account needs one', async () => {
    const t = setup();
    expect(await t.connections.insights('41111111-2222-4333-8444-555555555555', 'x', {})).toBeNull();
    const { username } = await connectVia(t, BOB, 'youtube');
    mock.connect(username, 'youtube', { reauth_required: true });
    await t.connections.check(BOB, 'youtube');
    await expect(t.connections.insights(BOB, 'youtube', {})).rejects.toMatchObject({ kind: 'reconnect' });
  });
});

describe('deletion, the monthly estimate and the daily reconcile', () => {
  it('forgetUser deletes the profile at Upload-Post, then reads as not connected', async () => {
    const t = setup();
    const { username } = await connectVia(t, ALICE, 'instagram');
    await t.connections.forgetUser(ALICE);
    expect(mock.profiles.has(username)).toBe(false);
    expect((await t.connections.status(ALICE)).every((s) => s.state === 'not_connected' || s.state === 'coming_soon')).toBe(true);
    // a second time (already gone, 404) is fine
    await t.connections.unforgetUser(ALICE);
    await t.connections.forgetUser(ALICE);
  });

  it('writes one estimated profile row per customer for last month, once', async () => {
    const t = setup({ start: Date.parse('2026-10-16T00:00:00Z') });
    const CAROL = '51111111-2222-4333-8444-555555555555';
    await connectVia(t, CAROL, 'x');
    t.clock.t = Date.parse('2026-11-02T00:00:00Z');
    expect((await t.impl.meterIfDue()).rows).toBe(1);
    expect((await t.impl.meterIfDue()).skipped).toBe(true);
    const row = t.db.rows('usage_ledger').find((r) => r.feature === 'connections');
    expect(row).toMatchObject({ vendor: 'uploadpost', estimated: true, endpoint: 'upload_post_profile 2026-10' });
    expect(row.cost_micro).toBeGreaterThan(900_000);
    expect(row.cost_micro).toBeLessThan(1_960_000);
    expect(await t.impl.accountCount(CAROL)).toBe(1);
    expect(await t.impl.ownerView()).toMatchObject({ profilesUsed: expect.any(Number), profilesLimit: 75 });
  });

  it('the daily reconcile deletes our own orphaned profiles only (never one not named ylb_…, never a live customer’s)', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'x');
    const alices = (await docOf(t, ALICE)).username;
    mock.addProfile('ylb_abcabcabcabcabcabcabcabc');
    mock.addProfile('owner_test_profile');
    const r = await t.impl.reconcileIfDue();
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(mock.profiles.has('ylb_abcabcabcabcabcabcabcabc')).toBe(false);
    expect(mock.profiles.has('owner_test_profile')).toBe(true);
    expect(mock.profiles.has(alices)).toBe(true);
    expect((await t.impl.reconcileIfDue()).skipped).toBe(true);
  });

  it('never logs the API key, a connect link, a profile name or an account id', async () => {
    const t = setup();
    const { link, acct, username } = await connectVia(t, BOB, 'instagram', { id: 'ig_acct_secret_id' });
    await t.connections.publish(BOB, 'instagram', { jobId: JOB(), composed: { text: 'Hi' }, media: { id: 'img-3.jpg', kind: 'image', type: 'image/jpeg', size: 10 } });
    const text = t.log.text();
    expect(text).not.toContain(TEST_UPLOAD_POST_KEY);
    expect(text).not.toContain(link.connectLink);
    expect(text).not.toContain(acct.username);
    expect(text).not.toContain(username);
    expect(text).not.toContain('/api/media/public/');
  });
});

describe('outcomeOfEntry', () => {
  it('reads one platform’s entry; never trusts a top-level success, never renders a non-https address', () => {
    expect(outcomeOfEntry({ success: true, url: 'https://x.com/1' })).toEqual({ state: 'sent', url: 'https://x.com/1' });
    expect(outcomeOfEntry({ success: true, post_url: 'Video sent to Inbox (No Public URL)', fallback_to_inbox: true })).toEqual({ state: 'sent', drafts: true });
    expect(outcomeOfEntry({ success: true, post_url: 'javascript:alert(1)' })).toEqual({ state: 'sent' });
    expect(outcomeOfEntry({ status: 'processing' })).toEqual({ state: 'pending' });
    expect(outcomeOfEntry({ success: false, error_code: 'account_checkpoint_required' })).toEqual({ state: 'failed', errorCode: 'ACCOUNT_CHECK' });
    expect(outcomeOfEntry({ success: false, error_code: 'spam_risk_too_many_pending_share' })).toEqual({ state: 'failed', errorCode: 'TIKTOK_DRAFTS_FULL' });
    expect(outcomeOfEntry({ status: 'skipped' })).toEqual({ state: 'failed', errorCode: 'NOT_CONNECTED' });
  });
});
