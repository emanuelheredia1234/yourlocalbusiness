// /b/<id> for Stripe offers (P6): a Checkout Session made on the seller's own Stripe account for each real click (a
// direct charge with our fee by plan), the thank-you page that reads the session back, the paid download, and the
// "checkout cancelled" page. Reached through server/offers/buy.mjs, after its own checks (limits, not found, gone).
//
//   GET|HEAD /b/<id>                          → 303 to checkout.stripe.com (only), or a notice
//   GET|HEAD /b/<id>/done?session_id=cs_…     → the thank-you page (reads the session; records the sale)
//   GET|HEAD /b/<id>/file?session_id=cs_…|t=… → 302 to a 60-second signed download (a paid product file)
//   GET|HEAD /b/<id>/back                     → "Checkout cancelled. Nothing was charged."
//
// Money and safety rules (docs/integrations-setup.md "Stripe Connect"):
// - The only redirect is to the session's url, checked every time: https, no user, password or port, host exactly
//   checkout.stripe.com (tests: the mock's own /__pay/ with a test key). Anything else: no redirect, an owner alert.
//   Nothing from the request (query, Referer, Host) chooses where anyone goes: success and cancel pages use the
//   seller's verified domain (when served there) or APP_PUBLIC_URL.
// - One write per click, never retried here: the Idempotency-Key is a hash of the browser (a first-party ylb_v cookie
//   set on the redirect; before it, the address with the browser's user agent and language) and the whole session
//   body (offer, price, fee and its plan, origin, tax, the 10-minute window), so a double click or an email scanner
//   gets Stripe's replay of one session, and a changed body is a new key (never Stripe's idempotency_error). A replay
//   is read back before anyone is sent to it: a session already completed or expired (someone else on the same
//   address paid it) is never reused; one new session is made under a key derived from it. Stripe still working on the
//   same key (409), or refusing it, answers "try again in a minute". A timeout answers the same (the buyer's own retry
//   replays the same key).
// - The fee is the seller's plan's (billing.entitlement; fail closed: no fee known, no sale) and is left out at 0,
//   at or above the price, or for a seller in Brazil (server/payments/connectFee.mjs).
// - HEAD and prefetches never make a session nor count a click.
// - The thank-you page shows "payment received" only for a session read back from Stripe on the offer's own account,
//   with our metadata and the right mode; anything else gets the plain page that claims nothing.
// - A cs_ id is a bearer secret for its download: queries are never logged (server/integrations/common.mjs redactPath).

import crypto from 'node:crypto';
import { escapeHtml, leadNotice, NOTICE_CSP, DOWNLOAD_NOTICE_CSP, windowCounter } from '../leads.mjs';
import { signProductDownload } from '../leadFiles.mjs';
import { safeLog, sha256 } from '../integrations/common.mjs';
import { feeForEntitlement, platformFee } from '../payments/connectFee.mjs';

export const CHECKOUT_HOST = 'checkout.stripe.com';
export const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const BUCKET_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const TICKET_DAYS = 7;
const VISITOR_COOKIE = 'ylb_v';
const COOKIE_RE = /(?:^|;\s*)ylb_v=([A-Za-z0-9_-]{22})(?:;|$)/;
/** Replays followed at most this many times for one click (each a new session under a key derived from the last). */
const MAX_FRESH = 2;
const PREFETCH = (req) => /prefetch/i.test(`${String(req.headers['sec-purpose'] ?? '').slice(0, 100)} ${String(req.headers.purpose ?? '').slice(0, 100)} ${String(req.headers['x-moz'] ?? '').slice(0, 100)}`);

/**
 * Where a buyer may be sent for a Checkout Session's url: the url, or null. testBase: the mock's origin (only when the
 * Stripe client's base was overridden with a test key), whose /__pay/ path is allowed too.
 */
export function validCheckoutUrl(raw, { testBase = null } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:' && u.port === '' && u.hostname === CHECKOUT_HOST) return u.href;
  if (testBase) {
    let t;
    try {
      t = new URL(testBase);
    } catch {
      return null;
    }
    if (u.origin === t.origin && u.pathname.startsWith('/__pay/')) return u.href;
  }
  return null;
}

/** A seller's buyer ticket for /b/<offer>/file?t=: HMAC over "s1|<sale id>|<exp>" (7 days). */
export function makeSaleTicket(secret, saleId, now = Date.now(), days = TICKET_DAYS) {
  const exp = Math.floor((now + days * DAY_MS) / 1000);
  const mac = crypto.createHmac('sha256', secret).update(`s1|${saleId}|${exp}`).digest('base64url').slice(0, 32);
  return `${exp.toString(36)}.${Buffer.from(saleId.replace(/-/g, ''), 'hex').toString('base64url')}.${mac}`;
}
/** The sale id a ticket names, or null (bad, forged, expired). */
export function checkSaleTicket(secret, t, now = Date.now()) {
  const m = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{32})$/.exec(String(t ?? ''));
  if (!m) return null;
  const exp = parseInt(m[1], 36);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  const hex = Buffer.from(m[2], 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const saleId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const want = crypto.createHmac('sha256', secret).update(`s1|${saleId}|${exp}`).digest('base64url').slice(0, 32);
  const a = Buffer.from(m[3]);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? saleId : null;
}

/**
 * What record_sale is sent for a Checkout Session read back from Stripe (expand payment_intent[.latest_charge]).
 * row: the offer; acct: its connect_accounts row; status: paid | pending | failed; at: the event's time (ms).
 */
export function saleFromSession(session, row, acct, { status, at }) {
  const pi = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const piId = pi?.id ?? (typeof session.payment_intent === 'string' ? session.payment_intent : null);
  const charge = pi?.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const feeId = typeof charge?.application_fee === 'string' ? charge.application_fee : charge?.application_fee?.id ?? null;
  const pct = Number(session.metadata?.ylb_fee_pct);
  const tier = String(session.metadata?.ylb_fee_tier ?? '');
  const email = session.customer_details?.email;
  return {
    user_id: row.user_id,
    project_id: row.project_id,
    offer_id: row.id,
    provider: 'stripe',
    environment: acct.environment,
    provider_account: acct.stripe_account_id,
    provider_payment_id: piId,
    checkout_session_id: session.id,
    status,
    amount_minor: Number(session.amount_total) || 0,
    refunded_minor: 0,
    application_fee_minor: Number.isSafeInteger(pi?.application_fee_amount) && pi.application_fee_amount > 0 ? pi.application_fee_amount : null,
    application_fee_id: /^fee_[A-Za-z0-9]+$/.test(String(feeId ?? '')) ? feeId : null,
    fee_pct: Number.isInteger(pct) && pct >= 0 && pct <= 100 ? pct : null,
    fee_tier: ['launch', 'grow', 'scale', 'owner', 'legacy', 'none'].includes(tier) ? tier : null,
    currency: String(session.currency ?? '').toLowerCase(),
    buyer_email: typeof email === 'string' && email.length <= 254 ? email : null,
    paid_at: status === 'paid' ? new Date(at).toISOString() : null,
    last_event_at: new Date(at).toISOString(),
  };
}

/**
 * deps: db; connect (server/payments/stripeConnect.mjs core); billing (entitlement); env; now; log; linkSecret (sale
 * tickets); supabase ({ supabaseUrl, secretKey, fetch }, product downloads).
 */
export function createStripeCheckout({ db, connect, billing = null, env = process.env, now = () => Date.now(), log = console, linkSecret = null, supabase = {} }) {
  const cfg = connect.cfg;
  const stripe = connect.stripe;
  const perVisitor = windowCounter(cfg.sessionsPerVisitorPerHour, 3_600_000);
  const verified = new Map(); // `${offer}|${session}` → { until, value }
  const testBase = stripe.mode === 'test' && String(env.STRIPE_API_BASE ?? '').trim() ? String(env.STRIPE_API_BASE).trim() : null;
  const NOT_NOW = [503, 'Not available right now', 'This isn’t available to buy right now. Try again later.'];

  /** The origin for success and cancel pages: the seller's verified domain when served there, else APP_PUBLIC_URL. */
  function originOf(site) {
    const domain = String(site?.domain ?? '').toLowerCase();
    if (site && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return `https://${domain}`;
    return cfg.publicOrigin;
  }

  /** Whether a Stripe offer can sell now (else the generic NOT_NOW; never says why). */
  function sellable(row, acct) {
    if (!connect.enabled || !acct || acct.status !== 'active' || acct.charges_enabled !== true) return false;
    if (acct.user_id !== row.user_id || acct.environment !== cfg.environment || !acct.stripe_account_id) return false;
    const price = Number(row.price_minor);
    return Number.isSafeInteger(price) && price > 0 && /^[a-z]{3}$/.test(String(row.currency ?? ''));
  }

  /** The thank-you and other pages name the seller (the merchant of record), never us (and never the offer's title). */
  const sellerName = (acct) => escapeHtml(String(acct?.display_name || 'the seller').slice(0, 120));

  /** Whether a Stripe answer is about the Idempotency-Key itself (still in flight: 409; or refused). */
  const keyTrouble = (got) => got.status === 409 || got.error?.type === 'idempotency_error' || /^idempotency/.test(String(got.error?.code ?? ''));

  /** A replayed session as it is now: true when it can still be paid (open, not expired), false when not, null unread. */
  async function stillOpen(acct, session) {
    try {
      const now_ = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(session.id)}`, {}, { account: acct.stripe_account_id });
      return now_?.id === session.id && now_.status === 'open' && !(Number(now_.expires_at) * 1000 <= now());
    } catch (e) {
      safeLog('connect_session_read_failed', { kind: e?.kind, code: e?.code }, log);
      return null;
    }
  }

  /** GET|HEAD /b/<id> for a Stripe offer (after buy.mjs's checks). page: buy.mjs's helpers. */
  async function checkout(req, res, { row, acct, site, visitorKey, page }) {
    const { notice, write, retryAfter, counted } = page;
    if (!sellable(row, acct)) return notice(req, res, ...NOT_NOW, retryAfter(3_600_000));
    // a preview or a prefetch: a link to continue, no session and no click
    if (req.method === 'HEAD' || PREFETCH(req)) return write(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': NOTICE_CSP }, leadNotice(escapeHtml(row.title || 'Checkout'), `Payments are processed by Stripe for ${sellerName(acct)}.</p>\n<p class="back"><a href="/b/${row.id}" rel="nofollow">Continue to checkout</a>`, ''));
    const key = `${visitorKey}|${row.id}`;
    if (perVisitor.full(key)) return notice(req, res, 429, 'Please wait a little', 'This was asked for a lot just now. Try again later.', retryAfter(perVisitor.wait(key)));
    perVisitor.hit(key);
    const origin = originOf(site);
    if (!origin || (cfg.live && !origin.startsWith('https://'))) {
      void connect.alert('connect_no_public_url', { where: 'checkout' }, { oncePerMs: DAY_MS });
      return notice(req, res, ...NOT_NOW, retryAfter(3_600_000));
    }
    // the fee by the seller's plan: never sell without knowing it
    let fee;
    try {
      if (!billing?.entitlement) throw new Error('no billing');
      fee = feeForEntitlement(await billing.entitlement(row.user_id));
    } catch {
      safeLog('connect_checkout_no_fee', {}, log);
      return notice(req, res, ...NOT_NOW, retryAfter(300_000));
    }
    const amount = Number(row.price_minor);
    const { fee: feeMinor, reason } = platformFee({ amountMinor: amount, pct: fee.pct, sellerCountry: acct.country, platformCountry: cfg.platformCountry });
    if (reason === 'country') void connect.alert('fee_not_allowed_br', {}, { oncePerMs: DAY_MS });
    await counted(row.id);
    const t = now();
    const bucket = Math.floor(t / BUCKET_MS);
    // the browser: its own cookie, else (its first click) the address with its user agent and language
    const cookie = COOKIE_RE.exec(String(req.headers.cookie ?? '').slice(0, 4096))?.[1] ?? null;
    const browser = cookie ? `c:${cookie}` : `a:${sha256(`${visitorKey}|${String(req.headers['user-agent'] ?? '').slice(0, 300)}|${String(req.headers['accept-language'] ?? '').slice(0, 100)}`)}`;
    const body = {
      mode: 'payment',
      line_items: [{ price_data: { currency: row.currency, unit_amount: amount, product_data: { name: String(row.title || 'Order').slice(0, 200) } }, quantity: 1 }],
      payment_intent_data: { ...(feeMinor > 0 ? { application_fee_amount: feeMinor } : {}), metadata: { ylb_offer: row.id } },
      metadata: { ylb_offer: row.id, ylb_fee_pct: String(fee.pct), ylb_fee_tier: fee.tier },
      client_reference_id: row.id,
      success_url: `${origin}/b/${row.id}/done?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/b/${row.id}/back`,
      expires_at: Math.floor((bucket * BUCKET_MS) / 1000) + 3600,
      ...(acct.tax_enabled === true && acct.tax_status === 'active' ? { automatic_tax: { enabled: true } } : {}),
    };
    // the key covers the whole body: a change of origin, tax, fee or plan is a new key, not Stripe's idempotency_error
    const bodyHash = sha256(`${row.updated_at ?? ''}|${JSON.stringify(body)}`);
    let got = await stripe.post('/v1/checkout/sessions', body, { idempotencyKey: `ylb-cs:${sha256(`${browser}|${bodyHash}`).slice(0, 48)}`, account: acct.stripe_account_id });
    // a replay is the first answer as it was: read the session now, and never send anyone to one already paid or over
    for (let fresh = 0; got.outcome === 'ok' && got.replayed && SESSION_RE.test(String(got.value?.id ?? '')); fresh++) {
      const open = await stillOpen(acct, got.value);
      if (open === true) break;
      if (open === null || fresh >= MAX_FRESH) {
        safeLog('connect_checkout_replay_closed', { read: open !== null }, log);
        return notice(req, res, 503, 'Checkout didn’t open', `Checkout didn’t open. Try again in a minute.</p>\n<p class="back"><a href="/b/${row.id}" rel="nofollow">Try again</a>`, retryAfter(60_000));
      }
      // one new session, under a key derived from the closed one (a new write, so a new key; a repeat replays it)
      got = await stripe.post('/v1/checkout/sessions', body, { idempotencyKey: `ylb-cs:${sha256(`${browser}|${bodyHash}|after:${got.value.id}`).slice(0, 48)}`, account: acct.stripe_account_id });
    }
    if (got.outcome === 'ok') {
      const href = validCheckoutUrl(got.value?.url, { testBase });
      if (!href) {
        let host = '';
        try {
          host = new URL(String(got.value?.url ?? '')).host.slice(0, 120);
        } catch {
          host = 'unreadable';
        }
        void connect.alert('checkout_url_unexpected', { host });
        return notice(req, res, ...NOT_NOW, retryAfter(3_600_000));
      }
      // this browser's own key from now on (first-party, this path only, an hour)
      const setCookie = cookie ? {} : { 'set-cookie': `${VISITOR_COOKIE}=${crypto.randomBytes(16).toString('base64url')}; Path=/b/; Max-Age=3600; HttpOnly; SameSite=Lax${origin.startsWith('https://') ? '; Secure' : ''}` };
      res.writeHead(303, { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'cache-control': 'no-store', ...setCookie, location: href, 'content-length': 0 });
      return res.end();
    }
    if (got.outcome === 'failed' && keyTrouble(got)) {
      // a double click still in flight (409), or a key Stripe refused: a minute, not an hour
      safeLog('connect_checkout_key_busy', { status: got.status }, log);
      return notice(req, res, 503, 'Checkout didn’t open', `Checkout didn’t open. Try again in a minute.</p>\n<p class="back"><a href="/b/${row.id}" rel="nofollow">Try again</a>`, retryAfter(60_000));
    }
    if (got.outcome === 'failed') {
      const mapped = connect.mapStripeError(got.error, 'checkout');
      if (mapped.extra?.sellerSync) void connect.rows.syncRow(acct).catch(() => null);
      safeLog('connect_checkout_refused', { code: String(got.error?.code ?? '').slice(0, 60), status: got.status }, log);
      return notice(req, res, ...NOT_NOW, retryAfter(3_600_000));
    }
    // timeout or 5xx: no automatic retry (the buyer's own retry replays the same key)
    safeLog('connect_checkout_unknown', { reason: got.reason ?? 'unknown' }, log);
    return notice(req, res, 503, 'Checkout didn’t open', 'Checkout didn’t open. Try again in a minute.', retryAfter(60_000));
  }

  const html = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': NOTICE_CSP };
  /** The thank-you page that claims nothing (a session we can't confirm, or none). */
  const plainThanks = (req, res, row, acct, page) => page.write(req, res, 200, html, leadNotice('Thanks for your order', `Thanks. If ${sellerName(acct)} sends receipts, yours comes by email.`, ''));
  /** The receipt line: Stripe emails one only when the seller turned that on, and never for a test payment. */
  const receiptLine = (session, seller) => (session.livemode === true ? ` If ${seller} sends receipts, yours comes by email.` : ' This was a test payment: no receipt is sent.');

  /**
   * A Checkout Session read back from Stripe on the offer's own account, checked to be this offer's (metadata,
   * client_reference_id, mode): the session, or null. Cached 10 minutes per (offer, session).
   */
  async function verifiedSession(row, acct, sid) {
    if (!SESSION_RE.test(String(sid ?? '')) || !acct?.stripe_account_id || acct.user_id !== row.user_id || !connect.enabled) return null;
    const key = `${row.id}|${sid}`;
    const hit = verified.get(key);
    if (hit && hit.until > now()) return hit.value;
    let session = null;
    try {
      // a read is tried once more after a 5xx or a network error (the client's rule)
      session = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(sid)}`, { 'expand[]': ['payment_intent.latest_charge'] }, { account: acct.stripe_account_id });
    } catch (e) {
      safeLog('connect_session_read_failed', { kind: e?.kind, code: e?.code }, log);
      return null;
    }
    const ok = session?.id === sid && session.metadata?.ylb_offer === row.id && session.client_reference_id === row.id && session.livemode === cfg.live && session.mode === 'payment';
    const value = ok ? session : null;
    verified.set(key, { value, until: now() + (value?.status === 'complete' && value?.payment_status === 'paid' ? 10 * 60_000 : 30_000) });
    while (verified.size > 5000) verified.delete(verified.keys().next().value);
    return value;
  }

  /**
   * Record a paid session as a sale: the same shape as the webhook's (record_sale is idempotent). Only 'paid': a
   * payment still processing, or one that failed, is the webhook's to record (a page load is no event, and its time
   * could put a failed payment back to pending).
   */
  async function recordFromSession(session, row, acct) {
    if (session.status !== 'complete' || session.payment_status !== 'paid') return null;
    const p = saleFromSession(session, row, acct, { status: 'paid', at: now() });
    if (!/^pi_[A-Za-z0-9]+$/.test(String(p.provider_payment_id ?? ''))) return null;
    try {
      await db.rpc('record_sale', { p });
    } catch (e) {
      safeLog('connect_thanks_record_failed', { code: e?.code }, log);
    }
    return p;
  }

  /** GET|HEAD /b/<id>/done?session_id=cs_… */
  async function thanks(req, res, { row, acct, url, page }) {
    const sid = url.searchParams.get('session_id');
    const session = await verifiedSession(row, acct, sid);
    if (!session) return plainThanks(req, res, row, acct, page);
    const seller = sellerName(acct);
    if (session.status === 'complete' && session.payment_status === 'paid') {
      if (req.method === 'GET') await recordFromSession(session, row, acct);
      const by = `Payment received. Sold by ${seller}. Payments are processed by Stripe for ${seller}.${receiptLine(session, seller)}`;
      if (row.delivery?.kind === 'file') {
        return page.write(req, res, 200, { ...html, 'content-security-policy': DOWNLOAD_NOTICE_CSP }, leadNotice('Thanks for your order', `${by}</p>\n<p>Save this page to download again for ${cfg.downloadDays} days.`, '', { href: `/b/${row.id}/file?session_id=${sid}`, label: String(row.title || 'your file').slice(0, 120) }));
      }
      return page.write(req, res, 200, html, leadNotice('Thanks for your order', `${by}</p>\n<p>The seller will be in touch.`, ''));
    }
    if (session.status === 'complete') {
      // not paid: processing, unless the webhook already recorded that it failed (then the plain page claims nothing)
      let sale = null;
      try {
        [sale] = await db.select('sales', { provider: 'stripe', environment: cfg.environment, checkout_session_id: sid }, { select: 'status', limit: 1 });
      } catch {
        sale = null;
      }
      if (sale?.status === 'failed') return plainThanks(req, res, row, acct, page);
      return page.write(req, res, 200, html, leadNotice('Your payment is processing', `Your payment is processing. ${seller} will email you.`, ''));
    }
    return page.write(req, res, 200, html, leadNotice('Checkout not finished', `This checkout wasn’t finished. Nothing was charged.</p>\n<p class="back"><a href="/b/${row.id}" rel="nofollow">Go back to checkout</a>`, ''));
  }

  const SALE_COLUMNS = 'id,user_id,offer_id,status,paid_at,downloads,checkout_session_id,environment';

  /** GET|HEAD /b/<id>/file?session_id=…|t=… : the paid product file. */
  async function file(req, res, { row, acct, url, page }) {
    const { write, notice, retryAfter } = page;
    const gone = () => notice(req, res, 410, 'No longer available', 'This download is no longer available.');
    if (row.delivery?.kind !== 'file' || !/^[A-Za-z0-9_-]{22}$/.test(String(row.delivery?.fileId ?? ''))) return gone();
    // a preview or a prefetch: no count, no signed link
    if (req.method === 'HEAD' || PREFETCH(req)) return write(req, res, 200, html, leadNotice(escapeHtml(row.title || 'Download'), 'Open this link to download your file.', ''));
    let sale = null;
    let byTicket = false;
    const sid = url.searchParams.get('session_id');
    const t = url.searchParams.get('t');
    if (sid && SESSION_RE.test(sid)) {
      const find = async () => (await db.select('sales', { provider: 'stripe', environment: cfg.environment, checkout_session_id: sid }, { select: SALE_COLUMNS, limit: 1 }))[0] ?? null;
      sale = await find();
      if (!sale) {
        // the thank-you page's record may not be there yet: the same read and record
        const session = await verifiedSession(row, acct, sid);
        if (session?.status === 'complete' && session.payment_status === 'paid') {
          await recordFromSession(session, row, acct);
          sale = await find();
        }
      }
    } else if (t && linkSecret) {
      const saleId = checkSaleTicket(linkSecret, t, now());
      if (saleId) sale = (await db.select('sales', { id: saleId }, { select: SALE_COLUMNS, limit: 1 }))[0] ?? null;
      byTicket = !!sale;
    }
    if (!sale || sale.offer_id !== row.id || sale.user_id !== row.user_id) return gone();
    if (!['paid', 'partially_refunded'].includes(sale.status)) return gone();
    // the thank-you page's link lasts downloadDays from the payment; a seller's new link (a ticket) lasts its own 7
    // days, whenever it was made (the per-sale count still applies)
    const paid = Date.parse(sale.paid_at ?? '');
    if (!byTicket && (!Number.isFinite(paid) || now() - paid > cfg.downloadDays * DAY_MS)) return gone();
    let n;
    try {
      n = await db.rpc('sale_downloaded', { p_id: sale.id, p_max: cfg.downloadsPerSale });
    } catch {
      return notice(req, res, 503, 'This can’t be shown right now', 'Try again in a minute.', retryAfter(60_000));
    }
    if (n === null || n === undefined) return notice(req, res, 429, 'Download limit reached', 'This download reached its limit. Ask the seller for a new link.');
    let signed;
    try {
      signed = await signProductDownload(supabase, row.delivery.fileId, row.user_id);
    } catch {
      return notice(req, res, 503, 'This can’t be shown right now', 'Try again in a minute.', retryAfter(60_000));
    }
    if (!signed) return gone();
    res.writeHead(302, { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'cache-control': 'no-store', location: signed.location, 'content-length': 0 });
    return res.end();
  }

  /** GET|HEAD /b/<id>/back: the buyer cancelled at Stripe. */
  async function back(req, res, { row, acct, page }) {
    return page.write(req, res, 200, html, leadNotice('Checkout cancelled', `Checkout cancelled. Nothing was charged.</p>\n<p class="back"><a href="/b/${row.id}" rel="nofollow">Go back to ${escapeHtml(String(row.title || 'checkout').slice(0, 120))}</a>`, ''));
  }

  return { checkout, thanks, file, back, verifiedSession, recordFromSession, originOf, sellable, testBase, makeTicket: (saleId) => (linkSecret ? makeSaleTicket(linkSecret, saleId, now()) : null), sellerName };
}
