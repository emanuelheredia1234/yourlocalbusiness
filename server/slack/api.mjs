// Slack's Web API for the owner's user token (server only). The token goes only in the Authorization header
// of requests to Slack's API, and to Slack's own file host when downloading a file Viktor posted; never in a
// URL, a log line or an answer to the browser.
//
// Every answer is checked for ok, and its x-oauth-scopes header read. A 429 comes with Retry-After: a read
// waits it out (a cooldown per method answers 429 until then), a write is simply "not sent" (never retried).
// A write that may have happened anyway (a timeout or a dropped connection after the request left, an HTTP
// 5xx, internal_error or fatal_error) is marked uncertain: the routes answer SLACK_SEND_UNKNOWN, and a read
// (/verify, by the Ref line) settles it.

const TIMEOUTS = { read: 15_000, write: 30_000, upload: 60_000 };
const TOKEN_PROBLEMS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);
const UNCERTAIN = new Set(['internal_error', 'fatal_error']);
const NOT_SENT_NET = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);

export class SlackError extends Error {
  /**
   * code: BAD_TOKEN | MISSING_SCOPE | RATE_LIMIT | SLACK_ERROR | SLACK_UNCERTAIN | TIMEOUT | NETWORK | UPSTREAM
   *       | CUT_OFF | ABORTED | BAD_FILE_URL | TOO_BIG | FILE_AUTH | UPLOAD
   * uncertain: a write that may have happened anyway
   */
  constructor(code, message, { slack = '', status = 502, uncertain = false, retryAfter = 0, needed = [] } = {}) {
    super(message);
    this.code = code;
    this.slack = slack;
    this.status = status;
    this.uncertain = uncertain;
    this.retryAfter = retryAfter;
    this.needed = needed;
  }
}

export const parseScopes = (h) =>
  String(h ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function errorFor(err, { write, needed }) {
  if (TOKEN_PROBLEMS.has(err)) return new SlackError('BAD_TOKEN', `Slack didn’t accept the saved token (${err}).`, { slack: err });
  if (err === 'missing_scope') return new SlackError('MISSING_SCOPE', `The Slack app is missing a permission${needed ? ` (${needed})` : ''}.`, { slack: err, needed: String(needed ?? '').split(',').map((s) => s.trim()).filter(Boolean) });
  if (err === 'ratelimited') return new SlackError('RATE_LIMIT', 'Slack asked the app to slow down. Try again in a minute.', { slack: err, status: 429, retryAfter: 60 });
  if (UNCERTAIN.has(err)) return new SlackError('SLACK_UNCERTAIN', `Slack had an internal error (${err}).`, { slack: err, uncertain: !!write });
  return new SlackError('SLACK_ERROR', `Slack refused it: ${err}.`, { slack: err });
}

const withTimeout = (ms, signal) => AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);

function networkError(e, signal, write) {
  if (signal?.aborted) return new SlackError('ABORTED', 'Stopped.', { status: 499 });
  if ((e?.name || e?.cause?.name) === 'TimeoutError') return new SlackError('TIMEOUT', 'Slack took too long to answer.', { status: 504, uncertain: !!write });
  const code = e?.cause?.code || e?.code || '';
  return new SlackError('NETWORK', `Couldn’t reach Slack${code ? ` (${code})` : ''}.`, { status: 502, uncertain: !!write && !NOT_SENT_NET.has(code) });
}

/**
 * base: https://slack.com/api (or the mock's). mock: the mock's origin, whose /slack-files/ and /slack-upload/
 * paths stand in for files.slack.com in tests and browser QA (only when AI_PROVIDER_BASE_URLS.slack is set).
 */
export function createSlackApi({ fetch = globalThis.fetch, base = 'https://slack.com/api', mock = null, timeouts = {} } = {}) {
  const root = String(base).replace(/\/+$/, '');
  const T = { ...TIMEOUTS, ...timeouts };
  const cooldown = new Map(); // method → until (ms)

  /** One Web API call: { payload, scopes }. json: a JSON body (writes like chat.postMessage); else form-encoded. */
  async function callFull(method, params = {}, { token, json = false, write = false, timeoutMs, signal } = {}) {
    if (!token) throw new SlackError('BAD_TOKEN', 'There’s no Slack token.', { slack: 'not_authed' });
    const until = cooldown.get(method) ?? 0;
    if (!write && until > Date.now()) {
      const retryAfter = Math.ceil((until - Date.now()) / 1000);
      throw new SlackError('RATE_LIMIT', `Slack asked the app to slow down. Try again in ${retryAfter} seconds.`, { status: 429, retryAfter });
    }
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const headers = { authorization: `Bearer ${token}`, 'content-type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded' };
    const body = json ? JSON.stringify(clean) : new URLSearchParams(Object.entries(clean).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString();
    let res;
    try {
      res = await fetch(`${root}/${method}`, { method: 'POST', headers, body, redirect: 'error', signal: withTimeout(timeoutMs ?? (write ? T.write : T.read), signal) });
    } catch (e) {
      throw networkError(e, signal, write);
    }
    const scopes = res.headers.has('x-oauth-scopes') ? parseScopes(res.headers.get('x-oauth-scopes')) : null;
    if (res.status === 429) {
      const retryAfter = Math.max(1, Math.min(600, Number(res.headers.get('retry-after')) || 30));
      if (!write) cooldown.set(method, Date.now() + retryAfter * 1000);
      await res.body?.cancel().catch(() => {});
      throw new SlackError('RATE_LIMIT', `Slack asked the app to slow down. Try again in ${retryAfter} seconds.`, { status: 429, retryAfter });
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      if (signal?.aborted) throw new SlackError('ABORTED', 'Stopped.', { status: 499 });
      throw new SlackError('CUT_OFF', 'Slack’s answer was cut off.', { uncertain: !!write });
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (res.status >= 500 || !payload || typeof payload !== 'object') throw new SlackError('UPSTREAM', `Slack had an error (${res.status}).`, { uncertain: !!write });
    if (payload.ok !== true) throw errorFor(String(payload.error || 'unknown_error'), { write, needed: payload.needed });
    return { payload, scopes };
  }

  const call = async (method, params, o) => (await callFull(method, params, o)).payload;

  /** Where Slack's file host is: files.slack.com, or the mock's /slack-files/ path. */
  function fileHostOk(u) {
    if (u.protocol === 'https:' && u.hostname === 'files.slack.com' && !u.port) return true;
    return !!mock && u.origin === mock && u.pathname.startsWith('/slack-files/');
  }

  /** Where Slack's upload addresses point: files.slack.com, or the mock's /slack-upload/ path. */
  function uploadHostOk(u) {
    if (u.protocol === 'https:' && u.hostname === 'files.slack.com' && !u.port) return true;
    return !!mock && u.origin === mock && u.pathname.startsWith('/slack-upload/');
  }

  /**
   * Step 2 of an upload: the bytes to the address files.getUploadURLExternal gave, without the token. Nothing
   * is visible in Slack until files.completeUploadExternal, so any failure here sent nothing.
   */
  async function uploadBytes(uploadUrl, bytes, { signal } = {}) {
    let u;
    try {
      u = new URL(String(uploadUrl));
    } catch {
      u = null;
    }
    if (!u || !uploadHostOk(u)) throw new SlackError('UPLOAD', 'Slack gave an upload address the app doesn’t trust.');
    let res;
    try {
      res = await fetch(u.href, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes, redirect: 'error', signal: withTimeout(T.upload, signal) });
    } catch (e) {
      const err = networkError(e, signal, false);
      throw err.code === 'ABORTED' ? err : new SlackError('UPLOAD', `Couldn’t send the image to Slack (${err.message})`);
    }
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new SlackError('UPLOAD', `Slack didn’t take the image (${res.status}).`);
    return true;
  }

  /**
   * A file Viktor posted, downloaded with the token: only from Slack's own file host, redirects followed by
   * hand (at most 2, same host, keeping the header; anything else is refused without a request), streamed
   * with a byte cap. Resolves { bytes, contentType }.
   */
  async function downloadFile(url, { token, maxBytes, signal } = {}) {
    let u;
    try {
      u = new URL(String(url));
    } catch {
      u = null;
    }
    if (!u || !fileHostOk(u)) throw new SlackError('BAD_FILE_URL', 'That file isn’t on Slack’s file host, so the app won’t fetch it.', { status: 403 });
    let res;
    for (let hop = 0; ; hop++) {
      try {
        res = await fetch(u.href, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: withTimeout(T.upload, signal) });
      } catch (e) {
        throw networkError(e, signal, false);
      }
      if (res.status < 300 || res.status >= 400) break;
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      let next = null;
      try {
        next = location ? new URL(location, u) : null;
      } catch {
        next = null;
      }
      // the token never follows a redirect to another host
      if (!next || hop >= 2 || next.protocol !== u.protocol || next.host !== u.host || !fileHostOk(next)) throw new SlackError('BAD_FILE_URL', 'Slack sent the file somewhere else, so the app didn’t fetch it.', { status: 403 });
      u = next;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new SlackError(res.status === 401 || res.status === 403 ? 'FILE_AUTH' : 'UPSTREAM', `Slack didn’t send the file (${res.status}).`);
    }
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new SlackError('TOO_BIG', 'That file is too big for the app.', { status: 413 });
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) throw new SlackError('TOO_BIG', 'That file is too big for the app.', { status: 413 });
        chunks.push(chunk);
      }
    } catch (e) {
      if (e instanceof SlackError) throw e;
      throw networkError(e, signal, false);
    }
    return { bytes: Buffer.concat(chunks), contentType };
  }

  return { call, callFull, uploadBytes, downloadFile, fileHostOk };
}
