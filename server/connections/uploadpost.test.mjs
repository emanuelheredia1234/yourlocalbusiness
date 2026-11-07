// Social accounts through Upload-Post (server/connections/uploadpost.mjs + server/uploadpost.mjs) against
// server/test/mock-uploadpost.mjs: the client's key handling, budget and bad-key guard, one profile per business
// (ylb_ + the customer tag + _ + a keyed hash of the business, stored once), each user's limit of businesses and the
// plan's cap kept from customers (and safe when two clicks race), isolation between businesses and between users,
// the hosted connect page with full branding, Pages always asked with profile=, signed webhooks routed to exactly one
// customer and business, one-attempt posting through the post's business, social stats per business, deleting a
// business or an account, the monthly estimate per business and the daily reconcile. Nothing here reaches Upload-Post.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUploadPostConnections, hasXLink, outcomeOfEntry, PROFILE_USERNAME, profileUsername } from './uploadpost.mjs';
import { combineConnections, createConnections } from './index.mjs';
import { createUploadPostClient, UPLOAD_POST_BASE_URL, uploadPostBase, upError } from '../uploadpost.mjs';
import { customerTag, errorBody, sha256 } from '../integrations/common.mjs';
import { createMockUploadPost, signUploadPost, TEST_UPLOAD_POST_KEY, TEST_UPLOAD_POST_WEBHOOK_SECRET } from '../test/mock-uploadpost.mjs';
import { makeDb, makeLog, makeStorage } from '../test/fakes.mjs';

const ALICE = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';
const BOB = '7d1e2b3c-4a5f-4b6c-8d7e-9f0a1b2c3d4e';
const TAG_SECRET = 'test-customer-tag-secret-0123456789';
/** Each user's first business (the app's ids look like proj_<12 characters>). */
const P1 = 'proj_bakery00001';
const P2 = 'proj_catering002';
const P3 = 'proj_foodtruck03';
const P4 = 'proj_popupshop04';
const JOB = () => crypto.randomUUID();

let mock;
beforeAll(async () => {
  mock = await createMockUploadPost().start();
});
afterAll(async () => {
  await mock.close();
});

function setup({ env = {}, start = Date.now(), storage = makeStorage(), db = makeDb(), billing = null } = {}) {
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
  const impl = createUploadPostConnections({ env: fullEnv, storage, db, log, now: () => clock.t, sleep: async (ms) => void (clock.t += ms), billing });
  return { impl, connections: createConnections(combineConnections({ social: impl })), storage, db, log, env: fullEnv, clock };
}

const docOf = async (t, userId) => (await t.storage.get(`uploadpost:user:${sha256(userId)}`))?.value;
/** A business's profile name, as stored. */
const nameOf = async (t, userId, projectId = P1) => (await docOf(t, userId))?.profiles?.find((p) => p.projectId === projectId)?.username;
/** A business saved to the user's account (user_docs), as the app's cloud save makes it. */
const business = (t, userId, projectId = P1) => t.db.insert('user_docs', { user_id: userId, kind: 'project', id: projectId, data: { id: projectId } }, { ignoreDuplicates: true });
/** The owner's stored alerts ({ kind: { at, n?, tag? } }), once their writes have landed. */
const alertsOf = async (t) => {
  await t.impl.settled();
  return (await t.storage.get('uploadpost:alerts'))?.value ?? {};
};
const statusOf = async (t, userId, platform, projectId = P1) => (await t.connections.status(userId, { projectId })).find((s) => s.platform === platform);

/** Connect a network for a business the way a customer does: the link, the hosted page (mock), then the signed webhook. */
async function connectVia(t, userId, platform, account = {}, projectId = P1) {
  await business(t, userId, projectId);
  const link = await t.connections.connectLink(userId, platform, { projectId });
  const username = await nameOf(t, userId, projectId);
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

  it('sends the key only as `Authorization: Apikey`, never in a query or a log; a profile name never reaches a log', async () => {
    const log = makeLog();
    const client = createUploadPostClient({ env: { UPLOAD_POST_API_KEY: TEST_UPLOAD_POST_KEY, UPLOAD_POST_BASE_URL: mock.base }, log });
    const before = mock.calls.length;
    expect((await client.call('GET', '/uploadposts/users/ylb_ffffffffffffffffffffffff_eeeeeeee')).status).toBe(404);
    expect(mock.calls[before].auth).toBe('apikey');
    expect(JSON.stringify(mock.calls[before].query)).not.toContain(TEST_UPLOAD_POST_KEY);
    expect(log.text()).not.toContain(TEST_UPLOAD_POST_KEY);
    expect(log.text()).not.toContain('ffffffffffffffffffffffff');
    expect(log.text()).not.toContain('eeeeeeee');
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
    expect((await client.call('GET', '/uploadposts/users/facebook-page', { query: { profile_username: 'ylb_aaaaaaaaaaaaaaaaaaaaaaaa_aaaaaaaa' } })).status).toBe(401);
    expect(alerts).toEqual([]);
    // the next call, for anyone, goes out
    expect((await client.call('POST', '/upload_text', { form: { user: 'ylb_bbbbbbbbbbbbbbbbbbbbbbbb_bbbbbbbb' }, headers: { 'Idempotency-Key': 'k1' } })).status).toBe(200);
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

describe('one profile per business', () => {
  it('is named ylb_ + the customer tag + _ + a keyed hash of the business: opaque, 37 characters Upload-Post allows, never a user id, email or project id', () => {
    const tag = customerTag(ALICE, { CUSTOMER_TAG_SECRET: TAG_SECRET });
    const a = profileUsername(tag, ALICE, P1, TAG_SECRET);
    const b = profileUsername(tag, ALICE, P2, TAG_SECRET);
    expect(a).toMatch(PROFILE_USERNAME);
    expect(a).toMatch(/^[A-Za-z0-9_@-]{1,40}$/);
    expect(a).toHaveLength(37);
    expect(a.startsWith(`ylb_${tag.slice(5)}_`)).toBe(true);
    expect(b).not.toBe(a);
    // the same business of another user gets another name; another secret gives another name
    expect(profileUsername(customerTag(BOB, { CUSTOMER_TAG_SECRET: TAG_SECRET }), BOB, P1, TAG_SECRET)).not.toBe(a);
    expect(profileUsername(tag, ALICE, P1, 'another-secret-entirely-0000')).not.toBe(a);
    for (const leak of [ALICE, ALICE.replace(/-/g, ''), P1, 'bakery']) expect(a).not.toContain(leak);
  });

  it('is made on the first Connect for that business, once; each business gets its own; nothing is sent about the user', async () => {
    const t = setup();
    await business(t, ALICE, P1);
    await business(t, ALICE, P2);
    await t.connections.connectLink(ALICE, 'facebook', { projectId: P1 });
    await t.connections.connectLink(ALICE, 'instagram', { projectId: P1 });
    await t.connections.connectLink(ALICE, 'instagram', { projectId: P2 });
    const one = await nameOf(t, ALICE, P1);
    const two = await nameOf(t, ALICE, P2);
    expect(one).toBe(profileUsername(customerTag(ALICE, t.env), ALICE, P1, TAG_SECRET));
    expect(two).toBe(profileUsername(customerTag(ALICE, t.env), ALICE, P2, TAG_SECRET));
    expect(one).not.toBe(two);
    const creates = mock.calls.filter((c) => c.method === 'POST' && c.path === '/api/uploadposts/users' && [one, two].includes(c.body?.username));
    expect(creates).toHaveLength(2);
    for (const c of creates) {
      expect(JSON.stringify(c.body)).not.toContain(ALICE);
      expect(JSON.stringify(c.body)).not.toMatch(/proj_/);
      expect(c.body.display_name).toMatch(/^Customer [0-9a-f]{8} business [0-9a-f]{8}$/);
    }
    // the hosted page was asked for each business's own profile, with no business id in the back button
    expect(mock.jwtBodies.slice(-3).map((b) => b.username)).toEqual([one, one, two]);
    expect(JSON.stringify(mock.jwtBodies.slice(-3))).not.toMatch(/proj_/);
    expect(await t.connections.slots(ALICE)).toEqual({ used: 2, cap: 3, projects: [P1, P2], orphans: [] });
    expect(mock.violations).toEqual([]);
  });

  it('is stored once and never computed again: a business keeps its profile name even after the tag secret changes', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'x');
    const stored = await nameOf(t, ALICE);
    const creates = () => mock.calls.filter((c) => c.method === 'POST' && c.path === '/api/uploadposts/users').length;
    const before = creates();
    // a second copy of the app on the same storage with another secret (a mistake the owner must not make)
    const other = createUploadPostConnections({ env: { ...t.env, CUSTOMER_TAG_SECRET: 'a-different-customer-tag-secret-99' }, storage: t.storage, db: t.db, log: makeLog(), now: () => t.clock.t });
    expect(await createConnections(combineConnections({ social: other })).connectLink(ALICE, 'tiktok', { projectId: P1 })).toMatchObject({ connectLink: expect.any(String) });
    expect(mock.jwtBodies.pop().username).toBe(stored);
    expect(creates()).toBe(before);
    expect(await nameOf(t, ALICE)).toBe(stored);
  });

  it('needs one of the user’s own saved businesses: none named, a malformed id or one not in their account is refused and nothing is made', async () => {
    const t = setup();
    const before = mock.calls.length;
    await expect(t.connections.connectLink(ALICE, 'facebook')).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    await expect(t.connections.connectLink(ALICE, 'facebook', { projectId: '../../users' })).rejects.toMatchObject({ status: 400 });
    await expect(t.connections.connectLink(ALICE, 'facebook', { projectId: '__proto__' })).rejects.toMatchObject({ status: 400 });
    await expect(t.connections.connectLink(ALICE, 'facebook', { projectId: 'proj_notsavedyet' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    // Bob's business id is not Alice's business
    await business(t, BOB, 'proj_bobsbusiness');
    await expect(t.connections.connectLink(ALICE, 'facebook', { projectId: 'proj_bobsbusiness' })).rejects.toMatchObject({ status: 404 });
    expect(mock.calls.slice(before).filter((c) => c.method !== 'GET')).toEqual([]);
    expect(await docOf(t, ALICE)).toBeUndefined();
  });

  it('a profile that already exists (409) is fine, and a missing one is made again once on connect, with the same name', async () => {
    const t = setup();
    await business(t, BOB, P1);
    const name = profileUsername(customerTag(BOB, t.env), BOB, P1, TAG_SECRET);
    mock.addProfile(name);
    await t.connections.connectLink(BOB, 'x', { projectId: P1 });
    expect(await nameOf(t, BOB)).toBe(name);
    mock.profiles.delete(name);
    const r = await t.connections.connectLink(BOB, 'x', { projectId: P1 });
    expect(r.connectLink).toMatch(/\/connect\?token=/);
    expect(mock.profiles.has(name)).toBe(true);
  });

  it('opens the hosted page with the full branding on every call, for that one network, and the app (GSC_APP_PROPERTY’s host) as the back button', async () => {
    const t = setup({ env: { UPLOAD_POST_CONNECT_TITLE: 'Connect Joe’s accounts' } });
    await business(t, ALICE);
    const a = await t.connections.connectLink(ALICE, 'linkedin', { projectId: P1 });
    const b = await t.connections.connectLink(ALICE, 'tiktok', { projectId: P1 });
    expect(a.connectLink).not.toBe(b.connectLink);
    expect(Date.parse(a.expiresAt) - t.clock.t).toBe(48 * 3_600_000);
    const [first, second] = mock.jwtBodies.slice(-2);
    for (const body of [first, second]) {
      expect(body).toMatchObject({ redirect_url: 'https://yourlocalbusiness.replit.app/?settings=accounts#workspace-settings', logo_image: 'https://cdn.example/logo.png', connect_title: 'Connect Joe’s accounts', redirect_button_text: expect.any(String), connect_description: expect.any(String), show_calendar: false, readonly_calendar: false, connect_theme: 'light' });
    }
    expect(first.platforms).toEqual(['linkedin']);
    expect(second.platforms).toEqual(['tiktok']);
    expect((await statusOf(t, ALICE, 'linkedin')).state).toBe('pending');
    // another of Alice's businesses isn't waiting for anything
    expect((await statusOf(t, ALICE, 'linkedin', P2)).state).toBe('not_connected');
    // the back button follows GSC_APP_PROPERTY
    const custom = setup({ env: { GSC_APP_PROPERTY: 'https://app.joes.example/' } });
    const NED = 'e2111111-2222-4333-8444-555555555555';
    await business(custom, NED);
    await custom.connections.connectLink(NED, 'x', { projectId: P1 });
    expect(mock.jwtBodies.pop().redirect_url).toBe('https://app.joes.example/?settings=accounts#workspace-settings');
  });

  it('the plan’s cap: the customer reads a safe message, the owner gets the hint and an alert; nothing is made and no slot is kept', async () => {
    const t = setup();
    const CARL = '11111111-2222-4333-8444-555555555555';
    await business(t, CARL);
    mock.cap = mock.profiles.size;
    try {
      const err = await t.connections.connectLink(CARL, 'facebook', { projectId: P1 }).catch((e) => e);
      expect(err).toMatchObject({ status: 503, code: 'CONNECTIONS_UNAVAILABLE' });
      const customer = JSON.stringify(errorBody(err, null).body);
      expect(customer).not.toMatch(/upload-post|plan|add-on|owner@|PROFILE_LIMIT/i);
      expect(errorBody(err, { isAdmin: true }).body.hint).toMatch(/profile/i);
      expect(Object.keys(await alertsOf(t))).toContain('profile_cap');
      expect(await t.connections.slots(CARL)).toMatchObject({ used: 0 });
    } finally {
      mock.cap = 75;
    }
  });

  it('a 403 PROFILE_LIMIT_REACHED from the create itself (the list was stale) reads the same safe way, and gives the slot back', async () => {
    const t = setup();
    const DIA = '21111111-2222-4333-8444-555555555555';
    await business(t, DIA);
    const before = mock.profiles.size;
    await t.impl.ownerView(); // caches the list with room
    mock.cap = before;
    try {
      const err = await t.connections.connectLink(DIA, 'facebook', { projectId: P1 }).catch((e) => e);
      expect(err).toMatchObject({ code: 'CONNECTIONS_UNAVAILABLE' });
      expect(errorBody(err, null).body.error).not.toMatch(/upload|plan/i);
      expect(await t.connections.slots(DIA)).toMatchObject({ used: 0, projects: [] });
    } finally {
      mock.cap = 75;
    }
  });

  it('a blocked profile (403 PROFILE_BLOCKED) tells the owner, not the customer', async () => {
    const t = setup();
    const OLA = 'e3111111-2222-4333-8444-555555555555';
    await business(t, OLA);
    await t.connections.connectLink(OLA, 'youtube', { projectId: P1 });
    const username = await nameOf(t, OLA);
    mock.blocked.add(username);
    try {
      const err = await t.connections.connectLink(OLA, 'x', { projectId: P1 }).catch((e) => e);
      expect(err).toMatchObject({ status: 503, code: 'CONNECTIONS_UNAVAILABLE' });
      expect(errorBody(err, null).body.error).not.toMatch(/blocked|plan|upload/i);
      expect(Object.keys(await alertsOf(t))).toContain('profile_blocked');
    } finally {
      mock.blocked.delete(username);
    }
  });

  it('Pinterest is coming soon; ad platforms aren’t this side’s', async () => {
    const t = setup();
    await business(t, ALICE);
    await expect(t.connections.connectLink(ALICE, 'pinterest', { projectId: P1 })).rejects.toMatchObject({ status: 400 });
    expect((await statusOf(t, ALICE, 'pinterest')).state).toBe('coming_soon');
    await expect(t.connections.connectLink(ALICE, 'meta_ads', { projectId: P1 })).rejects.toMatchObject({ code: 'CONNECTIONS_NOT_ENABLED' });
  });

  it('new profiles a day are limited (a burst of throwaway sign-ups can’t fill the plan); the customer reads a safe message and the owner is told', async () => {
    const t = setup({ env: { UPLOAD_POST_NEW_PROFILES_PER_DAY: '1' } });
    const D1 = 'd1111111-2222-4333-8444-555555555555';
    const D2 = 'd2111111-2222-4333-8444-555555555555';
    await business(t, D1);
    await business(t, D2);
    await t.connections.connectLink(D1, 'x', { projectId: P1 });
    const err = await t.connections.connectLink(D2, 'x', { projectId: P1 }).catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: 'CONNECTIONS_UNAVAILABLE' });
    expect(errorBody(err, null).body.error).not.toMatch(/upload|plan|day/i);
    expect(errorBody(err, { isAdmin: true }).body.hint).toContain('UPLOAD_POST_NEW_PROFILES_PER_DAY');
    expect(Object.keys(await alertsOf(t))).toContain('profile_budget');
    // a business whose profile exists already isn't a new one
    expect((await t.connections.connectLink(D1, 'tiktok', { projectId: P1 })).connectLink).toBeDefined();
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
    await expect(t.connections.connectLink(ALICE, 'facebook', { projectId: P1 })).rejects.toMatchObject({ code: 'NOT_SET_UP' });
  });
});

describe('each user’s limit of businesses (UPLOAD_POST_MAX_PROFILES_PER_USER)', () => {
  it('3 by default: the 4th business is refused plainly with how many are used, the owner is told which customer, and nothing is made', async () => {
    const t = setup();
    const EVE = 'e1111111-2222-4333-8444-555555555555';
    for (const p of [P1, P2, P3, P4]) await business(t, EVE, p);
    for (const p of [P1, P2, P3]) await t.connections.connectLink(EVE, 'x', { projectId: p });
    const before = mock.profiles.size;
    const err = await t.connections.connectLink(EVE, 'x', { projectId: P4 }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'BUSINESS_LIMIT', extra: { used: 3, cap: 3 } });
    const body = errorBody(err, null).body;
    expect(body.error).toMatch(/up to 3 businesses/);
    expect(body.error).not.toMatch(/upload-post|plan|UPLOAD_POST/i);
    expect(errorBody(err, { isAdmin: true }).body.hint).toContain('UPLOAD_POST_MAX_PROFILES_PER_USER');
    expect(mock.profiles.size).toBe(before);
    expect((await alertsOf(t)).profile_user_cap).toMatchObject({ tag: customerTag(EVE, t.env), n: 3 });
    expect(await t.connections.slots(EVE)).toMatchObject({ used: 3, cap: 3 });
    // a business that has its profile keeps connecting more networks
    expect((await t.connections.connectLink(EVE, 'tiktok', { projectId: P2 })).connectLink).toBeDefined();
    // the owner raised it for everyone
    const raised = setup({ env: { UPLOAD_POST_MAX_PROFILES_PER_USER: '4' }, storage: t.storage, db: t.db });
    expect((await raised.connections.connectLink(EVE, 'x', { projectId: P4 })).connectLink).toBeDefined();
    expect(await raised.connections.slots(EVE)).toMatchObject({ used: 4, cap: 4 });
  });

  it('two Connect clicks at once never make two profiles for one business, nor pass the limit with two businesses', async () => {
    const t = setup({ env: { UPLOAD_POST_MAX_PROFILES_PER_USER: '2' } });
    const FAY = 'f1111111-2222-4333-8444-555555555555';
    for (const p of [P1, P2, P3]) await business(t, FAY, p);
    const createsFor = (u) => mock.calls.filter((c) => c.method === 'POST' && c.path === '/api/uploadposts/users' && c.body?.username === u);
    // the same business, twice at once: one profile, one stored name
    const [a, b] = await Promise.all([t.connections.connectLink(FAY, 'x', { projectId: P1 }), t.connections.connectLink(FAY, 'tiktok', { projectId: P1 })]);
    expect(a.connectLink && b.connectLink).toBeTruthy();
    const name = await nameOf(t, FAY, P1);
    expect([...mock.profiles.keys()].filter((u) => u.startsWith(name.slice(0, 29)))).toEqual([name]);
    expect(createsFor(name).length).toBeLessThanOrEqual(2);
    // two more businesses at once with one slot left: one gets it, the other is refused
    const out = await Promise.allSettled([t.connections.connectLink(FAY, 'x', { projectId: P2 }), t.connections.connectLink(FAY, 'x', { projectId: P3 })]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(out.find((o) => o.status === 'rejected').reason).toMatchObject({ code: 'BUSINESS_LIMIT' });
    expect(await t.connections.slots(FAY)).toMatchObject({ used: 2 });
    expect([...mock.profiles.keys()].filter((u) => u.startsWith(name.slice(0, 29)))).toHaveLength(2);
  });
});

describe('the limit with plans (spec §A6.4): business_limit replaces the env cap once plans are enforced', () => {
  it('follows the plan’s business limit, says so in our words, and goes back to the env value when plans are off', async () => {
    let limit = 2;
    const billing = { businessLimit: async () => limit };
    const t = setup({ billing });
    const GUS = 'a9111111-2222-4333-8444-555555555555';
    for (const p of [P1, P2, P3, P4]) await business(t, GUS, p);
    for (const p of [P1, P2]) await t.connections.connectLink(GUS, 'x', { projectId: p });
    expect(await t.connections.slots(GUS)).toMatchObject({ used: 2, cap: 2 });
    const err = await t.connections.connectLink(GUS, 'x', { projectId: P3 }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'BUSINESS_LIMIT', extra: { used: 2, cap: 2 } });
    expect(errorBody(err, null).body.error).toBe('Your plan includes 2 businesses with social accounts. Add a business in Settings › Plan.');
    // a business added on the plan: the third connects
    limit = 3;
    expect((await t.connections.connectLink(GUS, 'x', { projectId: P3 })).connectLink).toBeDefined();
    // a paused plan: nothing new (the existing ones are kept)
    limit = 0;
    const paused = await t.connections.connectLink(GUS, 'x', { projectId: P4 }).catch((e) => e);
    expect(paused).toMatchObject({ status: 402, code: 'PLAN_REQUIRED' });
    expect((await t.connections.connectLink(GUS, 'tiktok', { projectId: P1 })).connectLink).toBeDefined();
    // plans not enforced (null): the env value as before plans
    limit = null;
    expect(await t.connections.slots(GUS)).toMatchObject({ cap: 3 });
  });
});

describe('accounts, Pages and isolation', () => {
  it('a connected account shows with its label for its business only; the browser never sees a profile name or an account id', async () => {
    const t = setup();
    const { username, acct } = await connectVia(t, ALICE, 'instagram', { id: 'ig_1789_secret', display_name: 'Joe’s Bakery IG' });
    const list = await t.connections.status(ALICE, { projectId: P1 });
    expect(list.find((s) => s.platform === 'instagram')).toMatchObject({ state: 'connected', targetLabel: 'Joe’s Bakery IG', targetKind: 'ig_account' });
    // Alice's other business, and no business at all, show it as not connected
    expect((await statusOf(t, ALICE, 'instagram', P2)).state).toBe('not_connected');
    expect((await t.connections.status(ALICE)).find((s) => s.platform === 'instagram').state).toBe('not_connected');
    const text = JSON.stringify(list) + JSON.stringify(await t.connections.targets(ALICE, 'instagram', { projectId: P1 }));
    expect(text).not.toContain(username);
    expect(text).not.toContain(acct.username);
  });

  it('each business connects its own Instagram (one account per network per profile), and its own posts and stats use it', async () => {
    const t = setup();
    const a = await connectVia(t, ALICE, 'instagram', { id: 'ig_bakery', display_name: 'Bakery IG' }, P1);
    const b = await connectVia(t, ALICE, 'instagram', { id: 'ig_catering', display_name: 'Catering IG' }, P2);
    expect(a.username).not.toBe(b.username);
    expect((await statusOf(t, ALICE, 'instagram', P1)).targetLabel).toBe('Bakery IG');
    expect((await statusOf(t, ALICE, 'instagram', P2)).targetLabel).toBe('Catering IG');
    const photo = { id: 'img-two.jpg', kind: 'image', type: 'image/jpeg', size: 10 };
    await t.connections.publish(ALICE, 'instagram', { projectId: P2, jobId: JOB(), composed: { text: 'Catering' }, media: photo });
    expect(mock.uploadCalls().pop().form.user).toBe(b.username);
    await t.connections.publish(ALICE, 'instagram', { projectId: P1, jobId: JOB(), composed: { text: 'Bakery' }, media: photo });
    expect(mock.uploadCalls().pop().form.user).toBe(a.username);
  });

  it('lists Facebook Pages with the business’s own profile=; each business chooses its Page; a Page pinned on the connect page is seen, and choosing another clears it', async () => {
    const t = setup();
    await business(t, ALICE, P1);
    await business(t, ALICE, P2);
    const u1 = profileUsername(customerTag(ALICE, t.env), ALICE, P1, TAG_SECRET);
    const u2 = profileUsername(customerTag(ALICE, t.env), ALICE, P2, TAG_SECRET);
    mock.addProfile(u1);
    mock.addProfile(u2);
    mock.pages.facebook.set(u1, [{ id: '1001', name: 'Joe’s Bakery' }, { id: '1002', name: 'Joe’s Catering' }]);
    mock.pages.facebook.set(u2, [{ id: '2001', name: 'Joe’s Food Truck' }]);
    mock.pages.facebook.set('ylb_someoneelse0000000000000_00000000', [{ id: '9999', name: 'Not Alice’s' }]);
    await connectVia(t, ALICE, 'facebook', {}, P1);
    await connectVia(t, ALICE, 'facebook', {}, P2);
    const fb = async (projectId) => (await t.connections.status(ALICE, { projectId })).find((s) => s.platform === 'facebook');
    expect(await fb(P1)).toMatchObject({ state: 'connected', targetsAvailable: 2 });
    // a business with one Page uses it
    expect(await fb(P2)).toMatchObject({ state: 'connected', targetLabel: 'Joe’s Food Truck' });
    const targets = await t.connections.targets(ALICE, 'facebook', { projectId: P1 });
    expect(targets.map((x) => x.label)).toEqual(['Joe’s Bakery', 'Joe’s Catering']);
    expect(JSON.stringify(targets)).not.toMatch(/1001|1002|9999|2001/);
    // the other business's list is its own
    expect((await t.connections.targets(ALICE, 'facebook', { projectId: P2 })).map((x) => x.label)).toEqual(['Joe’s Food Truck']);
    expect(mock.calls.filter((c) => c.path === '/api/uploadposts/facebook/pages').every((c) => [u1, u2].includes(c.query.profile))).toBe(true);
    // a business that hasn't chosen among several Pages is asked to choose
    expect((await fb(P1)).targetLabel).toBeUndefined();
    expect(await t.connections.publish(ALICE, 'facebook', { projectId: P1, jobId: JOB(), composed: { text: 'x' } })).toMatchObject({ state: 'failed', errorCode: 'NO_TARGET' });
    await t.connections.setTarget(ALICE, 'facebook', targets[1].id, { projectId: P1 });
    expect((await fb(P1)).targetLabel).toBe('Joe’s Catering');
    // a handle from another business's list isn't this business's
    const other = (await t.connections.targets(ALICE, 'facebook', { projectId: P2 }))[0].id;
    await expect(t.connections.setTarget(ALICE, 'facebook', other, { projectId: P1 })).rejects.toMatchObject({ status: 400 });

    // the customer pins Bakery on the hosted page for this business: it's seen, and the upload names it
    mock.pins.facebook.set(u1, '1001');
    await t.connections.check(ALICE, 'facebook', { projectId: P1 });
    expect((await fb(P1)).targetLabel).toBe('Joe’s Bakery');
    await t.connections.publish(ALICE, 'facebook', { projectId: P1, jobId: JOB(), composed: { text: 'Pinned' } });
    expect(mock.uploadCalls().pop().form).toMatchObject({ user: u1, facebook_page_id: '1001' });

    // choosing Catering again clears the pin at Upload-Post (one DELETE, for this business's profile only)
    const before = mock.calls.length;
    await t.connections.setTarget(ALICE, 'facebook', targets[1].id, { projectId: P1 });
    expect(mock.calls.slice(before).filter((c) => c.method === 'DELETE')).toEqual([expect.objectContaining({ path: '/api/uploadposts/users/facebook-page', body: { profile_username: u1 } })]);
    expect(mock.pins.facebook.has(u1)).toBe(false);
    expect((await fb(P1)).targetLabel).toBe('Joe’s Catering');
    expect((await fb(P2)).targetLabel).toBe('Joe’s Food Truck');
    await t.connections.publish(ALICE, 'facebook', { projectId: P1, jobId: JOB(), composed: { text: 'Mine' } });
    expect(mock.uploadCalls().pop().form.facebook_page_id).toBe('1002');
    expect(mock.violations).toEqual([]);
  });

  it('LinkedIn: a company page pinned on the business’s connect page (by number or URN) is what that business posts as', async () => {
    const t = setup();
    const GUS = 'a2111111-2222-4333-8444-555555555555';
    await business(t, GUS);
    const u = profileUsername(customerTag(GUS, t.env), GUS, P1, TAG_SECRET);
    mock.addProfile(u);
    mock.pages.linkedin.set(u, [{ id: 'urn:li:organization:42', name: 'Joe’s Bakery Co' }]);
    await connectVia(t, GUS, 'linkedin', { display_name: 'Joe Baker' });
    expect(await statusOf(t, GUS, 'linkedin')).toMatchObject({ targetLabel: 'Joe Baker', targetKind: 'li_person' });
    mock.pins.linkedin.set(u, '42');
    await t.connections.check(GUS, 'linkedin', { projectId: P1 });
    expect(await statusOf(t, GUS, 'linkedin')).toMatchObject({ targetLabel: 'Joe’s Bakery Co', targetKind: 'li_org' });
    await t.connections.publish(GUS, 'linkedin', { projectId: P1, jobId: JOB(), composed: { text: 'As the company' } });
    expect(mock.uploadCalls().pop().form.target_linkedin_page_id).toBe('urn:li:organization:42');
    mock.pins.linkedin.delete(u);
  });

  it('one business’s expired Facebook sign-in (401 facebook_reauth_required on the pin read) is its reconnect: nobody else is blocked and the owner isn’t told the key is bad', async () => {
    const t = setup();
    const CAROL = 'a3111111-2222-4333-8444-555555555555';
    const DAVE = 'a4111111-2222-4333-8444-555555555555';
    await business(t, CAROL);
    const u = profileUsername(customerTag(CAROL, t.env), CAROL, P1, TAG_SECRET);
    mock.addProfile(u);
    mock.pages.facebook.set(u, [{ id: '5001', name: 'Carol’s Page' }]);
    await connectVia(t, CAROL, 'facebook');
    await connectVia(t, DAVE, 'x');
    mock.pinReauth.add(u);
    try {
      expect(await t.connections.check(CAROL, 'facebook', { projectId: P1 })).toMatchObject({ state: 'needs_reconnect' });
      // the very next call, for someone else, goes out and posts
      const before = mock.uploadCalls().length;
      expect(await t.connections.publish(DAVE, 'x', { projectId: P1, jobId: JOB(), composed: { text: 'Still posting' } })).toMatchObject({ state: 'sent' });
      expect(mock.uploadCalls().length).toBe(before + 1);
      expect(Object.keys(await alertsOf(t))).not.toContain('auth');
    } finally {
      mock.pinReauth.delete(u);
    }
  });

  it('check reads the business’s profile back: a reauth flag needs a reconnect; disconnect removes it from that business only, once (404 is fine)', async () => {
    const t = setup();
    const { username } = await connectVia(t, BOB, 'tiktok', {}, P1);
    const second = await connectVia(t, BOB, 'tiktok', {}, P2);
    mock.connect(username, 'tiktok', { reauth_required: true });
    expect(await t.connections.check(BOB, 'tiktok', { projectId: P1 })).toMatchObject({ state: 'needs_reconnect', lastError: 'reconnect' });
    expect(await t.connections.check(BOB, 'tiktok', { projectId: P2 })).toMatchObject({ state: 'connected' });
    const before = mock.calls.length;
    await t.connections.disconnect(BOB, 'tiktok', { projectId: P1 });
    const del = mock.calls.slice(before).filter((c) => c.method === 'DELETE');
    expect(del).toEqual([expect.objectContaining({ path: '/api/uploadposts/users/social', body: { profile_username: username, social_platform: 'tiktok' } })]);
    expect((await statusOf(t, BOB, 'tiktok', P1)).state).toBe('not_connected');
    // the other business keeps its own TikTok, here and at Upload-Post
    expect((await statusOf(t, BOB, 'tiktok', P2)).state).toBe('connected');
    expect(mock.profiles.get(second.username).social_accounts.tiktok).toBeTruthy();
    // without a business nothing is disconnected
    await expect(t.connections.disconnect(BOB, 'tiktok')).rejects.toMatchObject({ status: 400 });
  });

  it('isolation: another user naming Alice’s business id only ever reaches their own (nothing): status, connect, targets, choose, disconnect, post, stats, check again, delete', async () => {
    const t = setup();
    const { username } = await connectVia(t, ALICE, 'x', { id: 'x_alice' }, P1);
    const before = mock.calls.filter((c) => c.method !== 'GET').length;
    const aliceDoc = JSON.stringify(await docOf(t, ALICE));
    expect((await statusOf(t, BOB, 'x', P1)).state).toBe('not_connected');
    // Bob hasn't saved a business with that id: no profile is made for him either
    await expect(t.connections.connectLink(BOB, 'x', { projectId: P1 })).rejects.toMatchObject({ status: 404 });
    expect(await t.connections.targets(BOB, 'x', { projectId: P1 })).toEqual([]);
    const aliceTarget = (await t.connections.targets(ALICE, 'x', { projectId: P1 }))[0].id;
    await expect(t.connections.setTarget(BOB, 'x', aliceTarget, { projectId: P1 })).rejects.toMatchObject({ status: 400 });
    await t.connections.disconnect(BOB, 'x', { projectId: P1 });
    expect(await t.connections.publish(BOB, 'x', { projectId: P1, jobId: JOB(), composed: { text: 'Not mine' } })).toMatchObject({ state: 'failed', errorCode: 'NO_TARGET' });
    expect(await t.connections.insights(BOB, 'x', { projectId: P1 })).toBeNull();
    expect(await t.connections.postStatus(BOB, { requestId: JOB(), platform: 'x', projectId: P1 })).toBeNull();
    expect(await t.connections.forgetProject(BOB, P1)).toEqual({ freed: false });
    expect(mock.calls.filter((c) => c.method !== 'GET').length).toBe(before);
    expect(mock.profiles.get(username).social_accounts.x).toBeTruthy();
    expect(JSON.stringify(await docOf(t, ALICE))).toBe(aliceDoc);
  });

  it('keeps customers and businesses apart: an event for one business’s profile never changes another’s', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'x', {}, P1);
    await business(t, ALICE, P2);
    await t.connections.connectLink(ALICE, 'tiktok', { projectId: P2 });
    const before = JSON.stringify((await docOf(t, ALICE)).profiles.find((p) => p.projectId === P1));
    const second = await nameOf(t, ALICE, P2);
    mock.connect(second, 'x');
    const evt = mock.signed({ event: 'social_account_connected', profile_username: second, platform: 'x' });
    await t.impl.webhook(evt.raw, evt.headers);
    await t.impl.settled();
    expect(JSON.stringify((await docOf(t, ALICE)).profiles.find((p) => p.projectId === P1))).toBe(before);
    expect((await statusOf(t, ALICE, 'x', P2)).state).toBe('connected');
    // Bob's events never touch Alice
    await business(t, BOB);
    await t.connections.connectLink(BOB, 'x', { projectId: P1 });
    const bobs = await nameOf(t, BOB);
    mock.connect(bobs, 'x');
    const alice = JSON.stringify(await docOf(t, ALICE));
    const bobEvt = mock.signed({ event: 'social_account_connected', profile_username: bobs, platform: 'x' });
    await t.impl.webhook(bobEvt.raw, bobEvt.headers);
    await t.impl.settled();
    expect(JSON.stringify(await docOf(t, ALICE))).toBe(alice);
    // a profile that isn't one of our customers' businesses is ignored
    const stranger = mock.signed({ event: 'social_account_connected', profile_username: 'ylb_000000000000000000000000_00000000', platform: 'x' });
    expect((await t.impl.webhook(stranger.raw, stranger.headers)).status).toBe(200);
  });
});

describe('the webhook', () => {
  it('refuses a bad, stale or missing signature without reading anything', async () => {
    const t = setup();
    const evt = mock.signed({ event: 'upload_completed', profile_username: 'ylb_000000000000000000000000_00000000' });
    const reads = t.db.calls?.length ?? 0;
    expect((await t.impl.webhook(evt.raw, { ...evt.headers, 'x-upload-post-signature': `sha256=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await t.impl.webhook(evt.raw, signUploadPost(evt.raw, { ts: Math.floor(t.clock.t / 1000) - 400 }))).status).toBe(401);
    expect((await t.impl.webhook(evt.raw, {})).status).toBe(401);
    expect(t.db.calls?.length ?? 0).toBe(reads);
  });

  it('applies an upload_completed once (a replay with a new delivery id is a duplicate) and routes it to the job with its customer and business', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram', {}, P1);
    const { username } = await connectVia(t, ALICE, 'instagram', {}, P2);
    const seen = [];
    t.impl.setPostListener((userId, jobId, outcome, where) => seen.push({ userId, jobId, outcome, where }));
    const jobId = JOB();
    const evt = mock.signed({ event: 'upload_completed', request_id: jobId, profile_username: username, platform: 'instagram', result: { success: true, url: 'https://instagram.com/p/abc', post_id: '1798' } });
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    const again = await t.impl.webhook(evt.raw, signUploadPost(evt.raw, { event: 'upload_completed' }));
    expect(again.body).toMatchObject({ duplicate: true });
    await t.impl.settled();
    expect(seen).toEqual([{ userId: ALICE, jobId, outcome: { state: 'sent', platform: 'instagram', url: 'https://instagram.com/p/abc' }, where: { projectId: P2 } }]);
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
    expect((await docOf(t, KIM)).profiles[0].accounts.x).toBeUndefined();
    release();
    await slow.settled();
    expect((await docOf(t, KIM)).profiles[0].accounts.x).toBeDefined();
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
    await t.connections.publish(ALICE, 'tiktok', { projectId: P1, jobId, composed: { text: 'Bread' }, media: { id: 'vid-tt9', kind: 'video', type: 'video/mp4', size: 6000 } });
    // the documented upload_completed result has no fallback_to_inbox
    const evt = mock.signed({ event: 'upload_completed', request_id: jobId, profile_username: username, platform: 'tiktok', result: { success: true, url: null, publish_id: 'p1', error: null } });
    await t.impl.webhook(evt.raw, evt.headers);
    await t.impl.settled();
    expect(seen).toEqual([{ state: 'sent', platform: 'tiktok', drafts: true }]);
  });
});

describe('posting (one attempt, through the post’s business)', () => {
  it('posts a text once with our job id as request_id, Idempotency-Key and external_id; the platform’s own result decides; the ledger row names the business', async () => {
    const t = setup();
    const { username } = await connectVia(t, ALICE, 'linkedin');
    const jobId = JOB();
    const out = await t.connections.publish(ALICE, 'linkedin', { projectId: P1, jobId, composed: { text: 'Fresh sourdough today', comment: 'Order: https://joes.example' } });
    expect(out).toMatchObject({ state: 'sent', url: expect.stringMatching(/^https:\/\/social\.example\/linkedin\/p\//), ref: { via: 'upload_post', requestId: jobId, platform: 'linkedin' } });
    const call = mock.uploadCalls().pop();
    expect(call).toMatchObject({ path: '/api/upload_text', idempotencyKey: jobId });
    expect(call.form).toMatchObject({ user: username, 'platform[]': ['linkedin'], request_id: jobId, external_id: jobId, title: 'Fresh sourdough today', first_comment: 'Order: https://joes.example' });
    expect(t.db.rows('usage_ledger').find((r) => r.call_id === jobId)).toMatchObject({ vendor: 'uploadpost', feature: 'posting', endpoint: 'linkedin:POST /upload_text', outcome: 'ok', project_id: P1, customer_tag: customerTag(ALICE, t.env) });
  });

  it('sends a photo as our short-lived public link (Upload-Post fetches it), never the bytes', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const out = await t.connections.publish(ALICE, 'instagram', { projectId: P1, jobId: JOB(), composed: { text: 'Look' }, media: { id: 'img-1.jpg', kind: 'image', type: 'image/jpeg', size: 2000 } });
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
    const out = await t.connections.publish(ALICE, 'youtube', { projectId: P1, jobId, composed: { text: 'desc', title: 'Our sourdough', description: 'desc', tags: ['bread'] }, media: { id: 'vid-1', kind: 'video', type: 'video/mp4', size: 6000 } });
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
    const out = await t.connections.publish(ALICE, 'x', { projectId: P1, jobId, composed: { text: 'Pending forever' } });
    expect(out).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
    expect(mock.uploadCalls().filter((c) => c.idempotencyKey === jobId)).toHaveLength(1);
  });

  it('top-level success with this platform failed is a failure; skipped is “not connected”; reauth needs a reconnect (that business only)', async () => {
    const t = setup();
    await business(t, BOB);
    const u = profileUsername(customerTag(BOB, t.env), BOB, P1, TAG_SECRET);
    mock.addProfile(u);
    mock.pages.facebook.set(u, [{ id: '2001', name: 'Bob’s Page' }]);
    await connectVia(t, BOB, 'facebook');
    await connectVia(t, BOB, 'facebook', {}, P2);
    mock.setUploadOutcome('platform_failed');
    expect(await t.connections.publish(BOB, 'facebook', { projectId: P1, jobId: JOB(), composed: { text: 'a' } })).toMatchObject({ state: 'failed', errorCode: 'REFUSED' });
    expect(mock.uploadCalls().pop().form.facebook_page_id).toBe('2001');
    mock.setUploadOutcome('skipped');
    expect(await t.connections.publish(BOB, 'facebook', { projectId: P1, jobId: JOB(), composed: { text: 'b' } })).toMatchObject({ state: 'failed', errorCode: 'NOT_CONNECTED' });
    mock.setUploadOutcome('reauth');
    expect(await t.connections.publish(BOB, 'facebook', { projectId: P1, jobId: JOB(), composed: { text: 'c' } })).toMatchObject({ state: 'failed', errorCode: 'NEEDS_RECONNECT' });
    expect((await statusOf(t, BOB, 'facebook', P1)).state).toBe('needs_reconnect');
    expect((await statusOf(t, BOB, 'facebook', P2)).state).toBe('connected');
  });

  it('TikTok: a video keeps the account’s own audience (no setting sent, nothing read first); drafts (inbox fallback) end sent with no address', async () => {
    const t = setup();
    const { username } = await connectVia(t, ALICE, 'tiktok');
    const video = { id: 'vid-tt', kind: 'video', type: 'video/mp4', size: 6000 };
    mock.setUploadOutcome('inbox');
    const reads = mock.calls.filter((c) => c.path === '/api/uploadposts/tiktok/settings').length;
    const out = await t.connections.publish(ALICE, 'tiktok', { projectId: P1, jobId: JOB(), composed: { text: 'Bread' }, media: video });
    expect(out).toMatchObject({ state: 'sent', ref: { outcome: 'drafts' } });
    expect(out.url).toBeUndefined();
    expect(mock.uploadCalls().pop().form.privacy_level).toBeUndefined();
    // a private account (no public option) posts its videos the same way, and an older connection the settings
    // read refuses is never marked for a reconnect over it
    mock.tiktokPrivacy.set(username, ['FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
    mock.tiktokSettings.set(username, { status: 400, body: { success: false, error_code: 'tiktok_reconnect_required' } });
    try {
      expect(await t.connections.publish(ALICE, 'tiktok', { projectId: P1, jobId: JOB(), composed: { text: 'Bread' }, media: video })).toMatchObject({ state: 'sent' });
      expect(mock.calls.filter((c) => c.path === '/api/uploadposts/tiktok/settings').length).toBe(reads);
      expect((await statusOf(t, ALICE, 'tiktok')).state).toBe('connected');
    } finally {
      mock.tiktokPrivacy.delete(username);
      mock.tiktokSettings.delete(username);
    }
  });

  it('TikTok photos need an audience, read from the business’s own TikTok: public when it has it, its followers on a private account, refused when neither', async () => {
    const t = setup();
    const { username } = await connectVia(t, BOB, 'tiktok', {}, P1);
    const second = await connectVia(t, BOB, 'tiktok', {}, P2);
    const photo = { id: 'img-tt.jpg', kind: 'image', type: 'image/jpeg', size: 10 };
    expect(await t.connections.publish(BOB, 'tiktok', { projectId: P1, jobId: JOB(), composed: { text: 'Buns' }, media: photo })).toMatchObject({ state: 'sent' });
    expect(mock.uploadCalls().pop().form.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    expect(mock.calls.filter((c) => c.path === '/api/uploadposts/tiktok/settings').pop().query.profile).toBe(username);
    // the second business's TikTok is private: its own settings decide for its posts
    mock.tiktokPrivacy.set(second.username, ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY']);
    try {
      expect(await t.connections.publish(BOB, 'tiktok', { projectId: P2, jobId: JOB(), composed: { text: 'Buns' }, media: photo })).toMatchObject({ state: 'sent' });
      expect(mock.uploadCalls().pop().form).toMatchObject({ user: second.username, privacy_level: 'FOLLOWER_OF_CREATOR' });
      expect(await t.connections.publish(BOB, 'tiktok', { projectId: P1, jobId: JOB(), composed: { text: 'Buns' }, media: photo })).toMatchObject({ state: 'sent' });
      expect(mock.uploadCalls().pop().form.privacy_level).toBe('PUBLIC_TO_EVERYONE');
      // asked for one the account doesn't have: Upload-Post refuses it before TikTok (nothing posted)
      expect(await t.connections.publish(BOB, 'tiktok', { projectId: P2, jobId: JOB(), composed: { text: 'Buns' }, media: photo, privacy: 'PUBLIC_TO_EVERYONE' })).toMatchObject({ state: 'failed', errorCode: 'TIKTOK_PRIVACY' });
      // the audience the customer asked for is sent as asked (never swapped for another), to that business's profile
      expect(mock.uploadCalls().pop().form).toMatchObject({ user: second.username, privacy_level: 'PUBLIC_TO_EVERYONE' });
      mock.tiktokPrivacy.set(second.username, ['SELF_ONLY']);
      const before = mock.uploadCalls().length;
      expect(await t.connections.publish(BOB, 'tiktok', { projectId: P2, jobId: JOB(), composed: { text: 'Buns' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'TIKTOK_PRIVACY' });
      expect(mock.uploadCalls().length).toBe(before);
      // TikTok no longer takes the connection (409 reauth_required): a reconnect, for that business only
      mock.tiktokSettings.set(second.username, { status: 409, body: { success: false, reauth_required: true } });
      expect(await t.connections.publish(BOB, 'tiktok', { projectId: P2, jobId: JOB(), composed: { text: 'Buns' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'NEEDS_RECONNECT' });
      expect((await statusOf(t, BOB, 'tiktok', P2)).state).toBe('needs_reconnect');
      expect((await statusOf(t, BOB, 'tiktok', P1)).state).toBe('connected');
    } finally {
      mock.tiktokPrivacy.delete(second.username);
      mock.tiktokSettings.delete(second.username);
    }
  });

  it('caps and team limits: a daily cap is PLATFORM_LIMIT; the scheduled-post cap and our key are the owner’s (safe code, alert)', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'instagram');
    const photo = { id: 'img-2.jpg', kind: 'image', type: 'image/jpeg', size: 10 };
    mock.setUploadOutcome('hard_cap');
    expect(await t.connections.publish(ALICE, 'instagram', { projectId: P1, jobId: JOB(), composed: { text: 'a' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'PLATFORM_LIMIT' });
    mock.setUploadOutcome('scheduled_limit');
    expect(await t.connections.publish(ALICE, 'instagram', { projectId: P1, jobId: JOB(), composed: { text: 'b' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' });
    expect(Object.keys(await alertsOf(t))).toContain('scheduled_limit');
    mock.setUploadOutcome('unauthorized');
    expect(await t.connections.publish(ALICE, 'instagram', { projectId: P1, jobId: JOB(), composed: { text: 'c' }, media: photo })).toMatchObject({ state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' });
    expect(Object.keys(await alertsOf(t))).toContain('auth');
    // the owner sees the most serious one
    expect((await t.impl.ownerView()).alert).toMatchObject({ kind: 'auth' });
    expect(t.log.text()).not.toMatch(/upgrade at|40000 pending/);
  });

  it('a 5xx after Upload-Post took it is unknown (nothing resent); “Check again” reads the status by the job id through the business’s profile and finds it', async () => {
    const t = setup();
    const { username } = await connectVia(t, BOB, 'x');
    const jobId = JOB();
    mock.setUploadOutcome('accepted_then_500');
    expect(await t.connections.publish(BOB, 'x', { projectId: P1, jobId, composed: { text: 'Created then 502' } })).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
    const reads = mock.calls.length;
    const found = await t.connections.postStatus(BOB, { via: 'upload_post', requestId: jobId, platform: 'x', jobId, projectId: P1 });
    expect(found).toMatchObject({ found: true, url: expect.stringMatching(/^https:\/\/social\.example\/x\//) });
    expect(mock.calls.slice(reads).every((c) => c.method === 'GET')).toBe(true);
    expect(mock.calls.slice(reads).filter((c) => c.path === '/api/uploadposts/history').every((c) => c.query.profile_username === username)).toBe(true);
    expect(mock.uploadCalls().filter((c) => c.idempotencyKey === jobId)).toHaveLength(1);
    // nothing created at all: still pending (never "send again")
    expect(await t.connections.postStatus(BOB, { requestId: JOB(), platform: 'x', projectId: P1 })).toMatchObject({ pending: true });
    // without the job's business there's no profile to read through
    expect(await t.connections.postStatus(BOB, { requestId: jobId, platform: 'x' })).toBeNull();
  });

  it('a status entry still “Queued” keeps the job waiting (never “Posted”); a retryable one too, and it ends “may have been posted”, never “failed”', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'x');
    const queued = JOB();
    mock.setUploadOutcome('async');
    // the first read answers the documented in-progress shape ({success: true, message: "Queued"}); the next one is done
    expect(await t.connections.publish(ALICE, 'x', { projectId: P1, jobId: queued, composed: { text: 'Queued first' } })).toMatchObject({ state: 'sent', url: expect.stringMatching(/^https:\/\/social\.example\/x\//) });
    expect(mock.calls.filter((c) => c.path === '/api/uploadposts/status' && c.query.request_id === queued).length).toBe(2);
    // Upload-Post will retry it by itself: never "failed" (a "Try again" would post it twice)
    const retry = JOB();
    mock.setStatus(retry, { request_id: retry, status: 'in_progress', results: [{ platform: 'x', success: false, status: 'retryable', error_code: 'content_rejected' }] });
    mock.setUploadOutcome('async_pending');
    try {
      expect(await t.connections.publish(ALICE, 'x', { projectId: P1, jobId: retry, composed: { text: 'Will be retried' } })).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
      expect(await t.connections.postStatus(ALICE, { requestId: retry, platform: 'x', projectId: P1 })).toMatchObject({ pending: true });
    } finally {
      mock.setStatus(retry, null);
    }
  });

  it('a TikTok that failed with no code (TikTok’s internal error) may still go out after moderation: “may have been posted”, not “Try again”', async () => {
    const t = setup();
    await connectVia(t, BOB, 'tiktok');
    mock.setUploadOutcome('tiktok_internal');
    expect(await t.connections.publish(BOB, 'tiktok', { projectId: P1, jobId: JOB(), composed: { text: 'Loaves' }, media: { id: 'vid-tt3', kind: 'video', type: 'video/mp4', size: 6000 } })).toMatchObject({ state: 'unknown', errorCode: 'UNCONFIRMED' });
  });

  it('an identical upload a moment ago answers with that request’s id: its status is read (and kept) by that id', async () => {
    const t = setup();
    await connectVia(t, BOB, 'x');
    const jobId = JOB();
    mock.setUploadOutcome('existing_request');
    const out = await t.connections.publish(BOB, 'x', { projectId: P1, jobId, composed: { text: 'Same as before' } });
    expect(out).toMatchObject({ state: 'sent', ref: { requestId: expect.stringMatching(/^up_/) } });
    expect(out.ref.requestId).not.toBe(jobId);
    expect(mock.calls.filter((c) => c.path === '/api/uploadposts/status').pop().query.request_id).toBe(out.ref.requestId);
    expect(await t.connections.postStatus(BOB, { ...out.ref, projectId: P1 })).toMatchObject({ found: true });
  });

  it('an account gone at Upload-Post (400 invalid_platforms, an object) is “not connected”, and the doc learns it', async () => {
    const t = setup();
    const HUGO = 'c2111111-2222-4333-8444-555555555555';
    const { username } = await connectVia(t, HUGO, 'youtube');
    delete mock.profiles.get(username).social_accounts.youtube;
    expect(await t.connections.publish(HUGO, 'youtube', { projectId: P1, jobId: JOB(), composed: { text: 'd', title: 'T', description: 'd', tags: [] }, media: { id: 'vid-y', kind: 'video', type: 'video/mp4', size: 6000 } })).toMatchObject({ state: 'failed', errorCode: 'NOT_CONNECTED' });
    expect((await statusOf(t, HUGO, 'youtube')).state).toBe('not_connected');
  });

  it('X links (with the X Links add-on): each customer has a share of the 50 a month everyone shares (all their businesses together); bare addresses like mybiz.com count; past it nothing is sent', async () => {
    const t = setup({ env: { UPLOAD_POST_X_LINKS: 'on', UPLOAD_POST_X_LINK_POSTS_PER_CUSTOMER: '3' } });
    expect(t.impl.xLinks).toBe(true);
    const JO = 'c3111111-2222-4333-8444-555555555555';
    await connectVia(t, JO, 'x', {}, P1);
    await connectVia(t, JO, 'x', {}, P2);
    expect((await t.connections.publish(JO, 'x', { projectId: P1, jobId: JOB(), composed: { text: 'Order now https://joes.example/order' } })).state).toBe('sent');
    // a bare address is a link on X too
    mock.setUploadOutcome('x_links_stripped');
    expect((await t.connections.publish(JO, 'x', { projectId: P2, jobId: JOB(), composed: { text: 'Order at joesbakery.com today' } })).state).toBe('sent');
    expect(Object.keys(await alertsOf(t))).toContain('x_links');
    expect((await t.connections.publish(JO, 'x', { projectId: P1, jobId: JOB(), composed: { text: 'Menu: joes-bakery.co.uk/menu' } })).state).toBe('sent');
    const before = mock.uploadCalls().length;
    expect(await t.connections.publish(JO, 'x', { projectId: P2, jobId: JOB(), composed: { text: 'See mybiz.com' } })).toMatchObject({ state: 'failed', errorCode: 'X_LINKS_USED' });
    expect(mock.uploadCalls().length).toBe(before);
    // a post without a link is never counted (an email address or a price isn't one)
    expect((await t.connections.publish(JO, 'x', { projectId: P1, jobId: JOB(), composed: { text: 'No link today: email joe@joes.example, $3.50 a loaf' } })).state).toBe('sent');
    const rows = t.db.rows('usage_ledger').filter((r) => r.endpoint === 'x:link_post');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.project_id).sort()).toEqual([P1, P1, P2]);
  });

  it('refuses (nothing sent) when the business has no account there, or no business is named', async () => {
    const t = setup();
    await connectVia(t, ALICE, 'facebook', {}, P2);
    const before = mock.uploadCalls().length;
    expect(await t.connections.publish('31111111-2222-4333-8444-555555555555', 'facebook', { projectId: P1, jobId: JOB(), composed: { text: 'x' } })).toMatchObject({ state: 'failed', errorCode: 'NO_TARGET' });
    expect(await t.connections.publish(ALICE, 'facebook', { projectId: P1, jobId: JOB(), composed: { text: 'x' } })).toMatchObject({ state: 'failed', errorCode: 'NO_TARGET' });
    expect(await t.connections.publish(ALICE, 'facebook', { jobId: JOB(), composed: { text: 'x' } })).toMatchObject({ state: 'failed', errorCode: 'NO_TARGET' });
    expect(mock.uploadCalls().length).toBe(before);
  });
});

describe('X links', () => {
  it('counts http(s) links, www. and bare domains, never an email, a hashtag, a price, an abbreviation or a missing space', () => {
    for (const s of ['https://joes.example', 'Order at mybiz.com', 'Visit MyBiz.COM/order', 'www.joesbakery', 'joes-bakery.co.uk', '(mybiz.com)', 'mybiz.de/menu', 'mybiz.co', 'Bakery.Shop']) expect([s, hasXLink(s)]).toEqual([s, true]);
    // a one-word country-code domain needs a path or a second-level label (as X links them): two letters after a
    // missing space are a word, not a country
    for (const s of ['No link today', 'joe@mybiz.com', '#mybiz.com', '$3.50 a loaf', 'e.g. this', 'Open 9a.m.-5p.m.', 'file.txt', 'St.Louis', 'Hello world.It’s fresh', 'Great deals.Go now', 'see you at 5.Be there', 'Thanks.So happy', 'Hi.My name is Joe', 'mybiz.de']) expect([s, hasXLink(s)]).toEqual([s, false]);
  });
});

describe('a connect whose webhook never came (Upload-Post sends each one once)', () => {
  it('the waiting row reads the business’s profile back (at most every 30 s), and Connect again finds the account instead of a new link', async () => {
    const t = setup();
    const LEE = 'c4111111-2222-4333-8444-555555555555';
    await business(t, LEE);
    await t.connections.connectLink(LEE, 'instagram', { projectId: P1 });
    const username = await nameOf(t, LEE);
    // the customer connected on the hosted page; the social_account_connected webhook was lost
    mock.connect(username, 'instagram');
    t.clock.t += 31_000;
    expect((await statusOf(t, LEE, 'instagram')).state).toBe('connected');
    // reads are throttled while waiting
    await t.connections.connectLink(LEE, 'tiktok', { projectId: P1 });
    mock.connect(username, 'tiktok');
    const reads = mock.calls.filter((c) => c.path === `/api/uploadposts/users/${username}`).length;
    await t.connections.status(LEE, { projectId: P1 });
    expect(mock.calls.filter((c) => c.path === `/api/uploadposts/users/${username}`).length).toBe(reads);
    // Connect again: the profile is read first, so no second link
    expect(await t.connections.connectLink(LEE, 'tiktok', { projectId: P1 })).toEqual({ alreadyConnected: true });
  });

  it('Check on a waiting row reads the profile back right away', async () => {
    const t = setup();
    const MAY = 'c5111111-2222-4333-8444-555555555555';
    await business(t, MAY);
    await t.connections.connectLink(MAY, 'linkedin', { projectId: P1 });
    mock.connect(await nameOf(t, MAY), 'linkedin');
    expect(await t.connections.check(MAY, 'linkedin', { projectId: P1 })).toMatchObject({ state: 'connected' });
  });
});

describe('social stats per business (reads)', () => {
  it('reads each business’s numbers from its own profile (Facebook with its Page) and its daily series; a missing key is unknown; ledger rows name the business and add up per customer', async () => {
    const t = setup();
    const a = await connectVia(t, ALICE, 'instagram', {}, P1);
    const b = await connectVia(t, ALICE, 'instagram', {}, P2);
    const got = await t.connections.insights(ALICE, 'instagram', { projectId: P1 });
    expect(got).toMatchObject({ followers: 1310, reach: 1000, views: 700, engagement: 64, series: [{ date: '2026-11-01', reach: 700 }, { date: '2026-11-02', reach: 300 }] });
    expect(got.postsCount).toBeUndefined();
    expect(got.topPosts).toBeUndefined();
    expect(mock.calls.filter((c) => c.path.startsWith('/api/analytics/')).pop().path).toBe(`/api/analytics/${a.username}`);
    await t.connections.insights(ALICE, 'instagram', { projectId: P2 });
    expect(mock.calls.filter((c) => c.path.startsWith('/api/analytics/')).pop().path).toBe(`/api/analytics/${b.username}`);
    expect(mock.calls.some((c) => c.path === '/api/uploadposts/post-analytics/cached')).toBe(false);
    const rows = t.db.rows('usage_ledger').filter((r) => r.feature === 'social');
    expect(rows.every((r) => r.vendor === 'uploadpost' && r.customer_tag === customerTag(ALICE, t.env))).toBe(true);
    expect(rows.map((r) => r.project_id).sort()).toEqual([P1, P2]);
    // no business, or another business without the network: nothing read
    expect(await t.connections.insights(ALICE, 'instagram', {})).toBeNull();
    expect(await t.connections.insights(ALICE, 'instagram', { projectId: P3 })).toBeNull();
    mock.pages.facebook.set(a.username, [{ id: '3001', name: 'Alice’s Page' }]);
    await connectVia(t, ALICE, 'facebook', {}, P1);
    expect((await t.connections.insights(ALICE, 'facebook', { projectId: P1 })).followers).toBe(1310);
    expect(mock.calls.filter((c) => c.path === `/api/analytics/${a.username}` && c.query.platforms === 'facebook').pop().query).toMatchObject({ page_id: '3001', days: '30' });
  });

  it('a series is what the network counts: TikTok’s is views, X’s impressions (never charted as reach)', async () => {
    const t = setup();
    await connectVia(t, BOB, 'tiktok');
    await connectVia(t, BOB, 'x');
    expect((await t.connections.insights(BOB, 'tiktok', { projectId: P1 })).series[0]).toEqual({ date: '2026-11-01', views: 700 });
    expect((await t.connections.insights(BOB, 'x', { projectId: P1 })).series[0]).toEqual({ date: '2026-11-01', impressions: 700 });
  });

  it('LinkedIn: a personal profile has no stats at Upload-Post (it would answer for some company page), so it reads public data; a company page is asked for by its URN', async () => {
    const t = setup();
    const CAROL = 'b1111111-2222-4333-8444-555555555555';
    await business(t, CAROL);
    const u = profileUsername(customerTag(CAROL, t.env), CAROL, P1, TAG_SECRET);
    mock.addProfile(u);
    mock.pages.linkedin.set(u, [{ id: 'urn:li:organization:77', name: 'Carol Co' }]);
    await connectVia(t, CAROL, 'linkedin');
    const reads = mock.calls.length;
    expect(await t.connections.insights(CAROL, 'linkedin', { projectId: P1 })).toBeNull();
    expect(mock.calls.slice(reads).some((c) => c.path.startsWith('/api/analytics/'))).toBe(false);
    const org = (await t.connections.targets(CAROL, 'linkedin', { projectId: P1 })).find((x) => x.kind === 'li_org');
    await t.connections.setTarget(CAROL, 'linkedin', org.id, { projectId: P1 });
    expect((await t.connections.insights(CAROL, 'linkedin', { projectId: P1 })).followers).toBe(1310);
    expect(mock.calls.filter((c) => c.path === `/api/analytics/${u}`).pop().query).toMatchObject({ platforms: 'linkedin', page_urn: 'urn:li:organization:77' });
  });

  it('answers null when nothing is connected, and { kind: reconnect } when the account needs one', async () => {
    const t = setup();
    expect(await t.connections.insights('41111111-2222-4333-8444-555555555555', 'x', { projectId: P1 })).toBeNull();
    const { username } = await connectVia(t, BOB, 'youtube');
    mock.connect(username, 'youtube', { reauth_required: true });
    await t.connections.check(BOB, 'youtube', { projectId: P1 });
    await expect(t.connections.insights(BOB, 'youtube', { projectId: P1 })).rejects.toMatchObject({ kind: 'reconnect' });
  });
});

describe('deleting a business', () => {
  it('deletes that business’s profile (with every account in it) once and frees its slot at once; the user’s other businesses keep theirs', async () => {
    const t = setup();
    const ROB = 'b7111111-2222-4333-8444-555555555555';
    const one = await connectVia(t, ROB, 'instagram', {}, P1);
    const two = await connectVia(t, ROB, 'instagram', {}, P2);
    expect(await t.connections.slots(ROB)).toMatchObject({ used: 2 });
    const before = mock.calls.length;
    expect(await t.connections.forgetProject(ROB, P1)).toEqual({ freed: true });
    expect(mock.calls.slice(before).filter((c) => c.method !== 'GET')).toEqual([expect.objectContaining({ method: 'DELETE', path: '/api/uploadposts/users', body: { username: one.username } })]);
    expect(mock.profiles.has(one.username)).toBe(false);
    expect(mock.profiles.has(two.username)).toBe(true);
    expect(await t.connections.slots(ROB)).toEqual({ used: 1, cap: 3, projects: [P2], orphans: [] });
    expect((await statusOf(t, ROB, 'instagram', P1)).state).toBe('not_connected');
    expect((await statusOf(t, ROB, 'instagram', P2)).state).toBe('connected');
    // nothing left to delete the second time; a malformed id is refused
    expect(await t.connections.forgetProject(ROB, P1)).toEqual({ freed: false });
    await expect(t.connections.forgetProject(ROB, '__proto__')).rejects.toMatchObject({ status: 400 });
  });

  it('a delete that fails hides the profile (nothing shows or posts) but it still holds the user’s slot until it’s gone, so failing deletes can’t pile up plan slots; Free it or the daily check finishes it', async () => {
    const t = setup({ env: { UPLOAD_POST_MAX_PROFILES_PER_USER: '1' } });
    const SAM = 'b8111111-2222-4333-8444-555555555555';
    const { username } = await connectVia(t, SAM, 'x', {}, P1);
    mock.failDeletes.add(username);
    try {
      expect(await t.connections.forgetProject(SAM, P1)).toEqual({ freed: false, later: true });
      expect(mock.profiles.has(username)).toBe(true);
      expect((await statusOf(t, SAM, 'x', P1)).state).toBe('not_connected');
      expect(await t.connections.publish(SAM, 'x', { projectId: P1, jobId: JOB(), composed: { text: 'gone' } })).toMatchObject({ state: 'failed' });
      // still one of the plan's: it counts toward the user's limit, and the app offers to free it
      expect(await t.connections.slots(SAM)).toEqual({ used: 1, cap: 1, projects: [P1], orphans: [P1] });
      await business(t, SAM, P2);
      await expect(t.connections.connectLink(SAM, 'x', { projectId: P2 })).rejects.toMatchObject({ code: 'BUSINESS_LIMIT' });
      expect([...mock.profiles.keys()].filter((u) => u.startsWith(username.slice(0, 29)))).toHaveLength(1);
    } finally {
      mock.failDeletes.delete(username);
    }
    // Free it (or a second delete of the business) finishes it now
    expect(await t.connections.forgetProject(SAM, P1, { onlyIfGone: true })).toEqual({ freed: true });
    expect(mock.profiles.has(username)).toBe(false);
    expect((await t.connections.connectLink(SAM, 'x', { projectId: P2 })).connectLink).toBeDefined();
    expect((await docOf(t, SAM)).profiles.map((p) => p.projectId)).toEqual([P2]);
  });

  it('the daily check finishes a delete that failed', async () => {
    const t = setup();
    const SID = 'b8211111-2222-4333-8444-555555555555';
    const { username } = await connectVia(t, SID, 'x', {}, P1);
    mock.failDeletes.add(username);
    try {
      expect(await t.connections.forgetProject(SID, P1)).toMatchObject({ freed: false, later: true });
    } finally {
      mock.failDeletes.delete(username);
    }
    expect((await t.impl.reconcileIfDue()).deleted).toBeGreaterThanOrEqual(1);
    expect(mock.profiles.has(username)).toBe(false);
    expect(await t.connections.slots(SID)).toMatchObject({ used: 0 });
  });

  it('"Free it" only frees a business that’s gone from the account: one made on another device and not pulled here yet is refused (409), and nothing is deleted', async () => {
    const t = setup();
    const UMA = 'b8311111-2222-4333-8444-555555555555';
    const one = await connectVia(t, UMA, 'instagram', {}, P1);
    const two = await connectVia(t, UMA, 'instagram', {}, P2);
    // P1 is still saved in the account: never an orphan, and Free it is refused
    expect((await t.connections.slots(UMA)).orphans).toEqual([]);
    const err = await t.connections.forgetProject(UMA, P1, { onlyIfGone: true }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'BUSINESS_EXISTS' });
    expect(mock.profiles.has(one.username)).toBe(true);
    expect((await statusOf(t, UMA, 'instagram', P1)).state).toBe('connected');
    // deleted from the account (the cloud save removed its row): now it's the server's orphan, and Free it works
    await t.db.remove('user_docs', { user_id: UMA, kind: 'project', id: P1 });
    expect((await t.connections.slots(UMA)).orphans).toEqual([P1]);
    expect(await t.connections.forgetProject(UMA, P1, { onlyIfGone: true })).toEqual({ freed: true });
    expect(mock.profiles.has(one.username)).toBe(false);
    expect(mock.profiles.has(two.username)).toBe(true);
    // the app's own delete of a business (no onlyIfGone) needs no check: the business is going
    expect(await t.connections.forgetProject(UMA, P2)).toEqual({ freed: true });
  });

  it('a business deleted while its first Connect is making its profile: the profile goes; a cleanup delete that fails is kept for the daily check (no plan slot lost)', async () => {
    const t = setup();
    const VIC = 'b8411111-2222-4333-8444-555555555555';
    await business(t, VIC, P1);
    const key = `uploadpost:user:${sha256(VIC)}`;
    let username;
    // right before the create goes out (it takes today's slot first), the business is deleted: its entry was
    // dropped (forgetProject found nothing at Upload-Post yet), and the cleanup delete after the create will fail
    const put = t.storage.put.bind(t.storage);
    t.storage.put = async (k, v, o) => {
      if (String(k).startsWith('uploadpost:new-profiles:') && !username) {
        const doc = (await t.storage.get(key)).value;
        username = doc.profiles[0].username;
        mock.failDeletes.add(username);
        await put(key, { ...doc, profiles: [] });
      }
      return put(k, v, o);
    };
    try {
      await expect(t.connections.connectLink(VIC, 'x', { projectId: P1 })).rejects.toMatchObject({ status: 404 });
    } finally {
      t.storage.put = put;
      mock.failDeletes.delete(username);
    }
    expect(mock.profiles.has(username)).toBe(true);
    expect((await docOf(t, VIC)).profiles).toEqual([expect.objectContaining({ projectId: P1, username, state: 'deleting' })]);
    expect((await t.impl.reconcileIfDue()).deleted).toBe(1);
    expect(mock.profiles.has(username)).toBe(false);
    expect((await docOf(t, VIC)).profiles).toEqual([]);
  });

  it('the daily check gives back the profile of a business gone from the account for 2 days (deleted where the app couldn’t reach us), never on the first sight or for an empty account', async () => {
    const t = setup();
    const TOM = 'b9111111-2222-4333-8444-555555555555';
    const one = await connectVia(t, TOM, 'x', {}, P1);
    const two = await connectVia(t, TOM, 'x', {}, P2);
    // P1 is deleted on a device that never told us (its row went with the cloud save)
    await t.db.remove('user_docs', { user_id: TOM, kind: 'project', id: P1 });
    expect((await t.impl.reconcileIfDue()).deleted).toBe(0);
    expect(mock.profiles.has(one.username)).toBe(true);
    t.clock.t += 3 * 86_400_000;
    expect((await t.impl.reconcileIfDue()).deleted).toBe(1);
    expect(mock.profiles.has(one.username)).toBe(false);
    expect(mock.profiles.has(two.username)).toBe(true);
    // a database without any of the account's businesses (not this app's, or emptied) concludes nothing
    await t.db.remove('user_docs', { user_id: TOM, kind: 'project', id: P2 });
    t.clock.t += 3 * 86_400_000;
    await t.impl.reconcileIfDue();
    t.clock.t += 3 * 86_400_000;
    await t.impl.reconcileIfDue();
    expect(mock.profiles.has(two.username)).toBe(true);
  });
});

describe('the plan’s slots: daily budget, missing profiles, refusals and the owner’s alerts', () => {
  it('one user connecting, deleting and connecting again can’t use up the daily new-profile budget for everyone', async () => {
    const t = setup({ env: { UPLOAD_POST_NEW_PROFILES_PER_DAY: '5' }, start: Date.parse('2026-11-06T09:00:00Z') });
    const ANN = 'c1111111-2222-4333-8444-555555555555';
    const BEN = 'c2111111-2222-4333-8444-555555555555';
    await business(t, ANN, P1);
    await business(t, BEN, P1);
    let made = 0;
    let refused = null;
    for (let i = 0; i < 6; i += 1) {
      try {
        await t.connections.connectLink(ANN, 'instagram', { projectId: P1 });
        made += 1;
      } catch (e) {
        refused = e;
        break;
      }
      await t.connections.forgetProject(ANN, P1);
      t.clock.t += 6 * 60_000;
    }
    // as many new profiles a day as the user's limit (3), then a plain refusal for that user only
    expect(made).toBe(3);
    expect(refused).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(errorBody(refused, null).body.error).toMatch(/tomorrow/);
    expect(errorBody(refused, null).body.error).not.toMatch(/upload|plan/i);
    // everyone else still connects
    expect((await t.connections.connectLink(BEN, 'instagram', { projectId: P1 })).connectLink).toBeDefined();
    // the next day ANN can again
    t.clock.t += 86_400_000;
    expect((await t.connections.connectLink(ANN, 'instagram', { projectId: P1 })).connectLink).toBeDefined();
  });

  it('a create Upload-Post refuses outright (a 400) tells the owner, reads “temporarily unavailable” to the customer, and gives the day’s slot back', async () => {
    const t = setup({ env: { UPLOAD_POST_NEW_PROFILES_PER_DAY: '1' } });
    const CAL = 'c3111111-2222-4333-8444-555555555555';
    const DEE = 'c4111111-2222-4333-8444-555555555555';
    await business(t, CAL, P1);
    await business(t, DEE, P1);
    mock.failCreates.push(400, 400);
    try {
      for (let i = 0; i < 2; i += 1) {
        const err = await t.connections.connectLink(CAL, 'x', { projectId: P1 }).catch((e) => e);
        expect(err).toMatchObject({ status: 503, code: 'CONNECTIONS_UNAVAILABLE' });
        expect(errorBody(err, null).body.error).toBe('Social connections are temporarily unavailable. We’ve been notified.');
        expect(errorBody(err, { isAdmin: true }).body.hint).toContain('HTTP 400');
      }
    } finally {
      mock.failCreates.length = 0;
    }
    expect(Object.keys(await alertsOf(t))).toContain('profile_refused');
    expect(Object.keys(await alertsOf(t))).not.toContain('profile_budget');
    // nothing was made: the one slot of the day is still there for anyone, and the user's own count too
    expect(await t.connections.slots(CAL)).toMatchObject({ used: 0 });
    expect((await t.connections.connectLink(DEE, 'x', { projectId: P1 })).connectLink).toBeDefined();
  });

  it('a create with no trustworthy answer (5xx) keeps its reservation and the day’s slot; asking again for the same name takes no second slot', async () => {
    const t = setup({ env: { UPLOAD_POST_NEW_PROFILES_PER_DAY: '1' } });
    const EDD = 'c5111111-2222-4333-8444-555555555555';
    await business(t, EDD, P1);
    mock.failCreates.push(500);
    try {
      await expect(t.connections.connectLink(EDD, 'x', { projectId: P1 })).rejects.toMatchObject({ status: 502 });
    } finally {
      mock.failCreates.length = 0;
    }
    expect(await t.connections.slots(EDD)).toMatchObject({ used: 1 });
    expect((await t.connections.connectLink(EDD, 'x', { projectId: P1 })).connectLink).toBeDefined();
    expect(Object.keys(await alertsOf(t))).not.toContain('profile_budget');
  });

  it('a profile deleted by hand at Upload-Post stops holding the slot and being billed (found by a read or the daily check); its next Connect makes it again with the same name', async () => {
    const t = setup({ start: Date.parse('2026-11-03T10:00:00Z') });
    const FLO = 'c6111111-2222-4333-8444-555555555555';
    const one = await connectVia(t, FLO, 'instagram', {}, P1);
    const two = await connectVia(t, FLO, 'instagram', {}, P2);
    mock.profiles.delete(one.username);
    mock.profiles.delete(two.username);
    // the daily check: not in the listing, read by name, 404: gone
    t.clock.t += 86_400_000;
    expect(await t.impl.reconcileIfDue()).toMatchObject({ missing: 2 });
    expect(await t.connections.slots(FLO)).toMatchObject({ used: 0 });
    expect((await statusOf(t, FLO, 'instagram', P1)).state).toBe('not_connected');
    // Connect makes it again, with the same stored name
    await t.connections.connectLink(FLO, 'instagram', { projectId: P1 });
    expect(await nameOf(t, FLO, P1)).toBe(one.username);
    expect(mock.profiles.has(one.username)).toBe(true);
    // a read of the profile (Check) that answers 404 says the same, without waiting for the daily check
    mock.profiles.delete(one.username);
    await t.connections.check(FLO, 'instagram', { projectId: P1 });
    expect(await t.connections.slots(FLO)).toMatchObject({ used: 0 });
    // November is billed only for the days they were there
    t.clock.t = Date.parse('2026-12-02T10:00:00Z');
    await t.impl.meterIfDue();
    const rows = t.db.rows('usage_ledger').filter((r) => r.endpoint === 'upload_post_profile 2026-11' && r.customer_tag === customerTag(FLO, t.env));
    for (const r of rows) expect(r.cost_micro).toBeLessThan(300_000);
    t.clock.t = Date.parse('2027-01-02T10:00:00Z');
    await t.impl.meterIfDue();
    expect(t.db.rows('usage_ledger').filter((r) => r.endpoint === 'upload_post_profile 2026-12' && r.customer_tag === customerTag(FLO, t.env))).toEqual([]);
  });

  it('the owner’s Billing page: one customer at their limit never hides “plan nearly full”', async () => {
    const t = setup();
    await t.storage.put('uploadpost:alerts', { profile_cap_low: { at: new Date(t.clock.t).toISOString() }, profile_user_cap: { at: new Date(t.clock.t).toISOString(), n: 3 } });
    expect((await t.impl.ownerView()).alert).toMatchObject({ kind: 'profile_cap_low' });
    await t.storage.put('uploadpost:alerts', { x_links_low: { at: new Date(t.clock.t).toISOString() }, profile_user_cap: { at: new Date(t.clock.t).toISOString(), n: 3 } });
    expect((await t.impl.ownerView()).alert).toMatchObject({ kind: 'x_links_low' });
    // a customer clicking Connect again and again re-stamps nothing within 10 minutes
    const GUS = 'c7111111-2222-4333-8444-555555555555';
    const u = setup({ env: { UPLOAD_POST_MAX_PROFILES_PER_USER: '1' } });
    await connectVia(u, GUS, 'x', {}, P1);
    await business(u, GUS, P2);
    for (let i = 0; i < 3; i += 1) await u.connections.connectLink(GUS, 'x', { projectId: P2 }).catch(() => null);
    await alertsOf(u);
    expect(u.storage.puts('uploadpost:alerts')).toBe(1);
  });

  it('a name given back and made again is billed once for the days it overlaps (never twice)', async () => {
    const t = setup({ start: Date.parse('2026-10-01T00:00:00Z') });
    const HAL = 'c8111111-2222-4333-8444-555555555555';
    const { username } = await connectVia(t, HAL, 'x', {}, P1);
    // deleted on 10 October, the delete fails: the profile lives on at Upload-Post
    t.clock.t = Date.parse('2026-10-10T00:00:00Z');
    mock.failDeletes.add(username);
    try {
      await t.connections.forgetProject(HAL, P1);
      // the business comes back (a backup), and its Connect gets no answer
      t.clock.t = Date.parse('2026-10-20T00:00:00Z');
      mock.failCreates.push(500);
      await t.connections.connectLink(HAL, 'x', { projectId: P1 }).catch(() => null);
    } finally {
      mock.failDeletes.delete(username);
      mock.failCreates.length = 0;
    }
    // the daily check finds it there: ready, from this reservation (not Upload-Post's first created_at)
    await t.impl.reconcileIfDue();
    const entry = (await docOf(t, HAL)).profiles.find((p) => p.projectId === P1);
    expect(entry).toMatchObject({ state: 'ready' });
    expect(Date.parse(entry.createdAt)).toBeGreaterThanOrEqual(Date.parse('2026-10-20T00:00:00Z'));
    t.clock.t = Date.parse('2026-11-01T06:00:00Z');
    await t.impl.meterIfDue();
    const row = t.db.rows('usage_ledger').find((r) => r.endpoint === 'upload_post_profile 2026-10' && r.customer_tag === customerTag(HAL, t.env));
    expect(row.cost_micro).toBeLessThanOrEqual(1_960_000);
  });
});

describe('account deletion, the monthly estimate and the daily reconcile', () => {
  it('account deletion: forgetUser stops social and marks every business profile but deletes nothing, so a deletion that stops (unforgetUser) loses no connection; userDeleted deletes them all once the account is gone', async () => {
    const t = setup();
    const one = await connectVia(t, ALICE, 'instagram', {}, P1);
    const two = await connectVia(t, ALICE, 'x', {}, P2);
    await t.connections.forgetUser(ALICE);
    expect(mock.profiles.has(one.username) && mock.profiles.has(two.username)).toBe(true);
    expect((await t.connections.status(ALICE, { projectId: P1 })).every((s) => s.state === 'not_connected' || s.state === 'coming_soon')).toBe(true);
    const marks = (await t.storage.get('uploadpost:gone')).value;
    expect(marks[one.username] && marks[two.username]).toBeTruthy();
    // the deletion stopped (Zernio, Omnisend or the account itself failed): everything is as it was
    await t.connections.unforgetUser(ALICE);
    expect((await statusOf(t, ALICE, 'instagram', P1)).state).toBe('connected');
    expect((await statusOf(t, ALICE, 'x', P2)).state).toBe('connected');
    expect((await t.storage.get('uploadpost:gone')).value[one.username]).toBeUndefined();
    // it went through: every profile (and every account in them) goes now, and their cost so far is on the ledger
    await t.connections.forgetUser(ALICE);
    await t.impl.userDeleted(ALICE);
    expect(mock.profiles.has(one.username) || mock.profiles.has(two.username)).toBe(false);
    expect((await t.storage.get('uploadpost:gone')).value).toEqual({});
    expect((await docOf(t, ALICE)).profiles).toEqual([]);
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

  it('the monthly estimate: one row per business profile, on its customer and tagged with the business; a failed insert leaves the month open; a customer deleted mid-month is charged up to then', async () => {
    const t = setup({ start: Date.parse('2026-10-01T00:00:00Z') });
    const FRAN = 'b3111111-2222-4333-8444-555555555555';
    const GIL = 'b4111111-2222-4333-8444-555555555555';
    await connectVia(t, FRAN, 'x', {}, P1);
    await connectVia(t, FRAN, 'x', {}, P2);
    await connectVia(t, GIL, 'x', {}, P1);
    t.clock.t = Date.parse('2026-11-01T06:00:00Z');
    let inserts = 0;
    t.db.fail.usage_ledger = (op) => op === 'insert' && (inserts += 1) === 1;
    const first = await t.impl.meterIfDue();
    expect(first).toMatchObject({ rows: 2, incomplete: true });
    delete t.db.fail.usage_ledger;
    // the next daily run (after the 2-hour claim) finishes the month without a second row for anyone
    t.clock.t += 3 * 3_600_000;
    expect((await t.impl.meterIfDue()).rows).toBe(1);
    t.clock.t += 3 * 3_600_000;
    expect((await t.impl.meterIfDue()).skipped).toBe(true);
    const rows = t.db.rows('usage_ledger').filter((r) => r.endpoint === 'upload_post_profile 2026-10');
    expect(rows.map((r) => [r.customer_tag, r.project_id]).sort()).toEqual([[customerTag(FRAN, t.env), P1], [customerTag(FRAN, t.env), P2], [customerTag(GIL, t.env), P1]].sort());
    expect(rows.every((r) => r.cost_micro === 1_960_000 && r.estimated === true && r.feature === 'connections' && r.vendor === 'uploadpost')).toBe(true);
    // FRAN's two businesses add up to two profile-months for her
    expect(rows.filter((r) => r.customer_tag === customerTag(FRAN, t.env)).reduce((s, r) => s + r.cost_micro, 0)).toBe(3_920_000);
    // GIL is deleted on 16 November: half of November is written now (the monthly run won't see GIL)
    t.clock.t = Date.parse('2026-11-16T00:00:00Z');
    await t.connections.forgetUser(GIL);
    await t.impl.userDeleted(GIL);
    const nov = t.db.rows('usage_ledger').find((r) => r.endpoint === 'upload_post_profile 2026-11' && r.customer_tag === customerTag(GIL, t.env));
    expect(nov).toMatchObject({ project_id: P1 });
    expect(nov.cost_micro).toBeGreaterThan(900_000);
    expect(nov.cost_micro).toBeLessThan(1_100_000);
  });

  it('a business deleted mid-month is charged up to then on the next monthly run; the owner’s counts add up the customer’s businesses', async () => {
    const t = setup({ start: Date.parse('2026-10-01T00:00:00Z') });
    const HAN = 'b5211111-2222-4333-8444-555555555555';
    await connectVia(t, HAN, 'x', {}, P1);
    await connectVia(t, HAN, 'instagram', {}, P2);
    await connectVia(t, HAN, 'tiktok', {}, P2);
    expect(await t.impl.accountCount(HAN)).toBe(3);
    expect(await t.impl.profileCount(HAN)).toBe(2);
    t.clock.t = Date.parse('2026-10-16T00:00:00Z');
    await t.connections.forgetProject(HAN, P1);
    expect(await t.impl.profileCount(HAN)).toBe(1);
    t.clock.t = Date.parse('2026-11-01T06:00:00Z');
    await t.impl.meterIfDue();
    const rows = t.db.rows('usage_ledger').filter((r) => r.endpoint === 'upload_post_profile 2026-10' && r.customer_tag === customerTag(HAN, t.env));
    expect(rows.find((r) => r.project_id === P2).cost_micro).toBe(1_960_000);
    const half = rows.find((r) => r.project_id === P1).cost_micro;
    expect(half).toBeGreaterThan(900_000);
    expect(half).toBeLessThan(1_100_000);
    expect(await t.impl.ownerView()).toMatchObject({ profilesUsed: expect.any(Number), profilesLimit: 75, perUserLimit: 3 });
  });

  it('the daily reconcile never deletes a profile because its customer looks absent: an unknown ylb_ profile, an empty database or a doc it can’t read is left alone (the owner is told)', async () => {
    const t = setup();
    const { username: alices } = await connectVia(t, ALICE, 'x');
    mock.addProfile('ylb_abcabcabcabcabcabcabcabc_12345678');
    mock.addProfile('owner_test_profile');
    // ALICE's doc can't be read (the app_state secret changed)
    const key = `uploadpost:user:${sha256(ALICE)}`;
    const kept = t.storage.documents.get(key);
    t.storage.documents.set(key, { unreadable: true, value: null, updatedAt: kept.updatedAt });
    const r = await t.impl.reconcileIfDue();
    expect(r.deleted).toBe(0);
    for (const u of ['ylb_abcabcabcabcabcabcabcabc_12345678', 'owner_test_profile', alices]) expect(mock.profiles.has(u)).toBe(true);
    expect((await alertsOf(t)).profile_orphans).toMatchObject({ n: expect.any(Number) });
    expect((await t.impl.reconcileIfDue()).skipped).toBe(true);
    // a copy of the app on an empty database (no customers at all) deletes nothing either
    const empty = createUploadPostConnections({ env: t.env, storage: makeStorage(), db: makeDb(), log: makeLog(), now: () => t.clock.t });
    expect((await empty.reconcileIfDue()).deleted).toBe(0);
    expect(mock.profiles.has(alices)).toBe(true);
    t.storage.documents.set(key, kept);
    mock.profiles.delete('ylb_abcabcabcabcabcabcabcabc_12345678');
  });

  it('the daily reconcile reads back every business profile whose accounts changed without a webhook, and gives back one nobody connected anything to for a week (made again with the same name on its next Connect)', async () => {
    const t = setup();
    const HAL = 'b5111111-2222-4333-8444-555555555555';
    const IVY = 'b6111111-2222-4333-8444-555555555555';
    const { username: hals } = await connectVia(t, HAL, 'youtube');
    // IVY pressed Connect but never finished; HAL connected Instagram and its webhook was lost
    await business(t, IVY);
    await t.connections.connectLink(IVY, 'x', { projectId: P1 });
    const ivys = await nameOf(t, IVY);
    mock.connect(hals, 'instagram');
    t.clock.t += 8 * 86_400_000;
    const r = await t.impl.reconcileIfDue();
    expect((await docOf(t, HAL)).profiles[0].accounts.instagram).toBeDefined();
    expect(r.reclaimed).toBe(1);
    expect(mock.profiles.has(ivys)).toBe(false);
    expect(mock.profiles.has(hals)).toBe(true);
    const ivy = (await docOf(t, IVY)).profiles[0];
    expect(ivy).toMatchObject({ projectId: P1, username: ivys, state: 'reclaimed' });
    expect(await t.connections.slots(IVY)).toMatchObject({ used: 0 });
    // the next Connect makes it again, with the stored name
    expect((await t.connections.connectLink(IVY, 'x', { projectId: P1 })).connectLink).toMatch(/\/connect\?token=/);
    expect(mock.profiles.has(ivys)).toBe(true);
    expect(await nameOf(t, IVY)).toBe(ivys);
  });

  it('never logs the API key, a connect link, a profile name, a business id or an account id', async () => {
    const t = setup();
    const { link, acct, username } = await connectVia(t, BOB, 'instagram', { id: 'ig_acct_secret_id' });
    await t.connections.publish(BOB, 'instagram', { projectId: P1, jobId: JOB(), composed: { text: 'Hi' }, media: { id: 'img-3.jpg', kind: 'image', type: 'image/jpeg', size: 10 } });
    await t.connections.forgetProject(BOB, P1);
    const text = t.log.text();
    expect(text).not.toContain(TEST_UPLOAD_POST_KEY);
    expect(text).not.toContain(link.connectLink);
    expect(text).not.toContain(acct.username);
    expect(text).not.toContain(username);
    expect(text).not.toContain(P1);
    expect(text).not.toContain('/api/media/public/');
  });
});

describe('a doc from the earlier one-profile-per-customer build (dev data)', () => {
  it('is read safely: nothing shows as connected, Connect makes the business’s own profile, and the old profile is deleted by the daily check', async () => {
    const t = setup();
    const OLD = 'b0111111-2222-4333-8444-555555555555';
    const tag = customerTag(OLD, t.env);
    const legacy = `ylb_${tag.slice(5)}`;
    mock.addProfile(legacy);
    mock.connect(legacy, 'instagram');
    await t.db.insert('billing_customers', { customer_tag: tag, user_id: OLD });
    await t.storage.put(`uploadpost:user:${sha256(OLD)}`, { v: 1, username: legacy, customer: tag, createdAt: new Date(t.clock.t).toISOString(), accounts: { instagram: { key: 'acct_x', label: 'Old', state: 'connected' } }, pages: {}, pins: {}, choice: {}, pending: {}, lastError: {} });
    expect((await statusOf(t, OLD, 'instagram')).state).toBe('not_connected');
    // an event for the old profile is ignored
    const evt = mock.signed({ event: 'social_account_connected', profile_username: legacy, platform: 'instagram' });
    expect((await t.impl.webhook(evt.raw, evt.headers)).status).toBe(200);
    await t.impl.settled();
    await connectVia(t, OLD, 'x');
    const name = await nameOf(t, OLD);
    expect(name).toMatch(PROFILE_USERNAME);
    expect((await docOf(t, OLD)).legacy).toEqual({ username: legacy });
    expect(await t.impl.profileCount(OLD)).toBe(2);
    expect((await t.impl.reconcileIfDue()).deleted).toBe(1);
    expect(mock.profiles.has(legacy)).toBe(false);
    expect(mock.profiles.has(name)).toBe(true);
    expect((await docOf(t, OLD)).legacy).toBeUndefined();
    expect((await statusOf(t, OLD, 'x')).state).toBe('connected');
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

  it('“trial” in an error reads as a Trial Reel refusal only for a job that was a Trial Reel, on Instagram', () => {
    const refused = { success: false, error: 'This account is not eligible for trial reels', error_code: 'instagram_api_error' };
    expect(outcomeOfEntry(refused, { final: true, platform: 'instagram', trial: true })).toEqual({ state: 'failed', errorCode: 'TRIAL_REEL_REFUSED' });
    // a regular Reel or photo whose error happens to mention a trial
    expect(outcomeOfEntry(refused, { final: true, platform: 'instagram' })).toEqual({ state: 'failed', errorCode: 'REFUSED' });
    // another network's error code containing "trial"
    expect(outcomeOfEntry({ success: false, error_code: 'trial_expired' }, { final: true, platform: 'tiktok' })).toEqual({ state: 'failed', errorCode: 'REFUSED' });
    expect(outcomeOfEntry({ success: false, error_code: 'trial_expired' }, { final: true, platform: 'facebook', trial: true })).toEqual({ state: 'failed', errorCode: 'REFUSED' });
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
