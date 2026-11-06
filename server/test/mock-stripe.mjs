// A stand-in for Stripe's API (https://docs.stripe.com/api), for tests and offline QA. Nothing here calls Stripe or a
// network. Same style as server/test/mock-zernio.mjs:
//
//   node server/test/mock-stripe.mjs [port]      → prints its base URL (use it as the SDK/client's API base)
//   const mock = await createMockStripe({ webhookUrl, webhookSecret }).start();
//
// Requests are what Stripe takes: form-encoded bodies with bracket keys (line_items[0][price]=…, metadata[k]=v,
// expand[]=…), "Authorization: Bearer sk_test_…" (anything else 401), an optional Idempotency-Key (the same key
// with the same request answers the first answer again, without doing anything; with different parameters 400
// idempotency_error), and an optional Stripe-Account header (the call acts on that connected account: its objects
// are apart from the platform's and from every other account's). Errors look like Stripe's: {error: {type, code,
// message, param?}}.
//
// What it answers (under /v1):
//   POST /customers, GET /customers/:id, POST /customers/:id, GET /customers?email=&limit=
//   POST /products, GET /products/:id
//   POST /prices (lookup_key, transfer_lookup_key, recurring[interval]), GET /prices/:id,
//        GET /prices?lookup_keys[]=&active=&product=
//   POST /checkout/sessions (mode payment|subscription, customer, client_reference_id, line_items, success_url,
//        cancel_url, metadata, expires_at, subscription_data[metadata], subscription_data[trial_period_days] (the
//        subscription starts trialing), payment_intent_data[application_fee_amount]), GET /checkout/sessions/:id
//   GET /subscriptions/:id, GET /subscriptions?customer=&status=, POST /subscriptions/:id (items[n][id|price|
//        quantity|deleted], cancel_at_period_end, proration_behavior, payment_behavior, metadata),
//        DELETE /subscriptions/:id. Subscriptions carry current_period_* on each item too (the basil API version),
//        billing_cycle_anchor and trial_end. A change with proration_behavior=always_invoice makes a paid invoice;
//        with payment_behavior=error_if_incomplete and a customer whose card declines (POST /__customers/decline) it
//        answers 402 card_declined and changes nothing.
//   POST /subscription_items/:id (quantity, proration_behavior, payment_behavior)
//   POST /billing_portal/sessions (customer, return_url, configuration)
//   POST /billing_portal/configurations (features[…], business_profile[…]), GET /billing_portal/configurations/:id
//   GET /invoices/:id
//   POST /accounts (Connect), GET /accounts/:id, POST /account_links (account, refresh_url, return_url, type)
//   GET /events/:id, GET /events
//
// Test hooks (no key):
//   GET  /__calls                                         every API call {method, path, account, idempotencyKey}
//   POST /__checkout/complete {id, account?, paid?}        finishes a Checkout Session: a subscription (mode
//                                                          subscription) with one item per line, or a paid payment;
//                                                          sends checkout.session.completed (+ customer.subscription.
//                                                          created), signed, to the webhook URL
//   POST /__subscriptions/status {id, status, account?}    e.g. past_due / unpaid / canceled, with its event
//   POST /__subscriptions/renew {id, account?}             the period rolls forward one interval (customer.subscription.
//                                                          updated + invoice.paid)
//   POST /__invoices/fail {subscription, account?}         a renewal payment fails: an open invoice, the subscription
//                                                          past_due, invoice.payment_failed + customer.subscription.updated
//   POST /__customers/decline {id, account?, on?}          the customer's card declines (on: false lifts it)
//   POST /__accounts/enable {id}                           charges_enabled + details_submitted, account.updated
//   POST /__fail {route, mode, times}                      the next `times` calls to `route` (e.g. "POST
//                                                          /v1/subscriptions/:id") fail: card_declined (402),
//                                                          server (500), rate_limit (429) or timeout (the request
//                                                          is DONE, then the connection is dropped: the "did it go
//                                                          through?" case a caller must read back, never resend)
//
// signStripeHeader(payload, secret, t) makes a valid Stripe-Signature header (t=…,v1=HMAC-SHA256 of "t.payload");
// verifyStripeHeader(payload, header, secret, toleranceSec) checks one, as Stripe's libraries do.

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const TEST_STRIPE_KEY = 'sk_test_mock_0000000000000000000000';
export const TEST_STRIPE_WEBHOOK_SECRET = 'whsec_test_mock_000000000000000000';

/** Stripe-Signature for a raw payload: "t=<unix>,v1=<hex HMAC-SHA256 of `${t}.${payload}`>". */
export function signStripeHeader(payload, secret = TEST_STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8')}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Checks a Stripe-Signature header the way Stripe's libraries do: any v1 matches, and t is within the tolerance. */
export function verifyStripeHeader(payload, header, secret = TEST_STRIPE_WEBHOOK_SECRET, toleranceSec = 300, now = Date.now()) {
  const parts = String(header ?? '').split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const want = Buffer.from(signStripeHeader(payload, secret, t).split('v1=')[1], 'hex');
  return sigs.some((s) => {
    const got = Buffer.from(String(s), 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}

/** Stripe's form encoding → nested objects (numeric keys become arrays; "a[]" appends). */
export function parseForm(text) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const keys = rawKey.replace(/\]/g, '').split('[');
    let node = out;
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      const nextIsIndex = !last && (keys[i + 1] === '' || /^\d+$/.test(keys[i + 1]));
      const key = k === '' && Array.isArray(node) ? node.length : /^\d+$/.test(k) && Array.isArray(node) ? Number(k) : k;
      if (last) node[key] = value;
      else {
        if (node[key] === undefined) node[key] = nextIsIndex ? [] : {};
        node = node[key];
      }
    });
  }
  return out;
}

/** The same encoding, the other way (for tests and clients that build requests). */
export function encodeForm(obj, prefix = '') {
  const pairs = [];
  const walk = (v, k) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${k}[${i}]`));
    else if (typeof v === 'object') for (const [ck, cv] of Object.entries(v)) walk(cv, k ? `${k}[${ck}]` : ck);
    else pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  };
  walk(obj, prefix);
  return pairs.join('&');
}

const PREFIX = { customer: 'cus', product: 'prod', price: 'price', 'checkout.session': 'cs_test', subscription: 'sub', subscription_item: 'si', 'billing_portal.session': 'bps', 'billing_portal.configuration': 'bpc', account: 'acct', account_link: 'al', event: 'evt', payment_intent: 'pi', invoice: 'in' };
const newId = (object) => `${PREFIX[object] ?? 'obj'}_${crypto.randomBytes(12).toString('hex')}`;
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_${crypto.randomBytes(7).toString('hex')}`, ...headers });
  res.end(JSON.stringify(body));
};
const stripeError = (status, type, message, extra = {}) => ({ status, body: { error: { type, message, ...extra } } });
const notFound = (what, id) => stripeError(404, 'invalid_request_error', `No such ${what}: '${id}'`, { code: 'resource_missing', param: 'id' });
const missing = (param) => stripeError(400, 'invalid_request_error', `Missing required param: ${param}.`, { code: 'parameter_missing', param });
const int = (v, d = null) => (v === undefined || v === null || v === '' ? d : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const bool = (v) => v === true || v === 'true';
const list = (data, url) => ({ object: 'list', data, has_more: false, url });

export function createMockStripe({ key = TEST_STRIPE_KEY, webhookSecret = TEST_STRIPE_WEBHOOK_SECRET, webhookUrl = '', now = () => Date.now() } = {}) {
  /** objects per account: '' is the platform, acct_… a connected account */
  const realms = new Map();
  const realm = (account = '') => {
    if (!realms.has(account)) realms.set(account, { customers: new Map(), products: new Map(), prices: new Map(), sessions: new Map(), subscriptions: new Map(), items: new Map(), invoices: new Map(), portalConfigs: new Map(), declining: new Set(), events: [] });
    return realms.get(account);
  };
  const accounts = new Map();
  const idempotency = new Map();
  const calls = [];
  const deliveries = [];
  const faults = [];
  let hookUrl = webhookUrl;
  let server = null;
  let base = '';
  const sec = () => Math.floor(now() / 1000);

  // ───────── events ─────────
  async function emit(type, object, account = '', previous = null) {
    const evt = { id: newId('event'), object: 'event', api_version: '2025-06-30.basil', created: sec(), type, livemode: false, pending_webhooks: 1, data: { object: structuredClone(object), ...(previous ? { previous_attributes: previous } : {}) }, ...(account ? { account } : {}) };
    realm(account).events.unshift(evt);
    const raw = JSON.stringify(evt);
    const header = signStripeHeader(raw, webhookSecret, sec());
    const delivery = { event: evt, raw, header, status: 0 };
    deliveries.push(delivery);
    if (hookUrl) {
      try {
        const res = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: raw });
        delivery.status = res.status;
      } catch {
        delivery.status = -1;
      }
    }
    return evt;
  }

  // ───────── objects ─────────
  const priceById = (r, id) => r.prices.get(id) ?? null;

  function makeItem(r, sub, priceId, quantity) {
    const price = priceById(r, priceId);
    const item = { id: newId('subscription_item'), object: 'subscription_item', subscription: sub.id, price, quantity: quantity ?? 1, created: sec(), metadata: {} };
    r.items.set(item.id, item);
    return item;
  }

  // like the basil API version: each item carries the period too
  const subscriptionView = (r, sub) => ({ ...sub, items: list([...r.items.values()].filter((i) => i.subscription === sub.id && !i.deleted).map(({ deleted, ...i }) => ({ ...i, current_period_start: sub.current_period_start, current_period_end: sub.current_period_end })), `/v1/subscription_items?subscription=${sub.id}`) });

  /** The length of one billing period of a subscription (its first item's interval). */
  const periodSec = (r, sub) => ([...r.items.values()].find((i) => i.subscription === sub.id && !i.deleted)?.price?.recurring?.interval === 'year' ? 365 * 86400 : 30 * 86400);
  const itemsTotal = (r, sub) => [...r.items.values()].filter((i) => i.subscription === sub.id && !i.deleted).reduce((n, i) => n + (i.price?.unit_amount ?? 0) * (i.quantity ?? 1), 0);

  function newInvoice(r, sub, { status = 'paid', amount = itemsTotal(r, sub), reason = 'subscription_cycle' } = {}) {
    const inv = { id: newId('invoice'), object: 'invoice', customer: sub.customer, subscription: sub.id, status, amount_due: amount, amount_paid: status === 'paid' ? amount : 0, billing_reason: reason, attempt_count: status === 'paid' ? 1 : 1, created: sec(), livemode: false };
    r.invoices.set(inv.id, inv);
    sub.latest_invoice = inv.id;
    return inv;
  }

  function newSubscription(r, { customer, lines, metadata = {}, status = 'active', trialDays = 0 }) {
    const start = sec();
    const trialEnd = trialDays > 0 ? start + trialDays * 86400 : null;
    const sub = { id: newId('subscription'), object: 'subscription', customer, status: trialEnd && status === 'active' ? 'trialing' : status, created: start, start_date: start, billing_cycle_anchor: trialEnd ?? start, current_period_start: start, current_period_end: start + 30 * 86400, trial_start: trialEnd ? start : null, trial_end: trialEnd, cancel_at_period_end: false, canceled_at: null, ended_at: null, metadata, latest_invoice: null, livemode: false };
    r.subscriptions.set(sub.id, sub);
    for (const l of lines) makeItem(r, sub, l.price, int(l.quantity, 1));
    sub.current_period_end = trialEnd ?? start + periodSec(r, sub);
    newInvoice(r, sub, { status: status === 'active' ? 'paid' : 'open', amount: trialEnd ? 0 : itemsTotal(r, sub), reason: 'subscription_create' });
    return sub;
  }

  /** A fault for this route, if one is armed: card_declined | server | rate_limit | timeout. */
  function takeFault(route) {
    const f = faults.find((x) => x.route === route && x.times > 0);
    if (!f) return null;
    f.times -= 1;
    return f.mode;
  }

  // ───────── the API ─────────
  async function api(method, parts, query, body, account) {
    const r = realm(account);
    const [res, id, sub] = parts;
    const path = `/v1/${parts.join('/')}`;

    if (res === 'customers') {
      if (method === 'POST' && !id) {
        const c = { id: newId('customer'), object: 'customer', email: body.email ?? null, name: body.name ?? null, metadata: body.metadata ?? {}, created: sec(), livemode: false };
        r.customers.set(c.id, c);
        return { status: 200, body: c };
      }
      if (method === 'GET' && !id) {
        const all = [...r.customers.values()].filter((c) => !query.get('email') || c.email === query.get('email'));
        return { status: 200, body: list(all.slice(0, int(query.get('limit'), 10)), '/v1/customers') };
      }
      const c = r.customers.get(id);
      if (!c) return notFound('customer', id);
      if (method === 'GET') return { status: 200, body: c };
      if (method === 'POST') {
        Object.assign(c, { ...(body.email !== undefined ? { email: body.email } : {}), ...(body.name !== undefined ? { name: body.name } : {}), metadata: { ...c.metadata, ...(body.metadata ?? {}) } });
        return { status: 200, body: c };
      }
    }

    if (res === 'products') {
      if (method === 'POST' && !id) {
        if (!body.name) return missing('name');
        if (body.id && r.products.has(body.id)) return stripeError(400, 'invalid_request_error', `Product already exists.`, { code: 'resource_already_exists', param: 'id' });
        const p = { id: body.id || newId('product'), object: 'product', name: body.name, active: body.active === undefined ? true : bool(body.active), metadata: body.metadata ?? {}, created: sec() };
        r.products.set(p.id, p);
        return { status: 200, body: p };
      }
      const p = r.products.get(id);
      if (!p) return notFound('product', id);
      if (method === 'GET') return { status: 200, body: p };
    }

    if (res === 'prices') {
      if (method === 'POST' && !id) {
        if (!body.currency) return missing('currency');
        if (!body.product) return missing('product');
        if (!r.products.has(body.product)) return notFound('product', body.product);
        if (body.lookup_key) {
          const holder = [...r.prices.values()].find((p) => p.lookup_key === body.lookup_key);
          if (holder && !bool(body.transfer_lookup_key)) return stripeError(400, 'invalid_request_error', `A price (\`${holder.id}\`) already uses that lookup key.`, { param: 'lookup_key' });
          if (holder) holder.lookup_key = null;
        }
        const recurring = body.recurring ? { interval: body.recurring.interval, interval_count: int(body.recurring.interval_count, 1), usage_type: 'licensed' } : null;
        const p = { id: newId('price'), object: 'price', active: true, currency: String(body.currency).toLowerCase(), unit_amount: int(body.unit_amount), product: body.product, lookup_key: body.lookup_key ?? null, nickname: body.nickname ?? null, recurring, type: recurring ? 'recurring' : 'one_time', metadata: body.metadata ?? {}, created: sec(), livemode: false };
        r.prices.set(p.id, p);
        return { status: 200, body: p };
      }
      if (method === 'GET' && !id) {
        const keys = [].concat(query.getAll('lookup_keys[]'), query.getAll('lookup_keys'));
        const all = [...r.prices.values()].filter((p) => (!keys.length || keys.includes(p.lookup_key)) && (query.get('active') === null || p.active === (query.get('active') === 'true')) && (!query.get('product') || p.product === query.get('product')));
        return { status: 200, body: list(all.slice(0, int(query.get('limit'), 10)), '/v1/prices') };
      }
      const p = r.prices.get(id);
      if (!p) return notFound('price', id);
      if (method === 'GET') return { status: 200, body: p };
    }

    if (res === 'checkout' && id === 'sessions') {
      const sid = sub;
      if (method === 'POST' && !sid) {
        const mode = body.mode;
        if (!['payment', 'subscription', 'setup'].includes(mode)) return missing('mode');
        if (!body.success_url && body.ui_mode !== 'embedded') return missing('success_url');
        const lines = Array.isArray(body.line_items) ? body.line_items : [];
        if (mode !== 'setup' && !lines.length) return missing('line_items');
        for (const l of lines) {
          if (!l.price) return missing('line_items[0][price]');
          const price = priceById(r, l.price);
          if (!price) return notFound('price', l.price);
          if (mode === 'subscription' && !price.recurring) return stripeError(400, 'invalid_request_error', 'You must provide at least one recurring price in `subscription` mode when using prices.', { param: 'line_items' });
        }
        if (body.customer && !r.customers.has(body.customer)) return notFound('customer', body.customer);
        const amount = lines.reduce((n, l) => n + (priceById(r, l.price)?.unit_amount ?? 0) * int(l.quantity, 1), 0);
        const s = {
          id: newId('checkout.session'),
          object: 'checkout.session',
          mode,
          status: 'open',
          payment_status: 'unpaid',
          customer: body.customer ?? null,
          customer_email: body.customer_email ?? null,
          client_reference_id: body.client_reference_id ?? null,
          success_url: body.success_url ?? null,
          cancel_url: body.cancel_url ?? null,
          metadata: body.metadata ?? {},
          amount_total: amount,
          currency: lines[0] ? priceById(r, lines[0].price).currency : null,
          subscription: null,
          payment_intent: null,
          line_items_input: lines.map((l) => ({ price: l.price, quantity: int(l.quantity, 1) })),
          subscription_data: body.subscription_data ? { ...body.subscription_data, trial_period_days: int(body.subscription_data.trial_period_days) } : null,
          payment_intent_data: body.payment_intent_data ? { ...body.payment_intent_data, application_fee_amount: int(body.payment_intent_data.application_fee_amount) } : null,
          created: sec(),
          expires_at: int(body.expires_at) ?? sec() + 24 * 3600,
          livemode: false,
        };
        s.url = `${base}/__pay/${s.id}`;
        r.sessions.set(s.id, s);
        return { status: 200, body: s };
      }
      const s = r.sessions.get(sid);
      if (!s) return notFound('checkout.session', sid);
      if (method === 'GET') return { status: 200, body: s };
    }

    if (res === 'subscriptions') {
      if (method === 'GET' && !id) {
        const status = query.get('status');
        // like Stripe: no status → every one but canceled; 'all' → every one
        const statusOk = (s) => (status === 'all' ? true : status ? s.status === status : s.status !== 'canceled');
        const all = [...r.subscriptions.values()].filter((s) => (!query.get('customer') || s.customer === query.get('customer')) && statusOk(s));
        return { status: 200, body: list(all.map((s) => subscriptionView(r, s)), '/v1/subscriptions') };
      }
      const s = r.subscriptions.get(id);
      if (!s) return notFound('subscription', id);
      if (method === 'GET') return { status: 200, body: subscriptionView(r, s) };
      if (method === 'DELETE') {
        s.status = 'canceled';
        s.canceled_at = s.ended_at = sec();
        await emit('customer.subscription.deleted', subscriptionView(r, s), account);
        return { status: 200, body: subscriptionView(r, s) };
      }
      if (method === 'POST') {
        if (s.status === 'canceled') return stripeError(400, 'invalid_request_error', 'A canceled subscription can only update its cancellation_details and metadata.');
        // a change charged now with a card that declines: error_if_incomplete refuses it and nothing changes
        const changesItems = Array.isArray(body.items) && body.items.length > 0;
        if (changesItems && body.proration_behavior === 'always_invoice' && body.payment_behavior === 'error_if_incomplete' && r.declining.has(s.customer)) {
          return { status: 402, body: { error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' } } };
        }
        const previous = {};
        for (const it of Array.isArray(body.items) ? body.items : []) {
          if (it.id) {
            const item = r.items.get(it.id);
            if (!item || item.subscription !== s.id) return notFound('subscription_item', it.id);
            if (bool(it.deleted)) item.deleted = true;
            else {
              if (it.quantity !== undefined) item.quantity = int(it.quantity, item.quantity);
              if (it.price) {
                const price = priceById(r, it.price);
                if (!price) return notFound('price', it.price);
                item.price = price;
              }
            }
          } else if (it.price) {
            if (!priceById(r, it.price)) return notFound('price', it.price);
            makeItem(r, s, it.price, int(it.quantity, 1));
          }
          previous.items = true;
        }
        if (body.cancel_at_period_end !== undefined) {
          previous.cancel_at_period_end = s.cancel_at_period_end;
          s.cancel_at_period_end = bool(body.cancel_at_period_end);
        }
        if (body.metadata) s.metadata = { ...s.metadata, ...body.metadata };
        if (previous.items && body.proration_behavior === 'always_invoice') newInvoice(r, s, { reason: 'subscription_update' });
        await emit('customer.subscription.updated', subscriptionView(r, s), account, previous);
        return { status: 200, body: subscriptionView(r, s) };
      }
    }

    if (res === 'subscription_items' && id && method === 'POST') {
      const item = r.items.get(id);
      if (!item || item.deleted) return notFound('subscription_item', id);
      if (body.quantity !== undefined) item.quantity = int(body.quantity, item.quantity);
      const s = r.subscriptions.get(item.subscription);
      if (body.proration_behavior === 'always_invoice') newInvoice(r, s, { reason: 'subscription_update' });
      await emit('customer.subscription.updated', subscriptionView(r, s), account, { items: true });
      const { deleted, ...out } = item;
      return { status: 200, body: out };
    }

    if (res === 'billing_portal' && id === 'configurations') {
      if (method === 'POST' && !sub) {
        const c = { id: newId('billing_portal.configuration'), object: 'billing_portal.configuration', active: true, is_default: false, features: body.features ?? {}, business_profile: body.business_profile ?? {}, default_return_url: body.default_return_url ?? null, metadata: body.metadata ?? {}, created: sec(), livemode: false };
        r.portalConfigs.set(c.id, c);
        return { status: 200, body: c };
      }
      const c = r.portalConfigs.get(sub);
      if (!c) return notFound('billing_portal.configuration', sub);
      if (method === 'GET') return { status: 200, body: c };
    }

    if (res === 'invoices' && id && method === 'GET') {
      const inv = r.invoices.get(id);
      if (!inv) return notFound('invoice', id);
      return { status: 200, body: inv };
    }

    if (res === 'billing_portal' && id === 'sessions' && method === 'POST') {
      if (!body.customer) return missing('customer');
      if (!r.customers.has(body.customer)) return notFound('customer', body.customer);
      if (body.configuration && !r.portalConfigs.has(body.configuration)) return notFound('billing_portal.configuration', body.configuration);
      const p = { id: newId('billing_portal.session'), object: 'billing_portal.session', customer: body.customer, configuration: body.configuration ?? null, return_url: body.return_url ?? null, created: sec(), livemode: false };
      p.url = `${base}/__portal/${p.id}`;
      return { status: 200, body: p };
    }

    if (res === 'accounts') {
      if (account) return stripeError(400, 'invalid_request_error', 'Connected accounts can’t make other accounts.');
      if (method === 'POST' && !id) {
        const a = { id: newId('account'), object: 'account', type: body.type ?? null, controller: body.controller ?? null, country: body.country ?? 'US', email: body.email ?? null, charges_enabled: false, payouts_enabled: false, details_submitted: false, metadata: body.metadata ?? {}, created: sec() };
        accounts.set(a.id, a);
        return { status: 200, body: a };
      }
      const a = accounts.get(id);
      if (!a) return notFound('account', id);
      if (method === 'GET') return { status: 200, body: a };
    }

    if (res === 'account_links' && method === 'POST') {
      if (!body.account) return missing('account');
      if (!accounts.has(body.account)) return notFound('account', body.account);
      for (const p of ['refresh_url', 'return_url', 'type']) if (!body[p]) return missing(p);
      return { status: 200, body: { object: 'account_link', created: sec(), expires_at: sec() + 300, url: `${base}/__onboard/${body.account}` } };
    }

    if (res === 'events') {
      if (method === 'GET' && !id) return { status: 200, body: list(r.events.slice(0, int(query.get('limit'), 10)), '/v1/events') };
      const e = r.events.find((x) => x.id === id);
      if (!e) return notFound('event', id);
      if (method === 'GET') return { status: 200, body: e };
    }

    return stripeError(404, 'invalid_request_error', `Unrecognized request URL (${method}: ${path}).`);
  }

  /** "POST /v1/subscriptions/:id" for a request, so faults can name a route. */
  const routeOf = (method, parts) => `${method} /v1/${parts.map((p, i) => (i > 0 && /_[0-9a-f]{8,}$/.test(p) ? ':id' : p)).join('/')}`;

  async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');

    // ───────── test hooks ─────────
    if (url.pathname.startsWith('/__')) {
      const b = raw ? JSON.parse(raw) : {};
      if (url.pathname === '/__calls') return send(res, 200, { calls });
      if (url.pathname === '/__fail' && req.method === 'POST') {
        faults.push({ route: String(b.route), mode: String(b.mode), times: Number(b.times ?? 1) });
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/__checkout/complete' && req.method === 'POST') return send(res, ...(await completeCheckout(b.id, b.account ?? '', b.paid !== false)));
      if (url.pathname === '/__subscriptions/status' && req.method === 'POST') {
        const r = realm(b.account ?? '');
        const s = r.subscriptions.get(b.id);
        if (!s) return send(res, 404, { error: 'no such subscription' });
        const previous = { status: s.status };
        s.status = b.status;
        if (b.status === 'canceled') s.canceled_at = s.ended_at = sec();
        await emit(b.status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated', subscriptionView(r, s), b.account ?? '', previous);
        return send(res, 200, subscriptionView(r, s));
      }
      if (url.pathname === '/__subscriptions/renew' && req.method === 'POST') {
        const r = realm(b.account ?? '');
        const s = r.subscriptions.get(b.id);
        if (!s) return send(res, 404, { error: 'no such subscription' });
        const len = periodSec(r, s);
        const previous = { current_period_start: s.current_period_start, current_period_end: s.current_period_end };
        s.current_period_start = s.current_period_end;
        s.current_period_end = s.current_period_start + len;
        if (s.status === 'trialing' || s.status === 'past_due') s.status = 'active';
        const inv = newInvoice(r, s);
        await emit('customer.subscription.updated', subscriptionView(r, s), b.account ?? '', previous);
        await emit('invoice.paid', inv, b.account ?? '');
        return send(res, 200, subscriptionView(r, s));
      }
      if (url.pathname === '/__invoices/fail' && req.method === 'POST') {
        const r = realm(b.account ?? '');
        const s = r.subscriptions.get(b.subscription);
        if (!s) return send(res, 404, { error: 'no such subscription' });
        const inv = newInvoice(r, s, { status: 'open' });
        const previous = { status: s.status };
        s.status = 'past_due';
        await emit('invoice.payment_failed', inv, b.account ?? '');
        await emit('customer.subscription.updated', subscriptionView(r, s), b.account ?? '', previous);
        return send(res, 200, { invoice: inv, subscription: subscriptionView(r, s) });
      }
      if (url.pathname === '/__customers/decline' && req.method === 'POST') {
        const r = realm(b.account ?? '');
        if (!r.customers.has(b.id)) return send(res, 404, { error: 'no such customer' });
        if (b.on === false) r.declining.delete(b.id);
        else r.declining.add(b.id);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/__accounts/enable' && req.method === 'POST') {
        const a = accounts.get(b.id);
        if (!a) return send(res, 404, { error: 'no such account' });
        Object.assign(a, { charges_enabled: true, payouts_enabled: true, details_submitted: true });
        await emit('account.updated', a, a.id);
        return send(res, 200, a);
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Stripe (mock)</title><p>Mock Stripe page.</p>');
    }

    if (!url.pathname.startsWith('/v1/')) return send(res, 404, { error: { type: 'invalid_request_error', message: 'Not found.' } });
    if (url.search.includes('sk_')) calls.push({ violation: 'secret key in a query string' });
    if (req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided.' } });

    const parts = url.pathname.slice(4).split('/').filter(Boolean);
    const method = req.method;
    const account = String(req.headers['stripe-account'] ?? '');
    const ikey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : null;
    const route = routeOf(method, parts);
    calls.push({ method, path: url.pathname, route, account: account || null, idempotencyKey: ikey });
    if (account && !accounts.has(account)) return send(res, 403, { error: { type: 'invalid_request_error', message: `The provided key does not have access to account '${account}' (or that account does not exist).` } });

    const body = method === 'POST' ? parseForm(raw) : {};
    // an Idempotency-Key replays the first answer (same request) or refuses a different one
    const fingerprint = `${method} ${url.pathname} ${account} ${raw}`;
    if (ikey && method === 'POST') {
      const seen = idempotency.get(`${account}:${ikey}`);
      if (seen && seen.fingerprint !== fingerprint) return send(res, 400, { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } });
      if (seen) return send(res, seen.status, seen.body, { 'idempotent-replayed': 'true' });
    }

    const fault = takeFault(route);
    if (fault === 'card_declined') return send(res, 402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' } });
    if (fault === 'server') return send(res, 500, { error: { type: 'api_error', message: 'Something went wrong on Stripe’s end.' } });
    if (fault === 'rate_limit') return send(res, 429, { error: { type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests.' } });

    const out = await api(method, parts, url.searchParams, body, account);
    if (ikey && method === 'POST' && out.status < 500) idempotency.set(`${account}:${ikey}`, { fingerprint, status: out.status, body: out.body });
    // the request went through; the caller never hears back
    if (fault === 'timeout') return void req.socket.destroy();
    return send(res, out.status, out.body);
  }

  async function completeCheckout(id, account = '', paid = true) {
    const r = realm(account);
    const s = r.sessions.get(id);
    if (!s) return [404, { error: 'no such session' }];
    if (s.status !== 'open') return [409, { error: `session is ${s.status}` }];
    s.status = 'complete';
    s.payment_status = paid ? 'paid' : 'unpaid';
    if (!s.customer) {
      const c = { id: newId('customer'), object: 'customer', email: s.customer_email, name: null, metadata: {}, created: sec(), livemode: false };
      r.customers.set(c.id, c);
      s.customer = c.id;
    }
    let subscription = null;
    if (s.mode === 'subscription') {
      subscription = newSubscription(r, { customer: s.customer, lines: s.line_items_input, metadata: s.subscription_data?.metadata ?? {}, status: paid ? 'active' : 'incomplete', trialDays: s.subscription_data?.trial_period_days ?? 0 });
      s.subscription = subscription.id;
    } else if (s.mode === 'payment') s.payment_intent = newId('payment_intent');
    await emit('checkout.session.completed', s, account);
    if (subscription) await emit('customer.subscription.created', subscriptionView(r, subscription), account);
    return [200, { session: s, subscription: subscription ? subscriptionView(r, subscription) : null }];
  }

  return {
    calls,
    deliveries,
    accounts,
    realm,
    get base() {
      return base;
    },
    /** what a client uses as Stripe's API base (requests go to `${apiBase}/v1/…`) */
    get apiBase() {
      return base;
    },
    set webhookUrl(u) {
      hookUrl = u;
    },
    completeCheckout,
    emit,
    /** An event as Stripe would sign it, for calling a webhook handler directly: { raw, header, event }. */
    signed(type, object, { account = '', secret = webhookSecret, t = sec() } = {}) {
      const event = { id: newId('event'), object: 'event', api_version: '2025-06-30.basil', created: t, type, livemode: false, data: { object }, ...(account ? { account } : {}) };
      const raw = JSON.stringify(event);
      return { raw, event, header: signStripeHeader(raw, secret, t) };
    },
    fail(route, mode, times = 1) {
      faults.push({ route, mode, times });
    },
    /** The customer's card declines from now on (on: false lifts it). */
    decline(customerId, on = true, account = '') {
      if (on) realm(account).declining.add(customerId);
      else realm(account).declining.delete(customerId);
    },
    /** Stripe writes (POST/DELETE under /v1) made so far, e.g. to check nothing was resent. */
    writes(route = null) {
      return calls.filter((c) => c.method && c.method !== 'GET' && (!route || c.route === route));
    },
    async start(port = 0) {
      server = http.createServer((req, res) => void handler(req, res).catch(() => send(res, 500, { error: { type: 'api_error', message: 'mock failure' } })));
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    async close() {
      server?.closeAllConnections?.();
      await new Promise((r) => (server ? server.close(() => r()) : r()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockStripe({ webhookUrl: process.env.STRIPE_MOCK_WEBHOOK_URL || '' }).start(Number(process.argv[2] || 0));
  console.log(mock.apiBase);
}
