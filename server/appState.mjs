// The server's own settings, kept in Supabase so they survive restarts and are shared by every
// copy of the server: the owner's AI keys and their settings, the Manus tasks the app started, and
// the usage log. Replit's published apps (and similar hosts) wipe their disk when they restart, so
// without this, keys typed into Settings › AI keys would quietly disappear.
//
// Each value is a JSON document, encrypted (AES-256-GCM) in the app_state table, which only the
// server can reach (row-level security with no policies). Needs SUPABASE_SECRET_KEY; USER_KEYS_SECRET
// (optional) sets the encryption secret, otherwise the secret key is used.

import { createSecretBox, serviceHeaders } from './secretBox.mjs';

export const MIGRATION = 'supabase/migrations/20261103010000_app_state.sql';

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

const problem = (code, message) => Object.assign(new Error(message), { status: 502, code });

export function createAppState({ supabaseUrl = '', secretKey = '', encryptionSecret = '', fetch = globalThis.fetch } = {}) {
  const url = String(supabaseUrl).replace(/\/+$/, '');
  if (!url || !secretKey) return LOCAL_ONLY;
  const box = createSecretBox(encryptionSecret || secretKey, 'ylb-app-state');
  const headers = serviceHeaders(secretKey);

  const call = async (path, { timeout = 10_000, ...init } = {}) => {
    try {
      return await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw problem('UNREACHABLE', `Couldn’t reach Supabase to keep the server’s settings (${e?.name === 'TimeoutError' ? 'it took too long' : e?.message || 'network error'}).`);
    }
  };
  /** A refused request as an error; the table not existing yet gets its own code (and the fix). */
  const refused = async (what, res) => {
    const b = await res.json().catch(() => null);
    const code = String(b?.code ?? '');
    if (res.status === 404 && (code === 'PGRST205' || code === '42P01' || /app_state/.test(String(b?.message ?? '')))) {
      return problem('NO_TABLE', `The app_state table isn’t in Supabase yet: run ${MIGRATION} in Supabase → SQL Editor, then save again.`);
    }
    return problem('REFUSED', `Supabase refused to ${what} the server’s settings (${res.status}${b?.message ? `: ${String(b.message).slice(0, 160)}` : ''}).`);
  };
  const seal = (key, value) => box.seal(JSON.stringify(value), `app_state:${key}`);

  return {
    enabled: true,
    /** When a document last changed (cheap: no data), or null if it was never saved. */
    async version(key, { timeout = 3000 } = {}) {
      const res = await call(`app_state?key=eq.${encodeURIComponent(key)}&select=updated_at`, { timeout });
      if (!res.ok) throw await refused('read', res);
      const [row] = await res.json();
      return row?.updated_at ?? null;
    },
    /**
     * The document and when it changed, or null if it was never saved. A document this server can't
     * decrypt (the secret changed) comes back as { unreadable: true, updatedAt }: never as "nothing".
     */
    async get(key, { timeout = 10_000 } = {}) {
      const res = await call(`app_state?key=eq.${encodeURIComponent(key)}&select=ciphertext,updated_at`, { timeout });
      if (!res.ok) throw await refused('read', res);
      const [row] = await res.json();
      if (!row) return null;
      try {
        return { value: JSON.parse(box.open(row.ciphertext, `app_state:${key}`)), updatedAt: row.updated_at };
      } catch {
        return { unreadable: true, value: null, updatedAt: row.updated_at };
      }
    },
    /**
     * Save a document; returns its new updated_at. With ifVersion, only if nobody changed it since
     * that version (null: only if it doesn't exist yet); otherwise throws { code: 'CONFLICT' }.
     */
    async put(key, value, { ifVersion } = {}) {
      const body = { key, ciphertext: seal(key, value), updated_at: new Date().toISOString() };
      let res;
      if (ifVersion === undefined) {
        res = await call('app_state?on_conflict=key&select=updated_at', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(body) });
      } else if (ifVersion === null) {
        // create it, unless another copy of the server just did
        res = await call('app_state?on_conflict=key&select=updated_at', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(body) });
      } else {
        res = await call(`app_state?key=eq.${encodeURIComponent(key)}&updated_at=eq.${encodeURIComponent(ifVersion)}&select=updated_at`, {
          method: 'PATCH',
          headers: { prefer: 'return=representation' },
          body: JSON.stringify({ ciphertext: body.ciphertext, updated_at: body.updated_at }),
        });
      }
      if (!res.ok) throw await refused('save', res);
      const [row] = await res.json();
      if (!row) throw problem('CONFLICT', 'Another copy of the server saved these settings at the same time.');
      return row.updated_at ?? null;
    },
  };
}
