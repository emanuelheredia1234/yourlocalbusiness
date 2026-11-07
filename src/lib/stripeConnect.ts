// Selling through the seller's own Stripe account (P6): the client for /api/payments/stripe
// (server/payments/stripeConnect.mjs). The seller owns the account and sees it in their own Stripe Dashboard; buyers
// pay on Stripe Checkout on that account, Stripe takes its own fees from the seller, and our fee (the plan's
// percentage) is taken by Stripe at the sale. The app never holds a key, never sees a card, and never refunds:
// refunds and disputes happen in the seller's Stripe Dashboard.
//
// - An onboarding link is single-use and goes only to this signed-in browser: it's never stored, copied or shown.
// - Creating the account keeps its request id until the server gives a definite answer (as requestIdsAfter does),
//   so a retry after a lost connection is the same request, never a second account.
// - None of this is in the claude.ai build: every call refuses there before any request.

import countries from '../../shared/connect-countries.json';
import { PLANS, tierName } from './plans';
import { OffersError, offersCall, type WhopEnvironment } from './offers';

export type ConnectStatus = 'creating' | 'unknown' | 'onboarding' | 'restricted' | 'active' | 'rejected' | 'disconnected';
export type FeeTier = 'launch' | 'grow' | 'scale' | 'owner' | 'legacy' | 'none';

/** The seller's Stripe account as the server shows it (never the full acct_ id, never a key). */
export interface ConnectAccount {
  id: string;
  environment: WhopEnvironment;
  status: ConnectStatus;
  country: string;
  defaultCurrency: string | null;
  displayName: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** how many details Stripe needs: now, past due, later, being checked */
  due: { now: number; pastDue: number; later: number; pending: number };
  deadline: string | null;
  disabledReason: string | null;
  taxEnabled: boolean;
  taxStatus: 'active' | 'pending' | null;
  payoutFailedAt: string | null;
  accountLast4: string;
}

export interface ConnectFee {
  pct: number;
  tier: FeeTier;
}

/** GET /api/payments/stripe */
export interface ConnectState {
  available: boolean;
  environment: WhopEnvironment | null;
  account: ConnectAccount | null;
  fee: ConnectFee | null;
  termsUrl: string;
  termsVersion: string;
  termsReady: boolean;
  countries: string[];
}

/** Countries Stripe supports sellers in (shared with the server). Stripe's onboarding has the final say. */
export const CONNECT_COUNTRIES: readonly string[] = countries.countries;

const NOT_HERE = 'Selling with Stripe needs the app’s own server, so it isn’t available here.';
const here = () => {
  if (__ARTIFACT_BUILD__) throw new OffersError(NOT_HERE, 'NOT_HERE');
};
/** NOT_SET_UP here is Connect's own sentence ("opens soon", "isn't available right now"), never the generic one. */
const WORDS = ['NOT_SET_UP', 'CONFLICT'] as const;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const n0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const STATUSES: ConnectStatus[] = ['creating', 'unknown', 'onboarding', 'restricted', 'active', 'rejected', 'disconnected'];
const TIERS: FeeTier[] = ['launch', 'grow', 'scale', 'owner', 'legacy', 'none'];

export function toConnectAccount(raw: unknown): ConnectAccount | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || !/^[A-Za-z0-9_-]{22}$/.test(str(r.id))) return null;
  const due = (r.due ?? {}) as Record<string, unknown>;
  return {
    id: str(r.id),
    environment: r.environment === 'sandbox' ? 'sandbox' : 'production',
    status: STATUSES.includes(r.status as ConnectStatus) ? (r.status as ConnectStatus) : 'unknown',
    country: /^[A-Z]{2}$/.test(str(r.country)) ? str(r.country) : '',
    defaultCurrency: /^[a-z]{3}$/.test(str(r.defaultCurrency)) ? str(r.defaultCurrency) : null,
    displayName: str(r.displayName).slice(0, 120),
    chargesEnabled: r.chargesEnabled === true,
    payoutsEnabled: r.payoutsEnabled === true,
    detailsSubmitted: r.detailsSubmitted === true,
    due: { now: n0(due.now), pastDue: n0(due.pastDue), later: n0(due.later), pending: n0(due.pending) },
    deadline: str(r.deadline) && Number.isFinite(Date.parse(str(r.deadline))) ? str(r.deadline) : null,
    disabledReason: /^[a-z_.]{1,60}$/.test(str(r.disabledReason)) ? str(r.disabledReason) : null,
    taxEnabled: r.taxEnabled === true,
    taxStatus: r.taxStatus === 'active' || r.taxStatus === 'pending' ? r.taxStatus : null,
    payoutFailedAt: str(r.payoutFailedAt) || null,
    accountLast4: str(r.accountLast4).slice(-4),
  };
}

export function toConnectFee(raw: unknown): ConnectFee | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.pct !== 'number' || !Number.isFinite(r.pct)) return null;
  return { pct: Math.min(100, Math.max(0, Math.trunc(r.pct))), tier: TIERS.includes(r.tier as FeeTier) ? (r.tier as FeeTier) : 'none' };
}

export function toConnectState(raw: unknown): ConnectState {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(r.countries) ? r.countries.filter((c): c is string => typeof c === 'string' && /^[A-Z]{2}$/.test(c)) : [];
  return {
    available: r.available === true,
    environment: r.environment === 'sandbox' || r.environment === 'production' ? r.environment : null,
    account: toConnectAccount(r.account),
    fee: toConnectFee(r.fee),
    termsUrl: /^\/[a-z-]{1,40}$/.test(str(r.termsUrl)) ? str(r.termsUrl) : '/seller-terms',
    termsVersion: str(r.termsVersion).slice(0, 40),
    termsReady: r.termsReady === true,
    countries: list.length ? list : [...CONNECT_COUNTRIES],
  };
}

const account = (body: { account?: unknown }): ConnectAccount | null => toConnectAccount(body.account);

// ───────────── the seller's account ─────────────

export async function connectStatus(signal?: AbortSignal): Promise<ConnectState> {
  here();
  const { body } = await offersCall<Record<string, unknown>>('GET', '/api/payments/stripe', undefined, signal, WORDS);
  return toConnectState(body);
}

/**
 * Make the seller's Stripe account (they ticked the seller terms). pending: Stripe hasn't confirmed it yet (202):
 * the server reads it back; ask connectStatus again in a few seconds.
 */
export async function createConnectAccount(input: { country: string; clientRequestId: string; businessName?: string }): Promise<{ account: ConnectAccount | null; pending: boolean }> {
  here();
  const { status, body } = await offersCall<{ account?: unknown }>('POST', '/api/payments/stripe', { country: input.country, acceptTerms: true, clientRequestId: input.clientRequestId, ...(input.businessName ? { businessName: input.businessName.slice(0, 480) } : {}) }, undefined, WORDS);
  const a = account(body);
  return { account: a, pending: status === 202 || a?.status === 'creating' || a?.status === 'unknown' };
}

/** Whether an address is one of Stripe's own https pages (where onboarding links lead). */
export function isStripeUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}

/**
 * A fresh single-use onboarding link for this browser only (never stored, copied or shown). Only one of Stripe's own
 * https pages is accepted; anything else is refused before the page goes anywhere.
 */
export async function onboardingLink(): Promise<string> {
  here();
  const { body } = await offersCall<{ url?: unknown }>('POST', '/api/payments/stripe/onboarding', {}, undefined, WORDS);
  const url = str(body.url);
  if (!isStripeUrl(url)) throw new OffersError('Stripe’s setup page couldn’t be opened. Try again.', 'BAD_ANSWER');
  return url;
}

/** Read the account from Stripe now. */
export async function syncConnect(): Promise<ConnectAccount | null> {
  here();
  return account((await offersCall<{ account?: unknown }>('POST', '/api/payments/stripe/sync', {}, undefined, WORDS)).body);
}

/** Stripe Tax on the seller's checkouts (TAX_NOT_READY: finish it in the Stripe Dashboard first). */
export async function setConnectTax(enabled: boolean): Promise<ConnectAccount | null> {
  here();
  return account((await offersCall<{ account?: unknown }>('PUT', '/api/payments/stripe/tax', { enabled }, undefined, WORDS)).body);
}

/**
 * "Stop selling with Stripe here". Without confirm: 409 CONFIRM (extra.offers: how many buy links would pause). The
 * Stripe account stays the seller's.
 */
export async function disconnectConnect(confirm = false): Promise<{ paused: number }> {
  here();
  const { body } = await offersCall<{ paused?: unknown }>('DELETE', `/api/payments/stripe${confirm ? '?confirm=1' : ''}`, undefined, undefined, WORDS);
  return { paused: n0(body.paused) };
}

/** A new 7-day download link for a buyer of a Stripe sale with a file (they lost theirs). */
export async function saleDownloadLink(saleId: string): Promise<{ url: string; expiresAt: string | null }> {
  here();
  if (!/^[0-9a-f-]{36}$/i.test(saleId)) throw new OffersError('That sale isn’t in your account.', 'BAD_ID');
  const { body } = await offersCall<{ url?: unknown; expiresAt?: unknown }>('POST', `/api/offers/sales/${saleId}/download-link`, {});
  const url = str(body.url);
  if (!/^https?:\/\/[^/]+\/b\/[A-Za-z0-9_-]{22}\/file\?t=[A-Za-z0-9._~-]{10,400}$/.test(url)) throw new OffersError('The server’s answer couldn’t be read. Try again.', 'BAD_ANSWER');
  return { url, expiresAt: str(body.expiresAt) || null };
}

// ───────────── the owner's view (Owner › Customer usage › Stripe Connect) ─────────────

export interface ConnectAdminSeller {
  customerTag: string;
  email: string;
  status: ConnectStatus;
  country: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  dueNow: number;
  last30: { count: number; gross: Record<string, number>; fees: Record<string, number> };
}
export interface ConnectFeeTotals {
  fees: number;
  returned: number;
  net: number;
}
export interface ConnectAdmin {
  setup: { environment: WhopEnvironment | null; missing: string[]; publicUrlOk: boolean; sellerTermsReady: boolean; termsVersion: string; returnFees: boolean; connectEnabled: boolean | null; webhookLastAt: string | null };
  accounts: { counts: Record<string, number>; sellers: ConnectAdminSeller[] };
  fees: { currencies: Record<string, { last30: ConnectFeeTotals; monthToDate: ConnectFeeTotals }>; returns: { sourceId: string; state: string; amountMinor: number; errorCode: string | null; createdAt: string | null }[] };
  alerts: { kind: string; count: number; firstAt: string | null; lastAt: string | null }[];
}

const money = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (/^[a-z]{3}$/.test(k) && typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  return out;
};
const totals = (v: unknown): ConnectFeeTotals => {
  const t = (v ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return { fees: n(t.fees), returned: n(t.returned), net: n(t.net) };
};

export function toConnectAdmin(raw: unknown): ConnectAdmin {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (r.setup ?? {}) as Record<string, unknown>;
  const a = (r.accounts ?? {}) as Record<string, unknown>;
  const f = (r.fees ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const currencies: ConnectAdmin['fees']['currencies'] = {};
  if (f.currencies && typeof f.currencies === 'object') for (const [cur, v] of Object.entries(f.currencies as Record<string, unknown>)) if (/^[a-z]{3}$/.test(cur)) currencies[cur] = { last30: totals((v as Record<string, unknown>)?.last30), monthToDate: totals((v as Record<string, unknown>)?.monthToDate) };
  const counts: Record<string, number> = {};
  if (a.counts && typeof a.counts === 'object') for (const [k, v] of Object.entries(a.counts as Record<string, unknown>)) if (STATUSES.includes(k as ConnectStatus) && typeof v === 'number') counts[k] = v;
  return {
    setup: {
      environment: s.environment === 'sandbox' || s.environment === 'production' ? s.environment : null,
      missing: Array.isArray(s.missing) ? s.missing.filter((x): x is string => typeof x === 'string' && /^[A-Z0-9_]{2,60}$/.test(x)) : [],
      publicUrlOk: s.publicUrlOk === true,
      sellerTermsReady: s.sellerTermsReady === true,
      termsVersion: str(s.termsVersion).slice(0, 40),
      returnFees: s.returnFees !== false,
      connectEnabled: s.connectEnabled === true ? true : s.connectEnabled === false ? false : null,
      webhookLastAt: str(s.webhookLastAt) || null,
    },
    accounts: {
      counts,
      sellers: arr(a.sellers).map((x) => {
        const l = (x.last30 ?? {}) as Record<string, unknown>;
        return {
          customerTag: str(x.customerTag).slice(0, 60),
          email: str(x.email).slice(0, 200),
          status: STATUSES.includes(x.status as ConnectStatus) ? (x.status as ConnectStatus) : 'unknown',
          country: /^[A-Z]{2}$/.test(str(x.country)) ? str(x.country) : '',
          chargesEnabled: x.chargesEnabled === true,
          payoutsEnabled: x.payoutsEnabled === true,
          dueNow: n0(x.dueNow),
          last30: { count: n0(l.count), gross: money(l.gross), fees: money(l.fees) },
        };
      }),
    },
    fees: {
      currencies,
      returns: arr(f.returns).map((x) => ({ sourceId: str(x.sourceId).slice(0, 80), state: str(x.state).slice(0, 20), amountMinor: n0(x.amountMinor), errorCode: str(x.errorCode) || null, createdAt: str(x.createdAt) || null })),
    },
    alerts: arr(r.alerts)
      .filter((x) => /^[a-z0-9_]{1,60}$/.test(str(x.kind)))
      .map((x) => ({ kind: str(x.kind), count: n0(x.count), firstAt: str(x.firstAt) || null, lastAt: str(x.lastAt) || null })),
  };
}

/** The owner only (403 otherwise). */
export async function connectAdmin(signal?: AbortSignal): Promise<ConnectAdmin> {
  here();
  return toConnectAdmin((await offersCall<Record<string, unknown>>('GET', '/api/payments/stripe/admin', undefined, signal)).body);
}

export async function resolveConnectAlert(kind: string): Promise<void> {
  here();
  if (!/^[a-z0-9_]{1,60}$/.test(kind)) throw new OffersError('No such alert.', 'BAD_ID');
  await offersCall('POST', `/api/payments/stripe/admin/alerts/${kind}/resolve`, {});
}

// ───────────── words ─────────────

/** Why Stripe paused an account, in plain words (a generic sentence for a reason we don't know). */
export const DISABLED_REASON: Record<string, string> = {
  'requirements.past_due': 'Stripe needs details that are past due.',
  'requirements.pending_verification': 'Stripe is checking the details you sent.',
  'under_review': 'Stripe is reviewing the account.',
  'platform_paused': 'Payments are paused on this app for now.',
  'listed': 'Stripe is reviewing the account.',
  'action_required.requested_capabilities': 'Stripe needs more details before you can take payments.',
  'rejected.fraud': 'Stripe closed this account.',
  'rejected.terms_of_service': 'Stripe closed this account.',
  'rejected.listed': 'Stripe closed this account.',
  'rejected.other': 'Stripe closed this account.',
  other: 'Stripe paused payments on this account.',
};
export function disabledWords(reason: string | null | undefined): string {
  if (!reason) return '';
  return DISABLED_REASON[reason] ?? (reason.startsWith('rejected.') ? 'Stripe closed this account.' : 'Stripe paused payments on this account. Your Stripe Dashboard says why.');
}

/** "3 items, due Nov 20" (or "1 item"). */
export function dueWords(a: Pick<ConnectAccount, 'due' | 'deadline'>): string {
  const n = a.due.now + a.due.pastDue;
  if (!n) return a.due.pending ? 'Stripe is checking what you sent.' : '';
  const items = `${n} item${n === 1 ? '' : 's'}`;
  if (!a.deadline) return items;
  const d = new Date(a.deadline);
  return `${items}, due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** The fee line: "Our fee is 3% on Launch, 1% on Grow and 0% on Scale." (the seller's own tier is marked). */
export function feeTiers(): { tier: 'launch' | 'grow' | 'scale'; name: string; pct: number }[] {
  return (['launch', 'grow', 'scale'] as const).map((t) => ({ tier: t, name: tierName(t), pct: feePctOf(t) }));
}
const feePctOf = (t: 'launch' | 'grow' | 'scale') => PLANS.plans[t].platformFeePct;

/** "No platform fee" for the owner, plans not enforced, and a 0% tier. */
export const noFee = (fee: ConnectFee | null | undefined): boolean => !!fee && (fee.pct === 0 || fee.tier === 'owner' || fee.tier === 'legacy');

/** "3% on Launch" (no plan: Launch's rate, said so). */
export function feeLabel(fee: ConnectFee | null | undefined): string {
  if (!fee) return '';
  if (noFee(fee)) return 'No platform fee';
  return fee.tier === 'none' ? `${fee.pct}% (no plan: Launch’s rate)` : `${fee.pct}% on ${tierName(fee.tier)}`;
}

/** The Stripe Dashboard (Test mode: its test pages). */
export const dashboardUrl = (env: WhopEnvironment | null | undefined, path = ''): string => `https://dashboard.stripe.com/${env === 'sandbox' ? 'test/' : ''}${path}`;
