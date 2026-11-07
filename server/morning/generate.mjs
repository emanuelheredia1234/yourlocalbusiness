// Making one morning action: the same code for the hourly tick and the first Dashboard visit (or the owner's "Get
// today's action"). makeAction fills one `generating` row and returns it as it ends up.
//
//   facts (first-party, compact) → rule candidates (always) → the AI through the server's router (only when the plan
//   check passed, a key can be asked and the business isn't fresh), metered like every AI request → the schema check
//   (bad candidates dropped, the list topped up from the rules) → repeats last, Not useful never → the row.
//
// Rules stand in whenever AI can't be used, the credits or the daily limit are used up, or the answer is invalid;
// `failed` is only for a read that failed or a crash. Nothing here posts, sends, buys or launches anything, and a
// failed or paid call is never repeated by itself. Provider account problems on the owner's keys raise an owner alert;
// the row keeps only our own codes.

import { safeLog } from '../integrations/common.mjs';
import { AI_TIMEOUT_MS, MORNING, iso } from './config.mjs';
import { readFacts } from './facts.mjs';
import { ruleCandidates } from './rules.mjs';
import { buildPrompt } from './prompt.mjs';
import { validateAnswer } from './validate.mjs';
import { alertFor } from './alerts.mjs';

/** Why rules stood in for an AI failure (our words only), and the owner alert it raises. */
export function fallbackFor(e) {
  const code = String(e?.code ?? '');
  const own = (e?.attempts ?? []).length > 0 && e.attempts.every((a) => /\(your key\)$/.test(String(a?.providerLabel ?? '')));
  if (code === 'NO_PROVIDER') return { fallback: 'no_ai' };
  if (code === 'CREDITS_USED' || code === 'PLAN_REQUIRED' || code === 'PAYMENT_REQUIRED') return { fallback: 'credits' };
  if (code === 'DAILY_LIMIT') return { fallback: 'daily_limit' };
  if (code === 'CONTENT_POLICY' || code === 'REFUSAL') return { fallback: 'refused' };
  if (own) return { fallback: 'own_key' };
  const alert = alertFor(code);
  if (alert) return { fallback: 'no_ai', alert };
  return { fallback: 'ai_error' };
}

/**
 * The final list: AI candidates first (in the AI's order), topped up to 3 from the rules; duplicates dropped,
 * anything marked Not useful in the last 30 days dropped, anything chosen in the last 7 days moved last.
 */
export function chooseCandidates(ai, rules, history) {
  const notUseful = new Set((history?.notUseful ?? []).map((r) => r.key));
  const recent = new Set((history?.recent ?? []).map((r) => r.key));
  const seen = new Set();
  const fresh = [];
  const repeats = [];
  for (const c of [...ai, ...rules]) {
    if (!c?.key || seen.has(c.key) || notUseful.has(c.key)) continue;
    seen.add(c.key);
    (recent.has(c.key) ? repeats : fresh).push(c);
  }
  return [...fresh, ...repeats].slice(0, 3).map(({ score, ...c }) => c);
}

/**
 * Fill one `generating` row. deps: { store, aiText, alerts, log }. who: the user the AI request is metered for.
 * planOk: false skips the AI (rules only). signal: the tick's (a visit's call is never cut short by the browser).
 */
export async function makeAction({ store, db, aiText, alerts, log = console }, { who, row, now, signal = null, planOk = true }) {
  const t = now();
  let facts;
  try {
    facts = await readFacts(db, { userId: row.user_id, projectId: row.project_id, tz: row.time_zone, now: t });
  } catch (e) {
    safeLog('morning_failed', { code: 'UNAVAILABLE', cause: e?.code }, log);
    return store.finish(row, { state: 'failed', error_code: 'UNAVAILABLE' });
  }
  try {
    const rules = ruleCandidates(facts, t);
    let ai = [];
    let fallback = null;
    let cost = 0;
    let ownKey = false;
    let provider = null;
    let model = null;
    if (facts.fresh) fallback = 'fresh';
    else if (!aiText || !planOk) fallback = 'no_ai';
    else {
      const timeout = AbortSignal.timeout(AI_TIMEOUT_MS);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const out = await aiText(who, 'morning', buildPrompt(facts, rules), { tier: 'quick', effortCap: 'low', strictFallback: true, signal: sig });
        cost = Number(out?.meta?.cost?.usd) > 0 ? Number(out.meta.cost.usd) : 0;
        ownKey = !!out?.own;
        provider = typeof out?.meta?.provider === 'string' ? out.meta.provider.slice(0, 40) : null;
        model = typeof out?.meta?.model === 'string' ? out.meta.model.slice(0, 128) : null;
        // a key that failed before another answered: its account problem is still the owner's to fix
        for (const a of out?.meta?.attempts ?? []) {
          const kind = !/\(your key\)$/.test(String(a?.providerLabel ?? '')) ? alertFor(a?.code) : null;
          if (kind) await alerts?.raise(kind);
        }
        const v = validateAnswer(out?.text, facts);
        if (v.valid.length) ai = v.valid;
        else fallback = 'invalid_output';
      } catch (e) {
        const f = fallbackFor(e);
        fallback = f.fallback;
        if (f.alert) await alerts?.raise(f.alert);
        safeLog('morning_ai_fallback', { fallback, code: String(e?.code ?? 'Error').slice(0, 40) }, log);
      }
    }
    const list = chooseCandidates(ai, rules, facts.history);
    const base = { fallback, cost_usd: Math.round(cost * 1e6) / 1e6, own_key: ownKey, provider, model, generated_at: iso(now()), error_code: null };
    if (!list.length) return store.finish(row, { ...base, state: 'dismissed', engine: ai.length ? 'ai' : 'rules', candidates: [], chosen: null });
    return store.finish(row, { ...base, state: 'ready', engine: list[0].from === 'ai' ? 'ai' : 'rules', candidates: list, chosen: 0 });
  } catch (e) {
    safeLog('morning_failed', { code: 'ERROR', error: e?.name || 'Error' }, log);
    return store.finish(row, { state: 'failed', error_code: 'ERROR' });
  }
}

/** The outcome a finished row means for the summary and business_settings.last_outcome. */
export const outcomeOf = (row) => (row?.state === 'failed' ? 'failed' : row?.engine === 'ai' ? 'ready' : 'rules');

export { MORNING };
