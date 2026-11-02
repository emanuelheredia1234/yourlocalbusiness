// Each signed-in user's own API keys (for now: Manus), so their agent tasks run in their own account.
//
// Keys are encrypted here (AES-256-GCM) and kept in Supabase's user_secrets table, which only the
// server can read (row-level security with no policies; the secret key bypasses it). The browser only
// ever sees the last 4 characters. Needs SUPABASE_SECRET_KEY; USER_KEYS_SECRET (optional) sets the
// encryption key, otherwise it's derived from the secret key.

import crypto from 'node:crypto';

export const USER_KEY_PROVIDERS = ['manus'];

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
  const key = crypto.createHash('sha256').update(`ylb-user-keys:${encryptionSecret || secretKey}`).digest();
  const headers = { apikey: secretKey, 'content-type': 'application/json', ...(secretKey.startsWith('sb_secret_') ? {} : { authorization: `Bearer ${secretKey}` }) };
  const cache = new Map(); // `${user}:${provider}` → { value, until }

  const encrypt = (plain, aad) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  };
  const decrypt = (b64, aad) => {
    const raw = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  };

  const unavailable = () => Object.assign(new Error('Your own keys need the SUPABASE_SECRET_KEY Secret on the server. Ask the app’s owner to add it.'), { status: 501, code: 'NOT_CONFIGURED' });
  const upstream = (what, status) => Object.assign(new Error(`Couldn’t ${what} your key (Supabase ${status}). Try again.`), { status: 502, code: 'UPSTREAM' });
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
      cache.set(k, { value, until: Date.now() + 5 * 60_000 });
      return value;
    },
    /** What the browser may know: which keys are saved, and their last 4 characters. */
    async info(userId) {
      const out = Object.fromEntries(USER_KEY_PROVIDERS.map((p) => [p, null]));
      if (!enabled) return out;
      for (const r of await rows(userId)) if (r.provider in out) out[r.provider] = { last4: r.last4, updatedAt: r.updated_at };
      return out;
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
      if (!res.ok) throw upstream('save', res.status);
      cache.set(`${userId}:${provider}`, { value, until: Date.now() + 5 * 60_000 });
    },
    async remove(userId, provider) {
      check(provider);
      const res = await fetch(`${url}/rest/v1/user_secrets?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${provider}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw upstream('remove', res.status);
      cache.delete(`${userId}:${provider}`);
    },
  };
}
