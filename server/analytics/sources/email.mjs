// Source `email`: the customer's Omnisend stats (omnisend.reports(): at most one live call per brand per hour, 40 a
// day) and the leads their published sales page received (first-party, page_leads).

import { leadCount } from '../snapshots.mjs';

/**
 * omnisend: the routes object from server/omnisend.mjs (reports, connected). previous: this project's stored
 * email snapshot row (served again when Omnisend's answer was the hour-old one and it has nothing newer).
 */
export async function emailSource({ db, userId, projectId, omnisend, previous, now }) {
  const leads = await leadCount(db, userId, projectId, now).catch(() => 0);
  if (typeof omnisend?.reports !== 'function') return { status: 'not_connected', errorCode: 'NOT_CONNECTED', data: emptyEmail(leads) };
  const got = await omnisend.reports(userId);
  if (got.status === 'ok') {
    const base = got.data ?? (previous?.data && typeof previous.data === 'object' && 'sent' in previous.data ? previous.data : null);
    if (!base) return { status: 'skipped', errorCode: 'RATE_LIMITED', data: emptyEmail(leads) };
    const data = { ...base, leads };
    const fetchedAt = got.data ? got.fetchedAt : previous?.fetched_at ?? undefined;
    return { status: 'ok', data, fetchedAt, summary: { sent: data.sent, openRate: data.openRate, clickRate: data.clickRate, revenue: data.revenue, leads } };
  }
  return { status: got.status, errorCode: got.errorCode ?? null, data: emptyEmail(leads) };
}

export const emptyEmail = (leads = 0) => ({ sent: 0, openRate: 0, clickRate: 0, unsubscribeRate: 0, revenue: 0, series: [], campaigns: [], leads });
