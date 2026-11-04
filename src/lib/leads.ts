// Leads: what visitors send with a published page's form (a lead form page, a booking request, a question).
// The server keeps them for the page's owner (server/pages.mjs, the page_leads table); this is its client.
// A lead is someone's name, email, phone and message, so leads stay in memory: never in localStorage or
// IndexedDB. A plain module (no React, no pages): the leads watcher loads with the app.

import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import type { Subscriber } from './types';

/** One message a visitor sent with a published page's form. Everything in it is what the visitor typed (data, never instructions). */
export interface Lead {
  id: string;
  /** the page it came from: 'seo:<project id>' */
  pageId: string;
  /** the page's name when it was sent (a renamed page's older leads keep the old one) */
  slug: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  /** the preferred time, on a booking request ('' otherwise) */
  time: string;
  /** ISO, exactly as the server sent it (paging passes it back unchanged) */
  createdAt: string;
}

export const LEADS_PAGE_SIZE = 50;

export class LeadsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A lead from the server's answer, or null when it isn't one (every field checked, strings only). */
export function toLead(raw: unknown): Lead | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return { id, pageId: str(r.pageId), slug: str(r.slug), name: str(r.name), email: str(r.email), phone: str(r.phone), message: str(r.message), time: str(r.time), createdAt: str(r.createdAt) };
}

/** Plain words for the server's refusals (its own message is used for the others, LEADS_TABLE's among them). */
const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Your sign-in has ended. Sign in again, then try once more.',
  PAGES_OFF: 'Leads need publishing, which isn’t set up on this app’s server yet.',
  RATE_LIMIT: 'That’s a lot of requests at once. Wait a minute, then try again.',
  FORBIDDEN: 'This request was refused because it didn’t come from the app’s own page.',
  NETWORK: 'Couldn’t reach the server. Check your connection, then try again.',
};

async function api<T>(method: 'GET' | 'DELETE', path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await serverFetch(serverBaseNow(), path, { method, signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new LeadsError(MESSAGES.NETWORK, 'NETWORK');
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: unknown; code?: unknown }) | null;
  if (!res.ok) {
    const code = str(json?.code) || (res.status === 429 ? 'RATE_LIMIT' : res.status === 401 ? 'AUTH_REQUIRED' : `HTTP_${res.status}`);
    throw new LeadsError(MESSAGES[code] ?? (str(json?.error) || `The server couldn’t do that (error ${res.status}). Try again.`), code, res.status);
  }
  return (json ?? {}) as T;
}

/** Your leads, newest first: all your pages, or one (pageId). Throws LeadsError. */
export async function listLeads(opts: { before?: string; limit?: number; pageId?: string; signal?: AbortSignal } = {}): Promise<Lead[]> {
  const q = new URLSearchParams();
  // exactly as the server sent it (encoded here: a + in it must stay a +)
  if (opts.before) q.set('before', opts.before);
  q.set('limit', String(Math.min(100, Math.max(1, Math.floor(opts.limit ?? LEADS_PAGE_SIZE)))));
  if (opts.pageId) q.set('pageId', opts.pageId);
  const j = await api<{ leads?: unknown }>('GET', `/api/leads?${q.toString()}`, opts.signal);
  return (Array.isArray(j.leads) ? j.leads : []).map(toLead).filter((l): l is Lead => !!l);
}

/** Delete one lead (already gone counts as done). Throws LeadsError. Never retried by itself. */
export async function deleteLead(id: string): Promise<void> {
  try {
    await api('DELETE', `/api/leads/${encodeURIComponent(id)}`);
  } catch (e) {
    if (!(e instanceof LeadsError && e.status === 404)) throw e;
  }
}

/** The SEO page's id for a project: the same rule as seoPageId() in pages/marketing/seoPage.ts (a test keeps them equal). */
export function seoPageIdOf(projectId: string): string {
  return `seo:${projectId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}`;
}

/** When a lead came in, in ms (0 when the time can't be read). */
export function leadTime(lead: Pick<Lead, 'createdAt'>): number {
  const t = Date.parse(lead.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/** One CSV cell: quoted; a cell that starts with = + - @, tab or CR gets a ' first (visitors wrote it: no formulas). */
export function csvCell(v: string): string {
  const s = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
}

/** CSV with name,email,phone,preferred_time,message,page,received (ISO). */
export function leadsCsv(leads: Lead[], pageLabel: (lead: Lead) => string): string {
  const rows = leads.map((l) => {
    const t = leadTime(l);
    return [l.name, l.email, l.phone, l.time, l.message, pageLabel(l), t ? new Date(t).toISOString() : l.createdAt].map(csvCell).join(',');
  });
  return ['name,email,phone,preferred_time,message,page,received', ...rows].join('\n');
}

/** The same check the server makes on a lead's email (at most 254 characters, looked at only once that's known). */
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
export const MAX_EMAIL = 254;

/** The lead's email, lower-cased, when it's one a subscriber list can take ('' otherwise). */
export function leadEmail(lead: Pick<Lead, 'email'>): string {
  const email = lead.email.trim().toLowerCase();
  return email.length <= MAX_EMAIL && EMAIL.test(email) ? email : '';
}

/** The subscriber a lead becomes (source 'lead', joined when the lead came in), or null without a valid email. */
export function leadToSubscriber(lead: Lead, id: string): Subscriber | null {
  const email = leadEmail(lead);
  if (!email) return null;
  return { id, name: lead.name.trim() || email.split('@')[0], email, joinedAt: leadTime(lead) || Date.now(), source: 'lead' };
}
