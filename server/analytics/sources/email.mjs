// Source `email`: the customer's Omnisend stats (omnisend.reports(): at most one live call per brand per hour, 40 a
// day) and the business's leads (first-party, page_leads: its pages, assets and lead magnet, by source) and its lead
// magnets' downloads (lead_files).

import { downloadCount, leadCounts } from '../snapshots.mjs';

/**
 * omnisend: the routes object from server/omnisend.mjs (reports, connected). previous: this project's stored
 * email snapshot row (served again when Omnisend's answer was the hour-old one and it has nothing newer).
 */
export async function emailSource({ db, userId, projectId, omnisend, previous, now }) {
  const leadsBySource = await leadCounts(db, userId, projectId, now).catch(() => ({ page: 0, asset: 0, magnet: 0 }));
  const leads = leadsBySource.page + leadsBySource.asset + leadsBySource.magnet;
  const downloads = await downloadCount(db, userId, projectId).catch(() => 0);
  const empty = () => ({ ...emptyEmail(leads), leadsBySource, downloads });
  if (typeof omnisend?.reports !== 'function') return { status: 'not_connected', errorCode: 'NOT_CONNECTED', data: empty() };
  const got = await omnisend.reports(userId);
  if (got.status === 'ok') {
    const base = got.data ?? (previous?.data && typeof previous.data === 'object' && 'sent' in previous.data ? previous.data : null);
    if (!base) return { status: 'skipped', errorCode: 'RATE_LIMITED', data: empty() };
    const data = { ...base, leads, leadsBySource, downloads };
    const fetchedAt = got.data ? got.fetchedAt : previous?.fetched_at ?? undefined;
    return { status: 'ok', data, fetchedAt, summary: { sent: data.sent, openRate: data.openRate, clickRate: data.clickRate, revenue: data.revenue, leads } };
  }
  return { status: got.status, errorCode: got.errorCode ?? null, data: empty() };
}

export const emptyEmail = (leads = 0) => ({ sent: 0, openRate: 0, clickRate: 0, unsubscribeRate: 0, revenue: 0, series: [], campaigns: [], leads, leadsBySource: { page: 0, asset: 0, magnet: 0 }, downloads: 0 });
