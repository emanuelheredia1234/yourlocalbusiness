// A stand-in for Omnisend, preloaded into the real server by its tests (node --import server/test/mock-omnisend.mjs
// server/ai-server.mjs): it answers Omnisend's token endpoint and API locally with fakes, lets loopback through
// (the mock Supabase), and refuses every other host, so nothing leaves the machine. Each call is appended to
// OMNISEND_MOCK_LOG as a JSON line.
import fs from 'node:fs';

const realFetch = globalThis.fetch;
const LOG = process.env.OMNISEND_MOCK_LOG || '';
const record = (entry) => {
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
    record({ kind: 'api', path: url.pathname, bearer, payload });
    if (url.pathname === '/api/email-templates/import') return json(201, { id: 'a'.repeat(24) });
    if (url.pathname === '/api/campaigns') return json(201, { id: 'b'.repeat(24), name: payload.name, status: 'draft', url: `https://app.omnisend.com/campaigns/${'b'.repeat(24)}/settings` });
    return json(404, { type: 'https://problems.omnisend.com/not-found', title: 'Not found', status: 404 });
  }
  record({ kind: 'blocked', host: url.hostname });
  throw new TypeError(`mock-omnisend: ${url.hostname} is not reachable in tests`);
};
