// Whop's webhooks, the parts that need no network and no database: the signature check, the event's shape, money
// and what a Payment says about a sale. server/payments/whop.mjs runs the route; server/test/mock-whop.mjs signs
// with the same whopHmacKey.
//
// Signature (Standard Webhooks, https://docs.whop.com/developer/guides/webhooks.md): headers webhook-id,
// webhook-timestamp (seconds) and webhook-signature (space-separated "v1,<base64>" entries). The signed content is
// "<id>.<timestamp>.<raw body>", the exact bytes received (never re-serialised), HMAC-SHA256, base64. Any v1 entry
// may match; the compare is constant-time; a timestamp more than 5 minutes from now is refused.
//
// UNCONFIRMED (Whop's docs don't say it in words): how the HMAC key comes from the "ws_…" secret. whopHmacKey is the
// only place that decides it, with no fallback that tries other keys. It must be confirmed with Whop's "send test
// webhook" in the sandbox before Whop goes live (docs/integrations-setup.md); if it's wrong, only this changes.

import crypto from 'node:crypto';

/** The events a connection's webhook subscribes to (memberships aren't: no use yet, less buyer data). */
export const WHOP_EVENTS = Object.freeze(['payment.succeeded', 'payment.failed', 'payment.pending', 'refund.created', 'refund.updated', 'dispute.created', 'dispute.updated']);
/** How far a webhook's timestamp may be from now. */
export const WEBHOOK_TOLERANCE_S = 300;
const MAX_HEADER = 1024;
const OFFER_ID = /^[A-Za-z0-9_-]{22}$/;
const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
const PAY_ID = /^pay_[A-Za-z0-9]{4,64}$/;
const MEM_ID = /^mem_[A-Za-z0-9]{4,64}$/;
const CH_ID = /^ch_[A-Za-z0-9]{4,64}$/;

/**
 * The HMAC key for a webhook secret: the UTF-8 bytes of the whole "ws_…" string (what handing the standard library
 * btoa(secret) amounts to). UNCONFIRMED: see the header.
 */
export function whopHmacKey(secret) {
  return Buffer.from(String(secret), 'utf8');
}

const signed = (raw, id, timestamp) => Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')]);

/** A webhook-signature header value for these bytes (the mock and the tests sign with it). */
export function signWhopPayload(raw, id, timestamp, secret) {
  return `v1,${crypto.createHmac('sha256', whopHmacKey(secret)).update(signed(raw, id, timestamp)).digest('base64')}`;
}

const header = (headers, name) => {
  const v = headers?.[name];
  return typeof v === 'string' ? v : null;
};

/**
 * Whether raw (a Buffer, as received) carries a valid signature by `secret`, made within the tolerance of `now` (ms).
 * headers: Node's request headers (lower-case names). Never throws.
 */
export function verifyWhopSignature(raw, headers, secret, now = Date.now()) {
  try {
    if (!secret || typeof secret !== 'string' || !Buffer.isBuffer(raw)) return false;
    const id = header(headers, 'webhook-id');
    const ts = header(headers, 'webhook-timestamp');
    const sig = header(headers, 'webhook-signature');
    if (!id || !ts || !sig) return false;
    if (id.length > MAX_HEADER || ts.length > MAX_HEADER || sig.length > MAX_HEADER) return false;
    if (!/^\d{1,12}$/.test(ts)) return false;
    if (Math.abs(Math.floor(now / 1000) - Number(ts)) > WEBHOOK_TOLERANCE_S) return false;
    const want = crypto.createHmac('sha256', whopHmacKey(secret)).update(signed(raw, id, ts)).digest();
    let ok = false;
    for (const entry of sig.split(' ')) {
      const comma = entry.indexOf(',');
      if (comma < 0 || entry.slice(0, comma) !== 'v1') continue;
      const b64 = entry.slice(comma + 1);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue;
      const got = Buffer.from(b64, 'base64');
      // every entry is compared, so the time doesn't tell which one matched
      if (got.length === want.length && crypto.timingSafeEqual(got, want)) ok = true;
    }
    return ok;
  } catch {
    return false;
  }
}

/** The event in a verified body: { id, type, timestamp, account, data } or null when it isn't one. */
export function parseEvent(raw) {
  let evt;
  try {
    evt = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    return null;
  }
  if (!evt || typeof evt !== 'object' || Array.isArray(evt)) return null;
  if (typeof evt.id !== 'string' || typeof evt.type !== 'string' || !evt.data || typeof evt.data !== 'object' || Array.isArray(evt.data)) return null;
  // the seller: account_id (pinned versions from 2026-08-14), company_id (older ones)
  const account = typeof evt.account_id === 'string' ? evt.account_id : typeof evt.company_id === 'string' ? evt.company_id : null;
  const at = Date.parse(String(evt.timestamp ?? ''));
  return { id: evt.id.slice(0, 128), type: evt.type.slice(0, 80), timestamp: Number.isFinite(at) ? new Date(at).toISOString() : null, account, data: evt.data };
}

/**
 * Money in minor units, without floats. Whop sends { amount: "10.00", currency, decimals } (older shapes a number).
 * → { minor, currency, ok }; anything unreadable is { minor: 0, ok: false } (the caller keeps the sale at 0 and tells
 * the owner), never a throw.
 */
export function toMinor(money, fallbackCurrency = null) {
  const cur = (c) => (typeof c === 'string' && /^[A-Za-z]{3}$/.test(c) ? c.toLowerCase() : null);
  let amount = money;
  let decimals = 2;
  let currency = cur(fallbackCurrency);
  if (money && typeof money === 'object' && !Array.isArray(money)) {
    amount = money.amount;
    if (money.decimals != null) decimals = Number(money.decimals);
    currency = cur(money.currency) ?? currency;
  }
  const bad = { minor: 0, currency, ok: false };
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) return bad;
  let text;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return bad;
    text = amount.toFixed(decimals);
  } else if (typeof amount === 'string') text = amount.trim();
  else return bad;
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) return bad;
  const [, sign, whole, frac = ''] = m;
  if (sign) return bad;
  // more digits than the currency has: only zeros may be dropped
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) return bad;
  const minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || '0').padEnd(decimals, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return bad;
  return { minor: Number(minor), currency, ok: true };
}

/** A buyer's email as stored: lower-case, at most 254 characters, an address's shape; else null. */
export function cleanEmail(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s.length <= 254 && EMAIL.test(s) ? s : null;
}

const STATUS_BY_EVENT = {
  'payment.succeeded': 'paid',
  'payment.pending': 'pending',
  'payment.requires_action': 'pending',
  'payment.created': 'pending',
  'payment.authorized': 'pending',
  'payment.failed': 'failed',
  'payment.canceled': 'failed',
};

const isoOrNull = (v) => {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The offer id our checkout put in a Payment's metadata (ylb_offer), or null. */
export function offerIdOf(payment) {
  const v = payment?.metadata?.ylb_offer;
  return typeof v === 'string' && OFFER_ID.test(v) ? v : null;
}

/**
 * What a Payment (a payment.* event's data, or a refund's full payment) says about its sale, or null when it isn't a
 * payment. type: the event type (its status; a payment's own `status: paid` and refunded amount win when later).
 * → { paymentId, offerId, checkoutId, account, status, amountMinor, amountOk, netMinor, refundedMinor, currency,
 *     email, paidAt, membershipId }
 */
export function saleFromPayment(type, p) {
  if (!p || typeof p !== 'object' || !PAY_ID.test(String(p.id ?? ''))) return null;
  const total = toMinor(p.total ?? p.final_amount ?? p.subtotal, p.currency);
  const net = p.amount_after_fees != null ? toMinor(p.amount_after_fees, total.currency) : null;
  const refunded = p.refunded_amount != null ? toMinor(p.refunded_amount, total.currency) : null;
  let status = STATUS_BY_EVENT[type] ?? null;
  if (p.status === 'paid' && (!status || status === 'pending')) status = 'paid';
  if (!status) status = p.status === 'paid' ? 'paid' : null;
  const refundedMinor = refunded?.ok ? refunded.minor : 0;
  if (status === 'paid' && refundedMinor > 0) status = total.ok && refundedMinor >= total.minor ? 'refunded' : 'partially_refunded';
  if (!status) return null;
  return {
    paymentId: p.id,
    offerId: offerIdOf(p),
    checkoutId: CH_ID.test(String(p.checkout_configuration_id ?? '')) ? p.checkout_configuration_id : null,
    account: typeof p.account_id === 'string' ? p.account_id : typeof p.company_id === 'string' ? p.company_id : null,
    status,
    amountMinor: total.ok ? total.minor : 0,
    amountOk: total.ok,
    netMinor: net?.ok ? net.minor : null,
    refundedMinor,
    currency: total.currency,
    email: cleanEmail(p.customer_email ?? p.user?.email),
    paidAt: isoOrNull(p.paid_at),
    membershipId: MEM_ID.test(String(p.membership_id ?? '')) ? p.membership_id : null,
  };
}

/** The payment a refund or dispute is about: { paymentId, payment (the full Payment, when sent) } or null. */
export function paymentOf(data) {
  const full = data?.payment && typeof data.payment === 'object' ? data.payment : null;
  const id = full?.id ?? data?.payment_id;
  if (typeof id !== 'string' || !PAY_ID.test(id)) return null;
  return { paymentId: id, payment: full && (full.total != null || full.metadata != null) ? full : null };
}
