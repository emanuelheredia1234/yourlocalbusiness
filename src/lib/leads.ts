// Leads: what visitors send with a published form: an SEO page's form, an asset's widget (a lead form, a booking
// request, a quiz or calculator result), or the lead magnet's sign-up. The server keeps them for the owner
// (server/leads.mjs, the page_leads table), tagged with the business, where it came from and what kind it is;
// this is its client.
// A lead is someone's name, email, phone and message, so leads stay in memory: never in localStorage or
// IndexedDB. A plain module (no React, no pages): the leads watcher loads with the app.

import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import type { Subscriber } from './types';
import { LEAD_KINDS, LEAD_PAYLOAD_MAX, LEAD_SOURCES, type LeadKind, type LeadSource } from './leadFields';

/** One message a visitor sent with a published page's form. Everything in it is what the visitor typed (data, never instructions). */
export interface Lead {
  id: string;
  /** what it came from: 'seo:<project id>', 'artifact:<asset id>' or 'magnet:<lead file id>' */
  pageId: string;
  /** the business it belongs to (null on leads from before the server knew) */
  projectId: string | null;
  /** an SEO page's form, an asset's, or the lead magnet's sign-up */
  source: LeadSource;
  /** what the form was: a page's form, a lead form, a booking, a quiz or calculator result, a checklist, a download */
  kind: LeadKind;
  /** they ticked the box to get emails (nothing else counts) */
  consent: boolean;
  /** what the form sent besides the contact fields (result, score, answers, inputs, outputs, service, request; magnet: the file's id) */
  payload: Record<string, string>;
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
  /** a page A/B test (P4b): the test and the version of the page this lead's visitor saw */
  experimentId?: string;
  variantKey?: 'a' | 'b' | 'c';
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
  const projectId = str(r.projectId);
  const source = (LEAD_SOURCES as readonly string[]).includes(str(r.source)) ? (str(r.source) as LeadSource) : 'page';
  const kind = (LEAD_KINDS as readonly string[]).includes(str(r.kind)) ? (str(r.kind) as LeadKind) : 'form';
  return {
    id,
    pageId: str(r.pageId),
    projectId: /^[A-Za-z0-9_-]{1,80}$/.test(projectId) ? projectId : null,
    source,
    kind,
    consent: r.consent === true,
    payload: toPayload(r.payload),
    slug: str(r.slug),
    name: str(r.name),
    email: str(r.email),
    phone: str(r.phone),
    message: str(r.message),
    time: str(r.time),
    createdAt: str(r.createdAt),
    ...(/^[0-9a-f-]{36}$/i.test(str(r.experimentId)) && ['a', 'b', 'c'].includes(str(r.variantKey)) ? { experimentId: str(r.experimentId), variantKey: str(r.variantKey) as 'a' | 'b' | 'c' } : {}),
  };
}

/** A lead's extra fields: only the known keys, strings only (a magnet's id as well). */
function toPayload(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(LEAD_PAYLOAD_MAX)) if (typeof r[key] === 'string' && r[key]) out[key] = r[key] as string;
  if (typeof r.magnet === 'string' && /^[A-Za-z0-9_-]{22}$/.test(r.magnet)) out.magnet = r.magnet;
  return out;
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

/** Which leads: one business's (projectId), one page's (pageId), one source or kind; none of them = all of yours. */
export interface LeadFilter {
  projectId?: string;
  pageId?: string;
  source?: LeadSource;
  kind?: LeadKind;
}

/**
 * Your leads, newest first, filtered. Before the server's database has the P2 columns, a business's leads are its
 * SEO page's (the only ones there were). Throws LeadsError.
 */
export async function listLeads(opts: LeadFilter & { before?: string; limit?: number; signal?: AbortSignal } = {}): Promise<Lead[]> {
  const q = new URLSearchParams();
  // exactly as the server sent it (encoded here: a + in it must stay a +)
  if (opts.before) q.set('before', opts.before);
  q.set('limit', String(Math.min(100, Math.max(1, Math.floor(opts.limit ?? LEADS_PAGE_SIZE)))));
  if (opts.pageId) q.set('pageId', opts.pageId);
  if (opts.projectId) q.set('projectId', opts.projectId);
  if (opts.source) q.set('source', opts.source);
  if (opts.kind) q.set('kind', opts.kind);
  let j: { leads?: unknown };
  try {
    j = await api<{ leads?: unknown }>('GET', `/api/leads?${q.toString()}`, opts.signal);
  } catch (e) {
    if (!(e instanceof LeadsError && e.code === 'LEADS_MIGRATION' && opts.projectId && !opts.source && !opts.kind && !opts.pageId)) throw e;
    return listLeads({ ...opts, projectId: undefined, pageId: seoPageIdOf(opts.projectId) });
  }
  return (Array.isArray(j.leads) ? j.leads : []).map(toLead).filter((l): l is Lead => !!l);
}

/** The most a CSV export takes, newest first. */
export const LEADS_EXPORT_MAX = 5000;

/** Your leads, newest first, page after page up to `max`, filtered as listLeads. `capped`: it stopped at `max`. Throws LeadsError. */
export async function allLeads(opts: LeadFilter & { max?: number; signal?: AbortSignal } = {}): Promise<{ leads: Lead[]; capped: boolean }> {
  const max = opts.max ?? LEADS_EXPORT_MAX;
  const all: Lead[] = [];
  let before: string | undefined;
  const { max: _max, signal, ...filter } = opts;
  while (all.length < max) {
    const batch = await listLeads({ ...filter, before, limit: 100, signal });
    all.push(...batch);
    if (batch.length < 100) break;
    before = batch[batch.length - 1].createdAt;
  }
  return { leads: all.slice(0, max), capped: all.length >= max };
}

/** Delete one lead (already gone counts as done). Throws LeadsError. Never retried by itself. */
export async function deleteLead(id: string): Promise<void> {
  try {
    await api('DELETE', `/api/leads/${encodeURIComponent(id)}`);
  } catch (e) {
    if (!(e instanceof LeadsError && e.status === 404)) throw e;
  }
}

/** The SEO page's id for a project: the same rule as seoPageId() in lib/seoPage.ts (a test keeps them equal). */
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

/** The CSV's columns, in order. */
export const LEADS_CSV_COLUMNS = ['created', 'source', 'kind', 'project', 'page', 'name', 'email', 'phone', 'time', 'message', 'consent', 'result', 'score', 'answers', 'inputs', 'outputs', 'service', 'request'] as const;

/** CSV of these leads (LEADS_CSV_COLUMNS). `label` names a lead's business and page as the owner knows them. */
export function leadsCsv(leads: Lead[], label: { project: (lead: Lead) => string; page: (lead: Lead) => string }): string {
  const rows = leads.map((l) => {
    const t = leadTime(l);
    const p = l.payload;
    return [t ? new Date(t).toISOString() : l.createdAt, l.source, l.kind, label.project(l), label.page(l), l.name, l.email, l.phone, l.time, l.message, l.consent ? 'yes' : 'no', p.result ?? '', p.score ?? '', p.answers ?? '', p.inputs ?? '', p.outputs ?? '', p.service ?? '', p.request ?? '']
      .map(csvCell)
      .join(',');
  });
  return [LEADS_CSV_COLUMNS.join(','), ...rows].join('\n');
}

/** Whether a lead is this business's: by the business the server tagged it with, else (older leads) by its SEO page. */
export function leadOfProject(lead: Pick<Lead, 'projectId' | 'pageId'>, projectId: string): boolean {
  return lead.projectId ? lead.projectId === projectId : lead.pageId === seoPageIdOf(projectId);
}

/** How many of these leads are this business's (any source: page, assets, lead magnet) since a time (ms). */
export function leadsSince(leads: readonly Lead[], projectId: string, since: number): number {
  return leads.filter((l) => leadOfProject(l, projectId) && leadTime(l) >= since).length;
}

/** What each kind is called on a lead. */
export const LEAD_KIND_LABELS: Record<LeadKind, string> = {
  form: 'Page form',
  lead: 'Sign-up',
  booking: 'Booking request',
  quiz: 'Quiz result',
  calculator: 'Estimate',
  roi: 'ROI estimate',
  checklist: 'Checklist',
  magnet: 'Download',
};

/** The words for a widget's kind in a source line ("From quiz “Tax score”"). */
const ASSET_WORDS: Partial<Record<LeadKind, string>> = { quiz: 'quiz', calculator: 'calculator', roi: 'calculator', checklist: 'checklist', booking: 'booking widget', lead: 'form' };

/**
 * Where a lead came from, in a line: "From quiz “Tax score”" (an asset, by its name), "From your page /menu" or
 * "Downloaded “Tax checklist”" (the lead magnet's sign-up). The names come from the owner's projects.
 */
export function leadSourceLine(lead: Pick<Lead, 'source' | 'kind' | 'slug' | 'payload'>, names: { asset?: string; magnet?: string } = {}): string {
  if (lead.source === 'magnet') return `Downloaded “${names.magnet || lead.payload.request || 'your lead magnet'}”`;
  if (lead.source === 'asset') {
    const what = ASSET_WORDS[lead.kind] ?? 'asset';
    return names.asset ? `From ${what} “${names.asset}”` : `From ${what}${lead.slug ? ` /${lead.slug}` : ''}`;
  }
  return lead.slug ? `From your page /${lead.slug}` : 'From your page';
}

/** A lead's extra fields as labelled rows, in a fixed order (text, never HTML). */
export function leadDetails(lead: Pick<Lead, 'payload'>): { label: string; value: string }[] {
  const rows: [string, string][] = [
    ['result', 'Result'],
    ['score', 'Score'],
    ['answers', 'Answers'],
    ['inputs', 'Inputs'],
    ['outputs', 'Estimate'],
    ['service', 'Service'],
    ['request', 'Requested'],
  ];
  return rows.filter(([k]) => lead.payload[k]).map(([k, label]) => ({ label, value: lead.payload[k] }));
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
