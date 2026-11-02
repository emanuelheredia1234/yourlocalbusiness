// Who is calling: checks the Supabase access token a signed-in browser sends as
// "Authorization: Bearer …". Tokens are verified locally against the project's public signing keys
// (JWKS); projects still on the legacy shared-secret key are checked by asking Supabase Auth.
//
// Env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (or the legacy SUPABASE_ANON_KEY), ADMIN_EMAILS
// (the owner's email; comma-separated for several), SIGN_IN_REQUIRED ("false" lets the app run without accounts).

import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** jose errors that mean the token itself is bad (anything else: it couldn't be checked here). */
const INVALID = new Set(['ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JWS_INVALID', 'ERR_JWT_INVALID']);

export function authFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  return createAuth({
    supabaseUrl: env.SUPABASE_URL || '',
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '',
    secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    adminEmails: env.ADMIN_EMAILS || '',
    signInRequired: String(env.SIGN_IN_REQUIRED ?? 'true').toLowerCase() !== 'false',
    fetch: fetchImpl,
  });
}

export function createAuth({ supabaseUrl = '', publishableKey = '', secretKey = '', adminEmails = '', signInRequired = true, fetch = globalThis.fetch } = {}) {
  const url = String(supabaseUrl).replace(/\/+$/, '');
  const enabled = !!(url && publishableKey);
  const admins = new Set(
    String(adminEmails)
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  const issuer = `${url}/auth/v1`;
  const jwks = enabled ? createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000, timeoutDuration: 8000 }) : null;
  const remembered = new Map(); // sha256(token) → { user, until }: answers from Supabase Auth, kept a minute

  // An email only proves who someone is when the project makes people confirm it.
  let confirmation = null;
  async function emailsAreConfirmed() {
    if (confirmation && confirmation.until > Date.now()) return confirmation.value;
    try {
      const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: publishableKey }, signal: AbortSignal.timeout(8000) });
      const s = res.ok ? await res.json() : null;
      const value = s ? s.mailer_autoconfirm === false : false;
      if (s && !value && admins.size) console.warn('Supabase lets people sign in without confirming their email, so ADMIN_EMAILS is ignored. Turn on "Confirm email" in Supabase → Authentication.');
      confirmation = { value, until: Date.now() + (s ? 10 * 60_000 : 30_000) };
    } catch {
      confirmation = { value: false, until: Date.now() + 30_000 };
    }
    return confirmation.value;
  }

  async function viaAuthServer(token) {
    const h = crypto.createHash('sha256').update(token).digest('hex');
    const hit = remembered.get(h);
    if (hit && hit.until > Date.now()) return hit.user;
    let res;
    try {
      res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: publishableKey, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw Object.assign(new Error('Couldn’t reach Supabase to check your sign-in. Try again shortly.'), { status: 503, code: 'AUTH_UNAVAILABLE' });
    }
    if (!res.ok && res.status !== 401 && res.status !== 403) throw Object.assign(new Error('Couldn’t check your sign-in with Supabase. Try again shortly.'), { status: 503, code: 'AUTH_UNAVAILABLE' });
    const u = res.ok ? await res.json().catch(() => null) : null;
    const user = typeof u?.id === 'string' ? { id: u.id, email: String(u.email ?? '').toLowerCase() } : null;
    remembered.set(h, { user, until: Date.now() + 60_000 });
    if (remembered.size > 500) remembered.delete(remembered.keys().next().value);
    return user;
  }

  /** The signed-in user behind a request, or null. Throws { status: 503 } when Supabase can't be reached. */
  async function identify(req) {
    if (!enabled) return null;
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const token = m[1];
    let user = null;
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated', algorithms: ['ES256', 'RS256', 'EdDSA'] });
      if (payload.role === 'authenticated' && typeof payload.sub === 'string') user = { id: payload.sub, email: String(payload.email ?? '').toLowerCase() };
    } catch (e) {
      if (INVALID.has(e?.code)) return null; // expired, wrong issuer or audience, bad signature
      // legacy shared-secret tokens (or keys that couldn't be fetched): ask Supabase Auth instead
      user = await viaAuthServer(token);
    }
    if (!user) return null;
    const isAdmin = admins.has(user.email) && !!user.email && (await emailsAreConfirmed());
    return { ...user, isAdmin };
  }

  /** Delete a user and their files (needs the secret key). */
  async function deleteUser(userId) {
    if (!secretKey) throw Object.assign(new Error('Add the SUPABASE_SECRET_KEY Secret to let people delete their accounts.'), { status: 501, code: 'NOT_CONFIGURED' });
    const headers = { apikey: secretKey, ...(secretKey.startsWith('sb_secret_') ? {} : { authorization: `Bearer ${secretKey}` }) };
    // their files first: list and remove media/<user id>/…
    for (let round = 0; round < 50; round++) {
      const list = await fetch(`${url}/storage/v1/object/list/media`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: `${userId}/`, limit: 1000, offset: 0 }) });
      const items = list.ok ? await list.json() : [];
      if (!Array.isArray(items) || !items.length) break;
      await fetch(`${url}/storage/v1/object/media`, { method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: items.map((i) => `${userId}/${i.name}`) }) });
      if (items.length < 1000) break;
    }
    const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers });
    if (!res.ok) throw Object.assign(new Error(`Supabase didn’t delete the account (${res.status}).`), { status: 502, code: 'UPSTREAM' });
  }

  return {
    enabled,
    signInRequired: enabled && signInRequired,
    canDeleteUsers: enabled && !!secretKey,
    identify,
    deleteUser,
    /** What the browser needs to sign in (the publishable key is meant to be public). */
    publicConfig: () => ({ enabled, url: enabled ? url : '', publishableKey: enabled ? publishableKey : '', signInRequired: enabled && signInRequired, canDeleteAccount: enabled && !!secretKey }),
  };
}
