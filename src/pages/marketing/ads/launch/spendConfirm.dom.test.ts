// @vitest-environment happy-dom
// The spend confirm and Check status in a real DOM: when one platform launches and the other gets no answer, the
// other's "may have happened" warning stays on screen (the window is reset only when it opens); a Check status button
// that has to wait comes back on by itself. Every request is stubbed: nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, children, footer }: { title?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), children, createElement('footer', null, footer)),
}));
vi.mock('@/lib/ads/launchApi', async (orig) => {
  const real = await orig<typeof import('@/lib/ads/launchApi')>();
  return {
    ...real,
    launchAds: vi.fn(async (token: string) => {
      if (token === 'tok-google') throw new real.AdsApiError(0, null);
      return { job: { id: 'j-meta', kind: 'launch', platform: 'meta', state: 'sending', message: '', requestedAt: '' } };
    }),
  };
});

const { SpendConfirm } = await import('./SpendConfirm');
const { CheckStatusButton } = await import('../campaigns/CampaignRow');
type Item = import('./SpendConfirm').LaunchItem;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

const review = (platform: 'meta' | 'google') => ({
  platform,
  account: { name: 'Acme', idTail: '1234', currency: 'USD', timezone: 'America/Chicago' },
  status: 'ACTIVE' as const,
  daily: 20,
  days: 7,
  plannedTotal: 140,
  start: '2026-12-01',
  startTime: null,
  asap: true,
  end: '2026-12-07',
  tz: 'America/Chicago',
  goal: 'traffic' as const,
  targeting: ['Austin'],
  leftOut: [],
  ads: [],
  claims: [],
  warnings: [],
  blockers: [],
  committedDailyAfter: 20,
  limitDaily: 50,
  linkUrl: 'https://acme.test',
  setup: [],
  ...(platform === 'meta' ? { spendCap: 140 } : {}),
});

function Host({ initial }: { initial: Item[] }) {
  const [items, setItems] = useState(initial);
  return createElement(SpendConfirm, { open: true, items, onClose: () => {}, onLaunched: (done) => setItems((list) => list.filter((i) => !done.some((d) => d.key === i.key))) });
}

describe('the spend confirm', () => {
  it('keeps the other platform’s “may have happened” warning when one platform launched', async () => {
    const items = [
      { key: 'p:meta', platform: 'meta', reviewToken: 'tok-meta', review: review('meta') },
      { key: 'p:google', platform: 'google', reviewToken: 'tok-google', review: review('google') },
    ] as unknown as Item[];
    act(() => root.render(createElement(Host, { initial: items })));
    const tick = host.querySelector<HTMLElement>('#spend-tick');
    act(() => tick!.click());
    const button = [...host.querySelectorAll('footer button')].at(-1) as HTMLButtonElement;
    await act(async () => button.click());
    await settle();
    expect(host.textContent).toMatch(/We may have started the launch on Google/);
    expect(host.textContent).toMatch(/check status before trying again/);
  });
});

describe('Check status', () => {
  it('comes back on by itself once the wait is over', async () => {
    act(() => root.render(createElement(CheckStatusButton, { jobId: 'j1', canCheckAt: new Date(Date.now() + 120).toISOString() })));
    const b = () => host.querySelector('button') as HTMLButtonElement;
    expect(b().disabled).toBe(true);
    await settle(260);
    expect(b().disabled).toBe(false);
  });
});
