// The Whop stand-in itself: keys and permissions, pagination, idempotency, webhooks signed the way the server checks
// them, and two environments that share nothing.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockWhop } from './mock-whop.mjs';
import { parseEvent, verifyWhopSignature } from '../payments/whopWebhook.mjs';

const ALL = ['access_pass:basic:read', 'plan:basic:read', 'checkout_configuration:create', 'checkout_configuration:basic:read', 'payment:basic:read', 'member:email:read', 'developer:manage_webhook'];

describe('mock Whop', () => {
  let sandbox;
  let production;
  let receiver;
  let received = [];
  let hookUrl = '';
  beforeAll(async () => {
    sandbox = await createMockWhop({ environment: 'sandbox' }).start();
    production = await createMockWhop({ environment: 'production' }).start();
    sandbox.allowHttp = true;
    receiver = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, raw: Buffer.concat(chunks) });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
    sandbox.addKey('key_sandbox_0123456789abcdef', 'biz_sand1234', ALL);
    production.addKey('key_live_0123456789abcdef', 'biz_live1234', ALL);
    sandbox.seed('biz_sand1234', [{ title: 'Course', plans: [{ title: 'One time', initial_price: 49, currency: 'usd' }] }, { title: 'Second' }, { title: 'Third' }]);
  });
  afterAll(async () => {
    await sandbox.close();
    await production.close();
    await new Promise((r) => receiver.close(r));
  });

  const call = (mock, key, method, path, body, headers = {}) =>
    fetch(`${mock.apiBase}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }));

  it('needs a known key, the permission, and the key’s own account', async () => {
    expect((await call(sandbox, 'nope', 'GET', '/products?account_id=biz_sand1234')).status).toBe(401);
    expect((await call(sandbox, 'key_sandbox_0123456789abcdef', 'GET', '/products?account_id=biz_other1')).status).toBe(404);
    sandbox.addKey('key_noperm_0123456789abcdef', 'biz_sand1234', []);
    const r = await call(sandbox, 'key_noperm_0123456789abcdef', 'GET', '/variants?account_id=biz_sand1234');
    expect(r.status).toBe(403);
    // the code-only error shape Whop's docs show once
    expect(r.body.error).toEqual({ code: 'insufficient_scope', message: expect.any(String) });
  });

  it('pages with first/after', async () => {
    const a = await call(sandbox, 'key_sandbox_0123456789abcdef', 'GET', '/products?account_id=biz_sand1234&first=2');
    expect(a.body.data).toHaveLength(2);
    expect(a.body.page_info.has_next_page).toBe(true);
    const b = await call(sandbox, 'key_sandbox_0123456789abcdef', 'GET', `/products?account_id=biz_sand1234&first=2&after=${a.body.page_info.end_cursor}`);
    expect(b.body.data).toHaveLength(1);
    expect(b.body.page_info.has_next_page).toBe(false);
  });

  it('replays, refuses a changed body, and says when the first is still running', async () => {
    const plan = (await call(sandbox, 'key_sandbox_0123456789abcdef', 'GET', '/variants?account_id=biz_sand1234')).body.data[0];
    const body = { account_id: 'biz_sand1234', variant_id: plan.id, metadata: { ylb_offer: 'x'.repeat(22) } };
    const one = await call(sandbox, 'key_sandbox_0123456789abcdef', 'POST', '/checkout_configurations', body, { 'idempotency-key': 'k1' });
    expect(one.body.purchase_url).toBe(`https://sandbox.whop.com/checkout/${one.body.id}/`);
    const again = await call(sandbox, 'key_sandbox_0123456789abcdef', 'POST', '/checkout_configurations', body, { 'idempotency-key': 'k1' });
    expect(again.body.id).toBe(one.body.id);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await call(sandbox, 'key_sandbox_0123456789abcdef', 'POST', '/checkout_configurations', { ...body, metadata: {} }, { 'idempotency-key': 'k1' })).body.error.type).toBe('idempotency_key_mismatch');
    sandbox.hold();
    const first = call(sandbox, 'key_sandbox_0123456789abcdef', 'POST', '/checkout_configurations', body, { 'idempotency-key': 'k2' });
    await new Promise((r) => setTimeout(r, 50));
    expect((await call(sandbox, 'key_sandbox_0123456789abcdef', 'POST', '/checkout_configurations', body, { 'idempotency-key': 'k2' })).status).toBe(409);
    sandbox.release();
    expect((await first).status).toBe(200);
  });

  it('signs webhooks the way the server checks them, and production knows nothing of the sandbox', async () => {
    const hook = await call(sandbox, 'key_sandbox_0123456789abcdef', 'POST', '/webhooks', { url: hookUrl, events: ['payment.succeeded'], resource_id: 'biz_sand1234', api_version_date: '2026-08-14' });
    expect(hook.body.webhook_secret).toMatch(/^ws_/);
    expect((await call(sandbox, 'key_sandbox_0123456789abcdef', 'GET', `/webhooks/${hook.body.id}`)).body.webhook_secret).toBeUndefined();
    const ch = [...sandbox.checkouts.values()][0];
    received = [];
    const paid = await sandbox.pay({ checkoutId: ch.id });
    expect(paid.deliveries).toEqual([{ webhookId: hook.body.id, status: 200 }]);
    const got = received[0];
    expect(verifyWhopSignature(got.raw, got.headers, hook.body.webhook_secret)).toBe(true);
    expect(parseEvent(got.raw)).toMatchObject({ type: 'payment.succeeded', account: 'biz_sand1234', data: { metadata: { ylb_offer: 'x'.repeat(22) } } });
    await sandbox.deliver(paid.event.id, { sig: 'bad' });
    expect(verifyWhopSignature(received[1].raw, received[1].headers, hook.body.webhook_secret)).toBe(false);
    expect((await call(production, 'key_live_0123456789abcdef', 'GET', `/webhooks/${hook.body.id}`)).status).toBe(404);
    expect((await call(production, 'key_sandbox_0123456789abcdef', 'GET', '/products?account_id=biz_sand1234')).status).toBe(401);
  });

  it('fails, rate-limits and drops on request, and lists calls without the key', async () => {
    sandbox.rateLimit('GET /products');
    const r = await call(sandbox, 'key_sandbox_0123456789abcdef', 'GET', '/products?account_id=biz_sand1234');
    expect(r.status).toBe(429);
    expect(r.body.error.message).toBe('Try again in 12 seconds.');
    sandbox.fail('POST /webhooks', { timeout: true });
    await expect(call(sandbox, 'key_sandbox_0123456789abcdef', 'POST', '/webhooks', { url: hookUrl, events: [], resource_id: 'biz_sand1234' })).rejects.toThrow();
    // it was made all the same
    expect([...sandbox.webhooks.values()]).toHaveLength(2);
    expect(JSON.stringify(sandbox.calls)).not.toContain('key_sandbox');
  });
});
