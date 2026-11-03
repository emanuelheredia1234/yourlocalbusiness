// Who is calling: checks the Supabase access token a signed-in browser sends as
// "Authorization: Bearer …". Tokens are verified locally against the project's public signing keys
// (JWKS); projects still on the legacy shared-secret key are checked by asking Supabase Auth.
//
// The app's owner (who manages the AI keys everyone uses) is either an account whose Supabase
// app_metadata has "ylb_role": "admin" (only the project's owner can set that, with SQL or the secret
// key), or one signed in with an ADMIN_EMAILS address that was confirmed by email.
//
// Env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (or the legacy SUPABASE_ANON_KEY), ADMIN_EMAILS
// (the owner's email; comma-separated for several; defaults to DEFAULT_ADMIN_EMAILS), SIGN_IN_REQUIRED ("false" lets the app run without accounts).

import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** jose errors that mean the token itself is bad (anything else: it couldn't be checked here). */
const INVALID = new Set(['ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JWS_INVALID', 'ERR_JWT_INVALID']);

/** The app's owner when no ADMIN_EMAILS Secret is set. */
export const DEFAULT_ADMIN_EMAILS = 'hectorheredia242@gmail.com';

export function authFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  return createAuth({
    supabaseUrl: env.SUPABASE_URL || '',
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '',
    secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    // the app owner manages the AI keys everyone uses; the ADMIN_EMAILS Secret replaces this default
    adminEmails: env.ADMIN_EMAILS ?? DEFAULT_ADMIN_EMAILS,
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
    const user = typeof u?.id === 'string' ? { id: u.id, email: String(u.email ?? '').toLowerCase(), roleAdmin: u.app_metadata?.ylb_role === 'admin' } : null;
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
      // app_metadata is set by Supabase from the user's record; users can't change it themselves
      if (payload.role === 'authenticated' && typeof payload.sub === 'string') user = { id: payload.sub, email: String(payload.email ?? '').toLowerCase(), roleAdmin: payload.app_metadata?.ylb_role === 'admin' };
    } catch (e) {
      if (INVALID.has(e?.code)) return null; // expired, wrong issuer or audience, bad signature
      // legacy shared-secret tokens (or keys that couldn't be fetched): ask Supabase Auth instead
      user = await viaAuthServer(token);
    }
    if (!user) return null;
    const { roleAdmin, ...who } = user;
    const isAdmin = roleAdmin || (admins.has(who.email) && !!who.email && (await emailsAreConfirmed()) && (await provedEmail(token, who)));
    return { ...who, isAdmin };
  }

  // The owner must have opened a confirmation link sent to that address: an account made while
  // "Confirm email" was off (marked confirmed without any email) doesn't count.
  const proven = new Map(); // user id → { ok, until }
  async function provedEmail(token, user) {
    const hit = proven.get(user.id);
    if (hit && hit.until > Date.now()) return hit.ok;
    let ok = false;
    try {
      const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: publishableKey, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      const u = res.ok ? await res.json() : null;
      ok = !!(u && u.id === user.id && String(u.email ?? '').toLowerCase() === user.email && u.email_confirmed_at && u.confirmation_sent_at && Date.parse(u.email_confirmed_at) >= Date.parse(u.confirmation_sent_at));
      proven.set(user.id, { ok, until: Date.now() + (res.ok ? 10 * 60_000 : 30_000) });
    } catch {
      proven.set(user.id, { ok: false, until: Date.now() + 30_000 });
    }
    return ok;
  }

  /** Delete a user and their files (needs the secret key). */
  async function deleteUser(userId) {
    if (!secretKey) throw Object.assign(new Error('Add the SUPABASE_SECRET_KEY Secret to let people delete their accounts.'), { status: 501, code: 'NOT_CONFIGURED' });
    const headers = { apikey: secretKey, ...(secretKey.startsWith('sb_secret_') ? {} : { authorization: `Bearer ${secretKey}` }) };
    const failed = (what, status) => Object.assign(new Error(`Couldn’t delete your files (${what}, ${status}). Nothing was deleted yet; try again.`), { status: 502, code: 'UPSTREAM' });
    // The files in a folder and its sub-folders (published pages keep their images in
    // <user id>/published/<page>/). Storage lists a sub-folder as an entry without an id.
    async function filesIn(prefix, depth = 0) {
      const list = await fetch(`${url}/storage/v1/object/list/media`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset: 0 }) });
      if (!list.ok) throw failed('listing', list.status);
      const items = await list.json();
      const out = [];
      for (const i of Array.isArray(items) ? items : []) {
        if (i?.id != null) out.push(`${prefix}${i.name}`);
        else if (i?.name && depth < 4) out.push(...(await filesIn(`${prefix}${i.name}/`, depth + 1)));
      }
      return out;
    }
    // their files first: list and remove media/<user id>/… until the folder is empty
    async function clearFolder() {
      for (let round = 0; round < 50; round++) {
        const files = await filesIn(`${userId}/`);
        if (!files.length) return;
        for (let i = 0; i < files.length; i += 1000) {
          const del = await fetch(`${url}/storage/v1/object/media`, { method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: files.slice(i, i + 1000) }) });
          if (!del.ok) throw failed('deleting', del.status);
        }
      }
      throw failed('too many files', 0);
    }
    await clearFolder();
    const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers });
    if (!res.ok) throw Object.assign(new Error(`Supabase didn’t delete the account (${res.status}).`), { status: 502, code: 'UPSTREAM' });
    // an upload that was still running when we started may have landed meanwhile
    await clearFolder().catch((e) => console.warn(`Deleted account ${userId}, but some files remain: ${e.message}`));
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
