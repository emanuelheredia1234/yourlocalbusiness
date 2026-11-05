// Calls our server makes straight to a network, not through the connections proxy (spec §1.2 "Derived tokens
// never go through the vendor proxy"):
// - Facebook with the Page's own token (read once through the proxy for one job, kept in memory only): posts,
//   photos, the first comment and the "Check again" read go to graph.facebook.com with
//   `Authorization: Bearer <page token>`. The token is never in a URL, a log, a proxy header or a row.
// - Pre-signed upload addresses the networks hand back (LinkedIn uploadUrl, YouTube's resumable session, TikTok's
//   upload_url): the bytes are PUT there directly, so they never pass through (and aren't billed by) the proxy.
//
// One attempt each, no retries: 30 s for reads, 120 s for writes and uploads. Answers are { status, headers,
// body } like connections.request; a network error or a timeout throws (the caller's oneShot makes it unknown).
//
// Env: GRAPH_BASE_URL (tests and QA: the mock), SOCIAL_MOCK_BASE_URL (tests and QA only: upload addresses on
// the mock are allowed too).

export const GRAPH_VERSION = 'v26.0';
const READ_MS = 30_000;
const WRITE_MS = 120_000;

/** The hosts each network's upload addresses may be on (an address from anywhere else is refused). */
const UPLOAD_HOSTS = {
  linkedin: [/(^|\.)linkedin\.com$/i, /(^|\.)licdn\.com$/i],
  youtube: [/(^|\.)googleapis\.com$/i],
  tiktok: [/(^|\.)tiktokapis\.com$/i, /(^|\.)tiktok\.com$/i, /(^|\.)tiktokcdn\.com$/i],
};

const HEADER_WHITELIST = ['location', 'x-restli-id', 'content-type', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

async function answer(res) {
  const headers = {};
  for (const h of HEADER_WHITELIST) {
    const v = res.headers.get(h);
    if (v != null) headers[h] = v;
  }
  const text = await res.text().catch(() => '');
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: kept as text (never shown to anyone) */
  }
  return { status: res.status, headers, body };
}

export function createDirect({ env = process.env, fetch = globalThis.fetch, timeouts = {} } = {}) {
  const graphBase = String(env.GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, '');
  const mockBase = String(env.SOCIAL_MOCK_BASE_URL || '').replace(/\/+$/, '');
  const readMs = timeouts.readMs ?? READ_MS;
  const writeMs = timeouts.writeMs ?? WRITE_MS;

  /** Whether an upload address is one this network hands out (https on its own hosts, or the test mock). */
  function uploadAllowed(network, address) {
    let u;
    try {
      u = new URL(String(address));
    } catch {
      return false;
    }
    if (mockBase && String(address).startsWith(`${mockBase}/`)) return true;
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    return (UPLOAD_HOSTS[network] ?? []).some((re) => re.test(u.hostname));
  }

  return {
    graphBase,
    uploadAllowed,

    /**
     * A Graph call with the Page token. path: '/v26.0/<id>/feed'. query: plain fields only (never a token).
     * body: an object, sent as JSON.
     */
    async graph(pageToken, { method = 'GET', path, query, body }) {
      if (!pageToken) throw new Error('no page token');
      const q = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
      const res = await fetch(`${graphBase}${path}${q}`, {
        method,
        headers: { authorization: `Bearer ${pageToken}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'GET' ? readMs : writeMs),
      });
      return answer(res);
    },

    /**
     * PUT bytes to a network's upload address. headers: e.g. content-type, content-range. One attempt; the
     * address is checked against the network's hosts first.
     */
    async upload(network, address, bytes, headers = {}) {
      if (!uploadAllowed(network, address)) throw Object.assign(new Error('upload address refused'), { refused: true });
      const res = await fetch(String(address), { method: 'PUT', headers: { 'content-length': String(bytes.length), ...headers }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(writeMs) });
      return answer(res);
    },
  };
}
