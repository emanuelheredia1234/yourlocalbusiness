// The only module that builds Zernio ads URLs (spec §4). Two objects so writes are easy to find and to lint:
//
//   const zads = createZernioAds({ client, ledger, storage, log, timeouts });
//   zads.reads.*   GET only: may be called again freely, but never in a loop
//   zads.writes.*  one attempt each, inside oneShot: { outcome: 'ok'|'failed'|'unknown', status, code?, ids?, … }
//
// client is connections.impl.ads.client (server/connections/zernio.mjs): the one Zernio client, so ads share the
// ZERNIO_RPM window with everything else, and the key stays in it (Authorization header only). Paths are under the
// client's base, which already ends in /api/v1 (so '/ads/create' is Zernio's POST /v1/ads/create).
//
// Outcome rules (R1, R8):
// - 2xx → ok. A Meta create's `warnings: ["activation_failed: …"]` → ok with activationFailed (which levels stayed
//   off is read back, never parsed out of the text).
// - A definite 4xx → failed, with our code (messages.mjs ZERNIO_CODES) and, for a refused create, what Zernio
//   couldn't clean up (details.createdObjects: left_behind ids); 429 → failed RATE_LIMITED or AD_ACCOUNT_BUSY
//   (nothing ran); a local 429 (no ZERNIO_RPM slot in time) → failed RATE_LIMITED, nothing was sent.
// - 409 idempotency_conflict → unknown (the first request with that key is still running); a 422 about the
//   Idempotency-Key → failed IDEMPOTENCY_MISMATCH (Zernio refused; nothing was created).
// - 5xx, a timeout or a cut connection → unknown ("a timed-out write may have completed upstream"), except a failed
//   create that lists what it made (details.createdObjects) and has no unconfirmedWrite: that is a definite failure,
//   and the left-behind ids are kept.
// - not_set_up (no ZERNIO_API_KEY) → failed ADS_UNAVAILABLE, never unknown: nothing was sent.
// - The owner's problems (key refused or restricted, plan, ads add-on, allowance, Zernio payment) are ADS_UNAVAILABLE
//   for the customer, a zernio_owner_alert log line and the 'zernio:alert' app_state key the owner's page reads.
// Results carry codes and ids, a fix link only when its host is on the allowlist, and for a definite refusal its
// safe fields as data (`refusal`, refusalDetail below): Zernio's code, type and field, its hint and fix link, and
// Meta's subcode and own words, cut to plain text. Zernio's `error` sentence and the raw platformError never leave
// this file, and a team-level refusal keeps its code only. Every call writes a ledger row (vendor zernio, feature
// ads, cost 0, estimated false: an estimated zernio row would count as a connection cost in
// server/billing/invoice.mjs). safeLog only.

import { oneShot, safeLog } from '../integrations/common.mjs';
import { ZernioCallError, zernioError } from '../zernio.mjs';
import { CONNECTION_OF, ZERNIO_UPDATE_PLATFORM } from './contracts.mjs';
import { cut, keptFixUrl, OWNER_CODES, safeFixUrl, ZERNIO_CODES } from './messages.mjs';

export const AD_TIMEOUTS = Object.freeze({ create: 120_000, update: 60_000, creative: 120_000 });
/** oneShot's own limit is longer than the call's (the client has no signal; its own timeout fires first) */
const ONE_SHOT_MARGIN_MS = 5_000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const idOf = (v) => (typeof v === 'string' || typeof v === 'number') && ID.test(String(v)) ? String(v) : null;
const iso = (t) => new Date(t).toISOString();

/**
 * A restricted Zernio key (zrk_) without the ads resource group: Zernio answers 403 insufficient_permissions with
 * `required_group` (or unclassified_resource). That is our key, never the customer's login.
 */
const restrictedKey = (b) => (b.code === 'insufficient_permissions' && typeof b.required_group === 'string') || b.code === 'unclassified_resource';
/** a 429 about the customer's own ad account (Meta's per-account queue); any other 429 is our key's limits */
const adAccountLimit = (b) => b.details?.reason === 'ad_account_busy' || b.details?.reason === 'ad_account_write_cap';

/** Our code for a refusal (never the text). platform: our 'meta' | 'google'. */
export function codeForResponse(res, platform) {
  const e = zernioError(res);
  const b = isObj(res?.body) ? res.body : {};
  if (e.status === 401 && (e.code === 'reconnect_required' || e.code === 'ads_connection_required')) return 'RECONNECT';
  if (e.status === 401 || e.status === 402) return 'ADS_UNAVAILABLE';
  if (OWNER_CODES.includes(e.code) || restrictedKey(b)) return 'ADS_UNAVAILABLE';
  if (e.status === 429) return adAccountLimit(b) ? 'AD_ACCOUNT_BUSY' : 'RATE_LIMITED';
  if (Number(b.platformError?.error_subcode) === 324 || Number(b.details?.subcode) === 324) return 'IMAGE_UNREACHABLE';
  if (Object.hasOwn(ZERNIO_CODES, e.code)) return ZERNIO_CODES[e.code];
  if (e.status === 409 && (e.code === 'invalid_field_value' || /budget_level/i.test(e.code))) return 'BUDGET_LEVEL';
  if (e.status === 404) return 'NOT_FOUND_REMOTE';
  void platform;
  return 'REFUSED';
}

/** Whether a refusal is the owner's to fix (the customer reads ADS_UNAVAILABLE). */
export function isOwnerProblem(res) {
  const e = zernioError(res);
  if (e.status === 401) return !(e.code === 'reconnect_required' || e.code === 'ads_connection_required');
  return e.status === 402 || OWNER_CODES.includes(e.code) || restrictedKey(isObj(res?.body) ? res.body : {});
}

const ERROR_TYPES = ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found', 'rate_limit_error', 'platform_error', 'api_error'];
const STAGES = ['media', 'campaign', 'adset', 'creative', 'ad', 'activation', 'other'];
const MACHINE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const PARAM = /^[A-Za-z0-9_.[\]-]{1,100}$/;

/**
 * A definite refusal's safe fields (Zernio's ErrorResponse), kept as data on the job and its audit row, never as
 * instructions or markup: Zernio's code, type and the field it names, the failed step, its English hint (cut to
 * 300) and fix link ({ label, url }: https on Meta's, Google's or Zernio's own site only), and for a platform error
 * Meta's subcode and its own title and message (cut). team: a team-level problem (our Zernio plan, add-on, billing,
 * key or rate limits): its status, code and type only, marked owner. → object | null
 */
export function refusalDetail(res, { team = false } = {}) {
  const b = isObj(res?.body) ? res.body : {};
  const d = isObj(b.details) ? b.details : {};
  const out = {};
  const status = Number(res?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) out.status = status;
  if (typeof b.code === 'string' && MACHINE_CODE.test(b.code)) out.code = b.code;
  if (ERROR_TYPES.includes(b.type)) out.type = b.type;
  if (team) return { ...out, owner: true };
  if (typeof b.param === 'string' && PARAM.test(b.param)) out.param = b.param;
  if (STAGES.includes(d.stage)) out.stage = d.stage;
  const hint = cut(d.hint, 300);
  if (hint) out.hint = hint;
  const fix = isObj(d.fix) ? d.fix : isObj(b.fix) ? b.fix : null;
  const url = keptFixUrl(fix?.url);
  if (url) out.fix = { ...(cut(fix.label, 80) ? { label: cut(fix.label, 80) } : {}), url };
  if (b.type === 'platform_error' && isObj(b.platformError)) {
    const p = b.platformError;
    const sub = Number(p.error_subcode);
    if (Number.isSafeInteger(sub) && sub > 0) out.subcode = sub;
    const title = cut(p.error_user_title, 120);
    if (title) out.metaTitle = title;
    const msg = cut(p.error_user_msg, 300);
    if (msg) out.metaMessage = msg;
  }
  return Object.keys(out).length ? out : null;
}

function cleanCreatedObjects(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(isObj)
    .map((o) => ({ type: ['campaign', 'adset', 'adSet', 'creative', 'ad', 'media', 'image'].includes(o.type) ? String(o.type) : 'other', id: idOf(o.id), cleanup: ['deleted', 'left_behind', 'kept'].includes(o.cleanup) ? o.cleanup : 'unknown' }))
    .filter((o) => o.id)
    .slice(0, 20);
}

function cleanUnconfirmed(u) {
  if (!isObj(u)) return null;
  return { type: typeof u.type === 'string' ? u.type.slice(0, 20) : 'unknown', parentId: idOf(u.parentId) };
}

/** The ids a create answered with (single and creatives[] shapes): nothing else of the body is kept. */
export function createIds(body) {
  const b = isObj(body) ? body : {};
  const ads = Array.isArray(b.ads) ? b.ads.filter(isObj) : isObj(b.ad) ? [b.ad] : [];
  const first = ads[0] ?? {};
  return {
    campaignId: idOf(b.platformCampaignId ?? first.platformCampaignId),
    adSetId: idOf(b.platformAdSetId ?? first.platformAdSetId),
    adIds: ads.map((a) => idOf(a.platformAdId)).filter(Boolean),
    zernioAdIds: ads.map((a) => idOf(a._id)).filter(Boolean),
    creativeIds: ads.map((a) => idOf(a.creative?.creativeId)).filter(Boolean),
  };
}

/**
 * client: the Zernio client (createZernioClient's shape). ledger: server/billing/ledger.mjs (or null). storage:
 * appState (the owner alert). timeouts: per-call limits (tests make them short).
 */
export function createZernioAds({ client, ledger = null, storage = null, log = console, now = () => Date.now(), timeouts = AD_TIMEOUTS } = {}) {
  const t = { ...AD_TIMEOUTS, ...timeouts };

  function ownerAlert(kind) {
    safeLog('zernio_owner_alert', { kind, area: 'ads' }, log);
    if (storage?.enabled !== true) return;
    storage.put('zernio:alert', { kind, at: iso(now()) }).catch(() => {});
  }

  async function ledgerRow(ctx, method, template, status, outcome, idempotencyKey) {
    if (!ledger || !ctx?.tag) return;
    await ledger.write({
      vendor: 'zernio',
      feature: 'ads',
      cost_micro: 0,
      estimated: false,
      customer_tag: ctx.tag,
      user_id: ctx.userId ?? null,
      project_id: ctx.projectId ?? null,
      endpoint: `${CONNECTION_OF[ctx.platform] ?? 'ads'}:${method} ${template}`,
      http_status: status || null,
      outcome,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    });
  }

  /** One GET. → { ok: true, status, body } | { ok: false, status, code, kind } (kind: refused | unreachable | not_set_up). */
  async function get(template, path, query, ctx) {
    if (!client?.enabled) return { ok: false, status: 0, code: 'ADS_UNAVAILABLE', kind: 'not_set_up' };
    let res;
    try {
      res = await client.call('GET', path, { query, retry429: true });
    } catch (e) {
      const kind = e instanceof ZernioCallError && e.kind === 'not_set_up' ? 'not_set_up' : 'unreachable';
      await ledgerRow(ctx, 'GET', template, 0, 'unknown');
      return { ok: false, status: 0, code: kind === 'not_set_up' ? 'ADS_UNAVAILABLE' : 'UNAVAILABLE', kind };
    }
    const ok = res.status >= 200 && res.status < 300;
    await ledgerRow(ctx, 'GET', template, res.status, ok ? 'ok' : res.status >= 500 ? 'unknown' : 'failed');
    if (ok) return { ok: true, status: res.status, body: isObj(res.body) ? res.body : {} };
    if (isOwnerProblem(res)) ownerAlert(zernioError(res).code || `http_${res.status}`);
    return { ok: false, status: res.status, code: res.local ? 'RATE_LIMITED' : codeForResponse(res, ctx?.platform), kind: res.status >= 500 ? 'unreachable' : 'refused', zcode: zernioError(res).code };
  }

  /**
   * One write, inside oneShot: never retried, never looped. → { outcome, status, code?, sent, ids?, activationFailed?,
   * createdObjects?, unconfirmedWrite?, fixUrl?, refusal? } (refusal: a definite refusal's safe fields, refusalDetail).
   */
  async function write(method, template, path, body, { idempotencyKey, timeoutMs }, ctx) {
    if (!client?.enabled) return { outcome: 'failed', status: 0, code: 'ADS_UNAVAILABLE', sent: false };
    let last = null;
    let notSetUp = false;
    const got = await oneShot(
      async () => {
        try {
          last = await client.call(method, path, { body, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}, timeoutMs });
          return last;
        } catch (e) {
          if (e instanceof ZernioCallError && e.kind === 'not_set_up') {
            notSetUp = true;
            return { status: 0 };
          }
          throw e;
        }
      },
      { timeoutMs: timeoutMs + ONE_SHOT_MARGIN_MS },
    );
    if (notSetUp) return { outcome: 'failed', status: 0, code: 'ADS_UNAVAILABLE', sent: false };
    const res = last;
    const b = isObj(res?.body) ? res.body : {};
    const details = isObj(b.details) ? b.details : {};
    const fixUrl = safeFixUrl(details.fix?.url ?? b.fix?.url);
    let out;
    if (got.outcome === 'ok') {
      const warnings = Array.isArray(b.warnings) ? b.warnings.filter((w) => typeof w === 'string') : [];
      out = { outcome: 'ok', status: res.status, sent: true, ...(warnings.some((w) => w.startsWith('activation_failed')) ? { activationFailed: true } : {}) };
    } else if (res?.local) {
      out = { outcome: 'failed', status: 429, code: 'RATE_LIMITED', sent: false };
    } else if (got.outcome === 'failed') {
      const e = zernioError(res);
      if (e.status === 409 && e.code === 'idempotency_conflict') out = { outcome: 'unknown', status: 409, code: 'UNKNOWN', sent: true };
      else if (e.status === 422 && idempotencyKey && /idempot/i.test(e.code)) {
        safeLog('ads_idempotency_mismatch', { template }, log);
        out = { outcome: 'failed', status: 422, code: 'IDEMPOTENCY_MISMATCH', sent: true };
      } else {
        const owner = isOwnerProblem(res);
        if (owner) ownerAlert(e.code || `http_${e.status}`);
        // the refusal's own reason, as data; a team-level one (ours: plan, add-on, billing, key, our rate limits) keeps its code only
        const refusal = refusalDetail(res, { team: owner || (e.status === 429 && !adAccountLimit(b)) });
        // a refused Meta create can still leave objects Zernio couldn't delete (e.g. 422 ad_account_unusable, 403
        // insufficient_permissions after the campaign and ad set were made): their ids, so the customer is told
        const createdObjects = cleanCreatedObjects(details.createdObjects);
        out = { outcome: 'failed', status: e.status, code: codeForResponse(res, ctx?.platform), sent: true, ...(fixUrl ? { fixUrl } : {}), ...(refusal ? { refusal } : {}), ...(createdObjects.length ? { createdObjects } : {}) };
      }
    } else {
      // 5xx, a timeout or a cut connection: unknown, unless Zernio says exactly what it made and nothing is unconfirmed
      const createdObjects = cleanCreatedObjects(details.createdObjects);
      const unconfirmedWrite = cleanUnconfirmed(details.unconfirmedWrite);
      if (res && res.status >= 500 && Array.isArray(details.createdObjects) && !unconfirmedWrite) {
        const refusal = refusalDetail(res);
        out = { outcome: 'failed', status: res.status, code: createdObjects.some((o) => o.cleanup === 'left_behind') ? 'PARTIAL_LEFT' : 'CREATE_FAILED', sent: true, createdObjects, ...(refusal ? { refusal } : {}) };
      } else {
        out = { outcome: 'unknown', status: res?.status ?? 0, code: 'UNKNOWN', sent: true, ...(createdObjects.length ? { createdObjects } : {}), ...(unconfirmedWrite ? { unconfirmedWrite } : {}) };
      }
    }
    await ledgerRow(ctx, method, template, out.status, out.outcome, idempotencyKey);
    safeLog('ads_write', { template, outcome: out.outcome, status: out.status, code: out.code }, log);
    return { ...out, ...(out.outcome === 'ok' ? { body: b } : {}) };
  }

  const need = (v, what) => {
    const id = idOf(v);
    if (!id) throw Object.assign(new Error(`ads: bad ${what}`), { code: 'BAD_ID' });
    return id;
  };
  const wholeAmount = (v, what) => {
    if (!Number.isInteger(v) || v <= 0) throw Object.assign(new Error(`ads: ${what} must be a whole number above 0`), { code: 'BAD_AMOUNT' });
    return v;
  };

  const reads = {
    listAdAccounts: (zid, ctx) => get('/ads/accounts', '/ads/accounts', { accountId: zid, inScopeOnly: 'true' }, ctx),
    health: (zid, adAccountId, ctx) => get('/ads/accounts/health', '/ads/accounts/health', { accountId: zid, adAccountId }, ctx),
    billing: (zid, adAccountId, ctx) => get('/ads/accounts/billing', '/ads/accounts/billing', { accountId: zid, adAccountId }, ctx),
    hierarchy: (zid, ctx) => get('/ads/accounts/hierarchy', '/ads/accounts/hierarchy', { accountId: zid }, ctx),
    targetingSearch: (zid, { q, dimension, geoType, countryCode }, ctx) => get('/ads/targeting/search', '/ads/targeting/search', { accountId: zid, q, dimension, geoType, countryCode }, ctx),
    tree: (zid, { search, campaignId, fromDate, toDate, source = 'zernio', adAccountId, limit } = {}, ctx) => get('/ads/tree', '/ads/tree', { accountId: zid, search, campaignId, fromDate, toDate, source, adAccountId, limit }, ctx),
    campaigns: (zid, adAccountId, { search, includeEmpty = true } = {}, ctx) => get('/ads/campaigns', '/ads/campaigns', { accountId: zid, adAccountId, search, includeEmpty: includeEmpty ? 'true' : undefined }, ctx),
    /** Meta only: campaigns and ad sets read live from Meta, whole units, with readAt; each level paged on its own (live.mjs) */
    liveEntities: (zid, adAccountId, ctx, { level, after } = {}) => get('/ads/accounts/live', '/ads/accounts/live', { accountId: zid, adAccountId, ...(level ? { level } : {}), ...(after ? { after } : {}) }, ctx),
    /** with live: the switches re-read from the platform; statusReadAt null = the live read failed */
    ad: (adId, { live = true } = {}, ctx) => get('/ads/:adId', `/ads/${need(adId, 'ad id')}`, live ? { live: 'true' } : {}, ctx),
    review: (adId, ctx) => get('/ads/:adId/review', `/ads/${need(adId, 'ad id')}/review`, {}, ctx),
    /** a raw Meta node: daily_budget in minor units, never used for money decisions (learning_stage_info only) */
    adSet: (adSetId, zid, ctx) => get('/ads/ad-sets/:id', `/ads/ad-sets/${need(adSetId, 'ad set id')}`, { accountId: zid }, ctx),
  };

  const writes = {
    /** POST /ads/create with the launch's Idempotency-Key (ad_campaigns.launch_key) */
    createAd: (body, key, ctx) => write('POST', '/ads/create', '/ads/create', body, { idempotencyKey: String(key), timeoutMs: t.create }, ctx),
    /** Meta only: the campaign spending limit, whole units; never 0, never null from this app */
    setCampaignSpendCap: (campaignId, amount, ctx) => write('PUT', '/ads/campaigns/:id', `/ads/campaigns/${need(campaignId, 'campaign id')}`, { platform: 'facebook', platformSpecificData: { spendCap: wholeAmount(amount, 'spend cap') } }, { timeoutMs: t.update }, ctx),
    setCampaignStatus: (campaignId, platform, status, ctx) => write('PUT', '/ads/campaigns/:id/status', `/ads/campaigns/${need(campaignId, 'campaign id')}/status`, { status: status === 'active' ? 'active' : 'paused', platform: ZERNIO_UPDATE_PLATFORM[platform] }, { timeoutMs: t.update }, ctx),
    setAdSetStatus: (adSetId, platform, status, ctx) => write('PUT', '/ads/ad-sets/:id/status', `/ads/ad-sets/${need(adSetId, 'ad set id')}/status`, { status: status === 'active' ? 'active' : 'paused', platform: ZERNIO_UPDATE_PLATFORM[platform] }, { timeoutMs: t.update }, ctx),
    setAdStatus: (adId, status, ctx) => write('PUT', '/ads/:adId/status', `/ads/${need(adId, 'ad id')}/status`, { status: status === 'active' ? 'active' : 'paused' }, { timeoutMs: t.update }, ctx),
    /** Meta ABO */
    setAdSetBudget: (adSetId, amount, ctx) => write('PUT', '/ads/ad-sets/:id', `/ads/ad-sets/${need(adSetId, 'ad set id')}`, { platform: 'facebook', budget: { amount: wholeAmount(amount, 'budget'), type: 'daily' } }, { timeoutMs: t.update }, ctx),
    /** Google, or Meta CBO; never allowSharedBudgetUpdate */
    setCampaignBudget: (campaignId, platform, amount, ctx) => write('PUT', '/ads/campaigns/:id', `/ads/campaigns/${need(campaignId, 'campaign id')}`, { platform: ZERNIO_UPDATE_PLATFORM[platform], budget: { amount: wholeAmount(amount, 'budget'), type: 'daily' } }, { timeoutMs: t.update }, ctx),
    /** Meta only: platformSpecificData.endDate (top-level dates are silently ignored), with an explicit offset */
    setAdSetEndDate: (adSetId, endDate, ctx) => {
      if (typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(endDate)) throw Object.assign(new Error('ads: end date needs an offset'), { code: 'BAD_DATE' });
      return write('PUT', '/ads/ad-sets/:id', `/ads/ad-sets/${need(adSetId, 'ad set id')}`, { platform: 'facebook', platformSpecificData: { endDate } }, { timeoutMs: t.update }, ctx);
    },
    /** Meta: every creative field, so the result doesn't depend on the live creative */
    setMetaCreative: (adId, creative, ctx) => write('PUT', '/ads/:adId', `/ads/${need(adId, 'ad id')}`, { creative }, { timeoutMs: t.creative }, ctx),
    /** Google Search: each list replaces the whole list */
    setSearchAdText: (adId, headlines, descriptions, finalUrls, ctx) => write('PUT', '/ads/:adId', `/ads/${need(adId, 'ad id')}`, { headlines: headlines.map((text) => ({ text })), descriptions: descriptions.map((text) => ({ text })), finalUrls }, { timeoutMs: t.update }, ctx),
  };

  return { reads, writes, enabled: client?.enabled === true };
}
