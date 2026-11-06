// The owner's customer usage page and the user's own usage card, drawn with fixed data: the reconcile
// Callout (match and mismatch), the customer table and caps, estimated costs labelled, and the header's
// single filled action.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { CustomerUsage, CustomerUsageRow, ReconcileReport } from '@/lib/integrations/types';
import { BillingView, ReconcileCallout, recentMonths, usd } from './Billing';
import Billing from './Billing';
import { UsageView, usd4 } from '@/pages/settings/UsageSection';

const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));

const ROWS: CustomerUsageRow[] = [
  { customerTag: 'cust_aaaaaaaaaaaaaaaaaaaaaaaa', email: 'joe@example.com', costMicro: 1_250_000, estimatedMicro: 290_000, calls: 120, todayMicro: 40_000, caps: {}, status: 'active', lastActivityAt: new Date().toISOString() },
  { customerTag: 'cust_bbbbbbbbbbbbbbbbbbbbbbbb', email: 'ann@example.com', costMicro: 0, estimatedMicro: 0, calls: 0, todayMicro: 0, caps: { dailyCapMicro: 100_000 }, status: 'blocked', syncedToTreg: false },
];
const DATA = { customers: ROWS, defaults: { dailyCapMicro: 250_000, monthlyCapMicro: 3_000_000, callsPerDay: 400, syncedToTreg: true } };
const OK: ReconcileReport = { days: 30, treg: { attributedMicro: 1_250_000, unattributedMicro: 0, totalMicro: 1_250_000, sumOk: true }, rows: [], unattributedOk: true, mismatches: 0, checkedAt: new Date().toISOString() };

afterEach(() => vi.unstubAllGlobals());

describe('the reconcile Callout', () => {
  it('match: “Ledger matches treg: attributed + unattributed = total ($1.25)”', () => {
    const html = wrap(createElement(ReconcileCallout, { report: OK }));
    expect(html).toContain('Ledger matches treg: attributed + unattributed = total ($1.25)');
    expect(html).toContain('bg-good-soft');
  });
  it('mismatch: the count and the unattributed amount, in red', () => {
    const html = wrap(createElement(ReconcileCallout, { report: { ...OK, treg: { ...OK.treg, unattributedMicro: 30_000 }, unattributedOk: false, mismatches: 2, pending: [{ customerTag: 'cust_x', callId: 'c', at: '' }] } }));
    expect(html).toContain('2 customers differ');
    expect(html).toContain('unattributed $0.03');
    expect(html).toContain('still settling');
    expect(html).toContain('bad');
  });
});

describe('the page', () => {
  it('totals, the customer table, caps and status, with estimated costs labelled', () => {
    const html = wrap(createElement(BillingView, { data: DATA, report: OK, onEdit: () => {}, onChanged: () => {} }));
    for (const t of ['joe@example.com', 'ann@example.com', '$1.25', '+$0.29 est.', 'Blocked', 'Active', 'Not synced', 'Own', 'Estimated connection costs', 'Default caps', '$0.25', '$3.00', 'Ledger matches treg']) expect(html).toContain(t);
    // nothing on this page is a filled button besides the header’s Download CSV
    expect(html).not.toContain('btn-primary');
  });
  it('Upload-Post and Zernio next to the others: accounts, profiles (one per business), calls and estimates per customer, profiles used of the plan, its alert in plain words', () => {
    const rows: CustomerUsageRow[] = [
      { ...ROWS[0], socialAccounts: 3, socialProfiles: 2, adAccounts: 1, connectedAccounts: 4, vendors: { treg: { costMicro: 1_250_000, estimatedMicro: 0, calls: 120 }, uploadpost: { costMicro: 0, estimatedMicro: 3_920_000, calls: 14 }, zernio: { costMicro: 0, estimatedMicro: 290_000, calls: 0 } } },
      ROWS[1],
    ];
    const html = wrap(createElement(BillingView, { data: { ...DATA, customers: rows, upProfiles: { used: 12, limit: 75, perCustomer: 3 }, uploadPostAlert: { kind: 'profile_cap_low', at: new Date().toISOString() } }, report: null, onEdit: () => {}, onChanged: () => {} }));
    for (const t of ['Social (Upload-Post)', 'Ads (Zernio)', '3 accts', '2 profiles · 14 calls · +$3.92 est.', '1 acct', '+$0.29 est.', 'Upload-Post profiles', '12 / 75', 'Social posting needs attention', 'Upload-Post profiles are running low']) expect(html).toContain(t);
    // a customer at their limit of businesses: which one, in plain words
    const cap = wrap(createElement(BillingView, { data: { ...DATA, uploadPostAlert: { kind: 'profile_user_cap', at: '', customerTag: 'cust_aaaaaaaaaaaaaaaaaaaaaaaa' } }, report: null, onEdit: () => {}, onChanged: () => {} }));
    expect(cap).toContain('UPLOAD_POST_MAX_PROFILES_PER_USER');
    expect(cap).toContain('Customer cust_aaaaaaaaaaaaaaaaaaaaaaaa.');
    // an alert kind this page doesn't know still reads in plain words, never the raw kind
    const other = wrap(createElement(BillingView, { data: { ...DATA, uploadPostAlert: { kind: 'something_new', at: '' } }, report: null, onEdit: () => {}, onChanged: () => {} }));
    expect(other).toContain('Check the Upload-Post dashboard.');
    expect(other).not.toContain('something_new');
  });
  it('carries the section ids Settings › Owner links to (overview, Plans, Ad limits)', () => {
    const html = wrap(createElement(BillingView, { data: DATA, report: null, onEdit: () => {}, onChanged: () => {} }));
    for (const id of ['owner-billing-overview', 'owner-plans', 'owner-ad-limits']) expect(html).toContain(`id="${id}"`);
  });

  it('the treg alert shows no amounts', () => {
    const html = wrap(createElement(BillingView, { data: { ...DATA, alert: { kind: 'insufficient_balance', at: '' } }, report: null, onEdit: () => {}, onChanged: () => {} }));
    expect(html).toContain('Analytics provider needs attention (billing).');
    expect(html).not.toMatch(/balance_micro|topup/);
  });
  it('the header (loading): one filled button at most, and the plain InfoTip', () => {
    const html = wrap(createElement(Billing));
    expect(html).toContain('Customer usage');
    expect((html.match(/btn-primary/g) ?? []).length).toBeLessThanOrEqual(1);
  });
  it('the artifact build: needs the full app', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(wrap(createElement(Billing))).toContain('Customer usage needs the full app');
  });
  it('months for the CSV and money from micros', () => {
    expect(recentMonths(new Date('2026-11-05T00:00:00Z'), 3)).toEqual(['2026-11', '2026-10', '2026-09']);
    expect(usd(1_250_000)).toBe('$1.25');
    expect(usd(4_000)).toBe('$0.0040');
  });
});

describe('the user’s own usage (Settings)', () => {
  const U: CustomerUsage = {
    today: { costMicro: 21_000, calls: 4 },
    month: { costMicro: 410_000, calls: 80 },
    caps: { dailyCapMicro: 250_000, monthlyCapMicro: 3_000_000, status: 'active' },
    byFeature: [{ feature: 'social', costMicro: 300_000, calls: 60 }],
    recent: [{ at: new Date().toISOString(), feature: 'social', label: 'Instagram profile', costMicro: 10_000, estimated: false }, { at: new Date().toISOString(), feature: 'posting', label: 'X post', costMicro: 15_000, estimated: true }],
  };
  it('“Analytics data costs” in USD with 4 decimals, caps, and estimated rows labelled', () => {
    const html = wrap(createElement(UsageView, { usage: U, error: null }));
    for (const t of ['Analytics data costs', '$0.0210 of $0.2500', '$0.4100 of $3.0000', 'Social stats', 'Instagram profile', 'estimated']) expect(html).toContain(t);
    expect(usd4(1)).toBe('$0.0000');
  });
  it('blocked, loading and error', () => {
    expect(wrap(createElement(UsageView, { usage: { ...U, caps: { ...U.caps, status: 'blocked' } }, error: null }))).toContain('Analytics are paused for your account. Contact support.');
    expect(wrap(createElement(UsageView, { usage: null, error: null }))).toContain('skeleton');
    expect(wrap(createElement(UsageView, { usage: null, error: 'Couldn’t load your usage.' }))).toContain('Couldn’t load your usage.');
  });
});
