// A stand-in for Whop's API (https://docs.whop.com/api-reference), for tests and offline QA. Nothing here calls
// Whop or a network beyond the webhook URLs it is given. One instance is one environment (sandbox or production):
// two instances share nothing, as Whop's two environments don't.
//
//   node server/test/mock-whop.mjs [port] [sandbox|production]   → prints its API base (…/api/v1)
//   const mock = await createMockWhop({ environment: 'sandbox' }).start();   mock.apiBase
//
// Auth: "Authorization: Bearer <key>" for a key registered with POST /__keys {key, accountId, permissions[]}
// (mock.addKey(...)); anything else 401 {error:{type:'unauthorized'}}. A call without the permission it needs answers
// 403 insufficient_scope (some of them as {error:{code}} with no type, as Whop's docs show once). account_id must be
// the key's own account (else 404).
//
// What it answers (under /api/v1):
//   GET  /products?account_id=&first=&after=                       access_pass:basic:read
//   GET  /variants?account_id=&product_ids=&first=&after=          plan:basic:read
//   POST /checkout_configurations {account_id, variant_id | variant, metadata, redirect_url}
//                                                                  checkout_configuration:create; metadata reads back
//                                                                  null without checkout_configuration:basic:read
//   POST /webhooks {url, events, resource_id, api_version_date}, GET /webhooks?resource_id=, GET|PATCH|DELETE
//        /webhooks/:id, POST /webhooks/:id/test                    developer:manage_webhook; webhook_secret only in
//                                                                  the create answer
//   GET  /payments?account_id=&created_after=&first=&after=        payment:basic:read
// Cursor pagination: { data, page_info: { end_cursor, has_next_page } }. Idempotency-Key on any POST: the same key
// with the same body answers the first answer again (Idempotent-Replayed: true) without doing anything; a different
// body 400 idempotency_key_mismatch; while the first is still running (hold()) 409 idempotency_request_in_progress.
//
// Test hooks (no key; also as methods on the returned object):
//   POST /__keys {key, accountId, permissions}         register a key
//   POST /__seed {accountId, products: [{title, visibility?, plans: [{title, initial_price, currency, ...}]}]}
//   POST /__pay {checkoutId, email?, amount?, status?, deliver?}   a buyer pays: a Payment carrying the checkout's
//                                                      metadata, then payment.succeeded (or the status's event)
//   POST /__refund {paymentId, amount?, full?}         refund.created (data.payment is {id} only, unless full)
//   POST /__dispute {paymentId}                        dispute.created
//   POST /__deliver {eventId, times?, sig?: 'bad'|'stale'}   deliver a sent event again (same webhook-id)
//   POST /__disable {webhookId}                        Whop turned the webhook off (delivery_failures)
//   POST /__fail {path, status?, timeout?, count?}     the next `count` calls to "METHOD /path" fail with `status`
//                                                      (as Whop's error), or, with timeout, are DONE and then the
//                                                      connection is dropped (the "did it go through?" case)
//   POST /__ratelimit {path}                           the next call to that path: 429 "Try again in 12 seconds."
//   POST /__hold / /__release                          the next checkout create waits until released
//   POST /__purchaseUrl {url}                          the next checkout answers this purchase_url (tests' tampering)
//   GET  /__calls                                      every API call {method, path, idempotencyKey} (never the key)
//
// Webhooks are signed with the server's own whopHmacKey (server/payments/whopWebhook.mjs), Standard Webhooks style.

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { signWhopPayload } from '../payments/whopWebhook.mjs';

const rid = (prefix, n = 14) => `${prefix}_${crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n)}`;
const API_VERSION_DATE = '2026-08-14';

export function createMockWhop({ environment = 'sandbox', now = () => Date.now() } = {}) {
  const keys = new Map(); // key → { accountId, permissions:Set }
  const products = []; // { id, account_id, title, visibility, created_at }
  const variants = []; // { id, product_id, account_id, ... }
  const checkouts = new Map(); // ch_ → config
  const webhooks = new Map(); // hook_ → { id, url, events, resource_id, enabled, secret, api_version_date, disabled_reason }
  const payments = new Map(); // pay_ → payment
  const events = new Map(); // msg_ → { event, raw }
  const deliveries = []; // { webhookId, eventId, status, sig }
  const calls = [];
  const idem = new Map(); // `${key}|${idemKey}` → { hash, status, body } | { running: true, hash }
  const faults = []; // { route, status, timeout, count }
  const rateLimits = new Set();
  let held = null; // { promise, release }
  let nextPurchaseUrl = null;
  let server;
  let base = '';
  const checkoutHost = environment === 'production' ? 'whop.com' : 'sandbox.whop.com';
  const iso = () => new Date(now()).toISOString();

  // ── state helpers (also used by the HTTP hooks) ──
  function addKey(key, accountId, permissions = []) {
    keys.set(key, { accountId, permissions: new Set(permissions) });
  }
  function seed(accountId, list = []) {
    const out = [];
    for (const p of list) {
      const prod = { id: p.id ?? rid('prod'), account_id: accountId, title: p.title ?? 'Product', visibility: p.visibility ?? 'visible', created_at: iso() };
      products.push(prod);
      const plans = [];
      for (const v of p.plans ?? []) {
        const plan = {
          id: v.id ?? rid('plan'),
          product: { id: prod.id, title: prod.title },
          account_id: accountId,
          title: v.title ?? '',
          plan_type: v.plan_type ?? (v.billing_period ? 'renewal' : 'one_time'),
          initial_price: v.initial_price ?? 0,
          renewal_price: v.renewal_price ?? null,
          billing_period: v.billing_period ?? null,
          trial_period_days: v.trial_period_days ?? null,
          currency: v.currency ?? 'usd',
          visibility: v.visibility ?? 'visible',
          created_at: iso(),
        };
        variants.push(plan);
        plans.push(plan);
      }
      out.push({ ...prod, plans });
    }
    return out;
  }

  /** Sign and POST an event to every enabled webhook of its account (or just `only`). → [{ webhookId, status }] */
  async function deliver(eventId, { sig = 'good', only = null } = {}) {
    const stored = events.get(eventId);
    if (!stored) return [];
    const out = [];
    for (const h of webhooks.values()) {
      if (only ? h.id !== only : !h.enabled || h.resource_id !== stored.account || !h.events.includes(stored.event.type)) continue;
      const envelope = { ...stored.event };
      // an unpinned (or older) webhook still says company_id
      if (!(h.api_version_date >= API_VERSION_DATE)) {
        envelope.company_id = envelope.account_id;
        delete envelope.account_id;
      }
      const raw = JSON.stringify(envelope);
      const ts = String(Math.floor((sig === 'stale' ? now() - 600_000 : now()) / 1000));
      const signature = sig === 'bad' ? signWhopPayload(raw, eventId, ts, `${h.secret}x`) : signWhopPayload(raw, eventId, ts, h.secret);
      let status = 0;
      try {
        const res = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': ts, 'webhook-signature': signature }, body: raw, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        status = res.status;
        await res.text().catch(() => '');
      } catch {
        status = 0;
      }
      deliveries.push({ webhookId: h.id, eventId, status, sig });
      out.push({ webhookId: h.id, status });
    }
    return out;
  }

  function newEvent(type, account, data) {
    const event = { id: rid('msg', 20), type, api_version: 'v1', api_version_date: API_VERSION_DATE, timestamp: iso(), account_id: account, data };
    events.set(event.id, { event, account });
    return event;
  }

  const money = (minor, currency) => ({ amount: (minor / 100).toFixed(2), currency, decimals: 2 });

  async function pay({ checkoutId, email = 'buyer@example.com', amount = null, status = 'paid', deliver: send = true } = {}) {
    const ch = checkouts.get(checkoutId);
    if (!ch) return null;
    const plan = variants.find((v) => v.id === ch.variant_id);
    const minor = amount ?? Math.round(Number(plan?.initial_price ?? 10) * 100);
    const currency = plan?.currency ?? 'usd';
    const p = {
      id: rid('pay'),
      account_id: ch.account_id,
      status,
      total: money(minor, currency),
      subtotal: money(minor, currency),
      amount_after_fees: money(Math.round(minor * 0.94), currency),
      currency,
      metadata: ch.metadata,
      checkout_configuration_id: ch.id,
      variant_id: ch.variant_id,
      product_id: plan?.product?.id ?? null,
      membership_id: rid('mem'),
      customer_email: keys.size && [...keys.values()].some((k) => k.accountId === ch.account_id && k.permissions.has('member:email:read')) ? email : null,
      refunded_amount: money(0, currency),
      paid_at: status === 'paid' ? iso() : null,
      created_at: iso(),
    };
    payments.set(p.id, p);
    const type = status === 'paid' ? 'payment.succeeded' : status === 'pending' ? 'payment.pending' : 'payment.failed';
    const event = newEvent(type, ch.account_id, p);
    const sent = send ? await deliver(event.id) : [];
    return { payment: p, event, deliveries: sent };
  }

  async function refund({ paymentId, amount = null, full = false } = {}) {
    const p = payments.get(paymentId);
    if (!p) return null;
    const total = Math.round(Number(p.total.amount) * 100);
    const minor = amount ?? total;
    const already = Math.round(Number(p.refunded_amount.amount) * 100);
    p.refunded_amount = money(Math.min(total, already + minor), p.currency);
    const r = { id: rid('rfnd'), amount: money(minor, p.currency), status: 'succeeded', created_at: iso(), payment: full ? { ...p } : { id: p.id } };
    const event = newEvent('refund.created', p.account_id, r);
    return { refund: r, event, deliveries: await deliver(event.id) };
  }

  async function dispute({ paymentId } = {}) {
    const p = payments.get(paymentId);
    if (!p) return null;
    const d = { id: rid('dspt'), status: 'needs_response', amount: p.total, payment: { id: p.id }, created_at: iso() };
    const event = newEvent('dispute.created', p.account_id, d);
    return { dispute: d, event, deliveries: await deliver(event.id) };
  }

  // ── HTTP ──
  function send(res, status, body, headers = {}) {
    if (res.destroyed) return;
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(data);
  }
  const err = (res, status, type, message, { codeOnly = false } = {}) => send(res, status, { error: codeOnly ? { code: type, message } : { type, message } });

  const page = (list, url) => {
    const first = Math.min(100, Math.max(1, Number(url.searchParams.get('first')) || 10));
    const after = url.searchParams.get('after');
    const start = after ? Number(Buffer.from(after, 'base64').toString('utf8')) || 0 : 0;
    const data = list.slice(start, start + first);
    const end = start + data.length;
    return { data, page_info: { end_cursor: data.length ? Buffer.from(String(end)).toString('base64') : null, has_next_page: end < list.length } };
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  async function hooks(req, res, url, raw) {
    let b = {};
    try {
      b = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: 'bad json' });
    }
    const p = url.pathname;
    if (p === '/__calls') return send(res, 200, calls);
    if (p === '/__keys') return send(res, 200, (addKey(b.key, b.accountId, b.permissions ?? []), { ok: true }));
    if (p === '/__seed') return send(res, 200, { products: seed(b.accountId, b.products) });
    if (p === '/__pay') return send(res, 200, (await pay(b)) ?? { error: 'no such checkout' });
    if (p === '/__refund') return send(res, 200, (await refund(b)) ?? { error: 'no such payment' });
    if (p === '/__dispute') return send(res, 200, (await dispute(b)) ?? { error: 'no such payment' });
    if (p === '/__deliver') {
      const out = [];
      for (let i = 0; i < (b.times ?? 1); i++) out.push(...(await deliver(b.eventId, { sig: b.sig ?? 'good' })));
      return send(res, 200, { deliveries: out });
    }
    if (p === '/__disable') {
      const h = webhooks.get(b.webhookId);
      if (h) Object.assign(h, { enabled: false, disabled_reason: 'delivery_failures' });
      return send(res, 200, { ok: !!h });
    }
    if (p === '/__fail') return send(res, 200, (faults.push({ route: b.path, status: b.status ?? 500, timeout: !!b.timeout, count: b.count ?? 1 }), { ok: true }));
    if (p === '/__ratelimit') return send(res, 200, (rateLimits.add(b.path), { ok: true }));
    if (p === '/__hold') return send(res, 200, (api.hold(), { ok: true }));
    if (p === '/__release') return send(res, 200, (api.release(), { ok: true }));
    if (p === '/__purchaseUrl') return send(res, 200, ((nextPurchaseUrl = b.url), { ok: true }));
    return send(res, 404, { error: 'no hook' });
  }

  const route = (method, path) => {
    const p = path.replace(/^\/api\/v1/, '');
    return `${method} ${p.replace(/\/(hook|ch|pay|prod|plan)_[A-Za-z0-9]+/g, '/:id')}`;
  };

  async function handler(req, res) {
    const url = new URL(req.url, 'http://mock');
    const raw = await readBody(req);
    if (url.pathname.startsWith('/__')) return hooks(req, res, url, raw);
    if (!url.pathname.startsWith('/api/v1/')) return err(res, 404, 'not_found', 'Not found.');
    const r = route(req.method, url.pathname);
    const idemKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
    calls.push({ method: req.method, path: url.pathname.replace(/^\/api\/v1/, ''), route: r, idempotencyKey: idemKey, apiVersionDate: req.headers['api-version-date'] ?? null });
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const who = bearer ? keys.get(bearer) : null;
    if (!who) return err(res, 401, 'unauthorized', 'Invalid API key.');
    if (rateLimits.has(r)) {
      rateLimits.delete(r);
      return err(res, 429, 'rate_limit_exceeded', 'Try again in 12 seconds.');
    }
    const fault = faults.find((f) => f.route === r && f.count > 0);
    if (fault) fault.count--;
    if (fault && !fault.timeout) return err(res, fault.status, fault.status >= 500 ? 'server_error' : 'invalid_parameters', 'Injected failure (mock).');
    const dropAfter = !!fault?.timeout;
    // the request is done, then the connection drops before the answer
    const reply = (status, body, headers) => (dropAfter ? res.destroy() : send(res, status, body, headers));
    const need = (perm, codeOnly = false) => {
      if (who.permissions.has(perm)) return true;
      err(res, 403, 'insufficient_scope', `Missing permission ${perm}.`, { codeOnly });
      return false;
    };
    const ownAccount = (id) => {
      if (id === who.accountId) return true;
      err(res, 404, 'not_found', 'Account not found.');
      return false;
    };
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return err(res, 400, 'invalid_json', 'Bad JSON.');
      }
    }

    // idempotency for POSTs
    let idemSlot = null;
    if (req.method === 'POST' && idemKey) {
      const slotKey = `${bearer}|${idemKey}`;
      const hash = crypto.createHash('sha256').update(`${url.pathname}\n${raw}`).digest('hex');
      const seen = idem.get(slotKey);
      if (seen) {
        if (seen.hash !== hash) return err(res, 400, 'idempotency_key_mismatch', 'This key was used with a different request.');
        if (seen.running) return err(res, 409, 'idempotency_request_in_progress', 'A request with this key is still running.');
        return send(res, seen.status, seen.body, { 'idempotent-replayed': 'true' });
      }
      idemSlot = { hash, running: true };
      idem.set(slotKey, idemSlot);
    }
    const done = (status, body2, headers) => {
      if (idemSlot) Object.assign(idemSlot, { running: false, status, body: body2 });
      reply(status, body2, headers);
    };
    const fails = (status, type, message, opts) => {
      // a refused request isn't stored (it may be sent again)
      if (idemSlot) idem.delete(`${bearer}|${idemKey}`);
      err(res, status, type, message, opts);
    };

    const p = url.pathname.replace(/^\/api\/v1/, '');
    let m;
    if (req.method === 'GET' && p === '/products') {
      if (!need('access_pass:basic:read') || !ownAccount(url.searchParams.get('account_id'))) return;
      return reply(200, page(products.filter((x) => x.account_id === who.accountId), url));
    }
    if (req.method === 'GET' && p === '/variants') {
      if (!need('plan:basic:read', true) || !ownAccount(url.searchParams.get('account_id'))) return;
      const ids = url.searchParams.getAll('product_ids').flatMap((s) => s.split(','));
      return reply(200, page(variants.filter((v) => v.account_id === who.accountId && (!ids.length || ids.includes(v.product.id))), url));
    }
    if (req.method === 'POST' && p === '/checkout_configurations') {
      if (!who.permissions.has('checkout_configuration:create')) return fails(403, 'insufficient_scope', 'Missing permission checkout_configuration:create.');
      if (body.account_id !== who.accountId) return fails(404, 'not_found', 'Account not found.');
      if (!!body.variant_id === !!body.variant) return fails(400, 'invalid_parameters', 'Give variant_id or variant.');
      const plan = variants.find((v) => v.id === body.variant_id && v.account_id === who.accountId);
      if (body.variant_id && !plan) return fails(422, 'invalid_parameters', 'Variant not found.');
      if (held) await held.promise;
      const id = rid('ch');
      const config = { id, account_id: who.accountId, variant_id: body.variant_id ?? null, metadata: body.metadata ?? null, redirect_url: body.redirect_url ?? null, purchase_url: nextPurchaseUrl ?? `https://${checkoutHost}/checkout/${id}/`, created_at: iso() };
      nextPurchaseUrl = null;
      checkouts.set(id, config);
      return done(200, { ...config, metadata: who.permissions.has('checkout_configuration:basic:read') ? config.metadata : null });
    }
    if (p === '/webhooks' || (m = /^\/webhooks\/(hook_[A-Za-z0-9]+)(\/test)?$/.exec(p))) {
      if (!who.permissions.has('developer:manage_webhook')) return req.method === 'POST' ? fails(403, 'insufficient_scope', 'Missing permission developer:manage_webhook.') : err(res, 403, 'insufficient_scope', 'Missing permission developer:manage_webhook.');
      const view = (h) => ({ id: h.id, url: h.url, events: h.events, resource_id: h.resource_id, enabled: h.enabled, disabled_reason: h.disabled_reason ?? null, api_version_date: h.api_version_date ?? null, created_at: h.created_at });
      if (p === '/webhooks' && req.method === 'POST') {
        if (body.resource_id !== who.accountId) return fails(404, 'not_found', 'Account not found.');
        let u;
        try {
          u = new URL(String(body.url));
        } catch {
          return fails(422, 'invalid_parameters', 'Bad url.');
        }
        if (u.protocol !== 'https:' && !process.env.MOCK_WHOP_ALLOW_HTTP && !api.allowHttp) return fails(422, 'invalid_parameters', 'The url must be https and public.');
        const h = { id: rid('hook'), url: body.url, events: Array.isArray(body.events) ? body.events : [], resource_id: body.resource_id, enabled: true, secret: `ws_${crypto.randomBytes(24).toString('hex')}`, api_version_date: body.api_version_date ?? null, created_at: iso() };
        webhooks.set(h.id, h);
        return done(200, { ...view(h), webhook_secret: h.secret });
      }
      if (p === '/webhooks' && req.method === 'GET') return reply(200, page([...webhooks.values()].filter((h) => h.resource_id === url.searchParams.get('resource_id') && h.resource_id === who.accountId).map(view), url));
      const h = m ? webhooks.get(m[1]) : null;
      if (!h || h.resource_id !== who.accountId) return req.method === 'POST' ? fails(404, 'not_found', 'Webhook not found.') : err(res, 404, 'not_found', 'Webhook not found.');
      if (m[2] && req.method === 'POST') {
        const event = newEvent('payment.succeeded', h.resource_id, { id: rid('pay'), test: true, account_id: h.resource_id, status: 'paid', total: money(100, 'usd'), currency: 'usd', metadata: {} });
        const out = await deliver(event.id, { only: h.id });
        return done(200, { ok: true, deliveries: out });
      }
      if (req.method === 'GET') return reply(200, view(h));
      if (req.method === 'PATCH') {
        if (typeof body.enabled === 'boolean') Object.assign(h, { enabled: body.enabled, disabled_reason: body.enabled ? null : h.disabled_reason });
        return reply(200, view(h));
      }
      if (req.method === 'DELETE') {
        webhooks.delete(h.id);
        return reply(200, { ok: true });
      }
    }
    if (req.method === 'GET' && p === '/payments') {
      if (!need('payment:basic:read') || !ownAccount(url.searchParams.get('account_id'))) return;
      const after = Date.parse(url.searchParams.get('created_after') ?? '') || 0;
      return reply(200, page([...payments.values()].filter((x) => x.account_id === who.accountId && Date.parse(x.created_at) >= after), url));
    }
    return err(res, 404, 'not_found', 'Not found.');
  }

  const api = {
    environment,
    allowHttp: false,
    get base() {
      return base;
    },
    /** what a client uses as Whop's API base */
    get apiBase() {
      return `${base}/api/v1`;
    },
    checkoutHost,
    calls,
    deliveries,
    webhooks,
    checkouts,
    payments,
    events,
    addKey,
    seed,
    pay,
    refund,
    dispute,
    deliver,
    /** API calls that write (POST/PATCH/DELETE), optionally of one route ("POST /checkout_configurations"). */
    writes: (r = null) => calls.filter((c) => c.method !== 'GET' && (!r || c.route === r)),
    fail(path, { status = 500, timeout = false, count = 1 } = {}) {
      faults.push({ route: path, status, timeout, count });
    },
    rateLimit(path) {
      rateLimits.add(path);
    },
    hold() {
      let release;
      const promise = new Promise((r) => (release = r));
      held = { promise, release };
    },
    release() {
      held?.release();
      held = null;
    },
    setPurchaseUrl(u) {
      nextPurchaseUrl = u;
    },
    disable(webhookId) {
      const h = webhooks.get(webhookId);
      if (h) Object.assign(h, { enabled: false, disabled_reason: 'delivery_failures' });
    },
    async start(port = 0) {
      server = http.createServer((req, res) => void handler(req, res).catch(() => send(res, 500, { error: { type: 'server_error', message: 'mock failure' } })));
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return api;
    },
    async close() {
      api.release();
      server?.closeAllConnections?.();
      await new Promise((r) => (server ? server.close(() => r()) : r()));
    },
  };
  return api;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockWhop({ environment: process.argv[3] === 'production' ? 'production' : 'sandbox' }).start(Number(process.argv[2] || 0));
  mock.allowHttp = true;
  console.log(mock.apiBase);
}
