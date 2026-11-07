// A stand-in for Omnisend, preloaded into the real server by its tests (node --import server/test/mock-omnisend.mjs
// server/ai-server.mjs): it answers Omnisend's token endpoint and API locally with fakes, lets loopback through
// (the mock Supabase), and refuses every other host, so nothing leaves the machine. Each call is appended to
// OMNISEND_MOCK_LOG as a JSON line. Email analytics: POST /api/analytics/reports and GET /api/campaigns answer
// fixed stats; OMNISEND_MOCK_REPORTS=403 (the reporting scope is missing) or =429 (over Omnisend's limit) makes
// reports answer that instead.
// A/B drafts (P4b): POST /api/campaigns with type abTest is checked (both variants, each with a templateID this mock
// imported, testSizePercent 10–100, no top-level content) and answered with variant ids; OMNISEND_MOCK_AB=422 makes
// Omnisend refuse the abTest type for the brand (campaign-type-not-supported). GET /api/campaigns/<id> answers the
// campaign with mockAb.result as its abTest.result (settable).
import fs from 'node:fs';

const realFetch = globalThis.fetch;
const LOG = process.env.OMNISEND_MOCK_LOG || '';
const record = (entry) => {
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};
/** Omnisend's reports answer for the analytics request (rates are ratios). */
export const MOCK_REPORTS = {
  reports: [
    {
      alias: 'campaigns-30d',
      rows: [
        { marketingActivityID: 'c'.repeat(24), sent: 1000, openRate: 0.4, clickRate: 0.05, unsubscribeRate: 0.002, attributedRevenue: 120.5, attributedOrders: 3 },
        { marketingActivityID: 'd'.repeat(24), sent: 500, openRate: 0.1, clickRate: 0.02, unsubscribeRate: 0.004, attributedRevenue: 0, attributedOrders: 0 },
      ],
    },
    {
      alias: 'daily-30d',
      rows: [
        { timestamp: '2026-11-02', sent: 1000, openedUnique: 400, clickedUnique: 50 },
        { timestamp: '2026-11-01', sent: 500, openedUnique: 50, clickedUnique: 10 },
      ],
    },
  ],
};
export const MOCK_CAMPAIGNS = [
  { id: 'c'.repeat(24), name: 'Spring <b>sale</b>' },
  { id: 'd'.repeat(24), name: 'Welcome' },
];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A/B drafts: the templates imported, the campaigns made, and the result GET /campaigns/<id> reports (settable). */
export const mockAb = { templates: new Set(), campaigns: new Map(), result: null };
let nextId = 0;
const hexId = () => (++nextId).toString(16).padStart(24, 'e');
/** Why an abTest campaign body isn't one Omnisend takes, or null. */
export function abProblem(payload, templates = mockAb.templates) {
  const ab = payload?.abTest;
  if (payload?.content !== undefined) return 'top-level content';
  if (!ab || typeof ab !== 'object') return 'no abTest';
  const size = ab.settings?.testSizePercent;
  if (!Number.isInteger(size) || size < 10 || size > 100) return 'testSizePercent';
  if (!['openRate', 'clickRate'].includes(ab.settings?.winningMetric)) return 'winningMetric';
  if (!Number.isInteger(ab.settings?.decisionTime?.amount) || !['h', 'd'].includes(ab.settings?.decisionTime?.unit)) return 'decisionTime';
  for (const k of ['a', 'b']) {
    const email = ab.variants?.[k]?.content?.email;
    if (!email?.subject || !templates.has(email.templateID)) return `variant ${k}`;
  }
  return null;
}

globalThis.fetch = async function mockOmnisendFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return realFetch(input, init);
  const body = typeof init.body === 'string' ? init.body : '';
  if (url.hostname === 'app.omnisend.com' && url.pathname === '/oauth2/token') {
    const code = new URLSearchParams(body).get('code') || '';
    record({ kind: 'token', code });
    return json(200, { access_token: `fake-at-${code}`, refresh_token: `fake-rt-${code}`, token_type: 'Bearer', expires_in: 9223372036, scope: 'campaigns.write email-templates.write' });
  }
  if (url.hostname === 'api.omnisend.com') {
    const bearer = new Headers(init.headers || {}).get('authorization') || '';
    const payload = JSON.parse(body || '{}');
    record({ kind: 'api', method: init.method || 'GET', path: url.pathname, bearer, payload });
    if (url.pathname === '/api/analytics/reports') {
      const mode = Number(process.env.OMNISEND_MOCK_REPORTS || 0);
      if (mode === 403 || mode === 429) return json(mode, { type: 'https://problems.omnisend.com/forbidden', title: 'Refused', status: mode });
      return json(200, MOCK_REPORTS);
    }
    if (url.pathname === '/api/campaigns' && (init.method || 'GET') === 'GET') return json(200, { campaigns: MOCK_CAMPAIGNS });
    if (url.pathname === '/api/email-templates/import') {
      mockAb.templates.add('a'.repeat(24));
      return json(201, { id: 'a'.repeat(24) });
    }
    const one = /^\/api\/campaigns\/([0-9a-f]{24})$/.exec(url.pathname);
    if (one && (init.method || 'GET') === 'GET') {
      const c = mockAb.campaigns.get(one[1]);
      if (!c) return json(404, { type: 'https://problems.omnisend.com/not-found', title: 'Not found', status: 404 });
      return json(200, { ...c, ...(mockAb.result ? { abTest: { ...c.abTest, result: mockAb.result } } : {}) });
    }
    if (url.pathname === '/api/campaigns' && payload.type === 'abTest') {
      if (Number(process.env.OMNISEND_MOCK_AB || 0) === 422) return json(422, { type: 'https://problems.omnisend.com/campaign-type-not-supported', title: 'Not supported', status: 422 });
      const problem = abProblem(payload);
      if (problem) return json(400, { type: 'https://problems.omnisend.com/validation-error', title: problem, status: 400 });
      const id = hexId();
      const c = { id, name: payload.name, status: 'draft', type: 'abTest', url: `https://app.omnisend.com/campaigns/${id}/settings`, abTest: { ...payload.abTest, variants: { a: { ...payload.abTest.variants.a, id: hexId() }, b: { ...payload.abTest.variants.b, id: hexId() } } } };
      mockAb.campaigns.set(id, c);
      return json(201, c);
    }
    if (url.pathname === '/api/campaigns') return json(201, { id: 'b'.repeat(24), name: payload.name, status: 'draft', url: `https://app.omnisend.com/campaigns/${'b'.repeat(24)}/settings` });
    return json(404, { type: 'https://problems.omnisend.com/not-found', title: 'Not found', status: 404 });
  }
  record({ kind: 'blocked', host: url.hostname });
  throw new TypeError(`mock-omnisend: ${url.hostname} is not reachable in tests`);
};
