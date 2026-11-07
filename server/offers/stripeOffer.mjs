// Stripe offers (P6): an offer sold through the seller's own Stripe account (server/payments/stripeConnect.mjs). No
// Stripe write when an offer is made or changed: each Checkout sends its price inline (price_data), so a new price
// takes effect on the next click (server/offers/stripeCheckout.mjs).
//
//   POST  /api/offers {provider: 'stripe', projectId, title, priceMinor, currency, delivery: {kind: 'none'} |
//                      {kind: 'file', fileId}, clientRequestId}                         (a plan; a Stripe account)
//   PATCH /api/offers/<id> {title?, priceMinor?, currency?, delivery?, status?}
//
// - The seller's live Stripe account (onboarding, restricted or active) is needed: else 409 STRIPE_NOT_CONNECTED.
//   An offer made while onboarding has problem 'stripe_setup' and /b/ says "not available to buy right now".
// - Price: whole minor units, 50 to 99,999,999 (Stripe's usual minimum for USD; other currencies' minimums are
//   Stripe's to refuse at checkout), a 3-letter currency. The price text is the server's.
// - Delivery: 'none' (the seller delivers) or 'file': a product file (lead_files.purpose 'product') of the same user.
// - The id comes from the clientRequestId (a double press makes one row).

import { fail, isUuid } from '../integrations/common.mjs';
import { ID_RE, MAX_OFFERS_PER_USER, PROJECT_ID_RE, priceText } from './store.mjs';

export const STRIPE_PRICE_MIN = 50;
export const STRIPE_PRICE_MAX = 99_999_999;
/** Account statuses an offer may be made on (it sells only once 'active'). */
const OFFER_ACCOUNT = ['onboarding', 'restricted', 'active'];

/** A Stripe offer's price in our checks: { priceMinor, currency } (throws 400). */
export function stripePriceOf(priceMinor, currency) {
  const n = typeof priceMinor === 'number' ? priceMinor : NaN;
  if (!Number.isSafeInteger(n) || n < STRIPE_PRICE_MIN || n > STRIPE_PRICE_MAX) throw fail(400, 'BAD_PRICE', 'Set a price from 0.50 to 999,999.99.');
  const cur = typeof currency === 'string' ? currency.trim().toLowerCase() : '';
  if (!/^[a-z]{3}$/.test(cur)) throw fail(400, 'BAD_PRICE', 'Choose a currency.');
  if (!priceText(n, cur)) throw fail(400, 'BAD_PRICE', 'Choose a currency.');
  return { priceMinor: n, currency: cur };
}

/**
 * ctx: { db, connect (the core), pc (offer ids), cleanText(v, max, what), drop(id) }.
 */
export function createStripeOffers({ db, connect, pc, cleanText }) {
  /** The user's account for new offers, or 409. */
  async function accountFor(userId) {
    const row = connect.enabled ? await connect.rows.liveRow(userId) : null;
    if (!row || !OFFER_ACCOUNT.includes(row.status)) throw fail(409, 'STRIPE_NOT_CONNECTED', 'Set up Stripe in Settings › Payments first.');
    return row;
  }

  /** A delivery as stored: { kind: 'none' } or { kind: 'file', fileId } (the user's own product file). */
  async function deliveryOf(userId, d) {
    if (d === undefined || d === null) return { kind: 'none' };
    if (typeof d !== 'object' || Array.isArray(d)) throw fail(400, 'BAD_DELIVERY', 'Choose how the buyer gets it.');
    if (d.kind === 'none') return { kind: 'none' };
    if (d.kind !== 'file' || typeof d.fileId !== 'string' || !ID_RE.test(d.fileId)) throw fail(400, 'BAD_DELIVERY', 'Choose how the buyer gets it.');
    const [file] = await db.select('lead_files', { id: d.fileId, user_id: userId }, { select: 'id,kind,purpose', limit: 1 });
    if (!file || file.purpose !== 'product' || file.kind !== 'file') throw fail(400, 'BAD_DELIVERY', 'Choose one of your product files (Products › Files).');
    return { kind: 'file', fileId: file.id };
  }

  async function create(who, b) {
    const projectId = typeof b.projectId === 'string' && PROJECT_ID_RE.test(b.projectId) ? b.projectId : null;
    if (!projectId) throw fail(400, 'BAD_REQUEST', 'Unknown business.');
    const title = cleanText(b.title, 200, 'The title') ?? '';
    if (!title) throw fail(400, 'BAD_REQUEST', 'Give the offer a title.');
    const { priceMinor, currency } = stripePriceOf(b.priceMinor, b.currency);
    const crid = String(b.clientRequestId ?? '');
    if (!isUuid(crid)) throw fail(400, 'BAD_REQUEST', 'clientRequestId must be a UUID.');
    const account = await accountFor(who.id);
    const delivery = await deliveryOf(who.id, b.delivery);
    const id = pc.offerIdFor(who.id, crid);
    const [existing] = await db.select('offers', { id }, { limit: 1 });
    if (existing) {
      if (existing.user_id !== who.id || existing.provider !== 'stripe') throw fail(409, 'CONFLICT', 'Try again.');
      return existing;
    }
    const mine = await db.select('offers', { user_id: who.id, status: ['neq', 'archived'] }, { select: 'id', limit: MAX_OFFERS_PER_USER + 1 });
    if (mine.length >= MAX_OFFERS_PER_USER) throw fail(400, 'TOO_MANY', `You can have up to ${MAX_OFFERS_PER_USER} buy links. Archive one first.`);
    const inserted = await db.insert('offers', { id, user_id: who.id, project_id: projectId, title, price_minor: priceMinor, currency, price_display: priceText(priceMinor, currency), provider: 'stripe', connect_account_id: account.id, provider_ref: {}, delivery, status: 'active' }, { returning: true, ignoreDuplicates: true, onConflict: 'id' });
    return inserted[0] ?? (await db.select('offers', { id, user_id: who.id }, { limit: 1 }))[0];
  }

  /** The patch for a Stripe offer (fields checked); status changes are the caller's. */
  async function patchFields(row, b) {
    const patch = {};
    if (b.priceMinor !== undefined || b.currency !== undefined) {
      const { priceMinor, currency } = stripePriceOf(b.priceMinor ?? Number(row.price_minor), b.currency ?? row.currency);
      Object.assign(patch, { price_minor: priceMinor, currency, price_display: priceText(priceMinor, currency) });
    }
    if (b.delivery !== undefined) patch.delivery = await deliveryOf(row.user_id, b.delivery);
    if (b.priceDisplay !== undefined || b.url !== undefined) throw fail(400, 'BAD_REQUEST', 'A Stripe offer’s price is set with priceMinor and currency.');
    return patch;
  }

  /** A paused Stripe offer sells again only on a seller account that's still connected. */
  async function sellable(row) {
    const acct = row.connect_account_id ? await connect.rows.rowById(row.connect_account_id) : null;
    if (!acct || acct.status === 'disconnected' || acct.user_id !== row.user_id) throw fail(409, 'NOT_SELLABLE', 'Your Stripe account isn’t connected here any more: set up Stripe in Settings › Payments.');
  }

  /** describeOffer's extras for Stripe offers: { [offerId]: { environment, delivery, problem? } }. */
  async function extrasFor(rows) {
    const stripeRows = rows.filter((r) => r.provider === 'stripe');
    if (!stripeRows.length) return new Map();
    const ids = [...new Set(stripeRows.map((r) => r.connect_account_id).filter(Boolean))];
    const accts = ids.length ? await db.select('connect_accounts', { id: ['in', ids] }, { select: 'id,environment,status,charges_enabled', limit: ids.length }) : [];
    const byId = new Map(accts.map((a) => [a.id, a]));
    const out = new Map();
    for (const r of stripeRows) {
      const a = byId.get(r.connect_account_id);
      const ready = a && a.status === 'active' && a.charges_enabled === true;
      out.set(r.id, { environment: a?.environment ?? connect.cfg.environment ?? null, delivery: r.delivery && typeof r.delivery === 'object' ? { kind: r.delivery.kind, ...(r.delivery.fileId ? { fileId: r.delivery.fileId } : {}) } : { kind: 'none' }, ...(ready ? {} : { problem: 'stripe_setup' }) });
    }
    return out;
  }

  return { create, patchFields, sellable, extrasFor, accountFor };
}
