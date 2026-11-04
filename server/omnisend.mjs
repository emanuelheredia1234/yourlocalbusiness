import crypto from 'node:crypto';

export const OMNISEND_PUBLIC_BASE_URL = 'https://yourlocalbusiness.replit.app';
export const OMNISEND_REDIRECT_URI = `${OMNISEND_PUBLIC_BASE_URL}/api/integrations/omnisend/callback`;
export const OMNISEND_SCOPES = ['campaigns.write', 'email-templates.write'];

const OAUTH_AUTHORIZE_URL = 'https://app.omnisend.com/oauth2/authorize';
const OAUTH_TOKEN_URL = 'https://app.omnisend.com/oauth2/token';
const API_BASE_URL = 'https://api.omnisend.com/api';
const API_VERSION = '2026-03-15';
const API_PREFIX = '/api/integrations/omnisend';
const OAUTH_STATES_KEY = 'omnisend:oauth:states';
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 500;

class OmnisendError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const stateHash = (state) => crypto.createHash('sha256').update(state).digest('hex');
const userDocumentKey = (userId) => `omnisend:user:${stateHash(userId)}`;

function failStorage(error) {
  if (error?.code === 'NO_TABLE') {
    return new OmnisendError(503, 'STORAGE_NOT_READY', 'Secure integration storage is not set up yet. Run the app_state Supabase migration before connecting Omnisend.');
  }
  if (error?.code === 'UNREADABLE') {
    return new OmnisendError(503, 'STORAGE_UNREADABLE', 'Secure integration storage cannot be read. Check that the Supabase encryption secret has not changed.');
  }
  return new OmnisendError(503, 'STORAGE_UNAVAILABLE', 'Secure integration storage is unavailable. Try again shortly.');
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function campaignHtml({ subject, body, ctaLabel, ctaUrl }) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((part) => `<p>${escapeHtml(part).replaceAll('\n', '<br>')}</p>`)
    .join('\n');
  const url = safeHttpUrl(ctaUrl);
  const button = url && ctaLabel
    ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#176b52;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(ctaLabel)}</a></p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px;font-family:Arial,sans-serif;line-height:1.6;color:#17221d"><main style="max-width:600px;margin:0 auto"><h1 style="font-size:24px;line-height:1.25">${escapeHtml(subject)}</h1>${paragraphs}${button}</main></body></html>`;
}

export function createOmnisendRoutes({
  auth,
  storage,
  send,
  readJson,
  sameOrigin = () => true,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const clientId = String(env.OMNISEND_CLIENT_ID || '').trim();
  const clientSecret = String(env.OMNISEND_CLIENT_SECRET || '').trim();
  const credentialsConfigured = !!(clientId && clientSecret);
  const missingCredentials = [
    ...(!clientId ? ['OMNISEND_CLIENT_ID'] : []),
    ...(!clientSecret ? ['OMNISEND_CLIENT_SECRET'] : []),
  ];
  const storageReady = storage?.enabled === true;

  async function readDocument(key) {
    try {
      if (!storageReady) throw new OmnisendError(503, 'STORAGE_NOT_READY', 'Secure integration storage needs Supabase server storage.');
      const result = await storage.get(key);
      if (result?.unreadable) throw Object.assign(new Error('Unreadable encrypted value'), { code: 'UNREADABLE' });
      return { value: isRecord(result?.value) ? result.value : {}, version: result?.updatedAt ?? null };
    } catch (error) {
      if (error instanceof OmnisendError) throw error;
      throw failStorage(error);
    }
  }

  async function updateDocument(key, change) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await readDocument(key);
      const result = change(current.value);
      if (result?.write === false) return result.result;
      try {
        await storage.put(key, result.value, { ifVersion: current.version });
        return result.result;
      } catch (error) {
        if (error?.code === 'CONFLICT') continue;
        throw failStorage(error);
      }
    }
    throw new OmnisendError(409, 'STORAGE_CONFLICT', 'The connection changed in another request. Try again.');
  }

  async function requireUser(req, res) {
    if (!auth?.enabled) {
      send(res, 503, { error: 'Customer sign-in must be enabled before connecting Omnisend.', code: 'ACCOUNTS_NOT_CONFIGURED' });
      return null;
    }
    try {
      const user = await auth.identify(req);
      if (!user?.id) {
        send(res, 401, { error: 'Sign in to connect your Omnisend account.', code: 'AUTH_REQUIRED' });
        return null;
      }
      return user;
    } catch {
      send(res, 503, { error: 'Could not verify your sign-in. Try again shortly.', code: 'AUTH_UNAVAILABLE' });
      return null;
    }
  }

  async function connectionFor(userId) {
    const { value } = await readDocument(userDocumentKey(userId));
    return value;
  }

  async function saveOAuthState(state, userId) {
    const hash = stateHash(state);
    const createdAt = now();
    await updateDocument(OAUTH_STATES_KEY, (current) => {
      const existing = isRecord(current.states) ? current.states : {};
      const active = Object.entries(existing)
        .filter(([, entry]) => isRecord(entry) && Number(entry.createdAt) > createdAt - STATE_TTL_MS)
        .sort((a, b) => Number(a[1].createdAt) - Number(b[1].createdAt))
        .slice(-MAX_PENDING_STATES);
      const states = Object.fromEntries(active);
      states[hash] = { userId, createdAt, scopes: [...OMNISEND_SCOPES] };
      return { value: { states }, result: undefined };
    });
  }

  async function consumeOAuthState(state) {
    if (!state || state.length > 256) return null;
    const hash = stateHash(state);
    return updateDocument(OAUTH_STATES_KEY, (current) => {
      const states = isRecord(current.states) ? current.states : {};
      const record = states[hash];
      if (!isRecord(record) || !record.userId || now() - Number(record.createdAt) > STATE_TTL_MS) {
        return { write: false, result: null };
      }
      const nextStates = { ...states };
      delete nextStates[hash];
      return { value: { states: nextStates }, result: record };
    });
  }

  function callbackRedirect(res, outcome) {
    const target = new URL('/', `${OMNISEND_PUBLIC_BASE_URL}/`);
    target.searchParams.set('omnisend', outcome);
    target.hash = 'marketing-email';
    res.writeHead(303, {
      location: target.toString(),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end();
  }

  async function exchangeCode(code) {
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: OMNISEND_REDIRECT_URI,
    });
    let response;
    try {
      response = await fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new OmnisendError(502, 'TOKEN_EXCHANGE_FAILED', 'Omnisend could not complete the token exchange. Try connecting again.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new OmnisendError(502, 'TOKEN_EXCHANGE_FAILED', 'Omnisend could not complete the token exchange. Check the OAuth credentials and registered callback URL.');
    }
    if (payload.token_type && String(payload.token_type).toLowerCase() !== 'bearer') {
      throw new OmnisendError(502, 'TOKEN_TYPE_UNSUPPORTED', 'Omnisend returned an unsupported token type. Try connecting again.');
    }
    return payload;
  }

  async function callback(req, res, url) {
    try {
      const state = await consumeOAuthState(url.searchParams.get('state') || '');
      if (!state) return callbackRedirect(res, 'invalid_state');
      if (url.searchParams.has('error')) {
        return callbackRedirect(res, url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'error');
      }
      const code = url.searchParams.get('code') || '';
      if (!code || code.length > 2048 || !credentialsConfigured) return callbackRedirect(res, 'setup');
      const token = await exchangeCode(code);
      const returnedScopes = typeof token.scope === 'string' && token.scope.trim()
        ? token.scope.trim().split(/\s+/)
        : state.scopes;
      const connection = {
        accessToken: token.access_token,
        // Omnisend documents non-expiring access tokens and no refresh grant endpoint; retain the returned refresh token securely, but do not invent a refresh flow.
        refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : '',
        scopes: returnedScopes.filter((scope) => OMNISEND_SCOPES.includes(scope)),
        connectedAt: new Date(now()).toISOString(),
      };
      await storage.put(userDocumentKey(state.userId), connection);
      return callbackRedirect(res, 'connected');
    } catch {
      return callbackRedirect(res, 'error');
    }
  }

  async function status(req, res, user) {
    let connection = {};
    let statusStorageReady = storageReady;
    if (storageReady) {
      try {
        connection = await connectionFor(user.id);
      } catch (error) {
        if (credentialsConfigured) throw error;
        statusStorageReady = false;
      }
    }
    return send(res, 200, {
      credentialsConfigured,
      missingCredentials,
      storageReady: statusStorageReady,
      connected: !!connection.accessToken,
      scopes: Array.isArray(connection.scopes) ? connection.scopes.filter((scope) => OMNISEND_SCOPES.includes(scope)) : [],
    });
  }

  async function disconnect(req, res, user) {
    await updateDocument(userDocumentKey(user.id), () => ({
      value: { disconnectedAt: new Date(now()).toISOString() },
      result: undefined,
    }));
    return send(res, 200, { connected: false });
  }

  async function omnisendRequest(accessToken, path, payload) {
    let response;
    try {
      response = await fetchImpl(`${API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          'omnisend-version': API_VERSION,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new OmnisendError(502, 'OMNISEND_UNAVAILABLE', 'Could not reach Omnisend. Try again shortly.');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) {
        throw new OmnisendError(401, 'RECONNECT_REQUIRED', 'Omnisend no longer accepts this connection. Reconnect the account.');
      }
      throw new OmnisendError(502, 'OMNISEND_REQUEST_FAILED', `Omnisend could not complete this request (HTTP ${response.status}).`);
    }
    return result;
  }

  function cleanInput(value, limit) {
    return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, limit) : '';
  }

  async function createCampaignDraft(req, res, user) {
    if (!credentialsConfigured) {
      throw new OmnisendError(503, 'CREDENTIALS_NOT_CONFIGURED', 'Add OMNISEND_CLIENT_ID and OMNISEND_CLIENT_SECRET in Replit Secrets after Omnisend issues them.');
    }
    if (!storageReady) throw new OmnisendError(503, 'STORAGE_NOT_READY', 'Secure Omnisend token storage is not configured.');
    const connection = await connectionFor(user.id);
    if (!connection.accessToken) throw new OmnisendError(409, 'NOT_CONNECTED', 'Connect your Omnisend account before creating a draft.');
    const missingScopes = OMNISEND_SCOPES.filter((scope) => !connection.scopes?.includes(scope));
    if (missingScopes.length) throw new OmnisendError(403, 'SCOPE_REQUIRED', 'Reconnect Omnisend to grant the campaign and email-template permissions.');

    const body = await readJson(req, res);
    if (!body) return;
    const subject = cleanInput(body.subject, 250);
    const emailBody = cleanInput(body.body, 24_000);
    const preheader = cleanInput(body.preheader, 250);
    const name = cleanInput(body.name, 255) || `Email campaign — ${subject || 'Draft'}`;
    const ctaLabel = cleanInput(body.ctaLabel, 100);
    const ctaUrl = safeHttpUrl(body.ctaUrl);
    if (!subject || !emailBody) throw new OmnisendError(400, 'INVALID_DRAFT', 'A subject and email body are required.');

    const template = await omnisendRequest(connection.accessToken, '/email-templates/import', {
      name: `${name} — email content`.slice(0, 255),
      html: campaignHtml({ subject, body: emailBody, ctaLabel, ctaUrl }),
    });
    const templateId = template?.id;
    if (typeof templateId !== 'string' || !/^[a-f0-9]{24}$/i.test(templateId)) {
      throw new OmnisendError(502, 'TEMPLATE_CREATE_FAILED', 'Omnisend did not return a usable email template ID. No campaign draft was created.');
    }

    let campaign;
    try {
      campaign = await omnisendRequest(connection.accessToken, '/campaigns', {
        channel: 'email',
        type: 'regular',
        name,
        language: 'en_US',
        content: { email: { templateID: templateId, subject, ...(preheader ? { preheader } : {}) } },
      });
    } catch {
      throw new OmnisendError(502, 'DRAFT_CREATE_FAILED', 'The email template was imported, but Omnisend did not create the campaign draft. Check Omnisend before retrying.');
    }
    return send(res, 201, {
      campaign: {
        id: typeof campaign?.id === 'string' ? campaign.id : '',
        name: typeof campaign?.name === 'string' ? campaign.name : name,
        status: typeof campaign?.status === 'string' ? campaign.status : 'draft',
        url: typeof campaign?.url === 'string' && campaign.url.startsWith('https://app.omnisend.com/') ? campaign.url : '',
      },
    });
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    if (!path.startsWith(`${API_PREFIX}/`)) return false;
    if (path === `${API_PREFIX}/callback` && method === 'GET') return callback(req, res, url);

    if (!sameOrigin(req)) {
      return send(res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
    }

    try {
      const user = await requireUser(req, res);
      if (!user) return true;

      if (path === `${API_PREFIX}/status` && method === 'GET') return await status(req, res, user);
      if (path === `${API_PREFIX}/connect` && method === 'POST') {
        if (!credentialsConfigured) {
          throw new OmnisendError(503, 'CREDENTIALS_NOT_CONFIGURED', 'Add OMNISEND_CLIENT_ID and OMNISEND_CLIENT_SECRET in Replit Secrets after Omnisend issues them.');
        }
        if (!storageReady) throw new OmnisendError(503, 'STORAGE_NOT_READY', 'Secure Omnisend token storage is not configured. Check the Supabase server secret and app_state migration.');
        if (req.headers.origin !== OMNISEND_PUBLIC_BASE_URL) {
          throw new OmnisendError(400, 'USE_PUBLISHED_APP', `Start the Omnisend connection from ${OMNISEND_PUBLIC_BASE_URL} so the callback returns to the same app.`);
        }
        const state = crypto.randomBytes(32).toString('base64url');
        await saveOAuthState(state, user.id);
        const authUrl = new URL(OAUTH_AUTHORIZE_URL);
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', OMNISEND_REDIRECT_URI);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', OMNISEND_SCOPES.join(' '));
        authUrl.searchParams.set('state', state);
        return send(res, 200, { authorizationUrl: authUrl.toString() });
      }
      if (path === `${API_PREFIX}/connection` && method === 'DELETE') return await disconnect(req, res, user);
      if (path === `${API_PREFIX}/campaign-drafts` && method === 'POST') return await createCampaignDraft(req, res, user);
      if (path === `${API_PREFIX}/send` || path.startsWith(`${API_PREFIX}/campaigns/`) && path.endsWith('/send')) {
        return send(res, 404, { error: 'Campaign sending is not enabled. Review and confirmation must be implemented first.', code: 'SEND_NOT_AVAILABLE' });
      }
      return send(res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const message = error?.publicMessage || (status >= 500 ? 'Omnisend could not complete the request. Try again shortly.' : 'The Omnisend request was not accepted.');
      return send(res, status, { error: message, code: error?.code || 'OMNISEND_ERROR' });
    }
  }

  async function forgetUser(userId) {
    if (!storageReady || !userId) return;
    try {
      const connection = await connectionFor(userId);
      if (!connection.accessToken && !connection.refreshToken) return;
      await updateDocument(userDocumentKey(userId), () => ({
        value: { disconnectedAt: new Date(now()).toISOString() },
        result: undefined,
      }));
    } catch (error) {
      if (error?.code === 'NO_TABLE') return;
      throw error;
    }
  }

  return { handle, forgetUser };
}
