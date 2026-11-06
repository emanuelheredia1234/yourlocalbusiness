// Typed calls to the server's integration routes (server/integrations/wiring.mjs), one per route, each with
// the signed-in user's bearer token (serverFetch). A refusal throws IntegrationApiError with the server's
// { error, code } (and nextAt, period, and for the owner a hint naming a Secret); nothing here retries a write.
//
// None of this reaches the server in the artifact build (__ARTIFACT_BUILD__): its UI is gated.

import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import type {
  AnalyticsSettings,
  AnalyticsSettingsInput,
  AnalyticsSnapshot,
  BillingOp,
  BillingOpResponse,
  BillingSettingsResponse,
  CancelOffer,
  CancelReason,
  CancelSurveysResponse,
  BusinessesResponse,
  AnalyticsSource,
  ApiError,
  ApiErrorCode,
  CapSettings,
  ConnectLink,
  ConnectPlatform,
  ConnectionStatus,
  ConnectionsResponse,
  CustomerUsage,
  CustomersResponse,
  NangoResponse,
  OwnerBillingAccount,
  PlanInterval,
  PlanResponse,
  PlanTier,
  PublishJob,
  PublishRequest,
  ReconcileReport,
  RefreshRun,
  SeoGoogleStatus,
  SeoPublishResult,
  Target,
} from './types';

export class IntegrationApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | 'NETWORK';
  readonly nextAt?: string;
  readonly period?: 'day' | 'month';
  /** the owner only: which Secret or setting is missing (names, never values) */
  readonly hint?: string;
  /** plans: what a refused action needs, when credits renew, whether to offer undo, the money operation */
  readonly need?: { feature?: string; tier?: string };
  readonly resetsAt?: string;
  readonly useUndo?: boolean;
  readonly op?: BillingOp | null;
  constructor(status: number, body: Partial<ApiError> | null, fallback = 'Something went wrong. Try again shortly.') {
    super(typeof body?.error === 'string' && body.error ? body.error : fallback);
    this.name = 'IntegrationApiError';
    this.status = status;
    this.code = (typeof body?.code === 'string' ? body.code : status === 0 ? 'NETWORK' : 'UNAVAILABLE') as ApiErrorCode | 'NETWORK';
    if (typeof body?.nextAt === 'string') this.nextAt = body.nextAt;
    if (body?.period === 'day' || body?.period === 'month') this.period = body.period;
    if (typeof body?.hint === 'string') this.hint = body.hint;
    if (body?.need && typeof body.need === 'object') this.need = { ...(typeof body.need.feature === 'string' ? { feature: body.need.feature } : {}), ...(typeof body.need.tier === 'string' ? { tier: body.need.tier } : {}) };
    if (typeof body?.resetsAt === 'string') this.resetsAt = body.resetsAt;
    if (body?.useUndo === true) this.useUndo = true;
    if (body?.op && typeof body.op === 'object') this.op = body.op;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** The server's address now (Settings › AI keys, or the app's own origin). Tests pass their own. */
let baseOverride: string | null = null;
export function setIntegrationsBase(base: string | null): void {
  baseOverride = base;
}
const base = () => baseOverride ?? serverBaseNow();

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await serverFetch(base(), path, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new IntegrationApiError(0, null, 'Couldn’t reach the app’s server. Check your connection and try again.');
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new IntegrationApiError(res.status, data && typeof data === 'object' ? (data as Partial<ApiError>) : null);
  return data as T;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : '';
};
const seg = encodeURIComponent;

// ───────────── connected accounts (social networks through Upload-Post, ad accounts through Zernio) ─────────────
// projectId: the business on screen. Each business connects its own social accounts (and picks its ad account).

export const getConnections = (projectId?: string) => call<ConnectionsResponse>('GET', `/api/integrations/connections${q({ projectId })}`);
export const connect = (platform: ConnectPlatform, projectId?: string) => call<ConnectLink>('POST', `/api/integrations/connections/${seg(platform)}/connect`, projectId ? { projectId } : {});
export const reconnect = (platform: ConnectPlatform, projectId?: string) => call<ConnectLink>('POST', `/api/integrations/connections/${seg(platform)}/reconnect`, projectId ? { projectId } : {});
/** accountId: the account Zernio named on its way back (?accountId=), a hint the server checks against this user's rows. */
export const checkConnection = (platform: ConnectPlatform, projectId?: string, accountId?: string) => call<{ connection: ConnectionStatus }>('POST', `/api/integrations/connections/${seg(platform)}/check`, { ...(projectId ? { projectId } : {}), ...(accountId ? { accountId } : {}) });
/** A connect that came back with ?error=: the platform stops waiting on the server and keeps our reason code. */
export const abandonConnection = (platform: ConnectPlatform, reason: string, projectId?: string) => call<{ connection: ConnectionStatus }>('POST', `/api/integrations/connections/${seg(platform)}/abandon`, { reason, ...(projectId ? { projectId } : {}) });
/** ackLiveAds: for Meta ads / Google Ads, the customer saw the campaigns that stay on (else 409 ADS_LIVE). */
export const disconnect = (platform: ConnectPlatform, projectId?: string, ackLiveAds = false) => call<{ ok: true }>('DELETE', `/api/integrations/connections/${seg(platform)}${q({ projectId, ...(ackLiveAds ? { ackLiveAds: '1' } : {}) })}`);
export const getTargets = (platform: ConnectPlatform, projectId?: string) => call<{ targets: Target[] }>('GET', `/api/integrations/connections/${seg(platform)}/targets${q({ projectId })}`);
export const setTarget = (platform: ConnectPlatform, targetId: string, projectId?: string) => call<{ connection: ConnectionStatus }>('PUT', `/api/integrations/connections/${seg(platform)}/target`, { targetId, ...(projectId ? { projectId } : {}) });
/** A business was deleted: its social accounts are disconnected and its slot freed (one request; never retried). */
/** A business was deleted (its social profile goes). `onlyIfGone`: "Free it", refused while the business is still saved. */
export const releaseProjectSocial = (projectId: string, onlyIfGone = false) => call<{ ok: true; freed: boolean }>('DELETE', `/api/integrations/connections${q(onlyIfGone ? { projectId, gone: '1' } : { projectId })}`);

// ───────────── other integrations (Nango; future booking tools and CRMs, shown only when the owner set it up) ─────────────

export const getNangoIntegrations = () => call<NangoResponse>('GET', '/api/integrations/nango');
export const connectNango = (key: string) => call<{ connectLink: string; expiresAt: string }>('POST', `/api/integrations/nango/${seg(key)}/connect`, {});
export const disconnectNango = (key: string) => call<{ ok: true }>('DELETE', `/api/integrations/nango/${seg(key)}`);

// ───────────── posting (one attempt each; never retried here) ─────────────

export const publishPost = (req: PublishRequest) => call<{ job: PublishJob }>('POST', '/api/posting/publish', req);
/** A pure read: never contacts the network. */
export const getJob = (jobId: string) => call<{ job: PublishJob }>('GET', `/api/posting/jobs/${seg(jobId)}`);
/** The user's "Check again" on an unknown job: one read-only check (at most once per 30 s); never resends. */
export const checkJob = (jobId: string) => call<{ job: PublishJob }>('POST', `/api/posting/jobs/${seg(jobId)}/check`, {});
export const listJobs = (projectId: string) => call<{ jobs: PublishJob[] }>('GET', `/api/posting/jobs${q({ projectId })}`);

// ───────────── analytics ─────────────

/** The Marketing hub's Update (202: the run goes on in the background). */
export const refreshAnalytics = (projectId: string, sources?: AnalyticsSource[]) => call<{ run: RefreshRun }>('POST', '/api/analytics/refresh', { projectId, ...(sources ? { sources } : {}) });
export const getRun = (runId: string) => call<{ run: RefreshRun }>('GET', `/api/analytics/runs/${seg(runId)}`);
export const getSnapshots = (projectId: string) => call<{ snapshots: AnalyticsSnapshot[] }>('GET', `/api/analytics/snapshots${q({ projectId })}`);
export const saveAnalyticsSettings = (input: AnalyticsSettingsInput) => call<{ settings: AnalyticsSettings }>('PUT', '/api/analytics/settings', input);

// ───────────── the SEO page on Google ─────────────

/** "Submit to Google": only after the confirm dialog (confirm: true). One-shot steps. */
export const publishSeoToGoogle = (projectId: string) => call<{ result: SeoPublishResult }>('POST', '/api/seo/google/publish', { projectId, confirm: true });
export const getSeoGoogleStatus = (projectId: string) => call<{ status: SeoGoogleStatus }>('GET', `/api/seo/google/status${q({ projectId })}`);

// ───────────── usage and billing ─────────────

export const getMyUsage = (days = 30) => call<{ usage: CustomerUsage }>('GET', `/api/billing/me${q({ days })}`);
/** The owner only. */
export const getCustomers = (days = 30) => call<CustomersResponse>('GET', `/api/billing/customers${q({ days })}`);
export const putCustomerCap = (customerTag: string, cap: CapSettings) => call<{ cap: CapSettings }>('PUT', `/api/billing/customers/${seg(customerTag)}/cap`, cap);
export const putDefaults = (defaults: CapSettings) => call<{ defaults: CapSettings }>('PUT', '/api/billing/defaults', defaults);
export const getReconcile = (days = 30) => call<ReconcileReport>('GET', `/api/billing/reconcile${q({ days })}`);
/** The invoice CSV's address (fetched with the bearer by the caller, as a download). month: YYYY-MM. */
export const invoiceCsvUrl = (month: string) => `${base()}/api/billing/invoice.csv${q({ month })}`;

// ───────────── plans (Launch, Grow, Scale) ─────────────
// clientRequestId: a UUID made per user action (a double click sends the same one, so Stripe sees one request). Writes
// are never retried here: a 202 means "being confirmed", read back with getBusinesses / getPlan.

/** The plan, businesses and credits; sessionId: the Checkout Session the user just came back from. */
export const getPlan = (sessionId?: string) => call<PlanResponse>('GET', `/api/billing/plan${q({ session_id: sessionId })}`);
export const startCheckout = (req: { tier: PlanTier; interval: PlanInterval; extraBusinesses?: number; clientRequestId: string }) => call<{ url: string }>('POST', '/api/billing/checkout', req);
export const openPortal = (clientRequestId: string) => call<{ url: string }>('POST', '/api/billing/portal', { clientRequestId });
export const getBusinesses = () => call<BusinessesResponse>('GET', '/api/billing/businesses');
export const changeBusinesses = (req: { action: 'add' | 'remove' | 'undo_remove'; clientRequestId: string; confirm: true; projectId?: string }) => call<BillingOpResponse>('POST', '/api/billing/businesses', req);
export const setActiveBusinesses = (projectIds: string[]) => call<BusinessesResponse>('PUT', '/api/billing/businesses/active', { projectIds });
export const changePlan = (req: { tier: PlanTier; interval: PlanInterval; clientRequestId: string; confirm: true }) => call<BillingOpResponse>('POST', '/api/billing/plan', req);
/** The cancel survey, then cancel at the period's end (sent once per clientRequestId; a 202 is read back, never resent). */
export const cancelPlan = (req: { reason: CancelReason; comment?: string; offer?: CancelOffer; clientRequestId: string; confirm: true }) => call<BillingOpResponse>('POST', '/api/billing/cancel', req);
/** The survey of someone who took the alternative instead (nothing changes in Stripe). */
export const keepPlanSurvey = (req: { reason: CancelReason; comment?: string; offer: CancelOffer; outcome: 'kept' | 'switched' }) => call<{ ok: true }>('POST', '/api/billing/cancel/survey', req);
/** Keep the plan after all (undo cancel at period end). */
export const resumePlan = (clientRequestId: string) => call<BillingOpResponse>('POST', '/api/billing/resume', { clientRequestId, confirm: true });
export const getCancelSurveys = () => call<CancelSurveysResponse>('GET', '/api/billing/surveys');
/** The owner only. */
export const getBillingAccounts = (status?: string) => call<{ accounts: OwnerBillingAccount[] }>('GET', `/api/billing/accounts${q({ status })}`);
export const putCompPlan = (customerTag: string, body: { tier: PlanTier | 'none'; extraBusinesses?: number; until?: string | null; note?: string }) => call<{ ok: true }>('PUT', `/api/billing/accounts/${seg(customerTag)}/comp`, body);
export const syncBillingAccount = (customerTag: string) => call<{ ok: true }>('POST', `/api/billing/accounts/${seg(customerTag)}/sync`, {});
export const getBillingSettings = () => call<BillingSettingsResponse>('GET', '/api/billing/settings');
export const putBillingSettings = (body: { enforce?: boolean; cardTrialDays?: number; existingTrialDays?: number }) => call<BillingSettingsResponse>('PUT', '/api/billing/settings', body);

/** A fresh id for one user action (Stripe's Idempotency-Key is made from it on the server). */
export function newRequestId(): string {
  const c = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
