// Offers and buy links: the client for server/offers/index.mjs. One offer is one thing a business sells, with one
// permanent buy link https://<app>/b/<id>; the checkout behind it is the owner's own Stripe account (Stripe Checkout
// on their account, P6: src/lib/stripeConnect.ts), their own Whop account (sales come back through Whop's webhook)
// or their own checkout link (only its clicks show). The money goes to the owner's own account, never the app's,
// and the app never holds a checkout address in a page: pages hold {{buy:<id>}} (src/lib/buyLinks.ts). Needs the app's
// server with accounts, so none of this is offered in the claude.ai build.

import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import checkoutHosts from '../../shared/checkout-hosts.json';
import { OFFER_ID } from './buyLinks';
import type { Project } from './types';

export type OfferProvider = 'whop' | 'external' | 'stripe';
export type OfferStatus = 'draft' | 'active' | 'paused' | 'checkout_unknown' | 'archived';
export type WhopEnvironment = 'sandbox' | 'production';

/** An offer, as the server describes it (never a key, never the checkout address's query). */
export interface Offer {
  id: string;
  projectId: string;
  title: string;
  /** "$49", "$19/month": display only */
  priceDisplay: string;
  priceMinor: number | null;
  currency: string | null;
  provider: OfferProvider;
  status: OfferStatus;
  /** Whop: which of the owner's connections (sandbox = Test mode); null for an outside link */
  environment: WhopEnvironment | null;
  /** Whop: the connection it sells through (a reconnect makes a new one, so it's matched by id) */
  connectionId?: string | null;
  /** where buyers pay: whop.com, sandbox.whop.com or the outside link's host */
  checkoutHost: string;
  /** the owner's own outside link (external offers only) */
  url?: string;
  /** Stripe: how the buyer gets it (nothing to download: the seller delivers; or one of the seller's product files) */
  delivery?: OfferDelivery;
  /** Stripe: the seller still has Stripe setup to finish, so its buy link doesn't sell yet */
  problem?: 'stripe_setup';
  clicks: number;
  lastClickAt: string | null;
  /** live sales */
  sales: { count: number; last: string | null };
  createdAt: string | null;
  updatedAt: string | null;
  /** https://<app>/b/<id> */
  link: string;
}

export interface OfferDelivery {
  kind: 'none' | 'file' | 'provider';
  fileId?: string;
}

export type SaleStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded' | 'disputed';

export interface Sale {
  id: string;
  offerId: string | null;
  projectId: string;
  status: SaleStatus;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  environment: WhopEnvironment;
  /** the owner's own customer: shown in the app, never logged */
  buyerEmail: string | null;
  paidAt: string | null;
  createdAt: string | null;
  /** who took the payment (older servers don't say: before Stripe, every recorded sale was Whop's) */
  provider?: OfferProvider | null;
  /** Stripe: our fee on it (minor units, null when none was taken), its percentage, how much of it went back */
  feeMinor?: number | null;
  feePct?: number | null;
  feeReturnedMinor?: number;
  /** Stripe: a dispute's state as Stripe says it (needs_response, under_review, won, lost…) */
  disputeStatus?: string | null;
  /** Stripe: how many times its file was downloaded */
  downloads?: number;
}

export interface SalesSummary {
  days: number;
  live: { count: number; revenue: Record<string, number>; refunded: Record<string, number> };
  test: { count: number };
  /** every click on the business's buy links (all time) */
  clicks: number;
  offers: { id: string; clicks: number; sales: number }[];
}

export type WebhookMode = 'none' | 'auto' | 'manual';
export type WebhookState = 'missing' | 'ok' | 'unknown' | 'disabled';

export interface WhopConnection {
  id: string;
  environment: WhopEnvironment;
  accountId: string;
  accountName: string;
  keyLast4: string;
  /** url: where Whop sends sales (manual mode only, to copy into Whop) */
  webhook: { mode: WebhookMode; state: WebhookState; url?: string };
  status: 'active' | 'key_rejected' | 'disconnected';
  lastEventAt: string | null;
  checkedAt: string | null;
}

export interface WhopProduct {
  id: string;
  title: string;
  visibility: string | null;
}

export interface WhopPrice {
  minor: number | null;
  currency: string;
  display: string;
}

export interface WhopPlan {
  id: string;
  productId: string | null;
  title: string;
  billingType: 'renewal' | 'one_time';
  price: WhopPrice;
  renewal?: WhopPrice & { period: string | null };
  trialDays: number | null;
  visibility: string | null;
}

/** What Whop sends buyers' payments to (the events the owner picks when they make the webhook by hand). */
export const WHOP_EVENTS = ['payment.succeeded', 'payment.failed', 'payment.pending', 'refund.created', 'refund.updated', 'dispute.created', 'dispute.updated'] as const;

/** The permissions a Whop API key needs (the last one only for the automatic webhook). */
export const WHOP_PERMISSIONS: { name: string; why: string; optional?: boolean }[] = [
  { name: 'access_pass:basic:read', why: 'see your products' },
  { name: 'plan:basic:read', why: 'see their plans and prices' },
  { name: 'checkout_configuration:create', why: 'make each offer’s checkout link' },
  { name: 'checkout_configuration:basic:read', why: 'check the link Whop made' },
  { name: 'payment:basic:read', why: 'see your sales' },
  { name: 'member:email:read', why: 'see each buyer’s email' },
  { name: 'webhook_receive:payments', why: 'hear about each sale' },
  { name: 'developer:manage_webhook', why: 'set up sales updates for you', optional: true },
];

export class OffersError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Plain words for the server's refusals (its own message, already ours, is used for the others). */
const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Your sign-in has ended. Sign in again, then try once more.',
  NOT_SET_UP: 'Payments aren’t set up on this app’s server yet.',
  RATE_LIMITED: 'That’s a lot of changes at once. Wait a minute, then try again.',
  RATE_LIMIT: 'That’s a lot of changes at once. Wait a minute, then try again.',
  FORBIDDEN: 'This request was refused because it didn’t come from the app’s own page.',
  NETWORK: 'Couldn’t reach the server. Check your connection, then try again.',
  UPGRADE: 'Selling needs an active plan. See Settings › Plan.',
  BAD_URL: 'Use a full web address starting with https://, without a user name or password.',
  WHOP_KEY_REJECTED: 'Whop didn’t accept this API key. Check it, or make a new one in Whop’s dashboard.',
  WHOP_ACCOUNT: 'That Whop account id doesn’t match this key. Copy the biz_… id of the account the key was made in.',
  WHOP_BUSY: 'Whop is busy. Try again in a minute.',
  WHOP_UNAVAILABLE: 'Whop didn’t answer just now. Try again in a few minutes.',
  WHOP_REFUSED: 'Whop didn’t accept this. Check the plan is still for sale.',
  WHOP_PLAN_GONE: 'That plan isn’t in your Whop account anymore. Pick another.',
  ALREADY_CONNECTED: 'A Whop account is already connected here. Disconnect it first.',
  CHECKOUT_EXPIRED: 'Whop no longer remembers this request. Make a new link for this plan.',
  HAS_SALES: 'This offer has sales, so it stays for your records. Archive it instead.',
  HAS_CHECKOUT: 'Whop’s checkout for this offer stays open, so it stays for your records. Archive it instead.',
  NOT_SELLABLE: 'This offer can’t sell again as it is. Attach another plan.',
};

/** Codes whose server sentence is already ours and says what to do next (Stripe's: never Stripe's own text). */
const SERVER_WORDS = new Set(['OFFERS_LIVE', 'TOO_MANY', 'BAD_REQUEST', 'NOT_FOUND', 'STRIPE_NOT_CONNECTED', 'STRIPE_SETUP', 'STRIPE_REJECTED', 'STRIPE_REFUSED', 'TAX_NOT_READY', 'PENDING', 'CONFIRM', 'BAD_COUNTRY', 'TERMS_REQUIRED', 'BAD_PRICE', 'BAD_DELIVERY', 'NO_FILE', 'NOT_PAID', 'UNAVAILABLE', 'ACCOUNT_DELETING', 'IN_USE']);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const STATUSES: OfferStatus[] = ['draft', 'active', 'paused', 'checkout_unknown', 'archived'];
const SALE_STATUSES: SaleStatus[] = ['pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed'];

/** An offer from the server's answer, or null when it isn't one. */
export function toOffer(raw: unknown): Offer | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || !OFFER_ID.test(str(r.id))) return null;
  const provider: OfferProvider = r.provider === 'whop' ? 'whop' : r.provider === 'stripe' ? 'stripe' : 'external';
  const sales = (r.sales ?? {}) as Record<string, unknown>;
  const link = str(r.link);
  return {
    id: str(r.id),
    projectId: str(r.projectId),
    title: str(r.title),
    priceDisplay: str(r.priceDisplay),
    priceMinor: typeof r.priceMinor === 'number' && Number.isFinite(r.priceMinor) ? r.priceMinor : null,
    currency: /^[a-z]{3}$/.test(str(r.currency)) ? str(r.currency) : null,
    provider,
    status: STATUSES.includes(r.status as OfferStatus) ? (r.status as OfferStatus) : 'draft',
    environment: r.environment === 'sandbox' ? 'sandbox' : r.environment === 'production' ? 'production' : null,
    connectionId: provider === 'whop' && str(r.connectionId) ? str(r.connectionId) : null,
    checkoutHost: str(r.checkoutHost),
    ...(provider === 'external' ? { url: /^https:\/\//i.test(str(r.url)) ? str(r.url) : '' } : {}),
    ...(provider === 'stripe' ? { delivery: toDelivery(r.delivery) } : {}),
    ...(provider === 'stripe' && r.problem === 'stripe_setup' ? { problem: 'stripe_setup' as const } : {}),
    clicks: num(r.clicks),
    lastClickAt: strOrNull(r.lastClickAt),
    sales: { count: num(sales.count), last: strOrNull(sales.last) },
    createdAt: strOrNull(r.createdAt),
    updatedAt: strOrNull(r.updatedAt),
    link: new RegExp(`^https?://[^/]+/b/${str(r.id)}$`).test(link) ? link : '',
  };
}

const FILE_ID = /^[A-Za-z0-9_-]{22}$/;
function toDelivery(raw: unknown): OfferDelivery {
  const d = (raw ?? {}) as Record<string, unknown>;
  if (d.kind === 'file' && FILE_ID.test(str(d.fileId))) return { kind: 'file', fileId: str(d.fileId) };
  return { kind: d.kind === 'provider' ? 'provider' : 'none' };
}
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

export function toSale(raw: unknown): Sale | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !str(r.id)) return null;
  const stripe = r.provider === 'stripe' || 'feeMinor' in r;
  return {
    id: str(r.id),
    offerId: OFFER_ID.test(str(r.offerId)) ? str(r.offerId) : null,
    projectId: str(r.projectId),
    status: SALE_STATUSES.includes(r.status as SaleStatus) ? (r.status as SaleStatus) : 'pending',
    amountMinor: num(r.amountMinor),
    refundedMinor: num(r.refundedMinor),
    currency: /^[a-z]{3}$/.test(str(r.currency)) ? str(r.currency) : 'usd',
    environment: r.environment === 'sandbox' ? 'sandbox' : 'production',
    buyerEmail: strOrNull(r.buyerEmail),
    paidAt: strOrNull(r.paidAt),
    createdAt: strOrNull(r.createdAt),
    provider: r.provider === 'whop' || r.provider === 'external' || r.provider === 'stripe' ? r.provider : stripe ? 'stripe' : null,
    ...(stripe
      ? {
          feeMinor: numOrNull(r.feeMinor),
          feePct: numOrNull(r.feePct),
          feeReturnedMinor: num(r.feeReturnedMinor),
          disputeStatus: /^[a-z_]{1,40}$/.test(str(r.disputeStatus)) ? str(r.disputeStatus) : null,
          downloads: num(r.downloads),
        }
      : {}),
  };
}

export function toConnection(raw: unknown): WhopConnection | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !OFFER_ID.test(str(r.id))) return null;
  const w = (r.webhook ?? {}) as Record<string, unknown>;
  const mode: WebhookMode = w.mode === 'auto' || w.mode === 'manual' ? w.mode : 'none';
  const state: WebhookState = w.state === 'ok' || w.state === 'unknown' || w.state === 'disabled' ? w.state : 'missing';
  return {
    id: str(r.id),
    environment: r.environment === 'sandbox' ? 'sandbox' : 'production',
    accountId: str(r.accountId),
    accountName: str(r.accountName),
    keyLast4: str(r.keyLast4).slice(-4),
    webhook: { mode, state, ...(mode === 'manual' && /^https?:\/\//.test(str(w.url)) ? { url: str(w.url) } : {}) },
    status: r.status === 'key_rejected' ? 'key_rejected' : r.status === 'disconnected' ? 'disconnected' : 'active',
    lastEventAt: strOrNull(r.lastEventAt),
    checkedAt: strOrNull(r.checkedAt),
  };
}

/** The error for a refused answer: the server's code, in plain words. */
export function offersError(status: number, body: Record<string, unknown> | null, serverWords: readonly string[] = []): OffersError {
  let code = str(body?.code) || (status === 429 ? 'RATE_LIMITED' : status === 401 ? 'AUTH_REQUIRED' : `HTTP_${status}`);
  if (status === 402) code = 'UPGRADE';
  const { error: _e, code: _c, hint: _h, ...extra } = body ?? {};
  let message = MESSAGES[code] ?? (str(body?.error) || `The server couldn’t do that (error ${status}). Try again.`);
  if (code === 'WHOP_PERMISSION') message = str(extra.missing) ? `This Whop API key needs the ${str(extra.missing)} permission. Add it to the key in Whop, then try again.` : 'This Whop API key is missing a permission this needs. See the list below.';
  if (code === 'WHOP_BUSY' && typeof extra.retryAfter === 'number') message = `Whop is busy. Try again in ${Math.max(1, Math.round(extra.retryAfter))} seconds.`;
  // the server's own words for these (they're already ours: counts, what to do next)
  if ((SERVER_WORDS.has(code) || serverWords.includes(code)) && str(body?.error)) message = str(body?.error);
  return new OffersError(message, code, status, extra);
}

/** One call to the app's server (exported for the Stripe client, src/lib/stripeConnect.ts). */
export async function offersCall<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, json?: unknown, signal?: AbortSignal, serverWords: readonly string[] = []): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    res = await serverFetch(serverBaseNow(), path, { method, headers, body, signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new OffersError(MESSAGES.NETWORK, 'NETWORK');
  }
  const got = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw offersError(res.status, got, serverWords);
  return { status: res.status, body: (got ?? {}) as T };
}
const call = offersCall;

const idPath = (id: string) => {
  if (!OFFER_ID.test(id)) throw new OffersError('That isn’t one of your offers.', 'BAD_ID');
  return id;
};
const one = (j: { offer?: unknown }): Offer => {
  const o = toOffer(j.offer);
  if (!o) throw new OffersError('The server’s answer couldn’t be read. Try again.', 'BAD_ANSWER');
  return o;
};
const conn = (j: { connection?: unknown }): WhopConnection => {
  const c = toConnection(j.connection);
  if (!c) throw new OffersError('The server’s answer couldn’t be read. Try again.', 'BAD_ANSWER');
  return c;
};
const q = (params: Record<string, string | number | undefined | null | false>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false && v !== '') s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : '';
};

// ───────────── offers ─────────────

/** A business's offers, newest first (archived ones only when asked). */
export async function listOffers(projectId: string, opts: { archived?: boolean; signal?: AbortSignal } = {}): Promise<Offer[]> {
  const { body } = await call<{ offers?: unknown }>('GET', `/api/offers${q({ projectId, archived: opts.archived ? 1 : undefined })}`, undefined, opts.signal);
  return (Array.isArray(body.offers) ? body.offers : []).map(toOffer).filter((o): o is Offer => !!o);
}

/** An offer for the owner's own checkout link. clientRequestId (one per press of Create) makes a double press one offer. */
export async function createExternalOffer(input: { projectId: string; title: string; url: string; priceDisplay?: string; clientRequestId?: string }): Promise<Offer> {
  return one((await call<{ offer?: unknown }>('POST', '/api/offers', { ...input, provider: 'external' })).body);
}

/** An offer for a Whop plan. unconfirmed: Whop didn't confirm the link yet (status checkout_unknown: use checkOffer). */
export async function createWhopOffer(input: { projectId: string; title?: string; connectionId: string; productId: string; variantId: string; clientRequestId: string }): Promise<{ offer: Offer; unconfirmed: boolean }> {
  const { status, body } = await call<{ offer?: unknown }>('POST', '/api/offers', { ...input, provider: 'whop' });
  const offer = one(body);
  return { offer, unconfirmed: status === 202 || offer.status === 'checkout_unknown' };
}

/**
 * An offer sold through the seller's own Stripe account (Settings › Payments). No Stripe call is made here: each
 * checkout sends its price. clientRequestId (one per press of Create) makes a double press one offer.
 */
export async function createStripeOffer(input: { projectId: string; title: string; priceMinor: number; currency: string; delivery: { kind: 'none' } | { kind: 'file'; fileId: string }; clientRequestId: string }): Promise<Offer> {
  return one((await call<{ offer?: unknown }>('POST', '/api/offers', { ...input, provider: 'stripe' })).body);
}

export async function updateOffer(id: string, patch: { title?: string; priceDisplay?: string; url?: string; status?: 'active' | 'paused'; priceMinor?: number; currency?: string; delivery?: { kind: 'none' } | { kind: 'file'; fileId: string } }): Promise<Offer> {
  return one((await call<{ offer?: unknown }>('PATCH', `/api/offers/${idPath(id)}`, patch)).body);
}

/** Whop: ask again for a link Whop didn't confirm, or read the plan's price again ("Refresh from Whop"). */
export async function checkOffer(id: string): Promise<{ offer: Offer; unconfirmed: boolean }> {
  const { status, body } = await call<{ offer?: unknown }>('POST', `/api/offers/${idPath(id)}/check`, {});
  const offer = one(body);
  return { offer, unconfirmed: status === 202 || offer.status === 'checkout_unknown' };
}

/** Its buy link then says "no longer available". */
export async function archiveOffer(id: string): Promise<Offer> {
  return one((await call<{ offer?: unknown }>('POST', `/api/offers/${idPath(id)}/archive`, {})).body);
}

/** Only an offer without sales (HAS_SALES: archive it instead). Already gone counts as done. */
export async function deleteOffer(id: string): Promise<void> {
  try {
    await call('DELETE', `/api/offers/${idPath(id)}`);
  } catch (e) {
    if (!(e instanceof OffersError && e.status === 404)) throw e;
  }
}

export async function listSales(projectId: string, opts: { env?: WhopEnvironment; before?: string; limit?: number; signal?: AbortSignal } = {}): Promise<{ sales: Sale[]; next: string | null }> {
  const { body } = await call<{ sales?: unknown; next?: unknown }>('GET', `/api/offers/sales${q({ projectId, env: opts.env, before: opts.before, limit: opts.limit })}`, undefined, opts.signal);
  return { sales: (Array.isArray(body.sales) ? body.sales : []).map(toSale).filter((s): s is Sale => !!s), next: strOrNull(body.next) };
}

export async function salesSummary(projectId: string, days = 30, signal?: AbortSignal): Promise<SalesSummary> {
  const { body } = await call<Record<string, unknown>>('GET', `/api/offers/summary${q({ projectId, days })}`, undefined, signal);
  const live = (body.live ?? {}) as Record<string, unknown>;
  const money = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === 'object') for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (/^[a-z]{3}$/.test(k) && typeof n === 'number' && Number.isFinite(n)) out[k] = n;
    return out;
  };
  return {
    days: num(body.days) || days,
    live: { count: num(live.count), revenue: money(live.revenue), refunded: money(live.refunded) },
    test: { count: num((body.test as Record<string, unknown> | undefined)?.count) },
    clicks: num(body.clicks),
    offers: (Array.isArray(body.offers) ? body.offers : []).filter((o) => OFFER_ID.test(str((o as Record<string, unknown>)?.id))).map((o) => ({ id: str(o.id), clicks: num(o.clicks), sales: num(o.sales) })),
  };
}

// ───────────── Whop ─────────────

export async function whopConnections(signal?: AbortSignal): Promise<WhopConnection[]> {
  const { body } = await call<{ connections?: unknown }>('GET', '/api/payments/whop', undefined, signal);
  return (Array.isArray(body.connections) ? body.connections : []).map(toConnection).filter((c): c is WhopConnection => !!c && c.status !== 'disconnected');
}

/** notice: NO_PUBLIC_ADDRESS / WEBHOOK_MANUAL (make the webhook in Whop by hand) or WEBHOOK_UNCONFIRMED (Check again). */
export async function connectWhop(input: { environment: WhopEnvironment; accountId: string; key: string }): Promise<{ connection: WhopConnection; notice: string | null }> {
  const { body } = await call<{ connection?: unknown; notice?: unknown }>('POST', '/api/payments/whop', input);
  return { connection: conn(body), notice: strOrNull(body.notice) };
}

export async function pasteWebhookSecret(id: string, secret: string): Promise<WhopConnection> {
  return conn((await call<{ connection?: unknown }>('POST', `/api/payments/whop/${idPath(id)}/webhook-secret`, { secret })).body);
}

export async function checkWhop(id: string): Promise<{ connection: WhopConnection; notice: string | null }> {
  const { body } = await call<{ connection?: unknown; notice?: unknown }>('POST', `/api/payments/whop/${idPath(id)}/check`, {});
  return { connection: conn(body), notice: strOrNull(body.notice) };
}

export async function enableWhopWebhook(id: string): Promise<WhopConnection> {
  return conn((await call<{ connection?: unknown }>('POST', `/api/payments/whop/${idPath(id)}/enable-webhook`, {})).body);
}

export async function replaceWhopKey(id: string, key: string): Promise<{ connection: WhopConnection; notice: string | null }> {
  const { body } = await call<{ connection?: unknown; notice?: unknown }>('PUT', `/api/payments/whop/${idPath(id)}/key`, { key });
  return { connection: conn(body), notice: strOrNull(body.notice) };
}

/** Without confirm, 409 OFFERS_LIVE {count} while offers use it; with it they pause. notice: remove the webhook in Whop yourself. */
export async function disconnectWhop(id: string, confirm = false): Promise<{ paused: number; notice: string | null }> {
  const { body } = await call<{ paused?: unknown; notice?: unknown }>('DELETE', `/api/payments/whop/${idPath(id)}${confirm ? '?confirm=1' : ''}`);
  return { paused: num(body.paused), notice: strOrNull(body.notice) };
}

export async function whopProducts(id: string, after?: string | null): Promise<{ products: WhopProduct[]; next: string | null }> {
  const { body } = await call<{ products?: unknown; next?: unknown }>('GET', `/api/payments/whop/${idPath(id)}/products${q({ after })}`);
  const products = (Array.isArray(body.products) ? body.products : [])
    .map((p) => p as Record<string, unknown>)
    .filter((p) => /^prod_[A-Za-z0-9]{4,64}$/.test(str(p?.id)))
    .map((p) => ({ id: str(p.id), title: str(p.title).slice(0, 200), visibility: strOrNull(p.visibility) }));
  return { products, next: strOrNull(body.next) };
}

const price = (v: unknown): WhopPrice => {
  const p = (v ?? {}) as Record<string, unknown>;
  return { minor: typeof p.minor === 'number' ? p.minor : null, currency: str(p.currency) || 'usd', display: str(p.display).slice(0, 40) };
};

export async function whopPlans(id: string, productId: string, after?: string | null): Promise<{ plans: WhopPlan[]; next: string | null }> {
  const { body } = await call<{ plans?: unknown; next?: unknown }>('GET', `/api/payments/whop/${idPath(id)}/plans${q({ productId, after })}`);
  const plans = (Array.isArray(body.plans) ? body.plans : [])
    .map((p) => p as Record<string, unknown>)
    .filter((p) => /^plan_[A-Za-z0-9]{4,64}$/.test(str(p?.id)))
    .map((p) => {
      const r = p.renewal as Record<string, unknown> | undefined;
      return {
        id: str(p.id),
        productId: strOrNull(p.productId),
        title: str(p.title).slice(0, 200),
        billingType: p.billingType === 'renewal' ? ('renewal' as const) : ('one_time' as const),
        price: price(p.price),
        ...(r ? { renewal: { ...price(r), period: strOrNull(r.period) } } : {}),
        trialDays: typeof p.trialDays === 'number' ? p.trialDays : null,
        visibility: strOrNull(p.visibility),
      };
    });
  return { plans, next: strOrNull(body.next) };
}

// ───────────── is it on? ─────────────

export interface OffersConfig {
  enabled: boolean;
  whop: { sandbox: boolean; production: boolean };
  /** selling through the seller's own Stripe account (P6): on here, and in which Stripe mode */
  stripe: { available: boolean; environment: WhopEnvironment | null };
  /** the server answered */
  reachable: boolean;
}

const OFF: OffersConfig = { enabled: false, whop: { sandbox: false, production: false }, stripe: { available: false, environment: null }, reachable: false };
let configAsk: Promise<OffersConfig> | null = null;

/** Whether this app's server has offers (GET /api/config → offers). Never in the claude.ai build. */
export function offersConfig(refresh = false): Promise<OffersConfig> {
  if (__ARTIFACT_BUILD__) return Promise.resolve(OFF);
  if (!configAsk || refresh) {
    const ask: Promise<OffersConfig> = fetch(`${serverBaseNow()}/api/config`, { signal: AbortSignal.timeout(8000) })
      .then(async (res) => {
        const body = res.ok ? ((await res.json().catch(() => null)) as { offers?: { enabled?: unknown; whop?: { sandbox?: unknown; production?: unknown }; stripe?: { available?: unknown; environment?: unknown } } } | null) : null;
        const o = body?.offers;
        const env = o?.stripe?.environment;
        return {
          enabled: o?.enabled === true,
          whop: { sandbox: o?.whop?.sandbox === true, production: o?.whop?.production === true },
          stripe: { available: o?.enabled === true && o?.stripe?.available === true, environment: env === 'sandbox' || env === 'production' ? (env as WhopEnvironment) : null },
          reachable: res.ok || res.status === 404,
        };
      })
      .catch(() => OFF);
    configAsk = ask;
    void ask.then((c) => {
      if (!c.reachable && configAsk === ask) configAsk = null;
    });
  }
  return configAsk;
}

// ───────────── words ─────────────

/** Sites a buy link sends buyers to straight away (shared with the server); any other site gets a "You're leaving" page first. */
export const CHECKOUT_HOSTS: readonly string[] = checkoutHosts.hosts;

/** Whether a host is a listed checkout site (exact, or under a listed parent domain). */
export function isCheckoutHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return !!h && CHECKOUT_HOSTS.some((c) => h === c || h.endsWith(`.${c}`));
}

/** The host of a link ('' when it isn't one). */
export function linkHost(href: string): string {
  try {
    return new URL(href.trim()).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** What happens when a buyer presses Buy on an outside link. */
export function checkoutHint(href: string): string {
  const host = linkHost(href);
  if (!host) return '';
  return isCheckoutHost(host) ? `Buyers go straight to ${host}.` : `Buyers see a “You’re leaving” page first, then go to ${host}. On your own domain they go straight there.`;
}

export const PROVIDER_LABEL: Record<OfferProvider, string> = { whop: 'Whop', external: 'Your own link', stripe: 'Stripe' };

/** An offer's state in plain words, or '' when it's selling. */
/**
 * The Whop connection an offer sells through, matched by id (null: not a Whop offer, or connections not loaded yet).
 * One that isn't in the list any more (disconnected; a reconnect is a new one) is { status: 'disconnected' }.
 */
export function offerConnection(o: Pick<Offer, 'provider' | 'connectionId'>, connections: WhopConnection[] | null | undefined): Pick<WhopConnection, 'status'> | null {
  if (o.provider !== 'whop' || !connections) return null;
  return connections.find((c) => c.id === o.connectionId) ?? { status: 'disconnected' };
}

export function offerProblem(o: Pick<Offer, 'status'> & Partial<Pick<Offer, 'problem'>>, connection?: Pick<WhopConnection, 'status'> | null): string {
  if (o.status === 'paused') return 'Paused: its buy link says it isn’t available right now.';
  if (o.status === 'checkout_unknown') return 'Whop didn’t confirm the checkout link yet. Use Check again.';
  if (o.status === 'archived') return 'Archived: its buy link says it’s no longer available.';
  if (o.status === 'draft') return 'Not ready yet.';
  if (o.problem === 'stripe_setup') return 'Finish Stripe setup to start selling.';
  if (connection?.status === 'disconnected') return 'The Whop account it used isn’t connected any more, so it isn’t selling. Attach another plan.';
  if (connection && connection.status !== 'active') return 'Its Whop account needs attention in Settings › Payments, so it isn’t selling.';
  return '';
}

export const SALE_STATUS_LABEL: Record<SaleStatus, string> = {
  pending: 'Pending',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
  disputed: 'Disputed: see Whop',
};

/** A dispute's state in words ("Dispute: needs response", "Dispute won"…). */
export function disputeWords(status: string | null | undefined): string {
  switch (status) {
    case 'warning_needs_response':
    case 'needs_response':
      return 'Dispute: needs response';
    case 'warning_under_review':
    case 'under_review':
      return 'Dispute: under review';
    case 'warning_closed':
      return 'Dispute closed';
    case 'won':
      return 'Dispute won';
    case 'lost':
      return 'Dispute lost';
    default:
      return 'Disputed';
  }
}

/** A sale's status in words: a Stripe dispute by its own state ("Dispute won"), a Whop one points to Whop. */
export function saleStatusLabel(s: Pick<Sale, 'status'> & Partial<Pick<Sale, 'provider' | 'disputeStatus'>>): string {
  if (s.status === 'disputed' && s.provider === 'stripe') return disputeWords(s.disputeStatus);
  return SALE_STATUS_LABEL[s.status];
}

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF']);
/** Minor units as a plain decimal ("49.00"; zero-decimal currencies as they are). */
export const minorToDecimal = (minor: number, currency: string): string => (ZERO_DECIMAL.has(currency.toUpperCase()) ? String(minor) : (minor / 100).toFixed(2));

/**
 * The opposite: what someone typed ("49", "49.5", "1,299.00") as minor units, or null when it isn't a price. A
 * zero-decimal currency (JPY…) takes whole numbers only.
 */
export function decimalToMinor(text: string, currency: string): number | null {
  const t = text.trim().replace(/^[^\d.]+/, '').replace(/,/g, '');
  const zero = ZERO_DECIMAL.has(currency.toUpperCase());
  if (!(zero ? /^\d{1,9}$/ : /^\d{1,7}(\.\d{1,2})?$/).test(t)) return null;
  if (zero) return Number(t);
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Stripe's limits on a price we check before sending (the server checks again): 0.50 to 999,999.99. */
export const STRIPE_PRICE_MIN = 50;
export const STRIPE_PRICE_MAX = 99_999_999;

/**
 * Our fee on a Stripe sale, for display only (the server decides): floor(amount × pct / 100), and none when that's
 * 0 or not below the amount, as the server's platformFee (server/payments/connectFee.mjs).
 */
export function feePreview(amountMinor: number, pct: number, sellerCountry?: string | null, platformCountry = 'US'): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !Number.isFinite(pct) || pct <= 0) return 0;
  // Stripe doesn't take a platform's fee from a seller in Brazil unless the platform is there too
  if (sellerCountry === 'BR' && platformCountry !== 'BR') return 0;
  const fee = Math.floor((amountMinor * Math.min(100, Math.trunc(pct))) / 100);
  return fee > 0 && fee < amountMinor ? fee : 0;
}

/** Money from minor units ("$49.00"; zero-decimal currencies as they are). */
export function formatMoney(minor: number, currency: string): string {
  const cur = currency.toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(ZERO_DECIMAL.has(cur) ? minor : minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${cur}`;
  }
}

/** The price an offer shows (its own text, else from minor units, else ''). */
export function offerPrice(o: Pick<Offer, 'priceDisplay' | 'priceMinor' | 'currency'>): string {
  if (o.priceDisplay) return o.priceDisplay;
  return o.priceMinor != null && o.currency ? formatMoney(o.priceMinor, o.currency) : '';
}

/** A UUID for clientRequestId (one per dialog open / press of Create). */
export function requestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * A create's request ids after it failed. The server answered (a refusal: nothing was made, the draft is gone): that
 * kind gets a new id, so the next try is a new request and never Whop's replay of the refused one. No answer (a lost
 * connection, unknown outcome): the same id, so a retry can't make a second offer or checkout link.
 */
export function requestIdsAfter<T extends Record<string, string>>(ids: T, kind: keyof T, e: unknown): T {
  return e instanceof OffersError && e.status >= 400 ? { ...ids, [kind]: requestId() } : ids;
}

/** Where a business uses an offer, in plain words (its assets, the SEO page, the listing, its emails). */
export function offerUses(project: Project, id: string): string[] {
  const token = new RegExp(`\\{\\{\\s*buy:${id.replace(/[^A-Za-z0-9_-]/g, '')}\\s*\\}\\}`);
  const out: string[] = [];
  for (const a of project.studio.codeAssets) if (a.offerId === id || token.test(a.html)) out.push(`Asset “${a.name}”`);
  if (project.marketing.pageLinks?.offerId === id || token.test(project.marketing.seoHtml?.html ?? '')) out.push('SEO page');
  if (project.studio.listing.offerId === id) out.push('Listing');
  const emails = project.marketing.emails.filter((e) => token.test(e.ctaUrl) || token.test(e.body)).length;
  if (emails) out.push(emails === 1 ? '1 email' : `${emails} emails`);
  return out;
}

const csvCell = (v: string): string => {
  const s = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** Sales as a CSV (date, offer, amount, refunded, currency, status, buyer email, mode). */
export function salesCsv(sales: Sale[], offerTitle: (id: string | null) => string): string {
  const head = ['date', 'offer', 'amount', 'refunded', 'currency', 'status', 'buyer_email', 'mode'];
  const rows = sales.map((s) =>
    [s.paidAt ?? s.createdAt ?? '', offerTitle(s.offerId), minorToDecimal(s.amountMinor, s.currency), minorToDecimal(s.refundedMinor, s.currency), s.currency.toUpperCase(), saleStatusLabel(s), s.buyerEmail ?? '', s.environment === 'sandbox' ? 'test' : 'live'].map(csvCell).join(','),
  );
  return [head.join(','), ...rows].join('\n');
}
