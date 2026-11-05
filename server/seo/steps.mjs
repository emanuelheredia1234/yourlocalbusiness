// "Submit to Google" bookkeeping shared by the route (server/seo/google.mjs) and the Update (the SEO source):
// each page's step outcomes (seo_google_steps), the shared sitemap-submit claim and the URL-inspection budget.
//
// Claims are compare-and-set writes to appState BEFORE the call (ifVersion), so of two requests at once only one
// calls Google, and a claim stays set whatever the outcome ('unknown' included):
//   gsc:app:lastSubmit                          ISO time of the last sitemap submit claim (at most one per 24 h)
//   gsc:app:inspect:<YYYY-MM-DD>                {count} for the whole property (refused above 1,500 of Google's 2,000)
//   gsc:app:inspect:<YYYY-MM-DD>:<customerTag>  {count} per customer (refused above 20)

import { fail, utcDay } from '../integrations/common.mjs';

export const SUBMIT_EVERY_MS = 24 * 60 * 60 * 1000;
export const INSPECT_PROPERTY_PER_DAY = 1500;
export const INSPECT_CUSTOMER_PER_DAY = 20;
export const INSPECT_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** The page's stored steps: { step: { outcome, detail, at } }. */
export async function readSteps(db, userId, pageId) {
  const rows = await db.select('seo_google_steps', { user_id: userId, page_id: pageId }, { limit: 10 });
  return Object.fromEntries(rows.map((r) => [r.step, { outcome: r.outcome, detail: r.detail && typeof r.detail === 'object' ? r.detail : {}, at: r.at }]));
}

export async function writeStep(db, userId, pageId, step, outcome, detail, now) {
  await db.upsert('seo_google_steps', { user_id: userId, page_id: pageId, step, outcome, detail: detail ?? {}, at: iso(now) }, { onConflict: 'user_id,page_id,step' });
}

/**
 * Change an appState document only if nobody else changed it meanwhile. change(value) → { value } to write and
 * win, or { result } to stop without writing. A CONFLICT means someone else wrote first: read again and decide.
 */
export async function casDocument(storage, key, change) {
  if (storage?.enabled !== true) throw fail(503, 'NOT_SET_UP', 'Secure storage isn’t set up.', {}, 'Run the app_state Supabase migration and set the Supabase secret key.');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await storage.get(key);
    const value = current?.value && typeof current.value === 'object' ? current.value : {};
    const decided = change(value);
    if (!('value' in decided)) return decided.result;
    try {
      await storage.put(key, decided.value, { ifVersion: current?.updatedAt ?? null });
      return decided.result;
    } catch (e) {
      if (e?.code === 'CONFLICT') continue;
      throw fail(503, 'UNAVAILABLE', 'Storage is unavailable. Try again shortly.');
    }
  }
  throw fail(409, 'UNAVAILABLE', 'Busy. Try again in a moment.');
}

/** Claim the shared sitemap submit: { won: true } or { won: false, at } when it was submitted in the last 24 h. */
export function claimSubmit(storage, now) {
  return casDocument(storage, 'gsc:app:lastSubmit', (doc) => {
    const at = Date.parse(doc.at);
    if (Number.isFinite(at) && now - at < SUBMIT_EVERY_MS) return { result: { won: false, at: doc.at } };
    return { value: { at: iso(now) }, result: { won: true, at: iso(now) } };
  });
}

/** Take one inspection from today's budgets (property, then customer). true when both had room. */
export async function claimInspection(storage, customerTag, now) {
  const day = utcDay(now);
  const property = await casDocument(storage, `gsc:app:inspect:${day}`, (doc) => {
    const count = Number(doc.count) || 0;
    if (count >= INSPECT_PROPERTY_PER_DAY) return { result: false };
    return { value: { count: count + 1 }, result: true };
  });
  if (!property) return false;
  return casDocument(storage, `gsc:app:inspect:${day}:${customerTag}`, (doc) => {
    const count = Number(doc.count) || 0;
    if (count >= INSPECT_CUSTOMER_PER_DAY) return { result: false };
    return { value: { count: count + 1 }, result: true };
  });
}

/** Whether a page's inspection is due: never inspected, or not indexed and the last one is a week old. */
export function inspectionDue(stored, now) {
  if (!stored) return true;
  if (stored.detail?.verdict === 'PASS') return false;
  const at = Date.parse(stored.at);
  return !Number.isFinite(at) || now - at >= INSPECT_EVERY_MS;
}
