// Offers: one thing a business sells, with one permanent buy link /b/<id>. Assets, the SEO checkout page, listings
// and emails hold the offer (its id), never a provider's URL. Providers: 'whop' (the user's own Whop account, through
// server/payments/whop.mjs), 'external' (the owner's own checkout link); 'stripe' is kept for later and refused here.
//
//   GET    /api/offers?projectId=[&archived=1]          → { offers: [offer] }                   (signed in, same site)
//   POST   /api/offers  {projectId, title, provider: 'external', url, priceDisplay?, clientRequestId?} → { offer }
//   POST   /api/offers  {projectId, title?, provider: 'whop', connectionId, productId, variantId, clientRequestId}
//                       → 200 { offer } | 202 { offer } (status checkout_unknown: Whop didn't confirm the link yet)
//   PATCH  /api/offers/<id>  {title?, priceDisplay? (external), url? (external), status?: 'active'|'paused'}
//   POST   /api/offers/<id>/check     Whop: ask again for a link Whop didn't confirm (same request, same key, 24 h),
//                                     or re-read the plan's price; → { offer }
//   POST   /api/offers/<id>/archive   /b/<id> then says "no longer available"
//   DELETE /api/offers/<id>           only without sales (409 HAS_SALES: archive it instead)
//   GET    /api/offers/sales?projectId=&env=production|sandbox&before=&limit=   → { sales, next }
//   POST   /api/offers/sales/<sale id>/download-link  → { url, expiresAt }: a Stripe sale's 7-day download link
//   GET    /api/offers/summary?projectId=&days=30   → { live: {count, revenue, refunded}, test: {count}, clicks, offers }
//   GET    /api/payments/whop                        → { connections }
//   POST   /api/payments/whop  {environment, accountId, key}        connect (needs a plan)
//   GET    /api/payments/whop/<id>/products?after=   GET /api/payments/whop/<id>/plans?productId=&after=
//   POST   /api/payments/whop/<id>/webhook-secret {secret}   POST …/check   POST …/enable-webhook
//   PUT    /api/payments/whop/<id>/key {key}         DELETE /api/payments/whop/<id>[?confirm=1]
//   POST   /api/webhooks/whop/<connection id>        Whop's signed events (server/payments/whop.mjs)
//   GET|POST|PUT|DELETE /api/payments/stripe…         Stripe Connect sellers (server/payments/stripeConnect.mjs)
//   POST   /api/webhooks/stripe-connect              Stripe's Connect events (server/payments/connectWebhook.mjs)
//   GET|HEAD /b/<id>, /b/<id>/done                   visitors (server/offers/buy.mjs, through pages.mjs)
//
// Every signed-in route: same site → a signed-in user → the rate bucket → ids checked by shape → every query filtered
// by the server's user id. Creating and editing need an active plan (402, as publishing does); reading, pausing,
// archiving, deleting and disconnecting never do. Tables: supabase/migrations/20261113000000_offers.sql.
//
// Env: PAYMENT_KEYS_SECRET (optional, 32+ characters: seals the users' Whop keys; else USER_KEYS_SECRET, else the
// Supabase secret key), APP_PUBLIC_URL (the app's https address: Whop's webhooks and the links), OFFERS_PROVIDER=off
// (every route 503 NOT_SET_UP, every /b/ "not found"), WHOP_ENABLED=off (outside links only),
// OFFER_CLICKS_PER_IP_PER_HOUR (60), OFFER_CLICKS_PER_OFFER_PER_HOUR (3000).

import { errorBody, fail, isUuid, notSetUp, safeLog, stubRoutes } from '../integrations/common.mjs';
import { ROUTE_PREFIXES } from '../integrations/contracts.mjs';
import { normalizeLink } from '../leadFiles.mjs';
import { drain } from '../leads.mjs';
import { createWhop } from '../payments/whop.mjs';
import { CONNECT_MIGRATION, accountView, createConnectCore, serveConnectReturn } from '../payments/stripeConnect.mjs';
import { createBuy, offerLimitsFromEnv } from './buy.mjs';
import { createStripeOffers } from './stripeOffer.mjs';
import { createStripeCheckout } from './stripeCheckout.mjs';
import { createConnectWebhook } from '../payments/connectWebhook.mjs';
import { leadLinkSecret } from '../leadFiles.mjs';
import nodeCrypto from 'node:crypto';
import { CHECKOUT_HOSTS, PROVIDERS } from './providers.mjs';
import { ID_RE, MAX_OFFERS_PER_USER, OFFERS_MIGRATION, PROJECT_ID_RE, createPaymentCrypto, describeOffer, describeSale, newId, paymentKeysSecret } from './store.mjs';

const MAX_JSON = 16 * 1024;
const off = (v) => ['off', 'none', 'false', '0'].includes(String(v ?? '').trim().toLowerCase());
const SALE_COUNTED = ['paid', 'partially_refunded', 'refunded', 'disputed'];

/** The app's public origin: APP_PUBLIC_URL, else the request's own address (only the app's hosts reach /api). */
export function originFor(req, env = process.env) {
  try {
    const u = new URL(String(env.APP_PUBLIC_URL ?? ''));
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
  } catch {
    /* not set */
  }
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$|^\[[0-9a-f:]{2,45}\](:\d{1,5})?$/.test(host)) return 'https://localhost';
  const proto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(host);
  return `${proto === 'http' || proto === 'https' ? proto : req.socket?.encrypted || !local ? 'https' : 'http'}://${host}`;
}

/**
 * deps: the integration modules' own (server/integrations/wiring.mjs): auth, db, send, readJson, readRaw, limit,
 * corsHeaders, sameOrigin, clientKey, env, fetch, now, log, billing. Tests only: whopBases ({ sandbox, production }:
 * the mocks), whopTimeouts.
 */
export function createOffers({ auth, db, send, readJson, readRaw, limit = () => false, corsHeaders = () => ({}), sameOrigin = () => true, clientKey = (req) => req.socket?.remoteAddress || 'unknown', env = process.env, fetch = globalThis.fetch, now = () => Date.now(), log = console, billing = null, whopBases = null, whopTimeouts = {}, stripe = null, sellerTermsReady = undefined } = {}) {
  const prefixes = [ROUTE_PREFIXES.offers, ROUTE_PREFIXES.whop, ROUTE_PREFIXES.whopWebhook, ROUTE_PREFIXES.stripePayments, ROUTE_PREFIXES.stripeConnectWebhook];
  const keys = paymentKeysSecret(env);
  const switchedOff = off(env.OFFERS_PROVIDER);
  const enabled = !switchedOff && !!db?.enabled && !!keys;
  const whopOn = enabled && !off(env.WHOP_ENABLED);
  const pc = keys ? createPaymentCrypto(keys.secret) : null;
  const buy = createBuy({ db, billing, limits: offerLimitsFromEnv(env), enabled, log, now });
  const whop = createWhop({ db, crypto: pc, fetch, now, log, bases: whopBases, timeouts: whopTimeouts, enabled: enabled });
  // Stripe Connect: the sellers' own Stripe accounts (its cache drops follow the buy links')
  const connect = createConnectCore({ db, env, fetch, now, log, billing, stripe, ...(sellerTermsReady === undefined ? {} : { sellerTermsReady }), onAccountChanged: (rowId) => buy.dropAccount?.(rowId) });
  const stripeOn = enabled && connect.enabled;
  const stripeOffers = createStripeOffers({ db, connect, pc, cleanText: (v, max, what) => cleanText(v, max, what) });
  const linkSecret = leadLinkSecret(env);
  const stripeCheckout = createStripeCheckout({ db, connect, billing, env, now, log, linkSecret: linkSecret ? Buffer.from(nodeCrypto.hkdfSync('sha256', linkSecret, Buffer.alloc(0), 'ylb-sale-link', 32)) : null, supabase: { supabaseUrl: env.SUPABASE_URL || '', secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '', fetch } });
  if (stripeOn) buy.setStripe(stripeCheckout);
  const connectHooks = createConnectWebhook({ db, connect, now, log });
  const blocked = new Set();

  const notes = () => {
    if (switchedOff) return ['Offers and buy links: off (OFFERS_PROVIDER=off). /b/ links answer "not found".'];
    if (!db?.enabled) return ['Offers and buy links: off (they need SUPABASE_URL and SUPABASE_SECRET_KEY).'];
    const lines = [`Offers and buy links: on at /b/<id> (they need ${OFFERS_MIGRATION} in Supabase; limits: OFFER_CLICKS_PER_IP_PER_HOUR, OFFER_CLICKS_PER_OFFER_PER_HOUR).`];
    lines.push(whopOn ? `Whop: on. Each user connects their own Whop account; their keys are sealed with ${keys.source === 'PAYMENT_KEYS_SECRET' ? 'PAYMENT_KEYS_SECRET' : `a key from ${keys.source} (set PAYMENT_KEYS_SECRET, 32+ random characters, to keep them apart; set it before anyone connects, never change it after)`}.` : 'Whop: off (WHOP_ENABLED=off): offers take outside checkout links only.');
    if (whopOn && !String(env.APP_PUBLIC_URL ?? '').startsWith('https://')) lines.push('Whop webhooks: set APP_PUBLIC_URL to the app’s https address so each connection’s webhook can be made automatically.');
    if (connect.cfg.switchedOff) lines.push('Stripe Connect: off (STRIPE_CONNECT=off).');
    else if (stripeOn) lines.push(`Stripe Connect: on (${connect.cfg.live ? 'live' : 'sandbox'}; webhook ${ROUTE_PREFIXES.stripeConnectWebhook}, needs ${CONNECT_MIGRATION}).${connect.cfg.ready ? '' : ' Set APP_PUBLIC_URL to the app’s https address before anyone can sell.'}`);
    else lines.push(`Stripe Connect: off (needs ${connect.cfg.missing().join(', ') || 'Supabase'}).`);
    if (stripeOn && !connect.sellerTermsReady) lines.push('Stripe Connect: the seller terms are a draft (server/legal.mjs): only the owner can set up selling with Stripe.');
    return lines;
  };
  const config = () => ({ enabled, whop: { sandbox: whopOn, production: whopOn }, stripe: { available: stripeOn && connect.cfg.ready, environment: connect.cfg.environment } });

  if (!enabled) {
    const stub = stubRoutes({ prefixes, send, corsHeaders, message: 'Offers aren’t set up on this app yet.' });
    // no offers on this app: no email may carry a buy link (server/omnisend.mjs refuses them)
    return { ...stub, buy, config, notes, cronJobs: () => [], enabled: false, idsFor: async () => [], connectPages: serveConnectReturn };
  }

  const reply = (req, res, status, body, extra = {}) => send(res, status, body, { ...corsHeaders(req), 'cache-control': 'no-store', ...extra });

  /** A database failure in our words: the migration's path when a table is missing, else "try again". */
  function fromDb(e) {
    if (e?.name !== 'DbError') return e;
    if (e.code === 'NOT_SET_UP') {
      safeLog('offers_not_set_up', { hint: `run ${OFFERS_MIGRATION}` }, log);
      return notSetUp(`Run ${OFFERS_MIGRATION} in Supabase → SQL Editor.`);
    }
    safeLog('offers_db_failed', { code: e.code }, log);
    return fail(503, 'UNAVAILABLE', 'Couldn’t reach the database. Try again shortly.');
  }

  async function user(req, res) {
    if (!sameOrigin(req)) {
      drain(req);
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return null;
    }
    if (!auth?.enabled) {
      drain(req);
      reply(req, res, 503, { error: 'Sign-in isn’t set up on this app.', code: 'NOT_SET_UP' });
      return null;
    }
    let who = null;
    try {
      who = await auth.identify(req);
    } catch {
      drain(req);
      reply(req, res, 503, { error: 'Couldn’t check your sign-in. Try again shortly.', code: 'UNAVAILABLE' });
      return null;
    }
    if (!who?.id || !isUuid(who.id)) {
      drain(req);
      reply(req, res, 401, { error: 'Sign in first.', code: 'AUTH_REQUIRED' });
      return null;
    }
    return who;
  }

  async function body(req) {
    let b;
    try {
      b = await readJson(req, MAX_JSON);
    } catch (e) {
      throw e?.status === 413 ? fail(413, 'BAD_REQUEST', 'Request too large.') : fail(400, 'BAD_REQUEST', 'That request isn’t valid JSON.');
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'BAD_REQUEST', 'Send a JSON object.');
    return b;
  }

  async function needsActive(who) {
    if (blocked.has(who.id)) throw fail(409, 'ACCOUNT_DELETING', 'This account is being deleted.');
    if (!billing?.requireActive) return;
    try {
      await billing.requireActive(who, 'publish');
    } catch (e) {
      if (e?.status === 402) throw fail(402, e.code, e.message, { need: e.extra?.need ?? null, upgrade: '#plans' });
      throw fail(503, 'UNAVAILABLE', 'Couldn’t check your plan just now. Try again in a minute.');
    }
  }
  const notBlocked = (who) => {
    if (blocked.has(who.id)) throw fail(409, 'ACCOUNT_DELETING', 'This account is being deleted.');
  };
  const limited = (bucket, who) => {
    if (limit(bucket, who)) throw fail(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');
  };
  const cleanText = (v, max, what) => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > max * 4) throw fail(400, 'BAD_REQUEST', `${what} must be text, at most ${max} characters.`);
    const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (Array.from(s).length > max) throw fail(400, 'BAD_REQUEST', `${what} can be at most ${max} characters.`);
    return s;
  };
  const projectOf = (v) => {
    if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) throw fail(400, 'BAD_REQUEST', 'Unknown business.');
    return v;
  };
  const linkOf = (v) => {
    const href = normalizeLink(v);
    // a checkout link is https only: a buyer is never sent to a payment page over plain http
    if (!href || !href.startsWith('https:')) throw fail(400, 'BAD_URL', 'Use a full web address starting with https://, without a user name or password.');
    return href;
  };

  // ── offers ──
  /** Each offer's counted sales in its own environment (a sandbox offer's test sales, a live one's real ones). */
  async function salesByOffer(userId, offers) {
    const map = new Map();
    if (!offers.length) return map;
    // a Stripe offer sells in this deployment's one Stripe mode
    const envOf = new Map(offers.map((o) => [o.id, o.provider === 'stripe' ? (connect.cfg.environment ?? 'production') : o.provider_ref?.environment === 'sandbox' ? 'sandbox' : 'production']));
    const rows = await db.select('sales', { user_id: userId, offer_id: ['in', [...envOf.keys()]], status: ['in', SALE_COUNTED] }, { select: 'offer_id,environment,paid_at,created_at', limit: 5000 });
    for (const r of rows) {
      if (r.environment !== envOf.get(r.offer_id)) continue;
      const cur = map.get(r.offer_id) ?? { count: 0, last: null };
      cur.count++;
      const at = r.paid_at ?? r.created_at ?? null;
      if (at && (!cur.last || at > cur.last)) cur.last = at;
      map.set(r.offer_id, cur);
    }
    return map;
  }
  async function own(userId, id) {
    if (!ID_RE.test(String(id ?? ''))) throw fail(404, 'NOT_FOUND', 'That offer isn’t in your account.');
    const [row] = await db.select('offers', { id, user_id: userId }, { limit: 1 });
    if (!row) throw fail(404, 'NOT_FOUND', 'That offer isn’t in your account.');
    return row;
  }
  const out = async (row, origin) => describeOffer(row, origin, (await salesByOffer(row.user_id, [row])).get(row.id) ?? { count: 0, last: null }, (await stripeOffers.extrasFor([row])).get(row.id) ?? null);

  async function listOffers(who, url, origin) {
    const projectId = url.searchParams.get('projectId');
    const filters = { user_id: who.id, ...(projectId ? { project_id: projectOf(projectId) } : {}), ...(url.searchParams.get('archived') === '1' ? {} : { status: ['neq', 'archived'] }) };
    const rows = await db.select('offers', filters, { order: 'created_at.desc', limit: MAX_OFFERS_PER_USER });
    const sales = await salesByOffer(who.id, rows);
    const extras = await stripeOffers.extrasFor(rows);
    return { offers: rows.map((r) => describeOffer(r, origin, sales.get(r.id) ?? { count: 0, last: null }, extras.get(r.id) ?? null)) };
  }

  async function createExternal(who, b, origin) {
    const projectId = projectOf(b.projectId);
    const title = cleanText(b.title, 200, 'The title') ?? '';
    if (!title) throw fail(400, 'BAD_REQUEST', 'Give the offer a title.');
    const priceDisplay = cleanText(b.priceDisplay, 40, 'The price') ?? '';
    const url = linkOf(b.url);
    const crid = b.clientRequestId === undefined ? null : String(b.clientRequestId);
    if (crid !== null && !isUuid(crid)) throw fail(400, 'BAD_REQUEST', 'clientRequestId must be a UUID.');
    const id = crid ? pc.offerIdFor(who.id, crid) : newId();
    const [existing] = crid ? await db.select('offers', { id }, { limit: 1 }) : [];
    if (existing) {
      // the same request again (a double press) answers the offer it made; anything else with this id is refused
      if (existing.user_id !== who.id || existing.provider !== 'external') throw fail(409, 'CONFLICT', 'Try again.');
      return { offer: await out(existing, origin) };
    }
    const mine = await db.select('offers', { user_id: who.id, status: ['neq', 'archived'] }, { select: 'id', limit: MAX_OFFERS_PER_USER + 1 });
    if (mine.length >= MAX_OFFERS_PER_USER) throw fail(400, 'TOO_MANY', `You can have up to ${MAX_OFFERS_PER_USER} buy links. Archive one first.`);
    const inserted = await db.insert('offers', { id, user_id: who.id, project_id: projectId, title, price_display: priceDisplay, provider: 'external', provider_ref: { url }, status: 'active' }, { returning: true, ignoreDuplicates: true, onConflict: 'id' });
    const row = inserted[0] ?? (await own(who.id, id));
    return { offer: await out(row, origin) };
  }

  async function patchOffer(who, id, b, origin) {
    const row = await own(who.id, id);
    const patch = row.provider === 'stripe' ? await stripeOffers.patchFields(row, b) : {};
    const title = cleanText(b.title, 200, 'The title');
    if (title !== undefined) {
      if (!title) throw fail(400, 'BAD_REQUEST', 'Give the offer a title.');
      patch.title = title;
    }
    if (b.priceDisplay !== undefined && row.provider !== 'stripe') {
      if (row.provider !== 'external') throw fail(400, 'BAD_REQUEST', 'A Whop offer’s price comes from its plan: use “Refresh from Whop”.');
      patch.price_display = cleanText(b.priceDisplay, 40, 'The price');
    }
    if (b.url !== undefined && row.provider !== 'stripe') {
      if (row.provider !== 'external') throw fail(400, 'BAD_REQUEST', 'Attach another plan to change where a Whop offer goes.');
      patch.provider_ref = { ...(row.provider_ref ?? {}), url: linkOf(b.url) };
    }
    if (b.status !== undefined) {
      if (b.status === 'paused' && ['active', 'paused'].includes(row.status)) patch.status = 'paused';
      else if (b.status === 'active' && ['active', 'paused'].includes(row.status)) {
        if (row.status === 'paused' && row.provider === 'whop') await sellable(row);
        if (row.status === 'paused' && row.provider === 'stripe') await stripeOffers.sellable(row);
        patch.status = 'active';
      } else throw fail(409, 'BAD_STATUS', row.status === 'archived' ? 'This offer is archived.' : 'This offer’s link isn’t ready yet: use “Check again”.');
    }
    if (!Object.keys(patch).length) return { offer: await out(row, origin) };
    const [saved] = await db.update('offers', { id: row.id, user_id: who.id }, patch, { returning: true });
    buy.drop(row.id);
    return { offer: await out(saved ?? { ...row, ...patch }, origin) };
  }

  /** A paused Whop offer sells again only with its checkout link made and its Whop connection still connected. */
  async function sellable(row) {
    if (!PROVIDERS.whop.checkoutTarget(row)) throw fail(409, 'NOT_SELLABLE', 'This offer’s checkout link isn’t ready: attach a plan again.');
    const [conn] = row.connection_id ? await db.select('payment_connections', { id: row.connection_id, user_id: row.user_id }, { select: 'id,status', limit: 1 }) : [];
    if (!conn || conn.status !== 'active') throw fail(409, 'NOT_SELLABLE', 'The Whop account this offer used isn’t connected any more: attach another plan.');
  }

  async function archive(who, id, origin) {
    const row = await own(who.id, id);
    const [saved] = row.status === 'archived' ? [row] : await db.update('offers', { id: row.id, user_id: who.id }, { status: 'archived' }, { returning: true });
    buy.drop(row.id);
    return { offer: await out(saved ?? { ...row, status: 'archived' }, origin) };
  }

  async function remove(who, id) {
    if (!ID_RE.test(String(id ?? ''))) return { ok: true };
    const [sale] = await db.select('sales', { user_id: who.id, offer_id: id }, { select: 'id', limit: 1 });
    if (sale) throw fail(409, 'HAS_SALES', 'This offer has sales, so it stays for your records. Archive it instead.');
    // a Whop checkout link stays open at Whop after it's made: the row stays (archived) so a sale through it is
    // still recorded
    const [row] = await db.select('offers', { id, user_id: who.id }, { select: 'id,provider,provider_ref', limit: 1 });
    if (row?.provider === 'whop' && row.provider_ref?.checkoutId) throw fail(409, 'HAS_CHECKOUT', 'Whop’s checkout for this offer stays open, so it stays for your records. Archive it instead.');
    await db.remove('offers', { id, user_id: who.id });
    buy.drop(id);
    return { ok: true };
  }

  async function checkOffer(who, id, origin) {
    const row = await own(who.id, id);
    if (row.provider !== 'whop') return { status: 200, body: { offer: await out(row, origin) } };
    if (!whopOn) throw notSetUp('WHOP_ENABLED is off.', 'Whop isn’t available on this app right now.');
    const got = await whop.checkOffer(who, row);
    buy.drop(row.id);
    return { status: got.status, body: { offer: await out(got.row, origin) } };
  }

  async function listSales(who, url) {
    const projectId = projectOf(url.searchParams.get('projectId'));
    const env2 = url.searchParams.get('env') === 'sandbox' ? 'sandbox' : 'production';
    const n = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get('limit')) || 50)));
    const before = url.searchParams.get('before');
    const filters = { user_id: who.id, project_id: projectId, environment: env2 };
    if (before) {
      if (!Number.isFinite(Date.parse(before)) || before.length > 40) throw fail(400, 'BAD_REQUEST', 'Bad cursor.');
      filters.created_at = ['lt', new Date(Date.parse(before)).toISOString()];
    }
    const since = url.searchParams.get('since');
    if (since && Number.isFinite(Date.parse(since)) && !before) filters.created_at = ['gte', new Date(Date.parse(since)).toISOString()];
    const rows = await db.select('sales', filters, { order: 'created_at.desc', limit: n });
    return { sales: rows.map(describeSale), next: rows.length === n ? (rows.at(-1).created_at ?? null) : null };
  }

  async function summary(who, url) {
    const projectId = projectOf(url.searchParams.get('projectId'));
    const days = Math.min(365, Math.max(1, Math.trunc(Number(url.searchParams.get('days')) || 30)));
    const since = new Date(now() - days * 86_400_000).toISOString();
    const rows = await db.select('sales', { user_id: who.id, project_id: projectId, created_at: ['gte', since] }, { select: 'offer_id,environment,status,amount_minor,refunded_minor,currency', limit: 5000 });
    const live = { count: 0, revenue: {}, refunded: {} };
    let test = 0;
    const perOffer = new Map();
    for (const r of rows) {
      if (!SALE_COUNTED.includes(r.status)) continue;
      if (r.environment !== 'production') {
        test++;
        continue;
      }
      live.count++;
      const cur = String(r.currency);
      live.revenue[cur] = (live.revenue[cur] ?? 0) + (Number(r.amount_minor) || 0);
      if (Number(r.refunded_minor) > 0) live.refunded[cur] = (live.refunded[cur] ?? 0) + Number(r.refunded_minor);
      if (r.offer_id) perOffer.set(r.offer_id, (perOffer.get(r.offer_id) ?? 0) + 1);
    }
    const offers = await db.select('offers', { user_id: who.id, project_id: projectId }, { select: 'id,clicks', limit: MAX_OFFERS_PER_USER * 2 });
    return { days, live, test: { count: test }, clicks: offers.reduce((n, o) => n + (Number(o.clicks) || 0), 0), offers: offers.map((o) => ({ id: o.id, clicks: Number(o.clicks) || 0, sales: perOffer.get(o.id) ?? 0 })) };
  }

  /** POST /api/offers/sales/<sale id>/download-link: a new 7-day link for a buyer who lost theirs (no plan needed). */
  async function saleDownloadLink(who, saleId, req) {
    if (!isUuid(saleId)) throw fail(404, 'NOT_FOUND', 'That sale isn’t in your account.');
    const [sale] = await db.select('sales', { id: saleId, user_id: who.id }, { select: 'id,offer_id,provider,status', limit: 1 });
    if (!sale || sale.provider !== 'stripe' || !sale.offer_id) throw fail(404, 'NOT_FOUND', 'That sale isn’t in your account.');
    const [offer] = await db.select('offers', { id: sale.offer_id, user_id: who.id }, { select: 'id,provider,delivery', limit: 1 });
    if (!offer || offer.provider !== 'stripe' || offer.delivery?.kind !== 'file') throw fail(409, 'NO_FILE', 'This offer has no file to download.');
    if (!['paid', 'partially_refunded'].includes(sale.status)) throw fail(409, 'NOT_PAID', 'This sale was refunded or disputed, so its download is closed.');
    const ticket = stripeCheckout.makeTicket(sale.id);
    if (!ticket) throw notSetUp('Set LEAD_LINK_SECRET (16+ characters) or SUPABASE_SECRET_KEY.', 'Download links aren’t available right now.');
    const origin = connect.cfg.publicOrigin ?? originFor(req, env);
    return { url: `${origin}/b/${offer.id}/file?t=${ticket}`, expiresAt: new Date(now() + 7 * 86_400_000).toISOString() };
  }

  async function routeOffers(req, res, url, who) {
    const p = url.pathname;
    const origin = originFor(req, env);
    const link = /^\/api\/offers\/sales\/([^/]{1,64})\/download-link$/.exec(p.length <= 120 ? p : '');
    if (link) {
      if (req.method !== 'POST') throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
      limited('sale-link', who.id);
      notBlocked(who);
      return reply(req, res, 200, await saleDownloadLink(who, link[1], req));
    }
    const m = /^\/api\/offers(?:\/([^/]{1,64})(?:\/(check|archive))?)?$/.exec(p.length <= 120 ? p : '');
    if (!m) throw fail(404, 'NOT_FOUND', 'Not found.');
    const [, id, action] = m;
    const method = req.method;
    if (method === 'GET') limited('offers-read', who.id);
    else limited('offers-write', who.id);
    if (id === undefined) {
      if (method === 'GET') return reply(req, res, 200, await listOffers(who, url, origin));
      if (method !== 'POST') throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
      await needsActive(who);
      const b = await body(req);
      if (b.provider === 'external') return reply(req, res, 200, await createExternal(who, b, origin));
      if (b.provider === 'whop') {
        if (!whopOn) throw notSetUp('WHOP_ENABLED is off.', 'Whop isn’t available on this app right now.');
        const got = await whop.createOffer(who, b, origin, pc.offerIdFor);
        return reply(req, res, got.status, { offer: await out(got.row, origin) });
      }
      if (b.provider === 'stripe') {
        if (!stripeOn) throw notSetUp(`Stripe Connect needs: ${connect.cfg.missing().join(', ') || 'SUPABASE_URL and SUPABASE_SECRET_KEY'}.`, connect.MSG.unavailable);
        const row = await stripeOffers.create(who, b);
        buy.drop(row.id);
        return reply(req, res, 200, { offer: await out(row, origin) });
      }
      throw fail(400, 'BAD_REQUEST', 'Choose Whop, Stripe or your own checkout link.');
    }
    if (id === 'sales' && !action && method === 'GET') return reply(req, res, 200, await listSales(who, url));
    if (id === 'summary' && !action && method === 'GET') return reply(req, res, 200, await summary(who, url));
    if (!ID_RE.test(id)) throw fail(404, 'NOT_FOUND', 'That offer isn’t in your account.');
    if (action === 'check' && method === 'POST') {
      await needsActive(who);
      const got = await checkOffer(who, id, origin);
      return reply(req, res, got.status, got.body);
    }
    if (action === 'archive' && method === 'POST') return reply(req, res, 200, await archive(who, id, origin));
    if (action) throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
    if (method === 'PATCH') {
      const b = await body(req);
      // pausing and resuming alone never need a plan
      if (Object.keys(b).some((k) => k !== 'status')) await needsActive(who);
      else notBlocked(who);
      return reply(req, res, 200, await patchOffer(who, id, b, origin));
    }
    if (method === 'DELETE') return reply(req, res, 200, await remove(who, id));
    throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
  }

  async function routeWhop(req, res, url, who) {
    const p = url.pathname;
    const origin = originFor(req, env);
    const m = /^\/api\/payments\/whop(?:\/([^/]{1,64})(?:\/(products|plans|webhook-secret|check|enable-webhook|key))?)?$/.exec(p.length <= 120 ? p : '');
    if (!m) throw fail(404, 'NOT_FOUND', 'Not found.');
    const [, id, action] = m;
    const method = req.method;
    if (id === undefined && method === 'GET') {
      limited('offers-read', who.id);
      return reply(req, res, 200, await whop.list(who.id, origin));
    }
    if (!whopOn) throw notSetUp('WHOP_ENABLED is off.', 'Whop isn’t available on this app right now.');
    if (id === undefined) {
      if (method !== 'POST') throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
      limited('whop-connect', who.id);
      await needsActive(who);
      const b = await body(req);
      try {
        return reply(req, res, 200, await whop.connect(who, b, origin));
      } finally {
        // the pasted key leaves this request's memory with it
        b.key = undefined;
      }
    }
    if (!ID_RE.test(id)) throw fail(404, 'NOT_FOUND', 'That Whop connection isn’t in your account.');
    if ((action === 'products' || action === 'plans') && method === 'GET') {
      limited('whop-catalog', who.id);
      if (action === 'products') return reply(req, res, 200, await whop.products(who, id, url.searchParams.get('after')));
      return reply(req, res, 200, await whop.plans(who, id, url.searchParams.get('productId'), url.searchParams.get('after')));
    }
    limited('whop-connect', who.id);
    notBlocked(who);
    if (action === 'webhook-secret' && method === 'POST') return reply(req, res, 200, await whop.pasteSecret(who, id, await body(req), origin));
    if (action === 'check' && method === 'POST') return reply(req, res, 200, await whop.check(who, id, origin));
    if (action === 'enable-webhook' && method === 'POST') return reply(req, res, 200, await whop.enableWebhook(who, id, origin));
    if (action === 'key' && method === 'PUT') {
      const b = await body(req);
      try {
        const got = await whop.replaceKey(who, id, b, origin);
        buy.dropConnection(id);
        return reply(req, res, 200, got);
      } finally {
        b.key = undefined;
      }
    }
    if (!action && method === 'DELETE') {
      const got = await whop.disconnect(who, id, { confirm: url.searchParams.get('confirm') === '1' });
      buy.dropConnection(id);
      return reply(req, res, 200, got);
    }
    throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
  }

  /** /api/payments/stripe…: the seller's own Stripe account (server/payments/stripeConnect.mjs). */
  async function routeStripe(req, res, url, who) {
    const p = url.pathname;
    const owner = /^\/api\/payments\/stripe\/admin(?:\/alerts\/([^/]{1,60})\/resolve)?$/.exec(p.length <= 120 ? p : '');
    if (owner) {
      if (who.isAdmin !== true) throw fail(403, 'FORBIDDEN', 'Only the app’s owner can see this.');
      limited('stripe-connect-read', who.id);
      if (!owner[1] && req.method === 'GET') return reply(req, res, 200, await connect.adminView({ emailFor: async (id) => (billing?.emailFor ? billing.emailFor(id) : '') }));
      if (owner[1] && req.method === 'POST') return reply(req, res, 200, await connect.resolveAlert(owner[1]));
      throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
    }
    const m = /^\/api\/payments\/stripe(?:\/(onboarding|sync|tax))?$/.exec(p.length <= 80 ? p : '');
    if (!m) throw fail(404, 'NOT_FOUND', 'Not found.');
    const [, action] = m;
    const method = req.method;
    if (!action && method === 'GET') {
      limited('stripe-connect-read', who.id);
      return reply(req, res, 200, await connect.view(who));
    }
    if (!stripeOn) throw notSetUp(`Stripe Connect needs: ${connect.cfg.missing().join(', ') || 'SUPABASE_URL and SUPABASE_SECRET_KEY'}.`, connect.MSG.unavailable);
    if (!action && method === 'POST') {
      limited('stripe-connect', who.id);
      notBlocked(who);
      const b = await body(req);
      const got = await connect.create(who, b, { needsActive });
      return reply(req, res, got.status, { account: accountView(got.row) });
    }
    if (action === 'onboarding' && method === 'POST') {
      limited('stripe-connect', who.id);
      notBlocked(who);
      await body(req);
      const origin = connect.cfg.publicOrigin ?? originFor(req, env);
      return reply(req, res, 200, await connect.onboardingLink(who, origin));
    }
    if (action === 'sync' && method === 'POST') {
      limited('stripe-connect-read', who.id);
      notBlocked(who);
      await body(req);
      return reply(req, res, 200, await connect.sync(who));
    }
    if (action === 'tax' && method === 'PUT') {
      limited('stripe-connect-read', who.id);
      notBlocked(who);
      return reply(req, res, 200, await connect.setTax(who, await body(req)));
    }
    if (!action && method === 'DELETE') {
      limited('offers-write', who.id);
      return reply(req, res, 200, await connect.disconnect(who, { confirm: url.searchParams.get('confirm') === '1' }));
    }
    throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
  }

  return {
    enabled: true,
    buy,
    config,
    notes,
    whop,
    /** Stripe Connect's core (accounts, alerts), for the webhook and tests */
    connect,
    /** /connect/return and /connect/refresh on the app's host (fixed redirects into the app) */
    connectPages: serveConnectReturn,

    async handle(req, res, url) {
      const p = url.pathname;
      if (p === ROUTE_PREFIXES.stripeConnectWebhook || p.startsWith(`${ROUTE_PREFIXES.stripeConnectWebhook}/`)) {
        if (req.method !== 'POST' || p !== ROUTE_PREFIXES.stripeConnectWebhook) {
          drain(req);
          reply(req, res, req.method !== 'POST' ? 405 : 404, { error: req.method !== 'POST' ? 'Method not allowed.' : 'Not found.', code: req.method !== 'POST' ? 'BAD_REQUEST' : 'NOT_FOUND' }, req.method !== 'POST' ? { allow: 'POST' } : {});
          return true;
        }
        const got = await connectHooks.webhook(req, { limited: (r) => limit('stripe-connect-webhook', clientKey(r)), readRaw });
        reply(req, res, got.status, got.body);
        return true;
      }
      if (p.startsWith(ROUTE_PREFIXES.whopWebhook)) {
        if (req.method !== 'POST') {
          drain(req);
          reply(req, res, 405, { error: 'Method not allowed.', code: 'BAD_REQUEST' }, { allow: 'POST' });
          return true;
        }
        const id = p.slice(ROUTE_PREFIXES.whopWebhook.length);
        const got = await whop.webhook(req, id, { limited: (r) => limit('whop-webhook', clientKey(r)), readRaw, drain });
        reply(req, res, got.status, got.body, got.close ? { connection: 'close' } : {});
        return true;
      }
      const under = (prefix) => p === prefix || p.startsWith(`${prefix}/`);
      if (!under(ROUTE_PREFIXES.offers) && !under(ROUTE_PREFIXES.whop) && !under(ROUTE_PREFIXES.stripePayments)) return false;
      const who = await user(req, res);
      if (!who) return true;
      try {
        if (under(ROUTE_PREFIXES.offers)) await routeOffers(req, res, url, who);
        else if (under(ROUTE_PREFIXES.stripePayments)) await routeStripe(req, res, url, who);
        else await routeWhop(req, res, url, who);
      } catch (e) {
        const mapped = fromDb(e);
        if (!mapped?.code) safeLog('offers_error', { error: e?.name || 'Error' }, log);
        if (res.headersSent) return true;
        drain(req);
        const { status, body: b } = errorBody(mapped, who);
        reply(req, res, status, b, b.code === 'WHOP_BUSY' && b.retryAfter ? { 'retry-after': String(b.retryAfter) } : {});
      }
      return true;
    },

    /**
     * server/cron: Whop's daily webhook check and read-only reconcile; Stripe Connect's hourly read-backs (accounts
     * whose create didn't answer, fee returns) and daily account sync and read-only reconcile (all claim their run).
     */
    cronJobs: () => [
      ...(whopOn ? [
        { name: 'offers-webhooks', dailyAtUtc: '04:17', run: (ctx) => whop.healthCheck(ctx) },
        { name: 'offers-reconcile', dailyAtUtc: '04:47', run: (ctx) => whop.reconcile(ctx) },
      ] : []),
      ...(stripeOn ? [
        { name: 'connect-readback', everyMs: 3_600_000, run: () => connect.cronReadback() },
        { name: 'connect-fees', everyMs: 3_600_000, run: () => connectHooks.cronFees() },
        { name: 'connect-sync', dailyAtUtc: '04:31', run: (ctx) => connect.cronSync(ctx) },
        { name: 'connect-reconcile', dailyAtUtc: '05:07', run: (ctx) => connectHooks.cronReconcile(ctx) },
      ] : []),
    ],
    /** P1's webhook hands our fee events (application_fee.*) here. */
    connectPlatformEvent: (evt) => (stripeOn ? connectHooks.onPlatformEvent(evt) : Promise.resolve('ignored')),
    /** for tests: the Connect webhook's parts (fee returns, crons) */
    connectHooks,

    /** Before an account is deleted: its buy links stop on this copy at once, then one attempt at each webhook. */
    async forgetUser(userId) {
      blocked.add(userId);
      buy.forgetUser(userId);
      await whop.forgetUser(userId);
      // the seller's Stripe account stays theirs (never deleted here); a fee return still unclear is for the owner to
      // check in Stripe once the rows are gone
      if (stripeOn) {
        try {
          const unclear = await db.select('connect_fee_returns', { user_id: userId, state: 'unknown' }, { select: 'source_id', limit: 50 });
          for (const r of unclear) await connect.alert('fee_return_unknown', { source: String(r.source_id).slice(0, 40), where: 'account_deleted' });
        } catch {
          /* best effort */
        }
      }
    },
    async unforgetUser(userId) {
      blocked.delete(userId);
      buy.unforgetUser(userId);
    },
    /**
     * The ids of a user's offers (every status: a paused or archived one's /b/ link says so to buyers). Omnisend
     * drafts (server/omnisend.mjs) check an email's buy links against them: only the caller's own become links.
     */
    async idsFor(userId) {
      if (!isUuid(userId)) return [];
      try {
        const rows = await db.select('offers', { user_id: userId }, { select: 'id', limit: MAX_OFFERS_PER_USER * 20 });
        return rows.map((r) => r.id).filter((id) => ID_RE.test(id));
      } catch (e) {
        throw fromDb(e);
      }
    },
    /** For the app's hints: the checkout sites buyers go to straight from /b/. */
    checkoutHosts: CHECKOUT_HOSTS,
  };
}
