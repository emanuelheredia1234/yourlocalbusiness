// The launch window and its spend confirm: no PAUSED/ACTIVE default, nothing spends until the customer picks it
// and ticks "real money" for an ACTIVE launch; the confirm names the platform, the account and its tail, the
// daily and total in the account's own currency (a EUR account never shows $), the dates with the time zone and
// the last day, the status, Meta's spending limit or Google's no-limit line; two currencies are never summed.
// One request id per opening, reused after an uncertain answer; a press while sending sends nothing.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, subtitle, children, footer }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), createElement('p', null, subtitle), children, createElement('footer', null, footer)),
}));

import type { LaunchReview } from '@/lib/ads/launchTypes';
import { AdsApiError } from '@/lib/ads/launchApi';
import { META_CTA } from '@/lib/ads';
import { CTA_MAP } from '../../../../../server/ads/build.mjs';
import { newProject } from '@/store/defaults';
import { newAdCampaign } from '@/ai/local/ads';
import { SpendConfirm, sendLaunches, launchRequestIdFor, type LaunchItem } from './SpendConfirm';
import { BudgetStep } from './BudgetStep';
import { draftProblems, forCurrency, newDraft, previewRequest, readyToConfirm, requestKey, splitLine } from './draft';

const review = (over: Partial<LaunchReview> = {}): LaunchReview => ({
  platform: 'meta',
  account: { name: 'Acme Plumbing', idTail: '1234', currency: 'USD', timezone: 'America/Chicago' },
  status: 'ACTIVE',
  daily: 25,
  days: 14,
  plannedTotal: 350,
  start: '2026-12-01',
  startTime: null,
  asap: true,
  end: '2026-12-14',
  tz: 'America/Chicago',
  goal: 'traffic',
  targeting: ['Austin'],
  leftOut: [],
  ads: [
    { variant: 'A', linkUrl: 'https://acme.example/plumbing', headline: 'Fast fixes' },
    { variant: 'B', linkUrl: 'https://acme.example/plumbing', headline: 'Same day' },
  ],
  claims: [],
  warnings: [],
  blockers: [],
  committedDailyAfter: 25,
  limitDaily: 50,
  spendCap: 350,
  linkUrl: 'https://acme.example/plumbing',
  setup: [],
  ...over,
});
const item = (r: LaunchReview, key = `plan1:${r.platform}`): LaunchItem => ({ key, platform: r.platform, reviewToken: 'tok', review: r });
const confirmHtml = (items: LaunchItem[]) => renderToStaticMarkup(createElement(SpendConfirm, { open: true, items, onClose: () => {}, onLaunched: () => {} }));
const launchButton = (html: string) => html.match(/<button[^>]*class="btn btn-primary[^"]*"[^>]*>(?:(?!<\/button>).)*<\/button>/)?.[0] ?? '';

describe('the spend confirm', () => {
  it('names the platform, account and tail, money in the account currency, dates with the zone and last day, the status and Meta’s limit', () => {
    const html = confirmHtml([item(review())]);
    for (const t of ['Launch on Meta (Facebook and Instagram)', 'Acme Plumbing (…1234), billed in USD by Meta', '$25.00 a day', '$350.00', 'Mon 14 Dec 2026 23:59', 'America/Chicago', '14 days', 'ACTIVE: spending starts once Meta approves the ads', 'Meta will stop this campaign at $350.00 in total', 'https://acme.example/plumbing', '$50.00 a day across live campaigns']) expect(html).toContain(t);
    expect(html).toContain('Launch on Meta and spend $25.00 a day');
  });

  it('an ACTIVE launch keeps the button off until the real-money tick', () => {
    const html = confirmHtml([item(review())]);
    expect(html).toContain('I understand this will spend real money from the Acme Plumbing ad account.');
    expect(launchButton(html)).toMatch(/disabled=""/);
  });

  it('a PAUSED launch says nothing is spent and needs no tick', () => {
    const html = confirmHtml([item(review({ status: 'PAUSED' }))]);
    expect(html).toContain('PAUSED: nothing is spent until you resume it');
    expect(html).toContain('Launch paused on Meta');
    expect(html).not.toContain('I understand this will spend real money');
    expect(launchButton(html)).not.toMatch(/disabled=""/);
  });

  it('Google says the app can’t set a total limit', () => {
    const html = confirmHtml([item(review({ platform: 'google', status: 'PAUSED', spendCap: undefined, ads: [{ variant: 'Search', linkUrl: 'https://acme.example', headlines: ['a', 'b', 'c'] }] }))]);
    expect(html).toContain('The app can’t set a total limit on Google: pause or end it to stop.');
    expect(html).not.toContain('Meta will stop');
  });

  it('two platforms in one currency: both lines and the combined total', () => {
    const html = confirmHtml([item(review()), item(review({ platform: 'google', daily: 10, plannedTotal: 140, spendCap: undefined }))]);
    expect(html).toContain('Together: $35.00 a day, $490.00 planned in total.');
    expect(html).toContain('Launch both (planned total $490.00)');
  });

  it('two currencies: never summed, and a EUR account never shows $', () => {
    const eur = review({ platform: 'google', account: { name: 'Acme EU', idTail: '9876', currency: 'EUR', timezone: 'Europe/Berlin' }, tz: 'Europe/Berlin', daily: 20, plannedTotal: 280, spendCap: undefined, limitDaily: null });
    const html = confirmHtml([item(review()), item(eur)]);
    expect(html).not.toContain('Together');
    expect(html).toContain('€20.00 a day');
    const google = html.slice(html.indexOf('data-testid="spend-google"'));
    expect(google.slice(0, google.indexOf('</dl>'))).not.toContain('$');
  });
});

describe('sending a launch', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('one request per press; an uncertain answer keeps the id for the same review only', async () => {
    const sent: string[] = [];
    const send = vi.fn(async (_t: string, id: string) => {
      sent.push(id);
      throw new AdsApiError(0, null);
    });
    const it1 = item(review(), 'p:meta');
    const out = await sendLaunches([it1], {}, send);
    expect(out[0]).toMatchObject({ ok: false, uncertain: true });
    expect(!out[0].ok && out[0].message).toMatch(/may have happened - check status before trying again/);
    expect(send).toHaveBeenCalledTimes(1);
    const id = sent[0];
    // the same review pressed again gets the same id: the server answers with the job it already has
    expect(launchRequestIdFor(it1.reviewToken)).toBe(id);
    // a new review never reuses it
    expect(launchRequestIdFor('another-review')).not.toBe(id);
    const ok = vi.fn(async (_t: string, _id: string) => ({ job: { id: 'j1', kind: 'launch' as const, platform: 'meta' as const, state: 'sending' as const, message: '', requestedAt: '' } }));
    await sendLaunches([it1], {}, ok);
    expect(ok.mock.calls[0][1]).toBe(id);
    expect(launchRequestIdFor(it1.reviewToken)).not.toBe(id);
  });

  it('a replayed answer whose job failed is a failure, never “launched”', async () => {
    const send = vi.fn(async () => ({ replayed: true, job: { id: 'j2', kind: 'launch' as const, platform: 'meta' as const, state: 'failed' as const, code: 'NOT_CREATED', message: 'Meta didn’t create this campaign.', requestedAt: '' } }));
    const out = await sendLaunches([item(review(), 'p4:meta')], {}, send);
    expect(out[0]).toMatchObject({ ok: false, uncertain: false, code: 'NOT_CREATED' });
  });

  it('a press while the first is on its way sends nothing', async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<{ job: never }>((res) => (release = () => res({ job: { id: 'j', state: 'sending' } as never }))));
    const it1 = item(review(), 'p2:meta');
    const first = sendLaunches([it1], { [it1.key]: 'a' }, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(await sendLaunches([it1], { [it1.key]: 'a' }, send)).toEqual([]);
    release();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('one platform failing doesn’t stop or retry the other', async () => {
    const send = vi.fn(async (t: string) => {
      if (t === 'bad') throw new AdsApiError(409, { error: 'Your ad limits changed since you reviewed this. Review it again.', code: 'LIMITS_CHANGED' });
      return { job: { id: 'j', kind: 'launch' as const, platform: 'google' as const, state: 'sending' as const, message: '', requestedAt: '' } };
    });
    const out = await sendLaunches([{ ...item(review(), 'p3:meta'), reviewToken: 'bad' }, item(review({ platform: 'google' }), 'p3:google')], {}, send);
    expect(out.map((o) => o.ok)).toEqual([false, true]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('the launch choices', () => {
  const project = { ...newProject('business', 'new'), id: 'proj1' };
  const plan = { ...newAdCampaign(project), id: 'ad1', platforms: ['meta', 'google'] as ('meta' | 'google')[], dailyBudget: 25 };

  it('PAUSED / ACTIVE has no default and blocks the review until picked', () => {
    const d = newDraft(plan, 'meta', 1);
    expect(d.status).toBe('');
    expect(draftProblems(d, { accountChosen: true })).toContain('Choose Paused or Active.');
    const html = renderToStaticMarkup(createElement(BudgetStep, { plan, draft: d, account: undefined, limits: undefined, split: null, twoPlatforms: false, onChange: () => {} }));
    expect(html).not.toMatch(/aria-checked="true"[^>]*>(Paused|Active)/);
    expect(html).toContain('Paused:');
    expect(html).toContain('spends nothing until you resume it');
  });

  it('two platforms start with empty amounts and a split line; one platform starts with the plan’s daily', () => {
    expect(newDraft(plan, 'meta', 2).daily).toBe('');
    expect(newDraft(plan, 'meta', 1).daily).toBe('25');
    const a = { ...newDraft(plan, 'meta', 2), daily: '15' };
    const b = { ...newDraft(plan, 'google', 2), daily: '15' };
    const s = splitLine([a, b], plan, () => 'USD');
    expect(s).toEqual({ text: 'Meta $15 + Google $15 = $30 a day (plan: $25)', over: true });
    expect(splitLine([a, b], plan, (p) => (p === 'meta' ? 'USD' : 'EUR'))).toBeNull();
    // both in EUR: the USD plan amount is never shown as euros or compared with them
    expect(splitLine([a, b], plan, () => 'EUR')).toEqual({ text: 'Meta €15 + Google €15 = €30 a day', over: false });
  });

  it('an account in another currency empties a prefilled amount (never converted)', () => {
    const d = newDraft(plan, 'meta', 1);
    expect(forCurrency(d, 'EUR').daily).toBe('');
    expect(forCurrency({ ...d, dailyTouched: true }, 'EUR').daily).toBe('25');
    expect(forCurrency(d, 'USD').daily).toBe('25');
  });

  it('a review is only good for exactly what was reviewed', () => {
    const d = { ...newDraft(plan, 'meta', 1), status: 'PAUSED' as const, specialCategory: 'none' as const };
    const key = requestKey(previewRequest(d, 'proj1', 'ad1'));
    const reviewed = { ...d, review: review(), reviewToken: 't', reviewedFor: key };
    expect(readyToConfirm(reviewed, 'proj1', 'ad1')).toBe(true);
    expect(readyToConfirm({ ...reviewed, daily: '30' }, 'proj1', 'ad1')).toBe(false);
    expect(readyToConfirm({ ...reviewed, review: review({ blockers: [{ code: 'NO_IMAGE', message: 'x' }] }) }, 'proj1', 'ad1')).toBe(false);
  });

  it('the planner’s buttons map to Meta’s values exactly as the server does', () => {
    expect(META_CTA).toEqual(CTA_MAP);
  });
});
