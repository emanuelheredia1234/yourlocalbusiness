// The treg wrapper (spec §1.4, §9.2 WP3) against mock-treg and mock Supabase: headers, tags, price ceilings,
// the ledger row on every answer, idempotent replays, timeouts, pending answers, every error kind, caps.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { createTreg, TregError, tregErrorKind, tregErrorToApi, TREG_ERROR_KINDS } from './treg.mjs';
import { TREG_ENDPOINTS, endpointLabel, tregEndpoint } from './treg-endpoints.mjs';
import { createMockTreg, FAKE_TOPUP_URL, MOCK_TREG, parseMeta } from './test/mock-treg.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';
import { createDb } from './integrations/db.mjs';
import { customerTag, errorBody } from './integrations/common.mjs';
import { createLedger } from './billing/ledger.mjs';

const SECRET = 'test-customer-tag-secret-0123456789';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

let supa;
let mock;
let db;

/** An in-memory appState (get/put with the same shapes as server/appState.mjs). */
function memoryStorage() {
  const docs = new Map();
  return {
    enabled: true,
    docs,
    async get(key) {
      return docs.has(key) ? { value: docs.get(key), updatedAt: 't' } : null;
    },
    async put(key, value) {
      docs.set(key, structuredClone(value));
      return 't';
    },
  };
}

function setup(extra = {}) {
  const env = { TREG_TOKEN: MOCK_TREG.token, TREG_ADMIN_TOKEN: MOCK_TREG.adminToken, TREG_ORG_ID: MOCK_TREG.org, TREG_BASE_URL: mock.url, CUSTOMER_TAG_SECRET: SECRET, ...(extra.env ?? {}) };
  const log = { log: vi.fn() };
  const storage = memoryStorage();
  const treg = createTreg({ env, db, log, storage, replayDelayMs: 50, ...extra.opts });
  return { treg, env, log, storage, tag: customerTag(U1, env) };
}

const ctx = (over = {}) => ({ userId: U1, projectId: 'proj-1', feature: 'social', runId: crypto.randomUUID(), ...over });
const key = () => `run:${crypto.randomUUID()}`;
const ledgerRows = async (tag) => db.select('usage_ledger', tag ? { customer_tag: tag } : {}, { order: 'id.asc' });
const callsTo = (endpointId) => mock.calls.filter((c) => c.path === `/call/${endpointId}`);

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  mock = await createMockTreg().start();
});
afterAll(async () => {
  await mock?.close();
  await supa?.close();
});
beforeEach(() => {
  mock.reset();
  supa.tables.set('usage_ledger', []);
  supa.tables.set('billing_caps', []);
});

describe('the endpoint table', () => {
  it('names every endpoint plainly and finds it by key or treg id', () => {
    for (const [k, e] of Object.entries(TREG_ENDPOINTS)) {
      expect(e.label, k).toMatch(/^[A-Z]/);
      expect(tregEndpoint(k).endpointId).toBe(e.endpointId);
      expect(tregEndpoint(e.endpointId).key).toBe(k);
    }
    expect(tregEndpoint('treg.something.else')).toBeNull();
    expect(endpointLabel('treg.instagram.user.profile')).toBe('Instagram profile');
    expect(endpointLabel('facebook:GET /v26.0/{id}/insights', 'nango')).toBe('Facebook (your account)');
    expect(endpointLabel('x:POST /2/tweets', 'x')).toBe('X post');
  });
});

describe('a call', () => {
  it('sends the member token in X-Treg-Token only, the customer tags, the ceiling and the key; writes one ledger row', async () => {
    const { treg, tag } = setup();
    const k = key();
    const got = await treg.call('ig.profile', { body: { username: 'joesbakery' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: k, maxAgeS: 3600, preferProvider: 'crawl4ai' });
    expect(got.ok).toBe(true);
    expect(got.data.output.followers).toBeGreaterThan(0);
    expect(got.meta).toMatchObject({ costMicro: 1000, servedBy: 'crawl4ai.instagram.user.profile', cache: 'miss', replay: false });
    expect(got.meta.callId).toMatch(/^[0-9a-f]{32}$/);
    const [sent] = callsTo('treg.instagram.user.profile');
    expect(sent.method).toBe('POST');
    expect(sent.headers['x-treg-token']).toBe('[member-token]');
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers['x-treg-meta']).toMatch(/^customer=cust_[0-9a-f]{24}, feature=social, business=biz_[0-9a-f]{16}$/);
    expect(parseMeta(sent.headers['x-treg-meta']).customer).toBe(tag);
    expect(sent.headers['x-treg-route-max-cost']).toBe('0.01');
    expect(sent.headers['idempotency-key']).toBe(k);
    expect(sent.headers['x-treg-max-age']).toBe('3600');
    expect(sent.headers['x-treg-route-prefer']).toBe('crawl4ai');
    expect(JSON.parse(sent.body)).toEqual({ username: 'joesbakery' });
    const rows = await ledgerRows(tag);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customer_tag: tag, user_id: U1, project_id: 'proj-1', feature: 'social', vendor: 'treg', endpoint: 'treg.instagram.user.profile', call_id: got.meta.callId, cost_micro: 1000, cache: 'miss', served_by: 'crawl4ai.instagram.user.profile', http_status: 200, outcome: 'ok', idempotency_key: k });
  });

  it('sends GET params as a query string and no body', async () => {
    const { treg } = setup();
    await treg.call('serp.organic', { query: { q: 'bakery springfield', location: 'Springfield', num: 10 } }, ctx({ feature: 'seo' }), { maxCostUsd: 0.005, idempotencyKey: key() });
    const [sent] = callsTo('crawl4ai.google.serp.organic');
    expect(sent.method).toBe('GET');
    expect(sent.query).toEqual({ q: 'bakery springfield', location: 'Springfield', num: '10' });
    expect(sent.body).toBeUndefined();
  });

  it('refuses a metered call with no price ceiling, no key, no user or an unknown endpoint, before any request', async () => {
    const { treg } = setup();
    await expect(treg.call('ig.profile', { body: {} }, ctx(), { idempotencyKey: key() })).rejects.toMatchObject({ kind: 'config' });
    await expect(treg.call('ig.profile', { body: {} }, ctx(), { maxCostUsd: 0, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'config' });
    await expect(treg.call('ig.profile', { body: {} }, ctx(), { maxCostUsd: 0.01 })).rejects.toMatchObject({ kind: 'config' });
    await expect(treg.call('ig.profile', { body: {} }, ctx({ userId: 'not-a-user' }), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'config' });
    await expect(treg.call('ig.profile', { body: {} }, ctx({ feature: 'everything' }), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'config' });
    await expect(treg.call('openai.chat', {}, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'config' });
    const noToken = setup({ env: { TREG_TOKEN: '' } }).treg;
    await expect(noToken.call('ig.profile', { body: {} }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'config', hint: expect.stringMatching(/TREG_TOKEN/) });
    expect(mock.calls).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('sends no X-Treg-Route-Max-Cost for Search Console (the team’s own connection), even if one is passed', async () => {
    const { treg, tag } = setup();
    const got = await treg.call('gsc.sitemaps', { query: { siteUrl: 'https://yourlocalbusiness.replit.app/' } }, ctx({ feature: 'gsc' }), { maxCostUsd: 0.5, idempotencyKey: key() });
    expect(got.ok).toBe(true);
    const [sent] = callsTo('google-search-console.sitemaps');
    expect(sent.headers['x-treg-route-max-cost']).toBeUndefined();
    expect(sent.query.siteUrl).toBe('https://yourlocalbusiness.replit.app/');
    expect((await ledgerRows(tag))[0]).toMatchObject({ cost_micro: 0, outcome: 'ok', feature: 'gsc' });
  });

  it('never sends the admin token on /call/, even with it set', async () => {
    const { treg } = setup();
    for (const k of ['ig.profile', 'tt.profile', 'gsc.sites']) await treg.call(k, { body: {} }, ctx({ feature: k.startsWith('gsc') ? 'gsc' : 'social' }), { maxCostUsd: 0.01, idempotencyKey: key() });
    const onCall = mock.calls.filter((c) => c.path.startsWith('/call/'));
    expect(onCall).toHaveLength(3);
    for (const c of onCall) expect(c.headers['x-treg-token']).toBe('[member-token]');
    expect(mock.violations).toEqual([]);
    // and mock-treg itself refuses a /call/ with it, so a slip would fail loudly
    const wrong = setup({ env: { TREG_TOKEN: MOCK_TREG.adminToken } }).treg;
    await expect(wrong.call('ig.profile', { body: {} }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'config' });
  });

  it('checks the caps inside the customer’s 4 slots, so a burst can’t all pass the check on the same spend', async () => {
    // treg answers slowly, so no answer (and no ledger row) lands before the whole burst has been queued
    const slowFetch = async (...args) => {
      await new Promise((r) => setTimeout(r, 60));
      return fetch(...args);
    };
    const { treg } = setup({ opts: { fetch: slowFetch } });
    await db.insert('billing_caps', { customer_tag: '*', daily_cap_micro: 10_000_000, monthly_cap_micro: 10_000_000, calls_per_day: 2, status: 'active' });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => treg.call('ig.posts', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })));
    expect(callsTo('treg.instagram.user.posts').length).toBeLessThanOrEqual(4);
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason.kind === 'customer_cap')).toBe(true);
    expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThanOrEqual(6);
  });

  it('never sends a ceiling above the table’s, and only calls an endpoint the way the table says', async () => {
    const { treg } = setup();
    await treg.call('ig.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 5, idempotencyKey: key() });
    expect(callsTo('treg.instagram.user.profile')[0].headers['x-treg-route-max-cost']).toBe('0.01');
    await expect(treg.call('gsc.submit', { method: 'GET', query: { siteUrl: 'https://a/' } }, ctx({ feature: 'gsc' }), { idempotencyKey: key() })).rejects.toMatchObject({ kind: 'config' });
    await expect(treg.call('ig.profile', { method: 'DELETE' }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'config' });
    expect(callsTo('google-search-console.x.webmasters-sitemaps-submit')).toHaveLength(0);
  });

  it('keeps only a plain error code from treg’s refusal: its prose never reaches the alert, the ledger or the logs', async () => {
    const { treg, tag, storage, log } = setup();
    mock.fail('treg.x.user.profile', { status: 402, error: 'insufficient_balance' });
    await treg.call('x.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() }).catch(() => {});
    expect(storage.docs.get('treg:alert').kind).toBe('insufficient_balance');
    mock.fail('treg.x.user.profile', { status: 429, error: 'platform_daily_cap_reached Top up at https://evil.example now' });
    const err = await treg.call('x.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() }).catch((e) => e);
    expect(err.reason).toBeNull();
    const everything = JSON.stringify({ rows: await ledgerRows(tag), logs: log.log.mock.calls, alert: [...storage.docs.values()] });
    expect(everything).not.toMatch(/evil\.example|Top up/);
  });

  it('runs at most 4 calls at a time per customer', async () => {
    let inFlight = 0;
    let peak = 0;
    const slowFetch = async (...args) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 30));
        return await fetch(...args);
      } finally {
        inFlight -= 1;
      }
    };
    const { treg } = setup({ opts: { fetch: slowFetch } });
    await Promise.all(Array.from({ length: 10 }, () => treg.call('ig.posts', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })));
    expect(peak).toBe(4);
  });
});

describe('the ledger on replays, timeouts and pending answers', () => {
  it('a replay of an answer we already have costs 0', async () => {
    const { treg, tag } = setup();
    const k = key();
    await treg.call('ig.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: k });
    const again = await treg.call('ig.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: k });
    expect(again.meta.replay).toBe(true);
    expect((await ledgerRows(tag)).map((r) => r.cost_micro)).toEqual([1000, 0]);
  });

  it('a timeout on a read is asked once more with the same key; that replay records the original charge and call id [R F1]', async () => {
    const { treg, tag } = setup({ opts: { replayDelayMs: 200 } });
    mock.fail('treg.instagram.user.posts', { delayMs: 150 });
    const k = key();
    const got = await treg.call('ig.posts', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: k, timeoutMs: 60 });
    expect(got.ok).toBe(true);
    expect(got.meta.replay).toBe(true);
    const sent = callsTo('treg.instagram.user.posts');
    expect(sent).toHaveLength(2);
    expect(sent[1].headers['idempotency-key']).toBe(k);
    const rows = await ledgerRows(tag);
    expect(rows.map((r) => [r.outcome, r.cost_micro])).toEqual([
      ['timeout', 0],
      ['ok', 1000],
    ]);
    expect(rows[1].call_id).toBe(mock.ledger[0].callId);
  });

  it('a one-shot write (sitemap submit) that times out is never repeated', async () => {
    const { treg, tag } = setup();
    mock.fail('google-search-console.x.webmasters-sitemaps-submit', { delayMs: 150 });
    await expect(treg.call('gsc.submit', { query: { siteUrl: 'https://a/', feedpath: 'https://a/sitemap.xml' } }, ctx({ feature: 'gsc' }), { idempotencyKey: key(), timeoutMs: 60 })).rejects.toMatchObject({ kind: 'timeout' });
    await new Promise((r) => setTimeout(r, 200));
    expect(callsTo('google-search-console.x.webmasters-sitemaps-submit')).toHaveLength(1);
    expect((await ledgerRows(tag)).map((r) => r.outcome)).toEqual(['timeout']);
  });

  it('a second timeout gives up with kind timeout and two timeout rows', async () => {
    // a fetch that never answers: both attempts time out (the same key both times)
    const sent = [];
    const hanging = (url, init) => {
      sent.push(init.headers['idempotency-key']);
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    };
    const { treg, tag } = setup({ opts: { fetch: hanging } });
    const k = key();
    await expect(treg.call('tt.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: k, timeoutMs: 30 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(sent).toEqual([k, k]);
    expect((await ledgerRows(tag)).map((r) => [r.outcome, r.cost_micro])).toEqual([
      ['timeout', 0],
      ['timeout', 0],
    ]);
  });

  it('a repeat that finds the first call still running (409) is left for the billing job to settle by call id, not lost', async () => {
    const { treg, tag } = setup();
    mock.fail('treg.tiktok.user.profile', { delayMs: 300 });
    await expect(treg.call('tt.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key(), timeoutMs: 40 })).rejects.toMatchObject({ kind: 'in_progress' });
    await new Promise((r) => setTimeout(r, 350));
    const rows = await ledgerRows(tag);
    expect(rows.map((r) => r.outcome)).toEqual(['timeout', 'error:uncertain']);
    expect(rows[1].call_id).toBe(mock.ledger[0].callId);
    // the settle job then records treg's charge for it
    const { settlePending } = await import('./billing/reconcile.mjs');
    const { createTregAdmin } = await import('./billing/tregAdmin.mjs');
    const later = Date.now() + 5 * 60_000;
    const settled = await settlePending({ ledger: createLedger({ db }), admin: createTregAdmin({ env: setup().env }), now: () => later });
    expect(settled).toBe(1);
    const sum = (await ledgerRows(tag)).reduce((a, r) => a + Number(r.cost_micro), 0);
    expect(sum).toBe(mock.ledger[0].charged);
  });

  it('a 202 pending answer is returned as pending, recorded with the reserved amount, and not retried [R E5]', async () => {
    const { treg, tag } = setup();
    mock.fail('treg.facebook.user.posts', { pending: true });
    const got = await treg.call('fb.posts', { body: { url: 'https://facebook.com/joes' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() });
    expect(got).toMatchObject({ ok: false, pending: true, status: 202, data: null });
    expect(callsTo('treg.facebook.user.posts')).toHaveLength(1);
    const [row] = await ledgerRows(tag);
    expect(row).toMatchObject({ outcome: 'pending', cost_micro: 1000, call_id: got.meta.callId });
  });
});

describe('errors', () => {
  const cases = [
    [{ status: 402, error: 'insufficient_balance' }, 'team_unavailable', true],
    [{ status: 429, error: 'platform_daily_cap_reached' }, 'team_unavailable', true],
    [{ status: 429, error: 'trial_allowance_reached' }, 'team_unavailable', true],
    [{ status: 422, error: 'invalid_identity' }, 'not_found'],
    [{ status: 422, error: 'strict_filters_refused' }, 'not_found'],
    [{ status: 402, error: 'route_max_cost' }, 'too_expensive'],
    [{ status: 429, error: 'share_busy' }, 'busy'],
    [{ status: 429, error: 'provider_rate_limited' }, 'busy'],
    [{ status: 503, error: 'provider_capacity_unavailable' }, 'unavailable'],
    [{ status: 502, error: 'route_failed' }, 'unavailable'],
    [{ status: 409, error: 'idempotency_in_progress' }, 'in_progress'],
    [{ status: 410, error: 'idempotency_response_lost' }, 'uncertain'],
    [{ status: 422, error: 'bad_params' }, 'config'],
    [{ status: 400, error: 'choose an org' }, 'config'],
    [{ status: 403, error: 'capability_pinned' }, 'config'],
    [{ status: 401, error: 'unauthorized' }, 'config'],
    [{ status: 404, error: 'not_found', tregError: false }, 'bad_request'],
    [{ status: 500, error: 'oops', tregError: false }, 'upstream'],
  ];
  for (const [fault, kind, alert] of cases) {
    it(`${fault.status} ${fault.error}${fault.tregError === false ? ' (the provider’s)' : ''} → ${kind}, with a ledger row`, async () => {
      const { treg, tag, storage, log } = setup();
      mock.fail('treg.x.user.profile', fault);
      const err = await treg.call('x.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() }).catch((e) => e);
      expect(err).toBeInstanceOf(TregError);
      expect(err.kind).toBe(kind);
      expect(TREG_ERROR_KINDS).toContain(kind);
      const [row] = await ledgerRows(tag);
      expect(row).toMatchObject({ outcome: `error:${kind}`, http_status: fault.status, endpoint: 'treg.x.user.profile' });
      expect(storage.docs.has('treg:alert')).toBe(!!alert);
      if (alert) expect(Object.keys(storage.docs.get('treg:alert')).sort()).toEqual(['at', 'kind']);
      if (kind === 'not_found') expect(err.hint).toBeUndefined();
      // nothing of treg's body travels: no balance, no top-up link
      const everything = JSON.stringify({ err: { ...err, message: err.message }, api: errorBody(tregErrorToApi(err), { isAdmin: true }).body, rows: await ledgerRows(), logs: log.log.mock.calls, alert: storage.docs.get('treg:alert') });
      expect(everything).not.toMatch(/topup|balance_micro|estimated_cost_micro|secret-topup-link/);
      expect(everything).not.toContain(MOCK_TREG.token);
    });
  }

  it('a key reused for a different request (422) is our mistake: config with an admin hint, never left to settle as uncertain', async () => {
    const { treg, tag } = setup();
    const k = key();
    await treg.call('x.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: k });
    const err = await treg.call('x.profile', { body: { username: 'b' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: k }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'config', status: 422 });
    expect(tregErrorKind(422, 'idempotency_key_reused')).toBe('config');
    expect(tregErrorKind(410, 'idempotency_outcome_unknown')).toBe('uncertain');
    expect((await ledgerRows(tag)).map((r) => r.outcome)).toEqual(['ok', 'error:config']);
  });

  it('stores X-Treg-Call-Id only when it is a treg call id (32 hex), never other text from the answer', async () => {
    const odd = async (url, init) => {
      const res = await fetch(url, init);
      const headers = new Headers(res.headers);
      headers.set('x-treg-call-id', 'call id with spaces https://evil.example');
      return new Response(await res.text(), { status: res.status, headers });
    };
    const { treg, tag } = setup({ opts: { fetch: odd } });
    const out = await treg.call('x.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() });
    expect(out.meta.callId).toBeNull();
    expect((await ledgerRows(tag))[0].call_id).toBeNull();
    const plain = setup();
    const ok = await plain.treg.call('x.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() });
    expect(ok.meta.callId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('the X-Treg-Upstream-Failed header inside a 200 is upstream', async () => {
    const { treg } = setup();
    mock.fail('treg.x.user.profile', { upstreamFailed: true });
    await expect(treg.call('x.profile', { body: { username: 'a' } }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('maps a kind to what a route answers: blocked 403, cap 429 with period, the rest a generic 503', () => {
    expect(errorBody(tregErrorToApi(new TregError('customer_blocked'))).body).toMatchObject({ code: 'CUSTOMER_BLOCKED', error: 'Analytics are paused for your account. Contact support.' });
    expect(errorBody(tregErrorToApi(new TregError('customer_cap', 'x', { period: 'month' }))).body).toMatchObject({ code: 'CUSTOMER_CAP', period: 'month', error: 'You’ve reached this month’s analytics limit.' });
    expect(errorBody(tregErrorToApi(new TregError('customer_cap'))).body).toMatchObject({ code: 'CUSTOMER_CAP', period: 'day', error: expect.stringMatching(/midnight UTC/) });
    expect(errorBody(tregErrorToApi(new TregError('team_unavailable'))).body).toEqual({ code: 'UNAVAILABLE', error: 'Analytics are temporarily unavailable. Try again later.' });
    const cfg = tregErrorToApi(new TregError('config', 'x', { hint: 'Add TREG_TOKEN' }));
    expect(errorBody(cfg, null).body.hint).toBeUndefined();
    expect(errorBody(cfg, { isAdmin: true }).body.hint).toBe('Add TREG_TOKEN');
    expect(tregErrorKind(429, 'tag_spend_cap_reached')).toBe('customer_cap');
    expect(tregErrorKind(403, 'tag_blocked')).toBe('customer_blocked');
  });

  it('treg’s own customer cap and block come back as customer_cap (with period) and customer_blocked', async () => {
    const { treg, tag } = setup();
    mock.budgets.perTag.set(tag, { daily_cap_micro: 500 });
    await expect(treg.call('ig.profile', { body: {} }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'customer_cap', period: 'day' });
    mock.budgets.perTag.set(tag, { status: 'blocked' });
    await expect(treg.call('ig.profile', { body: {} }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'customer_blocked' });
  });
});

describe('the app-side cap check before a metered call', () => {
  const row = (over) => ({ customer_tag: over.tag, user_id: U1, feature: 'social', vendor: 'treg', endpoint: 'treg.instagram.user.profile', cost_micro: 0, outcome: 'ok', created_at: new Date().toISOString(), ...over, tag: undefined });

  it('blocks when today’s real treg spend plus the ceiling is over the cap, without calling treg', async () => {
    const { treg, tag } = setup();
    await db.insert('usage_ledger', row({ tag, cost_micro: 245_000 }));
    await expect(treg.call('ig.profile', { body: {} }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })).rejects.toMatchObject({ kind: 'customer_cap', period: 'day' });
    expect(mock.calls).toHaveLength(0);
    // Search Console (own connection, not metered) still runs
    expect((await treg.call('gsc.sites', {}, ctx({ feature: 'gsc' }), { idempotencyKey: key() })).ok).toBe(true);
  });

  it('never counts estimated Nango or X rows [R F2]', async () => {
    const { treg, tag } = setup();
    await db.insert('usage_ledger', [row({ tag, vendor: 'nango', estimated: true, cost_micro: 5_000_000, feature: 'connections' }), row({ tag, vendor: 'x', estimated: true, cost_micro: 5_000_000, feature: 'posting' })]);
    expect((await treg.call('ig.profile', { body: {} }, ctx(), { maxCostUsd: 0.01, idempotencyKey: key() })).ok).toBe(true);
  });

  it('uses an override over the default (null fields inherit), and blocks a blocked customer', async () => {
    const { treg, tag } = setup();
    await db.insert('billing_caps', { customer_tag: '*', daily_cap_micro: 5000, monthly_cap_micro: 3_000_000, calls_per_day: 400, status: 'active' });
    await db.insert('usage_ledger', row({ tag, cost_micro: 4500 }));
    await expect(treg.checkCaps(U1, 1000)).rejects.toMatchObject({ kind: 'customer_cap' });
    await db.insert('billing_caps', { customer_tag: tag, daily_cap_micro: 100_000, monthly_cap_micro: null, status: 'active' });
    const ok = await treg.checkCaps(U1, 1000);
    expect(ok.caps).toMatchObject({ daily_cap_micro: 100_000, monthly_cap_micro: 3_000_000, calls_per_day: 400 });
    await db.update('billing_caps', { customer_tag: tag }, { status: 'blocked' });
    await expect(treg.checkCaps(U1, 0)).rejects.toMatchObject({ kind: 'customer_blocked' });
    // another customer is untouched
    expect((await treg.checkCaps(U2, 1000)).caps.daily_cap_micro).toBe(5000);
  });

  it('counts calls per day and this month’s spend too', async () => {
    const { treg, tag } = setup();
    await db.insert('billing_caps', { customer_tag: tag, calls_per_day: 2, status: 'active' });
    await db.insert('usage_ledger', [row({ tag }), row({ tag }), row({ tag, outcome: 'settled' })]);
    await expect(treg.checkCaps(U1, 0)).rejects.toMatchObject({ kind: 'customer_cap', period: 'day' });
    await db.update('billing_caps', { customer_tag: tag }, { calls_per_day: null, monthly_cap_micro: 10_000 });
    const earlier = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 0, 0, 1)).toISOString();
    await db.insert('usage_ledger', row({ tag, cost_micro: 9_500, created_at: earlier }));
    await expect(treg.checkCaps(U1, 1000)).rejects.toMatchObject({ kind: 'customer_cap', period: 'month' });
  });
});

describe('the ledger', () => {
  it('pages past 1000 rows and clears the user id after deletion, keeping the tag', async () => {
    const ledger = createLedger({ db });
    const tag = 'cust_aaaaaaaaaaaaaaaaaaaaaaaa';
    const at = new Date().toISOString();
    await db.insert('usage_ledger', Array.from({ length: 1205 }, () => ({ customer_tag: tag, user_id: U1, feature: 'social', vendor: 'treg', endpoint: 'e', cost_micro: 1, outcome: 'ok', created_at: at })));
    expect((await ledger.spend(tag)).todayMicro).toBe(1205);
    expect(await ledger.rows({ customer_tag: tag })).toHaveLength(1205);
    await ledger.clearUser(U1);
    const after = await db.select('usage_ledger', { customer_tag: tag }, { limit: 5 });
    expect(after.every((r) => r.user_id == null && r.customer_tag === tag)).toBe(true);
  });
});
