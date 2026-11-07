// @vitest-environment happy-dom
// Meta's review time in a real DOM: the per-ad review says it next to an ad "In review" (Meta only, campaign on), and a resume
// on Meta ends with a message that ads Meta hasn't approved yet are reviewed first (Google and pause say nothing).
// Every request is stubbed: nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, children, footer }: { title?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), children, createElement('footer', null, footer)),
}));
const reviewStatus = { value: 'in_review' as 'in_review' | 'approved' };
vi.mock('@/lib/ads/launchApi', async (orig) => {
  const real = await orig<typeof import('@/lib/ads/launchApi')>();
  return {
    ...real,
    getCampaignReview: vi.fn(async () => ({ review: { platform: 'meta', readAt: '2026-11-07T10:00:00Z', ads: [{ index: 0, status: reviewStatus.value, reasons: [] }] } })),
    previewChange: vi.fn(async (_id: string, req: { action: 'resume' | 'pause' }) => ({ review: changeReview(req.action), reviewToken: `tok-${req.action}` })),
    changeAds: vi.fn(async () => ({ job: { id: 'j-change', kind: 'change', platform: 'meta', state: 'sending', message: '', requestedAt: '' } })),
    followAdJob: vi.fn(async () => null),
  };
});

import type { ChangeReview, LaunchedCampaign } from '@/lib/ads/launchTypes';
import { META_IN_REVIEW, META_REVIEW_ON_RESUME } from '@/lib/ads/reviewTime';
const { ReviewStatus } = await import('./ReviewStatus');
const { ChangeConfirm } = await import('./ChangeConfirm');
const { useUI } = await import('@/store/ui');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const changeReview = (action: 'resume' | 'pause'): ChangeReview => ({
  action,
  platform: 'meta',
  confirmKind: action === 'resume' ? 'spend' : 'short',
  account: { name: 'Acme', idTail: '1234', currency: 'USD', timezone: 'America/Chicago' },
  current: { daily: 25, configured: 'PAUSED', spendCap: null, end: null, asOf: null, live: true },
  proposed: {},
  notes: [],
  blockers: [],
});
const camp = (over: Partial<LaunchedCampaign> = {}): LaunchedCampaign => ({
  id: 'c1',
  planId: 'ad1',
  projectId: 'proj1',
  platform: 'meta',
  name: 'Spring fixes',
  tag: 'YLB 0123456789ab',
  account: { name: 'Acme', idTail: '1234', currency: 'USD', timezone: 'America/Chicago' },
  state: 'paused',
  stateMessage: 'Paused: not spending.',
  review: { status: 'in_review', reasons: [] },
  daily: 25,
  start: '2026-12-01',
  end: '2026-12-14',
  launchedAs: 'PAUSED',
  configuredStatus: 'PAUSED',
  platformCampaignId: '120000',
  openInManagerUrl: 'https://business.facebook.com/adsmanager/manage/campaigns?act=1234',
  ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  useUI.setState({ toasts: [] });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const press = async (text: RegExp) => {
  const b = [...host.querySelectorAll('button')].find((x) => text.test(x.textContent ?? ''));
  expect(b, String(text)).toBeTruthy();
  await act(async () => b!.click());
  await settle();
};

describe('the review per ad', () => {
  it('says Meta’s review time next to an ad in review on a campaign that is on', async () => {
    reviewStatus.value = 'in_review';
    act(() => root.render(createElement(ReviewStatus, { c: camp({ state: 'in_review', configuredStatus: 'ACTIVE', launchedAs: 'ACTIVE' }) })));
    await press(/Read each ad/);
    expect(host.textContent).toContain('In review');
    expect(host.textContent).toContain(META_IN_REVIEW);
  });

  it('says nothing about it on a paused campaign: it doesn’t go live once approved', async () => {
    reviewStatus.value = 'in_review';
    act(() => root.render(createElement(ReviewStatus, { c: camp() })));
    await press(/Read each ad/);
    expect(host.textContent).toContain('In review');
    expect(host.textContent).not.toContain('10 minutes');
    expect(host.textContent).not.toContain('goes live');
  });

  it('says nothing about it once every ad is approved, or on Google', async () => {
    reviewStatus.value = 'approved';
    act(() => root.render(createElement(ReviewStatus, { c: camp({ state: 'active', configuredStatus: 'ACTIVE', launchedAs: 'ACTIVE' }) })));
    await press(/Read each ad/);
    expect(host.textContent).toContain('Approved');
    expect(host.textContent).not.toContain('10 minutes');
    reviewStatus.value = 'in_review';
    act(() => root.render(createElement(ReviewStatus, { key: 'g', c: camp({ platform: 'google', state: 'in_review', configuredStatus: 'ACTIVE', launchedAs: 'ACTIVE' }) })));
    await press(/Read each ad/);
    expect(host.textContent).toContain('In review');
    expect(host.textContent).not.toContain('10 minutes');
  });
});

describe('the message after a change', () => {
  const run = async (c: LaunchedCampaign, action: 'resume' | 'pause') => {
    let closed = false;
    act(() => root.render(createElement(ChangeConfirm, { c, action, onClose: () => (closed = true) })));
    await settle();
    const tick = host.querySelector<HTMLElement>('#cc-tick');
    expect(!!tick).toBe(action === 'resume');
    if (tick) await act(async () => tick.click());
    await press(action === 'resume' ? /Resume and spend/ : /^\s*Pause\s*$/);
    expect(closed, host.innerHTML).toBe(true);
    return useUI.getState().toasts;
  };

  it('a resume on Meta says ads Meta hasn’t approved yet are reviewed first, about 10 minutes', async () => {
    const toasts = await run(camp(), 'resume');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: 'success', title: 'Turning it on at Meta', body: META_REVIEW_ON_RESUME });
  });

  it('a resume on Google and a pause say nothing about review time', async () => {
    expect(await run(camp({ id: 'c2', platform: 'google' }), 'resume')).toHaveLength(0);
    act(() => root.render(createElement('div')));
    expect(await run(camp({ id: 'c3', state: 'active', configuredStatus: 'ACTIVE' }), 'pause')).toHaveLength(0);
  });
});
