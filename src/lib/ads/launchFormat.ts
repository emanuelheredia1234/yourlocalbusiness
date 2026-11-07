// What the spend confirm and the Campaigns tab say about money and dates. Amounts are whole units of the ad
// account's own currency, formatted with that currency (never "$" unless the account is in USD); dates are the
// account's calendar days ('YYYY-MM-DD') in its own time zone. Nothing here converts between currencies.

import type { AdsPlatform, ChangeReview, LaunchReview } from './launchTypes';
import { PLATFORM_LABEL, PLATFORM_LONG } from './launchTypes';

/** "$25.00", "€25.00", "¥2,500" (the currency's own decimals). */
export function money(amount: number | null | undefined, currency: string): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const code = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

/** "Mon 1 Dec 2026" for a calendar day. */
export function dayLabel(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${ymd}T00:00:00Z`)).replace(/,/g, '');
}

/** "1 Dec" (short, for tables). */
export function shortDay(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${ymd}T00:00:00Z`));
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The calendar day it is in a time zone now ('YYYY-MM-DD'). */
export function todayIn(tz: string, t = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

/** "Runs 14 days: Mon 1 Dec 2026 to Sun 14 Dec 2026, ending 23:59 America/Chicago" */
export function runsText(start: string, days: number, tz: string): string {
  if (!start || !Number.isInteger(days) || days < 1) return '';
  const end = addDays(start, days - 1);
  return `Runs ${days} day${days === 1 ? '' : 's'}: ${dayLabel(start)} to ${dayLabel(end)}, ending 23:59 ${tz}`;
}

/** The UTC offset of `tz` at instant t, in minutes. */
function offsetMinutes(tz: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  return Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(t / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time ('YYYY-MM-DD', 'HH:MM:SS') happens in `tz` (ms), daylight saving included. */
export function localInstant(ymd: string, hms: string, tz: string): number {
  const guess = Date.parse(`${ymd}T${hms}Z`);
  return guess - offsetMinutes(tz, guess - offsetMinutes(tz, guess) * 60_000) * 60_000;
}

/**
 * Meta runs a daily budget only on an ad set scheduled for more than 24 hours, and the last day ends 23:59:59 in the
 * ad account's zone, so one day is never enough (server/ads/build.mjs, which decides: this only keeps the choice
 * honest). "As soon as approved", or a start already past, counts from the latest the launch can go out.
 */
export const META_DAILY_MIN_MS = 24 * 3_600_000;
export const META_SEND_MARGIN_MS = 15 * 60_000;
/** the fewest days on Meta whatever the start (a date-only end is 23:59:59) */
export const META_MIN_DAYS = 2;

/** The fewest days (1 to 90) whose Meta schedule runs a daily budget more than 24 hours from this start; 91 if none. */
export function metaMinDays(o: { startDay: string; time?: string | null; asap?: boolean; tz: string; now?: number }): number {
  const now = o.now ?? Date.now();
  try {
    const at = o.asap ? now : localInstant(o.startDay, /^([01]\d|2[0-3]):[0-5]\d$/.test(o.time ?? '') ? `${o.time}:00` : '00:00:00', o.tz);
    const start = Math.max(at, now + META_SEND_MARGIN_MS);
    for (let n = 1; n <= 90; n += 1) if (localInstant(addDays(o.startDay, n - 1), '23:59:59', o.tz) - start > META_DAILY_MIN_MS) return n;
    return 91;
  } catch {
    return META_MIN_DAYS;
  }
}

export interface ConfirmLine {
  label: string;
  value: string;
}

/** The spend confirm's lines for one platform (spec §7.4), from the server's review only. */
export function launchLines(r: LaunchReview): ConfirmLine[] {
  const cur = r.account.currency;
  const P = PLATFORM_LABEL[r.platform];
  const startText = r.asap || !r.start ? `${r.start ? dayLabel(r.start) : 'The day it’s approved'}, as soon as approved` : `${dayLabel(r.start)}${r.startTime ? ` ${r.startTime}` : ''}`;
  const lines: ConfirmLine[] = [
    { label: 'Ad account', value: `${r.account.name} (…${r.account.idTail}), billed in ${cur} by ${P} to your payment method` },
    { label: 'Daily budget', value: `${money(r.daily, cur)} a day` },
    { label: 'Dates', value: `${startText} → ${r.end ? `${dayLabel(r.end)} 23:59` : '—'} (${r.tz}), ${r.days} day${r.days === 1 ? '' : 's'}` },
    { label: 'Planned total', value: `${money(r.plannedTotal, cur)}. ${P} can spend more than ${money(r.daily, cur)} on a busy day and less on others.` },
    r.platform === 'meta'
      ? { label: 'Spending limit', value: `Meta will stop this campaign at ${money(r.spendCap ?? r.plannedTotal, cur)} in total (a limit the app sets on the campaign).` }
      : { label: 'Spending limit', value: 'Google can also spend more than the daily amount on some days. The app can’t set a total limit on Google: pause or end it to stop.' },
    { label: 'Starts as', value: r.status === 'PAUSED' ? 'PAUSED: nothing is spent until you resume it' : `ACTIVE: spending starts once ${P} approves the ads` },
    { label: 'Ads', value: `${r.ads.length} ad${r.ads.length === 1 ? '' : 's'}${r.platform === 'meta' ? ` (${r.ads.map((a) => a.variant).join(', ')})` : ''}, sending people to ${r.linkUrl}` },
  ];
  if (r.limitDaily != null) lines.push({ label: 'Your limit', value: `${money(r.limitDaily, cur)} a day across live campaigns; after this: ${money(r.committedDailyAfter, cur)} committed` });
  return lines;
}

/** The launch button's words: the choice and the daily amount ("Launch on Meta and spend $25.00 a day"). */
export function launchButton(reviews: LaunchReview[]): string {
  if (reviews.length > 1) {
    const currencies = new Set(reviews.map((r) => r.account.currency));
    if (currencies.size === 1) {
      const cur = reviews[0].account.currency;
      return `Launch both (planned total ${money(reviews.reduce((s, r) => s + r.plannedTotal, 0), cur)})`;
    }
    return 'Launch both';
  }
  const r = reviews[0];
  if (!r) return 'Launch';
  const P = PLATFORM_LABEL[r.platform];
  return r.status === 'PAUSED' ? `Launch paused on ${P}` : `Launch on ${P} and spend ${money(r.daily, r.account.currency)} a day`;
}

/** The combined line for two platforms, only when both are in one currency (never summed across currencies). */
export function combinedLine(reviews: LaunchReview[]): string | null {
  if (reviews.length < 2) return null;
  const currencies = new Set(reviews.map((r) => r.account.currency));
  if (currencies.size !== 1) return null;
  const cur = reviews[0].account.currency;
  const daily = reviews.reduce((s, r) => s + r.daily, 0);
  const total = reviews.reduce((s, r) => s + r.plannedTotal, 0);
  return `Together: ${money(daily, cur)} a day, ${money(total, cur)} planned in total.`;
}

/** Whether the confirm needs the "real money" tick: an ACTIVE launch (every resume asks too). */
export const needsMoneyTick = (reviews: LaunchReview[]) => reviews.some((r) => r.status === 'ACTIVE');

export const platformTitle = (p: AdsPlatform) => PLATFORM_LONG[p];

/** The change confirm's lines (spend or short), from the server's review only. */
export function changeLines(r: ChangeReview): ConfirmLine[] {
  const cur = r.account.currency;
  const P = PLATFORM_LABEL[r.platform];
  const lines: ConfirmLine[] = [{ label: 'Ad account', value: `${r.account.name} (…${r.account.idTail}) on ${P}` }];
  const asOf = r.current.live ? 'live now' : r.current.asOf ? `as of ${new Date(r.current.asOf).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'last known';
  if (r.action === 'budget' && r.proposed.daily != null) {
    const delta = r.dailyDelta != null ? ` (${r.dailyDelta > 0 ? '+' : ''}${money(r.dailyDelta, cur)})` : '';
    lines.push({ label: 'Daily budget', value: `${money(r.current.daily, cur)} → ${money(r.proposed.daily, cur)} a day${delta} (now: ${asOf})` });
  }
  if (r.action === 'end_date' && r.proposed.end) lines.push({ label: 'Last day', value: `${r.current.end ? dayLabel(r.current.end) : 'none'} → ${dayLabel(r.proposed.end)} 23:59 (${r.account.timezone})` });
  if (r.action === 'resume' || (r.action === 'creative' && r.confirmKind === 'spend')) lines.push({ label: 'Daily budget', value: `${money(r.current.daily, cur)} a day (now: ${asOf})` });
  if (r.proposed.remainingDays != null && r.proposed.remainingTotal != null) lines.push({ label: 'Remaining', value: `${r.proposed.remainingDays} day${r.proposed.remainingDays === 1 ? '' : 's'}: ${money(r.proposed.remainingTotal, cur)}` });
  if (r.spentSoFar != null && r.confirmKind === 'spend') lines.push({ label: 'Spent so far', value: money(r.spentSoFar, cur) });
  if (r.proposed.total != null && r.confirmKind === 'spend') lines.push({ label: 'Whole campaign', value: money(r.proposed.total, cur) });
  if (r.platform === 'meta' && r.newSpendCap != null) lines.push({ label: 'Spending limit', value: `Meta will stop this campaign at ${money(r.newSpendCap, cur)} in total${r.current.spendCap != null ? ` (was ${money(r.current.spendCap, cur)})` : ''}.` });
  else if (r.platform === 'google' && r.confirmKind === 'spend') lines.push({ label: 'Spending limit', value: 'Google can spend more than the daily amount on some days. Pause or end it to stop.' });
  if (r.action === 'pause') lines.push({ label: 'After', value: 'Paused: it stops spending. You can resume it later.' });
  if (r.action === 'end') lines.push({ label: 'After', value: 'It stops now and can’t be resumed from the app.' });
  if (r.action === 'creative' && r.proposed.ad) lines.push({ label: 'New ad', value: `Version ${r.proposed.ad.variant}: “${r.proposed.ad.headline}”` });
  if (r.action === 'creative' && r.proposed.headlines) lines.push({ label: 'New text', value: `${r.proposed.headlines.length} headlines, ${r.proposed.descriptions?.length ?? 0} descriptions from the plan` });
  return lines;
}

const ACTION_WORD: Record<ChangeReview['action'], string> = { pause: 'Pause', resume: 'Resume', end: 'End', budget: 'Change the budget', end_date: 'Change the last day', creative: 'Swap the ad' };

/** The change confirm's title and button. */
export function changeTitle(r: Pick<ChangeReview, 'action' | 'platform'>): string {
  if (r.action === 'end') return 'End this campaign?';
  if (r.action === 'pause') return `Pause on ${PLATFORM_LABEL[r.platform]}?`;
  return `${ACTION_WORD[r.action]} on ${PLATFORM_LABEL[r.platform]}`;
}
export function changeButton(r: ChangeReview): string {
  const cur = r.account.currency;
  if (r.action === 'resume') return `Resume and spend ${money(r.current.daily, cur)} a day`;
  if (r.action === 'budget' && r.proposed.daily != null) return r.confirmKind === 'spend' ? `Raise to ${money(r.proposed.daily, cur)} a day` : `Lower to ${money(r.proposed.daily, cur)} a day`;
  if (r.action === 'end_date') return r.confirmKind === 'spend' ? 'Run it longer' : 'End it sooner';
  if (r.action === 'end') return 'End campaign';
  if (r.action === 'pause') return 'Pause';
  return r.confirmKind === 'spend' ? `Swap and spend ${money(r.current.daily, cur)} a day` : 'Swap the ad';
}
