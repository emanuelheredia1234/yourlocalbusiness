// The Zernio ads module (server/ads/zernioAds.mjs, spec §4) against the mock (server/test/mock-zernio.mjs +
// mock-zernio-ads.mjs): one attempt per write, the outcome for every status class, the owner's problems kept from the
// customer, a ledger row per call, the key only in the Authorization header, and nothing live (R10).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createZernioAds, codeForResponse, createIds } from './zernioAds.mjs';
import { createZernioClient } from '../zernio.mjs';
import { createMockZernio, TEST_ZERNIO_KEY } from '../test/mock-zernio.mjs';
import { assertLocalZernio } from '../test/mock-zernio-ads.mjs';
import { makeLog, makeStorage } from '../test/fakes.mjs';

let mock;
let meta;
let google;
beforeAll(async () => {
  mock = await createMockZernio().start();
  meta = mock.addAccount({ platform: 'metaads', profileId: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'acme' });
  google = mock.addAccount({ platform: 'googleads', profileId: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'acme' });
});
afterAll(async () => {
  await mock.close();
});

const CTX = { userId: '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11', tag: 'cust_aaaaaaaaaaaaaaaaaaaaaaaa', projectId: 'proj-1', platform: 'meta' };

function setup({ env = {}, timeouts = { create: 400, update: 400, creative: 400 }, clientOpts = {} } = {}) {
  const fullEnv = assertLocalZernio({ ZERNIO_API_KEY: TEST_ZERNIO_KEY, ZERNIO_BASE_URL: mock.apiBase, ZERNIO_RPM: '10000', ...env });
  const log = makeLog();
  const storage = makeStorage();
  const rows = [];
  const ledger = { write: async (r) => void rows.push(r) };
  const client = createZernioClient({ env: fullEnv, log, ...clientOpts });
  const calls = [];
  const spy = { ...client, enabled: client.enabled, call: (...a) => (calls.push(a), client.call(...a)) };
  const zads = createZernioAds({ client: spy, ledger, storage, log, timeouts });
  return { zads, rows, log, storage, calls, client };
}

let n = 0;
function metaBody(extra = {}) {
  n += 1;
  return {
    accountId: meta._id,
    adAccountId: 'act_1',
    name: `Test ${n} · Meta · YLB ${String(n).padStart(12, '0')}`,
    goal: 'traffic',
    budgetAmount: 25,
    budgetType: 'daily',
    endDate: '2026-12-14',
    status: 'PAUSED',
    campaignStatus: 'PAUSED',
    adSetStatus: 'ACTIVE',
    adStatus: 'ACTIVE',
    cities: [{ key: '2421836', radius: 10, distance_unit: 'mile' }],
    headline: 'Fresh bread',
    body: 'Baked this morning.',
    callToAction: 'LEARN_MORE',
    imageUrl: 'https://app.test/api/media/public/x.jpg',
    linkUrl: 'https://acme.example/',
    creativeFeatures: { text_optimizations: 'OPT_OUT' },
    ...extra,
  };
}
const key = () => crypto.randomUUID();
const violations = () => mock.violations.filter((v) => v.kind !== 'repeated_write');

describe('writes: one attempt, outcome per status class', () => {
  it('2xx → ok with the ids (single and creatives[] shapes)', async () => {
    const t = setup();
    const r = await t.zads.writes.createAd(metaBody(), key(), CTX);
    expect(r.outcome).toBe('ok');
    const ids = createIds(r.body);
    expect(ids.campaignId).toMatch(/^\d+$/);
    expect(ids.adSetId).toMatch(/^\d+$/);
    expect(ids.zernioAdIds).toHaveLength(1);
    const multi = await t.zads.writes.createAd(metaBody({ headline: undefined, body: undefined, imageUrl: undefined, callToAction: undefined, linkUrl: undefined, creatives: ['A', 'B'].map((v) => ({ name: v, headline: `H ${v}`, body: 'b', callToAction: 'LEARN_MORE', imageUrl: 'https://app.test/x.jpg', linkUrl: 'https://acme.example/' })) }), key(), CTX);
    expect(createIds(multi.body).zernioAdIds).toHaveLength(2);
    expect(violations()).toEqual([]);
  });

  it('a Meta activation_failed warning is ok with a flag, never parsed for text', async () => {
    const t = setup();
    mock.ads.fail('POST /ads/create', '201-activation-failed');
    const r = await t.zads.writes.createAd(metaBody(), key(), CTX);
    expect(r).toMatchObject({ outcome: 'ok', activationFailed: true });
    expect(JSON.stringify({ ...r, body: undefined })).not.toContain('SECRET');
  });

  it.each([
    ['422-budget-too-low', 'failed', 'BUDGET_TOO_LOW'],
    ['403-payment', 'failed', 'PAYMENT_REQUIRED'],
    ['401-reconnect', 'failed', 'RECONNECT'],
    ['meta-code-31', 'failed', 'SECURITY_CHECK'],
    ['429-ad-account-busy', 'failed', 'AD_ACCOUNT_BUSY'],
    ['422-key-mismatch', 'failed', 'IDEMPOTENCY_MISMATCH'],
    ['409-idempotency', 'unknown', 'UNKNOWN'],
    ['500', 'unknown', 'UNKNOWN'],
    ['502', 'unknown', 'UNKNOWN'],
  ])('%s → %s %s', async (mode, outcome, code) => {
    const t = setup();
    mock.ads.fail('POST /ads/create', mode);
    const before = mock.calls.length;
    const r = await t.zads.writes.createAd(metaBody(), key(), CTX);
    expect(r).toMatchObject({ outcome, code });
    // exactly one request reached the mock: no retry, even after a 429 or a 5xx
    expect(mock.calls.slice(before).filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|mock |platformError|hint/);
    if (r.fixUrl) expect(r.fixUrl).toMatch(/^https:\/\/(business\.)?facebook\.com\//);
  });

  it('a timeout is unknown (it may have happened), and nothing is sent again', async () => {
    const t = setup();
    mock.ads.fail('POST /ads/create', 'timeout');
    const before = mock.calls.length;
    const r = await t.zads.writes.createAd(metaBody(), key(), CTX);
    expect(r).toMatchObject({ outcome: 'unknown', code: 'UNKNOWN', sent: true });
    await new Promise((res) => setTimeout(res, 50));
    expect(mock.calls.slice(before).filter((c) => c.method === 'POST')).toHaveLength(1);
    mock.ads.release();
  });

  it('a failed create that lists what it left behind is a definite failure; an unconfirmed write stays unknown', async () => {
    const t = setup();
    mock.ads.fail('POST /ads/create', '503-left-behind');
    const a = await t.zads.writes.createAd(metaBody(), key(), CTX);
    expect(a).toMatchObject({ outcome: 'failed', code: 'PARTIAL_LEFT' });
    expect(a.createdObjects).toEqual([expect.objectContaining({ type: 'campaign', cleanup: 'left_behind' })]);
    mock.ads.fail('POST /ads/create', '502-unconfirmed');
    const b = await t.zads.writes.createAd(metaBody(), key(), CTX);
    expect(b).toMatchObject({ outcome: 'unknown' });
    expect(b.unconfirmedWrite).toMatchObject({ type: 'ad' });
  });

  it('the owner’s problems are ADS_UNAVAILABLE for the customer, with an owner alert', async () => {
    for (const mode of ['402-payment', '403-ads-allowance', '401-key']) {
      const t = setup();
      mock.ads.fail('POST /ads/create', mode);
      const r = await t.zads.writes.createAd(metaBody(), key(), CTX);
      expect(r).toMatchObject({ outcome: 'failed', code: 'ADS_UNAVAILABLE' });
      await new Promise((res) => setTimeout(res, 5));
      expect(t.storage.documents.get('zernio:alert')?.value?.kind).toBeTruthy();
      expect(t.log.events('zernio_owner_alert')).toHaveLength(1);
    }
  });

  it('no key: failed ADS_UNAVAILABLE and nothing is sent (never unknown)', async () => {
    const t = setup({ env: { ZERNIO_API_KEY: '' } });
    const before = mock.calls.length;
    const r = await t.zads.writes.setCampaignStatus('123456', 'meta', 'paused', CTX);
    expect(r).toMatchObject({ outcome: 'failed', code: 'ADS_UNAVAILABLE', sent: false });
    expect(mock.calls.length).toBe(before);
    // a client that is on but throws not_set_up mid-call says the same
    const z = createZernioAds({ client: { enabled: true, call: async () => { const { ZernioCallError } = await import('../zernio.mjs'); throw new ZernioCallError('not_set_up'); } } });
    expect(await z.writes.setCampaignStatus('123456', 'meta', 'paused', CTX)).toMatchObject({ outcome: 'failed', code: 'ADS_UNAVAILABLE' });
  });

  it('shares the one ZERNIO_RPM window: a write with no slot is failed RATE_LIMITED and nothing is sent', async () => {
    let clock = 5_000_000;
    const t = setup({ env: { ZERNIO_RPM: '1' }, clientOpts: { now: () => clock, sleep: async (ms) => void (clock += ms) } });
    expect((await t.zads.reads.listAdAccounts(meta._id, CTX)).ok).toBe(true);
    const before = mock.calls.length;
    const r = await t.zads.writes.setCampaignStatus('123456', 'meta', 'paused', CTX);
    expect(r).toMatchObject({ outcome: 'failed', code: 'RATE_LIMITED', sent: false });
    expect(mock.calls.length).toBe(before);
  });

  it('writes never ask the client to retry a 429', async () => {
    const t = setup();
    await t.zads.writes.setCampaignStatus('123456', 'meta', 'paused', CTX);
    await t.zads.writes.createAd(metaBody(), key(), CTX);
    for (const [method, , opts] of t.calls) if (method !== 'GET') expect(opts.retry429).toBeFalsy();
  });

  it('refuses amounts that aren’t whole numbers and end dates without an offset, before sending', async () => {
    const t = setup();
    const before = mock.calls.length;
    expect(() => t.zads.writes.setCampaignSpendCap('123456', 0, CTX)).toThrow();
    expect(() => t.zads.writes.setCampaignSpendCap('123456', 12.5, CTX)).toThrow();
    expect(() => t.zads.writes.setAdSetBudget('123456', null, CTX)).toThrow();
    expect(() => t.zads.writes.setAdSetEndDate('123456', '2026-12-14', CTX)).toThrow();
    expect(() => t.zads.writes.setCampaignStatus('../x', 'meta', 'paused', CTX)).toThrow();
    expect(mock.calls.length).toBe(before);
  });
});

describe('ledger, key and logs', () => {
  it('writes one ledger row per call: vendor zernio, feature ads, cost 0, estimated false, no ids in the endpoint', async () => {
    const t = setup();
    await t.zads.reads.liveEntities(meta._id, 'act_1', CTX);
    await t.zads.writes.setCampaignStatus('999999999', 'meta', 'paused', CTX);
    const k = key();
    await t.zads.writes.createAd(metaBody(), k, CTX);
    expect(t.rows).toHaveLength(3);
    for (const r of t.rows) {
      expect(r).toMatchObject({ vendor: 'zernio', feature: 'ads', cost_micro: 0, estimated: false, customer_tag: CTX.tag, user_id: CTX.userId, project_id: 'proj-1' });
      expect(r.endpoint).not.toMatch(/\d{6,}|[0-9a-f]{24}/);
    }
    expect(t.rows.map((r) => r.endpoint)).toEqual(['meta_ads:GET /ads/accounts/live', 'meta_ads:PUT /ads/campaigns/:id/status', 'meta_ads:POST /ads/create']);
    expect(t.rows[2].idempotency_key).toBe(k);
  });

  it('sends the key only in the Authorization header and never logs it, a body or ad copy', async () => {
    const t = setup();
    const before = mock.calls.length;
    await t.zads.writes.createAd(metaBody({ headline: 'Unique headline 8812' }), key(), CTX);
    const call = mock.calls[before];
    expect(call.auth).toBe('bearer');
    expect(JSON.stringify(call.query)).not.toContain(TEST_ZERNIO_KEY);
    expect(call.idempotencyKey).toBeTruthy();
    expect(t.log.text()).not.toContain(TEST_ZERNIO_KEY);
    expect(t.log.text()).not.toContain('Unique headline 8812');
  });
});

describe('reads', () => {
  it('reads accounts/live in whole units with readAt; Google has no live read', async () => {
    const t = setup();
    const live = await t.zads.reads.liveEntities(meta._id, 'act_1', CTX);
    expect(live.ok).toBe(true);
    expect(typeof live.body.readAt).toBe('string');
    const g = await t.zads.reads.liveEntities(google._id, '1234567890', { ...CTX, platform: 'google' });
    expect(g).toMatchObject({ ok: false });
  });

  it('maps a refused read to our code, never Zernio’s text', async () => {
    const t = setup();
    mock.ads.fail('GET /ads/accounts', '401-key');
    const r = await t.zads.reads.listAdAccounts(meta._id, CTX);
    expect(r).toMatchObject({ ok: false, code: 'ADS_UNAVAILABLE' });
    expect(JSON.stringify(r)).not.toContain('mock');
  });

  it('codeForResponse reads only machine fields', () => {
    expect(codeForResponse({ status: 409, body: { code: 'shared_budget', error: 'x' } })).toBe('SHARED_BUDGET');
    expect(codeForResponse({ status: 409, body: { code: 'BUDGET_LEVEL_MISMATCH' } })).toBe('BUDGET_LEVEL');
    expect(codeForResponse({ status: 400, body: { code: 'whatever', platformError: { error_subcode: 324 } } })).toBe('IMAGE_UNREACHABLE');
    expect(codeForResponse({ status: 404, body: {} })).toBe('NOT_FOUND_REMOTE');
    expect(codeForResponse({ status: 400, body: { code: 'new_code' } })).toBe('REFUSED');
  });
});

describe('R10: no live calls in tests', () => {
  it('a base URL that isn’t local throws in the test setup', () => {
    expect(() => assertLocalZernio({ ZERNIO_BASE_URL: 'https://zernio.com/api/v1' })).toThrow(/local mock/);
    expect(() => assertLocalZernio({})).toThrow();
    expect(assertLocalZernio({ ZERNIO_BASE_URL: mock.apiBase }).ZERNIO_BASE_URL).toBe(mock.apiBase);
  });
});
