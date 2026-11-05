// Connected accounts through Nango (server/nango.mjs), against server/test/mock-nango.mjs: connect sessions, the
// signed webhook and what it may change, targets and the chosen account, the proxy (one attempt, no Retries,
// placeholders, Nango's own errors), check, disconnect, forgetting an account, and the monthly estimate rows.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNango, integrationIds, scopesFor } from './nango.mjs';
import { createConnections } from './connections/index.mjs';
import { customerTag, sha256 } from './integrations/common.mjs';
import { createMockNango, makeDb, makeLog, makeStorage, signWebhook, TEST_NANGO_KEY, TEST_SIGNING_KEY } from './test/mock-nango.mjs';

const UID = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';
const UID2 = '7d1e2b3c-4a5f-4b6c-8d7e-9f0a1b2c3d4e';
const TAG_SECRET = 'test-customer-tag-secret-0123456789';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

let mock;
beforeAll(async () => {
  mock = await createMockNango().start();
});
afterAll(async () => {
  await mock.close();
});

/** A fresh Nango instance with its own storage, db, clock and log. */
function setup(extraEnv = {}, opts = {}) {
  const storage = opts.storage ?? makeStorage();
  const db = makeDb();
  const log = makeLog();
  const clock = { t: NOW };
  const slept = [];
  const env = { NANGO_SECRET_KEY: TEST_NANGO_KEY, NANGO_WEBHOOK_SIGNING_KEY: TEST_SIGNING_KEY, CUSTOMER_TAG_SECRET: TAG_SECRET, NANGO_BASE_URL: mock.base, ...extraEnv };
  const nango = createNango({
    env,
    storage,
    db,
    log,
    now: () => clock.t,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const deliver = (entry, headers) => nango.webhook(Buffer.from(entry.raw), headers ?? { 'x-nango-hmac-sha256': signWebhook(entry.raw) });
  /** Send a signed event of our own making. */
  const event = async (payload, key = TEST_SIGNING_KEY) => {
    const raw = JSON.stringify(payload);
    return nango.webhook(Buffer.from(raw), { 'x-nango-hmac-sha256': signWebhook(raw, key) });
  };
  /** Connect a platform end to end (session → Complete → webhook → accounts read). */
  async function connect(userId, platform = 'facebook') {
    const link = await nango.connectLink(userId, platform);
    const token = new URL(link.connectLink).searchParams.get('session_token');
    const sent = await mock.complete(token);
    const r = await deliver(sent);
    await r.after;
    return { link, sent, r, connectionId: sent.body.connectionId };
  }
  const doc = (userId = UID) => storage.documents.get(`nango:user:${sha256(userId)}`)?.value;
  const status = async (platform, userId = UID) => (await nango.status(userId)).find((s) => s.platform === platform);
  return { nango, storage, db, log, clock, slept, env, deliver, event, connect, doc, status };
}

beforeEach(() => mock.reset());

describe('setup and scopes', () => {
  it('reads the integration ids, keeping only known platforms and plain ids', () => {
    expect(integrationIds({}).facebook).toBe('ylb-facebook');
    expect(integrationIds({ NANGO_INTEGRATIONS: '{"facebook":"my-fb","nope":"x","x":"bad id!"}' })).toMatchObject({ facebook: 'my-fb', x: 'ylb-x' });
    expect(integrationIds({ NANGO_INTEGRATIONS: 'not json' }).facebook).toBe('ylb-facebook');
  });

  it('asks LinkedIn only for openid, profile and w_member_social until the org products are approved', () => {
    expect(scopesFor('linkedin', {})).toBe('openid,profile,w_member_social');
    expect(scopesFor('linkedin', { LINKEDIN_MEMBER_ANALYTICS_APPROVED: '1' })).toBe('openid,profile,w_member_social,r_member_postAnalytics');
    expect(scopesFor('linkedin', { LINKEDIN_ORG_APPROVED: '1' })).toBe('openid,profile,w_member_social,w_organization_social,r_organization_social,rw_organization_admin');
    expect(scopesFor('facebook')).toContain('pages_manage_engagement');
    expect(scopesFor('facebook')).toContain('instagram_manage_comments');
    expect(scopesFor('meta_ads')).toBe('ads_read,business_management');
  });

  it('is not set up without the signing key, and says which Secret (names only)', async () => {
    const s = setup({ NANGO_WEBHOOK_SIGNING_KEY: '' });
    expect(s.nango.setUp).toBe(false);
    expect(s.nango.hint).toMatch(/NANGO_WEBHOOK_SIGNING_KEY/);
    expect(s.nango.hint).not.toContain(TEST_NANGO_KEY);
    await expect(s.nango.connectLink(UID, 'facebook')).rejects.toMatchObject({ status: 503, code: 'NOT_SET_UP' });
  });
});

describe('connect sessions', () => {
  it('sends the customer tag only (no email or name) and the scopes for the platform; stores pending', async () => {
    const s = setup();
    const link = await s.nango.connectLink(UID, 'linkedin');
    expect(link.connectLink).toMatch(/\/connect\?session_token=nango_connect_session_test_/);
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
    const body = mock.lastSession();
    const tag = customerTag(UID, { CUSTOMER_TAG_SECRET: TAG_SECRET });
    expect(body.tags).toEqual({ end_user_id: tag, organization_id: tag });
    expect(body.allowed_integrations).toEqual(['ylb-linkedin']);
    expect(body.integrations_config_defaults['ylb-linkedin'].connection_config.oauth_scopes_override).toBe('openid,profile,w_member_social');
    expect(JSON.stringify(body)).not.toMatch(/end_user_email|end_user_display_name|@/);
    expect(s.db.rows('billing_customers')).toEqual([{ customer_tag: tag, user_id: UID }]);
    expect(s.doc().pendingSince.linkedin).toBe(new Date(NOW).toISOString());
    expect((await s.status('linkedin')).state).toBe('pending');
  });

  it('uses Facebook Login for Business config_id instead of scopes when it is set; Instagram connects through Facebook', async () => {
    const s = setup({ META_LOGIN_CONFIG_ID: '1234567890' });
    await s.nango.connectLink(UID, 'instagram');
    const body = mock.lastSession();
    expect(body.allowed_integrations).toEqual(['ylb-facebook']);
    expect(body.integrations_config_defaults['ylb-facebook']).toEqual({ authorization_params: { config_id: '1234567890' } });
  });

  it('never logs the connect link or its session token', async () => {
    const s = setup();
    const link = await s.nango.connectLink(UID, 'facebook');
    const token = new URL(link.connectLink).searchParams.get('session_token');
    expect(s.log.text()).not.toContain(token);
    expect(s.log.text()).not.toContain('connect?session');
    expect(s.log.text()).not.toContain(TEST_NANGO_KEY);
  });

  it('reads a pending connect older than 30 minutes as not connected ("didn’t finish")', async () => {
    const s = setup();
    await s.nango.connectLink(UID, 'tiktok');
    s.clock.t += 29 * MIN;
    expect(await s.status('tiktok')).toEqual({ platform: 'tiktok', state: 'pending' });
    s.clock.t += 2 * MIN;
    expect(await s.status('tiktok')).toEqual({ platform: 'tiktok', state: 'not_connected', lastError: 'not_finished' });
  });

  it('maps Nango refusals to our words: a missing integration is NOT_SET_UP with an owner hint, plan_limit is unavailable', async () => {
    const s = setup();
    mock.fail('/connect/sessions', 404, { body: { error: { code: 'unknown_provider_config', message: 'Integration does not exist <script>' } } });
    const e = await s.nango.connectLink(UID, 'facebook').catch((x) => x);
    expect(e).toMatchObject({ status: 503, code: 'NOT_SET_UP' });
    expect(e.hint).toContain('ylb-facebook');
    expect(e.message).not.toContain('script');
    mock.fail('/connect/sessions', 402, { body: { error: { code: 'plan_limit' } } });
    await expect(s.nango.connectLink(UID, 'facebook')).rejects.toMatchObject({ code: 'CONNECTIONS_UNAVAILABLE' });
    expect(s.storage.documents.get('nango:alert').value.kind).toBe('plan_limit');
  });

  it('reconnect keeps the connection id and sends an override', async () => {
    const s = setup();
    const { connectionId } = await s.connect(UID, 'x');
    const link = await s.nango.reconnectLink(UID, 'x');
    const body = mock.lastSession();
    expect(body.connection_id).toBe(connectionId);
    expect(body.integration_id).toBe('ylb-x');
    const sent = await mock.complete(new URL(link.connectLink).searchParams.get('session_token'));
    expect(sent.body.operation).toBe('override');
    await (await s.deliver(sent)).after;
    expect(s.doc().platforms.x.connectionId).toBe(connectionId);
  });
});

describe('the webhook', () => {
  it('accepts the signing key and the previous one; refuses a bad signature or a changed byte', async () => {
    const s = setup({ NANGO_WEBHOOK_SIGNING_KEY_PREVIOUS: 'test-nango-old-signing-key' });
    const payload = { type: 'sync', from: 'nango' };
    expect((await s.event(payload)).status).toBe(200);
    expect((await s.event(payload, 'test-nango-old-signing-key')).status).toBe(200);
    expect((await s.event(payload, 'wrong-key')).status).toBe(401);
    const raw = JSON.stringify({ type: 'auth', operation: 'deletion', connectionId: 'c1' });
    const sig = signWebhook(raw);
    const changed = Buffer.from(raw);
    changed[changed.length - 3] ^= 1;
    const r = await s.nango.webhook(changed, { 'x-nango-hmac-sha256': sig });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Not allowed.', code: 'AUTH_REQUIRED' });
    expect((await s.nango.webhook(Buffer.from(raw), {})).status).toBe(401);
  });

  it('ignores types it doesn’t know', async () => {
    const s = setup();
    const r = await s.event({ type: 'brand_new_type', operation: 'creation', connectionId: 'x' });
    expect(r.status).toBe(200);
    expect(s.storage.puts()).toBe(0);
  });

  it('creation: stores the connection, reads the Pages, picks none of two, Instagram follows the chosen Page', async () => {
    const s = setup();
    const { connectionId } = await s.connect(UID, 'facebook');
    const e = s.doc().platforms.facebook;
    expect(e).toMatchObject({ connectionId, providerConfigKey: 'ylb-facebook', state: 'connected', targetsAvailable: 2, target: null, limited: null });
    expect(s.doc().pendingSince.facebook).toBeUndefined();
    const fb = await s.status('facebook');
    expect(fb).toMatchObject({ platform: 'facebook', state: 'connected', targetsAvailable: 2 });
    expect(JSON.stringify(await s.nango.status(UID))).not.toContain(connectionId);
    expect(await s.status('instagram')).toEqual({ platform: 'instagram', state: 'not_connected' });

    const targets = await s.nango.targets(UID, 'facebook');
    expect(targets.map((t) => t.label)).toEqual(['Joe’s Bakery', 'Joe’s Second Shop']);
    expect(targets.every((t) => /^tgt_[0-9a-f]{32}$/.test(t.id))).toBe(true);
    expect(JSON.stringify(targets)).not.toContain('111222333');
    const chosen = await s.nango.setTarget(UID, 'facebook', targets[0].id);
    expect(chosen).toMatchObject({ state: 'connected', targetLabel: 'Joe’s Bakery', targetKind: 'fb_page' });
    expect(await s.status('instagram')).toMatchObject({ platform: 'instagram', state: 'connected', targetKind: 'ig_account' });
    // a Page without CREATE_CONTENT: limited, and Instagram has no account
    const second = await s.nango.setTarget(UID, 'facebook', targets[1].id);
    expect(second).toMatchObject({ state: 'limited', limitedReason: 'no_page_role' });
    expect((await s.status('instagram')).state).toBe('not_connected');
  });

  it('chooses the only account by itself (X)', async () => {
    const s = setup();
    await s.connect(UID, 'x');
    expect(await s.status('x')).toMatchObject({ state: 'connected', targetLabel: '@joesbakery', targetKind: 'x_account', targetsAvailable: 1 });
    const call = mock.proxyCalls().find((c) => c.path === '/2/users/me');
    expect(call.headers['base-url-override']).toBe('https://api.x.com');
  });

  it('missing Meta permissions → limited (missing_permissions); a sole Page without CREATE_CONTENT → limited (no_page_role)', async () => {
    const s = setup();
    mock.on('GET', '/v26.0/me/permissions', { body: { data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'declined' }] } });
    await s.connect(UID, 'facebook');
    expect(await s.status('facebook')).toMatchObject({ state: 'limited', limitedReason: 'missing_permissions' });

    mock.reset();
    const t = setup();
    mock.on('GET', '/v26.0/me/accounts', { body: { data: [{ id: '777', name: 'Only Page', tasks: ['ANALYZE'] }] } });
    await t.connect(UID, 'facebook');
    expect(await t.status('facebook')).toMatchObject({ state: 'limited', limitedReason: 'no_page_role', targetLabel: 'Only Page' });
  });

  it('applies the same raw body once; refresh false → true → false (three bodies) ends needs_reconnect', async () => {
    const s = setup();
    const { sent, connectionId } = await s.connect(UID, 'youtube');
    const before = s.storage.puts();
    expect((await s.deliver(sent)).status).toBe(200);
    expect(s.storage.puts()).toBe(before);
    const tags = sent.body.tags;
    const base = { from: 'nango', type: 'auth', operation: 'refresh', connectionId, providerConfigKey: 'ylb-youtube', tags };
    await s.event({ ...base, success: false, error: { type: 'refresh_token_external_error' } });
    expect((await s.status('youtube')).state).toBe('needs_reconnect');
    await s.event({ ...base, success: true });
    expect((await s.status('youtube')).state).toBe('connected');
    await s.event({ ...base, success: false, error: { type: 'refresh_token_external_error' }, n: 2 });
    expect((await s.status('youtube')).state).toBe('needs_reconnect');
    expect(s.doc().platforms.youtube.needsReconnect).toBe('refresh_failed');
  });

  it('a later deletion of the replaced connection leaves the new one connected (stale_connection_event)', async () => {
    const s = setup();
    const a = await s.connect(UID, 'linkedin');
    const b = await s.connect(UID, 'linkedin');
    expect(b.connectionId).not.toBe(a.connectionId);
    // the app deleted A once at Nango, and Nango sent A's deletion
    await new Promise((r) => setTimeout(r, 20));
    const deletions = mock.webhooks.filter((w) => w.body.operation === 'deletion');
    expect(deletions.map((w) => w.body.connectionId)).toEqual([a.connectionId]);
    expect(mock.calls.filter((c) => c.method === 'DELETE').length).toBe(1);
    expect((await s.deliver(deletions[0])).status).toBe(200);
    expect(await s.status('linkedin')).toMatchObject({ state: 'connected' });
    expect(s.doc().platforms.linkedin.connectionId).toBe(b.connectionId);
    expect(s.log.events('stale_connection_event')).toHaveLength(1);
  });

  it('disconnect then a quick reconnect: the old deletion doesn’t remove the new connection', async () => {
    const s = setup();
    const a = await s.connect(UID, 'tiktok');
    await s.nango.disconnect(UID, 'tiktok');
    expect(s.doc().platforms.tiktok).toBeUndefined();
    const b = await s.connect(UID, 'tiktok');
    await new Promise((r) => setTimeout(r, 20));
    const del = mock.webhooks.find((w) => w.body.operation === 'deletion' && w.body.connectionId === a.connectionId);
    await s.deliver(del);
    expect(s.doc().platforms.tiktok.connectionId).toBe(b.connectionId);
    // a deletion of the current one removes it
    await s.event({ type: 'auth', operation: 'deletion', connectionId: b.connectionId, providerConfigKey: 'ylb-tiktok', tags: b.sent.body.tags });
    expect(s.doc().platforms.tiktok).toBeUndefined();
  });

  it('a failed reconnect (override false) keeps needs_reconnect and records the error type', async () => {
    const s = setup();
    const { connectionId, sent } = await s.connect(UID, 'x');
    const base = { type: 'auth', connectionId, providerConfigKey: 'ylb-x', tags: sent.body.tags };
    await s.event({ ...base, operation: 'refresh', success: false });
    await s.event({ ...base, operation: 'override', success: false, error: { type: 'access_denied' } });
    expect(await s.status('x')).toMatchObject({ state: 'needs_reconnect', lastError: 'access_denied' });
    await s.event({ ...base, operation: 'override', success: true });
    expect((await s.status('x')).state).toBe('connected');
  });

  it('a failed creation shows not connected with the error type (third-party text kept to a plain code)', async () => {
    const s = setup();
    await s.nango.connectLink(UID, 'youtube');
    const tag = customerTag(UID, { CUSTOMER_TAG_SECRET: TAG_SECRET });
    await s.event({ type: 'auth', operation: 'creation', success: false, connectionId: 'c-x', providerConfigKey: 'ylb-youtube', tags: { end_user_id: tag }, error: { type: '<img src=x onerror=alert(1)>' } });
    expect(await s.status('youtube')).toEqual({ platform: 'youtube', state: 'not_connected', lastError: 'connect_failed' });
  });

  it('a creation for an unknown customer is logged with the tag only and stores nothing', async () => {
    const s = setup();
    const r = await s.event({ type: 'auth', operation: 'creation', success: true, connectionId: 'c-unknown', providerConfigKey: 'ylb-x', tags: { end_user_id: `cust_${'a'.repeat(24)}` } });
    expect(r.status).toBe(200);
    expect(s.storage.puts()).toBe(0);
    const [ev] = s.log.events('nango_webhook_unknown_customer');
    expect(ev.customer).toBe(`cust_${'a'.repeat(24)}`);
    expect(s.log.text()).not.toContain('c-unknown');
  });

  it('answers 500 when it can’t store (so Nango sends it again) and 200 only once stored', async () => {
    const s = setup({}, { storage: makeStorage({ latencyMs: 15 }) });
    await s.nango.connectLink(UID, 'x');
    const token = mock.lastSession() && [...mock.sessions.keys()].at(-1);
    const sent = await mock.complete(token);
    s.storage.fail.put = 'UNAVAILABLE';
    const failed = await s.deliver(sent);
    expect(failed.status).toBe(500);
    expect(s.doc().platforms.x).toBeUndefined();
    s.storage.fail.put = null;
    const ok = await s.deliver(sent);
    expect(ok.status).toBe(200);
    // the reply came after the write
    expect(s.doc().platforms.x.connectionId).toBe(sent.body.connectionId);
    await ok.after;
  });

  it('handles a version conflict by reading again (ifVersion)', async () => {
    const s = setup();
    await s.nango.connectLink(UID, 'x');
    const sent = await mock.complete([...mock.sessions.keys()].at(-1));
    let once = true;
    s.storage.fail.put = (key) => {
      if (once && key.startsWith('nango:user:')) {
        once = false;
        return 'CONFLICT';
      }
      return null;
    };
    const r = await s.deliver(sent);
    expect(r.status).toBe(200);
    expect(s.doc().platforms.x.connectionId).toBe(sent.body.connectionId);
    await r.after;
  });
});

describe('status', () => {
  it('shows every platform; phase 2 ones as coming soon; Facebook after 50 days expires soon', async () => {
    const s = setup();
    await s.connect(UID, 'facebook');
    const all = await s.nango.status(UID);
    expect(all.map((x) => x.platform)).toHaveLength(12);
    expect(all.find((x) => x.platform === 'pinterest').state).toBe('coming_soon');
    expect(all.find((x) => x.platform === 'linkedin').state).toBe('not_connected');
    s.clock.t += 51 * DAY;
    expect((await s.status('facebook')).expiresSoon).toBe(true);
  });

  it('keeps users apart', async () => {
    const s = setup();
    await s.connect(UID, 'x');
    expect((await s.status('x', UID2)).state).toBe('not_connected');
    await expect(s.nango.request(UID2, 'x', { method: 'GET', path: '/2/users/me' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    // A's account handles mean nothing for B
    await s.connect(UID2, 'x');
    const aTargets = await s.nango.targets(UID, 'x');
    await expect(s.nango.setTarget(UID2, 'x', aTargets[0].id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the proxy', () => {
  it('fills {target} and {ig_user}, prefixes provider headers, never sends Retries or the key elsewhere', async () => {
    const s = setup();
    await s.connect(UID, 'facebook');
    const [first] = await s.nango.targets(UID, 'facebook');
    await s.nango.setTarget(UID, 'facebook', first.id);
    mock.on('POST', '/v26.0/17841400000000001/media', { status: 200, body: { id: 'container-1' } });
    mock.on('GET', '/rest/organizationalEntityShareStatistics', { body: { elements: [] } });
    const r = await s.nango.request(UID, 'instagram', { method: 'POST', path: '/v26.0/{ig_user}/media', body: { image_url: 'https://app.example/api/media/public/x', caption: 'Hi', page: '{target}' }, oneShot: true });
    expect(r).toMatchObject({ status: 200, body: { id: 'container-1' } });
    const call = mock.proxyCalls().at(-1);
    expect(call.path).toBe('/v26.0/17841400000000001/media');
    expect(JSON.parse(call.body).page).toBe('111222333');
    expect(call.headers['provider-config-key']).toBe('ylb-facebook');
    expect(call.headers.retries).toBeUndefined();
    expect(call.headers['retry-on']).toBeUndefined();
    expect(mock.calls.some((c) => c.headers.retries !== undefined)).toBe(false);
    expect(mock.violations).toEqual([]);
  });

  it('refuses an Authorization header (derived tokens never go through the proxy) and secrets in the query', async () => {
    const s = setup();
    await s.connect(UID, 'x');
    await expect(s.nango.request(UID, 'x', { method: 'GET', path: '/2/users/me', headers: { Authorization: 'Bearer page-token' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(s.nango.request(UID, 'x', { method: 'GET', path: '/2/users/me', headers: { 'Nango-Proxy-Authorization': 'Bearer t' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(s.nango.request(UID, 'x', { method: 'GET', path: '/2/users/me', headers: { Retries: '3' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(s.nango.request(UID, 'x', { method: 'GET', path: '/2/users/me', query: { access_token: 'abc' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(s.nango.request(UID, 'x', { method: 'GET', path: '/../connections' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mock.violations).toEqual([]);
  });

  it('asks the user to choose an account when a path needs one', async () => {
    const s = setup();
    await s.connect(UID, 'facebook');
    await expect(s.nango.request(UID, 'facebook', { method: 'GET', path: '/v26.0/{target}', query: { fields: 'access_token' } })).rejects.toMatchObject({ status: 409, code: 'NOT_CONNECTED' });
  });

  it('a read repeats once after a 429 (waiting Retry-After); a write never does', async () => {
    const s = setup();
    await s.connect(UID, 'x');
    mock.fail('/2/users/me', 429, { times: 1, headers: { 'retry-after': '7' } });
    const r = await s.nango.request(UID, 'x', { method: 'GET', path: '/2/users/me', oneShot: false, baseUrlOverride: 'https://api.x.com' });
    expect(r.status).toBe(200);
    expect(s.slept).toEqual([7000]);
    mock.on('POST', '/2/tweets', { status: 201, body: { data: { id: '1' } } });
    mock.fail('/2/tweets', 429, { times: 1, headers: { 'retry-after': '1' } });
    const w = await s.nango.request(UID, 'x', { method: 'POST', path: '/2/tweets', body: { text: 'hi' }, oneShot: true });
    expect(w.status).toBe(429);
    expect(mock.proxyCalls().filter((c) => c.path === '/2/tweets')).toHaveLength(1);
    // a read whose Retry-After is over 60 s is not repeated
    mock.fail('/2/users/me', 429, { times: 2, headers: { 'retry-after': '120' } });
    expect((await s.nango.request(UID, 'x', { method: 'GET', path: '/2/users/me', oneShot: false })).status).toBe(429);
  });

  it('a write that times out throws (the caller records unknown) and is sent once', async () => {
    const s = setup();
    await s.connect(UID, 'x');
    mock.fail('/2/tweets', 0, { delayMs: 300 });
    mock.on('POST', '/2/tweets', { status: 201, body: {} });
    await expect(s.nango.request(UID, 'x', { method: 'POST', path: '/2/tweets', body: { text: 'x' }, oneShot: true, timeoutMs: 50 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(mock.proxyCalls().filter((c) => c.path === '/2/tweets')).toHaveLength(1);
  });

  it('maps Nango’s own errors: server_error → needs reconnect, plan_limit → unavailable, unknown_provider_config → not set up', async () => {
    const s = setup();
    await s.connect(UID, 'youtube');
    mock.fail('/youtube/v3/channels', 402, { body: { error: { code: 'plan_limit', message: 'cap' } } });
    await expect(s.nango.request(UID, 'youtube', { method: 'GET', path: '/youtube/v3/channels' })).rejects.toMatchObject({ code: 'CONNECTIONS_UNAVAILABLE' });
    mock.fail('/youtube/v3/channels', 404, { body: { error: { code: 'unknown_provider_config' } } });
    await expect(s.nango.request(UID, 'youtube', { method: 'GET', path: '/youtube/v3/channels' })).rejects.toMatchObject({ code: 'NOT_SET_UP' });
    // a provider's own 404 passes through unchanged
    mock.fail('/youtube/v3/channels', 404, { body: { error: { code: 404, message: 'Not found' } } });
    expect((await s.nango.request(UID, 'youtube', { method: 'GET', path: '/youtube/v3/channels' })).status).toBe(404);
    mock.fail('/youtube/v3/channels', 400, { body: { error: { code: 'server_error', message: 'refresh failed' } } });
    await expect(s.nango.request(UID, 'youtube', { method: 'GET', path: '/youtube/v3/channels' })).rejects.toMatchObject({ code: 'NEEDS_RECONNECT' });
    expect((await s.status('youtube')).state).toBe('needs_reconnect');
    await expect(s.nango.request(UID, 'youtube', { method: 'GET', path: '/youtube/v3/channels' })).rejects.toMatchObject({ code: 'NEEDS_RECONNECT' });
  });

  it('writes a ledger row per request: vendor nango, cost 0, the path template (no ids), bytes', async () => {
    const s = setup();
    await s.connect(UID, 'facebook');
    const [first] = await s.nango.targets(UID, 'facebook');
    await s.nango.setTarget(UID, 'facebook', first.id);
    mock.on('GET', '/v26.0/111222333', { body: { id: '111222333' } });
    await s.nango.request(UID, 'facebook', { method: 'GET', path: '/v26.0/{target}', query: { fields: 'name' }, feature: 'social', projectId: 'p1' });
    const row = s.db.rows('usage_ledger').at(-1);
    expect(row).toMatchObject({ vendor: 'nango', cost_micro: 0, estimated: false, feature: 'social', project_id: 'p1', endpoint: 'facebook:GET /v26.0/{target}', http_status: 200, outcome: 'ok', user_id: UID });
    expect(row.customer_tag).toMatch(/^cust_[0-9a-f]{24}$/);
    expect(row.bytes).toBeGreaterThan(0);
  });
});

describe('check, disconnect, forget', () => {
  it('check: 404 → not connected, 424 → reconnect, 200 → connected again', async () => {
    const s = setup();
    const { connectionId } = await s.connect(UID, 'google_ads');
    mock.connections.get(connectionId).broken = true;
    expect((await s.nango.check(UID, 'google_ads')).state).toBe('needs_reconnect');
    mock.connections.get(connectionId).broken = false;
    expect((await s.nango.check(UID, 'google_ads')).state).toBe('connected');
    mock.connections.delete(connectionId);
    expect((await s.nango.check(UID, 'google_ads')).state).toBe('not_connected');
    expect(s.doc().platforms.google_ads).toBeUndefined();
  });

  it('disconnect removes the entry first, then deletes once at Nango (a 404 is fine)', async () => {
    const s = setup();
    const { connectionId } = await s.connect(UID, 'meta_ads');
    mock.connections.delete(connectionId);
    await s.nango.disconnect(UID, 'meta_ads');
    expect(s.doc().platforms.meta_ads).toBeUndefined();
    expect(mock.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    await expect(s.nango.disconnect(UID, 'instagram')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('forgetUser deletes each connection once (a failure is logged, not retried), then the doc; new creations go too', async () => {
    const s = setup();
    const fb = await s.connect(UID, 'facebook');
    const x = await s.connect(UID, 'x');
    mock.fail(`/connections/${encodeURIComponent(x.connectionId)}`, 500, { times: 5 });
    const before = mock.calls.filter((c) => c.method === 'DELETE').length;
    await s.nango.forgetUser(UID);
    const deletes = mock.calls.filter((c) => c.method === 'DELETE').slice(before);
    expect(deletes.map((c) => c.path).sort()).toEqual([`/connections/${fb.connectionId}`, `/connections/${x.connectionId}`].sort());
    expect(s.log.events('nango_forget_delete_failed')).toHaveLength(1);
    expect(s.doc().platforms).toEqual({});
    expect(s.doc().forgottenAt).toBeTruthy();
    expect(await s.nango.status(UID)).toSatisfy((list) => list.every((c) => c.state !== 'connected'));
    // a creation arriving meanwhile is removed at Nango, not stored
    const tag = customerTag(UID, { CUSTOMER_TAG_SECRET: TAG_SECRET });
    mock.connections.set('late-1', { id: 'late-1', providerConfigKey: 'ylb-youtube', tags: {} });
    const r = await s.event({ type: 'auth', operation: 'creation', success: true, connectionId: 'late-1', providerConfigKey: 'ylb-youtube', tags: { end_user_id: tag } });
    await r.after;
    expect(s.doc().platforms.youtube).toBeUndefined();
    expect(mock.connections.has('late-1')).toBe(false);
    await expect(s.nango.connectLink(UID, 'x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // the deletion didn't happen: connecting works again
    await s.nango.unforgetUser(UID);
    await expect(s.nango.connectLink(UID, 'x')).resolves.toHaveProperty('connectLink');
  });
});

describe('the interface', () => {
  it('fits createConnections (every method) and credentials stay limited to the two direct platforms', async () => {
    const s = setup();
    const c = createConnections(s.nango);
    expect(c.enabled).toBe(true);
    expect(c.setUp).toBe(true);
    await expect(c.credentials(UID, 'facebook')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.credentials(UID, 'tiktok_ads')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});

describe('monthly estimates', () => {
  it('adds one prorated connection row per customer for last month, once', async () => {
    const s = setup();
    s.clock.t = Date.UTC(2026, 9, 16); // connected mid-October
    await s.connect(UID, 'x');
    s.clock.t = Date.UTC(2026, 10, 2);
    const r = await s.nango.meterIfDue();
    expect(r.rows).toBeGreaterThanOrEqual(1);
    const row = s.db.rows('usage_ledger').find((x) => x.endpoint === 'nango_connection 2026-10');
    expect(row).toMatchObject({ vendor: 'nango', estimated: true, feature: 'connections' });
    expect(row.cost_micro).toBe(Math.round((290000 * 16) / 31));
    expect(await s.nango.meterIfDue()).toEqual({ skipped: true });
  });
});
