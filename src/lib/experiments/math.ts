// What the app shows of an A/B test's result (P4b §A5). Display only: the verdict, the winner and the numbers come
// from the server (server/experiments/math.mjs), which is the one that counts. A number a network didn't report is
// unknown and shows as "—", never 0. No "statistically significant" wording anywhere.

import type { Experiment, ExperimentChanged, ExperimentMetric, ExperimentResult, ExperimentVariant, VariantKey } from '@/lib/types';

export const DASH = '—';
const n = (v: number) => v.toLocaleString('en-US');
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** "Version A" (or the variant's own label when it has one, for A "Original"). */
export const versionName = (key: VariantKey) => `Version ${key.toUpperCase()}`;

/** "3.4%" (one decimal), "—" when unknown. */
export function pct(rate: number | undefined | null): string {
  if (!num(rate)) return DASH;
  return `${(rate * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

/** A count, or "—" when the network didn't say. */
export const count = (v: unknown): string => (num(v) ? n(v) : DASH);

export const METRIC_LABEL: Record<ExperimentMetric, string> = {
  engagement_rate: 'Engagement rate',
  views: 'Views',
  reach: 'Reach',
  open_rate: 'Open rate',
  click_rate: 'Click rate',
  lead_rate: 'Lead rate',
};

export const CHANGED_LABEL: Record<ExperimentChanged, string> = {
  hook: 'Hook',
  caption: 'Caption',
  visual: 'Visual',
  cta: 'Call to action',
  time: 'Posting time',
  subject: 'Subject line',
  opening: 'Opening',
  headline: 'Headline',
  hero: 'Hero',
};

const UNIT: Partial<Record<ExperimentMetric, string>> = { engagement_rate: 'reached', lead_rate: 'visitors', open_rate: 'sent', click_rate: 'sent' };

/** The chosen metric for one version: "3.4% · 41 of 1,210 reached", "2,340 views", or "—". */
export function metricLine(e: Pick<Experiment, 'metric' | 'result'>, key: VariantKey): string {
  const row = e.result?.perVariant?.[key];
  if (!row) return DASH;
  if (num(row.count)) return `${n(row.count)} ${e.metric === 'reach' ? 'reached' : 'views'}`;
  if (num(row.successes) && num(row.trials)) {
    const unit = e.metric === 'engagement_rate' && e.result.measure && e.result.measure !== 'reach' ? e.result.measure : (UNIT[e.metric] ?? '');
    return `${pct(row.trials > 0 ? row.successes / row.trials : undefined)} · ${n(row.successes)} of ${n(row.trials)}${unit ? ` ${unit}` : ''}`;
  }
  return DASH;
}

/** The secondary numbers of a version, by kind (unknown values as "—"). */
export function secondaryNumbers(e: Pick<Experiment, 'kind'>, v: ExperimentVariant): { label: string; value: string }[] {
  if (e.kind === 'page') return [
    { label: 'Visitors', value: n(v.visitors) },
    { label: 'Leads', value: n(v.leads) },
    { label: 'Conversion', value: v.visitors > 0 ? pct(v.leads / v.visitors) : DASH },
  ];
  if (e.kind === 'email') {
    const sent = v.metrics.sent;
    return [
      { label: 'Sent', value: count(sent) },
      { label: 'Opens', value: num(sent) && num(v.metrics.openRate) ? n(Math.round(sent * v.metrics.openRate)) : DASH },
      { label: 'Clicks', value: num(sent) && num(v.metrics.clickRate) ? n(Math.round(sent * v.metrics.clickRate)) : DASH },
    ];
  }
  return (['views', 'likes', 'comments', 'shares', 'saves'] as const).map((k) => ({ label: k[0].toUpperCase() + k.slice(1), value: count(v.metrics[k]) }));
}

const WHAT: Record<string, string> = { reach: 'reached', views: 'views', impressions: 'impressions', visitors: 'visitors', sent: 'sent', leads: 'leads', opens: 'opens', engagements: 'engagements' };

/** "Not enough data to call it: B needs 300 reached (has 120); 20 engagements in all (has 8)". */
export function missingCopy(r: ExperimentResult): string {
  if (r.reason === 'variant_missing') return 'A version is missing: its post was deleted, or it didn’t go out.';
  if (r.reason === 'no_common_measure') return 'The networks didn’t report the same numbers for each version, so they can’t be compared.';
  if (r.reason === 'page_changed') return 'The page was published again during the test, so its versions can’t be compared.';
  if (r.reason === 'omnisend_picks') return 'Omnisend picks the winner from the test group’s opens or clicks.';
  if (r.reason === 'omnisend_no_pick') return 'Omnisend didn’t pick a winner by its decision time.';
  const parts = (r.missing ?? []).map((m) => (m.key ? `${versionName(m.key)} needs ${n(m.need)} ${WHAT[m.what] ?? m.what} (has ${n(m.have)})` : `${n(m.need)} ${WHAT[m.what] ?? m.what} in all (has ${n(m.have)})`));
  return parts.length ? parts.join('; ') : 'Not enough data yet.';
}

export interface VerdictCopy {
  tone: 'good' | 'neutral' | 'warn';
  title: string;
  body: string;
}

const day = (iso: string | null | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

/** The verdict banner's words (the server's verdict, in plain words). */
export function verdictCopy(e: Pick<Experiment, 'result' | 'state' | 'endsAt' | 'metric' | 'winner'>): VerdictCopy {
  const r = e.result ?? {};
  const rateOf = (k: VariantKey) => {
    const row = r.perVariant?.[k];
    return row && num(row.count) ? n(row.count) : row && num(row.rate) ? pct(row.rate) : DASH;
  };
  const keys = Object.keys(r.perVariant ?? {}) as VariantKey[];
  const both = keys.map((k) => `${k.toUpperCase()} ${rateOf(k)}`).join(' vs ');
  switch (r.verdict) {
    case 'winner': {
      const w = r.winner as VariantKey;
      const lift = num(r.lift) ? ` +${r.lift}%` : '';
      return { tone: 'good', title: `Clear winner: ${versionName(w)}${lift}`, body: r.source === 'omnisend' ? 'Omnisend picked it from the opens or clicks of the test group.' : `${both}. The numbers are clear enough to call it.` };
    }
    case 'too_close':
      return { tone: 'neutral', title: 'Too close to call', body: `${both}. Both work about the same.` };
    case 'tie':
      return { tone: 'neutral', title: 'Tie', body: both ? `${both}. They did the same.` : 'They did the same.' };
    case 'not_enough':
      return { tone: 'warn', title: 'Not enough data to call it', body: missingCopy(r) };
    case 'keep_going':
      return { tone: 'neutral', title: 'Keep going', body: `${r.reason ? missingCopy(r) : r.leader ? `${versionName(r.leader)} is ahead so far, but it’s too early to call.` : 'It’s too early to call.'}${e.endsAt ? ` Decides by ${day(e.endsAt)}.` : ''}` };
    default:
      return { tone: 'neutral', title: e.state === 'draft' ? 'Not started' : 'Not enough data yet', body: e.state === 'draft' ? 'Results show once the first version goes out.' : `Results show after the first read.${e.endsAt ? ` Decides by ${day(e.endsAt)}.` : ''}` };
  }
}

/** The notes under the verdict (confounds and caveats). */
export function resultNotes(e: Pick<Experiment, 'result' | 'winner'>, alsoChanged = false): string[] {
  const out: string[] = [];
  const r = e.result ?? {};
  if (r.note === 'time_differs') out.push('These went out at different times, which can also change results.');
  if (r.note === 'non_followers') out.push('Trial Reels are shown to non-followers first, so this tells you what works with new people.');
  if (alsoChanged) out.push('More than one thing changed between the versions, so the result can’t say which made the difference.');
  if (r.reason === 'variant_missing' && r.verdict !== 'not_enough') out.push('A version is missing: its post was deleted, or it didn’t go out.');
  if (r.pickedByYou && e.winner) out.push(`${versionName(e.winner)} is your pick: the numbers didn’t call it.`);
  return out;
}

/** "Last updated 3:40 PM" (or the date when older than a day). */
export function lastUpdated(iso: string | null | undefined, now = Date.now()): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const t = Date.parse(iso);
  const d = new Date(t);
  return `Last updated ${now - t < 86_400_000 ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
