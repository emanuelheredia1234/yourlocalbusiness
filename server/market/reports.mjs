// Reports and owner moderation for the public marketplace (P7).
//
// - The report form (GET /market/<slug>/report) carries a token: <issued at, base36>.<HMAC(secret, slug|issued
//   at|visitor), base64url 22>, valid from 3 s to 1 h after it was issued and only for the visitor it was made for (a
//   bot that posts at once, an old copy, or a token copied onto another site and posted by other people's browsers is
//   asked to send the form again and nothing is stored).
// - Who reported is a keyed hash (HMAC of 'v:' + the visitor key, or 'u:' + the user id), never an address. One report
//   per reporter per listing per day (a second one counts as accepted and changes nothing).
// - MARKET_REPORT_HOLD_AT (3) distinct open reporters in 7 days put a live or thin listing on hold (noindex, off the
//   grid and the sitemap) until the owner reviews it. The hold reads the row from the database (never a cached copy)
//   and the write is conditional, so a listing its seller just took off the web (or the sweep put over the limit)
//   stays off.
// - The owner hides (hidden_at, a reason; every open report actioned), unhides (back to the computed status, or
//   over_limit when the seller's plan has no room for it) or
//   dismisses one report (the hold goes when none are open). The seller sees only the status and the count.

import crypto from 'node:crypto';
import { fail, utcDay } from '../integrations/common.mjs';
import { publicStatus } from './quality.mjs';
import { REPORT_REASONS } from './validate.mjs';

const TOKEN_MIN_MS = 3_000;
const TOKEN_MAX_MS = 60 * 60_000;
const WEEK_MS = 7 * 86_400_000;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mac = (secret, text) => crypto.createHmac('sha256', secret).update(String(text)).digest();

/** A report form's token for this listing and this visitor (their visitor key). */
export function makeFormToken(secret, slug, visitor, now = Date.now()) {
  const at = Math.floor(now).toString(36);
  return `${at}.${b64url(mac(secret, `${slug}|${at}|${visitor}`)).slice(0, 22)}`;
}

/** Whether a token is this listing's, was made for this visitor, and is between 3 s and 1 h old. */
export function checkFormToken(secret, slug, visitor, token, now = Date.now()) {
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})$/.exec(String(token ?? ''));
  if (!m) return false;
  const want = b64url(mac(secret, `${slug}|${m[1]}|${visitor}`)).slice(0, 22);
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]))) return false;
  const age = now - Number.parseInt(m[1], 36);
  return age >= TOKEN_MIN_MS && age <= TOKEN_MAX_MS;
}

/** The reporter's keyed hash (64 hex). kind: 'v' (a visitor key) or 'u' (a user id). */
export const reporterHash = (secret, kind, key) => crypto.createHmac('sha256', secret).update(`${kind}:${key}`).digest('hex');

/** A report's note: plain one-paragraph text, at most 500 characters (cut, never refused). */
export function cleanNote(raw) {
  let s = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
  return Array.from(s).slice(0, 500).join('');
}

/**
 * db; now; holdAt (distinct reporters in 7 days). onChanged(slug), log(event, fields): the module's. limitOf(userId):
 * the seller's plan's public-listing limit (null: unlimited; it may throw: then unlimited).
 */
export function createReports({ db, now = () => Date.now(), holdAt = 3, onChanged = () => {}, log = () => {}, limitOf = async () => null }) {
  const iso = () => new Date(now()).toISOString();

  /**
   * Recount a listing's open reports; put it on hold when enough distinct reporters wrote in the last 7 days. The row
   * is read again here (a cached copy may be up to a minute old on this server copy), and the hold is written only
   * while the row is still live or thin, not held, hidden or unlisted.
   */
  async function recount(listing) {
    const open = await db.select('public_listing_reports', { public_listing_id: listing.id, status: 'open' }, { select: 'reporter_hash,created_at', limit: 1000 });
    const since = now() - WEEK_MS;
    const recent = new Set(open.filter((r) => Date.parse(r.created_at) >= since).map((r) => r.reporter_hash));
    await db.update('public_listings', { id: listing.id }, { report_count: open.length });
    let hold = false;
    if (recent.size >= holdAt) {
      const [row] = await db.select('public_listings', { id: listing.id }, { select: 'id,slug,status,held_at,hidden_at,unlisted_at', limit: 1 });
      if (row && ['live', 'thin'].includes(row.status) && !row.held_at && !row.hidden_at && !row.unlisted_at) {
        const got = await db.update('public_listings', { id: listing.id, status: ['in', ['live', 'thin']], held_at: null, hidden_at: null, unlisted_at: null }, { held_at: iso(), status: 'held' }, { returning: true });
        hold = Array.isArray(got) && got.length > 0;
      }
    }
    if (hold) {
      log('market_listing_held', { id: listing.id });
      onChanged(listing.slug);
    }
    return { held: hold, open: open.length };
  }

  /**
   * File one report. listing: the row; reason one of REPORT_REASONS; hash: reporterHash's; kind 'visitor' | 'user'.
   * → { created, held }.
   */
  async function file(listing, { reason, note = '', hash, kind }) {
    if (!REPORT_REASONS.includes(reason)) throw fail(400, 'BAD_REQUEST', 'Choose a reason.');
    const got = await db.insert('public_listing_reports', { public_listing_id: listing.id, reason, note: cleanNote(note), reporter_hash: hash, reporter_kind: kind, day: utcDay(now()), status: 'open' }, { returning: true, ignoreDuplicates: true, onConflict: 'public_listing_id,reporter_hash,day' });
    if (!Array.isArray(got) || got.length !== 1) return { created: false, held: false };
    const { held } = await recount(listing);
    return { created: true, held };
  }

  async function listingById(id) {
    const [row] = await db.select('public_listings', { id }, { select: 'id,user_id,slug,status,quality,held_at,hidden_at,unlisted_at', limit: 1 });
    if (!row) throw fail(404, 'NOT_FOUND', 'That listing isn’t there any more.');
    return row;
  }

  /**
   * The status a listing goes back to when nothing holds or hides it: unlisted when its seller took it off, else from
   * its quality, unless the seller's plan has no room for one more public listing (over_limit, as the sweep would).
   */
  async function computed(row) {
    if (row.unlisted_at) return 'unlisted';
    const status = publicStatus(row.quality);
    let lim = null;
    try {
      lim = await limitOf(row.user_id);
    } catch {
      lim = null;
    }
    if (lim === null || lim === undefined) return status;
    const others = await db.select('public_listings', { user_id: row.user_id, status: ['in', ['live', 'thin', 'held']], id: ['neq', row.id] }, { select: 'id', limit: 1000 });
    return others.length >= Number(lim) ? 'over_limit' : status;
  }

  return {
    file,
    recount,
    async hide(id, { reason }) {
      if (!REPORT_REASONS.includes(reason)) throw fail(400, 'BAD_REQUEST', 'Choose a reason.');
      const row = await listingById(id);
      await db.update('public_listings', { id }, { hidden_at: iso(), hidden_reason: reason, status: 'hidden', report_count: 0 });
      await db.update('public_listing_reports', { public_listing_id: id, status: 'open' }, { status: 'actioned', resolved_at: iso() });
      log('market_moderation', { action: 'hide', id });
      onChanged(row.slug);
      return { ok: true };
    },
    async unhide(id) {
      const row = await listingById(id);
      const status = await computed(row);
      await db.update('public_listings', { id }, { hidden_at: null, hidden_reason: null, held_at: null, status });
      log('market_moderation', { action: 'unhide', id });
      onChanged(row.slug);
      return { ok: true, status };
    },
    async dismiss(reportId) {
      const [rep] = await db.select('public_listing_reports', { id: reportId }, { select: 'id,public_listing_id,status', limit: 1 });
      if (!rep) throw fail(404, 'NOT_FOUND', 'That report isn’t there any more.');
      if (rep.status === 'open') await db.update('public_listing_reports', { id: reportId, status: 'open' }, { status: 'dismissed', resolved_at: iso() });
      const row = await listingById(rep.public_listing_id);
      const open = await db.select('public_listing_reports', { public_listing_id: row.id, status: 'open' }, { select: 'id', limit: 1000 });
      const patch = { report_count: open.length };
      if (!open.length && row.held_at) Object.assign(patch, { held_at: null, ...(row.status === 'held' ? { status: await computed(row) } : {}) });
      await db.update('public_listings', { id: row.id }, patch);
      log('market_moderation', { action: 'dismiss', id: row.id });
      onChanged(row.slug);
      return { ok: true };
    },
    /** The owner's view: open reports (newest first, 100) with their listing, held and hidden listings. */
    async adminView() {
      const reports = await db.select('public_listing_reports', { status: 'open' }, { select: 'id,public_listing_id,reason,note,reporter_kind,created_at', order: 'created_at.desc', limit: 100 });
      const held = await db.select('public_listings', { status: 'held' }, { select: 'id,slug,title,seller_name,report_count,held_at', order: 'held_at.desc', limit: 100 });
      const hidden = await db.select('public_listings', { status: 'hidden' }, { select: 'id,slug,title,seller_name,hidden_reason,hidden_at', order: 'hidden_at.desc', limit: 100 });
      const ids = [...new Set(reports.map((r) => r.public_listing_id))];
      const listings = ids.length ? await db.select('public_listings', { id: ['in', ids] }, { select: 'id,slug,title,seller_name,status', limit: ids.length }) : [];
      const by = new Map(listings.map((l) => [l.id, l]));
      return {
        reports: reports.map((r) => ({ id: r.id, reason: r.reason, note: r.note, from: r.reporter_kind, at: r.created_at, listing: by.get(r.public_listing_id) ?? null })),
        held,
        hidden,
      };
    },
  };
}
