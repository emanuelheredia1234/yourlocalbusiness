import crypto from 'node:crypto';
import { serviceHeaders } from './secretBox.mjs';

// Direct publishing for Facebook Pages and Instagram professional accounts.
// Facebook Login connects Pages (and any linked Instagram account); Instagram Login
// also connects professional Instagram accounts that are not linked to a Facebook Page.
export const META_PUBLIC_APP_URL = 'https://yourlocalbusiness.replit.app';
export const META_GRAPH_VERSION = 'v27.0';
export const META_CALLBACKS = {
  facebook: `${META_PUBLIC_APP_URL}/api/integrations/meta/callback/facebook`,
  instagram: `${META_PUBLIC_APP_URL}/api/integrations/meta/callback/instagram`,
};

const PREFIX = '/api/integrations/meta';
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const IG_GRAPH = `https://graph.instagram.com/${META_GRAPH_VERSION}`;
const FB_AUTHORIZE = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
const IG_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN = 'https://api.instagram.com/oauth/access_token';
const OAUTH_DOC = 'meta:oauth:states';
const JOBS_DOC = 'meta:scheduled:jobs';
const OAUTH_TTL = 10 * 60_000;
const COOKIE = '__Host-meta-connect';
const SCOPES_FACEBOOK = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
const SCOPES_INSTAGRAM = ['instagram_business_basic', 'instagram_business_content_publish'];

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const userKey = (id) => `meta:user:${hash(id)}`;
const iso = (ms) => new Date(ms).toISOString();

class MetaError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

function safeError(error) {
  if (error?.code === 'NO_TABLE') return new MetaError(503, 'STORAGE_NOT_READY', 'Secure account storage is not set up. Apply the app_state Supabase migration.');
  if (error?.code === 'UNREADABLE') return new MetaError(503, 'STORAGE_UNREADABLE', 'Secure account storage cannot be read. Check that the Supabase encryption secret has not changed.');
  return new MetaError(503, 'STORAGE_UNAVAILABLE', 'Secure account storage is unavailable. Try again shortly.');
}

function noStore(headers = {}) {
  return { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers };
}

function cookieValue(req) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE}=`));
  return part ? decodeURIComponent(part.slice(COOKIE.length + 1)) : '';
}

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    username: account.username || '',
    login: account.login,
  };
}

export function createMetaSocialRoutes({
  auth,
  storage,
  send,
  readJson,
  sameOrigin = () => true,
  rateLimited = () => false,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const appId = String(env.META_SOCIAL_APP_ID || '').trim();
  const appSecret = String(env.META_SOCIAL_APP_SECRET || '').trim();
  const credentialsConfigured = !!(appId && appSecret);
  const missingCredentials = [
    ...(!appId ? ['META_SOCIAL_APP_ID'] : []),
    ...(!appSecret ? ['META_SOCIAL_APP_SECRET'] : []),
  ];
  const storageReady = storage?.enabled === true;
  const supabaseUrl = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const supabaseSecret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const forgetBackups = new Map();

  async function readDocument(key) {
    try {
      if (!storageReady) throw new MetaError(503, 'STORAGE_NOT_READY', 'Secure Meta account storage needs Supabase server storage.');
      const row = await storage.get(key);
      if (row?.unreadable) throw Object.assign(new Error('Unreadable encrypted value'), { code: 'UNREADABLE' });
      return { value: isObject(row?.value) ? row.value : {}, version: row?.updatedAt ?? null };
    } catch (error) {
      if (error instanceof MetaError) throw error;
      throw safeError(error);
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
        throw safeError(error);
      }
    }
    throw new MetaError(409, 'STORAGE_CONFLICT', 'The account changed in another request. Try again.');
  }

  function reply(req, res, status, body, headers = {}) {
    return send(res, status, body, noStore(headers));
  }

  async function requireUser(req, res) {
    if (!auth?.enabled) {
      reply(req, res, 503, { error: 'Customer sign-in must be enabled before connecting social accounts.', code: 'ACCOUNTS_NOT_CONFIGURED' });
      return null;
    }
    try {
      const who = await auth.identify(req);
      if (!who?.id) {
        reply(req, res, 401, { error: 'Sign in to manage your social accounts.', code: 'AUTH_REQUIRED' });
        return null;
      }
      return who;
    } catch {
      reply(req, res, 503, { error: 'Could not verify your sign-in. Try again shortly.', code: 'AUTH_UNAVAILABLE' });
      return null;
    }
  }

  async function jsonRequest(url, init = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new MetaError(502, 'META_UNAVAILABLE', 'Could not reach Meta. Try again shortly.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !isObject(data)) {
      const code = Number(response.status) === 401 || Number(response.status) === 403 ? 'RECONNECT_REQUIRED' : 'META_REQUEST_FAILED';
      throw new MetaError(502, code, code === 'RECONNECT_REQUIRED'
        ? 'Meta no longer accepts this connection or permission. Reconnect the account.'
        : `Meta could not complete the request (HTTP ${response.status}).`);
    }
    return data;
  }

  function formBody(values) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) body.set(key, String(value));
    return body;
  }

  async function saveStartedState(state, browserSecret, userId, provider) {
    const key = hash(state);
    const item = { userId, provider, browserHash: hash(browserSecret), createdAt: now() };
    await updateDocument(OAUTH_DOC, (current) => {
      const existing = isObject(current.states) ? current.states : {};
      const states = Object.fromEntries(Object.entries(existing).filter(([, v]) => isObject(v) && Number(v.createdAt) > now() - OAUTH_TTL));
      states[key] = item;
      return { value: { states }, result: undefined };
    });
  }

  async function consumeState(rawState, rawCookie) {
    if (!rawState || rawState.length > 256 || !rawCookie || rawCookie.length > 256) return null;
    const key = hash(rawState);
    return updateDocument(OAUTH_DOC, (current) => {
      const states = isObject(current.states) ? current.states : {};
      const item = states[key];
      if (!isObject(item) || now() - Number(item.createdAt) > OAUTH_TTL || !crypto.timingSafeEqual(Buffer.from(item.browserHash || ''), Buffer.from(hash(rawCookie)))) {
        return { write: false, result: null };
      }
      const next = { ...states };
      delete next[key];
      return { value: { states: next }, result: item };
    });
  }

  function redirectOutcome(res, outcome) {
    const url = new URL('/', `${META_PUBLIC_APP_URL}/`);
    url.searchParams.set('meta', outcome);
    url.hash = 'workspace-settings';
    res.writeHead(303, noStore({
      location: url.toString(),
      'set-cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    }));
    res.end();
  }

  async function connect(req, res, user, provider) {
    if (!credentialsConfigured) throw new MetaError(503, 'CREDENTIALS_NOT_CONFIGURED', `Add ${missingCredentials.join(' and ')} in Replit Secrets after creating the Meta developer app.`);
    if (!storageReady) throw new MetaError(503, 'STORAGE_NOT_READY', 'Secure social-account storage is not configured. Check the Supabase server secret and app_state migration.');
    if (req.headers.origin !== META_PUBLIC_APP_URL) {
      throw new MetaError(400, 'USE_PUBLISHED_APP', `Start account connection from ${META_PUBLIC_APP_URL} so Meta returns to the same app.`);
    }
    const browserSecret = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    const callback = META_CALLBACKS[provider];
    await saveStartedState(state, browserSecret, user.id, provider);
    const url = new URL(provider === 'facebook' ? FB_AUTHORIZE : IG_AUTHORIZE);
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', callback);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    if (provider === 'facebook') {
      url.searchParams.set('scope', SCOPES_FACEBOOK.join(','));
    } else {
      url.searchParams.set('scope', SCOPES_INSTAGRAM.join(','));
      url.searchParams.set('enable_fb_login', '0');
      url.searchParams.set('force_authentication', '1');
    }
    return reply(req, res, 200, { authorizationUrl: url.toString() }, {
      'set-cookie': `${COOKIE}=${encodeURIComponent(browserSecret)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    });
  }

  async function exchangeFacebook(code) {
    const shortUrl = new URL(`${GRAPH}/oauth/access_token`);
    Object.entries({ client_id: appId, client_secret: appSecret, redirect_uri: META_CALLBACKS.facebook, code }).forEach(([k, v]) => shortUrl.searchParams.set(k, v));
    const short = await jsonRequest(shortUrl);
    const longUrl = new URL(`${GRAPH}/oauth/access_token`);
    Object.entries({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token }).forEach(([k, v]) => longUrl.searchParams.set(k, v));
    return jsonRequest(longUrl);
  }

  async function facebookAccounts(code) {
    const token = await exchangeFacebook(code);
    if (typeof token.access_token !== 'string') throw new MetaError(502, 'TOKEN_EXCHANGE_FAILED', 'Meta did not return a Facebook access token.');
    const pagesUrl = new URL(`${GRAPH}/me/accounts`);
    pagesUrl.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username}');
    pagesUrl.searchParams.set('access_token', token.access_token);
    const result = await jsonRequest(pagesUrl);
    const accounts = [];
    for (const page of Array.isArray(result.data) ? result.data : []) {
      if (typeof page.id !== 'string' || typeof page.access_token !== 'string') continue;
      accounts.push({ id: page.id, name: typeof page.name === 'string' ? page.name : 'Facebook Page', kind: 'facebook_page', login: 'facebook', accessToken: page.access_token, connectedAt: iso(now()) });
      if (isObject(page.instagram_business_account) && typeof page.instagram_business_account.id === 'string') {
        accounts.push({ id: page.instagram_business_account.id, name: page.instagram_business_account.username || 'Instagram professional account', username: page.instagram_business_account.username || '', kind: 'instagram', login: 'facebook', accessToken: page.access_token, pageId: page.id, connectedAt: iso(now()) });
      }
    }
    return accounts;
  }

  async function instagramAccount(code) {
    const body = formBody({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: META_CALLBACKS.instagram,
      code,
    });
    const short = await jsonRequest(IG_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (typeof short.access_token !== 'string') throw new MetaError(502, 'TOKEN_EXCHANGE_FAILED', 'Instagram did not return an access token.');
    const longUrl = new URL(`${IG_GRAPH}/access_token`);
    longUrl.searchParams.set('grant_type', 'ig_exchange_token');
    longUrl.searchParams.set('client_secret', appSecret);
    longUrl.searchParams.set('access_token', short.access_token);
    const token = await jsonRequest(longUrl);
    const meUrl = new URL(`${IG_GRAPH}/me`);
    meUrl.searchParams.set('fields', 'user_id,username');
    meUrl.searchParams.set('access_token', token.access_token);
    const me = await jsonRequest(meUrl);
    const id = typeof me.user_id === 'string' ? me.user_id : typeof me.id === 'string' ? me.id : '';
    if (!id || typeof token.access_token !== 'string') throw new MetaError(502, 'ACCOUNT_LOOKUP_FAILED', 'Instagram did not return a professional account.');
    return {
      id,
      name: typeof me.username === 'string' ? `@${me.username}` : 'Instagram professional account',
      username: typeof me.username === 'string' ? me.username : '',
      kind: 'instagram',
      login: 'instagram',
      accessToken: token.access_token,
      expiresAt: now() + Number(token.expires_in || 5_183_940) * 1000,
      connectedAt: iso(now()),
    };
  }

  async function callback(req, res, url, provider) {
    try {
      const state = await consumeState(url.searchParams.get('state') || '', cookieValue(req));
      if (!state || state.provider !== provider) return redirectOutcome(res, 'invalid_state');
      if (url.searchParams.has('error')) return redirectOutcome(res, url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'error');
      const code = url.searchParams.get('code') || '';
      if (!code || code.length > 2048 || !credentialsConfigured) return redirectOutcome(res, 'setup');
      const accounts = provider === 'facebook' ? await facebookAccounts(code) : [await instagramAccount(code)];
      if (!accounts.length) return redirectOutcome(res, 'no_accounts');
      await updateDocument(userKey(state.userId), (current) => {
        const existing = Array.isArray(current.accounts) ? current.accounts : [];
        const next = existing.filter((a) => !accounts.some((x) => x.kind === a.kind && x.id === a.id));
        return { value: { accounts: [...next, ...accounts] }, result: undefined };
      });
      return redirectOutcome(res, 'connected');
    } catch {
      return redirectOutcome(res, 'error');
    }
  }

  async function currentAccounts(userId) {
    const { value } = await readDocument(userKey(userId));
    return Array.isArray(value.accounts) ? value.accounts.filter((a) => isObject(a) && typeof a.id === 'string' && typeof a.accessToken === 'string') : [];
  }

  async function status(req, res, user) {
    let accounts = [];
    let storageAvailable = storageReady;
    if (storageReady) {
      try {
        accounts = (await currentAccounts(user.id)).map(publicAccount);
      } catch (error) {
        if (credentialsConfigured) throw error;
        storageAvailable = false;
      }
    }
    return reply(req, res, 200, { credentialsConfigured, missingCredentials, storageReady: storageAvailable, accounts, owner: !!user.isAdmin });
  }

  async function signedMediaUrl(userId, mediaId) {
    if (!supabaseUrl || !supabaseSecret) throw new MetaError(503, 'MEDIA_STORAGE_UNAVAILABLE', 'Supabase media storage is not configured for direct posting.');
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(mediaId)) throw new MetaError(400, 'INVALID_MEDIA', 'The selected post media is not valid.');
    const path = `${encodeURIComponent(userId)}/${encodeURIComponent(mediaId)}`;
    let response;
    try {
      response = await fetchImpl(`${supabaseUrl}/storage/v1/object/sign/media/${path}`, {
        method: 'POST',
        headers: {
          ...serviceHeaders(supabaseSecret),
        },
        body: JSON.stringify({ expiresIn: 1800 }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new MetaError(502, 'MEDIA_SIGN_FAILED', 'Could not prepare the post media for Meta.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.signedURL !== 'string') throw new MetaError(502, 'MEDIA_SIGN_FAILED', 'Could not prepare the post media for Meta.');
    return new URL(data.signedURL, `${supabaseUrl}/storage/v1/`).toString();
  }

  async function graphPost(url, accessToken) {
    const body = new URLSearchParams();
    body.set('access_token', accessToken);
    for (const [key, value] of Object.entries(url.body || {})) if (value !== undefined && value !== '') body.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new MetaError(502, 'PUBLISH_UNCERTAIN', 'The publish request timed out. Check the social account before trying again.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !isObject(data)) throw new MetaError(502, 'PUBLISH_FAILED', `Meta did not publish the post (HTTP ${response.status}).`);
    return data;
  }

  async function publishNow(userId, job) {
    const accounts = await currentAccounts(userId);
    let account = accounts.find((x) => x.kind === job.platform && x.id === job.accountId);
    if (!account) throw new MetaError(409, 'ACCOUNT_NOT_CONNECTED', 'Reconnect or choose a connected Meta account.');
    if (account.login === 'instagram' && Number(account.expiresAt) < now() + 7 * 24 * 60 * 60_000) {
      const refreshUrl = new URL('https://graph.instagram.com/refresh_access_token');
      refreshUrl.searchParams.set('grant_type', 'ig_refresh_token');
      refreshUrl.searchParams.set('access_token', account.accessToken);
      const refreshed = await jsonRequest(refreshUrl);
      if (typeof refreshed.access_token !== 'string') throw new MetaError(409, 'RECONNECT_REQUIRED', 'Instagram needs to be reconnected before publishing.');
      account = {
        ...account,
        accessToken: refreshed.access_token,
        expiresAt: now() + Number(refreshed.expires_in || 5_183_940) * 1000,
      };
      const updatedAccount = account;
      await updateDocument(userKey(userId), (current) => ({
        value: { accounts: (Array.isArray(current.accounts) ? current.accounts : []).map((a) => a.id === updatedAccount.id && a.login === 'instagram' ? updatedAccount : a) },
        result: undefined,
      }));
    }
    const mediaUrl = job.mediaId ? await signedMediaUrl(userId, job.mediaId) : '';
    if (job.platform === 'instagram' && !mediaUrl) throw new MetaError(400, 'INSTAGRAM_MEDIA_REQUIRED', 'Instagram posts need an image or video.');
    if (job.platform === 'facebook_page') {
      const endpoint = `${GRAPH}/${encodeURIComponent(account.id)}/${job.mediaKind === 'video' ? 'videos' : mediaUrl ? 'photos' : 'feed'}`;
      const body = job.mediaKind === 'video'
        ? { file_url: mediaUrl, description: job.caption }
        : mediaUrl
          ? { url: mediaUrl, caption: job.caption }
          : { message: job.caption };
      const out = await graphPost({ endpoint, body }, account.accessToken);
      return { id: typeof out.id === 'string' ? out.id : '' };
    }
    const video = job.mediaKind === 'video';
    const containerUrl = new URL(`${IG_GRAPH}/${encodeURIComponent(account.id)}/media`);
    const container = await graphPost({
      endpoint: containerUrl.toString(),
      body: { ...(video ? { media_type: 'REELS', video_url: mediaUrl } : { image_url: mediaUrl }), caption: job.caption },
    }, account.accessToken);
    if (typeof container.id !== 'string') throw new MetaError(502, 'MEDIA_CONTAINER_FAILED', 'Instagram did not create a media container.');
    if (video) {
      const deadline = Date.now() + 90_000;
      let ready = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const check = new URL(`${IG_GRAPH}/${encodeURIComponent(container.id)}`);
        check.searchParams.set('fields', 'status_code');
        check.searchParams.set('access_token', account.accessToken);
        const state = await jsonRequest(check);
        if (state.status_code === 'FINISHED') { ready = true; break; }
        if (state.status_code === 'ERROR' || state.status_code === 'EXPIRED') break;
      }
      if (!ready) throw new MetaError(502, 'INSTAGRAM_MEDIA_PROCESSING', 'Instagram could not finish processing the video. Check the post before retrying.');
    }
    const published = await graphPost({
      endpoint: `${IG_GRAPH}/${encodeURIComponent(account.id)}/media_publish`,
      body: { creation_id: container.id },
    }, account.accessToken);
    return { id: typeof published.id === 'string' ? published.id : '' };
  }

  async function queueChange(change) {
    return updateDocument(JOBS_DOC, (current) => {
      const jobs = Array.isArray(current.jobs) ? current.jobs.filter((j) => isObject(j)) : [];
      const result = change(jobs);
      if (result?.write === false) return result;
      return { value: { jobs: result.jobs.slice(-2000) }, result: result.result };
    });
  }

  async function publish(req, res, user) {
    const body = await readJson(req, res);
    if (!body) return true;
    const platform = body.platform === 'facebook_page' ? 'facebook_page' : body.platform === 'instagram' ? 'instagram' : '';
    const accountId = typeof body.accountId === 'string' ? body.accountId.slice(0, 100) : '';
    const caption = typeof body.caption === 'string' ? body.caption.trim().slice(0, 2200) : '';
    const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
    const mediaKind = body.mediaKind === 'video' ? 'video' : 'image';
    const scheduledAt = typeof body.scheduledAt === 'string' ? Date.parse(body.scheduledAt) : 0;
    if (body.scheduledAt && !Number.isFinite(scheduledAt)) throw new MetaError(400, 'INVALID_SCHEDULE', 'Choose a valid publish time.');
    if (!platform || !accountId || !caption) throw new MetaError(400, 'INVALID_POST', 'Choose a connected account and enter post text.');
    const accounts = await currentAccounts(user.id);
    if (!accounts.some((x) => x.kind === platform && x.id === accountId)) throw new MetaError(403, 'ACCOUNT_NOT_CONNECTED', 'That social account is not connected to your profile.');
    const post = {
      id: crypto.randomUUID(),
      postId: typeof body.postId === 'string' ? body.postId.slice(0, 128) : '',
      userId: user.id,
      platform,
      accountId,
      caption,
      mediaId,
      mediaKind,
      scheduledAt: scheduledAt || now(),
    };
    if (scheduledAt && scheduledAt > now() + 30_000) {
      if (scheduledAt > now() + 90 * 24 * 60 * 60_000) throw new MetaError(400, 'SCHEDULE_TOO_FAR', 'Schedule the post within the next 90 days.');
      await queueChange((jobs) => {
        if (jobs.filter((j) => j.status === 'scheduled').length >= 500) throw new MetaError(429, 'QUEUE_FULL', 'The scheduled-post queue is full. Try again after some posts are published.');
        jobs.push({ ...post, status: 'scheduled', createdAt: now() });
        return { jobs, result: undefined };
      });
      return reply(req, res, 202, { jobId: post.id, status: 'scheduled', scheduledAt: iso(scheduledAt) });
    }
    const result = await publishNow(user.id, post);
    return reply(req, res, 201, { status: 'published', postId: result.id });
  }

  async function jobsStatus(req, res, user) {
    const { value } = await readDocument(JOBS_DOC);
    const jobs = (Array.isArray(value.jobs) ? value.jobs : []).filter((j) => j.userId === user.id).map(({ id, postId, platform, accountId, status, scheduledAt, publishedAt, error }) => ({ id, postId, platform, accountId, status, scheduledAt, publishedAt, error: error || '' }));
    return reply(req, res, 200, { jobs });
  }

  async function cancelJob(req, res, user, url) {
    const id = url.pathname.split('/').pop();
    const found = await queueChange((jobs) => {
      const job = jobs.find((x) => x.id === id && x.userId === user.id);
      if (!job) return { write: false, result: 'missing' };
      if (job.status !== 'scheduled') return { write: false, result: 'busy' };
      job.status = 'cancelled';
      return { jobs, result: 'cancelled' };
    });
    if (found === 'missing') throw new MetaError(404, 'JOB_NOT_FOUND', 'Scheduled post not found.');
    if (found === 'busy') throw new MetaError(409, 'JOB_ALREADY_STARTED', 'This post has already started publishing and cannot be cancelled.');
    return reply(req, res, 200, { status: 'cancelled' });
  }

  let workerTimer = null;
  let workerBusy = false;
  async function runOneDueJob() {
    if (workerBusy || !storageReady || !credentialsConfigured) return;
    workerBusy = true;
    let job = null;
    try {
      job = await queueChange((jobs) => {
        const expired = jobs.find((j) => j.status === 'publishing' && Number(j.lockUntil) <= now());
        if (expired) {
          expired.status = 'uncertain';
          expired.error = 'The server stopped during publishing. Check the social account before retrying.';
          expired.lockUntil = 0;
          return { jobs, result: null };
        }
        const item = jobs.find((j) => j.status === 'scheduled' && Number(j.scheduledAt) <= now());
        if (!item) return { write: false, result: null };
        item.status = 'publishing';
        item.lockUntil = now() + 120_000;
        return { jobs, result: { ...item } };
      });
      if (!job) return;
      const result = await publishNow(job.userId, job);
      await queueChange((jobs) => {
        const item = jobs.find((j) => j.id === job.id);
        if (item) Object.assign(item, { status: 'published', publishedAt: now(), providerPostId: result.id || '', lockUntil: 0 });
        return { jobs, result: undefined };
      });
    } catch (error) {
      if (job) {
        await queueChange((jobs) => {
          const item = jobs.find((j) => j.id === job.id);
          if (item) Object.assign(item, { status: error?.code === 'PUBLISH_UNCERTAIN' ? 'uncertain' : 'failed', error: error?.publicMessage || 'Meta could not publish the scheduled post.', lockUntil: 0 });
          return { jobs, result: undefined };
        }).catch(() => {});
      }
    } finally {
      workerBusy = false;
    }
  }

  async function forgetUser(userId) {
    if (!userId || !storageReady) return;
    const connection = await readDocument(userKey(userId));
    const queue = await readDocument(JOBS_DOC);
    forgetBackups.set(userId, {
      connection: connection.value,
      jobs: (Array.isArray(queue.value.jobs) ? queue.value.jobs : []).filter((job) => job.userId === userId),
    });
    await updateDocument(userKey(userId), () => ({ value: { disconnectedAt: iso(now()) }, result: undefined }));
    await queueChange((jobs) => {
      for (const job of jobs) if (job.userId === userId && job.status === 'scheduled') job.status = 'cancelled';
      return { jobs, result: undefined };
    });
  }

  async function unforgetUser(userId) {
    const backup = forgetBackups.get(userId);
    if (!backup) return;
    await storage.put(userKey(userId), backup.connection);
    await queueChange((jobs) => {
      const existing = new Set(jobs.map((job) => job.id));
      for (const job of backup.jobs) if (!existing.has(job.id)) jobs.push(job);
      return { jobs, result: undefined };
    });
    forgetBackups.delete(userId);
  }

  function finishForgetUser(userId) {
    forgetBackups.delete(userId);
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith(`${PREFIX}/`)) return false;
    const callbackProvider = path === `${PREFIX}/callback/facebook` ? 'facebook' : path === `${PREFIX}/callback/instagram` ? 'instagram' : '';
    if (callbackProvider && req.method === 'GET') return callback(req, res, url, callbackProvider);
    if (!sameOrigin(req)) return reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
    try {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (path === `${PREFIX}/status` && req.method === 'GET') return await status(req, res, user);
      if (path === `${PREFIX}/connect/facebook` && req.method === 'POST') {
        if (rateLimited(`meta-connect:${user.id}`)) return reply(req, res, 429, { error: 'Please wait before connecting another Meta account.', code: 'RATE_LIMITED' });
        await connect(req, res, user, 'facebook');
        return true;
      }
      if (path === `${PREFIX}/connect/instagram` && req.method === 'POST') {
        if (rateLimited(`meta-connect:${user.id}`)) return reply(req, res, 429, { error: 'Please wait before connecting another Meta account.', code: 'RATE_LIMITED' });
        await connect(req, res, user, 'instagram');
        return true;
      }
      if (path === `${PREFIX}/publish` && req.method === 'POST') return await publish(req, res, user);
      if (path === `${PREFIX}/jobs` && req.method === 'GET') return await jobsStatus(req, res, user);
      if (path.startsWith(`${PREFIX}/jobs/`) && req.method === 'DELETE') return await cancelJob(req, res, user, url);
      if (path.startsWith(`${PREFIX}/accounts/`) && req.method === 'DELETE') {
        const id = decodeURIComponent(path.slice(`${PREFIX}/accounts/`.length));
        await updateDocument(userKey(user.id), (current) => ({ value: { accounts: (Array.isArray(current.accounts) ? current.accounts : []).filter((a) => a.id !== id) }, result: undefined }));
        return reply(req, res, 200, { ok: true });
      }
      return reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return reply(req, res, status, { error: error?.publicMessage || 'Meta could not complete the request. Try again shortly.', code: error?.code || 'META_ERROR' });
    }
  }

  function startWorker() {
    if (workerTimer) return () => clearInterval(workerTimer);
    workerTimer = setInterval(() => { void runOneDueJob(); }, 15_000);
    workerTimer.unref?.();
    return () => {
      if (workerTimer) clearInterval(workerTimer);
      workerTimer = null;
    };
  }

  return { handle, startWorker, forgetUser, unforgetUser, finishForgetUser };
}
