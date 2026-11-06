// Connecting a user's own Whop account (spec tests 3, 6, 7): the key checked with reads, sealed and bound to its row,
// the webhook made once (or left to the owner), sandbox and production apart, nothing secret in a log or an answer,
// and no Whop write ever sent twice by itself.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPaymentCrypto } from '../offers/store.mjs';
import { ALL_PERMISSIONS, PAYMENT_SECRET, offersServer } from '../offers/test-helpers.mjs';

describe('Whop connection', () => {
  let h;
  beforeAll(async () => {
    h = await offersServer();
  });
  afterAll(() => h.close());

  it('connects: reads first, the key sealed and bound to its row, the webhook made with its own idempotency key', async () => {
    const s = await h.seller('auto@example.com');
    expect(s.connect.status).toBe(200);
    expect(s.connection).toMatchObject({ environment: 'production', accountId: s.accountId, keyLast4: s.whopKey.slice(-4), webhook: { mode: 'auto', state: 'ok' }, status: 'active' });
    expect(JSON.stringify(s.connect.body)).not.toContain(s.whopKey);
    const calls = s.mock.calls.filter((c) => c.idempotencyKey === `ylb-whop-webhook-${s.connection.id}`);
    expect(calls).toHaveLength(1);
    // the reads came before the write
    const order = s.mock.calls.map((c) => c.route);
    expect(order.indexOf('GET /products')).toBeLessThan(order.indexOf('POST /webhooks'));
    const row = h.rows('payment_connections').find((r) => r.id === s.connection.id);
    expect(row.key_ciphertext).not.toContain(s.whopKey);
    const pc = createPaymentCrypto(PAYMENT_SECRET);
    expect(pc.openKey(row.user_id, row.id, row.key_ciphertext)).toBe(s.whopKey);
    const hook = [...s.mock.webhooks.values()].find((w) => w.id === row.webhook_id);
    expect(pc.openWebhook(row.user_id, row.id, row.webhook_secret_ciphertext)).toBe(hook.secret);
    expect(hook.url).toBe(`https://app.example.test/api/webhooks/whop/${row.id}`);
    expect(hook.api_version_date).toBe('2026-08-14');
    // bound to its row: copied to another connection id or user, it doesn't open
    expect(() => pc.openKey(row.user_id, 'X'.repeat(22), row.key_ciphertext)).toThrow();
    expect(() => pc.openWebhook('00000000-0000-4000-8000-000000000000', row.id, row.webhook_secret_ciphertext)).toThrow();
    const list = await h.call(s.who, 'GET', '/api/payments/whop');
    expect(list.body.connections).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/ciphertext|ws_|hook_/);
  });

  it('refuses a bad key, names a missing permission, and a key from another account', async () => {
    const who = await h.user('bad@example.com');
    const bad = await h.call(who, 'POST', '/api/payments/whop', { environment: 'production', accountId: 'biz_nobody123', key: 'whop_wrong_key_0123456789abcdef' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('WHOP_KEY_REJECTED');
    h.production.addKey('whop_noplans_0123456789abcdef', 'biz_noplans1', ['access_pass:basic:read']);
    const perm = await h.call(who, 'POST', '/api/payments/whop', { environment: 'production', accountId: 'biz_noplans1', key: 'whop_noplans_0123456789abcdef' });
    expect(perm.body).toMatchObject({ code: 'WHOP_PERMISSION', missing: 'plan:basic:read' });
    const other = await h.call(who, 'POST', '/api/payments/whop', { environment: 'production', accountId: 'biz_someoneelse', key: 'whop_noplans_0123456789abcdef' });
    expect(other.body.code).toBe('WHOP_ACCOUNT');
    expect(h.rows('payment_connections').filter((r) => r.user_id === who.id)).toHaveLength(0);
    const shape = await h.call(who, 'POST', '/api/payments/whop', { environment: 'live', accountId: 'biz_x', key: 'k' });
    expect(shape.status).toBe(400);
  });

  it('a key that can’t manage webhooks: manual mode with the URL to copy', async () => {
    const s = await h.seller('manual@example.com', { permissions: ALL_PERMISSIONS.filter((p) => p !== 'developer:manage_webhook') });
    expect(s.connect.body.notice).toBe('WEBHOOK_MANUAL');
    expect(s.connection.webhook).toEqual({ mode: 'manual', state: 'missing', url: `https://app.example.test/api/webhooks/whop/${s.connection.id}` });
    const pasted = await h.call(s.who, 'POST', `/api/payments/whop/${s.connection.id}/webhook-secret`, { secret: 'ws_pasted_secret_0123456789' });
    expect(pasted.body.connection.webhook).toMatchObject({ mode: 'manual', state: 'unknown' });
  });

  it('a webhook whose outcome is unknown is never sent again; "Check again" finds ours by its URL', async () => {
    h.production.fail('POST /webhooks', { timeout: true });
    const s = await h.seller('unknown@example.com');
    expect(s.connect.body.notice).toBe('WEBHOOK_UNCONFIRMED');
    expect(s.connection.webhook).toMatchObject({ mode: 'auto', state: 'unknown' });
    const check = await h.call(s.who, 'POST', `/api/payments/whop/${s.connection.id}/check`);
    expect(check.status).toBe(200);
    expect(check.body.notice).toBe('WEBHOOK_MADE_WITHOUT_SECRET');
    expect(check.body.connection.webhook.mode).toBe('manual');
    expect(s.mock.calls.filter((c) => c.idempotencyKey === `ylb-whop-webhook-${s.connection.id}`)).toHaveLength(1);
  });

  it('one live connection per environment; sandbox and production stay apart', async () => {
    const s = await h.seller('twice@example.com');
    const again = await h.call(s.who, 'POST', '/api/payments/whop', { environment: 'production', accountId: s.accountId, key: s.whopKey });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_CONNECTED');
    // a production key means nothing in the sandbox
    const sb = await h.call(s.who, 'POST', '/api/payments/whop', { environment: 'sandbox', accountId: s.accountId, key: s.whopKey });
    expect(sb.body.code).toBe('WHOP_KEY_REJECTED');
    h.sandbox.addKey('whop_sandbox_twice_0123456789', 'biz_sandtwice', ALL_PERMISSIONS);
    const ok = await h.call(s.who, 'POST', '/api/payments/whop', { environment: 'sandbox', accountId: 'biz_sandtwice', key: 'whop_sandbox_twice_0123456789' });
    expect(ok.status).toBe(200);
    expect(ok.body.connection.environment).toBe('sandbox');
    expect([...h.production.webhooks.values()].some((w) => w.resource_id === 'biz_sandtwice')).toBe(false);
  });

  it('replace key, enable a webhook Whop turned off (once), and disconnect pausing its offers', async () => {
    const s = await h.seller('cycle@example.com');
    const row = () => h.rows('payment_connections').find((r) => r.id === s.connection.id);
    s.mock.disable(row().webhook_id);
    const checked = await h.call(s.who, 'POST', `/api/payments/whop/${s.connection.id}/check`);
    expect(checked.body.connection.webhook.state).toBe('disabled');
    s.mock.fail('PATCH /webhooks/:id', { status: 503 });
    const failed = await h.call(s.who, 'POST', `/api/payments/whop/${s.connection.id}/enable-webhook`);
    expect(failed.body.code).toBe('WHOP_UNCONFIRMED');
    expect(s.mock.writes('PATCH /webhooks/:id')).toHaveLength(1);
    const on = await h.call(s.who, 'POST', `/api/payments/whop/${s.connection.id}/enable-webhook`);
    expect(on.body.connection.webhook.state).toBe('ok');
    const newKey = `${s.whopKey}_v2`;
    s.mock.addKey(newKey, s.accountId, ALL_PERMISSIONS);
    const replaced = await h.call(s.who, 'PUT', `/api/payments/whop/${s.connection.id}/key`, { key: newKey });
    expect(replaced.body.connection.keyLast4).toBe(newKey.slice(-4));
    const offer = await h.whopOffer(s);
    expect(offer.status).toBe(200);
    const refused = await h.call(s.who, 'DELETE', `/api/payments/whop/${s.connection.id}`);
    expect(refused.body).toMatchObject({ code: 'OFFERS_LIVE', count: 1 });
    const gone = await h.call(s.who, 'DELETE', `/api/payments/whop/${s.connection.id}?confirm=1`);
    expect(gone.body).toMatchObject({ ok: true, paused: 1 });
    expect(row()).toMatchObject({ status: 'disconnected', key_ciphertext: '', webhook_secret_ciphertext: null });
    expect(h.rows('offers').find((o) => o.id === offer.body.offer.id).status).toBe('paused');
    expect(s.mock.writes('DELETE /webhooks/:id')).toHaveLength(1);
    expect(s.mock.webhooks.size).toBeGreaterThan(0);
  });

  it('another user can’t see or touch a connection', async () => {
    const s = await h.seller('owner2@example.com');
    const other = await h.user('intruder@example.com');
    for (const [m, p] of [['POST', `/check`], ['POST', '/enable-webhook'], ['GET', '/products'], ['DELETE', '']]) {
      const r = await h.call(other, m, `/api/payments/whop/${s.connection.id}${p}`);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect((await h.call(other, 'GET', '/api/payments/whop')).body.connections).toEqual([]);
    expect((await h.call(null, 'GET', '/api/payments/whop')).status).toBe(401);
  });
});

describe('secrets never leak', () => {
  let h;
  const spies = [];
  beforeAll(async () => {
    h = await offersServer();
  });
  afterAll(() => h.close());
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it('a whole connect, sale and failure run: no key, no ws_ secret, no buyer email in any log line or answer', async () => {
    const lines = [];
    for (const m of ['log', 'warn', 'error', 'info']) spies.push(vi.spyOn(console, m).mockImplementation((...a) => lines.push(a.map(String).join(' '))));
    const s = await h.seller('leak@example.com');
    const bodies = [JSON.stringify(s.connect.body)];
    const offer = await h.whopOffer(s);
    bodies.push(JSON.stringify(offer.body));
    const ch = h.rows('offers').find((o) => o.id === offer.body.offer.id).provider_ref.checkoutId;
    await s.mock.pay({ checkoutId: ch, email: 'secret.buyer@example.com' });
    s.mock.fail('POST /checkout_configurations', { status: 422 });
    bodies.push(JSON.stringify((await h.whopOffer(s)).body));
    bodies.push(JSON.stringify((await h.call(s.who, 'POST', '/api/payments/whop', { environment: 'production', accountId: s.accountId, key: 'whop_bad_key_for_leak_test_0000' })).body));
    bodies.push(JSON.stringify((await h.call(s.who, 'GET', '/api/offers?projectId=p1')).body));
    const secret = [...s.mock.webhooks.values()].find((w) => w.resource_id === s.accountId).secret;
    const all = [...lines, ...h.logs].join('\n');
    for (const needle of [s.whopKey, secret, 'secret.buyer@example.com', 'whop_bad_key_for_leak_test_0000']) {
      expect(all).not.toContain(needle);
      for (const b of bodies) expect(b).not.toContain(needle);
    }
    // the email is the owner's own: only their sale list shows it
    const sales = await h.call(s.who, 'GET', '/api/offers/sales?projectId=p1');
    expect(sales.body.sales[0].buyerEmail).toBe('secret.buyer@example.com');
  });
});

describe('a Whop plan’s price', () => {
  it('a bare price in a zero-decimal currency is whole yen: ¥1000 shows ¥1,000, never ¥100,000', async () => {
    const { planOut } = await import('./whop.mjs');
    const p = planOut({ id: 'plan_yen1234', title: 'Lifetime', initial_price: 1000, currency: 'jpy' });
    expect(p.price).toEqual({ minor: 1000, currency: 'jpy', display: '¥1,000' });
    expect(planOut({ id: 'plan_usd1234', title: 'Lifetime', initial_price: 49, currency: 'usd' }).price).toEqual({ minor: 4900, currency: 'usd', display: '$49' });
  });
});
