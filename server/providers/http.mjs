// Shared plumbing for the provider adapters: requests with timeouts, readable errors, and
// checks on the bytes providers send back.

export class ProviderError extends Error {
  /**
   * @param {string} code   AUTH | CREDITS | RATE_LIMIT | BAD_REQUEST | NOT_FOUND | CONTENT_POLICY | REFUSAL
   *                        | TIMEOUT | NETWORK | UPSTREAM | CUT_OFF | NO_OUTPUT | ABORTED | NO_PROVIDER
   * @param {object} o      status: HTTP status for our reply; httpStatus: what the provider answered;
   *                        notStarted: the provider certainly did no paid work (safe to try another key)
   */
  constructor(code, message, o = {}) {
    super(message);
    this.code = code;
    this.status = o.status ?? 502;
    this.httpStatus = o.httpStatus ?? 0;
    this.notStarted = !!o.notStarted;
    this.provider = o.provider ?? '';
  }
}

const str = (v) => (typeof v === 'string' ? v : '');

/** Providers sometimes quote part of the key back in errors: never pass that on. */
export const scrubKeys = (s) =>
  s
    .replace(/\b(sk|xai|mk|key)[-_][A-Za-z0-9*._-]{6,}/g, '[key]')
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, '[key]')
    .replace(/(api key provided:?\s*)\S+/gi, '$1[key]');

/** The provider's own error text, from the many shapes APIs use. */
export function upstreamMessage(payload) {
  let msg = '';
  if (typeof payload === 'string') msg = payload.trim();
  else if (payload && typeof payload === 'object') {
    const e = payload.error ?? payload;
    if (typeof e === 'string') msg = e;
    else if (e && typeof e === 'object') msg = str(e.message) || str(e.msg) || str(e.detail) || str(e.error?.message) || str(payload.message);
  }
  return scrubKeys(msg).slice(0, 400);
}

/** Map a provider's HTTP failure to a stable code the app can explain. */
export function errorFromResponse(httpStatus, payload, label) {
  const message = upstreamMessage(payload);
  const raw = JSON.stringify(payload ?? '').slice(0, 2000);
  const o = { httpStatus, notStarted: httpStatus >= 400 && httpStatus < 500, provider: label };
  if (httpStatus === 401 || httpStatus === 403) return new ProviderError('AUTH', `${label} rejected the API key${message ? `: ${message}` : '.'}`, { ...o, status: 502 });
  if (httpStatus === 402 || /insufficient[_ ](credits|quota|balance)|out of credits|billing|quota exceeded|exceeded your current quota/i.test(raw)) {
    return new ProviderError('CREDITS', `${label} says the account is out of credits${message ? `: ${message}` : '.'}`, { ...o, status: 402 });
  }
  if (httpStatus === 429) return new ProviderError('RATE_LIMIT', `${label} is rate limiting requests. Try again shortly.`, { ...o, status: 429 });
  if (/content[_ ]?policy|safety (system|filter)|moderation|prohibited|blocked by|responsible ai/i.test(raw) && httpStatus < 500) {
    return new ProviderError('CONTENT_POLICY', `${label} blocked this request under its content policy.`, { ...o, status: 422 });
  }
  if (httpStatus === 404) return new ProviderError('NOT_FOUND', `${label}: ${message || 'model or endpoint not found'}.`, { ...o, status: 502 });
  if (httpStatus >= 400 && httpStatus < 500) return new ProviderError('BAD_REQUEST', `${label} refused the request${message ? `: ${message}` : ` (${httpStatus}).`}`, { ...o, status: 502 });
  return new ProviderError('UPSTREAM', `${label} had an error${message ? `: ${message}` : ` (${httpStatus}).`}`, { ...o, status: 502 });
}

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);

function networkError(e, signal, label) {
  if (signal?.aborted) return new ProviderError('ABORTED', 'Stopped.', { status: 499, provider: label });
  const name = e?.name || e?.cause?.name || '';
  if (name === 'TimeoutError') return new ProviderError('TIMEOUT', `${label} took too long to answer.`, { status: 504, provider: label });
  const code = e?.cause?.code || e?.code || '';
  return new ProviderError('NETWORK', `Couldn’t reach ${label}${code ? ` (${code})` : ''}.`, { status: 502, notStarted: NOT_SENT.has(code), provider: label });
}

/**
 * Send a request and read a JSON (or text) reply. Never throws for HTTP errors: the caller
 * decides; throws ProviderError for timeouts, aborts and network failures.
 */
export async function requestJson(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = 60_000, signal, label = 'The provider' } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    throw networkError(e, signal, label);
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw networkError(e, signal, label);
  }
  let payload = text;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    /* keep the text */
  }
  return { status: res.status, ok: res.ok, payload, headers: res.headers };
}

/** Download a file with a size cap. Resolves { bytes, contentType }. */
export async function downloadBytes(fetchImpl, url, { headers = {}, maxBytes = 50_000_000, timeoutMs = 180_000, signal, label = 'The provider' } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.any(signals), redirect: 'follow' });
  } catch (e) {
    throw networkError(e, signal, label);
  }
  if (!res.ok) {
    let payload = '';
    try {
      payload = await res.text();
    } catch {
      /* ignore */
    }
    throw errorFromResponse(res.status, payload, label);
  }
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new ProviderError('UPSTREAM', `${label} sent a file that’s too large (${Math.round(declared / 1e6)} MB).`, { provider: label });
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) throw new ProviderError('UPSTREAM', `${label} sent a file that’s too large.`, { provider: label });
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw networkError(e, signal, label);
  }
  return { bytes: Buffer.concat(chunks), contentType: (res.headers.get('content-type') || '').split(';')[0].trim() };
}

/** png / jpeg / webp / gif, or null. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

/** mp4 / mov / webm, or null. */
export function sniffVideo(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('ascii', 4, 8) === 'ftyp') return buf.toString('ascii', 8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}

const DATA_URL = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/** Split a base64 data URL; null when it isn't one. */
export function parseDataUrl(value) {
  const m = DATA_URL.exec(String(value || ''));
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: m[2].replace(/\s+/g, '') };
}

/** Image bytes from the shapes image APIs answer with: base64, a data URL, or an https link. */
export async function imageFromValue(fetchImpl, value, { label, maxBytes = 20_000_000, signal, headers } = {}) {
  if (typeof value !== 'string' || !value) return null;
  const d = parseDataUrl(value);
  if (d) return Buffer.from(d.base64, 'base64');
  if (/^https?:\/\//i.test(value)) return (await downloadBytes(fetchImpl, value, { maxBytes, label, signal, headers })).bytes;
  if (/^[A-Za-z0-9+/=\s]{16,}$/.test(value)) return Buffer.from(value.replace(/\s+/g, ''), 'base64');
  return null;
}

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
