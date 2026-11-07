// @vitest-environment happy-dom
// Cancel plan: one required reason, an optional comment, one fitting alternative per reason (never blocking), and the
// cancel sent once with an id made when the dialog opens (an unclear answer sends the same id again; a definite
// refusal makes a new one). Taking the alternative saves the answer and sends no cancel. Requests are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, subtitle, children, footer }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), createElement('p', null, subtitle), children, createElement('footer', null, footer)),
}));
const api = vi.hoisted(() => ({ cancelPlan: vi.fn(), keepPlanSurvey: vi.fn(), getPlan: vi.fn(() => new Promise(() => undefined)), getBusinesses: vi.fn(() => new Promise(() => undefined)) }));
vi.mock('@/lib/integrations/api', async (orig) => ({ ...(await orig<typeof import('@/lib/integrations/api')>()), ...api }));
const nav = vi.hoisted(() => ({ navigate: vi.fn(async () => true) }));
vi.mock('@/lib/router', async (orig) => ({ ...(await orig<typeof import('@/lib/router')>()), navigate: nav.navigate }));
const actions = vi.hoisted(() => ({ confirmPlanChange: vi.fn(async () => true), manageBilling: vi.fn(async () => true) }));
vi.mock('@/lib/billing/actions', async (orig) => ({ ...(await orig<typeof import('@/lib/billing/actions')>()), confirmPlanChange: actions.confirmPlanChange, manageBilling: actions.manageBilling }));

const { IntegrationApiError } = await import('@/lib/integrations/api');
const { CancelDialog, alternativeFor, REASONS } = await import('./CancelDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCT = (over: Record<string, unknown> = {}) => ({ tier: 'grow', interval: 'month', status: 'active', source: 'stripe', currentPeriodEnd: '2026-12-01T12:00:00Z', cancelAtPeriodEnd: false, trialEndsAt: null, graceUntil: null, extraBusinesses: 0, pendingRemove: null, pendingDowngrade: null, hasCustomer: true, ...over }) as never;

let host: HTMLDivElement;
let root: Root;
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(label)) as HTMLButtonElement | undefined;
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};
const pick = async (id: string) => click(host.querySelector(`input[type=radio][value="${id}"]`) as HTMLInputElement);
const open = async (account = ACCT(), onClose = vi.fn()) => {
  await act(async () => root.render(createElement(CancelDialog, { open: true, onClose, account })));
  return onClose;
};

beforeEach(() => {
  for (const f of [...Object.values(api), nav.navigate, actions.confirmPlanChange, actions.manageBilling]) f.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the alternatives', () => {
  it('one per reason: a cheaper plan, tips, tell us the feature; none for switching or other', () => {
    expect(alternativeFor('too_expensive', 'grow', 'month')).toMatchObject({ offer: 'cheaper_plan', title: 'Switch to Launch instead' });
    expect(alternativeFor('too_expensive', 'launch', 'month')).toMatchObject({ offer: 'tips' });
    for (const r of ['not_using', 'short_term', 'results', 'too_hard'] as const) expect(alternativeFor(r, 'grow', 'month')?.offer).toBe('tips');
    expect(alternativeFor('missing_feature', 'grow', 'month')?.offer).toBe('tell_feature');
    expect(alternativeFor('switching', 'grow', 'month')).toBeNull();
    expect(alternativeFor('other', 'grow', 'month')).toBeNull();
    expect(alternativeFor('', 'grow', 'month')).toBeNull();
    expect(REASONS).toHaveLength(8);
  });
});

describe('Cancel plan', () => {
  it('needs a reason; then one cancel with the dialog’s id, the comment and the offer shown', async () => {
    api.cancelPlan.mockResolvedValue({ ok: true, op: { id: 'o', kind: 'cancel', state: 'done' } });
    const onClose = await open();
    expect(button('Cancel plan')?.disabled).toBe(true);
    await pick('too_expensive');
    expect(host.textContent).toContain('Switch to Launch instead');
    expect(button('Cancel plan')?.disabled).toBe(false);
    await click(button('Cancel plan')!);
    expect(api.cancelPlan).toHaveBeenCalledTimes(1);
    expect(api.cancelPlan.mock.calls[0][0]).toMatchObject({ reason: 'too_expensive', offer: 'cheaper_plan', confirm: true });
    expect(api.cancelPlan.mock.calls[0][0].clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(onClose).toHaveBeenCalled();
  });

  it('an unclear answer keeps the id (the same cancel again, never a second); a definite refusal makes a new one', async () => {
    api.cancelPlan.mockRejectedValueOnce(new IntegrationApiError(503, { error: 'Try again in a minute.', code: 'BILLING_PENDING' }));
    await open();
    await pick('not_using');
    await click(button('Cancel plan')!);
    api.cancelPlan.mockRejectedValueOnce(new IntegrationApiError(400, { error: 'Bad.', code: 'BAD_REQUEST' }));
    await click(button('Cancel plan')!);
    api.cancelPlan.mockResolvedValueOnce({ ok: true, op: null });
    await click(button('Cancel plan')!);
    const ids = api.cancelPlan.mock.calls.map((c) => c[0].clientRequestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it('a change read back and not there (NOT_APPLIED) is definite: the next press is a new request, never stuck on the old one', async () => {
    api.cancelPlan.mockRejectedValueOnce(new IntegrationApiError(409, { error: 'That change didn’t go through. Try again.', code: 'NOT_APPLIED' }));
    await open();
    await pick('other');
    await click(button('Cancel plan')!);
    api.cancelPlan.mockResolvedValueOnce({ ok: true, op: { id: 'o', kind: 'cancel', state: 'done' } });
    await click(button('Cancel plan')!);
    const ids = api.cancelPlan.mock.calls.map((c) => c[0].clientRequestId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('after a failed payment it says the plan ends now and nothing more is charged', async () => {
    api.cancelPlan.mockResolvedValue({ ok: true, op: { id: 'o', kind: 'cancel', state: 'done' } });
    const onClose = await open(ACCT({ status: 'past_due', graceUntil: '2026-11-20T12:00:00Z' }));
    expect(host.textContent).toContain('Cancel your plan?');
    expect(host.textContent).toContain('your plan ends now and Stripe stops trying your card: nothing more is charged');
    await pick('too_expensive');
    await click(button('Cancel plan')!);
    expect(api.cancelPlan).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('before the server can cancel here (USE_PORTAL): the dialog closes and Stripe’s billing page opens', async () => {
    api.cancelPlan.mockRejectedValueOnce(new IntegrationApiError(409, { error: 'Cancelling here isn’t ready yet. Use Manage billing instead.', code: 'USE_PORTAL' }));
    const onClose = await open();
    await pick('other');
    await click(button('Cancel plan')!);
    expect(actions.manageBilling).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('a trial says nothing is charged; taking the alternative saves the answer and sends no cancel', async () => {
    api.keepPlanSurvey.mockResolvedValue({ ok: true });
    await open(ACCT({ status: 'trialing', trialEndsAt: '2026-11-20T12:00:00Z', currentPeriodEnd: '2026-11-20T12:00:00Z' }));
    expect(host.textContent).toContain('Cancel your free trial?');
    expect(host.textContent).toContain('Nothing is charged: your trial ends on Nov 20, 2026.');
    await pick('missing_feature');
    await act(async () => {
      const ta = host.querySelector('textarea') as HTMLTextAreaElement;
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(ta, 'Etsy listings');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Send and keep my plan')!);
    expect(api.keepPlanSurvey).toHaveBeenCalledWith({ reason: 'missing_feature', offer: 'tell_feature', outcome: 'kept', comment: 'Etsy listings' });
    expect(api.cancelPlan).not.toHaveBeenCalled();
  });

  it('a cheaper plan: the plan change asks first; the answer is kept as switched only when it went ahead', async () => {
    api.keepPlanSurvey.mockResolvedValue({ ok: true });
    actions.confirmPlanChange.mockResolvedValueOnce(false);
    await open(ACCT({ tier: 'scale' }));
    await pick('too_expensive');
    await click(button('Switch to Grow')!);
    expect(actions.confirmPlanChange).toHaveBeenCalledWith('grow', 'month');
    expect(api.keepPlanSurvey).not.toHaveBeenCalled();
    await click(button('Switch to Grow')!);
    expect(api.keepPlanSurvey).toHaveBeenCalledWith(expect.objectContaining({ reason: 'too_expensive', offer: 'cheaper_plan', outcome: 'switched' }));
    expect(api.cancelPlan).not.toHaveBeenCalled();
  });
});
