// The Campaigns tab: each state in plain words, an unknown outcome offers Check status and never "Try again",
// review reasons stay text (an injected <script> or markdown link is not markup), the limits strip, the audit
// list; the Manage drawer: Google's end date is off with the reason, and every action is off while a change is
// live; the change confirm sends one request and keeps its id after an uncertain answer.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';

vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, subtitle, children, footer }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), createElement('p', null, subtitle), children, createElement('footer', null, footer)),
  Drawer: ({ title, children }: { title?: ReactNode; children: ReactNode }) => createElement('aside', null, createElement('h2', null, title), children),
}));
const live = <S,>(store: { getState: () => S }) => Object.assign(<T,>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/adsLaunch', async (original) => {
  const real = await original<typeof import('@/store/adsLaunch')>();
  return { ...real, useAdsLaunch: live(real.useAdsLaunch) };
});

import type { AdJob, LaunchedCampaign } from '@/lib/ads/launchTypes';
import { AdsApiError } from '@/lib/ads/launchApi';
const { useAdsLaunch } = await import('@/store/adsLaunch');
const { CampaignsTab } = await import('./CampaignsTab');
const { CampaignRow, CampaignCard } = await import('./CampaignRow');
const { ManageActions } = await import('./ManageDrawer');
const { AuditList, auditCsv } = await import('./AuditLog');
const { manageActions, canLaunchAgain } = await import('./campaignView');
const { sendChange, changeRequestIdFor } = await import('./ChangeConfirm');
const { newProject } = await import('@/store/defaults');
const { safeFixUrl } = await import('@/lib/ads/launchFormat');

const job = (over: Partial<AdJob> = {}): AdJob => ({ id: 'j1', kind: 'launch', platform: 'meta', state: 'unknown', message: 'We don’t know yet whether Meta created this campaign. Nothing will be sent again by itself. It may have happened - check status before trying again.', requestedAt: '2026-11-06T10:00:00Z', ...over });
const camp = (over: Partial<LaunchedCampaign> = {}): LaunchedCampaign => ({
  id: 'c1',
  planId: 'ad1',
  projectId: 'proj1',
  platform: 'meta',
  name: 'Spring fixes',
  tag: 'YLB 0123456789ab',
  account: { name: 'Acme', idTail: '1234', currency: 'USD', timezone: 'America/Chicago' },
  state: 'active',
  stateMessage: 'Running',
  review: { status: 'approved', reasons: [] },
  daily: 25,
  start: '2026-12-01',
  end: '2026-12-14',
  launchedAs: 'ACTIVE',
  configuredStatus: 'ACTIVE',
  platformCampaignId: '120000',
  openInManagerUrl: 'https://business.facebook.com/adsmanager/manage/campaigns?act=1234',
  ...over,
});
const row = (c: LaunchedCampaign) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement('table', null, createElement('tbody', null, createElement(CampaignRow, { c, onManage: () => {}, onLaunchAgain: () => {} })))));
const project = { ...newProject('business', 'new'), id: 'proj1' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  useAdsLaunch.setState({ campaigns: {}, limits: {}, notes: {}, loading: {}, error: {}, refreshedAt: {}, checkNotes: {} });
});

describe('a campaign row', () => {
  it('says each state in plain words', () => {
    const cases: [Partial<LaunchedCampaign>, string][] = [
      [{ state: 'in_review', stateMessage: 'In review at Meta. It usually takes about 10 minutes (sometimes up to 24 hours) and goes live once approved. Nothing is spent until it’s approved.' }, 'In review'],
      [{ state: 'paused', configuredStatus: 'PAUSED', stateMessage: 'Approved and paused. Resume to start spending.' }, 'Paused'],
      [{ state: 'with_issues', stateMessage: 'Running, but Meta reports a delivery problem. Open Ads Manager to see it.' }, 'Running with limits'],
      [{ state: 'completed', stateMessage: 'Reached its $350.00 limit and stopped.' }, 'Finished'],
      [{ state: 'ended', stateMessage: 'Ended. It can’t be resumed from the app.' }, 'Ended'],
      [{ state: 'active', learning: 'FAIL' }, 'Running · Learning limited'],
    ];
    for (const [over, badge] of cases) {
      const html = row(camp(over));
      expect(html).toContain(badge);
      if (over.stateMessage) expect(html).toContain(over.stateMessage.replace(/’/g, '’'));
    }
    expect(row(camp())).toContain('$25.00');
  });

  it('unknown: Check status and Ads Manager, never “Try again”', () => {
    const html = row(camp({ state: 'unknown', pendingJob: job() }));
    expect(html).toContain('Check status');
    expect(html).toContain('It may have happened - check status before trying again.');
    expect(html).not.toMatch(/Try again|Launch again/);
  });

  it('a sending launch shows Launching…', () => {
    expect(row(camp({ state: 'launching', pendingJob: job({ state: 'sending' }) }))).toContain('Launching…');
  });

  it('rejected: the platform’s reasons as plain text, never markup or a link', () => {
    const html = row(camp({ state: 'rejected', stateMessage: 'Meta didn’t approve this ad.', review: { status: 'rejected', reasons: ['<script>alert(1)</script>', '[click](https://evil.example)'] } }));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="https://evil.example"');
    expect(html).toContain('Meta’s reason');
  });

  it('“Launch again” only after a definite “not created”', () => {
    const failed = camp({ state: 'failed', lastJob: job({ state: 'failed', code: 'NOT_CREATED', message: 'Meta didn’t create this campaign. Nothing is running. You can launch it again.' }) });
    expect(canLaunchAgain(failed)).toBe(true);
    expect(row(failed)).toContain('Launch again');
    expect(canLaunchAgain(camp({ state: 'unknown', pendingJob: job() }))).toBe(false);
  });

  it('a refused launch says why, that nothing was created, links Meta’s fix page, and offers Launch again; never “to see why”', () => {
    const failed = camp({ state: 'failed', stateMessage: 'Not launched.', platformCampaignId: undefined, openInManagerUrl: undefined, lastJob: job({ state: 'failed', code: 'PAYMENT_REQUIRED', message: 'Add a payment method in Meta Ads Manager (Billing). Meta bills your ads to it; this app never charges for ad spend. Nothing was created and no money was spent.', fixUrl: 'https://business.facebook.com/billing_hub/payment_settings' }) });
    const html = row(failed);
    expect(html).toContain('Nothing was created and no money was spent.');
    expect(html).toContain('href="https://business.facebook.com/billing_hub/payment_settings"');
    expect(html).toContain('Fix it');
    expect(html).toContain('Launch again');
    expect(html).not.toMatch(/to see why/);
    expect(html).not.toContain('’s message');
  });

  it('the live refusal of 6 Nov reads Meta’s 24-hour rule', () => {
    const msg = 'Meta needs a daily-budget ad to run more than 24 hours, and this one was set for less. Launch it again with at least 2 days. Nothing was created and no money was spent.';
    const html = row(camp({ state: 'failed', stateMessage: 'Not launched.', platformCampaignId: undefined, openInManagerUrl: undefined, lastJob: job({ state: 'failed', code: 'REFUSED', message: msg }) }));
    expect(html).toContain(msg);
    expect(html).toContain('Launch again');
  });

  it('a refusal the server has no sentence for shows Meta’s own words as escaped plain text, labelled, with no foreign link', () => {
    const says = '<script>alert(1)</script> [Fix it](https://evil.example) Use an image Meta can read.';
    const failed = camp({ state: 'failed', stateMessage: 'Not launched.', platformCampaignId: undefined, openInManagerUrl: undefined, lastJob: job({ state: 'failed', code: 'REFUSED', message: 'Meta refused the launch. Nothing was created and no money was spent.', platformSays: says, fixUrl: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fevil.example' }) });
    const html = row(failed);
    expect(html).toContain('Meta’s message: </span>“&lt;script&gt;alert(1)&lt;/script&gt; [Fix it](https://evil.example) Use an image Meta can read.”');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/href="https:\/\/(l\.facebook\.com|evil\.example)/);
    // the card (small screens) too
    const card = renderToStaticMarkup(createElement(TooltipProvider, null, createElement('ul', null, createElement(CampaignCard, { c: failed, onManage: () => {}, onLaunchAgain: () => {} }))));
    expect(card).toContain('&lt;script&gt;');
    expect(card).not.toContain('<script>');
  });

  it('a fix link goes only to Meta’s or Google’s own site (the server’s rule): never Zernio’s, a link shim or a look-alike', () => {
    for (const ok of ['https://business.facebook.com/billing_hub', 'https://www.meta.com/help/', 'https://ads.google.com/aw/billing']) expect(safeFixUrl(ok)).toBe(ok);
    for (const bad of ['https://docs.zernio.com/x', 'https://l.facebook.com/l.php?u=x', 'https://www.facebook.com/l.php?u=x', 'https://docs.google.com/d/1', 'https://facebook.com.evil.example/', 'http://www.facebook.com/x', 'javascript:alert(1)', undefined]) expect(safeFixUrl(bad), String(bad)).toBeNull();
  });

  it('a fix link goes to an exact list of hosts only: no other subdomain of Google, Facebook or Meta, no translator or redirector', () => {
    for (const ok of ['https://facebook.com/', 'https://www.facebook.com/business/help/422289316306981', 'https://adsmanager.facebook.com/adsmanager/manage/accounts?act=1', 'https://transparency.meta.com/policies', 'https://support.google.com/google-ads/answer/1']) expect(safeFixUrl(ok), ok).toBe(ok);
    for (const bad of [
      'https://translate.google.com/translate?u=https://evil.example/pay',
      'https://colab.research.google.com/drive/1',
      'https://lookerstudio.google.com/reporting/1',
      'https://www.google.com/maps/d/viewer?mid=1',
      'https://www.google.com/amp/s/evil.example/',
      'https://www.facebook.com/flx/warn/?u=https%3A%2F%2Fevil.example',
      'https://www.facebook.com/dialog/oauth?client_id=1',
      'https://business.facebook.com/settings?next=https%3A%2F%2Fevil.example',
      'https://m.facebook.com/x',
      'https://about.meta.com/x',
    ])
      expect(safeFixUrl(bad), bad).toBeNull();
    // and the card shows no link for one
    const html = row(camp({ state: 'failed', stateMessage: 'Not launched.', platformCampaignId: undefined, openInManagerUrl: undefined, lastJob: job({ state: 'failed', code: 'PAYMENT_REQUIRED', message: 'Add a payment method in Meta Ads Manager (Billing).', fixUrl: 'https://translate.google.com/translate?u=https://evil.example/pay' }) }));
    expect(html).not.toContain('Fix it');
    expect(html).not.toContain('translate.google.com');
  });

  it('a launch made but not switched on says why, with Meta’s words as plain text and Meta’s fix page', () => {
    const says = '<b>Budget</b> minimum is $1.00';
    const html = row(camp({ state: 'paused', stateMessage: 'Paused', configuredStatus: 'PAUSED', lastJob: job({ state: 'done', code: 'ACTIVATION_NOT_SENT', message: 'Created and paused, with its spending limit. We couldn’t switch it on: press Resume. Add a payment method in Meta Ads Manager (Billing).', platformSays: says, fixUrl: 'https://business.facebook.com/billing_hub/payment_settings' }) }));
    expect(html).toContain('We couldn’t switch it on: press Resume. Add a payment method in Meta Ads Manager (Billing).');
    expect(html).toContain('Meta’s message: </span>“&lt;b&gt;Budget&lt;/b&gt; minimum is $1.00”');
    expect(html).not.toContain('<b>Budget');
    expect(html).toContain('href="https://business.facebook.com/billing_hub/payment_settings"');
    expect(html).toContain('Fix it');
  });

  it('a refused change on a live campaign says why and links the fix too', () => {
    const html = row(camp({ lastJob: job({ kind: 'budget', state: 'failed', code: 'REFUSED', message: 'Meta refused this change. Nothing was changed.', platformSays: 'The budget must be at least $1.25.', fixUrl: 'https://www.facebook.com/business/help/1' }) }));
    expect(html).toContain('Meta refused this change. Nothing was changed.');
    expect(html).toContain('Meta’s message: </span>“The budget must be at least $1.25.”');
    expect(html).toContain('href="https://www.facebook.com/business/help/1"');
  });

  it('an Ads Manager link only to Meta’s or Google’s own host', () => {
    expect(row(camp())).toContain('href="https://business.facebook.com/adsmanager/manage/campaigns?act=1234"');
    expect(row(camp({ openInManagerUrl: 'https://evil.example/x' }))).not.toContain('evil.example');
  });
});

describe('the Campaigns tab', () => {
  it('shows the limits strip, the rows and who pays for spend', () => {
    useAdsLaunch.setState({
      campaigns: { proj1: [camp()] },
      limits: { proj1: { adsEnabled: true, currency: 'USD', maxDaily: 50, maxChange: 50, maxCampaignTotal: 750, launchesPerDay: 3, changesPerDay: 20, committedDaily: 25, liveCampaigns: 1, launchOpen: true } },
    });
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CampaignsTab, { project, onLaunchAgain: () => {} })));
    for (const t of ['Daily limit', '$50.00', 'Committed', '$25.00', 'Live campaigns', 'Spring fixes', 'Ad spend is billed by Meta to your own payment method. The app never charges you for it.', 'Refresh']) expect(html).toContain(t);
  });
  it('empty: nothing launched yet', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CampaignsTab, { project, onLaunchAgain: () => {} })));
    expect(html).toContain('Nothing launched yet');
  });
});

describe('the Manage drawer', () => {
  it('Google’s end date is off with the reason', () => {
    const a = manageActions(camp({ platform: 'google' })).find((x) => x.action === 'end_date')!;
    expect(a.enabled).toBe(false);
    expect(a.reason).toBe('Google doesn’t allow changing the dates after launch. Pause or end it instead.');
    const html = renderToStaticMarkup(createElement(ManageActions, { c: camp({ platform: 'google' }) }));
    expect(html).toContain('Google doesn’t allow changing the dates after launch.');
  });
  it('every action is off while a change is live; pause stays open otherwise', () => {
    const busy = manageActions(camp({ pendingJob: job({ kind: 'budget' }) }));
    expect(busy.every((a) => !a.enabled)).toBe(true);
    expect(busy[0].reason).toContain('Check its status first');
    const free = manageActions(camp());
    expect(free.find((a) => a.action === 'pause')?.enabled).toBe(true);
    expect(free.find((a) => a.action === 'resume')?.enabled).toBe(false);
  });
  it('an ended campaign offers no Resume', () => {
    expect(manageActions(camp({ state: 'ended' })).some((a) => a.action === 'resume')).toBe(false);
  });
});

describe('the audit list', () => {
  it('lists our own words, newest first as given, and exports a CSV', () => {
    const entries = [{ id: 2, at: '2026-11-06T10:01:00Z', campaignId: 'c1', actor: 'customer' as const, action: 'launch', summary: 'Launched on Meta (Acme …1234), PAUSED, $25.00/day: done', outcome: 'done' as const }];
    const html = renderToStaticMarkup(createElement(AuditList, { entries }));
    expect(html).toContain('Launched on Meta (Acme …1234)');
    expect(html).toContain('Done');
    expect(auditCsv(entries)).toContain('"Launched on Meta (Acme …1234), PAUSED, $25.00/day: done"');
  });

  it('a refused launch’s line says why, as text, with Meta’s fix page only', () => {
    const summary = 'Launched on Meta (Acme …1234), PAUSED, $1.00/day, Fri 6 Nov 2026 to Fri 6 Nov 2026: not done. Meta refused the launch. Nothing was created and no money was spent. Meta’s message: “<b>Use</b> an image Meta can read.”';
    const entries = [
      { id: 3, at: '2026-11-07T01:41:00Z', campaignId: 'c1', actor: 'customer' as const, action: 'launch', summary, outcome: 'failed' as const, fixUrl: 'https://www.facebook.com/ads/leadgen/tos' },
      { id: 4, at: '2026-11-07T01:42:00Z', campaignId: 'c1', actor: 'customer' as const, action: 'launch', summary: 'x', outcome: 'failed' as const, fixUrl: 'https://docs.zernio.com/x' },
    ];
    const html = renderToStaticMarkup(createElement(AuditList, { entries }));
    expect(html).toContain('Meta’s message: “&lt;b&gt;Use&lt;/b&gt; an image Meta can read.”');
    expect(html).toContain('href="https://www.facebook.com/ads/leadgen/tos"');
    expect(html).not.toContain('zernio');
    expect(html).toContain('Failed');
  });
});

describe('sending a change', () => {
  it('one request; an uncertain answer keeps the id and says it may have happened', async () => {
    const send = vi.fn(async () => {
      throw new AdsApiError(504, { code: 'UNAVAILABLE', error: 'gateway' });
    });
    const id = changeRequestIdFor('tok-9');
    const r = await sendChange('c9', 'budget', 'tok-9', id, send);
    expect(r).toMatchObject({ ok: false, uncertain: true });
    expect(r && !r.ok && r.message).toContain('It may have happened - check status before trying again.');
    expect(send).toHaveBeenCalledTimes(1);
    expect(changeRequestIdFor('tok-9')).toBe(id);
    // a new review (after Check status, or a new amount) never reuses the old id
    expect(changeRequestIdFor('tok-10')).not.toBe(id);
  });
  it('a replayed answer whose job failed is shown as failed, never closes as done', async () => {
    const send = vi.fn(async () => ({ replayed: true, job: { id: 'j9', kind: 'pause' as const, platform: 'meta' as const, state: 'failed' as const, code: 'NOT_CHANGED', message: 'Meta didn’t make this change. Nothing changed.', requestedAt: '' } }));
    const r = await sendChange('c7', 'pause', 'tok-7', 'id-7', send);
    expect(r).toMatchObject({ ok: false, uncertain: false, message: 'Meta didn’t make this change. Nothing changed.' });
  });
  it('a refusal is not uncertain and gets a fresh id next time', async () => {
    const send = vi.fn(async () => {
      throw new AdsApiError(409, { code: 'LIVE_CHANGED', error: 'This campaign was changed in Ads Manager since you looked. Review it again.' });
    });
    const r = await sendChange('c8', 'pause', 'tok-8', 'id-1', send);
    expect(r).toMatchObject({ ok: false, uncertain: false });
    expect(changeRequestIdFor('tok-8')).not.toBe('id-1');
  });
});
