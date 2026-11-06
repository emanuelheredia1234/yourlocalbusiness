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
/** The owner's stored alerts ({ kind: { at, n? } }), once their writes have landed. */
const alertsOf = async (t) => {
  await t.impl.settled();
  return (await t.storage.get('uploadpost:alerts'))?.value ?? {};
};

/** Connect a network the way a customer does: the link, the hosted page (mock), then the signed webhook. */
async function connectVia(t, userId, platform, account = {}) {
  const link = await t.connections.connectLink(userId, platform);
  const { username } = await docOf(t, userId);
  const acct = mock.connect(username, platform, account);
  const evt = mock.signed({ event: 'social_account_connected', profile_username: username, platform, account_name: acct.handle, status: 'connected' }, { ts: Math.floor(t.clock.t / 1000) });
  const res = await t.impl.webhook(evt.raw, evt.headers);
  expect(res.status).toBe(200);
  // the webhook is answered at once; its work runs after
  await t.impl.settled();
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

  it('a 401 that is one customer’s social sign-in running out (reauth_required) blocks nothing and alerts no one; after a key alert, the next success says it’s over', async () => {
    let clock = 7_000_000;
    const alerts = [];
    const over = [];
    const answers = [
      { status: 401, body: { success: false, error_code: 'facebook_reauth_required', reauth_required: true } },
      { status: 200, body: { success: true } },
      { status: 401, body: { success: false, message: 'Invalid API key' } },
      { status: 200, body: { success: true } },
    ];
    let sent = 0;
    const fakeFetch = async () => {
      const a = answers[sent];
      sent += 1;
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
    };
    const client = createUploadPostClient({ env: { UPLOAD_POST_API_KEY: TEST_UPLOAD_POST_KEY }, fetch: fakeFetch, now: () => clock, log: makeLog(), onAlert: (k) => alerts.push(k), onRecover: (k) => over.push(...k) });
    expect((await client.call('GET', '/uploadposts/users/facebook-page', { query: { profile_username: 'ylb_aaaaaaaaaaaaaaaaaaaaaaaa' } })).status).toBe(401);
    expect(alerts).toEqual([]);
    // the next call, for anyone, goes out
    expect((await client.call('POST', '/upload_text', { form: { user: 'ylb_bbbbbbbbbbbbbbbbbbbbbbbb' }, headers: { 'Idempotency-Key': 'k1' } })).status).toBe(200);
    expect(sent).toBe(2);
    // our key: the 60 s guard and the owner's alert; once a call works again, the alert is over
    expect((await client.call('GET', '/uploadposts/me')).status).toBe(401);
    expect(alerts).toEqual(['auth']);
    expect(await client.call('GET', '/uploadposts/me')).toMatchObject({ status: 401, local: true });
    clock += 61_000;
    expect((await client.call('GET', '/uploadposts/me')).status).toBe(200);
    expect(over).toEqual(['auth']);
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
      expect(body).toMatchObject({ redirect_url: 'https://yourlocalbusiness.replit.app/?settings=accounts#workspace-settings', logo_image: 'https://cdn.example/logo.png', connect_title: 'Connect Joe’s accounts', redirect_button_text: expect.any(String), connect_description: expect.any(String), show_calendar: false, readonly_calendar: false, connect_theme: 'light' });
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
      expect(Object.keys(await alertsOf(t))).toContain('profile_cap');
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
      expect(Object.keys(await alertsOf(t))).toContain('profile_blocked');
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

  it('new profiles a day are limited (a burst of throwaway sign-ups can’t fill the plan); the customer reads a safe message and the owner is told', async () => {
    const t = setup({ env: { UPLOAD_POST_NEW_PROFILES_PER_DAY: '1' } });
    await t.connections.connectLink('d1111111-2222-4333-8444-555555555555', 'x');
    const err = await t.connections.connectLink('d2111111-2222-4333-8444-555555555555', 'x').catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: 'CONNECTIONS_UNAVAILABLE' });
    expect(errorBody(err, null).body.error).not.toMatch(/upload|plan|day/i);
    expect(errorBody(err, { isAdmin: true }).body.hint).toContain('UPLOAD_POST_NEW_PROFILES_PER_DAY');
    expect(Object.keys(await alertsOf(t))).toContain('profile_budget');
    // a customer whose profile exists already isn't a new one
    expect((await t.connections.connectLink('d1111111-2222-4333-8444-555555555555', 'tiktok')).connectLink).toBeDefined();
  });

  it('set up without MEDIA_URL_SECRET: text posts go, and the owner reads that photos and videos need it', async () => {
    const t = setup({ env: { MEDIA_URL_SECRET: '' } });
    expect(t.impl.setUp).toBe(true);
    expect(t.impl.warning).toContain('MEDIA_URL_SECRET');
    expect(t.connections.hint).toContain('MEDIA_URL_SECRET');
    expect(t.impl.warning).not.toContain('test-media');
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

  it('lists Facebook Pages with profile= only; each business chooses its own Page (never inherits another’s); a Page pinned on the connect page is seen, and choosing another clears it', async () => {
    const t = setup();
    const u = `ylb_${customerTag(ALICE, t.env).slice(5)}`;
    mock.addProfile(u);
    mock.pages.facebook.set(u, [{ id: '1001', name: 'Joe’s Bakery' }, { id: '1002', name: 'Joe’s Catering' }]);
    mock.pages.facebook.set('ylb_someoneelse0000000000000', [{ id: '9999', name: 'Not Alice’s' }]);
    await connectVia(t, ALICE, 'facebook');
    const fb = async (projectId) => (await t.connections.status(ALICE, { projectId })).find((s) => s.platform === 'facebook');
    expect(await fb()).toMatchObject({ state: 'connected', targetsAvailable: 2 });
    const targets = await t.connections.targets(ALICE, 'facebook');
    expect(targets.map((x) => x.label)).toEqual(['Joe’s Bakery', 'Joe’s Catering']);
    expect(JSON.stringify(targets)).not.toMatch(/1001|1002|9999/);
    await t.connections.setTarget(ALICE, 'facebook', targets[1].id, { projectId: 'proj-b' });
    await t.connections.setTarget(ALICE, 'facebook', targets[0].id, { projectId: 'proj-a' });
    expect((await fb('proj-b')).targetLabel).toBe('Joe’s Catering');
    expect((await fb('proj-a')).targetLabel).toBe('Joe’s Bakery');
    // a business that never chose isn't handed another business's Page: it's asked to choose
    expect((await fb('proj-c')).targetLabel).toBeUndefined();
    expect(await t.connections.publish(ALICE, 'facebook', { projectId: 'proj-c', jobId: JOB(), composed: { text: 'x' } })).toMatchObject({ state: 'failed', errorCode: 'NO_TARGET' });

    // the customer picks Catering on the hosted page, which pins it (GET answers selected_page_id): it's seen, and
    // since it wins over the Page each upload names, every business shows it and the upload names it too
    mock.pins.facebook.set(u, '1002');
    await t.connections.check(ALICE, 'facebook');
    expect((await fb('proj-a')).targetLabel).toBe('Joe’s Catering');
    await t.connections.publish(ALICE, 'facebook', { projectId: 'proj-a', jobId: JOB(), composed: { text: 'Pinned' } });
    expect(mock.uploadCalls().pop().form.facebook_page_id).toBe('1002');

    // proj-a chooses Bakery again: the pin goes at Upload-Post (one DELETE), proj-a posts on Bakery, and the
    // businesses that never chose keep the pinned Page as their default
    const before = mock.calls.length;
    await t.connections.setTarget(ALICE, 'facebook', targets[0].id, { projectId: 'proj-a' });
    expect(mock.calls.slice(before).filter((c) => c.method === 'DELETE')).toEqual([expect.objectContaining({ path: '/api/uploadposts/users/facebook-page', body: { profile_username: u } })]);
    expect(mock.pins.facebook.has(u)).toBe(false);
    expect((await fb('proj-a')).targetLabel).toBe('Joe’s Bakery');
    expect((await fb('proj-b')).targetLabel).toBe('Joe’s Catering');
    expect((await fb('proj-c')).targetLabel).toBe('Joe’s Catering');
    await t.connections.publish(ALICE, 'facebook', { projectId: 'proj-a', jobId: JOB(), composed: { text: 'Mine' } });
    expect(mock.uploadCalls().pop().form.facebook_page_id).toBe('1001');
    expect(mock.violations).toEqual([]);
  });

  it('LinkedIn: a company page pinned on the connect page (by number or URN) is what every post goes out as', async () => {
    const t = setup();
    const u = `ylb_${customerTag('a2111111-2222-4333-8444-555555555555', t.env).slice(5)}`;
    mock.addProfile(u);
    mock.pages.linkedin.set(u, [{ id: 'urn:li:organization:42', name: 'Joe’s Bakery Co' }]);
    await connectVia(t, 'a2111111-2222-4333-8444-555555555555', 'linkedin', { display_name: 'Joe Baker' });
    const li = async () => (await t.connections.status('a2111111-2222-4333-8444-555555555555')).find((s) => s.platform === 'linkedin');
    expect(await li()).toMatchObject({ targetLabel: 'Joe Baker', targetKind: 'li_person' });
    mock.pins.linkedin.set(u, '42');
    await t.connections.check('a2111111-2222-4333-8444-555555555555', 'linkedin');
    expect(await li()).toMatchObject({ targetLabel: 'Joe’s Bakery Co', targetKind: 'li_org' });
    await t.connections.publish('a2111111-2222-4333-8444-555555555555', 'linkedin', { jobId: JOB(), composed: { text: 'As the company' } });
    expect(mock.uploadCalls().pop().form.target_linkedin_page_id).toBe('urn:li:organization:42');
    mock.pins.linkedin.delete(u);
  });

  it('one customer’s expired Facebook sign-in (401 facebook_reauth_required on the pin read) is their reconnect: nobody else is blocked and the owner isn’t told the key is bad', async () => {
    const t = setup();
    const CAROL = 'a3111111-2222-4333-8444-555555555555';
    const DAVE = 'a4111111-2222-4333-8444-555555555555';
    const u = `ylb_${customerTag(CAROL, t.env).slice(5)}`;
    mock.addProfile(u);
    mock.pages.facebook.set(u, [{ id: '5001', name: 'Carol’s Page' }]);
    await connectVia(t, CAROL, 'facebook');
    await connectVia(t, DAVE, 'x');
    mock.pinReauth.add(u);
    try {
      expect(await t.connections.check(CAROL, 'facebook')).toMatchObject({ state: 'needs_reconnect' });
      // the very next call, for someone else, goes out and posts
      const before = mock.uploadCalls().length;
      expect(await t.connections.publish(DAVE, 'x', { jobId: JOB(), composed: { text: 'Still posting' } })).toMatchObject({ state: 'sent' });
      expect(mock.uploadCalls().length).toBe(before + 1);
      expect(Object.keys(await alertsOf(t))).not.toContain('auth');
    } finally {
      mock.pinReauth.delete(u);
    }
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
    await t.impl.settled();
    expect(seen).toEqual([{ userId: ALICE, jobId, outcome: { state: 'sent', platform: 'instagram', url: 'https://instagram.com/p/abc' } }]);
  });

  it('answers at once and works afterwards: a slow profile read can’t make Upload-Post wait (10 s) or pause deliveries; a failure is never a 5xx', async () => {
    const t = setup();
    const KIM = 'c1111111-2222-4333-8444-555555555555';
    const { username } = await connectVia(t, KIM, 'instagram');
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = createUploadPostConnections({
      env: t.env,
      storage: t.storage,
      db: t.db,
      log: makeLog(),
      now: () => t.clock.t,
      fetch: async (url, init) => {
        if (String(url).includes(`/uploadposts/users/${username}`)) await gate;
        return fetch(url, init);
      },
    });
    mock.connect(username, 'x');
    const evt = mock.signed({ event: 'social_account_connected', profile_username: username, platform: 'x' }, { ts: Math.floor(t.clock.t / 1000) });
    const res = await slow.webhook(evt.raw, evt.headers);
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect((await docOf(t, KIM)).accounts.x).toBeUndefined();
    release();
    await slow.settled();
    expect((await docOf(t, KIM)).accounts.x).toBeDefined();
    // the work failing (the database is down for the routing read) still answered 200
    t.db.fail.billing_customers = () => true;
    try {
      const evt2 = mock.signed({ event: 'social_account_disconnected', profile_username: username, platform: 'x' }, { ts: Math.floor(t.clock.t / 1000) });
      expect((await slow.webhook(evt2.raw, evt2.headers)).status).toBe(200);
      await slow.settled();
    } finally {
      delete t.db.fail.billing_customers;
    }
  });

  it('a TikTok finished by its webhook with no web address reads the status first: drafts read as drafts, not “Posted”', async () => {
    const t = setup();
    const { username } = await connectVia(t, ALICE, 'tiktok');
    const seen = [];
    t.impl.setPostListener((userId, jobId, outcome) => seen.push(outcome));
    const jobId = JOB();
    mock.setUploadOutcome('inbox');
    await t.connections.publish(ALICE, 'tiktok', { jobId, composed: { text: 'Bread' }, media: { id: 'vid-tt9', kind: 'video', type: 'video/mp4', size: 6000 } });
    // the documented upload_completed result has no fallback_to_inbox
    const evt = mock.signed({ event: 'upload_completed', request_id: jobId, profile_username: username, platform: 'tiktok', result: { success: true, url: null, publish_id: 'p1', error: null } });
    await t.impl.webhook(evt.raw, evt.headers);
    await t.impl.settled();
    expect(seen).toEqual([{ state: 'sent', platform: 'tiktok', drafts: true }]);
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
    // a direct link to the file, ending in its extension (Upload-Post asks for one)
    expect(call.form['photos[]']).toEqual([expect.stringMatching(/^https:\/\/app\.test\/api\/media\/public\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.jpg$/)]);
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

  it('TikTok: a video keeps the account’s own audience (no setting sent, nothing read first); drafts (inbox fallback) end sent with no address', async () => {
    const t = setup();
    const { username } = await connectVia(t, ALICE, 'tiktok');
    const video = { id: 'vid-tt', kind: 'video', type: 'video/mp4', size: 6000 };
    mock.setUploadOutcome('inbox');
    const reads = mock.calls.filter((c) => c.path === '/api/uploadposts/tiktok/settings').length;
    const out = await t.connections.publish(ALICE, 'tiktok', { jobId: JOB(), composed: { text: 'Bread' }, media: video });
    expect(out).toMatchObject({ state: 'sent', ref: { outcome: 'drafts' } });
    expect(out.url).toBeUndefined();
    expect(mock.uploadCalls().pop().form.privacy_level).toBeUndefined();
    // a private account (no public option) posts its videos the same way, and an older connection the settings
    // read refuses is never marked for a reconnect over it
    mock.tiktokPrivacy.set(username, ['FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
    mock.tiktokSettings.set(username, { status: 400, body: { success: false, error_code: 'tiktok_reconnect_required' } });
    try {
      expect(await t.connections.publish(ALICE, 'tiktok', { jobId: JOB(), composed: { text: 'Bread' }, media: video })).toMatchObject({ state: 'sent' });
      expect(mock.calls.filter((c) => c.path === '/api/uploadposts/tiktok/settings').length).toBe(reads);
      expect((await t.connections.status(ALICE)).find((s) => s.platform === 'tiktok').state).toBe('connected');
    } finally {
      mock.tiktokPrivacy.delete(username);
      mock.tiktokSettings.delete(username);
    }
  });

  it('TikTok photos need an audience: public when the account has it, its followers on a private account, refused when neither; one asked for goes as it is (never quietly public)', async () => {
    const t = setup();
    const { username } = await connectVia(t, BOB, 'tiktok');
    const photo = { id: 'img-tt.jpg', kind: 'image', type: 'image/jpeg', size: 10 };
    expect(await t.connections.publish(BOB, 'tiktok', { jobId: JOB(), composed: { text: 'Buns' }, media: photo })).toMatchObject({ state: 'sent' });
    expect(mock.uploadCalls().pop().form.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    mock.tiktokPrivacy.set(username, ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY']);
    try {
      expect(await t.connections.publish(BOB, 'tiktok', { jobId: JOB(), composed: { text: 'Buns' }, media: photo })).toMatchObject({ state: 'sent' });
      expect(mock.uploadCalls().pop().form.privacy_level).toBe('FOLLOWER_OF_CREATOR');
      // asked for one the account doesn't have: Upload-Post refuses it before TikTok (nothing posted)
      expect(await t.connections.publish(BOB, 'tiktok', { jobId: JOB(), composed: { text: 'Buns' }, media: photo, privacy: 'PUBLIC_TO_EVERYONE' })).toMatchObject({ state: 'failed', errorCode: 'TIKTOK_PRIVACY' });
      expect(mock.uploadCalls().pop().form.privacy_level).toBe('PUBLIC_TO_EVERYONE');
      mock.tiktokPrivacy.set(username, ['SELF_ONLY']);
      const before = mock.uploadCalls().length;
      expect(await t.connections.publish(BOB, 'tiktok', { jobId: JOB(), composed: { text: 'Buns' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'TIKTOK_PRIVACY' });
      expect(mock.uploadCalls().length).toBe(before);
      // TikTok no longer takes the connection (409 reauth_required): a reconnect, not "couldn't reach the service"
      mock.tiktokSettings.set(username, { status: 409, body: { success: false, reauth_required: true } });
      expect(await t.connections.publish(BOB, 'tiktok', { jobId: JOB(), composed: { text: 'Buns' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'NEEDS_RECONNECT' });
      expect((await t.connections.status(BOB)).find((s) => s.platform === 'tiktok').state).toBe('needs_reconnect');
    } finally {
      mock.tiktokPrivacy.delete(username);
      mock.tiktokSettings.delete(username);
    }
  });

  it('caps and team limits: a daily cap is PLATFORM_LIMIT; the scheduled-post cap and our key are the owner’s (safe code, alert)', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const photo = { id: 'img-2.jpg', kind: 'image', type: 'image/jpeg', size: 10 };
    mock.setUploadOutcome('hard_cap');
    expect(await t.connections.publish(ALICE, 'instagram', { jobId: JOB(), composed: { text: 'a' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'PLATFORM_LIMIT' });
    mock.setUploadOutcome('scheduled_limit');
    expect(await t.connections.publish(ALICE, 'instagram', { jobId: JOB(), composed: { text: 'b' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' });
    expect(Object.keys(await alertsOf(t))).toContain('scheduled_limit');
    mock.setUploadOutcome('unauthorized');
    expect(await t.connections.publish(ALICE, 'instagram', { jobId: JOB(), composed: { text: 'c' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' });
    expect(Object.keys(await alertsOf(t))).toContain('auth');
    // the owner sees the most serious one
    expect((await t.impl.ownerView()).alert).toMatchObject({ kind: 'auth' });
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

  it('a status entry still “Queued” keeps the job waiting (never “Posted”); a retryable one too, and it ends “may have been posted”, never “failed”', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'x');
    const queued = JOB();
    mock.setUploadOutcome('async');
    // the first read answers the documented in-progress shape ({success: true, message: "Queued"}); the next one is done
    expect(await t.connections.publish(ALICE, 'x', { jobId: queued, composed: { text: 'Queued first' } })).toMatchObject({ state: 'sent', url: expect.stringMatching(/^https:\/\/social\.example\/x\//) });
    expect(mock.calls.filter((c) => c.path === '/api/uploadposts/status' && c.query.request_id === queued).length).toBe(2);
    // Upload-Post will retry it by itself: never "failed" (a "Try again" would post it twice)
    const retry = JOB();
    mock.setStatus(retry, { request_id: retry, status: 'in_progress', results: [{ platform: 'x', success: false, status: 'retryable', error_code: 'content_rejected' }] });
    mock.setUploadOutcome('async_pending');
    try {
      expect(await t.connections.publish(ALICE, 'x', { jobId: retry, composed: { text: 'Will be retried' } })).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
      expect(await t.connections.postStatus(ALICE, { requestId: retry, platform: 'x' })).toMatchObject({ pending: true });
    } finally {
      mock.setStatus(retry, null);
    }
  });

  it('a TikTok that failed with no code (TikTok’s internal error) may still go out after moderation: “may have been posted”, not “Try again”', async () => {
    const t = setup();
    await connectVia(t, BOB, 'tiktok');
    mock.setUploadOutcome('tiktok_internal');
    expect(await t.connections.publish(BOB, 'tiktok', { jobId: JOB(), composed: { text: 'Loaves' }, media: { id: 'vid-tt3', kind: 'video', type: 'video/mp4', size: 6000 } })).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
  });

  it('an identical upload a moment ago answers with that request’s id: its status is read (and kept) by that id', async () => {
    const t = setup();
    await connectVia(t, BOB, 'x');
    const jobId = JOB();
    mock.setUploadOutcome('existing_request');
    const out = await t.connections.publish(BOB, 'x', { jobId, composed: { text: 'Same as before' } });
    expect(out).toMatchObject({ state: 'sent', ref: { requestId: expect.stringMatching(/^up_/) } });
    expect(out.ref.requestId).not.toBe(jobId);
    expect(mock.calls.filter((c) => c.path === '/api/uploadposts/status').pop().query.request_id).toBe(out.ref.requestId);
    expect(await t.connections.postStatus(BOB, out.ref)).toMatchObject({ found: true });
  });

  it('an account gone at Upload-Post (400 invalid_platforms, an object) is “not connected”, and the doc learns it', async () => {
    const t = setup();
    const { username } = await connectVia(t, 'c2111111-2222-4333-8444-555555555555', 'youtube');
    delete mock.profiles.get(username).social_accounts.youtube;
    expect(await t.connections.publish('c2111111-2222-4333-8444-555555555555', 'youtube', { jobId: JOB(), composed: { text: 'd', title: 'T', description: 'd', tags: [] }, media: { id: 'vid-y', kind: 'video', type: 'video/mp4', size: 6000 } })).toMatchObject({ state: 'failed', errorCode: 'NOT_CONNECTED' });
    expect((await t.connections.status('c2111111-2222-4333-8444-555555555555')).find((s) => s.platform === 'youtube').state).toBe('not_connected');
  });

  it('X links (with the X Links add-on): each customer has a share of the 50 a month everyone shares; past it nothing is sent, and the owner hears when links were taken out', async () => {
    const t = setup({ env: { UPLOAD_POST_X_LINKS: 'on', UPLOAD_POST_X_LINK_POSTS_PER_CUSTOMER: '2' } });
    expect(t.impl.xLinks).toBe(true);
    const JO = 'c3111111-2222-4333-8444-555555555555';
    await connectVia(t, JO, 'x');
    const link = 'Order now https://joes.example/order';
    expect((await t.connections.publish(JO, 'x', { jobId: JOB(), composed: { text: link } })).state).toBe('sent');
    mock.setUploadOutcome('x_links_stripped');
    expect((await t.connections.publish(JO, 'x', { jobId: JOB(), composed: { text: link } })).state).toBe('sent');
    expect(Object.keys(await alertsOf(t))).toContain('x_links');
    const before = mock.uploadCalls().length;
    expect(await t.connections.publish(JO, 'x', { jobId: JOB(), composed: { text: link } })).toMatchObject({ state: 'failed', errorCode: 'X_LINKS_USED' });
    expect(mock.uploadCalls().length).toBe(before);
    // a post without a link is never counted
    expect((await t.connections.publish(JO, 'x', { jobId: JOB(), composed: { text: 'No link today' } })).state).toBe('sent');
    expect(t.db.rows('usage_ledger').filter((r) => r.endpoint === 'x:link_post')).toHaveLength(2);
  });

  it('refuses (nothing sent) when the business has no account there', async () => {
    const t = setup();
    const before = mock.uploadCalls().length;
    expect(await t.connections.publish('31111111-2222-4333-8444-555555555555', 'facebook', { jobId: JOB(), composed: { text: 'x' } })).toMatchObject({ state: 'failed', errorCode: 'NO_TARGET' });
    expect(mock.uploadCalls().length).toBe(before);
  });
});

describe('a connect whose webhook never came (Upload-Post sends each one once)', () => {
  it('the waiting row reads the profile back (at most every 30 s), and Connect again finds the account instead of a new link', async () => {
    const t = setup();
    const LEE = 'c4111111-2222-4333-8444-555555555555';
    await t.connections.connectLink(LEE, 'instagram');
    const { username } = await docOf(t, LEE);
    // the customer connected on the hosted page; the social_account_connected webhook was lost
    mock.connect(username, 'instagram');
    const ig = async () => (await t.connections.status(LEE)).find((s) => s.platform === 'instagram');
    t.clock.t += 31_000;
    expect((await ig()).state).toBe('connected');
    // reads are throttled while waiting
    await t.connections.connectLink(LEE, 'tiktok');
    mock.connect(username, 'tiktok');
    const reads = mock.calls.filter((c) => c.path === `/api/uploadposts/users/${username}`).length;
    await t.connections.status(LEE);
    expect(mock.calls.filter((c) => c.path === `/api/uploadposts/users/${username}`).length).toBe(reads);
    // Connect again: the profile is read first, so no second link
    expect(await t.connections.connectLink(LEE, 'tiktok')).toEqual({ alreadyConnected: true });
  });

  it('Check on a waiting row reads the profile back right away', async () => {
    const t = setup();
    const MAY = 'c5111111-2222-4333-8444-555555555555';
    await t.connections.connectLink(MAY, 'linkedin');
    const { username } = await docOf(t, MAY);
    mock.connect(username, 'linkedin');
    expect(await t.connections.check(MAY, 'linkedin')).toMatchObject({ state: 'connected' });
  });
});

describe('social stats (reads)', () => {
  it('reads the account’s numbers (Facebook with its Page) and its daily series; no cached-posts read (it only holds posts read one by one); a missing key is unknown', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const got = await t.connections.insights(ALICE, 'instagram', {});
    expect(got).toMatchObject({ followers: 1310, reach: 1000, views: 700, engagement: 64, series: [{ date: '2026-11-01', reach: 700 }, { date: '2026-11-02', reach: 300 }] });
    expect(got.postsCount).toBeUndefined();
    expect(got.topPosts).toBeUndefined();
    expect(mock.calls.some((c) => c.path === '/api/uploadposts/post-analytics/cached')).toBe(false);
    expect(t.db.rows('usage_ledger').filter((r) => r.feature === 'social').every((r) => r.vendor === 'uploadpost')).toBe(true);
    const u = (await docOf(t, ALICE)).username;
    mock.pages.facebook.set(u, [{ id: '3001', name: 'Alice’s Page' }]);
    await connectVia(t, ALICE, 'facebook');
    expect((await t.connections.insights(ALICE, 'facebook', {})).followers).toBe(1310);
    expect(mock.calls.filter((c) => c.path === `/api/analytics/${u}` && c.query.platforms === 'facebook').pop().query).toMatchObject({ page_id: '3001', days: '30' });
  });

  it('a series is what the network counts: TikTok’s is views, X’s impressions (never charted as reach)', async () => {
    const t = setup();
    await connectVia(t, BOB, 'tiktok');
    await connectVia(t, BOB, 'x');
    expect((await t.connections.insights(BOB, 'tiktok', {})).series[0]).toEqual({ date: '2026-11-01', views: 700 });
    expect((await t.connections.insights(BOB, 'x', {})).series[0]).toEqual({ date: '2026-11-01', impressions: 700 });
  });

  it('LinkedIn: a personal profile has no stats at Upload-Post (it would answer for some company page), so it reads public data; a company page is asked for by its URN', async () => {
    const t = setup();
    const CAROL = 'b1111111-2222-4333-8444-555555555555';
    const u = `ylb_${customerTag(CAROL, t.env).slice(5)}`;
    mock.addProfile(u);
    mock.pages.linkedin.set(u, [{ id: 'urn:li:organization:77', name: 'Carol Co' }]);
    await connectVia(t, CAROL, 'linkedin');
    const reads = mock.calls.length;
    expect(await t.connections.insights(CAROL, 'linkedin', {})).toBeNull();
    expect(mock.calls.slice(reads).some((c) => c.path.startsWith('/api/analytics/'))).toBe(false);
    const org = (await t.connections.targets(CAROL, 'linkedin')).find((x) => x.kind === 'li_org');
    await t.connections.setTarget(CAROL, 'linkedin', org.id, { projectId: 'p1' });
    expect((await t.connections.insights(CAROL, 'linkedin', { projectId: 'p1' })).followers).toBe(1310);
    expect(mock.calls.filter((c) => c.path === `/api/analytics/${u}`).pop().query).toMatchObject({ platforms: 'linkedin', page_urn: 'urn:li:organization:77' });
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
  it('account deletion: forgetUser stops social and marks the profile but deletes nothing, so a deletion that stops (unforgetUser) loses no connection; userDeleted deletes the profile once the account is gone', async () => {
    const t = setup();
    const { username } = await connectVia(t, ALICE, 'instagram');
    await t.connections.forgetUser(ALICE);
    expect(mock.profiles.has(username)).toBe(true);
    expect((await t.connections.status(ALICE)).every((s) => s.state === 'not_connected' || s.state === 'coming_soon')).toBe(true);
    expect((await t.storage.get('uploadpost:gone')).value[username]).toBeDefined();
    // the deletion stopped (Zernio, Omnisend or the account itself failed): everything is as it was
    await t.connections.unforgetUser(ALICE);
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'instagram').state).toBe('connected');
    expect((await t.storage.get('uploadpost:gone')).value[username]).toBeUndefined();
    // it went through: the profile (and every account in it) goes now, and its cost so far is on the ledger
    await t.connections.forgetUser(ALICE);
    await t.impl.userDeleted(ALICE);
    expect(mock.profiles.has(username)).toBe(false);
    expect((await t.storage.get('uploadpost:gone')).value[username]).toBeUndefined();
    expect((await docOf(t, ALICE)).username).toBeUndefined();
  });

  it('a profile whose delete failed after the account went is deleted by the daily check (it was marked); a mark whose customer is still here is dropped', async () => {
    const t = setup();
    const ERIN = 'b2111111-2222-4333-8444-555555555555';
    const { username } = await connectVia(t, ERIN, 'x');
    await t.connections.forgetUser(ERIN);
    // the account is gone (its billing row with it), but Upload-Post's delete didn't happen
    t.db.tables.set('billing_customers', t.db.rows('billing_customers').filter((r) => r.user_id !== ERIN));
    expect((await t.impl.reconcileIfDue()).deleted).toBe(1);
    expect(mock.profiles.has(username)).toBe(false);
    expect((await t.storage.get('uploadpost:gone')).value[username]).toBeUndefined();
  });

  it('the monthly estimate: a failed insert leaves the month open, the next run writes only what’s missing; a customer deleted mid-month is charged up to then', async () => {
    const t = setup({ start: Date.parse('2026-10-01T00:00:00Z') });
    const FRAN = 'b3111111-2222-4333-8444-555555555555';
    const GIL = 'b4111111-2222-4333-8444-555555555555';
    await connectVia(t, FRAN, 'x');
    await connectVia(t, GIL, 'x');
    t.clock.t = Date.parse('2026-11-01T06:00:00Z');
    let inserts = 0;
    t.db.fail.usage_ledger = (op) => op === 'insert' && (inserts += 1) === 1;
    const first = await t.impl.meterIfDue();
    expect(first).toMatchObject({ rows: 1, incomplete: true });
    delete t.db.fail.usage_ledger;
    // the next daily run (after the 2-hour claim) finishes the month without a second row for anyone
    t.clock.t += 3 * 3_600_000;
    expect((await t.impl.meterIfDue()).rows).toBe(1);
    t.clock.t += 3 * 3_600_000;
    expect((await t.impl.meterIfDue()).skipped).toBe(true);
    const rows = t.db.rows('usage_ledger').filter((r) => r.endpoint === 'upload_post_profile 2026-10');
    expect(rows.map((r) => r.customer_tag).sort()).toEqual([customerTag(FRAN, t.env), customerTag(GIL, t.env)].sort());
    expect(rows.every((r) => r.cost_micro === 1_960_000)).toBe(true);
    // GIL is deleted on 16 November: half of November is written now (the monthly run won't see GIL)
    t.clock.t = Date.parse('2026-11-16T00:00:00Z');
    await t.connections.forgetUser(GIL);
    await t.impl.userDeleted(GIL);
    const nov = t.db.rows('usage_ledger').find((r) => r.endpoint === 'upload_post_profile 2026-11' && r.customer_tag === customerTag(GIL, t.env));
    expect(nov.cost_micro).toBeGreaterThan(900_000);
    expect(nov.cost_micro).toBeLessThan(1_100_000);
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

  it('the daily reconcile never deletes a profile because its customer looks absent: an unknown ylb_ profile, an empty database or a doc it can’t read is left alone (the owner is told)', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'x');
    const alices = (await docOf(t, ALICE)).username;
    mock.addProfile('ylb_abcabcabcabcabcabcabcabc');
    mock.addProfile('owner_test_profile');
    // ALICE's doc can't be read (the app_state secret changed)
    const key = `uploadpost:user:${sha256(ALICE)}`;
    const kept = t.storage.documents.get(key);
    t.storage.documents.set(key, { unreadable: true, value: null, updatedAt: kept.updatedAt });
    const r = await t.impl.reconcileIfDue();
    expect(r.deleted).toBe(0);
    for (const u of ['ylb_abcabcabcabcabcabcabcabc', 'owner_test_profile', alices]) expect(mock.profiles.has(u)).toBe(true);
    expect((await alertsOf(t)).profile_orphans).toMatchObject({ n: expect.any(Number) });
    expect((await t.impl.reconcileIfDue()).skipped).toBe(true);
    // a copy of the app on an empty database (no customers at all) deletes nothing either
    const empty = createUploadPostConnections({ env: t.env, storage: makeStorage(), db: makeDb(), log: makeLog(), now: () => t.clock.t });
    expect((await empty.reconcileIfDue()).deleted).toBe(0);
    expect(mock.profiles.has(alices)).toBe(true);
    t.storage.documents.set(key, kept);
    mock.profiles.delete('ylb_abcabcabcabcabcabcabcabc');
  });

  it('the daily reconcile reads back every profile whose accounts changed without a webhook, and gives back a profile nobody connected anything to for a week', async () => {
    const t = setup();
    const HAL = 'b5111111-2222-4333-8444-555555555555';
    const IVY = 'b6111111-2222-4333-8444-555555555555';
    const { username: hals } = await connectVia(t, HAL, 'youtube');
    // IVY pressed Connect but never finished; HAL connected Instagram and its webhook was lost
    await t.connections.connectLink(IVY, 'x');
    const ivys = (await docOf(t, IVY)).username;
    mock.connect(hals, 'instagram');
    t.clock.t += 8 * 86_400_000;
    const r = await t.impl.reconcileIfDue();
    expect((await docOf(t, HAL)).accounts.instagram).toBeDefined();
    expect(r.reclaimed).toBe(1);
    expect(mock.profiles.has(ivys)).toBe(false);
    expect(mock.profiles.has(hals)).toBe(true);
    const ivy = await docOf(t, IVY);
    expect(ivy.username).toBeUndefined();
    expect(ivy.lastLife).toMatchObject({ from: expect.any(String), to: expect.any(String) });
    // the next Connect makes it again
    expect((await t.connections.connectLink(IVY, 'x')).connectLink).toMatch(/\/connect\?token=/);
    expect(mock.profiles.has(ivys)).toBe(true);
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
  it('reads one platform’s finished entry (an upload’s own result, a webhook); never trusts a top-level success, never renders a non-https address', () => {
    const final = { final: true };
    expect(outcomeOfEntry({ success: true, url: 'https://x.com/1' }, final)).toEqual({ state: 'sent', url: 'https://x.com/1' });
    expect(outcomeOfEntry({ success: true, post_url: 'Video sent to Inbox (No Public URL)', fallback_to_inbox: true }, final)).toEqual({ state: 'sent', drafts: true });
    expect(outcomeOfEntry({ success: true, post_url: 'javascript:alert(1)' }, final)).toEqual({ state: 'sent' });
    expect(outcomeOfEntry({ status: 'processing' }, final)).toEqual({ state: 'pending' });
    expect(outcomeOfEntry({ success: false, error_code: 'account_checkpoint_required' }, final)).toEqual({ state: 'failed', errorCode: 'ACCOUNT_CHECK' });
    expect(outcomeOfEntry({ success: false, error_code: 'spam_risk_too_many_pending_share' }, { ...final, platform: 'tiktok' })).toEqual({ state: 'failed', errorCode: 'TIKTOK_DRAFTS_FULL' });
    expect(outcomeOfEntry({ status: 'skipped' })).toEqual({ state: 'failed', errorCode: 'NOT_CONNECTED' });
  });

  it('a /status entry is an answer only when it or the whole request says so: “Queued” with success true is still going; retryable is still going', () => {
    // the documented in-progress answer
    expect(outcomeOfEntry({ platform: 'x', success: true, message: 'Queued' }, { top: 'in_progress' })).toEqual({ state: 'pending' });
    expect(outcomeOfEntry({ platform: 'x', success: false }, { top: 'in_progress' })).toEqual({ state: 'pending' });
    expect(outcomeOfEntry({ platform: 'x', success: false, status: 'retryable', error_code: 'content_rejected' }, { top: 'failed' })).toEqual({ state: 'pending' });
    expect(outcomeOfEntry({ platform: 'x', success: true, message: 'Published' }, { top: 'completed' })).toEqual({ state: 'sent' });
    expect(outcomeOfEntry({ platform: 'x', success: true, status: 'completed' }, { top: 'in_progress' })).toEqual({ state: 'sent' });
    expect(outcomeOfEntry({ platform: 'x', success: false, error_code: 'content_rejected' }, { top: 'failed' })).toEqual({ state: 'failed', errorCode: 'REFUSED' });
  });

  it('a TikTok failure with no code (TikTok’s internal error, which TikTok sometimes publishes after moderation) may have been posted', () => {
    expect(outcomeOfEntry({ success: false, error: 'TikTok received the video but answered with an internal error' }, { platform: 'tiktok', final: true })).toEqual({ state: 'unknown', errorCode: 'UNCONFIRMED' });
    expect(outcomeOfEntry({ platform: 'tiktok', success: false }, { top: 'failed' })).toEqual({ state: 'unknown', errorCode: 'UNCONFIRMED' });
    expect(outcomeOfEntry({ success: false }, { platform: 'instagram', final: true })).toEqual({ state: 'failed', errorCode: 'REFUSED' });
  });
});
