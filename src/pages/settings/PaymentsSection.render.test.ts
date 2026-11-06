// Settings › Payments, drawn once per state (as on the server: no effects run). The key is never on the page:
// the server sends only its last 4 characters.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { WhopConnection, WhopEnvironment } from '@/lib/offers';
import { PaymentsView, type PaymentActions } from './PaymentsSection';

const noop = async () => null;
const actions: PaymentActions = { connect: noop, check: noop, replaceKey: noop, pasteSecret: async () => {}, enableWebhook: async () => {}, disconnect: async () => {} };
const CONN: WhopConnection = { id: 'CCCCCCCCCCCCCCCCCCCCCC', environment: 'production', accountId: 'biz_live1234', accountName: 'Acme', keyLast4: 'w9Zq', webhook: { mode: 'auto', state: 'ok' }, status: 'active', lastEventAt: null, checkedAt: null };
const render = (status: 'checking' | 'off' | 'signed-out' | 'ready', connections: WhopConnection[] | null, environment: WhopEnvironment = 'production') =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(PaymentsView, { status, connections, environment, onEnvironment: () => {}, actions })));

describe('Settings › Payments', () => {
  it('not connected: the three steps, the permissions, a password field, Connect', () => {
    const html = render('ready', []);
    expect(html).toContain('Whop');
    expect(html).toContain('access_pass:basic:read');
    expect(html).toContain('member:email:read');
    expect(html).toContain('developer:manage_webhook');
    expect(html).toMatch(/id="whop-production-key" type="password" autocomplete="off"/i);
    expect(html).toContain('biz_…');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Connect/);
    expect(html).not.toContain('Test mode uses Whop’s sandbox');
  });

  it('connected: account, the key’s last 4 only, receiving sales, the actions', () => {
    const html = render('ready', [CONN]);
    expect(html).toContain('biz_live1234');
    expect(html).toContain('…w9Zq');
    expect(html).toContain('Receiving sales');
    for (const b of ['Check again', 'Replace key', 'Disconnect']) expect(html).toContain(b);
    expect(html).toContain('Live · connected');
    expect(html).not.toContain('type="password"');
  });

  it('manual webhook: the address to copy, the events, a field for the secret', () => {
    const html = render('ready', [{ ...CONN, webhook: { mode: 'manual', state: 'missing', url: 'https://app.test/api/webhooks/whop/CCCCCCCCCCCCCCCCCCCCCC' } }]);
    expect(html).toContain('https://app.test/api/webhooks/whop/CCCCCCCCCCCCCCCCCCCCCC');
    expect(html).toContain('payment.succeeded');
    expect(html).toContain('dispute.updated');
    expect(html).toContain('Webhook secret');
    expect(html).toContain('Waiting for your webhook');
  });

  it('Whop turned the webhook off: says so, with Turn back on', () => {
    const html = render('ready', [{ ...CONN, webhook: { mode: 'auto', state: 'disabled' } }]);
    expect(html).toContain('Whop turned off sales updates');
    expect(html).toContain('Turn back on');
  });

  it('a rejected key: what to do', () => {
    const html = render('ready', [{ ...CONN, status: 'key_rejected' }]);
    expect(html).toContain('Whop no longer accepts this key');
  });

  it('Test mode: labelled everywhere, the sandbox card', () => {
    const html = render('ready', [{ ...CONN, environment: 'sandbox', accountId: 'biz_test1234' }], 'sandbox');
    expect(html).toContain('Test mode · connected');
    expect(html).toContain('Test mode uses Whop’s sandbox');
    expect(html).toMatch(/Test mode<\/span>/);
    expect(html).toContain('biz_test1234');
  });

  it('server off or signed out: no form', () => {
    expect(render('off', null)).toContain('Payments aren’t set up on this app’s server yet');
    expect(render('signed-out', null)).toContain('Sign in to connect your Whop account.');
    expect(render('off', null)).not.toContain('type="password"');
  });
});
