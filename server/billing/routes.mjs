// Usage and billing routes:
//   GET /api/billing/me?days=30                    each user's own usage (their customer tag only)
//   GET /api/billing/customers?days=30             owner: every customer, with caps, and the defaults
//   PUT /api/billing/customers/:tag/cap            owner: a customer's override ({dailyCapMicro?, monthlyCapMicro?,
//                                                  callsPerDay?, postsPerDay?, xPostsPerDay?, status?, note?});
//                                                  every field null and active = back to the defaults
//   PUT /api/billing/defaults                      owner: the defaults ("Set up caps" sends them the first time,
//                                                  with treg's budget dimension)
//   GET /api/billing/reconcile?days=30             owner: our ledger against treg's usage by tag
//   GET /api/billing/invoice.csv?month=YYYY-MM     owner: the month's CSV to bill from
// onStart: settle treg's `pending` answers now and every 5 minutes. userDeleted(userId): the ledger rows keep
// the customer tag (for invoices) and lose the user id.
//
// Checks in order: same origin, a signed-in user, the billing-read bucket, set up (else 503 NOT_SET_UP, with
// the Secret names for the owner), then the owner for the owner routes. Rows of other customers never reach a
// customer. No route charges a card: this tracks usage only.

import { createLedger, dayStart, isCall, isReal, monthStart } from './ledger.mjs';
import { createCaps, capToApi, mergeCaps, parseCapFields } from './caps.mjs';
import { createTregAdmin } from './tregAdmin.mjs';
import { reconcile, settlePending } from './reconcile.mjs';
import { invoiceCsv, isMonth, monthWindow } from './invoice.mjs';
import { endpointLabel } from '../treg-endpoints.mjs';
import { customerTag, errorBody, fail, notSetUp, safeLog } from '../integrations/common.mjs';
import { serviceHeaders } from '../secretBox.mjs';

export const BILLING_PREFIX = '/api/billing/';
const TAG = /^cust_[0-9a-f]{24}$/;
const SETTLE_EVERY_MS = 5 * 60_000;

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
};
const daysFrom = (url) => Math.min(366, Math.max(1, Math.trunc(Number(url.searchParams.get('days')) || 30)));

export function createBillingRoutes({
  auth,
  storage = null,
  db,
  treg = null,
  connections = null,
  send,
  readJson,
  limit = () => false,
  corsHeaders = () => ({}),
  sameOrigin = () => true,
  env = process.env,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  log = console,
  admin: adminOverride = null,
} = {}) {
  const ledger = createLedger({ db, now, log });
  const admin = adminOverride ?? createTregAdmin({ env, fetch, log });
  const caps = createCaps({ db, ledger, admin, storage, now, log });
  const reply = (req, res, status, body, headers = {}) => send(res, status, body, { ...corsHeaders(req), ...headers });
  let timer = null;
  // one settle run at a time in this server: an overlapping run would write a second 'settled' row for a call
  let settling = null;
  const settleOnce = () => (settling ??= settlePending({ ledger, admin, now, log }).finally(() => (settling = null)));

  /**
   * What's missing, by Secret name (empty when ready). A user's own usage needs only the ledger and the tag
   * secret: their treg calls are tracked (and charged) without the admin token, so they must see them too.
   * The owner routes and the settle job also need treg's admin token and team id.
   */
  function missing({ ownUsageOnly = false } = {}) {
    const out = [];
    if (!db?.enabled) out.push('SUPABASE_URL and SUPABASE_SECRET_KEY (and the integrations migration)');
    if (String(env.CUSTOMER_TAG_SECRET || '').length < 16) out.push('CUSTOMER_TAG_SECRET');
    if (ownUsageOnly) return out;
    if (!env.TREG_ADMIN_TOKEN) out.push('TREG_ADMIN_TOKEN');
    if (!env.TREG_ORG_ID) out.push('TREG_ORG_ID');
    return out;
  }

  /** Emails for customer tags (owner only), from Supabase Auth's admin API, cached 10 minutes. */
  const emailCache = new Map(); // user id → { email, until }
  async function emailFor(userId) {
    const hit = emailCache.get(userId);
    if (hit && hit.until > now()) return hit.email;
    const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
    let email = '';
    if (url && key && userId) {
      try {
        const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: serviceHeaders(key), signal: AbortSignal.timeout(8000) });
        if (res.ok) email = String((await res.json())?.email ?? '');
      } catch {
        email = '';
      }
    }
    emailCache.set(userId, { email, until: now() + 600_000 });
    if (emailCache.size > 5000) emailCache.delete(emailCache.keys().next().value);
    return email;
  }

  async function allCustomers() {
    const out = [];
    for (let page = 0; page < 100; page++) {
      const rows = await db.select('billing_customers', {}, { select: 'customer_tag,user_id,created_at', order: 'created_at.asc', limit: 1000, offset: page * 1000 });
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  async function emailsFor(customers) {
    const map = new Map();
    const queue = customers.filter((c) => c.user_id);
    await Promise.all(
      Array.from({ length: Math.min(8, queue.length) }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) map.set(c.customer_tag, await emailFor(c.user_id));
      }),
    );
    return map;
  }

  async function overrides() {
    const rows = await db.select('billing_caps', {}, { limit: 1000 });
    return { defaults: rows.find((r) => r.customer_tag === '*') ?? null, byTag: new Map(rows.filter((r) => r.customer_tag !== '*').map((r) => [r.customer_tag, r])) };
  }

  // ───────────── the routes ─────────────

  async function me(who, url) {
    const tag = customerTag(who.id, env);
    const days = daysFrom(url);
    const at = now();
    const since = new Date(Math.min(Date.parse(monthStart(at)), at - days * 86_400_000)).toISOString();
    const rows = await ledger.rows({ customer_tag: tag, since });
    const today = dayStart(at);
    const month = monthStart(at);
    const windowStart = new Date(at - days * 86_400_000).toISOString();
    const usage = { today: { costMicro: 0, calls: 0 }, month: { costMicro: 0, calls: 0 }, byFeature: [], recent: [] };
    const features = new Map();
    for (const r of rows) {
      const real = isReal(r);
      const c = real ? Math.trunc(Number(r.cost_micro) || 0) : 0;
      const t = String(r.created_at);
      const call = r.vendor === 'treg' && isCall(r);
      if (t >= month) {
        usage.month.costMicro += c;
        if (call) usage.month.calls += 1;
      }
      if (t >= today) {
        usage.today.costMicro += c;
        if (call) usage.today.calls += 1;
      }
      if (t >= windowStart) {
        const f = features.get(r.feature) ?? { feature: r.feature, costMicro: 0, calls: 0 };
        f.costMicro += c;
        if (isCall(r)) f.calls += 1;
        features.set(r.feature, f);
      }
    }
    usage.byFeature = [...features.values()].sort((a, b) => b.costMicro - a.costMicro || a.feature.localeCompare(b.feature));
    usage.recent = rows
      .filter((r) => r.outcome !== 'settled')
      .slice(-50)
      .reverse()
      .map((r) => ({ at: String(r.created_at), feature: r.feature, label: endpointLabel(r.endpoint, r.vendor), costMicro: Math.trunc(Number(r.cost_micro) || 0), estimated: r.estimated === true }));
    const effective = await caps.effective(tag);
    usage.caps = { dailyCapMicro: effective.daily_cap_micro ?? 0, monthlyCapMicro: effective.monthly_cap_micro ?? 0, status: effective.status };
    const alert = who.isAdmin === true ? await treg?.alert?.() : null;
    return { usage, ...(alert ? { alert } : {}) };
  }

  async function customers(url) {
    const days = daysFrom(url);
    const at = now();
    const since = new Date(at - days * 86_400_000).toISOString();
    const today = dayStart(at);
    const [list, rows, capRows] = await Promise.all([allCustomers(), ledger.rows({ since, select: 'customer_tag,vendor,estimated,cost_micro,created_at,outcome' }), overrides()]);
    const per = new Map();
    const ensure = (tag) => {
      let p = per.get(tag);
      if (!p) per.set(tag, (p = { costMicro: 0, estimatedMicro: 0, calls: 0, todayMicro: 0, lastActivityAt: null }));
      return p;
    };
    for (const c of list) ensure(c.customer_tag);
    for (const r of rows) {
      const p = ensure(r.customer_tag);
      const c = Math.trunc(Number(r.cost_micro) || 0);
      if (isReal(r)) {
        p.costMicro += c;
        if (String(r.created_at) >= today) p.todayMicro += c;
      } else if (r.estimated === true) p.estimatedMicro += c;
      if (r.vendor === 'treg' && isCall(r)) p.calls += 1;
      if (!p.lastActivityAt || String(r.created_at) > p.lastActivityAt) p.lastActivityAt = String(r.created_at);
    }
    const emails = await emailsFor(list);
    // how many social accounts (Upload-Post) and ad accounts (Zernio) each customer has connected right now
    const counts = new Map();
    const socialCount = connections?.impl?.social?.accountCount;
    const adsCount = connections?.impl?.ads?.accountCount ?? (connections?.impl && !('social' in connections.impl) ? connections.impl.accountCount : undefined);
    if (typeof socialCount === 'function' || typeof adsCount === 'function') {
      for (const c of list) {
        const social = typeof socialCount === 'function' ? await socialCount(c.user_id).catch(() => null) : null;
        const ads = typeof adsCount === 'function' ? await adsCount(c.user_id).catch(() => null) : null;
        if (Number.isFinite(social) || Number.isFinite(ads)) counts.set(c.customer_tag, { social: Number.isFinite(social) ? social : 0, ads: Number.isFinite(ads) ? ads : 0, socialKnown: Number.isFinite(social), adsKnown: Number.isFinite(ads) });
      }
    }
    // the owner's view of Upload-Post: profiles used out of the plan's limit, and its last team-level alert
    const uploadPost = (await connections?.impl?.social?.ownerView?.().catch(() => null)) ?? null;
    const out = [...per.entries()].map(([tag, p]) => {
      const o = capRows.byTag.get(tag);
      const merged = mergeCaps(capRows.defaults, o);
      return {
        customerTag: tag,
        ...(emails.get(tag) ? { email: emails.get(tag) } : {}),
        ...p,
        lastActivityAt: p.lastActivityAt ?? undefined,
        ...(counts.has(tag)
          ? {
              connectedAccounts: counts.get(tag).social + counts.get(tag).ads,
              ...(counts.get(tag).socialKnown ? { socialAccounts: counts.get(tag).social } : {}),
              ...(counts.get(tag).adsKnown ? { adAccounts: counts.get(tag).ads } : {}),
            }
          : {}),
        caps: o ? capToApi(o) : {},
        status: merged.status,
        ...(o ? { syncedToTreg: o.synced_to_treg_at != null } : {}),
      };
    });
    out.sort((a, b) => b.costMicro - a.costMicro || a.customerTag.localeCompare(b.customerTag));
    const d = mergeCaps(capRows.defaults, null);
    const alert = await treg?.alert?.();
    return {
      customers: out,
      defaults: { ...capToApi(d), syncedToTreg: capRows.defaults?.synced_to_treg_at != null },
      ...(alert ? { alert } : {}),
      ...(uploadPost && Number.isFinite(uploadPost.profilesUsed) ? { upProfiles: { used: uploadPost.profilesUsed, ...(uploadPost.profilesLimit ? { limit: uploadPost.profilesLimit } : {}) } } : {}),
      ...(uploadPost?.alert ? { uploadPostAlert: uploadPost.alert } : {}),
    };
  }

  async function putCap(req, tag) {
    if (!TAG.test(tag)) throw fail(404, 'NOT_FOUND', 'No such customer.');
    const [known] = await db.select('billing_customers', { customer_tag: tag }, { limit: 1 });
    if (!known) throw fail(404, 'NOT_FOUND', 'No such customer.');
    const fields = parseCapFields(await body(req));
    const { cap } = await caps.putCap(tag, fields);
    return { cap };
  }

  async function putDefaults(req) {
    const fields = parseCapFields(await body(req));
    if (fields.status === 'blocked') throw fail(400, 'BAD_REQUEST', 'The defaults can’t block everyone. Block customers one by one.');
    const { defaults } = await caps.putDefaults(fields);
    return { defaults };
  }

  async function reconcileReport(url) {
    const report = await reconcile({ ledger, admin, now, days: daysFrom(url) });
    try {
      if (storage?.enabled) await storage.put('billing:lastReconcile', report);
    } catch {
      /* the report is still answered */
    }
    return report;
  }

  async function invoice(url) {
    const month = url.searchParams.get('month') || new Date(now()).toISOString().slice(0, 7);
    if (!isMonth(month)) throw fail(400, 'BAD_REQUEST', 'month must look like 2026-11.');
    const { from, to } = monthWindow(month);
    const [rows, list, capRows] = await Promise.all([ledger.rows({ since: from, until: to, select: 'customer_tag,vendor,estimated,cost_micro,created_at,outcome' }), allCustomers(), overrides()]);
    const tags = new Set(rows.map((r) => r.customer_tag));
    const emails = await emailsFor(list.filter((c) => tags.has(c.customer_tag)));
    const statuses = new Map([...tags].map((t) => [t, mergeCaps(capRows.defaults, capRows.byTag.get(t)).status]));
    return { month, csv: invoiceCsv({ month, rows, emails, statuses }) };
  }

  async function body(req) {
    try {
      return await readJson(req, 16_384);
    } catch (e) {
      throw fail(e?.status === 413 ? 413 : 400, 'BAD_REQUEST', e?.status === 413 ? 'Request too large.' : 'Send the caps as JSON.');
    }
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith(BILLING_PREFIX)) return false;
    if (!sameOrigin(req)) {
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return true;
    }
    let who = null;
    try {
      who = auth?.enabled ? await auth.identify(req) : null;
    } catch {
      reply(req, res, 503, { error: 'Could not verify your sign-in. Try again shortly.', code: 'UNAVAILABLE' });
      return true;
    }
    if (!who?.id) {
      reply(req, res, 401, { error: 'Sign in first.', code: 'AUTH_REQUIRED' });
      return true;
    }
    if (limit('billing-read', who.id)) {
      reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED' });
      return true;
    }
    try {
      const sub = path.slice(BILLING_PREFIX.length);
      const gaps = missing({ ownUsageOnly: sub === 'me' });
      if (gaps.length) throw notSetUp(`Usage tracking needs these in Replit Secrets: ${gaps.join(', ')}.`, 'Usage isn’t available yet.');
      const m = req.method;
      if (sub === 'me') {
        if (m !== 'GET') return false;
        reply(req, res, 200, await me(who, url));
        return true;
      }
      const ownerRoute = sub === 'customers' || sub === 'defaults' || sub === 'reconcile' || sub === 'invoice.csv' || /^customers\/[^/]+\/cap$/.test(sub);
      if (!ownerRoute) return false;
      if (who.isAdmin !== true) throw fail(403, 'FORBIDDEN', 'Only the app owner can see this.');
      if (sub === 'customers' && m === 'GET') reply(req, res, 200, await customers(url));
      else if (sub === 'defaults' && m === 'PUT') reply(req, res, 200, await putDefaults(req));
      else if (sub === 'reconcile' && m === 'GET') reply(req, res, 200, await reconcileReport(url));
      else if (sub === 'invoice.csv' && m === 'GET') {
        const { month, csv } = await invoice(url);
        reply(req, res, 200, csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="usage-${month}.csv"` });
      } else if (/^customers\/[^/]+\/cap$/.test(sub) && m === 'PUT') reply(req, res, 200, await putCap(req, safeDecode(sub.split('/')[1])));
      else return false;
      return true;
    } catch (e) {
      // treg's own refusals become our words (never its body: it can carry the balance and a top-up link)
      if (e?.name === 'TregError') {
        safeLog('billing_treg_failed', { kind: e.kind }, log);
        const err = e.kind === 'config' ? notSetUp(e.hint || 'Check TREG_ADMIN_TOKEN and TREG_ORG_ID in Replit Secrets.', 'treg isn’t reachable with the billing settings.') : fail(503, 'UNAVAILABLE', 'treg is unavailable. Try again shortly.');
        const { status, body: b } = errorBody(err, who);
        reply(req, res, status, b);
        return true;
      }
      if (e?.name === 'DbError') safeLog('billing_db_failed', { code: e.code }, log);
      const err = e?.name === 'DbError' && e.code === 'NOT_SET_UP' ? notSetUp('Run supabase/migrations/20261105000000_integrations.sql in Supabase.', 'Usage isn’t available yet.') : e;
      const { status, body: b } = errorBody(err, who);
      reply(req, res, status, b);
      return true;
    }
  }

  return {
    handle,
    ledger,
    caps,
    admin,
    /** Settle pending treg rows now (also every 5 minutes after onStart). */
    settle: () => (missing().length ? Promise.resolve(0) : settleOnce()),
    async onStart() {
      if (missing().length) return;
      await settleOnce();
      if (!timer) {
        timer = setInterval(() => {
          settleOnce().catch(() => {});
        }, SETTLE_EVERY_MS);
        timer.unref?.();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async forgetUser() {},
    async unforgetUser() {},
    /** After the account is gone: its ledger rows stay (by customer tag, for invoices) without the user id. */
    async userDeleted(userId) {
      if (db?.enabled) await ledger.clearUser(userId);
    },
  };
}
