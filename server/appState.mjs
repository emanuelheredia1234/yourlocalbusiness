// The server's own settings, kept in Supabase so they survive restarts and are shared by every
// copy of the server: the owner's AI keys and their settings, the Manus tasks the app started, and
// the usage log. Replit's published apps (and similar hosts) wipe their disk when they restart, so
// without this, keys typed into Settings → AI would quietly disappear.
//
// Each value is a JSON document, encrypted (AES-256-GCM) in the app_state table, which only the
// server can reach (row-level security with no policies). Needs SUPABASE_SECRET_KEY; USER_KEYS_SECRET
// (optional) sets the encryption secret, otherwise the secret key is used.

import { createSecretBox, serviceHeaders } from './secretBox.mjs';

export function appStateFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  return createAppState({
    supabaseUrl: env.SUPABASE_URL || '',
    secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    encryptionSecret: env.USER_KEYS_SECRET || '',
    fetch: fetchImpl,
  });
}

/** Nothing to keep anywhere but the local disk. */
export const LOCAL_ONLY = { enabled: false, get: async () => null, version: async () => null, put: async () => null };

export function createAppState({ supabaseUrl = '', secretKey = '', encryptionSecret = '', fetch = globalThis.fetch } = {}) {
  const url = String(supabaseUrl).replace(/\/+$/, '');
  if (!url || !secretKey) return LOCAL_ONLY;
  const box = createSecretBox(encryptionSecret || secretKey, 'ylb-app-state');
  const headers = serviceHeaders(secretKey);
  const failed = (what, status, detail = '') =>
    Object.assign(new Error(`Couldn’t ${what} the server settings in Supabase (${status}${detail ? `: ${detail}` : ''}).`), { status: 502, code: 'NOT_SAVED' });
  const call = async (path, init = {}) => {
    try {
      return await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(10_000) });
    } catch (e) {
      throw failed('reach', 'network', e?.message);
    }
  };
  const detail = async (res) => {
    const b = await res.json().catch(() => null);
    return String(b?.message ?? '').slice(0, 160);
  };

  return {
    enabled: true,
    /** When a document last changed (cheap: no data), or null if it was never saved. */
    async version(key) {
      const res = await call(`app_state?key=eq.${encodeURIComponent(key)}&select=updated_at`);
      if (!res.ok) throw failed('read', res.status, await detail(res));
      const [row] = await res.json();
      return row?.updated_at ?? null;
    },
    /** The document and when it changed, or null. */
    async get(key) {
      const res = await call(`app_state?key=eq.${encodeURIComponent(key)}&select=ciphertext,updated_at`);
      if (!res.ok) throw failed('read', res.status, await detail(res));
      const [row] = await res.json();
      if (!row) return null;
      let value;
      try {
        value = JSON.parse(box.open(row.ciphertext, `app_state:${key}`));
      } catch {
        // saved with a different secret (the secret key was rotated): start over rather than fail
        console.warn(`Couldn’t decrypt the saved "${key}" settings (was SUPABASE_SECRET_KEY or USER_KEYS_SECRET changed?). Starting from this server’s copy.`);
        return null;
      }
      return { value, updatedAt: row.updated_at };
    },
    /** Save a document; returns its new updated_at. */
    async put(key, value) {
      const res = await call('app_state?on_conflict=key&select=updated_at', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ key, ciphertext: box.seal(JSON.stringify(value), `app_state:${key}`), updated_at: new Date().toISOString() }),
      });
      if (!res.ok) throw failed('save', res.status, await detail(res));
      const [row] = await res.json();
      return row?.updated_at ?? null;
    },
  };
}
