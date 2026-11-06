// Email analytics (WP4): Omnisend's reports for the Update, within Omnisend's limits (one live call per brand per
// hour, 40 a day), the optional reporting scope that never forces existing users to reconnect, and the email
// source. Omnisend is server/test/mock-omnisend.mjs (it replaces fetch; nothing leaves the machine).
import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { MOCK_REPORTS } from '../test/mock-omnisend.mjs';
import { createOmnisendRoutes, emailDataFrom, OMNISEND_SCOPES, REPORTS_QUERY } from '../omnisend.mjs';
import { emailSource } from './sources/email.mjs';
import { leadCounts } from './snapshots.mjs';
import { call, fakeAuth, makeStorage, readJson, send } from './test-helpers.mjs';

const USER = { id: '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11', email: 'a@example.com' };
const userKey = (id) => `omnisend:user:${crypto.createHash('sha256').update(id).digest('hex')}`;
const mockFetch = globalThis.fetch;

let calls;
let storage;
let t;
function make({ optionalScopes } = {}) {
  const fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: new Headers(init.headers).get('authorization') });
    return mockFetch(input, init);
  };
  return createOmnisendRoutes({
    auth: fakeAuth({ a: USER }),
    storage,
    send,
    readJson,
    env: { OMNISEND_CLIENT_ID: 'test-client', OMNISEND_CLIENT_SECRET: 'test-omnisend-secret' },
    fetch,
    now: () => t,
    ...(optionalScopes ? { optionalScopes } : {}),
  });
}
const reportsCalls = () => calls.filter((c) => c.url.endsWith('/api/analytics/reports'));

beforeEach(async () => {
  calls = [];
  storage = makeStorage();
  t = Date.parse('2026-11-05T12:00:00Z');
  delete process.env.OMNISEND_MOCK_REPORTS;
  await storage.put(userKey(USER.id), { accessToken: 'fake-at-test', scopes: [...OMNISEND_SCOPES], connectedAt: '2026-11-01T00:00:00Z' });
});

describe('omnisend.reports()', () => {
  it('sends the analytics request of the spec and returns EmailData with campaign names as text', async () => {
    const o = make();
    const got = await o.reports(USER.id);
    expect(reportsCalls()).toHaveLength(1);
    expect(reportsCalls()[0]).toMatchObject({ method: 'POST', body: REPORTS_QUERY, auth: 'Bearer fake-at-test' });
    expect(REPORTS_QUERY.queries[0]).toMatchObject({ alias: 'campaigns-30d', dimensions: [{ name: 'marketingActivityID' }], dateRange: { interval: 'last30Days' }, filters: [{ name: 'marketingActivityType', operator: 'in', values: ['Campaign'] }] });
    expect(REPORTS_QUERY.queries[1]).toMatchObject({ alias: 'daily-30d', dimensions: [{ name: 'timestamp', granularity: 'day' }] });
    expect(got.status).toBe('ok');
    expect(got.data.sent).toBe(1500);
    expect(got.data.openRate).toBeCloseTo(0.3);
    expect(got.data.revenue).toBeCloseTo(120.5);
    expect(got.data.campaigns[0]).toEqual({ id: 'c'.repeat(24), name: 'Spring <b>sale</b>', sent: 1000, openRate: 0.4, clickRate: 0.05, revenue: 120.5 });
    expect(got.data.series.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02']);
    expect(calls.some((c) => c.url.includes('/api/campaigns?limit=100'))).toBe(true);
    // the token never comes back
    expect(JSON.stringify(got)).not.toContain('fake-at-test');
  });

  it('serves the hour-old answer again with no Omnisend call, and caches campaign names for a day', async () => {
    const o = make();
    await o.reports(USER.id);
    t += 30 * 60_000;
    const again = await o.reports(USER.id);
    expect(reportsCalls()).toHaveLength(1);
    expect(again).toMatchObject({ status: 'ok', cached: true, data: { sent: 1500 } });
    t += 31 * 60_000;
    await o.reports(USER.id);
    expect(reportsCalls()).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes('/api/campaigns'))).toHaveLength(1);
  });

  it('makes one call for two Updates at once', async () => {
    storage = Object.assign(makeStorage({ latencyMs: 3 }), {});
    await storage.put(userKey(USER.id), { accessToken: 'fake-at-test', scopes: [...OMNISEND_SCOPES] });
    const o = make();
    await Promise.all([o.reports(USER.id), o.reports(USER.id)]);
    expect(reportsCalls()).toHaveLength(1);
  });

  it('refuses the 41st call of the day for a brand', async () => {
    const o = make();
    await o.reports(USER.id);
    const key = [...storage.documents.keys()].find((k) => k.startsWith('omnisend:reports:'));
    expect(key).toMatch(/^omnisend:reports:[0-9a-f]{24}:2026-11-05$/);
    const doc = storage.documents.get(key);
    await storage.put(key, { ...doc.value, count: 40, lastAt: t - 2 * 3_600_000 }, { ifVersion: doc.updatedAt });
    const got = await o.reports(USER.id);
    expect(got).toEqual({ status: 'skipped', errorCode: 'RATE_LIMITED' });
    expect(reportsCalls()).toHaveLength(1);
  });

  it('maps 403 to not_connected / NEEDS_RECONNECT and 429 to skipped / RATE_LIMITED', async () => {
    process.env.OMNISEND_MOCK_REPORTS = '403';
    expect(await make().reports(USER.id)).toEqual({ status: 'not_connected', errorCode: 'NEEDS_RECONNECT' });
    storage = makeStorage();
    await storage.put(userKey(USER.id), { accessToken: 'fake-at-other', scopes: [...OMNISEND_SCOPES] });
    process.env.OMNISEND_MOCK_REPORTS = '429';
    expect(await make().reports(USER.id)).toEqual({ status: 'skipped', errorCode: 'RATE_LIMITED' });
    delete process.env.OMNISEND_MOCK_REPORTS;
  });

  it('is not_connected without a connection', async () => {
    storage = makeStorage();
    const o = make();
    expect(await o.reports(USER.id)).toEqual({ status: 'not_connected', errorCode: 'NOT_CONNECTED' });
    expect(await o.connected(USER.id)).toBe(false);
    expect(reportsCalls()).toHaveLength(0);
  });
});

describe('the optional reporting scope', () => {
  it('is asked for on connect but never sends an existing user to reconnect; only email stats need it', async () => {
    const o = make({ optionalScopes: ['analytics.read'] });
    const status = await call(o, 'GET', '/api/integrations/omnisend/status', { token: 'a' });
    expect(status.body).toMatchObject({ connected: true, reconnect: null });
    expect(await o.reports(USER.id)).toEqual({ status: 'not_connected', errorCode: 'NEEDS_RECONNECT' });
    expect(reportsCalls()).toHaveLength(0);
    // new connects ask for both lists
    const r = await call(o, 'POST', '/api/integrations/omnisend/connect', { token: 'a', headers: { origin: 'https://yourlocalbusiness.replit.app' } });
    expect(r.status).toBe(200);
    expect(new URL(r.body.authorizationUrl).searchParams.get('scope')).toBe('campaigns.write email-templates.write analytics.read');
  });
});

describe('email source', () => {
  it('adds leads and keeps going on a skipped answer', async () => {
    const db = { select: async () => [{ id: 1 }, { id: 2 }] };
    const ok = await emailSource({ db, userId: USER.id, projectId: 'p1', omnisend: { reports: async () => ({ status: 'ok', data: emailDataFrom(MOCK_REPORTS.reports, {}), fetchedAt: 'x' }) }, now: Date.now() });
    expect(ok).toMatchObject({ status: 'ok', data: { sent: 1500, leads: 2 }, summary: { leads: 2 } });
    const skipped = await emailSource({ db, userId: USER.id, projectId: 'p1', omnisend: { reports: async () => ({ status: 'skipped', errorCode: 'RATE_LIMITED' }) }, now: Date.now() });
    expect(skipped).toMatchObject({ status: 'skipped', errorCode: 'RATE_LIMITED' });
    const cached = await emailSource({ db, userId: USER.id, projectId: 'p1', omnisend: { reports: async () => ({ status: 'ok', cached: true }) }, previous: { data: { sent: 9, openRate: 0 }, fetched_at: '2026-11-05T11:30:00Z' }, now: Date.now() });
    expect(cached).toMatchObject({ status: 'ok', data: { sent: 9, leads: 2 }, fetchedAt: '2026-11-05T11:30:00Z' });
  });
});

describe('leads by business and source', () => {
  const NOW = Date.parse('2026-11-06T12:00:00Z');
  const day = 86_400_000;
  const other = '00000000-0000-4000-8000-0000000000ff';
  const rows = {
    page_leads: [
      { user_id: USER.id, project_id: 'p1', page_id: 'seo:p1', source: 'page', created_at: new Date(NOW - day).toISOString() },
      { user_id: USER.id, project_id: 'p1', page_id: 'artifact:a1', source: 'asset', created_at: new Date(NOW - 2 * day).toISOString() },
      { user_id: USER.id, project_id: 'p1', page_id: 'artifact:a2', source: 'asset', created_at: new Date(NOW - 3 * day).toISOString() },
      { user_id: USER.id, project_id: 'p1', page_id: 'magnet:AAAAAAAAAAAAAAAAAAAAAA', source: 'magnet', created_at: new Date(NOW - 4 * day).toISOString() },
      // too old, another business, another account
      { user_id: USER.id, project_id: 'p1', page_id: 'seo:p1', source: 'page', created_at: new Date(NOW - 40 * day).toISOString() },
      { user_id: USER.id, project_id: 'p2', page_id: 'seo:p2', source: 'page', created_at: new Date(NOW - day).toISOString() },
      { user_id: other, project_id: 'p1', page_id: 'seo:p1', source: 'page', created_at: new Date(NOW - day).toISOString() },
    ],
    lead_files: [
      { user_id: USER.id, project_id: 'p1', downloads: 7 },
      { user_id: USER.id, project_id: 'p1', downloads: 3 },
      { user_id: USER.id, project_id: 'p2', downloads: 100 },
      { user_id: other, project_id: 'p1', downloads: 50 },
    ],
  };
  /** db.select over the rows above, with eq and ['gte', v] filters, as server/integrations/db.mjs sends them. */
  const db = (missingColumn = false) => ({
    select: async (table, filters) => {
      if (missingColumn && table === 'page_leads' && 'project_id' in filters) throw Object.assign(new Error('column'), { status: 400 });
      if (missingColumn && table === 'lead_files') throw Object.assign(new Error('table'), { status: 503 });
      return (rows[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => (Array.isArray(v) ? String(r[k]) >= v[1] : String(r[k]) === String(v))));
    },
  });

  it('counts the business’s pages, assets and lead magnet, and its downloads; never another business’s or account’s', async () => {
    expect(await leadCounts(db(), USER.id, 'p1', NOW)).toEqual({ page: 1, asset: 2, magnet: 1 });
    const got = await emailSource({ db: db(), userId: USER.id, projectId: 'p1', omnisend: null, now: NOW });
    expect(got.data).toMatchObject({ leads: 4, leadsBySource: { page: 1, asset: 2, magnet: 1 }, downloads: 10 });
  });

  it('before the migration: the sales page’s leads, as before, and no downloads', async () => {
    const got = await emailSource({ db: db(true), userId: USER.id, projectId: 'p1', omnisend: null, now: NOW });
    // page_id seo:p1 in the last 30 days (another account's never)
    expect(got.data).toMatchObject({ leads: 1, leadsBySource: { page: 1, asset: 0, magnet: 0 }, downloads: 0 });
  });
});
