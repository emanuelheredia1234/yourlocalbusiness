// Typed calls to /api/ads/* (server/ads/routes.mjs), one per route, each with the signed-in user's bearer token.
// Launches and changes spend the customer's real money, so the rules here are strict:
//   - every write (launch, change, owner pause-all) is ONE request; nothing in this file retries anything, and a
//     write is never called from a catch;
//   - a write that ends without a definite answer (no answer, or a gateway error) is reported as "may have
//     happened - check status before trying again" (AdsApiError.uncertain); pressing the same confirm again sends
//     the same clientRequestId, so the server answers with the job it already has instead of a second write;
//   - followAdJob only GETs our own job route: it never calls Check status or resends.
// None of this runs in the artifact build (__ARTIFACT_BUILD__): its UI is hidden there.

import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import type {
  AccountsResponse,
  AdJob,
  AdLimitsPatch,
  AdminLimitsResponse,
  AdsPlatform,
  AuditEntry,
  CampaignsResponse,
  ChangePreviewRequest,
  ChangeReview,
  LaunchedCampaign,
  LaunchPreviewRequest,
  LaunchReview,
  LiveAdRow,
  PlainNote,
  ReviewView,
  TargetOption,
} from './launchTypes';

export class AdsApiError extends Error {
  readonly status: number;
  /** the server's code, or NETWORK when the server couldn't be reached */
  readonly code: string;
  /** the owner only: which Secret or setting is missing (names, never values) */
  readonly hint?: string;
  /** ADS_LIVE: the campaigns that keep running */
  readonly live?: LiveAdRow[];
  constructor(status: number, body: { error?: unknown; code?: unknown; hint?: unknown; live?: unknown } | null, fallback = 'Something went wrong. Try again shortly.') {
    super(typeof body?.error === 'string' && body.error ? body.error : fallback);
    this.name = 'AdsApiError';
    this.status = status;
    this.code = typeof body?.code === 'string' ? body.code : status === 0 ? 'NETWORK' : 'UNAVAILABLE';
    if (typeof body?.hint === 'string') this.hint = body.hint;
    if (Array.isArray(body?.live)) this.live = body.live as LiveAdRow[];
  }
  /** No definite answer to a write: the server may have taken it (it couldn't be reached, or a gateway timed out). */
  get uncertain(): boolean {
    return this.code === 'NETWORK' || (this.status >= 500 && this.code === 'UNAVAILABLE');
  }
}

/** The words for a write without a definite answer (R8): never "try again". */
export const MAY_HAVE_HAPPENED = 'It may have happened - check status before trying again.';

let baseOverride: string | null = null;
/** Tests point the calls at their own server. */
export function setAdsBase(base: string | null): void {
  baseOverride = base;
}
const base = () => baseOverride ?? serverBaseNow();

type Method = 'GET' | 'POST' | 'PUT';

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await serverFetch(base(), path, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new AdsApiError(0, null, 'Couldn’t reach the app’s server. Check your connection.');
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new AdsApiError(res.status, data && typeof data === 'object' ? (data as Record<string, unknown>) : null);
  return data as T;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : '';
};
const seg = encodeURIComponent;

// ───────────── reads ─────────────

export const getAdAccounts = (projectId: string, platform: AdsPlatform) => call<AccountsResponse>('GET', `/api/ads/accounts${q({ projectId, platform })}`);
/** Our database only (no write to Meta or Google). */
export const chooseAdAccount = (projectId: string, platform: AdsPlatform, adAccountRef: string) => call<{ chosen: AccountsResponse['chosen'] }>('PUT', '/api/ads/accounts/choice', { projectId, platform, adAccountRef });
export const searchTargeting = (projectId: string, platform: AdsPlatform, dimension: 'geo' | 'interest', term: string) => call<{ results: TargetOption[] }>('GET', `/api/ads/targeting/search${q({ projectId, platform, dimension, q: term })}`);
export const getCampaigns = (projectId: string) => call<CampaignsResponse>('GET', `/api/ads/campaigns${q({ projectId })}`);
/** One read per connection; at most once per business every 5 minutes. */
export const refreshCampaigns = (projectId: string) => call<CampaignsResponse>('POST', '/api/ads/campaigns/refresh', { projectId });
export const getCampaignReview = (campaignId: string) => call<{ review: ReviewView }>('GET', `/api/ads/campaigns/${seg(campaignId)}/review`);
/** A pure read of our own job row: never contacts Meta or Google. */
export const getAdJob = (jobId: string) => call<{ job: AdJob; campaign?: LaunchedCampaign }>('GET', `/api/ads/jobs/${seg(jobId)}`);
/** "Check status": reads only (at most once per 30 s per job); never resends anything. */
export const checkAdJob = (jobId: string) => call<{ job: AdJob; campaign: LaunchedCampaign; note?: PlainNote }>('POST', `/api/ads/jobs/${seg(jobId)}/check`, {});
export const getAdAudit = (o: { projectId?: string; campaignId?: string; before?: number }) => call<{ entries: AuditEntry[]; next?: number }>('GET', `/api/ads/audit${q({ projectId: o.projectId, campaignId: o.campaignId, before: o.before })}`);
/** Campaigns whose switch is (or may be) on: the delete-account and disconnect warnings (R12). */
export const getLiveAds = (platform?: AdsPlatform) => call<{ live: LiveAdRow[] }>('GET', `/api/ads/live${q({ platform })}`);

// ───────────── previews (reads; they return a review and, when nothing blocks, a review token) ─────────────

export const previewLaunch = (req: LaunchPreviewRequest) => call<{ review: LaunchReview; reviewToken?: string }>('POST', '/api/ads/launch/preview', req);
export const previewChange = (campaignId: string, req: ChangePreviewRequest) => call<{ review: ChangeReview; reviewToken?: string }>('POST', `/api/ads/campaigns/${seg(campaignId)}/change/preview`, req);

// ───────────── writes: one request each, only after the customer's confirm ─────────────

export const launchAds = (reviewToken: string, clientRequestId: string) => call<{ job: AdJob; campaign?: LaunchedCampaign; replayed?: boolean }>('POST', '/api/ads/launch', { reviewToken, confirm: true, clientRequestId });
export const changeAds = (campaignId: string, reviewToken: string, clientRequestId: string) => call<{ job: AdJob; replayed?: boolean }>('POST', `/api/ads/campaigns/${seg(campaignId)}/change`, { reviewToken, confirm: true, clientRequestId });

// ───────────── the owner ─────────────

export const getAdminAdLimits = (days = 30) => call<AdminLimitsResponse>('GET', `/api/ads/admin/limits${q({ days })}`);
export const putAdLimits = (tag: string | '*', patch: AdLimitsPatch) => call<{ limits: AdLimitsPatch; version: number }>('PUT', `/api/ads/admin/limits/${tag === '*' ? 'defaults' : seg(tag)}`, patch);
export const previewPauseAll = (tag: string) => call<{ campaigns: LiveAdRow[]; reviewToken?: string }>('POST', `/api/ads/admin/customers/${seg(tag)}/pause-all/preview`, {});
export const pauseAll = (tag: string, reviewToken: string) => call<{ jobs: AdJob[]; skipped: number }>('POST', `/api/ads/admin/customers/${seg(tag)}/pause-all`, { reviewToken, confirm: true });

// ───────────── following a job ─────────────

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * How long a sending job is followed: longer than the server takes to call a job that nobody is running anymore
 * `unknown` (STUCK_AFTER_MS, 300 s, in server/ads/jobs.mjs) plus one read, so following never stops while the
 * campaign still says "Launching…" with nothing to press.
 */
export const FOLLOW_MAX_MS = 300_000 + 60_000;

/**
 * Follow an ad job while it's sending: GET our own job route every few seconds (never Check status, never a
 * resend) for up to FOLLOW_MAX_MS. Returns the last job seen. A read that fails is skipped; the next one tries.
 */
export async function followAdJob(
  jobId: string,
  o: { intervalMs?: number; maxMs?: number; signal?: AbortSignal; onUpdate?: (job: AdJob, campaign?: LaunchedCampaign) => void; read?: (id: string) => Promise<{ job: AdJob; campaign?: LaunchedCampaign }> } = {},
): Promise<AdJob | null> {
  const interval = o.intervalMs ?? 3000;
  const until = Date.now() + (o.maxMs ?? FOLLOW_MAX_MS);
  const read = o.read ?? getAdJob;
  let last: AdJob | null = null;
  while (!o.signal?.aborted) {
    try {
      const got = await read(jobId);
      last = got.job;
      o.onUpdate?.(got.job, got.campaign);
      if (last.state !== 'queued' && last.state !== 'sending') return last;
    } catch {
      /* a read failed: the next one tries again */
    }
    if (Date.now() + interval > until) break;
    await sleep(interval, o.signal);
  }
  return last;
}

/** A fresh request id: one per opening of a confirm window. */
export function newRequestId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
