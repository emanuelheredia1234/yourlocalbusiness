// Each signed-in user's own API keys (OpenAI, Anthropic, Google, xAI, OpenRouter, Meta, Manus), so
// their requests run in their own accounts: never limited, never on the app owner's bill.
//
// Keys are encrypted here (AES-256-GCM) and kept in Supabase's user_secrets table, which only the
// server can read (row-level security with no policies; the secret key bypasses it). The browser only
// ever sees the last 4 characters. Needs SUPABASE_SECRET_KEY; USER_KEYS_SECRET (optional) sets the
// encryption key, otherwise it's derived from the secret key.

import { createSecretBox, serviceHeaders } from './secretBox.mjs';

/** Providers a user can add their own key for (OpenRouter: the main slot only), in routing order. */
export const USER_KEY_PROVIDERS = ['openrouter', 'google', 'xai', 'anthropic', 'meta', 'manus', 'openai'];

export function userKeysFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  return createUserKeys({
    supabaseUrl: env.SUPABASE_URL || '',
    secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    encryptionSecret: env.USER_KEYS_SECRET || '',
    fetch: fetchImpl,
  });
}

export function createUserKeys({ supabaseUrl = '', secretKey = '', encryptionSecret = '', fetch = globalThis.fetch } = {}) {
  const url = String(supabaseUrl).replace(/\/+$/, '');
  const enabled = !!(url && secretKey);
  const box = createSecretBox(encryptionSecret || secretKey, 'ylb-user-keys');
  const encrypt = box.seal;
  const decrypt = box.open;
  const headers = serviceHeaders(secretKey);
  // short-lived: a key added or removed through another copy of the server shows up here within seconds
  const TTL = 15_000;
  const cache = new Map(); // `${user}:${provider}` → { value, until }
  const allCache = new Map(); // user → { value: { provider: key }, until }

  const unavailable = () => Object.assign(new Error('Your own keys need the SUPABASE_SECRET_KEY Secret on the server. Ask the app’s owner to add it.'), { status: 501, code: 'NOT_CONFIGURED' });
  const upstream = (what, status) => Object.assign(new Error(`Couldn’t ${what} your key (Supabase ${status}). Try again.`), { status: 502, code: 'UPSTREAM' });
  const MIGRATION = 'supabase/migrations/20261103030000_ai_usage_daily.sql';
  const check = (provider) => {
    if (!enabled) throw unavailable();
    if (!USER_KEY_PROVIDERS.includes(provider)) throw Object.assign(new Error('Unknown provider.'), { status: 400, code: 'BAD_REQUEST' });
  };
  const rows = async (userId, provider) => {
    const q = `user_id=eq.${encodeURIComponent(userId)}${provider ? `&provider=eq.${provider}` : ''}`;
    const res = await fetch(`${url}/rest/v1/user_secrets?${q}&select=provider,ciphertext,last4,updated_at`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw upstream('read', res.status);
    return res.json();
  };

  return {
    enabled,
    /** The user's key in plain text, or null. */
    async get(userId, provider) {
      if (!enabled || !userId) return null;
      const k = `${userId}:${provider}`;
      const hit = cache.get(k);
      if (hit && hit.until > Date.now()) return hit.value;
      const [row] = await rows(userId, provider);
      let value = null;
      if (row) {
        try {
          value = decrypt(row.ciphertext, `${userId}:${provider}`);
        } catch {
          value = null; // encrypted with another secret: treat as not set
        }
      }
      cache.set(k, { value, until: Date.now() + TTL });
      if (cache.size > 4000) cache.delete(cache.keys().next().value);
      return value;
    },
    /**
     * All of a user's keys in plain text ({ provider: key }), for routing their requests (one read,
     * cached for a few seconds; fresh: read Supabase again).
     */
    async all(userId, { fresh = false } = {}) {
      if (!enabled || !userId) return {};
      const hit = fresh ? null : allCache.get(userId);
      if (hit && hit.until > Date.now()) return { ...hit.value };
      const value = {};
      for (const row of await rows(userId)) {
        if (!USER_KEY_PROVIDERS.includes(row.provider)) continue;
        try {
          value[row.provider] = decrypt(row.ciphertext, `${userId}:${row.provider}`);
        } catch {
          /* encrypted with another secret: treat as not set */
        }
      }
      allCache.set(userId, { value, until: Date.now() + TTL });
      if (allCache.size > 2000) allCache.delete(allCache.keys().next().value);
      return { ...value };
    },
    /** What the browser may know: which keys are saved, and their last 4 characters ({ provider: {last4, updatedAt} | null }). */
    async info(userId) {
      const out = Object.fromEntries(USER_KEY_PROVIDERS.map((p) => [p, null]));
      if (!enabled) return out;
      for (const r of await rows(userId)) if (r.provider in out) out[r.provider] = { last4: r.last4, updatedAt: r.updated_at };
      return out;
    },
    /** The same as a list: [{ provider, last4, updatedAt }] for the saved keys only. */
    async list(userId) {
      const info = await this.info(userId);
      return USER_KEY_PROVIDERS.filter((p) => info[p]).map((provider) => ({ provider, last4: info[provider].last4, updatedAt: info[provider].updatedAt }));
    },
    async set(userId, provider, plain) {
      check(provider);
      const value = String(plain).trim();
      const res = await fetch(`${url}/rest/v1/user_secrets?on_conflict=user_id,provider`, {
        method: 'POST',
        headers: { ...headers, prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, provider, ciphertext: encrypt(value, `${userId}:${provider}`), last4: value.slice(-4), updated_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // the table still has the first version's check (Manus keys only): the migration wasn't run
        const why = res.status === 400 || res.status === 409 ? await res.json().catch(() => null) : null;
        if (why?.code === '23514') {
          console.warn(`Own keys: Supabase refused a ${provider} key (check constraint). Run ${MIGRATION} in Supabase → SQL Editor.`);
          throw Object.assign(new Error(`Own keys for this provider need the latest database update. Ask the app’s owner to run ${MIGRATION} in Supabase.`), { status: 501, code: 'NOT_CONFIGURED' });
        }
        throw upstream('save', res.status);
      }
      cache.set(`${userId}:${provider}`, { value, until: Date.now() + TTL });
      allCache.delete(userId);
    },
    async remove(userId, provider) {
      check(provider);
      const res = await fetch(`${url}/rest/v1/user_secrets?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${provider}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw upstream('remove', res.status);
      cache.delete(`${userId}:${provider}`);
      allCache.delete(userId);
    },
  };
}
