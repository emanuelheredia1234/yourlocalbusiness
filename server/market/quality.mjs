// The public marketplace's thin-content and spam rules (P7): which public listings Google may index (status 'live')
// and which stay public with noindex ('thin'), with a stable key per missing item that the app turns into a sentence
// (shared/marketQuality.json, read by the app too). And the one function that says how a stored row is served.
//
// Indexable needs all of: a description of 200+ characters and 35+ words; a title that isn't mostly capitals and has
// no character repeated 5+ times in a row; a hosted cover image; a category and 3+ tags; a way to act (an active or
// paused offer, an outside buy link, a website or a phone); a price (or a quote or free price model); a description no
// other seller's live listing has; and a paid plan (during a card trial: public, not indexed until the first paid
// period).

import fs from 'node:fs';

/** shared/marketQuality.json, frozen. */
export const QUALITY = Object.freeze(JSON.parse(fs.readFileSync(new URL('../../shared/marketQuality.json', import.meta.url), 'utf8')));
export const QUALITY_KEYS = Object.freeze([...QUALITY.keys]);

/** Words in a text (letters or digits). */
export const wordCount = (text) => (String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/** Whether a title shouts: over the share of capitals among its letters, or a character repeated 5+ times in a row. */
export function titleShouts(title) {
  const letters = String(title ?? '').match(/\p{L}/gu) ?? [];
  const caps = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
  if (letters.length >= 6 && caps / letters.length > QUALITY.maxTitleCapsShare) return true;
  return new RegExp(`(.)\\1{${QUALITY.maxRepeatedChars},}`, 'u').test(String(title ?? ''));
}

/**
 * row: the public_listings columns. ctx: { offer (its row or null: { status }), duplicate (another seller's live row has
 * this description), trial (the seller's plan is a card trial) }. → { indexable, missing: key[], words }.
 */
export function qualityOf(row, { offer = null, duplicate = false, trial = false } = {}) {
  const missing = [];
  const words = wordCount(row.description);
  if (Array.from(String(row.description ?? '')).length < QUALITY.minDescriptionChars || words < QUALITY.minDescriptionWords) missing.push('description_length');
  if (titleShouts(row.title)) missing.push('title_caps');
  if (!row.cover_path) missing.push('cover');
  if (!row.category || (row.tags ?? []).length < QUALITY.minTags) missing.push('tags');
  const offerOk = !!row.offer_id && !!offer && ['active', 'paused', 'checkout_unknown'].includes(offer.status);
  if (!(offerOk || row.outside_buy_url || row.website || row.phone)) missing.push('action');
  if (!(row.price_minor !== null && row.price_minor !== undefined) && !['quote', 'free'].includes(row.price_model)) missing.push('price');
  if (duplicate) missing.push('duplicate');
  if (trial) missing.push('trial');
  return { indexable: missing.length === 0, missing, words };
}

/** The status a write gives a row that is public (held or hidden come from their own flags). */
export const publicStatus = (quality) => (quality?.indexable ? 'live' : 'thin');

/**
 * How a stored row is served right now: 'live' | 'thin' | 'held' (200; only live is indexed) or 'gone' (410).
 * ctx: { blocked (the seller's account is being deleted), serveUntil (billing.pagesServeUntil: ISO or null), now }.
 */
export function statusOf(row, { blocked = false, serveUntil = null, now = Date.now() } = {}) {
  if (!row) return 'missing';
  if (blocked) return 'gone';
  if (serveUntil && Date.parse(serveUntil) < now) return 'gone';
  if (row.hidden_at || row.unlisted_at || row.status === 'hidden') return 'gone';
  if (['unlisted', 'over_limit'].includes(row.status)) return 'gone';
  if (row.held_at || row.status === 'held') return 'held';
  return row.status === 'live' ? 'live' : 'thin';
}
