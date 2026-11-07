// Owner alerts for the morning action: one log line (morning_owner_alert) plus app_state `morning:alert`
// { kind, at, n?, kinds: { <kind>: { at, n? } } } (the latest, and the latest of each kind this week), at most once per kind per 10 minutes. Kinds only: never a key, a provider's message, a customer
// id or a business name. Customers never see these: they read our own wording on their card.

import { safeLog } from '../integrations/common.mjs';

export const ALERT_KINDS = Object.freeze(['ai_key', 'ai_credits', 'ai_rate', 'ai_model', 'backlog']);
export const ALERT_KEY = 'morning:alert';
export const LAST_KEY = 'morning:last';
const EVERY_MS = 10 * 60_000;

/** The alert a provider failure on the owner's keys raises, or null. */
export function alertFor(code) {
  return { AUTH: 'ai_key', CREDITS: 'ai_credits', RATE_LIMIT: 'ai_rate', NOT_FOUND: 'ai_model' }[code] ?? null;
}

export function createAlerts({ storage = null, now = () => Date.now(), log = console } = {}) {
  const last = new Map();
  return {
    /** Raise an alert (best effort: never throws). */
    async raise(kind, n = null) {
      if (!ALERT_KINDS.includes(kind)) return false;
      const t = now();
      if (t - (last.get(kind) ?? -Infinity) < EVERY_MS) return false;
      last.set(kind, t);
      safeLog('morning_owner_alert', { kind, ...(n != null ? { n } : {}) }, log);
      try {
        if (storage?.enabled) {
          // the latest alert, and the latest of each kind in the last 7 days (the owner's page shows one line each)
          const cur = await storage.get(ALERT_KEY).catch(() => null);
          const at = new Date(t).toISOString();
          const kinds = {};
          for (const [k, v] of Object.entries(cur?.value?.kinds ?? {})) if (ALERT_KINDS.includes(k) && t - Date.parse(v?.at) < 7 * 86_400_000) kinds[k] = v;
          kinds[kind] = { at, ...(n != null ? { n } : {}) };
          await storage.put(ALERT_KEY, { kind, at, ...(n != null ? { n } : {}), kinds });
        }
      } catch {
        /* the log line is enough */
      }
      return true;
    },
  };
}
