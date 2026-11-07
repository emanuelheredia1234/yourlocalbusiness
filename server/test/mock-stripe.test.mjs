// Self-test of the Stripe stand-in (server/test/mock-stripe.mjs): what later phases build on (plans, extra businesses,
// the portal, webhooks, Connect sellers) answers the way Stripe does. Nothing leaves the machine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createMockStripe, encodeForm, parseForm, signStripeHeader, TEST_STRIPE_KEY, TEST_STRIPE_WEBHOOK_SECRET, verifyStripeHeader } from './mock-stripe.mjs';

let mock;
let hook;
const received = [];

beforeAll(async () => {
  // a webhook endpoint that checks every delivery's signature, as the app's will
  hook = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const ok = verifyStripeHeader(raw, req.headers['stripe-signature'], TEST_STRIPE_WEBHOOK_SECRET);
      received.push({ ok, event: JSON.parse(raw) });
      res.writeHead(ok ? 200 : 400);
      res.end();
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  mock = await createMockStripe({ webhookUrl: `http://127.0.0.1:${hook.address().port}/api/webhooks/stripe` }).start();
});

afterAll(async () => {
  await mock?.close();
  await new Promise((r) => hook.close(r));
});

/** A Stripe call: form body, bearer, optional Idempotency-Key and Stripe-Account. */
async function stripe(method, path, params, { key = TEST_STRIPE_KEY, idem, account } = {}) {
  const headers = { authorization: `Bearer ${key}` };
  if (idem) headers['idempotency-key'] = idem;
  if (account) headers['stripe-account'] = account;
  let url = `${mock.apiBase}${path}`;
  let body;
  if (method === 'GET' && params) url += `?${encodeForm(params)}`;
  else if (params) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = encodeForm(params);
  }
  const res = await fetch(url, { method, headers, body });
  return { status: res.status, body: await res.json(), replayed: res.headers.get('idempotent-replayed') === 'true' };
}

async function plan(lookupKey, amount, interval = 'month') {
  const product = (await stripe('POST', '/v1/products', { name: lookupKey })).body;
  return (await stripe('POST', '/v1/prices', { product: product.id, currency: 'usd', unit_amount: amount, lookup_key: lookupKey, recurring: { interval } })).body;
}

describe('mock-stripe', () => {
  it('encodes and parses Stripe’s bracket form', () => {
    const obj = { line_items: [{ price: 'price_1', quantity: 2 }], metadata: { user: 'u1' }, expand: ['subscription'] };
    expect(parseForm(encodeForm(obj))).toEqual({ line_items: [{ price: 'price_1', quantity: '2' }], metadata: { user: 'u1' }, expand: ['subscription'] });
    expect(parseForm('expand[]=a&expand[]=b')).toEqual({ expand: ['a', 'b'] });
  });

  it('signs webhooks the way Stripe’s libraries verify them', () => {
    const payload = '{"id":"evt_1"}';
    const header = signStripeHeader(payload, 'whsec_x', 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyStripeHeader(payload, header, 'whsec_x', 300, 1_700_000_100_000)).toBe(true);
    expect(verifyStripeHeader(payload, header, 'whsec_other', 300, 1_700_000_100_000)).toBe(false);
    expect(verifyStripeHeader(`${payload} `, header, 'whsec_x', 300, 1_700_000_100_000)).toBe(false);
    // too old
    expect(verifyStripeHeader(payload, header, 'whsec_x', 300, 1_700_000_400_000)).toBe(false);
    const s = mock.signed('invoice.paid', { id: 'in_1' });
    expect(verifyStripeHeader(s.raw, s.header)).toBe(true);
  });

  it('refuses a wrong key', async () => {
    const r = await stripe('GET', '/v1/customers', null, { key: 'sk_test_wrong' });
    expect(r.status).toBe(401);
    expect(r.body.error.type).toBe('invalid_request_error');
  });

  it('finds prices by lookup_key, and moves a lookup key only with transfer_lookup_key', async () => {
    const launch = await plan('launch_monthly', 9700);
    await plan('launch_annual', 97000, 'year');
    const found = await stripe('GET', '/v1/prices', { lookup_keys: ['launch_monthly', 'launch_annual'] });
    expect(found.body.data.map((p) => p.lookup_key).sort()).toEqual(['launch_annual', 'launch_monthly']);
    expect(found.body.data.find((p) => p.lookup_key === 'launch_monthly')).toMatchObject({ id: launch.id, unit_amount: 9700, recurring: { interval: 'month' } });
    const dup = await stripe('POST', '/v1/prices', { product: launch.product, currency: 'usd', unit_amount: 9900, lookup_key: 'launch_monthly', recurring: { interval: 'month' } });
    expect(dup.status).toBe(400);
    const moved = await stripe('POST', '/v1/prices', { product: launch.product, currency: 'usd', unit_amount: 9900, lookup_key: 'launch_monthly', transfer_lookup_key: true, recurring: { interval: 'month' } });
    expect(moved.status).toBe(200);
    expect((await stripe('GET', `/v1/prices/${launch.id}`)).body.lookup_key).toBeNull();
  });

  it('customer → Checkout (two items) → subscription, with signed webhooks; quantity changes; portal', async () => {
    const tier = await plan('grow_monthly', 19700);
    const extra = await plan('extra_business_monthly', 9700);
    const customer = (await stripe('POST', '/v1/customers', { email: 'owner@example.com', metadata: { user_id: 'u1' } })).body;
    expect((await stripe('GET', '/v1/customers', { email: 'owner@example.com' })).body.data[0].id).toBe(customer.id);
    const session = await stripe('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer: customer.id,
      client_reference_id: 'u1',
      success_url: 'https://app.example/#plans?ok=1',
      cancel_url: 'https://app.example/#plans',
      line_items: [
        { price: tier.id, quantity: 1 },
        { price: extra.id, quantity: 2 },
      ],
      subscription_data: { metadata: { user_id: 'u1' } },
    });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ object: 'checkout.session', status: 'open', mode: 'subscription', client_reference_id: 'u1', amount_total: 19700 + 2 * 9700 });
    expect(session.body.url).toContain(mock.base);

    received.length = 0;
    const done = await (await fetch(`${mock.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: session.body.id }) })).json();
    expect(done.session).toMatchObject({ status: 'complete', payment_status: 'paid' });
    const sub = done.subscription;
    expect(sub).toMatchObject({ status: 'active', customer: customer.id, metadata: { user_id: 'u1' } });
    expect(sub.items.data.map((i) => [i.price.lookup_key, i.quantity])).toEqual([
      ['grow_monthly', 1],
      ['extra_business_monthly', 2],
    ]);
    expect(received.map((d) => [d.event.type, d.ok])).toEqual([
      ['checkout.session.completed', true],
      ['customer.subscription.created', true],
    ]);

    // a third extra business: always_invoice, error_if_incomplete, an Idempotency-Key
    const extraItem = sub.items.data.find((i) => i.price.id === extra.id);
    const change = { items: [{ id: extraItem.id, quantity: 3 }], proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' };
    const r1 = await stripe('POST', `/v1/subscriptions/${sub.id}`, change, { idem: 'add-biz-1' });
    expect(r1.status).toBe(200);
    expect(r1.body.items.data.find((i) => i.id === extraItem.id).quantity).toBe(3);
    // the same key and request: the first answer again, nothing done twice
    const r2 = await stripe('POST', `/v1/subscriptions/${sub.id}`, change, { idem: 'add-biz-1' });
    expect(r2).toMatchObject({ status: 200, replayed: true });
    expect(r2.body.latest_invoice).toBe(r1.body.latest_invoice);
    // the same key, other parameters: refused
    const r3 = await stripe('POST', `/v1/subscriptions/${sub.id}`, { items: [{ id: extraItem.id, quantity: 4 }] }, { idem: 'add-biz-1' });
    expect(r3.status).toBe(400);
    expect(r3.body.error.type).toBe('idempotency_error');
    expect((await stripe('GET', `/v1/subscriptions/${sub.id}`)).body.items.data.find((i) => i.id === extraItem.id).quantity).toBe(3);

    const portal = await stripe('POST', '/v1/billing_portal/sessions', { customer: customer.id, return_url: 'https://app.example/#settings' });
    expect(portal.body).toMatchObject({ object: 'billing_portal.session', customer: customer.id });
    expect(portal.body.url).toContain('/__portal/');

    // cancel at period end, then a failed payment, then canceled
    expect((await stripe('POST', `/v1/subscriptions/${sub.id}`, { cancel_at_period_end: true })).body.cancel_at_period_end).toBe(true);
    await fetch(`${mock.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify({ id: sub.id, status: 'past_due' }) });
    expect((await stripe('GET', `/v1/subscriptions/${sub.id}`)).body.status).toBe('past_due');
    expect((await stripe('DELETE', `/v1/subscriptions/${sub.id}`)).body.status).toBe('canceled');
    expect((await stripe('GET', '/v1/subscriptions', { customer: customer.id })).body.data).toHaveLength(0);
    expect((await stripe('GET', '/v1/subscriptions', { customer: customer.id, status: 'all' })).body.data).toHaveLength(1);
    expect(received.every((d) => d.ok)).toBe(true);
    const evt = (await stripe('GET', `/v1/events/${received.at(-1).event.id}`)).body;
    expect(evt.type).toBe('customer.subscription.deleted');
  });

  it('fault injection: a declined card, and a timeout after the change went through', async () => {
    const tier = await plan('scale_monthly', 39700);
    const extra = await plan('extra_business_monthly_2', 9700);
    const s = await stripe('POST', '/v1/checkout/sessions', { mode: 'subscription', success_url: 'https://x/ok', customer_email: 'a@example.com', line_items: [{ price: tier.id, quantity: 1 }, { price: extra.id, quantity: 0 }] });
    const { subscription: sub } = await (await fetch(`${mock.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: s.body.id }) })).json();
    const item = sub.items.data[1];
    mock.fail('POST /v1/subscriptions/:id', 'card_declined');
    const declined = await stripe('POST', `/v1/subscriptions/${sub.id}`, { items: [{ id: item.id, quantity: 1 }], payment_behavior: 'error_if_incomplete' }, { idem: 'k-declined' });
    expect(declined.status).toBe(402);
    expect(declined.body.error).toMatchObject({ type: 'card_error', code: 'card_declined' });
    expect((await stripe('GET', `/v1/subscriptions/${sub.id}`)).body.items.data[1].quantity).toBe(0);

    mock.fail('POST /v1/subscriptions/:id', 'timeout');
    await expect(stripe('POST', `/v1/subscriptions/${sub.id}`, { items: [{ id: item.id, quantity: 1 }] }, { idem: 'k-timeout' })).rejects.toThrow();
    // it went through: reading back shows it (a caller must read, never resend)
    expect((await stripe('GET', `/v1/subscriptions/${sub.id}`)).body.items.data[1].quantity).toBe(1);
    const calls = (await (await fetch(`${mock.base}/__calls`)).json()).calls;
    expect(calls.filter((c) => c.idempotencyKey === 'k-timeout')).toHaveLength(1);
    expect(calls.some((c) => c.violation)).toBe(false);
  });

  it('P1 additions: product custom ids, a card trial, error_if_incomplete with a declining card, invoices, renewal failure, portal configurations, item periods', async () => {
    const product = await stripe('POST', '/v1/products', { id: 'ylb_test_custom', name: 'Custom' });
    expect(product.body.id).toBe('ylb_test_custom');
    expect((await stripe('POST', '/v1/products', { id: 'ylb_test_custom', name: 'Again' })).status).toBe(400);
    expect((await stripe('GET', '/v1/products/ylb_test_custom')).body.name).toBe('Custom');
    const price = (await stripe('POST', '/v1/prices', { product: 'ylb_test_custom', currency: 'usd', unit_amount: 9700, lookup_key: 'p1_tier_m', recurring: { interval: 'month' } })).body;
    const extra = (await stripe('POST', '/v1/prices', { product: 'ylb_test_custom', currency: 'usd', unit_amount: 9700, lookup_key: 'p1_biz_m', recurring: { interval: 'month' } })).body;
    const yearly = (await stripe('POST', '/v1/prices', { product: 'ylb_test_custom', currency: 'usd', unit_amount: 97000, lookup_key: 'p1_tier_y', recurring: { interval: 'year' } })).body;
    const customer = (await stripe('POST', '/v1/customers', { email: 'p1@example.com' })).body;

    // a 7-day card trial: the subscription starts trialing, the first invoice is $0
    const trial = await stripe('POST', '/v1/checkout/sessions', { mode: 'subscription', customer: customer.id, success_url: 'https://x/ok', line_items: [{ price: price.id, quantity: 1 }], subscription_data: { trial_period_days: 7 } });
    const { subscription: sub } = await (await fetch(`${mock.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: trial.body.id }) })).json();
    expect(sub.status).toBe('trialing');
    expect(sub.trial_end - sub.current_period_start).toBe(7 * 86400);
    expect(sub.items.data[0]).toMatchObject({ current_period_start: sub.current_period_start, current_period_end: sub.current_period_end });
    const first = (await stripe('GET', `/v1/invoices/${sub.latest_invoice}`)).body;
    expect(first).toMatchObject({ object: 'invoice', subscription: sub.id, amount_paid: 0, status: 'paid' });
    expect((await stripe('GET', '/v1/invoices/in_nope00000000')).status).toBe(404);

    // during the trial an added item is billed $0, as Stripe bills items added during a free trial: nothing to decline
    await fetch(`${mock.base}/__customers/decline`, { method: 'POST', body: JSON.stringify({ id: customer.id }) });
    const add = { items: [{ price: extra.id, quantity: 1 }], proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' };
    const inTrial = await stripe('POST', `/v1/subscriptions/${sub.id}`, add, { idem: 'p1-in-trial' });
    expect(inTrial.status).toBe(200);
    expect((await stripe('GET', `/v1/invoices/${inTrial.body.latest_invoice}`)).body).toMatchObject({ amount_due: 0, status: 'paid' });
    const trialItem = inTrial.body.items.data.find((i) => i.price.id === extra.id);
    expect((await stripe('POST', `/v1/subscriptions/${sub.id}`, { items: [{ id: trialItem.id, deleted: true }], proration_behavior: 'none' })).status).toBe(200);
    // the trial ends: now the card declines an immediate charge, and with error_if_incomplete nothing changes
    expect((await (await fetch(`${mock.base}/__subscriptions/renew`, { method: 'POST', body: JSON.stringify({ id: sub.id }) })).json()).status).toBe('active');
    const declined = await stripe('POST', `/v1/subscriptions/${sub.id}`, add, { idem: 'p1-declined' });
    expect(declined.status).toBe(402);
    expect(declined.body.error).toMatchObject({ type: 'card_error', code: 'card_declined' });
    expect((await stripe('GET', `/v1/subscriptions/${sub.id}`)).body.items.data).toHaveLength(1);
    // a change that charges nothing now still goes through
    expect((await stripe('POST', `/v1/subscriptions/${sub.id}`, { items: [{ id: sub.items.data[0].id, price: price.id }], proration_behavior: 'none' })).status).toBe(200);
    mock.decline(customer.id, false);
    const added = await stripe('POST', `/v1/subscriptions/${sub.id}`, add, { idem: 'p1-added' });
    expect(added.status).toBe(200);
    expect((await stripe('GET', `/v1/invoices/${added.body.latest_invoice}`)).body).toMatchObject({ billing_reason: 'subscription_update', status: 'paid' });
    // month → year on both items
    const items = added.body.items.data;
    expect((await stripe('POST', `/v1/subscriptions/${sub.id}`, { items: [{ id: items[0].id, price: yearly.id }] })).body.items.data[0].price.recurring.interval).toBe('year');

    // a renewal payment fails: past_due with invoice.payment_failed; a renewal recovers it
    received.length = 0;
    const failed = await (await fetch(`${mock.base}/__invoices/fail`, { method: 'POST', body: JSON.stringify({ subscription: sub.id }) })).json();
    expect(failed.subscription.status).toBe('past_due');
    expect(failed.invoice).toMatchObject({ status: 'open', subscription: sub.id });
    expect(received.map((d) => d.event.type)).toEqual(['invoice.payment_failed', 'customer.subscription.updated']);
    const renewed = await (await fetch(`${mock.base}/__subscriptions/renew`, { method: 'POST', body: JSON.stringify({ id: sub.id }) })).json();
    expect(renewed.status).toBe('active');
    expect(renewed.current_period_start).toBe(failed.subscription.current_period_end);

    // a portal configuration with quantity editing off, used by a portal session
    const config = await stripe('POST', '/v1/billing_portal/configurations', { features: { payment_method_update: { enabled: true }, subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: 'at_period_end' } } }, { idem: 'p1-portal' });
    expect(config.body).toMatchObject({ object: 'billing_portal.configuration', features: { subscription_update: { enabled: 'false' } } });
    expect((await stripe('GET', `/v1/billing_portal/configurations/${config.body.id}`)).body.id).toBe(config.body.id);
    expect((await stripe('POST', '/v1/billing_portal/sessions', { customer: customer.id, configuration: config.body.id })).body.configuration).toBe(config.body.id);
    expect((await stripe('POST', '/v1/billing_portal/sessions', { customer: customer.id, configuration: 'bpc_nope00000000' })).status).toBe(404);
    expect(mock.writes('POST /v1/billing_portal/configurations')).toHaveLength(1);
  });

  it('P1c additions: trial_end=now and a declining card (402 with error_if_incomplete, else past_due with an open invoice), DELETE with its params in the query, Checkout’s trial fields, a permission fault', async () => {
    await stripe('POST', '/v1/products', { id: 'ylb_test_p1c', name: 'P1c' });
    const price = (await stripe('POST', '/v1/prices', { product: 'ylb_test_p1c', currency: 'usd', unit_amount: 9700, lookup_key: 'p1c_tier_m', recurring: { interval: 'month' } })).body;
    const customer = (await stripe('POST', '/v1/customers', { email: 'p1c@example.com' })).body;
    const trialSub = async () => {
      const s = await stripe('POST', '/v1/checkout/sessions', { mode: 'subscription', customer: customer.id, success_url: 'https://x/ok', line_items: [{ price: price.id, quantity: 1 }], subscription_data: { trial_period_days: 7 }, payment_method_collection: 'always', payment_method_types: ['card'], custom_text: { submit: { message: 'One free trial per person and card.' } } });
      expect(s.body).toMatchObject({ payment_method_collection: 'always', payment_method_types: ['card'], custom_text: { submit: { message: 'One free trial per person and card.' } } });
      return (await (await fetch(`${mock.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: s.body.id }) })).json()).subscription;
    };
    const one = await trialSub();
    const two = await trialSub();
    mock.decline(customer.id);
    // error_if_incomplete: refused, nothing changes
    const refused = await stripe('POST', `/v1/subscriptions/${one.id}`, { trial_end: 'now', payment_behavior: 'error_if_incomplete' }, { idem: 'p1c-refused' });
    expect(refused.status).toBe(402);
    expect((await stripe('GET', `/v1/subscriptions/${one.id}`)).body.status).toBe('trialing');
    // Stripe's default (allow_incomplete): the trial ends, the invoice stays open, the subscription is past_due
    const incomplete = await stripe('POST', `/v1/subscriptions/${one.id}`, { trial_end: 'now' }, { idem: 'p1c-incomplete' });
    expect(incomplete.status).toBe(200);
    expect(incomplete.body.status).toBe('past_due');
    expect((await stripe('GET', `/v1/invoices/${incomplete.body.latest_invoice}`)).body).toMatchObject({ status: 'open', amount_paid: 0 });
    // DELETE takes its params from the query, as Stripe's libraries send them
    const del = await fetch(`${mock.apiBase}/v1/subscriptions/${two.id}?invoice_now=false&prorate=false&cancellation_details%5Bfeedback%5D=too_expensive&cancellation_details%5Bcomment%5D=Later`, { method: 'DELETE', headers: { authorization: `Bearer ${TEST_STRIPE_KEY}`, 'idempotency-key': 'p1c-del' } });
    expect((await del.json()).cancellation_details).toMatchObject({ feedback: 'too_expensive', comment: 'Later' });
    expect(mock.calls.at(-1)).toMatchObject({ method: 'DELETE', route: 'DELETE /v1/subscriptions/:id', query: 'invoice_now=false&prorate=false&cancellation_details%5Bfeedback%5D=too_expensive&cancellation_details%5Bcomment%5D=Later' });
    // a restricted key without a permission: 403
    mock.fail('GET /v1/payment_methods/:id', 'permission', 1);
    expect((await stripe('GET', `/v1/payment_methods/${one.default_payment_method}`)).status).toBe(403);
    expect((await stripe('GET', `/v1/payment_methods/${one.default_payment_method}`)).status).toBe(200);
  });

  it('Connect: an account, its onboarding link, and a direct charge with an application fee on that account only', async () => {
    const acct = (await stripe('POST', '/v1/accounts', { type: 'standard', country: 'US', email: 'seller@example.com' })).body;
    expect(acct).toMatchObject({ object: 'account', charges_enabled: false });
    const link = await stripe('POST', '/v1/account_links', { account: acct.id, refresh_url: 'https://app/#refresh', return_url: 'https://app/#return', type: 'account_onboarding' });
    expect(link.body).toMatchObject({ object: 'account_link' });
    expect(link.body.url).toContain(acct.id);
    expect((await stripe('POST', '/v1/account_links', { account: acct.id, type: 'account_onboarding' })).status).toBe(400);

    received.length = 0;
    await fetch(`${mock.base}/__accounts/enable`, { method: 'POST', body: JSON.stringify({ id: acct.id }) });
    expect((await stripe('GET', `/v1/accounts/${acct.id}`)).body.charges_enabled).toBe(true);
    expect(received[0].event).toMatchObject({ type: 'account.updated', account: acct.id });

    // the seller's product and price live on their account
    const product = (await stripe('POST', '/v1/products', { name: 'Ebook' }, { account: acct.id })).body;
    const price = (await stripe('POST', '/v1/prices', { product: product.id, currency: 'usd', unit_amount: 2500 }, { account: acct.id })).body;
    expect((await stripe('GET', `/v1/prices/${price.id}`)).status).toBe(404);
    const session = await stripe('POST', '/v1/checkout/sessions', { mode: 'payment', success_url: 'https://app/thank-you?session_id={CHECKOUT_SESSION_ID}', line_items: [{ price: price.id, quantity: 1 }], payment_intent_data: { application_fee_amount: 75 }, metadata: { offer_id: 'o1' } }, { account: acct.id });
    expect(session.status).toBe(200);
    expect(session.body.payment_intent_data.application_fee_amount).toBe(75);
    expect((await stripe('GET', `/v1/checkout/sessions/${session.body.id}`)).status).toBe(404);
    expect((await stripe('GET', `/v1/checkout/sessions/${session.body.id}`, null, { account: acct.id })).body.status).toBe('open');

    await fetch(`${mock.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: session.body.id, account: acct.id }) });
    const paid = received.find((d) => d.event.type === 'checkout.session.completed');
    expect(paid.ok).toBe(true);
    expect(paid.event.account).toBe(acct.id);
    expect(paid.event.data.object).toMatchObject({ payment_status: 'paid', metadata: { offer_id: 'o1' } });

    // an account nobody made
    expect((await stripe('GET', '/v1/customers', null, { account: 'acct_000000000000000000000000' })).status).toBe(403);
  });
});
