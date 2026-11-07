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
//        subscription starts trialing), payment_intent_data[application_fee_amount]), GET /checkout/sessions/:id,
//        GET /checkout/sessions?customer=&status=, POST /checkout/sessions/:id/expire (only an open one)
//   GET /subscriptions/:id, GET /subscriptions?customer=&status=, POST /subscriptions/:id (items[n][id|price|
//        quantity|deleted], cancel_at_period_end, proration_behavior, payment_behavior, metadata),
//        DELETE /subscriptions/:id. Subscriptions carry current_period_* on each item too (the basil API version),
//        billing_cycle_anchor and trial_end (a change of interval starts a new period now). A change with
//        proration_behavior=always_invoice makes a paid invoice ($0 while the subscription is trialing, as Stripe bills
//        items added during a free trial); a customer whose card declines (POST /__customers/decline): with
//        payment_behavior=error_if_incomplete it answers 402 card_declined and changes nothing, otherwise (Stripe's
//        default, allow_incomplete) the change is made, its invoice stays open and the subscription goes past_due.
//        trial_end=now ends a trial at once (active with a paid invoice; a declining card: the same two outcomes);
//        cancellation_details[feedback|comment] is kept on the subscription. DELETE takes its params in the query
//        (invoice_now, prorate, cancellation_details[…]) like Stripe's libraries send them.
//   GET /payment_methods/:id (card.fingerprint, card.brand, card.last4)
//   POST /subscription_items/:id (quantity, proration_behavior, payment_behavior)
//   POST /billing_portal/sessions (customer, return_url, configuration)
//   POST /billing_portal/configurations (features[…], business_profile[…]), GET /billing_portal/configurations/:id
//   GET /invoices/:id
//   POST /accounts (Connect: controller, capabilities[…][requested] (→ inactive), business_profile, metadata, country
//        (two letters), email; requirements and default_currency like Stripe's), GET /accounts/:id,
//        GET /accounts?limit=&starting_after= (newest first), POST /accounts/:id (business_profile, metadata; identity
//        fields refused after the first Account Link), POST /account_links (account, refresh_url, return_url, type:
//        account_update refused for a full-Dashboard account; each url single-use: /__onboard/<acct>/<nonce>)
//   GET /events/:id, GET /events
//   Connect payments (with Stripe-Account): POST /checkout/sessions with line_items[n][price_data][currency|unit_amount|
//        product_data[name]] (account_invalid unless the account's charges are enabled; application_fee_amount a
//        positive integer below the amount, refused for a BR account (the mock platform is US); automatic_tax only with
//        active tax settings; expires_at 30 minutes to 24 hours ahead), GET /checkout/sessions/:id (expand[]=
//        payment_intent, payment_intent.latest_charge), GET /checkout/sessions?created[gte]=&limit=,
//        GET /payment_intents/:id, GET /charges/:id (expand[]=refunds), POST /refunds {charge|payment_intent, amount,
//        refund_application_fee, metadata}, GET /disputes/:id, GET /tax/settings
//   Application fees (platform only; with Stripe-Account 400): GET /application_fees/:id,
//        POST /application_fees/:id/refunds {amount (≤ what's left), metadata}, GET /application_fees/:id/refunds
//
// Test hooks (no key):
//   GET  /__calls                                         every API call {method, path, account, idempotencyKey,
//                                                          query?}
//   POST /__checkout/complete {id, account?, paid?, card?}  card: a card fingerprint (default: a new one each time),
//                                                          the subscription's default_payment_method
//                                                          finishes a Checkout Session: a subscription (mode
//                                                          subscription) with one item per line, or a paid payment;
//                                                          sends checkout.session.completed (+ customer.subscription.
//                                                          created), signed, to the webhook URL
//   POST /__subscriptions/status {id, status, account?, cancellation_details?}    e.g. past_due / unpaid / canceled,
//                                                          with its event (cancel_at_period_end: true sets that,
//                                                          as a Customer Portal cancel does)
//   POST /__subscriptions/renew {id, account?}             the period rolls forward one interval (customer.subscription.
//                                                          updated + invoice.paid)
//   POST /__invoices/fail {subscription, account?}         a renewal payment fails: an open invoice, the subscription
//                                                          past_due, invoice.payment_failed + customer.subscription.updated
//   POST /__customers/decline {id, account?, on?}          the customer's card declines (on: false lifts it)
//   POST /__accounts/enable {id}                           charges_enabled + details_submitted, capabilities active,
//                                                          requirements cleared, account.updated
//   POST /__accounts/requirements {id, currently_due?, past_due?, eventually_due?, disabled_reason?, details_submitted?,
//                                  charges_enabled?}       account.updated
//   POST /__accounts/deauthorize {id}                      account.application.deauthorized; afterwards that
//                                                          Stripe-Account answers 403
//   POST /__checkout/complete {id, account, paid?, async?, email?}   (mode payment on a connected account) a
//                                                          PaymentIntent and a Charge on the account, an application
//                                                          fee on the platform; checkout.session.completed (Connect)
//                                                          + application_fee.created (platform). async: unpaid until
//   POST /__checkout/async {id, account, succeeded}        checkout.session.async_payment_succeeded | _failed
//   POST /__charges/refund {charge, account, amount?}      a refund from the seller's Dashboard (our fee stays):
//                                                          charge.refunded
//   POST /__charges/dispute {charge, account, amount?}     charge.dispute.created (needs_response)
//   POST /__disputes/close {id, account, status: won|lost} charge.dispute.closed + .funds_reinstated | .funds_withdrawn
//   POST /__tax/active {account, on}                       the account's tax settings active (or pending)
//   POST /__fail {route, mode, times}                      the next `times` calls to `route` (e.g. "POST
//                                                          /v1/subscriptions/:id") fail: card_declined (402),
//                                                          permission (403: a restricted key without that
//                                                          permission), server (500), rate_limit (429) or timeout (the request
//                                                          is DONE, then the connection is dropped: the "did it go
//                                                          through?" case a caller must read back, never resend)
//
// Webhooks: platform events go to webhookUrl signed with webhookSecret; events of a connected account (`account`
// set) go to connectWebhookUrl signed with connectWebhookSecret, as Stripe's Connect endpoints do.
//
// signStripeHeader(payload, secret, t) makes a valid Stripe-Signature header (t=…,v1=HMAC-SHA256 of "t.payload");
// verifyStripeHeader(payload, header, secret, toleranceSec) checks one, as Stripe's libraries do.

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const TEST_STRIPE_KEY = 'sk_test_mock_0000000000000000000000';
export const TEST_STRIPE_WEBHOOK_SECRET = 'whsec_test_mock_000000000000000000';
export const TEST_STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_test_mock_connect_000000000000';

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

const PREFIX = { charge: 'ch', application_fee: 'fee', fee_refund: 'fr', refund: 're', dispute: 'dp', application: 'ca', payment_method: 'pm', customer: 'cus', product: 'prod', price: 'price', 'checkout.session': 'cs_test', subscription: 'sub', subscription_item: 'si', 'billing_portal.session': 'bps', 'billing_portal.configuration': 'bpc', account: 'acct', account_link: 'al', event: 'evt', payment_intent: 'pi', invoice: 'in' };
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
/** expand[]=a, expand[0]=a or expand=a, as Stripe takes them. */
const expandOf = (query) => [...query.entries()].filter(([k]) => /^expand(\[\d*\])?$/.test(k)).map(([, v]) => v);

export function createMockStripe({ key = TEST_STRIPE_KEY, webhookSecret = TEST_STRIPE_WEBHOOK_SECRET, webhookUrl = '', connectWebhookSecret = TEST_STRIPE_CONNECT_WEBHOOK_SECRET, connectWebhookUrl = '', now = () => Date.now() } = {}) {
  /** objects per account: '' is the platform, acct_… a connected account */
  const realms = new Map();
  const realm = (account = '') => {
    if (!realms.has(account)) realms.set(account, { paymentMethods: new Map(), customers: new Map(), products: new Map(), prices: new Map(), sessions: new Map(), subscriptions: new Map(), items: new Map(), invoices: new Map(), portalConfigs: new Map(), paymentIntents: new Map(), charges: new Map(), refunds: new Map(), disputes: new Map(), applicationFees: new Map(), declining: new Set(), taxActive: false, events: [] });
    return realms.get(account);
  };
  const accounts = new Map();
  /** single-use onboarding links: nonce → { account, used } */
  const onboardLinks = new Map();
  /** accounts that removed the platform: their Stripe-Account answers 403 */
  const deauthorized = new Set();
  const PLATFORM_COUNTRY = 'US';
  const idempotency = new Map();
  const calls = [];
  const deliveries = [];
  const faults = [];
  let hookUrl = webhookUrl;
  let connectHookUrl = connectWebhookUrl;
  let server = null;
  let base = '';
  const sec = () => Math.floor(now() / 1000);

  // ───────── events ─────────
  async function emit(type, object, account = '', previous = null) {
    const evt = { id: newId('event'), object: 'event', api_version: '2025-06-30.basil', created: sec(), type, livemode: false, pending_webhooks: 1, data: { object: structuredClone(object), ...(previous ? { previous_attributes: previous } : {}) }, ...(account ? { account } : {}) };
    realm(account).events.unshift(evt);
    const raw = JSON.stringify(evt);
    // a connected account's events go to the Connect endpoint, signed with its own secret
    const header = signStripeHeader(raw, account ? connectWebhookSecret : webhookSecret, sec());
    const delivery = { event: evt, raw, header, status: 0, connect: !!account };
    deliveries.push(delivery);
    const target = account ? connectHookUrl : hookUrl;
    if (target) {
      try {
        const res = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: raw });
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

  function newSubscription(r, { customer, lines, metadata = {}, status = 'active', trialDays = 0, paymentMethod = null }) {
    const start = sec();
    const trialEnd = trialDays > 0 ? start + trialDays * 86400 : null;
    const sub = { id: newId('subscription'), object: 'subscription', customer, status: trialEnd && status === 'active' ? 'trialing' : status, created: start, start_date: start, billing_cycle_anchor: trialEnd ?? start, current_period_start: start, current_period_end: start + 30 * 86400, trial_start: trialEnd ? start : null, trial_end: trialEnd, cancel_at_period_end: false, canceled_at: null, ended_at: null, cancellation_details: { comment: null, feedback: null, reason: null }, default_payment_method: paymentMethod, metadata, latest_invoice: null, livemode: false };
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
        // inline prices (price_data) are made as one-off prices on the realm, as Stripe does
        for (const l of lines) {
          if (!l.price && l.price_data) {
            const pd = l.price_data;
            if (!pd.currency || !/^[a-z]{3}$/.test(String(pd.currency))) return missing('line_items[0][price_data][currency]');
            if (!(int(pd.unit_amount) >= 0)) return missing('line_items[0][price_data][unit_amount]');
            if (!pd.product_data?.name && !pd.product) return missing('line_items[0][price_data][product_data][name]');
            const prod = { id: newId('product'), object: 'product', name: pd.product_data?.name ?? '', active: true, metadata: {}, created: sec() };
            r.products.set(prod.id, prod);
            const pr = { id: newId('price'), object: 'price', active: false, currency: String(pd.currency), unit_amount: int(pd.unit_amount), product: prod.id, lookup_key: null, nickname: null, recurring: null, type: 'one_time', metadata: {}, created: sec(), livemode: false };
            r.prices.set(pr.id, pr);
            l.price = pr.id;
          }
        }
        for (const l of lines) {
          if (!l.price) return missing('line_items[0][price]');
          const price = priceById(r, l.price);
          if (!price) return notFound('price', l.price);
          if (mode === 'subscription' && !price.recurring) return stripeError(400, 'invalid_request_error', 'You must provide at least one recurring price in `subscription` mode when using prices.', { param: 'line_items' });
        }
        if (body.customer && !r.customers.has(body.customer)) return notFound('customer', body.customer);
        const amount = lines.reduce((n, l) => n + (priceById(r, l.price)?.unit_amount ?? 0) * int(l.quantity, 1), 0);
        if (account) {
          const a = accounts.get(account);
          if (!a.charges_enabled) return stripeError(400, 'invalid_request_error', 'This account cannot currently make live charges.', { code: 'account_invalid' });
        }
        if (body.payment_intent_data?.application_fee_amount !== undefined) {
          const fee = int(body.payment_intent_data.application_fee_amount);
          if (!account) return stripeError(400, 'invalid_request_error', 'Can only apply an application_fee_amount when the request is made on behalf of another account.', { param: 'payment_intent_data[application_fee_amount]' });
          if (!(Number.isInteger(fee) && fee > 0 && fee < amount)) return stripeError(400, 'invalid_request_error', 'The application fee must be a positive integer less than the amount.', { param: 'payment_intent_data[application_fee_amount]' });
          if (accounts.get(account).country === 'BR' && PLATFORM_COUNTRY !== 'BR') return stripeError(400, 'invalid_request_error', 'Application fees aren’t supported for this account’s country.', { param: 'payment_intent_data[application_fee_amount]' });
        }
        if (bool(body.automatic_tax?.enabled) && !r.taxActive) return stripeError(400, 'invalid_request_error', 'Stripe Tax isn’t set up on this account.', { param: 'automatic_tax[enabled]', code: 'stripe_tax_inactive' });
        if (body.expires_at !== undefined) {
          const ahead = int(body.expires_at) - sec();
          if (!(ahead >= 30 * 60 && ahead <= 24 * 3600)) return stripeError(400, 'invalid_request_error', 'expires_at must be 30 minutes to 24 hours from now.', { param: 'expires_at' });
        }
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
          payment_method_collection: body.payment_method_collection ?? 'always',
          payment_method_types: Array.isArray(body.payment_method_types) ? body.payment_method_types : null,
          custom_text: body.custom_text ?? null,
          payment_intent_data: body.payment_intent_data ? { ...body.payment_intent_data, application_fee_amount: int(body.payment_intent_data.application_fee_amount) } : null,
          automatic_tax: { enabled: bool(body.automatic_tax?.enabled) },
          customer_details: null,
          created: sec(),
          expires_at: int(body.expires_at) ?? sec() + 24 * 3600,
          livemode: false,
        };
        s.url = `${base}/__pay/${s.id}`;
        r.sessions.set(s.id, s);
        return { status: 200, body: s };
      }
      if (method === 'GET' && !sid) {
        const gte = int(query.get('created[gte]'));
        const all = [...r.sessions.values()].filter((s) => (!query.get('customer') || s.customer === query.get('customer')) && (!query.get('status') || s.status === query.get('status')) && (gte == null || s.created >= gte));
        return { status: 200, body: list(all.slice(0, int(query.get('limit'), 10)), '/v1/checkout/sessions') };
      }
      const s = r.sessions.get(sid);
      if (!s) return notFound('checkout.session', sid);
      if (method === 'GET' && !parts[3]) {
        const expand = expandOf(query);
        const out = structuredClone(s);
        if ((expand.includes('payment_intent') || expand.includes('payment_intent.latest_charge')) && s.payment_intent && r.paymentIntents.has(s.payment_intent)) {
          out.payment_intent = structuredClone(r.paymentIntents.get(s.payment_intent));
          if (expand.includes('payment_intent.latest_charge') && out.payment_intent.latest_charge) out.payment_intent.latest_charge = chargeView(r, r.charges.get(out.payment_intent.latest_charge), false);
        }
        return { status: 200, body: out };
      }
      if (method === 'POST' && parts[3] === 'expire') {
        // like Stripe: only an open session can be expired
        if (s.status !== 'open') return stripeError(400, 'invalid_request_error', `This Checkout Session is ${s.status}, so it can't be expired.`, { code: 'checkout_session_not_open' });
        s.status = 'expired';
        s.url = null;
        return { status: 200, body: s };
      }
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
        if (body.cancellation_details) s.cancellation_details = { ...s.cancellation_details, reason: 'cancellation_requested', ...(body.cancellation_details.feedback ? { feedback: body.cancellation_details.feedback } : {}), ...(body.cancellation_details.comment ? { comment: String(body.cancellation_details.comment).slice(0, 5000) } : {}) };
        s.status = 'canceled';
        s.canceled_at = s.ended_at = sec();
        await emit('customer.subscription.deleted', subscriptionView(r, s), account);
        return { status: 200, body: subscriptionView(r, s) };
      }
      if (method === 'POST') {
        if (s.status === 'canceled') return stripeError(400, 'invalid_request_error', 'A canceled subscription can only update its cancellation_details and metadata.');
        // a change charged now with a card that declines: error_if_incomplete refuses it and nothing changes; Stripe's
        // default (allow_incomplete) makes the change, leaves its invoice open and the subscription past_due. Items
        // changed during a free trial are billed $0 (nothing to decline).
        const changesItems = Array.isArray(body.items) && body.items.length > 0;
        const inTrial = s.status === 'trialing' && body.trial_end !== 'now';
        const charged = (changesItems && body.proration_behavior === 'always_invoice' && !inTrial) || body.trial_end === 'now';
        const declines = charged && r.declining.has(s.customer);
        if (declines && body.payment_behavior === 'error_if_incomplete') {
          return { status: 402, body: { error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' } } };
        }
        const previous = {};
        const lenBefore = periodSec(r, s);
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
          s.cancellation_details = s.cancel_at_period_end ? { ...s.cancellation_details, reason: 'cancellation_requested' } : { comment: null, feedback: null, reason: null };
        }
        if (body.cancellation_details) {
          const FEEDBACK = ['customer_service', 'low_quality', 'missing_features', 'other', 'switched_service', 'too_complex', 'too_expensive', 'unused'];
          const fb = body.cancellation_details.feedback;
          if (fb !== undefined && fb !== '' && !FEEDBACK.includes(fb)) return stripeError(400, 'invalid_request_error', 'Invalid cancellation_details[feedback].', { param: 'cancellation_details[feedback]' });
          s.cancellation_details = { ...s.cancellation_details, ...(fb !== undefined ? { feedback: fb || null } : {}), ...(body.cancellation_details.comment !== undefined ? { comment: String(body.cancellation_details.comment).slice(0, 5000) || null } : {}) };
        }
        // a trial that ends now: charged at once (a declining card refuses it and nothing changes)
        if (body.trial_end === 'now') {
          if (s.status !== 'trialing') return stripeError(400, 'invalid_request_error', 'This subscription is not trialing.', { param: 'trial_end' });
          previous.status = s.status;
          previous.trial_end = s.trial_end;
          s.status = declines ? 'past_due' : 'active';
          s.trial_end = sec();
          s.current_period_start = s.billing_cycle_anchor = sec();
          s.current_period_end = s.current_period_start + periodSec(r, s);
          newInvoice(r, s, { reason: 'subscription_cycle', status: declines ? 'open' : 'paid' });
        }
        if (body.metadata) s.metadata = { ...s.metadata, ...body.metadata };
        // like Stripe: a change of billing interval starts a new period now (the billing cycle anchor resets)
        if (previous.items && periodSec(r, s) !== lenBefore) {
          previous.current_period_start = s.current_period_start;
          s.current_period_start = s.billing_cycle_anchor = sec();
          s.current_period_end = s.current_period_start + periodSec(r, s);
        }
        if (previous.items && body.proration_behavior === 'always_invoice') {
          newInvoice(r, s, { reason: 'subscription_update', ...(inTrial ? { amount: 0 } : {}), ...(declines ? { status: 'open' } : {}) });
          if (declines && s.status === 'active') {
            previous.status = s.status;
            s.status = 'past_due';
          }
        }
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

    if (res === 'payment_methods' && id && method === 'GET') {
      const pm = r.paymentMethods.get(id);
      if (!pm) return notFound('payment_method', id);
      return { status: 200, body: pm };
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
        const country = body.country ?? 'US';
        if (!/^[A-Z]{2}$/.test(String(country))) return stripeError(400, 'invalid_request_error', `Country '${country}' is unknown.`, { param: 'country', code: 'country_unsupported' });
        const capabilities = Object.fromEntries(Object.entries(body.capabilities ?? {}).map(([k, v]) => [k, bool(v?.requested) ? 'inactive' : 'unrequested']));
        const a = {
          id: newId('account'),
          object: 'account',
          type: body.type ?? null,
          controller: body.controller ?? null,
          country,
          email: body.email ?? null,
          business_profile: { name: null, url: null, ...(body.business_profile ?? {}) },
          settings: { dashboard: { display_name: body.business_profile?.name ?? null } },
          capabilities,
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          default_currency: { US: 'usd', GB: 'gbp', CA: 'cad', AU: 'aud', BR: 'brl', JP: 'jpy' }[country] ?? 'eur',
          requirements: { currently_due: ['business_profile.url', 'external_account', 'individual.dob.day', 'tos_acceptance.date'], eventually_due: ['business_profile.url', 'external_account', 'individual.dob.day', 'tos_acceptance.date'], past_due: [], pending_verification: [], disabled_reason: 'requirements.past_due', current_deadline: null },
          metadata: body.metadata ?? {},
          created: sec(),
          livemode: false,
        };
        accounts.set(a.id, a);
        return { status: 200, body: a };
      }
      if (method === 'GET' && !id) {
        const all = [...accounts.values()].reverse();
        const after = query.get('starting_after');
        const from = after ? all.findIndex((a) => a.id === after) + 1 : 0;
        const n = Math.min(100, int(query.get('limit'), 10));
        const page = all.slice(from, from + n);
        return { status: 200, body: { ...list(page, '/v1/accounts'), has_more: from + n < all.length } };
      }
      const a = accounts.get(id);
      if (!a) return notFound('account', id);
      if (method === 'GET') return { status: 200, body: a };
      if (method === 'POST') {
        // like Stripe: once onboarding has started, identity details are the account's own to change
        if (a.linked && ['email', 'individual', 'company', 'country'].some((k) => body[k] !== undefined)) return stripeError(400, 'invalid_request_error', 'This field can no longer be changed by the platform.', { code: 'account_update_not_allowed' });
        if (body.business_profile) a.business_profile = { ...a.business_profile, ...body.business_profile };
        if (body.metadata) a.metadata = { ...a.metadata, ...body.metadata };
        if (body.email !== undefined) a.email = body.email;
        return { status: 200, body: a };
      }
    }

    if (res === 'account_links' && method === 'POST') {
      if (account) return stripeError(400, 'invalid_request_error', 'Account Links are made by the platform.');
      if (!body.account) return missing('account');
      if (!accounts.has(body.account)) return notFound('account', body.account);
      for (const p of ['refresh_url', 'return_url', 'type']) if (!body[p]) return missing(p);
      const a = accounts.get(body.account);
      if (body.type === 'account_update' && a.controller?.stripe_dashboard?.type === 'full') return stripeError(400, 'invalid_request_error', 'You cannot create `account_update` type Account Links for accounts with access to the full Stripe Dashboard.', { param: 'type' });
      a.linked = true;
      const nonce = crypto.randomBytes(8).toString('hex');
      onboardLinks.set(nonce, { account: a.id, used: false, refresh: body.refresh_url, ret: body.return_url });
      return { status: 200, body: { object: 'account_link', created: sec(), expires_at: sec() + 300, url: `${base}/__onboard/${body.account}/${nonce}` } };
    }

    if (res === 'payment_intents' && id && method === 'GET') {
      const pi = r.paymentIntents.get(id);
      if (!pi) return notFound('payment_intent', id);
      return { status: 200, body: pi };
    }

    if (res === 'charges' && id && method === 'GET') {
      const ch = r.charges.get(id);
      if (!ch) return notFound('charge', id);
      const expand = expandOf(query);
      return { status: 200, body: chargeView(r, ch, expand.includes('refunds')) };
    }

    if (res === 'refunds' && method === 'POST' && !id) {
      const chId = body.charge ?? r.paymentIntents.get(body.payment_intent)?.latest_charge;
      const ch = chId ? r.charges.get(chId) : null;
      if (!ch) return body.charge ? notFound('charge', body.charge) : missing('charge');
      const amount = body.amount === undefined ? ch.amount - ch.amount_refunded : int(body.amount);
      if (!(amount > 0 && amount <= ch.amount - ch.amount_refunded)) return stripeError(400, 'invalid_request_error', 'Refund amount is greater than the charge’s remaining amount.', { param: 'amount', code: 'amount_too_large' });
      const refund = await refundCharge(account, ch, amount, { feeToo: bool(body.refund_application_fee), metadata: body.metadata ?? {} });
      return { status: 200, body: refund };
    }

    if (res === 'disputes' && id && method === 'GET') {
      const d = r.disputes.get(id);
      if (!d) return notFound('dispute', id);
      return { status: 200, body: d };
    }

    if (res === 'tax' && id === 'settings' && method === 'GET') {
      return { status: 200, body: { object: 'tax.settings', status: r.taxActive ? 'active' : 'pending', defaults: { tax_behavior: null, tax_code: null }, livemode: false } };
    }

    if (res === 'application_fees') {
      if (account) return stripeError(400, 'invalid_request_error', 'Application fees live on the platform account.');
      const fee = r.applicationFees.get(id);
      if (!fee) return notFound('application_fee', id);
      if (method === 'GET' && !sub) return { status: 200, body: fee };
      if (sub === 'refunds' && method === 'GET') return { status: 200, body: list(fee.refunds.data, `/v1/application_fees/${fee.id}/refunds`) };
      if (sub === 'refunds' && method === 'POST') {
        const amount = body.amount === undefined ? fee.amount - fee.amount_refunded : int(body.amount);
        if (!(amount > 0 && amount <= fee.amount - fee.amount_refunded)) return stripeError(400, 'invalid_request_error', 'Refund amount is greater than the application fee’s remaining amount.', { param: 'amount', code: 'amount_too_large' });
        const fr = refundFee(fee, amount, body.metadata ?? {});
        await emit('application_fee.refunded', fee, '');
        return { status: 200, body: fr };
      }
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
      if (url.pathname === '/__checkout/complete' && req.method === 'POST') return send(res, ...(await completeCheckout(b.id, b.account ?? '', b.paid !== false, b.card, { async: b.async === true, email: b.email })));
      if (url.pathname === '/__subscriptions/status' && req.method === 'POST') {
        const r = realm(b.account ?? '');
        const s = r.subscriptions.get(b.id);
        if (!s) return send(res, 404, { error: 'no such subscription' });
        const previous = { status: s.status };
        if (b.cancellation_details) s.cancellation_details = { ...s.cancellation_details, ...b.cancellation_details };
        if (b.cancel_at_period_end === true) {
          previous.cancel_at_period_end = s.cancel_at_period_end;
          s.cancel_at_period_end = true;
        }
        if (b.status) s.status = b.status;
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
        Object.assign(a, { charges_enabled: true, payouts_enabled: true, details_submitted: true, capabilities: Object.fromEntries(Object.keys(a.capabilities ?? {}).map((k) => [k, 'active'])), requirements: { currently_due: [], eventually_due: [], past_due: [], pending_verification: [], disabled_reason: null, current_deadline: null } });
        await emit('account.updated', a, a.id);
        return send(res, 200, a);
      }
      if (url.pathname === '/__accounts/requirements' && req.method === 'POST') {
        const a = accounts.get(b.id);
        if (!a) return send(res, 404, { error: 'no such account' });
        const q = a.requirements ?? {};
        a.requirements = { ...q, ...(b.currently_due ? { currently_due: b.currently_due } : {}), ...(b.eventually_due ? { eventually_due: b.eventually_due } : {}), ...(b.past_due ? { past_due: b.past_due } : {}), ...(b.pending_verification ? { pending_verification: b.pending_verification } : {}), ...(b.disabled_reason !== undefined ? { disabled_reason: b.disabled_reason } : {}) };
        if (typeof b.details_submitted === 'boolean') a.details_submitted = b.details_submitted;
        if (typeof b.charges_enabled === 'boolean') a.charges_enabled = b.charges_enabled;
        if (typeof b.payouts_enabled === 'boolean') a.payouts_enabled = b.payouts_enabled;
        await emit('account.updated', a, a.id);
        return send(res, 200, a);
      }
      if (url.pathname === '/__accounts/deauthorize' && req.method === 'POST') {
        const a = accounts.get(b.id);
        if (!a) return send(res, 404, { error: 'no such account' });
        deauthorized.add(a.id);
        await emit('account.application.deauthorized', { id: newId('application'), object: 'application', name: 'Mock platform' }, a.id);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/__checkout/async' && req.method === 'POST') return send(res, ...(await asyncCheckout(b.id, b.account ?? '', b.succeeded !== false)));
      if (url.pathname === '/__charges/refund' && req.method === 'POST') {
        const ch = realm(b.account ?? '').charges.get(b.charge);
        if (!ch) return send(res, 404, { error: 'no such charge' });
        const amount = b.amount ?? ch.amount - ch.amount_refunded;
        if (!(amount > 0 && amount <= ch.amount - ch.amount_refunded)) return send(res, 400, { error: 'bad amount' });
        return send(res, 200, await refundCharge(b.account ?? '', ch, amount, { feeToo: false }));
      }
      if (url.pathname === '/__charges/dispute' && req.method === 'POST') {
        const r = realm(b.account ?? '');
        const ch = r.charges.get(b.charge);
        if (!ch) return send(res, 404, { error: 'no such charge' });
        const d = { id: newId('dispute'), object: 'dispute', charge: ch.id, payment_intent: ch.payment_intent, amount: b.amount ?? ch.amount, currency: ch.currency, status: 'needs_response', reason: 'fraudulent', created: sec(), livemode: false };
        r.disputes.set(d.id, d);
        ch.disputed = true;
        await emit('charge.dispute.created', d, b.account ?? '');
        return send(res, 200, d);
      }
      if (url.pathname === '/__disputes/close' && req.method === 'POST') {
        const d = realm(b.account ?? '').disputes.get(b.id);
        if (!d) return send(res, 404, { error: 'no such dispute' });
        d.status = b.status === 'won' ? 'won' : 'lost';
        await emit('charge.dispute.closed', d, b.account ?? '');
        await emit(d.status === 'won' ? 'charge.dispute.funds_reinstated' : 'charge.dispute.funds_withdrawn', d, b.account ?? '');
        return send(res, 200, d);
      }
      if (url.pathname === '/__tax/active' && req.method === 'POST') {
        realm(b.account ?? '').taxActive = b.on !== false;
        return send(res, 200, { ok: true });
      }
      const onboard = /^\/__onboard\/(acct_[A-Za-z0-9]+)\/([0-9a-f]+)$/.exec(url.pathname);
      if (onboard) {
        const link = onboardLinks.get(onboard[2]);
        res.writeHead(200, { 'content-type': 'text/html' });
        if (!link || link.account !== onboard[1] || link.used) return res.end('<!doctype html><title>Stripe (mock)</title><p>This link has expired.</p>');
        link.used = true;
        return res.end('<!doctype html><title>Stripe (mock)</title><p>Mock onboarding.</p>');
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
    calls.push({ method, path: url.pathname, route, account: account || null, idempotencyKey: ikey, ...(url.search ? { query: url.search.slice(1) } : {}) });
    if (account && (!accounts.has(account) || deauthorized.has(account))) return send(res, 403, { error: { type: 'invalid_request_error', message: `The provided key does not have access to account '${account}' (or that account does not exist).` } });

    // Stripe's libraries send a DELETE's params in the query string
    const body = method === 'POST' ? parseForm(raw) : method === 'DELETE' ? parseForm(url.search.slice(1)) : {};
    // an Idempotency-Key replays the first answer (same request) or refuses a different one
    const fingerprint = `${method} ${url.pathname} ${account} ${raw}`;
    if (ikey && method === 'POST') {
      const seen = idempotency.get(`${account}:${ikey}`);
      if (seen && seen.fingerprint !== fingerprint) return send(res, 400, { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } });
      if (seen) return send(res, seen.status, seen.body, { 'idempotent-replayed': 'true' });
    }

    const fault = takeFault(route);
    if (fault === 'card_declined') return send(res, 402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' } });
    if (fault === 'permission') return send(res, 403, { error: { type: 'invalid_request_error', message: 'The provided key does not have the required permissions for this endpoint.' } });
    if (fault === 'server') return send(res, 500, { error: { type: 'api_error', message: 'Something went wrong on Stripe’s end.' } });
    if (fault === 'rate_limit') return send(res, 429, { error: { type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests.' } });

    const out = await api(method, parts, url.searchParams, body, account);
    if (ikey && method === 'POST' && out.status < 500) idempotency.set(`${account}:${ikey}`, { fingerprint, status: out.status, body: out.body });
    // the request went through; the caller never hears back
    if (fault === 'timeout') return void req.socket.destroy();
    return send(res, out.status, out.body);
  }

  /** A charge as the API shows it (refunds only when expanded, as Stripe's current versions do). */
  function chargeView(r, ch, withRefunds) {
    if (!ch) return null;
    const { disputed, ...out } = structuredClone(ch);
    out.disputed = !!disputed;
    out.refunds = withRefunds ? list([...r.refunds.values()].filter((x) => x.charge === ch.id), `/v1/charges/${ch.id}/refunds`) : undefined;
    if (!withRefunds) delete out.refunds;
    return out;
  }

  /** A fee refund on the platform (its amount from what's left), recorded on the fee. */
  function refundFee(fee, amount, metadata = {}) {
    const fr = { id: newId('fee_refund'), object: 'fee_refund', amount, currency: fee.currency, fee: fee.id, metadata, created: sec() };
    fee.refunds.data.unshift(fr);
    fee.amount_refunded += amount;
    fee.refunded = fee.amount_refunded >= fee.amount;
    return fr;
  }

  /** A refund of a connected account's charge: charge.refunded; with feeToo our fee goes back in proportion. */
  async function refundCharge(account, ch, amount, { feeToo = false, metadata = {} } = {}) {
    const r = realm(account);
    const refund = { id: newId('refund'), object: 'refund', amount, charge: ch.id, payment_intent: ch.payment_intent, currency: ch.currency, status: 'succeeded', metadata, created: sec() };
    r.refunds.set(refund.id, refund);
    ch.amount_refunded += amount;
    ch.refunded = ch.amount_refunded >= ch.amount;
    await emit('charge.refunded', chargeView(r, ch, true), account);
    if (feeToo && ch.application_fee) {
      const fee = realm('').applicationFees.get(ch.application_fee);
      const share = Math.min(fee.amount - fee.amount_refunded, Math.floor((fee.amount * amount) / ch.amount));
      if (share > 0) {
        refundFee(fee, share, {});
        await emit('application_fee.refunded', fee, '');
      }
    }
    return refund;
  }

  /** A paid payment on a connected account: its PaymentIntent and Charge there, our fee on the platform. */
  async function payOnAccount(account, s, email) {
    const r = realm(account);
    const fee = s.payment_intent_data?.application_fee_amount ?? null;
    const pi = r.paymentIntents.get(s.payment_intent);
    const ch = { id: newId('charge'), object: 'charge', amount: s.amount_total, amount_refunded: 0, refunded: false, currency: s.currency, payment_intent: pi.id, application_fee: null, application_fee_amount: fee, billing_details: { email }, status: 'succeeded', paid: true, created: sec(), livemode: false };
    if (fee) {
      const af = { id: newId('application_fee'), object: 'application_fee', account, amount: fee, amount_refunded: 0, refunded: false, currency: s.currency, charge: ch.id, originating_transaction: ch.id, refunds: { object: 'list', data: [], has_more: false }, created: sec(), livemode: false };
      realm('').applicationFees.set(af.id, af);
      ch.application_fee = af.id;
    }
    r.charges.set(ch.id, ch);
    Object.assign(pi, { status: 'succeeded', latest_charge: ch.id, amount_received: s.amount_total });
    return ch;
  }

  async function asyncCheckout(id, account, succeeded) {
    const r = realm(account);
    const s = r.sessions.get(id);
    if (!s || s.status !== 'complete' || s.payment_status !== 'unpaid') return [409, { error: 'not waiting' }];
    if (succeeded) {
      s.payment_status = 'paid';
      const ch = await payOnAccount(account, s, s.customer_details?.email ?? null);
      await emit('checkout.session.async_payment_succeeded', s, account);
      if (ch.application_fee) await emit('application_fee.created', realm('').applicationFees.get(ch.application_fee), '');
    } else {
      Object.assign(r.paymentIntents.get(s.payment_intent), { status: 'requires_payment_method' });
      await emit('checkout.session.async_payment_failed', s, account);
    }
    return [200, { session: s }];
  }

  async function completeCheckout(id, account = '', paid = true, card = undefined, { async: delayed = false, email } = {}) {
    const r = realm(account);
    const s = r.sessions.get(id);
    if (!s) return [404, { error: 'no such session' }];
    if (s.status !== 'open') return [409, { error: `session is ${s.status}` }];
    s.status = 'complete';
    s.payment_status = paid && !delayed ? 'paid' : 'unpaid';
    if (account && s.mode === 'payment') {
      const buyer = typeof email === 'string' && email ? email : 'buyer@example.com';
      s.customer_details = { email: buyer, name: null };
      const pi = { id: newId('payment_intent'), object: 'payment_intent', amount: s.amount_total, currency: s.currency, status: delayed ? 'processing' : 'requires_payment_method', application_fee_amount: s.payment_intent_data?.application_fee_amount ?? null, latest_charge: null, metadata: s.payment_intent_data?.metadata ?? {}, created: sec(), livemode: false };
      r.paymentIntents.set(pi.id, pi);
      s.payment_intent = pi.id;
      let ch = null;
      if (paid && !delayed) ch = await payOnAccount(account, s, buyer);
      await emit('checkout.session.completed', s, account);
      if (ch?.application_fee) await emit('application_fee.created', realm('').applicationFees.get(ch.application_fee), '');
      return [200, { session: s, charge: ch ? chargeView(r, ch, false) : null }];
    }
    if (!s.customer) {
      const c = { id: newId('customer'), object: 'customer', email: s.customer_email, name: null, metadata: {}, created: sec(), livemode: false };
      r.customers.set(c.id, c);
      s.customer = c.id;
    }
    let subscription = null;
    if (s.mode === 'subscription') {
      // the card the customer typed in: a payment method with its fingerprint (the same card twice, the same one)
      const pm = { id: newId('payment_method'), object: 'payment_method', type: 'card', customer: s.customer, card: { brand: 'visa', last4: '4242', fingerprint: typeof card === 'string' && card ? card : crypto.randomBytes(8).toString('hex') }, created: sec(), livemode: false };
      r.paymentMethods.set(pm.id, pm);
      subscription = newSubscription(r, { customer: s.customer, lines: s.line_items_input, metadata: s.subscription_data?.metadata ?? {}, status: paid ? 'active' : 'incomplete', trialDays: s.subscription_data?.trial_period_days ?? 0, paymentMethod: pm.id });
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
    set connectWebhookUrl(u) {
      connectHookUrl = u;
    },
    completeCheckout,
    emit,
    /** An event as Stripe would sign it, for calling a webhook handler directly: { raw, header, event }. */
    signed(type, object, { account = '', secret = account ? connectWebhookSecret : webhookSecret, t = sec(), livemode = false } = {}) {
      const event = { id: newId('event'), object: 'event', api_version: '2025-06-30.basil', created: t, type, livemode, data: { object }, ...(account ? { account } : {}) };
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
