// Whop for offers: each user connects their own Whop account (their account API key and biz_ id), picks a product and
// plan, and the server makes one checkout link for it. Sales come back only through that account's signed webhook.
// The routes are in server/offers/index.mjs; this is what they call.
//
// Connect: the key is checked with reads first (products, then plans), then saved sealed (server/offers/store.mjs),
// then one attempt at making the webhook (POST /webhooks, Idempotency-Key ylb-whop-webhook-<connection id>):
// made → its secret is sealed and kept ("auto"); refused (the key may not manage webhooks) → "manual": the owner makes
// it in Whop's dashboard and pastes its secret; unknown → "Check again" looks for ours (by URL) instead of sending it
// again. Nothing here is ever sent twice by itself.
//
// A checkout link is made once, when a plan is attached (POST /checkout_configurations with our offer id in metadata,
// Idempotency-Key ylb-offer-<offer id>); its answer is checked before it's stored. A click never calls Whop.
//
// The webhook (POST /api/webhooks/whop/<connection id>): per-IP limit, raw body (256 KB), the connection, the
// signature on the raw bytes, the event's seller must be the connection's account, dedupe in webhook_deliveries
// (whop:<connection>:<webhook-id>), then the sale is recorded (record_sale never moves it backwards) before the 2xx.
// No Whop call happens inside it (Whop waits 5 seconds). A payment is kept only when its metadata names one of this
// user's Whop offers on this connection (and its checkout); the seller's other Whop sales are acknowledged and dropped.
//
// Whop's own error text is never shown or logged: server/payments/whopClient.mjs maps everything to our codes.

import { fail, notSetUp, safeLog, sha256 } from '../integrations/common.mjs';
import { createWhopClient, WHOP_API_VERSION_DATE, WHOP_ENVIRONMENTS } from './whopClient.mjs';
import { WHOP_EVENTS, cleanEmail, offerIdOf, parseEvent, paymentOf, saleFromPayment, toMinor, verifyWhopSignature } from './whopWebhook.mjs';
import { ACCOUNT_RE, CHECKOUT_RE, ID_RE, MAX_OFFERS_PER_USER, OFFERS_MIGRATION, PLAN_RE, PRODUCT_RE, PROJECT_ID_RE, describeConnection, describeOffer, last4, newId, priceText } from '../offers/store.mjs';
import { validWhopPurchaseUrl } from '../offers/providers.mjs';

export const WHOP_WEBHOOK_PREFIX = '/api/webhooks/whop/';
export const WEBHOOK_MAX_BYTES = 256 * 1024;
/** Whop answers a replay of a checkout request only for this long (its idempotency window). */
export const CHECKOUT_REPLAY_MS = 24 * 3_600_000;
const DB_TIMEOUT_MS = 3000;
const CATALOG_TTL_MS = 60_000;
const HEALTH_EVERY_MS = 20 * 3_600_000;
const RECONCILE_WINDOW_MS = 72 * 3_600_000;
const KEY_RE = /^[\x21-\x7e]{20,300}$/;
const SECRET_RE = /^[\x21-\x7e]{8,300}$/;
const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{4,100}$/;
const HEADER_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const PAY_STATUS_EVENT = { paid: 'payment.succeeded', pending: 'payment.pending', open: 'payment.pending', void: 'payment.failed', uncollectible: 'payment.failed' };

const iso = (t) => new Date(t).toISOString();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const within = (ms, p) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms)))]).finally(() => clearTimeout(timer));
};

/** Whether an origin can receive Whop's webhooks: https, a public name (not localhost, not an address, not .local). */
export function publicOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.startsWith('[')) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** A billing period in days as people say it. */
const periodWord = (days) => {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n === 7) return 'week';
  if (n >= 28 && n <= 31) return 'month';
  if (n >= 89 && n <= 92) return 'quarter';
  if (n >= 365 && n <= 366) return 'year';
  return `${Math.round(n)} days`;
};
const text200 = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 200) : '');

/** A Whop variant as the browser sees a plan: ids, title, price (minor units) and period only. */
export function planOut(v) {
  const currency = typeof v.currency === 'string' ? v.currency.toLowerCase() : 'usd';
  const recurring = v.plan_type === 'renewal' || v.billing_type === 'renewal' || (v.billing_period != null && v.renewal_price != null);
  const first = toMinor(v.initial_price ?? 0, currency);
  const renew = recurring && v.renewal_price != null ? toMinor(v.renewal_price, currency) : null;
  const period = recurring ? periodWord(v.billing_period) : null;
  const display = recurring && renew?.ok && (!first.ok || first.minor === 0 || first.minor === renew.minor) ? priceText(renew.minor, currency, period) : first.ok ? priceText(first.minor, currency) : '';
  return {
    id: v.id,
    productId: v.product?.id ?? v.product_id ?? null,
    title: text200(v.title),
    billingType: recurring ? 'renewal' : 'one_time',
    price: { minor: first.ok ? first.minor : null, currency, display },
    ...(renew?.ok ? { renewal: { minor: renew.minor, currency, display: priceText(renew.minor, currency, period), period } } : {}),
    trialDays: Number.isInteger(v.trial_period_days) ? v.trial_period_days : null,
    visibility: text200(v.visibility) || null,
  };
}

/**
 * db (server/integrations/db.mjs), crypto (createPaymentCrypto), fetch, now, log. bases: { sandbox, production } for
 * tests only (the mock). webhookUrl(connId, origin): where Whop sends a connection's events.
 */
export function createWhop({ db, crypto: pc, fetch = globalThis.fetch, now = () => Date.now(), log = console, bases = null, timeouts = {}, enabled = true }) {
  const catalog = new Map(); // `${connId}|${what}` → { value, until }
  const warned = new Set();
  const warnOnce = (code, hint) => {
    if (warned.has(code)) return;
    warned.add(code);
    safeLog('offers_owner_hint', { code, hint }, log);
  };

  const client = (conn, key) => createWhopClient({ environment: conn.environment, key, fetch, base: bases?.[conn.environment] ?? null, ...timeouts });
  const webhookUrl = (connId, origin) => `${origin}${WHOP_WEBHOOK_PREFIX}${connId}`;

  // ── rows ──
  async function connRow(userId, id) {
    if (!ID_RE.test(String(id ?? ''))) throw fail(404, 'NOT_FOUND', 'That Whop connection isn’t in your account.');
    const [row] = await db.select('payment_connections', { id, user_id: userId, provider: 'whop' }, { limit: 1 });
    if (!row || row.status === 'disconnected') throw fail(404, 'NOT_FOUND', 'That Whop connection isn’t in your account.');
    return row;
  }
  const patchConn = (row, patch) => db.update('payment_connections', { id: row.id, user_id: row.user_id }, patch, { returning: true }).then((r) => r[0] ?? { ...row, ...patch });

  function keyOf(row) {
    if (!pc) throw notSetUp('Add PAYMENT_KEYS_SECRET (32+ random characters) in Replit Secrets.');
    try {
      return pc.openKey(row.user_id, row.id, row.key_ciphertext);
    } catch {
      warnOnce('payment_key_unreadable', 'A saved Whop key can’t be opened: PAYMENT_KEYS_SECRET (or the secret it falls back to) changed. The user must replace the key.');
      throw fail(409, 'WHOP_KEY_UNREADABLE', 'This Whop key needs to be added again. Use “Replace key”.');
    }
  }

  /** A read failure on a saved key: a 401 marks the connection (the app shows "replace your key"). */
  async function onReadError(row, e) {
    if (e?.code === 'WHOP_KEY_REJECTED' && row.status === 'active') await patchConn(row, { status: 'key_rejected' }).catch(() => {});
    throw e;
  }

  function cleanKey(v) {
    const key = typeof v === 'string' ? v.trim() : '';
    if (!KEY_RE.test(key)) throw fail(400, 'BAD_REQUEST', 'Paste the whole Whop API key (no spaces).');
    return key;
  }

  /** The key works on this account: products, then plans (reads only). */
  async function checkKey(conn, key) {
    const w = client(conn, key);
    try {
      await w.list('products.list', '/products', { account_id: conn.account_id, first: 1 });
      await w.list('variants.list', '/variants', { account_id: conn.account_id, first: 1 });
    } catch (e) {
      if (e?.code === 'WHOP_NOT_FOUND') throw fail(400, 'WHOP_ACCOUNT', 'That Whop account id doesn’t match this key. Copy the biz_… id of the account the key was made in.');
      throw e;
    }
  }

  // ── connections ──
  async function list(userId, origin) {
    const rows = await db.select('payment_connections', { user_id: userId, provider: 'whop', status: ['neq', 'disconnected'] }, { order: 'created_at.asc', limit: 10 });
    return { connections: rows.map((r) => describeConnection(r, { webhookUrl: webhookUrl(r.id, origin) })) };
  }

  /** One attempt at making the connection's webhook. → the row as saved, and a notice for the app (or null). */
  async function makeWebhook(row, key, origin) {
    const pub = publicOrigin(origin);
    if (!pub) return { row: await patchConn(row, { webhook_mode: 'manual', webhook_state: 'missing' }), notice: 'NO_PUBLIC_ADDRESS' };
    const got = await client(row, key).write('webhooks.create', 'POST', '/webhooks', { url: webhookUrl(row.id, pub), events: [...WHOP_EVENTS], resource_id: row.account_id, api_version_date: WHOP_API_VERSION_DATE }, { idempotencyKey: `ylb-whop-webhook-${row.id}` });
    if (got.outcome === 'ok') {
      const id = String(got.value?.id ?? '');
      const secret = String(got.value?.webhook_secret ?? '');
      if (!WEBHOOK_ID_RE.test(id) || !SECRET_RE.test(secret)) {
        safeLog('whop_webhook_unexpected_answer', {}, log);
        return { row: await patchConn(row, { webhook_mode: 'manual', webhook_state: 'missing' }), notice: 'WEBHOOK_MANUAL' };
      }
      return { row: await patchConn(row, { webhook_id: id, webhook_secret_ciphertext: pc.sealWebhook(row.user_id, row.id, secret), webhook_mode: 'auto', webhook_state: 'ok' }), notice: null };
    }
    if (got.outcome === 'failed') {
      safeLog('whop_webhook_refused', { code: got.error?.code, status: got.status }, log);
      return { row: await patchConn(row, { webhook_mode: 'manual', webhook_state: 'missing' }), notice: 'WEBHOOK_MANUAL' };
    }
    safeLog('whop_webhook_unknown', { reason: got.reason }, log);
    return { row: await patchConn(row, { webhook_mode: 'auto', webhook_state: 'unknown' }), notice: 'WEBHOOK_UNCONFIRMED' };
  }

  async function connect(who, b, origin) {
    const environment = b.environment;
    if (!WHOP_ENVIRONMENTS.includes(environment)) throw fail(400, 'BAD_REQUEST', 'Choose Live or Test mode.');
    const accountId = typeof b.accountId === 'string' ? b.accountId.trim() : '';
    if (!ACCOUNT_RE.test(accountId)) throw fail(400, 'BAD_REQUEST', 'Your Whop account id starts with biz_ (Whop dashboard → Settings).');
    const key = cleanKey(b.key);
    if (!pc) throw notSetUp('Add PAYMENT_KEYS_SECRET (32+ random characters) in Replit Secrets.');
    const live = await db.select('payment_connections', { user_id: who.id, provider: 'whop', environment, status: ['neq', 'disconnected'] }, { select: 'id', limit: 1 });
    if (live.length) throw fail(409, 'ALREADY_CONNECTED', environment === 'sandbox' ? 'A Whop account is already connected in Test mode. Disconnect it first.' : 'A Whop account is already connected. Disconnect it first.');
    const id = newId();
    const draft = { id, user_id: who.id, provider: 'whop', kind: 'account_key', environment, account_id: accountId };
    await checkKey(draft, key);
    let row;
    try {
      [row] = await db.insert('payment_connections', { ...draft, key_ciphertext: pc.sealKey(who.id, id, key), key_last4: last4(key), webhook_mode: 'none', webhook_state: 'missing', status: 'active' }, { returning: true });
    } catch (e) {
      if (e?.code === 'CONFLICT') throw fail(409, 'ALREADY_CONNECTED', 'A Whop account is already connected here. Disconnect it first.');
      throw e;
    }
    row ??= { ...draft, webhook_mode: 'none', webhook_state: 'missing', status: 'active', key_last4: last4(key) };
    const made = await makeWebhook(row, key, origin);
    return { connection: describeConnection(made.row, { webhookUrl: webhookUrl(id, publicOrigin(origin) ?? origin) }), ...(made.notice ? { notice: made.notice } : {}) };
  }

  async function pasteSecret(who, id, b, origin) {
    const row = await connRow(who.id, id);
    const secret = typeof b.secret === 'string' ? b.secret.trim() : '';
    if (!SECRET_RE.test(secret)) throw fail(400, 'BAD_REQUEST', 'Paste the webhook’s whole signing secret (it starts with ws_).');
    if (!pc) throw notSetUp('Add PAYMENT_KEYS_SECRET (32+ random characters) in Replit Secrets.');
    const saved = await patchConn(row, { webhook_secret_ciphertext: pc.sealWebhook(row.user_id, row.id, secret), webhook_mode: 'manual', webhook_state: 'unknown', webhook_id: null });
    return { connection: describeConnection(saved, { webhookUrl: webhookUrl(row.id, origin) }) };
  }

  /** "Check again": reads only. The key, then the webhook (by its id, or ours by URL when it's unknown). */
  async function check(who, id, origin) {
    const row = await connRow(who.id, id);
    const key = keyOf(row);
    const w = client(row, key);
    const patch = { checked_at: iso(now()) };
    let notice = null;
    try {
      if (row.webhook_mode === 'auto' && row.webhook_id) {
        try {
          const h = await w.read('webhooks.read', `/webhooks/${encodeURIComponent(row.webhook_id)}`);
          patch.webhook_state = h?.enabled === false ? 'disabled' : 'ok';
        } catch (e) {
          if (e?.code !== 'WHOP_NOT_FOUND') throw e;
          Object.assign(patch, { webhook_mode: 'manual', webhook_state: 'missing', webhook_id: null, webhook_secret_ciphertext: null });
          notice = 'WEBHOOK_GONE';
        }
      } else if (row.webhook_mode === 'auto' && row.webhook_state === 'unknown') {
        const pub = publicOrigin(origin);
        const page = await w.list('webhooks.list', '/webhooks', { resource_id: row.account_id, first: 50 });
        const ours = page.data.find((h) => pub && h?.url === webhookUrl(row.id, pub));
        // ours was made, but its secret is only ever shown once: it can't be checked, so the owner replaces it by hand
        Object.assign(patch, { webhook_mode: 'manual', webhook_state: 'missing' });
        notice = ours ? 'WEBHOOK_MADE_WITHOUT_SECRET' : 'WEBHOOK_MANUAL';
      } else {
        await w.list('products.list', '/products', { account_id: row.account_id, first: 1 });
      }
      if (row.status === 'key_rejected') patch.status = 'active';
    } catch (e) {
      await patchConn(row, patch).catch(() => {});
      return onReadError(row, e);
    }
    const saved = await patchConn(row, patch);
    return { connection: describeConnection(saved, { webhookUrl: webhookUrl(row.id, origin) }), ...(notice ? { notice } : {}) };
  }

  /** The owner turns a webhook Whop switched off back on: one PATCH, never repeated by itself. */
  async function enableWebhook(who, id, origin) {
    const row = await connRow(who.id, id);
    if (row.webhook_mode !== 'auto' || !row.webhook_id) throw fail(409, 'NOT_AUTO', 'This webhook was made in Whop’s dashboard: turn it on there.');
    const got = await client(row, keyOf(row)).write('webhooks.update', 'PATCH', `/webhooks/${encodeURIComponent(row.webhook_id)}`, { enabled: true });
    if (got.outcome === 'failed') throw got.error;
    if (got.outcome === 'unknown') throw fail(502, 'WHOP_UNCONFIRMED', 'Whop didn’t confirm it. Use “Check again” in a minute.');
    const saved = await patchConn(row, { webhook_state: got.value?.enabled === false ? 'disabled' : 'ok', checked_at: iso(now()) });
    return { connection: describeConnection(saved, { webhookUrl: webhookUrl(row.id, origin) }) };
  }

  async function replaceKey(who, id, b, origin) {
    const row = await connRow(who.id, id);
    const key = cleanKey(b.key);
    if (!pc) throw notSetUp('Add PAYMENT_KEYS_SECRET (32+ random characters) in Replit Secrets.');
    await checkKey(row, key);
    const saved = await patchConn(row, { key_ciphertext: pc.sealKey(row.user_id, row.id, key), key_last4: last4(key), status: 'active', checked_at: iso(now()) });
    for (const k of [...catalog.keys()]) if (k.startsWith(`${row.id}|`)) catalog.delete(k);
    return { connection: describeConnection(saved, { webhookUrl: webhookUrl(row.id, origin) }) };
  }

  /** Disconnect: its Whop offers pause (409 OFFERS_LIVE first, unless confirmed); one attempt at removing our webhook. */
  async function disconnect(who, id, { confirm = false } = {}) {
    const row = await connRow(who.id, id);
    const live = await db.select('offers', { user_id: who.id, connection_id: row.id, status: ['in', ['active', 'checkout_unknown', 'draft']] }, { select: 'id', limit: MAX_OFFERS_PER_USER + 1 });
    if (live.length && !confirm) throw fail(409, 'OFFERS_LIVE', `${live.length} buy link${live.length === 1 ? '' : 's'} use${live.length === 1 ? 's' : ''} this Whop account. They’ll stop selling until you attach another payment.`, { count: live.length });
    if (live.length) await db.update('offers', { user_id: who.id, connection_id: row.id, status: ['in', ['active', 'checkout_unknown', 'draft']] }, { status: 'paused' });
    let notice = null;
    if (row.webhook_mode === 'auto' && row.webhook_id) {
      let key = null;
      try {
        key = keyOf(row);
      } catch {
        key = null;
      }
      const got = key ? await client(row, key).write('webhooks.delete', 'DELETE', `/webhooks/${encodeURIComponent(row.webhook_id)}`) : { outcome: 'failed' };
      if (got.outcome !== 'ok') {
        notice = 'REMOVE_WEBHOOK_IN_WHOP';
        safeLog('whop_webhook_delete_not_done', { outcome: got.outcome, code: got.error?.code }, log);
      }
    } else if (row.webhook_mode === 'manual') notice = 'REMOVE_WEBHOOK_IN_WHOP';
    await patchConn(row, { status: 'disconnected', key_ciphertext: '', key_last4: '', webhook_secret_ciphertext: null });
    for (const k of [...catalog.keys()]) if (k.startsWith(`${row.id}|`)) catalog.delete(k);
    return { ok: true, paused: live.length, ...(notice ? { notice } : {}) };
  }

  // ── catalog (reads, cached 60 s per connection) ──
  async function cached(row, what, load) {
    const k = `${row.id}|${what}`;
    const hit = catalog.get(k);
    if (hit && hit.until > now()) return hit.value;
    const value = await load();
    catalog.set(k, { value, until: now() + CATALOG_TTL_MS });
    while (catalog.size > 2000) catalog.delete(catalog.keys().next().value);
    return value;
  }
  const cursor = (v) => (typeof v === 'string' && v.length <= 500 && /^[A-Za-z0-9+/=_-]+$/.test(v) ? v : undefined);

  async function products(who, id, after) {
    const row = await connRow(who.id, id);
    if (row.status !== 'active') throw fail(409, 'WHOP_KEY_REJECTED', 'Whop didn’t accept this API key. Replace it in Settings → Payments.');
    const key = keyOf(row);
    try {
      return await cached(row, `p:${cursor(after) ?? ''}`, async () => {
        const page = await client(row, key).list('products.list', '/products', { account_id: row.account_id, first: 25, after: cursor(after) });
        return { products: page.data.filter((p) => PRODUCT_RE.test(String(p?.id ?? ''))).map((p) => ({ id: p.id, title: text200(p.title), visibility: text200(p.visibility) || null })), next: page.next };
      });
    } catch (e) {
      return onReadError(row, e);
    }
  }

  async function plans(who, id, productId, after) {
    if (!PRODUCT_RE.test(String(productId ?? ''))) throw fail(400, 'BAD_REQUEST', 'Choose a product first.');
    const row = await connRow(who.id, id);
    if (row.status !== 'active') throw fail(409, 'WHOP_KEY_REJECTED', 'Whop didn’t accept this API key. Replace it in Settings → Payments.');
    const key = keyOf(row);
    try {
      return await cached(row, `v:${productId}:${cursor(after) ?? ''}`, async () => {
        const page = await client(row, key).list('variants.list', '/variants', { account_id: row.account_id, product_ids: productId, first: 25, after: cursor(after) });
        return { plans: page.data.filter((v) => PLAN_RE.test(String(v?.id ?? ''))).map(planOut), next: page.next };
      });
    } catch (e) {
      return onReadError(row, e);
    }
  }

  /** The plan as Whop has it now (the list endpoint with product_ids: GET /variants/<id> isn't confirmed), or null. */
  async function findPlan(row, key, productId, variantId) {
    let after;
    for (let i = 0; i < 5; i++) {
      const page = await client(row, key).list('variants.list', '/variants', { account_id: row.account_id, product_ids: productId, first: 50, after });
      const v = page.data.find((x) => x?.id === variantId);
      if (v) return v;
      if (!page.next) return null;
      after = page.next;
    }
    return null;
  }

  // ── checkout links ──
  const checkoutBody = (offerId, ref) => ({ account_id: ref.accountId, variant_id: ref.variantId, metadata: { ylb_offer: offerId, ylb_env: ref.environment }, redirect_url: ref.redirectUrl });

  /** Store Whop's answer only once it's checked: a ch_ id and a purchase_url on the environment's own checkout host. */
  async function settle(offer, got) {
    const ref = offer.provider_ref ?? {};
    if (got.outcome === 'ok') {
      const ch = String(got.value?.id ?? '');
      const purchaseUrl = CHECKOUT_RE.test(ch) ? validWhopPurchaseUrl(got.value?.purchase_url, ref.environment, ch) : null;
      const meta = got.value?.metadata;
      const metaOk = meta == null || (isObj(meta) && meta.ylb_offer === offer.id && meta.ylb_env === ref.environment);
      if (!purchaseUrl || !metaOk) {
        warnOnce('whop_checkout_url_unexpected', 'Whop answered a checkout link that isn’t on its own checkout site (or for another offer); it wasn’t stored.');
        safeLog('whop_checkout_url_unexpected', {}, log);
        const [r] = await db.update('offers', { id: offer.id, user_id: offer.user_id }, { status: 'checkout_unknown' }, { returning: true });
        return { status: 202, row: r ?? { ...offer, status: 'checkout_unknown' } };
      }
      const [r] = await db.update('offers', { id: offer.id, user_id: offer.user_id }, { status: 'active', provider_ref: { ...ref, checkoutId: ch, purchaseUrl } }, { returning: true });
      return { status: 200, row: r ?? offer };
    }
    if (got.outcome === 'unknown') {
      const [r] = await db.update('offers', { id: offer.id, user_id: offer.user_id }, { status: 'checkout_unknown' }, { returning: true });
      return { status: 202, row: r ?? { ...offer, status: 'checkout_unknown' } };
    }
    return { status: 0, error: got.error };
  }

  /**
   * POST /api/offers {provider: 'whop', …}: read the plan, store a draft (the deterministic id: a double click is the
   * same row), make the checkout link once. → { status: 200 | 202, offer }.
   */
  async function createOffer(who, b, origin, offerIdFor) {
    const projectId = typeof b.projectId === 'string' && PROJECT_ID_RE.test(b.projectId) ? b.projectId : null;
    if (!projectId) throw fail(400, 'BAD_REQUEST', 'Unknown business.');
    if (!PRODUCT_RE.test(String(b.productId ?? '')) || !PLAN_RE.test(String(b.variantId ?? ''))) throw fail(400, 'BAD_REQUEST', 'Choose a Whop product and plan.');
    const crid = String(b.clientRequestId ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(crid)) throw fail(400, 'BAD_REQUEST', 'clientRequestId must be a UUID.');
    const title = b.title === undefined ? '' : typeof b.title === 'string' ? b.title.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim() : null;
    if (title === null || Array.from(title).length > 200) throw fail(400, 'BAD_REQUEST', 'The title can be at most 200 characters.');
    const id = offerIdFor(who.id, crid);
    // a double click: the same row, answered as it is now
    const [existing] = await db.select('offers', { id }, { limit: 1 });
    if (existing) {
      if (existing.user_id !== who.id) throw fail(409, 'CONFLICT', 'Try again.');
      return { status: existing.status === 'active' ? 200 : 202, row: existing };
    }
    const row = await connRow(who.id, b.connectionId);
    if (row.status !== 'active') throw fail(409, 'WHOP_KEY_REJECTED', 'Whop didn’t accept this API key. Replace it in Settings → Payments.');
    const mine = await db.select('offers', { user_id: who.id, status: ['neq', 'archived'] }, { select: 'id', limit: MAX_OFFERS_PER_USER + 1 });
    if (mine.length >= MAX_OFFERS_PER_USER) throw fail(400, 'TOO_MANY', `You can have up to ${MAX_OFFERS_PER_USER} buy links. Archive one first.`);
    const key = keyOf(row);
    let plan;
    try {
      plan = await findPlan(row, key, b.productId, b.variantId);
    } catch (e) {
      return onReadError(row, e);
    }
    if (!plan) throw fail(400, 'WHOP_PLAN_GONE', 'That plan isn’t in your Whop account anymore. Pick another.');
    const p = planOut(plan);
    const pub = publicOrigin(origin) ?? origin;
    const ref = { productId: b.productId, variantId: b.variantId, environment: row.environment, accountId: row.account_id, redirectUrl: `${pub}/b/${id}/done`, requestedAt: iso(now()) };
    const draft = {
      id,
      user_id: who.id,
      project_id: projectId,
      title: title || text200(plan.product?.title) || p.title || 'Offer',
      price_display: (p.renewal?.display && p.billingType === 'renewal' ? p.renewal.display : p.price.display) || '',
      price_minor: p.price.minor,
      currency: /^[a-z]{3}$/.test(p.price.currency) ? p.price.currency : null,
      provider: 'whop',
      connection_id: row.id,
      provider_ref: ref,
      status: 'draft',
    };
    const inserted = await db.insert('offers', draft, { returning: true, ignoreDuplicates: true, onConflict: 'id' });
    if (!inserted.length) {
      // the other click of a double click got here first: it makes the link
      const [now2] = await db.select('offers', { id, user_id: who.id }, { limit: 1 });
      return { status: 202, row: now2 ?? { ...draft } };
    }
    const offer = inserted[0];
    const got = await client(row, key).write('checkout.create', 'POST', '/checkout_configurations', checkoutBody(id, ref), { idempotencyKey: `ylb-offer-${id}` });
    const out = await settle(offer, got);
    if (out.error) {
      await db.remove('offers', { id, user_id: who.id, status: 'draft' }).catch(() => {});
      if (out.error.code === 'WHOP_KEY_REJECTED') await patchConn(row, { status: 'key_rejected' }).catch(() => {});
      throw out.error;
    }
    return out;
  }

  /**
   * POST /api/offers/<id>/check for a Whop offer: a link Whop didn't confirm is asked for again with the SAME request
   * and Idempotency-Key (the owner's click; Whop answers the first result), within 24 hours; an active one re-reads its
   * plan's price (reads only).
   */
  async function checkOffer(who, offer) {
    const ref = offer.provider_ref ?? {};
    const row = await connRow(who.id, offer.connection_id);
    const key = keyOf(row);
    if (offer.status === 'checkout_unknown' || offer.status === 'draft') {
      if (now() - Date.parse(String(ref.requestedAt ?? '')) > CHECKOUT_REPLAY_MS || !Number.isFinite(Date.parse(String(ref.requestedAt ?? '')))) throw fail(409, 'CHECKOUT_EXPIRED', 'Whop no longer remembers this request. Make a new link for this plan.');
      const got = await client(row, key).write('checkout.create', 'POST', '/checkout_configurations', checkoutBody(offer.id, ref), { idempotencyKey: `ylb-offer-${offer.id}` });
      const out = await settle(offer, got);
      if (out.error) {
        if (out.error.code === 'WHOP_KEY_REJECTED') await patchConn(row, { status: 'key_rejected' }).catch(() => {});
        throw out.error;
      }
      return out;
    }
    if (offer.status === 'active' || offer.status === 'paused') {
      let plan;
      try {
        plan = await findPlan(row, key, ref.productId, ref.variantId);
      } catch (e) {
        return onReadError(row, e);
      }
      if (!plan) throw fail(400, 'WHOP_PLAN_GONE', 'That plan isn’t in your Whop account anymore. Attach another plan.');
      const p = planOut(plan);
      const [r] = await db.update('offers', { id: offer.id, user_id: who.id }, { price_display: (p.billingType === 'renewal' && p.renewal?.display) || p.price.display || '', price_minor: p.price.minor, currency: /^[a-z]{3}$/.test(p.price.currency) ? p.price.currency : null }, { returning: true });
      return { status: 200, row: r ?? offer };
    }
    return { status: 200, row: offer };
  }

  // ── the webhook ──

  /** The record_sale payload for a sale of one of this connection's offers. */
  const salePayload = (conn, offer, s, status, at) => ({
    user_id: conn.user_id,
    project_id: offer.project_id,
    offer_id: offer.id,
    provider: 'whop',
    environment: conn.environment,
    provider_account: conn.account_id,
    provider_payment_id: s.paymentId,
    provider_membership_id: s.membershipId ?? null,
    status,
    amount_minor: s.amountMinor ?? 0,
    refunded_minor: s.refundedMinor ?? 0,
    net_minor: s.netMinor ?? null,
    currency: s.currency ?? 'usd',
    buyer_email: s.email ?? null,
    paid_at: s.paidAt ?? null,
    last_event_at: at,
  });

  /** The offer a payment's metadata names, when it's this connection's own (else null: not ours). */
  async function ourOffer(conn, s) {
    if (!s?.offerId) return null;
    const [offer] = await within(DB_TIMEOUT_MS, db.select('offers', { id: s.offerId }, { limit: 1 }));
    if (!offer || offer.user_id !== conn.user_id || offer.provider !== 'whop') return null;
    const ref = offer.provider_ref ?? {};
    if (offer.connection_id !== conn.id && ref.accountId !== conn.account_id) return null;
    if (ref.environment && ref.environment !== conn.environment) return null;
    if (s.account && s.account !== conn.account_id) return null;
    if (s.checkoutId && ref.checkoutId && s.checkoutId !== ref.checkoutId) return null;
    return offer;
  }

  /** A full Payment (an event's, or the reconcile's) → record_sale. → the outcome, or 'not_ours'. */
  async function recordPayment(conn, type, payment, at) {
    const s = saleFromPayment(type, payment);
    if (!s) return 'ignored';
    const offer = await ourOffer(conn, s);
    if (!offer) return 'not_ours';
    if (!s.currency) s.currency = offer.currency ?? 'usd';
    if (!s.amountOk) safeLog('whop_sale_amount_unreadable', {}, log);
    return within(DB_TIMEOUT_MS, db.rpc('record_sale', { p: salePayload(conn, offer, s, s.status, at) }));
  }

  /** A refund or dispute that names only its payment: change the sale we already have (never someone else's). */
  async function updateStored(conn, paymentId, at, change) {
    const [sale] = await within(DB_TIMEOUT_MS, db.select('sales', { provider: 'whop', environment: conn.environment, provider_payment_id: paymentId }, { limit: 1 }));
    if (!sale || sale.user_id !== conn.user_id || sale.provider_account !== conn.account_id) return 'not_ours';
    const s = { paymentId, membershipId: sale.provider_membership_id, amountMinor: Number(sale.amount_minor) || 0, refundedMinor: Number(sale.refunded_minor) || 0, netMinor: sale.net_minor == null ? null : Number(sale.net_minor), currency: sale.currency, email: sale.buyer_email, paidAt: sale.paid_at };
    const { status, refundedMinor } = change(s);
    return within(DB_TIMEOUT_MS, db.rpc('record_sale', { p: salePayload(conn, { id: sale.offer_id, project_id: sale.project_id }, { ...s, refundedMinor }, status, at) }));
  }

  async function processEvent(conn, evt) {
    const at = evt.timestamp ?? iso(now());
    const t = evt.type;
    if (t.startsWith('payment.')) return recordPayment(conn, t, evt.data, at);
    if (t === 'refund.created' || t === 'refund.updated') {
      const po = paymentOf(evt.data);
      if (!po) return 'ignored';
      // a refund that failed or was canceled changes nothing
      const rs = typeof evt.data.status === 'string' ? evt.data.status : 'succeeded';
      if (!['succeeded', 'pending', 'processing'].includes(rs)) return 'ignored';
      if (po.payment) return recordPayment(conn, PAY_STATUS_EVENT[po.payment.status] ?? 'payment.succeeded', po.payment, at);
      const amount = toMinor(evt.data.amount, evt.data.currency);
      return updateStored(conn, po.paymentId, at, (s) => {
        // without the payment's own total refunded, the largest single refund seen (never more than was refunded)
        const refunded = Math.max(s.refundedMinor, amount.ok ? amount.minor : 0);
        return { status: s.amountMinor > 0 && refunded >= s.amountMinor ? 'refunded' : refunded > 0 ? 'partially_refunded' : 'paid', refundedMinor: refunded };
      });
    }
    if (t === 'dispute.created' || t === 'dispute.updated') {
      const po = paymentOf(evt.data);
      if (!po) return 'ignored';
      const out = await updateStored(conn, po.paymentId, at, (s) => ({ status: 'disputed', refundedMinor: s.refundedMinor }));
      if (out !== 'not_ours' || !po.payment) return out;
      const s = saleFromPayment('payment.succeeded', po.payment);
      const offer = s ? await ourOffer(conn, s) : null;
      if (!offer) return 'not_ours';
      return within(DB_TIMEOUT_MS, db.rpc('record_sale', { p: salePayload(conn, offer, s, 'disputed', at) }));
    }
    return 'ignored';
  }

  /**
   * POST /api/webhooks/whop/<connection id> → { status, body }. limited(req): the per-IP limit; readRaw(req, max).
   * Nothing is parsed before the signature is checked; nothing is answered 2xx before the sale is written.
   */
  async function webhook(req, connId, { limited, readRaw, drain }) {
    if (limited(req)) {
      drain?.(req);
      return { status: 429, body: { error: 'Too many requests.', code: 'RATE_LIMITED' } };
    }
    if (!ID_RE.test(String(connId ?? ''))) {
      drain?.(req);
      return { status: 404, body: { error: 'Not found.', code: 'NOT_FOUND' } };
    }
    // a body announced as too big is refused before it's read (the connection then closes)
    const announced = Number(req.headers['content-length']);
    if (Number.isFinite(announced) && announced > WEBHOOK_MAX_BYTES) return { status: 413, body: { error: 'Request too large.', code: 'BAD_REQUEST' }, close: true };
    let raw;
    try {
      raw = await readRaw(req, WEBHOOK_MAX_BYTES);
    } catch (e) {
      return { status: e?.status === 413 ? 413 : 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    }
    if (!enabled || !pc) return { status: 404, body: { error: 'Not found.', code: 'NOT_FOUND' } };
    let conn;
    try {
      [conn] = await within(DB_TIMEOUT_MS, db.select('payment_connections', { id: connId, provider: 'whop' }, { limit: 1 }));
    } catch {
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    if (!conn || conn.status === 'disconnected' || !conn.webhook_secret_ciphertext) return { status: 404, body: { error: 'Not found.', code: 'NOT_FOUND' } };
    let secret;
    try {
      secret = pc.openWebhook(conn.user_id, conn.id, conn.webhook_secret_ciphertext);
    } catch {
      warnOnce('webhook_secret_unreadable', 'A saved Whop webhook secret can’t be opened: PAYMENT_KEYS_SECRET (or the secret it falls back to) changed.');
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    if (!verifyWhopSignature(raw, req.headers, secret, now())) {
      safeLog('whop_webhook_bad_signature', {}, log);
      return { status: 400, body: { error: 'Bad signature.', code: 'BAD_REQUEST' } };
    }
    const evt = parseEvent(raw);
    if (!evt) return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    if (evt.account !== conn.account_id) {
      safeLog('whop_webhook_other_account', { type: evt.type }, log);
      return { status: 200, body: { ok: true, ignored: true } };
    }
    const hid = String(req.headers['webhook-id'] ?? '');
    const dedupeKey = `whop:${conn.id}:${HEADER_ID_RE.test(hid) ? hid : sha256(raw)}`;
    try {
      const seen = await within(DB_TIMEOUT_MS, db.select('webhook_deliveries', { body_hash: dedupeKey }, { select: 'body_hash', limit: 1 }));
      if (seen.length) return { status: 200, body: { ok: true, duplicate: true } };
    } catch {
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    let outcome;
    try {
      outcome = await processEvent(conn, evt);
    } catch (e) {
      safeLog('whop_webhook_failed', { type: evt.type, code: e?.code }, log);
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    try {
      await within(DB_TIMEOUT_MS, db.upsert('webhook_deliveries', { body_hash: dedupeKey, received_at: iso(now()) }, { onConflict: 'body_hash' }));
    } catch {
      /* a repeat is harmless: record_sale keeps what it has */
    }
    try {
      await within(DB_TIMEOUT_MS, db.update('payment_connections', { id: conn.id }, { last_event_at: iso(now()), ...(conn.webhook_state === 'ok' ? {} : { webhook_state: 'ok' }) }));
    } catch {
      /* only the "last sale received" line */
    }
    safeLog('whop_webhook', { type: evt.type, outcome: String(outcome).slice(0, 20) }, log);
    return { status: 200, body: { ok: true } };
  }

  // ── cron (reads only) ──

  /** Daily: each active connection not checked for 20 hours (50 at most): its webhook's state, or its key. */
  async function healthCheck(ctx = {}) {
    const cutoff = iso(now() - HEALTH_EVERY_MS);
    const due = [...(await db.select('payment_connections', { provider: 'whop', status: 'active', checked_at: null }, { limit: 50 })), ...(await db.select('payment_connections', { provider: 'whop', status: 'active', checked_at: ['lt', cutoff] }, { order: 'checked_at.asc', limit: 50 }))].slice(0, 50);
    const out = { checked: 0, disabled: 0, keyRejected: 0, failed: 0 };
    for (const row of due) {
      if (ctx.deadline && now() > ctx.deadline - 2000) break;
      const patch = { checked_at: iso(now()) };
      try {
        const w = client(row, keyOf(row));
        if (row.webhook_mode === 'auto' && row.webhook_id) {
          const h = await w.read('webhooks.read', `/webhooks/${encodeURIComponent(row.webhook_id)}`);
          patch.webhook_state = h?.enabled === false ? 'disabled' : 'ok';
          if (patch.webhook_state === 'disabled') out.disabled++;
        } else await w.list('products.list', '/products', { account_id: row.account_id, first: 1 });
        out.checked++;
      } catch (e) {
        if (e?.code === 'WHOP_KEY_REJECTED') {
          patch.status = 'key_rejected';
          out.keyRejected++;
        } else {
          out.failed++;
          safeLog('whop_health_failed', { code: e?.code }, log);
        }
      }
      await db.update('payment_connections', { id: row.id, user_id: row.user_id }, patch).catch(() => {});
    }
    return out;
  }

  /** Daily: payments of the last 72 hours on each active connection (5 pages at most), recorded once (reads only). */
  async function reconcile(ctx = {}) {
    const rows = await db.select('payment_connections', { provider: 'whop', status: 'active' }, { order: 'created_at.asc', limit: 50 });
    const out = { connections: 0, recorded: 0, failed: 0 };
    for (const row of rows) {
      if (ctx.deadline && now() > ctx.deadline - 2000) break;
      try {
        const w = client(row, keyOf(row));
        let after;
        for (let i = 0; i < 5; i++) {
          const page = await w.list('payments.list', '/payments', { account_id: row.account_id, created_after: iso(now() - RECONCILE_WINDOW_MS), first: 50, after });
          for (const p of page.data) {
            if (!offerIdOf(p)) continue;
            const got = await recordPayment(row, PAY_STATUS_EVENT[p?.status] ?? 'payment.pending', p, iso(now() - RECONCILE_WINDOW_MS));
            if (got === 'inserted' || got === 'updated') out.recorded++;
          }
          if (!page.next) break;
          after = page.next;
        }
        out.connections++;
      } catch (e) {
        out.failed++;
        safeLog('whop_reconcile_failed', { code: e?.code }, log);
      }
    }
    return out;
  }

  /** Account deletion: one best-effort attempt at removing each automatic webhook (5 s, never repeated). */
  async function forgetUser(userId) {
    let rows = [];
    try {
      rows = await db.select('payment_connections', { user_id: userId, provider: 'whop', status: ['neq', 'disconnected'] }, { limit: 10 });
    } catch (e) {
      safeLog('whop_forget_read_failed', { code: e?.code }, log);
      return;
    }
    for (const row of rows) {
      if (row.webhook_mode !== 'auto' || !row.webhook_id) continue;
      try {
        const got = await createWhopClient({ environment: row.environment, key: keyOf(row), fetch, base: bases?.[row.environment] ?? null, writeTimeoutMs: 5000 }).write('webhooks.delete', 'DELETE', `/webhooks/${encodeURIComponent(row.webhook_id)}`);
        safeLog('whop_forget_webhook', { outcome: got.outcome }, log);
      } catch (e) {
        safeLog('whop_forget_webhook', { outcome: 'error', code: e?.code }, log);
      }
    }
  }

  return { list, connect, pasteSecret, check, enableWebhook, replaceKey, disconnect, products, plans, createOffer, checkOffer, webhook, processEvent, healthCheck, reconcile, forgetUser, webhookUrl, migration: OFFERS_MIGRATION, cleanEmail };
}
