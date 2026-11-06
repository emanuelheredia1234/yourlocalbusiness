// Offers' rows and secrets: ids, the sealed Whop keys and webhook secrets, and what the browser sees of each row.
// The tables are in supabase/migrations/20261113000000_offers.sql (server-only: row-level security with no policies).
//
// Keys and webhook secrets are sealed with AES-256-GCM (server/secretBox.mjs) under their own label,
// 'ylb-payment-keys', so they never share a key with the AI keys (server/userKeys.mjs), and each ciphertext is bound
// to its row and use (AAD "<user id>:<connection id>:key" or ":webhook"): one copied to another row doesn't open.
// The secret: PAYMENT_KEYS_SECRET (32+ characters), else USER_KEYS_SECRET, else the Supabase secret key.

import crypto from 'node:crypto';
import { createSecretBox } from '../secretBox.mjs';

export const OFFERS_MIGRATION = 'supabase/migrations/20261113000000_offers.sql';
export const ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const ACCOUNT_RE = /^biz_[A-Za-z0-9]{4,64}$/;
export const PRODUCT_RE = /^prod_[A-Za-z0-9]{4,64}$/;
export const PLAN_RE = /^plan_[A-Za-z0-9]{4,64}$/;
export const CHECKOUT_RE = /^ch_[A-Za-z0-9]{4,64}$/;
/** Non-archived offers a user may have. */
export const MAX_OFFERS_PER_USER = 100;

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A new random id: 16 bytes, 22 base64url characters (connections). */
export const newId = () => b64url(crypto.randomBytes(16));

/**
 * The secret that seals payment keys, and where it came from (for the startup notes; never the value), or null.
 */
export function paymentKeysSecret(env = process.env) {
  const own = String(env.PAYMENT_KEYS_SECRET ?? '');
  if (own.length >= 32) return { secret: own, source: 'PAYMENT_KEYS_SECRET' };
  const user = String(env.USER_KEYS_SECRET ?? '');
  if (user.length >= 16) return { secret: user, source: 'USER_KEYS_SECRET' };
  const sb = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (sb) return { secret: sb, source: 'SUPABASE_SECRET_KEY' };
  return null;
}

/** The sealing box for payment keys and the id maker for offers (deterministic per user and click), or null. */
export function createPaymentCrypto(secret) {
  if (!secret) return null;
  const box = createSecretBox(secret, 'ylb-payment-keys');
  const idKey = crypto.createHash('sha256').update(`ylb-offer-ids:${secret}`).digest();
  return {
    sealKey: (userId, connId, key) => box.seal(key, `${userId}:${connId}:key`),
    openKey: (userId, connId, ct) => box.open(ct, `${userId}:${connId}:key`),
    sealWebhook: (userId, connId, s) => box.seal(s, `${userId}:${connId}:webhook`),
    openWebhook: (userId, connId, ct) => box.open(ct, `${userId}:${connId}:webhook`),
    /** The offer id for one "Create" click: a double click makes the same id, so one row and one Whop call. */
    offerIdFor: (userId, clientRequestId) => b64url(crypto.createHmac('sha256', idKey).update(`${userId}:${clientRequestId}`).digest().subarray(0, 16)),
  };
}

/** The key's last 4 characters (the browser's only view of it). */
export const last4 = (key) => String(key).slice(-4);

/** What the browser sees of a connection: never the key, the secret or Whop's webhook id. */
export function describeConnection(r, { webhookUrl = null } = {}) {
  return {
    id: r.id,
    provider: r.provider,
    environment: r.environment,
    accountId: r.account_id,
    accountName: r.account_name ?? '',
    keyLast4: r.status === 'disconnected' ? '' : (r.key_last4 ?? ''),
    webhook: { mode: r.webhook_mode, state: r.webhook_state, ...(r.webhook_mode === 'manual' && webhookUrl ? { url: webhookUrl } : {}) },
    status: r.status,
    lastEventAt: r.last_event_at ?? null,
    checkedAt: r.checked_at ?? null,
    createdAt: r.created_at ?? null,
  };
}

/** A link's host for the browser (www. dropped), or ''. */
export function hostOf(href) {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** What the browser sees of an offer: never a key, never the checkout link's query string (the host is enough). */
export function describeOffer(r, origin, sales = null) {
  const ref = r.provider_ref && typeof r.provider_ref === 'object' ? r.provider_ref : {};
  const checkoutHost = r.provider === 'whop' ? hostOf(ref.purchaseUrl) || (ref.environment === 'sandbox' ? 'sandbox.whop.com' : 'whop.com') : r.provider === 'external' ? hostOf(ref.url) : '';
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title ?? '',
    priceDisplay: r.price_display ?? '',
    priceMinor: r.price_minor == null ? null : Number(r.price_minor),
    currency: r.currency ?? null,
    provider: r.provider,
    status: r.status,
    environment: r.provider === 'whop' ? (ref.environment === 'sandbox' ? 'sandbox' : 'production') : null,
    // the Whop connection it sells through (the browser matches it by id: a reconnect makes a new one)
    connectionId: r.provider === 'whop' ? r.connection_id ?? null : null,
    checkoutHost,
    // an outside link is the owner's own: they see it to edit it
    ...(r.provider === 'external' ? { url: typeof ref.url === 'string' ? ref.url : '' } : {}),
    clicks: Number(r.clicks) || 0,
    lastClickAt: r.last_click_at ?? null,
    sales: sales ?? { count: 0, last: null },
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
    link: `${origin}/b/${r.id}`,
  };
}

/** What the browser sees of a sale (the buyer's email is the owner's own customer data: shown, never logged). */
export function describeSale(r) {
  return {
    id: r.id,
    offerId: r.offer_id ?? null,
    projectId: r.project_id,
    status: r.status,
    amountMinor: Number(r.amount_minor) || 0,
    refundedMinor: Number(r.refunded_minor) || 0,
    currency: r.currency,
    environment: r.environment,
    buyerEmail: r.buyer_email ?? null,
    paidAt: r.paid_at ?? null,
    createdAt: r.created_at ?? null,
  };
}

/** A price as people read it ("$49", "$19/month") from minor units; '' when it can't be said. */
export function priceText(minor, currency, period = null) {
  if (minor == null || !Number.isFinite(Number(minor)) || !currency) return '';
  const cur = String(currency).toUpperCase();
  const zero = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF']);
  let text;
  try {
    text = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: zero.has(cur) || Number(minor) % 100 === 0 ? 0 : 2, maximumFractionDigits: zero.has(cur) ? 0 : 2 }).format(zero.has(cur) ? Number(minor) : Number(minor) / 100);
  } catch {
    return '';
  }
  return (period ? `${text}/${period}` : text).slice(0, 40);
}
