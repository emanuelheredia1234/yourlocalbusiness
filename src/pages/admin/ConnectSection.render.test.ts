// Owner → Stripe Connect, drawn with fixed data: the setup checklist with what's missing, platform alerts in words
// with Mark resolved, our fees per currency, fee returns to check, sellers with the ones that need something first;
// never a Stripe id or a key; nothing in the claude.ai build.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { ConnectAdmin } from '@/lib/stripeConnect';
import { ConnectSection, ConnectView, alertWords, sortSellers } from './ConnectSection';

const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
const seller = (status: ConnectAdmin['accounts']['sellers'][number]['status'], email: string) => ({ customerTag: `cust_${email.slice(0, 3)}`, email, status, country: 'US', chargesEnabled: status === 'active', payoutsEnabled: status === 'active', dueNow: status === 'restricted' ? 2 : 0, last30: { count: 1, gross: { usd: 4900 }, fees: { usd: 147 } } });
const DATA: ConnectAdmin = {
  setup: { environment: 'production', missing: ['STRIPE_CONNECT_WEBHOOK_SECRET'], publicUrlOk: true, sellerTermsReady: false, termsVersion: 'v1', returnFees: true, connectEnabled: true, webhookLastAt: null },
  accounts: { counts: { active: 1, restricted: 1 }, sellers: [seller('active', 'ann@example.com'), seller('restricted', 'bo@example.com')] },
  fees: { currencies: { usd: { last30: { fees: 294, returned: 50, net: 244 }, monthToDate: { fees: 147, returned: 0, net: 147 } } }, returns: [{ sourceId: 're_1', state: 'unknown', amountMinor: 30, errorCode: null, createdAt: null }] },
  alerts: [{ kind: 'key_missing_connect_permission', count: 3, firstAt: null, lastAt: new Date().toISOString() }],
};

afterEach(() => vi.unstubAllGlobals());

describe('Owner › Stripe Connect', () => {
  it('the setup checklist: what’s done and what’s missing, and where the steps are', () => {
    const html = wrap(createElement(ConnectView, { data: DATA, error: null, onResolve: () => {} }));
    for (const t of ['Connect is on in Stripe', 'Connect webhook secret', 'APP_PUBLIC_URL is the app’s https address', 'Seller terms published']) expect(html).toContain(t);
    expect(html).toContain('Missing in Replit Secrets: STRIPE_CONNECT_WEBHOOK_SECRET');
    expect(html).toContain('docs/integrations-setup.md#16-stripe-connect-sellers-get-paid-p6');
    expect(html).toContain('Review the draft at /seller-terms');
  });

  it('platform alerts in words, with Mark resolved', () => {
    const html = wrap(createElement(ConnectView, { data: DATA, error: null, onResolve: () => {} }));
    expect(html).toContain('Add the Connect permissions to the restricted key');
    expect(html).toContain('3×');
    expect(html).toContain('Mark resolved');
    expect(alertWords('something_new')).toContain('something new');
  });

  it('our fees per currency, fee returns to check, sellers needing something first; no Stripe ids', () => {
    const html = wrap(createElement(ConnectView, { data: DATA, error: null, onResolve: () => {} }));
    expect(html).toContain('$1.47');
    expect(html).toContain('$2.44');
    expect(html).toContain('Not confirmed');
    expect(html.indexOf('bo@example.com')).toBeLessThan(html.indexOf('ann@example.com'));
    expect(html).toContain('Needs information');
    expect(html).not.toMatch(/acct_|sk_|rk_/);
    expect(sortSellers(DATA.accounts.sellers).map((s) => s.status)).toEqual(['restricted', 'active']);
  });

  it('nothing in the claude.ai build', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(wrap(createElement(ConnectSection))).toBe('');
  });
});
