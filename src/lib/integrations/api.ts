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
  AnalyticsSource,
  ApiError,
  ApiErrorCode,
  CapSettings,
  ConnectLink,
  ConnectPlatform,
  ConnectionStatus,
  ConnectionsResponse,
  CustomerUsage,
  CustomerUsageRow,
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
  constructor(status: number, body: Partial<ApiError> | null, fallback = 'Something went wrong. Try again shortly.') {
    super(typeof body?.error === 'string' && body.error ? body.error : fallback);
    this.name = 'IntegrationApiError';
    this.status = status;
    this.code = (typeof body?.code === 'string' ? body.code : status === 0 ? 'NETWORK' : 'UNAVAILABLE') as ApiErrorCode | 'NETWORK';
    if (typeof body?.nextAt === 'string') this.nextAt = body.nextAt;
    if (body?.period === 'day' || body?.period === 'month') this.period = body.period;
    if (typeof body?.hint === 'string') this.hint = body.hint;
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

// ───────────── connected accounts ─────────────

export const getConnections = () => call<ConnectionsResponse>('GET', '/api/integrations/connections');
export const connect = (platform: ConnectPlatform) => call<ConnectLink>('POST', `/api/integrations/connections/${seg(platform)}/connect`, {});
export const reconnect = (platform: ConnectPlatform) => call<ConnectLink>('POST', `/api/integrations/connections/${seg(platform)}/reconnect`, {});
export const checkConnection = (platform: ConnectPlatform) => call<{ connection: ConnectionStatus }>('POST', `/api/integrations/connections/${seg(platform)}/check`, {});
export const disconnect = (platform: ConnectPlatform) => call<{ ok: true }>('DELETE', `/api/integrations/connections/${seg(platform)}`);
export const getTargets = (platform: ConnectPlatform) => call<{ targets: Target[] }>('GET', `/api/integrations/connections/${seg(platform)}/targets`);
export const setTarget = (platform: ConnectPlatform, targetId: string) => call<{ connection: ConnectionStatus }>('PUT', `/api/integrations/connections/${seg(platform)}/target`, { targetId });

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
export const getCustomers = (days = 30) => call<{ customers: CustomerUsageRow[]; defaults: CapSettings }>('GET', `/api/billing/customers${q({ days })}`);
export const putCustomerCap = (customerTag: string, cap: CapSettings) => call<{ cap: CapSettings }>('PUT', `/api/billing/customers/${seg(customerTag)}/cap`, cap);
export const putDefaults = (defaults: CapSettings) => call<{ defaults: CapSettings }>('PUT', '/api/billing/defaults', defaults);
export const getReconcile = (days = 30) => call<ReconcileReport>('GET', `/api/billing/reconcile${q({ days })}`);
/** The invoice CSV's address (fetched with the bearer by the caller, as a download). month: YYYY-MM. */
export const invoiceCsvUrl = (month: string) => `${base()}/api/billing/invoice.csv${q({ month })}`;
