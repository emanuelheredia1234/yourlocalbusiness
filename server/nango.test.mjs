// Nango kept for future non-social integrations (server/nango.mjs + server/connections/nangoRoutes.mjs), against
// server/test/mock-nango.mjs: off unless NANGO_SECRET_KEY is set; no social, ads or Search Console provider is ever
// accepted; connect sessions tagged with the customer tag only; signed webhooks; and the key never in a log.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNango, integrationsFrom, nullNango } from './nango.mjs';
import { createNangoRoutes } from './connections/nangoRoutes.mjs';
import { customerTag } from './integrations/common.mjs';
import { createMockNango, signWebhook, TEST_NANGO_KEY, TEST_SIGNING_KEY } from './test/mock-nango.mjs';
import { makeDb, makeLog, makeStorage } from './test/fakes.mjs';
import { call } from './analytics/test-helpers.mjs';

const ALICE = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';
const TAG_SECRET = 'test-customer-tag-secret-0123456789';
const INTEGRATIONS = JSON.stringify({ calendly: { id: 'ylb-calendly', label: 'Calendly', category: 'booking' }, hubspot: 'ylb-hubspot' });

let mock;
beforeAll(async () => {
  mock = await createMockNango().start();
});
afterAll(async () => {
  await mock.close();
});

function setup(extra = {}) {
  const storage = makeStorage();
  const db = makeDb();
  const log = makeLog();
  const env = { NANGO_SECRET_KEY: TEST_NANGO_KEY, NANGO_WEBHOOK_SIGNING_KEY: TEST_SIGNING_KEY, NANGO_BASE_URL: mock.base, CUSTOMER_TAG_SECRET: TAG_SECRET, NANGO_INTEGRATIONS: INTEGRATIONS, ...extra };
  return { nango: createNango({ env, storage, db, log }), storage, db, log, env };
}

describe('which integrations Nango may hold', () => {
  it('none by default, and never a social network, an ad platform or Search Console', () => {
    expect(integrationsFrom({})).toEqual({});
    const log = makeLog();
    const got = integrationsFrom({ NANGO_INTEGRATIONS: JSON.stringify({ calendly: 'ylb-calendly', facebook: 'ylb-facebook', meta_ads: 'ylb-meta', crm: 'ylb-google-ads', gsc: 'ylb-gsc', tiktok_shop: 'x', booking: 'ylb-instagram-booking' }) }, log);
    expect(Object.keys(got)).toEqual(['calendly']);
    expect(log.events('nango_integration_refused').length).toBe(6);
  });

  it('is off without NANGO_SECRET_KEY: the list is empty and the routes say so', async () => {
    const routes = createNangoRoutes({ auth: { enabled: true, identify: async () => ({ id: ALICE }) }, nango: nullNango, send: (res, status, body) => (res.writeHead(status), res.end(JSON.stringify(body))) });
    const list = await call(routes, 'GET', '/api/integrations/nango', { token: 'a' });
    expect(list.body).toEqual({ enabled: false, setUp: false, integrations: [] });
    expect((await call(routes, 'POST', '/api/integrations/nango/calendly/connect', { token: 'a', body: {} })).status).toBe(503);
    expect((await call(routes, 'POST', '/api/webhooks/nango', { body: {} })).status).toBe(503);
  });
});

describe('connecting a future integration', () => {
  it('starts a connect session tagged with the customer tag only, and lists the integration as pending', async () => {
    const t = setup();
    const before = mock.calls.length;
    const link = await t.nango.connectLink(ALICE, 'calendly');
    expect(link.connectLink).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/connect\?session_token=/);
    const sent = mock.calls.slice(before).find((c) => c.path === '/connect/sessions');
    expect(sent.body).toEqual({ tags: { end_user_id: customerTag(ALICE, t.env), organization_id: customerTag(ALICE, t.env) }, allowed_integrations: ['ylb-calendly'] });
    const list = await t.nango.list(ALICE);
    expect(list.find((i) => i.key === 'calendly')).toMatchObject({ label: 'Calendly', category: 'booking', state: 'pending' });
    expect(t.log.text()).not.toContain(TEST_NANGO_KEY);
    expect(t.log.text()).not.toContain(link.connectLink);
  });

  it('a signed creation webhook connects it; a bad signature is refused; deletion removes it', async () => {
    const t = setup();
    await t.nango.connectLink(ALICE, 'calendly');
    const tag = customerTag(ALICE, t.env);
    await t.db.insert('billing_customers', { customer_tag: tag, user_id: ALICE }, { ignoreDuplicates: true });
    const raw = Buffer.from(JSON.stringify({ type: 'auth', operation: 'creation', success: true, connectionId: 'conn-1', providerConfigKey: 'ylb-calendly', tags: { end_user_id: tag } }));
    expect((await t.nango.webhook(raw, { 'x-nango-hmac-sha256': 'f'.repeat(64) })).status).toBe(401);
    expect((await t.nango.webhook(raw, { 'x-nango-hmac-sha256': signWebhook(raw) })).status).toBe(200);
    expect((await t.nango.list(ALICE)).find((i) => i.key === 'calendly').state).toBe('connected');
    const del = Buffer.from(JSON.stringify({ type: 'auth', operation: 'deletion', success: true, connectionId: 'conn-1', providerConfigKey: 'ylb-calendly', tags: { end_user_id: tag } }));
    await t.nango.webhook(del, { 'x-nango-hmac-sha256': signWebhook(del) });
    expect((await t.nango.list(ALICE)).find((i) => i.key === 'calendly').state).toBe('not_connected');
  });

  it('ignores a webhook for a provider that isn’t listed (e.g. a social one someone added in Nango)', async () => {
    const t = setup();
    const raw = Buffer.from(JSON.stringify({ type: 'auth', operation: 'creation', success: true, connectionId: 'conn-9', providerConfigKey: 'ylb-facebook', tags: { end_user_id: customerTag(ALICE, t.env) } }));
    const before = t.db.calls.length;
    expect((await t.nango.webhook(raw, { 'x-nango-hmac-sha256': signWebhook(raw) })).status).toBe(200);
    expect(t.db.calls.length).toBe(before);
  });

  it('refuses an unknown integration key', async () => {
    const t = setup();
    await expect(t.nango.connectLink(ALICE, 'facebook')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
