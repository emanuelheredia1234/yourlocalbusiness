// A stand-in for a Supabase project, for tests and offline QA: Auth (email + password, email
// confirmation and password recovery with PKCE links, ES256 tokens and a JWKS), a PostgREST subset
// with per-user row security, and a Storage subset with per-user folders. The browser app can use
// it through supabase-js exactly as it would a real project.
//
//   node server/test/mock-supabase.mjs [port]   → prints { url, publishableKey, secretKey }

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const PUBLISHABLE = 'sb_publishable_mock_123';
const SECRET = 'sb_secret_mock_456';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Primary keys per table: rows with the same values are one row (upserts replace them). */
const PRIMARY_KEYS = { user_docs: ['user_id', 'kind', 'id'], user_secrets: ['user_id', 'provider'] };
/** tables with row-level security and no policies: only the secret key reaches them */
const SERVICE_ONLY = new Set(['user_secrets']);

export async function createMockSupabase({ confirmEmail = true, tokenTtl = 3600 } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = 'mock-key-1';
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const users = new Map(); // id → user
  const refresh = new Map(); // refresh token → user id
  const codes = new Map(); // auth code → { userId, challenge, method, type }
  const emails = []; // { to, type, link }
  const tables = new Map(); // table → rows[]
  const objects = new Map(); // `${bucket}/${path}` → { bytes, type, created }
  const calls = [];
  const behavior = { down: false };
  let server;
  let base = '';

  const issuer = () => `${base}/auth/v1`;
  const userJson = (u) => ({
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.confirmed_at,
    confirmation_sent_at: u.confirmation_sent_at ?? null,
    confirmed_at: u.confirmed_at,
    created_at: u.created_at,
    updated_at: u.updated_at,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    is_anonymous: false,
  });

  async function session(u) {
    const now = Math.floor(Date.now() / 1000);
    const access_token = await new SignJWT({ email: u.email, role: 'authenticated', aal: 'aal1', session_id: crypto.randomUUID(), is_anonymous: false })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setSubject(u.id)
      .setIssuer(issuer())
      .setAudience('authenticated')
      .setIssuedAt(now)
      .setExpirationTime(now + tokenTtl)
      .sign(privateKey);
    const refresh_token = b64url(crypto.randomBytes(24));
    refresh.set(refresh_token, u.id);
    return { access_token, token_type: 'bearer', expires_in: tokenTtl, expires_at: now + tokenTtl, refresh_token, user: userJson(u) };
  }

  /** Who a request is: { userId } for a valid user token, { service: true } for the secret key, else null. */
  async function caller(req) {
    const key = req.headers.apikey || '';
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
    if (key === SECRET && (!auth || auth === SECRET)) return { service: true };
    if (!auth || auth === PUBLISHABLE) return { anon: true };
    try {
      const { jwtVerify } = await import('jose');
      const { payload } = await jwtVerify(auth, publicKey, { issuer: issuer(), audience: 'authenticated' });
      return users.has(payload.sub) ? { userId: payload.sub } : null;
    } catch {
      return null;
    }
  }

  function send(res, status, body, headers = {}) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, x-client-info' };
    if (body === undefined) {
      res.writeHead(status, { ...cors, ...headers });
      return res.end();
    }
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, { ...cors, ...headers });
      return res.end(body);
    }
    res.writeHead(status, { 'content-type': 'application/json', ...cors, ...headers });
    res.end(JSON.stringify(body));
  }
  const authError = (res, status, error_code, msg) => send(res, status, { code: status, error_code, msg });

  function mail(to, type, user, redirectTo, challenge, method) {
    const token = b64url(crypto.randomBytes(16));
    codes.set(`verify:${token}`, { userId: user.id, type, redirectTo, challenge, method });
    const link = `${base}/auth/v1/verify?token=${token}&type=${type}&redirect_to=${encodeURIComponent(redirectTo || '')}`;
    emails.push({ to: user.email, type, link, at: Date.now() });
    if (type === 'signup') user.confirmation_sent_at = new Date().toISOString();
  }

  // ───────────── PostgREST subset ─────────────

  function parseFilter(raw) {
    const [op, ...rest] = raw.split('.');
    const value = rest.join('.');
    if (op === 'in') return { op, value: value.replace(/^\(|\)$/g, '').split(',').map((v) => decodeURIComponent(v).replace(/^"|"$/g, '')) };
    return { op, value: decodeURIComponent(value) };
  }

  function matches(row, filters) {
    return filters.every(([col, f]) => {
      const v = row[col];
      if (f.op === 'eq') return String(v) === f.value;
      if (f.op === 'neq') return String(v) !== f.value;
      if (f.op === 'in') return f.value.includes(String(v));
      if (f.op === 'gt') return String(v) > f.value;
      if (f.op === 'gte') return String(v) >= f.value;
      if (f.op === 'is') return f.value === 'null' ? v == null : String(v) === f.value;
      return true;
    });
  }

  function project(row, select) {
    if (!select || select === '*') return { ...row };
    const out = {};
    for (const c of select.split(',').map((s) => s.trim()).filter(Boolean)) out[c] = row[c];
    return out;
  }

  async function rest(req, res, url, table, raw) {
    const who = await caller(req);
    if (!who) return send(res, 401, { code: 'PGRST301', message: 'JWT expired or invalid' });
    if (who.anon || (SERVICE_ONLY.has(table) && !who.service)) return send(res, 401, { code: '42501', message: 'permission denied for table ' + table });
    const rows = tables.get(table) ?? [];
    tables.set(table, rows);
    const visible = (r) => who.service || r.user_id === who.userId;
    const filters = [];
    for (const [k, v] of url.searchParams) if (!['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) filters.push([k, parseFilter(v)]);
    const prefer = String(req.headers.prefer || '');

    if (req.method === 'GET' || req.method === 'HEAD') {
      let out = rows.filter((r) => visible(r) && matches(r, filters));
      const order = url.searchParams.get('order');
      if (order) {
        const keys = order.split(',').map((o) => o.split('.'));
        out = [...out].sort((a, b) => {
          for (const [col, dir] of keys) {
            const c = (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1);
            if (c) return c;
          }
          return 0;
        });
      }
      let offset = Number(url.searchParams.get('offset') || 0);
      let limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 1000;
      const range = /^(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
      if (range) {
        offset = Number(range[1]);
        limit = Number(range[2]) - offset + 1;
      }
      limit = Math.min(limit, 1000); // PostgREST's usual max-rows
      const total = out.length;
      out = out.slice(offset, offset + limit).map((r) => project(r, url.searchParams.get('select')));
      return send(res, 200, out, { 'content-range': `${offset}-${offset + out.length - 1}/${total}` });
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(raw || 'null');
      } catch {
        return send(res, 400, { message: 'invalid json' });
      }
      const items = Array.isArray(body) ? body : [body];
      const pk = (url.searchParams.get('on_conflict') || '').split(',').filter(Boolean);
      const keyCols = pk.length ? pk : PRIMARY_KEYS[table] ?? ['id'];
      const upsert = /resolution=merge-duplicates/.test(prefer);
      const written = [];
      for (const item of items) {
        if (!who.service && item.user_id !== who.userId) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy for table "' + table + '"' });
        const row = { ...item, updated_at: new Date().toISOString() };
        const i = rows.findIndex((r) => keyCols.every((c) => r[c] === row[c]));
        if (i >= 0) {
          if (!upsert) return send(res, 409, { code: '23505', message: 'duplicate key value violates unique constraint' });
          rows[i] = { ...rows[i], ...row };
          written.push(rows[i]);
        } else {
          rows.push(row);
          written.push(row);
        }
      }
      return /return=representation/.test(prefer) ? send(res, 201, written.map((r) => project(r, url.searchParams.get('select')))) : send(res, 201, undefined);
    }

    if (req.method === 'PATCH') {
      const patch = JSON.parse(raw || '{}');
      const hit = rows.filter((r) => visible(r) && matches(r, filters));
      for (const r of hit) Object.assign(r, patch, { updated_at: new Date().toISOString() });
      return /return=representation/.test(prefer) ? send(res, 200, hit) : send(res, 204, undefined);
    }

    if (req.method === 'DELETE') {
      const keep = [];
      const gone = [];
      for (const r of rows) (visible(r) && matches(r, filters) ? gone : keep).push(r);
      tables.set(table, keep);
      return /return=representation/.test(prefer) ? send(res, 200, gone) : send(res, 204, undefined);
    }
    return send(res, 405, { message: 'method not allowed' });
  }

  // ───────────── Storage subset ─────────────

  async function storage(req, res, url, rawBuf) {
    const who = await caller(req);
    if (!who || who.anon) return send(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'Invalid JWT' });
    const own = (path) => who.service || path.split('/')[0] === who.userId;
    const p = url.pathname.replace(/^\/storage\/v1/, '');
    let m = /^\/object\/list\/([^/]+)$/.exec(p);
    if (m && req.method === 'POST') {
      const { prefix = '', limit = 100, offset = 0 } = JSON.parse(rawBuf.toString() || '{}');
      const dir = prefix.replace(/\/+$/, '');
      const names = [...objects.keys()]
        .filter((k) => k.startsWith(`${m[1]}/${dir}/`) && own(k.slice(m[1].length + 1)))
        .map((k) => k.slice(m[1].length + 1 + dir.length + 1))
        .filter((n) => !n.includes('/'));
      return send(res, 200, names.slice(offset, offset + limit).map((name) => ({ name, id: name, metadata: { size: objects.get(`${m[1]}/${dir}/${name}`).bytes.length } })));
    }
    m = /^\/object\/([^/]+)$/.exec(p);
    if (m && req.method === 'DELETE') {
      const { prefixes = [] } = JSON.parse(rawBuf.toString() || '{}');
      const removed = [];
      for (const path of prefixes) {
        if (!own(path)) continue;
        if (objects.delete(`${m[1]}/${path}`)) removed.push({ name: path });
      }
      return send(res, 200, removed);
    }
    m = /^\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/.exec(p);
    if (m) {
      const [, bucket, path] = m;
      const key = `${bucket}/${decodeURIComponent(path)}`;
      if (!own(decodeURIComponent(path))) return send(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (req.method === 'POST' || req.method === 'PUT') {
        if (objects.has(key) && req.headers['x-upsert'] !== 'true' && req.method === 'POST') return send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        if (rawBuf.length > 50 * 1024 * 1024) return send(res, 413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
        let bytes = rawBuf;
        let type = String(req.headers['content-type'] || 'application/octet-stream');
        // supabase-js sends Blobs and Files as multipart form data: keep the file part
        if (/^multipart\/form-data/i.test(type)) {
          const form = await new Response(rawBuf, { headers: { 'content-type': type } }).formData();
          const file = [...form.values()].find((v) => typeof v !== 'string');
          if (!file) return send(res, 400, { statusCode: '400', error: 'Bad request', message: 'no file in the form' });
          bytes = Buffer.from(await file.arrayBuffer());
          type = file.type || 'application/octet-stream';
        }
        objects.set(key, { bytes, type, created: Date.now() });
        return send(res, 200, { Key: key, Id: crypto.randomUUID() });
      }
      if (req.method === 'GET') {
        const o = objects.get(key);
        if (!o) return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        return send(res, 200, o.bytes, { 'content-type': o.type, 'content-length': o.bytes.length });
      }
    }
    return send(res, 404, { message: 'mock storage: no route ' + p });
  }

  // ───────────── Auth ─────────────

  async function authRoute(req, res, url, raw) {
    const p = url.pathname.replace(/^\/auth\/v1/, '');
    const body = (() => {
      try {
        return JSON.parse(raw || '{}');
      } catch {
        return {};
      }
    })();

    if (p === '/.well-known/jwks.json') return send(res, 200, { keys: [jwk] });
    if (p === '/settings') return send(res, 200, { external: { email: true }, disable_signup: false, mailer_autoconfirm: !confirmEmail });

    if (p === '/signup' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return authError(res, 400, 'validation_failed', 'Unable to validate email address: invalid format');
      if (String(body.password || '').length < 6) return authError(res, 422, 'weak_password', 'Password should be at least 6 characters.');
      const existing = [...users.values()].find((u) => u.email === email);
      if (existing?.confirmed_at) return authError(res, 422, 'user_already_exists', 'User already registered');
      const now = new Date().toISOString();
      const u = existing ?? { id: crypto.randomUUID(), email, created_at: now };
      Object.assign(u, { password: body.password, updated_at: now, confirmed_at: confirmEmail ? null : now });
      users.set(u.id, u);
      if (!confirmEmail) return send(res, 200, await session(u));
      mail(email, 'signup', u, url.searchParams.get('redirect_to') || '', body.code_challenge, body.code_challenge_method);
      return send(res, 200, userJson(u));
    }

    if (p === '/resend' && req.method === 'POST') {
      const u = [...users.values()].find((x) => x.email === String(body.email || '').toLowerCase());
      if (u && !u.confirmed_at) mail(u.email, 'signup', u, url.searchParams.get('redirect_to') || '', body.code_challenge, body.code_challenge_method);
      return send(res, 200, {});
    }

    if (p === '/recover' && req.method === 'POST') {
      const u = [...users.values()].find((x) => x.email === String(body.email || '').toLowerCase());
      if (u) mail(u.email, 'recovery', u, url.searchParams.get('redirect_to') || '', body.code_challenge, body.code_challenge_method);
      return send(res, 200, {});
    }

    if (p === '/verify' && req.method === 'GET') {
      const v = codes.get(`verify:${url.searchParams.get('token')}`);
      if (!v) return send(res, 303, undefined, { location: `${url.searchParams.get('redirect_to') || base}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` });
      codes.delete(`verify:${url.searchParams.get('token')}`);
      const u = users.get(v.userId);
      if (v.type === 'signup') u.confirmed_at = u.confirmed_at || new Date().toISOString();
      const target = new URL(v.redirectTo || base);
      if (v.challenge) {
        const code = crypto.randomUUID();
        codes.set(`pkce:${code}`, { userId: u.id, challenge: v.challenge, method: v.method, type: v.type });
        target.searchParams.set('code', code);
        return send(res, 303, undefined, { location: target.toString() });
      }
      const s = await session(u);
      return send(res, 303, undefined, { location: `${target.toString()}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=${s.expires_in}&token_type=bearer&type=${v.type}` });
    }

    if (p === '/token' && req.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const u = [...users.values()].find((x) => x.email === String(body.email || '').toLowerCase());
        if (!u || u.password !== body.password) return authError(res, 400, 'invalid_credentials', 'Invalid login credentials');
        if (!u.confirmed_at) return authError(res, 400, 'email_not_confirmed', 'Email not confirmed');
        return send(res, 200, await session(u));
      }
      if (grant === 'refresh_token') {
        const id = refresh.get(body.refresh_token);
        if (!id || !users.has(id)) return authError(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        refresh.delete(body.refresh_token);
        return send(res, 200, await session(users.get(id)));
      }
      if (grant === 'pkce') {
        const c = codes.get(`pkce:${body.auth_code}`);
        if (!c) return authError(res, 400, 'flow_state_not_found', 'invalid flow state, no valid flow state found');
        const verifier = String(body.code_verifier || '');
        const challenge = c.method === 'plain' ? verifier : b64url(crypto.createHash('sha256').update(verifier).digest());
        if (challenge !== c.challenge) return authError(res, 400, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
        codes.delete(`pkce:${body.auth_code}`);
        return send(res, 200, await session(users.get(c.userId)));
      }
      return authError(res, 400, 'unsupported_grant_type', 'unsupported grant type');
    }

    if (p === '/user') {
      const who = await caller(req);
      if (!who?.userId) return authError(res, 401, 'bad_jwt', 'invalid JWT');
      const u = users.get(who.userId);
      if (req.method === 'GET') return send(res, 200, userJson(u));
      if (req.method === 'PUT') {
        if (body.password) {
          if (String(body.password).length < 6) return authError(res, 422, 'weak_password', 'Password should be at least 6 characters.');
          if (body.password === u.password) return authError(res, 422, 'same_password', 'New password should be different from the old password.');
          u.password = body.password;
        }
        u.updated_at = new Date().toISOString();
        return send(res, 200, userJson(u));
      }
    }

    if (p === '/logout' && req.method === 'POST') return send(res, 204, undefined);

    const adminUser = /^\/admin\/users\/([0-9a-f-]{36})$/.exec(p);
    if (adminUser && req.method === 'DELETE') {
      const who = await caller(req);
      if (!who?.service) return authError(res, 403, 'not_admin', 'User not allowed');
      users.delete(adminUser[1]);
      for (const [t, rows] of tables) tables.set(t, rows.filter((r) => r.user_id !== adminUser[1])); // on delete cascade
      return send(res, 200, {});
    }

    return authError(res, 404, 'not_found', 'mock auth: no route ' + p);
  }

  function handle(req, res, rawBuf) {
    const url = new URL(req.url, 'http://mock');
    const raw = rawBuf.toString('utf8');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw.length < 20000 ? raw : `<${raw.length} bytes>` });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    if (url.pathname === '/__mock/emails') return send(res, 200, emails.filter((e) => !url.searchParams.get('to') || e.to === url.searchParams.get('to')));
    if (behavior.down) return send(res, 503, { message: 'mock outage' });
    if (url.pathname.startsWith('/auth/v1/')) return void authRoute(req, res, url, raw);
    const t = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (t) return void rest(req, res, url, t[1], raw);
    if (url.pathname.startsWith('/storage/v1/')) return void storage(req, res, url, rawBuf);
    return send(res, 404, { message: 'mock: no route ' + url.pathname });
  }

  return {
    PUBLISHABLE,
    SECRET,
    users,
    tables,
    objects,
    emails,
    calls,
    behavior,
    get url() {
      return base;
    },
    /** A valid access token for a user (creating a confirmed user if needed). */
    /** autoconfirmed: made while "Confirm email" was off (no confirmation email was ever sent) */
    async tokenFor(email, password = 'password123', { autoconfirmed = false } = {}) {
      let u = [...users.values()].find((x) => x.email === email);
      if (!u) {
        const now = new Date().toISOString();
        const sent = new Date(Date.now() - 60_000).toISOString();
        u = { id: crypto.randomUUID(), email, password, created_at: sent, updated_at: now, confirmed_at: now, confirmation_sent_at: autoconfirmed ? null : sent };
        users.set(u.id, u);
      }
      return { token: (await session(u)).access_token, user: u };
    },
    lastEmail(to, type) {
      return [...emails].reverse().find((e) => e.to === to && (!type || e.type === type));
    },
    async start(port = 0) {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => handle(req, res, Buffer.concat(chunks)));
      });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockSupabase({ confirmEmail: process.env.MOCK_CONFIRM_EMAIL !== '0' });
  await mock.start(Number(process.argv[2] || 0));
  console.log(JSON.stringify({ url: mock.url, publishableKey: mock.PUBLISHABLE, secretKey: mock.SECRET }));
}
