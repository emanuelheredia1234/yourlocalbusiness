// A stand-in for Google's OAuth and Gmail send APIs, preloaded into the real server by its tests
// (node --import server/test/mock-google.mjs server/ai-server.mjs): token, userinfo, revoke and send are
// answered locally, loopback (the mock Supabase) passes through, and every other host is refused, so nothing
// leaves the machine. Each call is appended to GOOGLE_MOCK_LOG as a JSON line. Token values are not logged.
import fs from 'node:fs';

const realFetch = globalThis.fetch;
const LOG = process.env.GOOGLE_MOCK_LOG || '';
const record = (entry) => {
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};
const SCOPES = 'https://www.googleapis.com/auth/gmail.send openid https://www.googleapis.com/auth/userinfo.email';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async function mockGoogleFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return realFetch(input, init);
  const body = typeof init.body === 'string' ? init.body : '';
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
    const form = new URLSearchParams(body);
    const grant = form.get('grant_type') || '';
    const code = form.get('code') || '';
    record({ kind: 'token', grant, redirect: form.get('redirect_uri') || '', hasSecret: Boolean(form.get('client_secret')), code, hasRefresh: Boolean(form.get('refresh_token')) });
    if (grant === 'refresh_token') return json(200, { access_token: 'fake-at-refreshed', token_type: 'Bearer', expires_in: 3600, scope: SCOPES });
    return json(200, { access_token: `fake-at-${code}`, refresh_token: `fake-rt-${code}`, token_type: 'Bearer', expires_in: 3600, scope: SCOPES });
  }
  if (url.hostname === 'openidconnect.googleapis.com' && url.pathname === '/v1/userinfo') {
    record({ kind: 'userinfo' });
    return json(200, { sub: 'google-sub-ada', email: 'ada@gmail.com', email_verified: true });
  }
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
    record({ kind: 'revoke', hasToken: Boolean(new URLSearchParams(body).get('token')) });
    return new Response('', { status: 200 });
  }
  if (url.hostname === 'gmail.googleapis.com' && url.pathname === '/gmail/v1/users/me/messages/send') {
    record({ kind: 'send' });
    return json(200, { id: 'msg_1', threadId: 'thr_1' });
  }
  record({ kind: 'blocked', host: url.hostname });
  throw new TypeError(`mock-google: ${url.hostname} is not reachable in tests`);
};
