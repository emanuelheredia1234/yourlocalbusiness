// Zernio's /v1/ads routes for tests and offline QA (spec §15.1), mounted by server/test/mock-zernio.mjs. Nothing
// here calls Zernio, Meta or Google. Paths are under /api/v1 (the client's base already ends in it).
//
//   const ads = createMockZernioAds({ calls, violations, sendWebhook, connections, profileRef });
//   ads.handle(req, res, path, query, body, headers) → true when it answered
//
// State: ad accounts per connection platform (Meta act_1 USD America/Chicago billing ok, act_2 EUR billing missing;
// Google 1234567890 USD America/New_York APPROVED, 9999999999 APPROVED_HELD), the campaigns, ad sets and ads the
// tests create, review states, an idempotency store (replay with Idempotent-Replayed: true, 409 while in flight, 422
// for the same key with another body, only 2xx stored).
//
// Reads: /ads/accounts, /ads/accounts/health, /ads/accounts/billing, /ads/accounts/hierarchy, /ads/accounts/live
// (whole units, readAt), /ads/targeting/search, /ads/tree (search, source, campaignId, syncedAt that tests can hold
// back, 202 backfillPending), /ads/campaigns, /ads/timeline, /ads/ad-sets/{id} (raw minor units), /ads/{id}?live=true,
// /ads/{id}/review.
// Writes: /ads/create (single, creatives[], Google search), campaign/ad set/ad status PUTs (read-before-write:
// updated/skipped), budget PUTs (ABO/CBO mismatch 409, Google shared 409), ad set end date (platformSpecificData only;
// top-level dates are ignored), campaign spend cap, creative PUTs (back in review after).
//
// A test fails (a violation is recorded) when: a write body arrives twice without POST /__expectRepeat first; a
// create lacks the Idempotency-Key, or any of status/campaignStatus/adSetStatus/adStatus, or has adSetStatus/adStatus
// other than ACTIVE, or a Meta campaignStatus other than PAUSED; budgetType is missing or not daily; endDate, a place
// or linkUrl is missing; Google gets fewer than 3 headlines or 2 descriptions; Meta creativeFeatures aren't all
// OPT_OUT or appear inside a creatives[] item; a Meta campaign is switched on without a spend cap; a spend cap or
// budget isn't a whole number; a spend cap is 0 or null; any request carries validateOnly.
//
// Faults (POST /__fail {route, mode, times}): route is 'METHOD template' (e.g. 'POST /ads/create',
// 'PUT /ads/campaigns/:id', 'GET /ads/accounts/live'). Modes: timeout (never answers), hang-then-create (creates,
// then drops the connection), created-not-stored-hang (Meta objects made that only the live read and source=all
// see, then no answer), 503-left-behind, 502-unconfirmed, 201-activation-failed, 409-idempotency, 422-budget-too-low,
// 403-payment, 403-ads-allowance, 402-payment, 429-ad-account-busy, 401-reconnect, 401-key, meta-code-31, 500, 502,
// 409-budget-level, 409-shared-budget, 422-key-mismatch, live-read-failed (GET /ads/{id}?live=true: statusReadAt null).

import crypto from 'node:crypto';

/**
 * R10: tests talk only to a mock. Throws when ZERNIO_BASE_URL is missing or isn't a local address, so a test can
 * never reach Zernio (and through it Meta or Google) by a typo or a leaked environment variable.
 */
export function assertLocalZernio(env) {
  let host = '';
  try {
    host = new URL(String(env?.ZERNIO_BASE_URL ?? '')).hostname;
  } catch {
    host = '';
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('Tests must point ZERNIO_BASE_URL at the local mock (server/test/mock-zernio.mjs).');
  return env;
}

const oid = () => crypto.randomBytes(12).toString('hex');
const digits = (n = 15) => String(Math.floor(1e14 + Math.random() * 9e14)).slice(0, n);
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const err = (res, status, code, type = 'invalid_request_error', extra = {}, headers = {}) => json(res, status, { error: `mock ${code}`, type, code, ...extra }, headers);

/** canonical JSON (sorted keys), so the same body always has the same text */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const hash = (v) => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');

const META_ACCOUNTS = () => [
  { id: 'act_1', name: 'Acme Plumbing', currency: 'USD', accountStatus: 1, timezoneName: 'America/Chicago', minimumDailyBudget: 1, selectable: true, unusableReason: null, billingStatus: 'ok', selected: true },
  { id: 'act_2', name: 'Old Account', currency: 'EUR', accountStatus: 1, timezoneName: 'Europe/Berlin', minimumDailyBudget: 2, selectable: true, unusableReason: null, billingStatus: 'missing', selected: true },
];
const GOOGLE_ACCOUNTS = () => [
  { id: '1234567890', name: 'Acme Plumbing Ads', currency: 'USD', selectable: true },
  { id: '9999999999', name: 'Acme Second', currency: 'USD', selectable: true },
];
const GOOGLE_HIERARCHY = () => [
  { customerId: '1234567890', name: 'Acme Plumbing Ads', currency: 'USD', timeZone: 'America/New_York', manager: false, testAccount: false, status: 'ENABLED', managerLinks: [], clients: [] },
  { customerId: '9999999999', name: 'Acme Second', currency: 'USD', timeZone: 'America/Los_Angeles', manager: false, testAccount: false, status: 'ENABLED', managerLinks: [], clients: [] },
];
const GOOGLE_BILLING = { '1234567890': 'APPROVED', '9999999999': 'APPROVED_HELD' };

const GEO = {
  meta: [
    { id: '2421836', name: 'Austin', type: 'city', path: ['United States', 'Texas', 'Austin'], countryCode: 'US' },
    { id: '2420379', name: 'Round Rock', type: 'city', path: ['United States', 'Texas', 'Round Rock'], countryCode: 'US' },
    { id: '3886', name: 'Texas', type: 'region', path: ['United States', 'Texas'], countryCode: 'US' },
    { id: 'US', name: 'United States', type: 'country', path: ['United States'], countryCode: 'US' },
    { id: '577564', name: 'Berlin', type: 'city', path: ['Germany', 'Berlin'], countryCode: 'DE' },
    { id: 'US:78701', name: '78701', type: 'zip', path: ['United States', 'Texas', '78701'], countryCode: 'US' },
  ],
  google: [
    { id: '1026201', name: 'Austin', type: 'City', path: ['United States', 'Texas', 'Austin'], countryCode: 'US' },
    { id: '21176', name: 'Texas', type: 'State', path: ['United States', 'Texas'], countryCode: 'US' },
    { id: 'US', name: 'United States', type: 'country', path: ['United States'], countryCode: 'US' },
  ],
};
const INTERESTS = [
  { id: '6003107902433', name: 'Baking', type: 'interest', path: ['Interests', 'Food and drink', 'Baking'] },
  { id: '6003020834693', name: 'Home improvement', type: 'interest', path: ['Interests', 'Home', 'Home improvement'] },
];

const ALL_OPT_OUT = (m) => m && typeof m === 'object' && Object.values(m).every((v) => v === 'OPT_OUT');
const whole = (v) => Number.isInteger(v) && v > 0;

/** Route template of an /ads path (ids replaced), for fault matching and the ledger. */
export function adsTemplate(method, p) {
  const rules = [
    [/^\/ads\/campaigns\/[^/]+\/status$/, '/ads/campaigns/:id/status'],
    [/^\/ads\/campaigns\/[^/]+$/, '/ads/campaigns/:id'],
    [/^\/ads\/ad-sets\/[^/]+\/status$/, '/ads/ad-sets/:id/status'],
    [/^\/ads\/ad-sets\/[^/]+$/, '/ads/ad-sets/:id'],
    [/^\/ads\/(accounts|targeting|tree|create|timeline|campaigns)(\/.*)?$/, null],
    [/^\/ads\/[^/]+\/status$/, '/ads/:adId/status'],
    [/^\/ads\/[^/]+\/review$/, '/ads/:adId/review'],
    [/^\/ads\/[^/]+$/, '/ads/:adId'],
  ];
  for (const [re, t] of rules) if (re.test(p)) return `${method} ${t ?? p}`;
  return `${method} ${p}`;
}

/**
 * calls, violations: mock-zernio's lists. sendWebhook(event): sign and deliver. connections: () => mock-zernio's
 * account list ({_id, platform, profileId}). profileRef(profileId) → the event's profiles list. now: the clock.
 */
export function createMockZernioAds({ violations, sendWebhook = async () => ({}), connections = () => [], profileRef = () => [], now = () => Date.now() } = {}) {
  const state = {
    adAccounts: { meta: META_ACCOUNTS(), google: GOOGLE_ACCOUNTS() },
    hierarchy: GOOGLE_HIERARCHY(),
    billing: { ...GOOGLE_BILLING },
    health: {},
    campaigns: new Map(), // platformCampaignId → campaign
    ads: new Map(), // zernio ad _id → { campaignId, adSetId }
    idem: new Map(), // key → { hash, status, body, inFlight }
    seenWrites: new Map(), // body key → count
    failures: [],
    expectRepeat: 0,
    syncedAt: null, // an ISO time the tree reports (null: now)
    livePageSize: null, // accounts/live rows per level per page (null: everything on one page)
    treePageSize: null, // tree campaigns per page (null: everything on one page)
    backfillPending: false,
    sharedBudget: new Set(), // Google campaign ids whose budget is shared
    hung: new Set(),
    clock: now,
  };
  const iso = (t = state.clock()) => new Date(t).toISOString();
  const violation = (kind, detail = {}) => violations.push({ kind, ...detail });

  const connection = (zid) => connections().find((a) => a._id === zid) ?? null;
  const platformOf = (zid) => {
    const p = connection(zid)?.platform;
    return p === 'metaads' || p === 'facebook' ? 'meta' : p === 'googleads' ? 'google' : null;
  };

  function takeFailure(template) {
    const i = state.failures.findIndex((f) => f.route === template && f.times > 0);
    if (i < 0) return null;
    const f = state.failures[i];
    f.times -= 1;
    if (f.times <= 0) state.failures.splice(i, 1);
    return f.mode;
  }

  /** The same write body twice is a violation unless the test said a repeat is coming (a new confirm). */
  function noteWrite(method, p, body) {
    const key = `${method} ${p} ${canonicalJson(body)}`;
    const n = (state.seenWrites.get(key) ?? 0) + 1;
    state.seenWrites.set(key, n);
    if (n > 1) {
      if (state.expectRepeat > 0) state.expectRepeat -= 1;
      else violation('repeated_write', { path: p });
    }
  }

  // ───────────── the objects ─────────────

  function derivedStatus(c) {
    if (c.cancelled) return 'cancelled';
    if (c.ads().some((a) => a.reviewStatus === 'rejected')) return 'rejected';
    if (c.configuredStatus === 'PAUSED') return 'paused';
    if (c.ads().some((a) => a.reviewStatus === 'in_review')) return 'pending_review';
    return 'active';
  }

  function makeTree({ zid, platform, adAccountId, body, stored = true, adSetStatus = 'ACTIVE', adStatus = 'ACTIVE', withAdSet = true, withAds = true, offFirstAd = false }) {
    const id = digits(15);
    const c = {
      id,
      zid,
      platform,
      adAccountId,
      name: String(body.campaignName ?? body.name ?? ''),
      configuredStatus: platform === 'google' ? String(body.campaignStatus ?? body.status ?? 'ACTIVE') : String(body.campaignStatus ?? 'ACTIVE'),
      budgetLevel: platform === 'google' || body.budgetLevel === 'campaign' ? 'campaign' : 'adset',
      campaignBudget: platform === 'google' || body.budgetLevel === 'campaign' ? { amount: body.budgetAmount, type: 'daily' } : null,
      lifetimeBudget: null,
      spendCap: null,
      spend: 0,
      impressions: 0,
      clicks: 0,
      stored,
      cancelled: false,
      createdAt: iso(),
      adSets: [],
      currency: (state.adAccounts[platform] ?? []).find((a) => a.id === adAccountId)?.currency ?? 'USD',
      ads() {
        return this.adSets.flatMap((s) => s.ads);
      },
    };
    if (withAdSet) {
      const s = { id: digits(15), name: String(body.adSetName ?? `${c.name} - Ad Set`), configuredStatus: adSetStatus, dailyBudget: c.budgetLevel === 'adset' ? body.budgetAmount : null, endDate: body.endDate ?? null, startDate: body.startDate ?? null, learning: 'LEARNING', ads: [] };
      c.adSets.push(s);
      if (withAds) {
        const creatives = Array.isArray(body.creatives) && body.creatives.length ? body.creatives : [{ headline: body.headline, body: body.body, description: body.description, callToAction: body.callToAction, imageUrl: body.imageUrl, linkUrl: body.linkUrl }];
        creatives.forEach((cr, i) => {
          const ad = {
            _id: oid(),
            platformAdId: digits(15),
            name: String(cr.name ?? body.adName ?? `${c.name} #${i + 1}`),
            configuredStatus: offFirstAd && i === 0 ? 'PAUSED' : adStatus,
            reviewStatus: 'in_review',
            rejections: [],
            creative: platform === 'google' ? null : { creativeId: digits(15), headline: cr.headline, body: cr.body, description: cr.description, callToAction: cr.callToAction, imageUrl: cr.imageUrl, linkUrl: cr.linkUrl },
            headlines: platform === 'google' ? [body.headline, ...(body.additionalHeadlines ?? [])].map((t) => (typeof t === 'string' ? { text: t } : t)) : undefined,
            descriptions: platform === 'google' ? [body.body, ...(body.additionalDescriptions ?? [])].map((t) => (typeof t === 'string' ? { text: t } : t)) : undefined,
            finalUrls: platform === 'google' ? [body.linkUrl] : undefined,
          };
          s.ads.push(ad);
          state.ads.set(ad._id, { campaignId: id, adSetId: s.id });
        });
      }
    }
    state.campaigns.set(id, c);
    return c;
  }

  const adNode = (c, a) => ({
    _id: a._id,
    platformAdId: a.platformAdId,
    name: a.name,
    platform: c.platform === 'google' ? 'google' : 'facebook',
    status: c.configuredStatus === 'PAUSED' || a.configuredStatus === 'PAUSED' ? 'paused' : a.reviewStatus === 'in_review' ? 'pending_review' : a.reviewStatus === 'rejected' ? 'rejected' : 'active',
    configuredStatus: a.configuredStatus,
    reviewStatus: a.reviewStatus,
    platformCampaignId: c.id,
    platformAdSetId: c.adSets.find((s) => s.ads.includes(a))?.id,
    platformAdAccountId: c.adAccountId,
    ...(a.creative ? { creative: { ...a.creative } } : {}),
    ...(a.headlines ? { headlines: a.headlines, descriptions: a.descriptions, finalUrls: a.finalUrls } : {}),
  });

  function campaignNode(c) {
    return {
      platformCampaignId: c.id,
      campaignName: c.name,
      platform: c.platform === 'google' ? 'google' : 'facebook',
      platformAdAccountId: c.adAccountId,
      status: derivedStatus(c),
      reviewStatus: c.ads().some((a) => a.reviewStatus === 'rejected') ? 'rejected' : c.ads().some((a) => a.reviewStatus === 'in_review') ? 'in_review' : c.ads().length ? 'approved' : null,
      configuredStatus: c.configuredStatus,
      budgetLevel: c.budgetLevel,
      campaignBudget: c.campaignBudget ? { ...c.campaignBudget } : null,
      currency: c.currency,
      metrics: { spend: c.spend, impressions: c.impressions, clicks: c.clicks, ctr: c.impressions ? Math.round((c.clicks / c.impressions) * 10000) / 100 : 0 },
      adSets: c.adSets.map((s) => ({ platformAdSetId: s.id, adSetName: s.name, status: s.configuredStatus === 'PAUSED' ? 'paused' : 'active', adSetBudget: s.dailyBudget != null ? { amount: s.dailyBudget, type: 'daily' } : null, ads: s.ads.map((a) => adNode(c, a)) })),
    };
  }

  // ───────────── creates ─────────────

  function checkCreate(body, platform, idemKey) {
    if (!idemKey) violation('create_without_idempotency_key');
    for (const k of ['status', 'campaignStatus', 'adSetStatus', 'adStatus']) if (!['ACTIVE', 'PAUSED'].includes(body?.[k])) violation('create_status_missing', { field: k });
    if (body?.adSetStatus !== 'ACTIVE' || body?.adStatus !== 'ACTIVE') violation('create_child_not_active');
    if (platform === 'meta' && (body?.campaignStatus !== 'PAUSED' || body?.status !== 'PAUSED')) violation('meta_campaign_not_paused');
    if (body?.budgetType !== 'daily') violation('budget_type_not_daily');
    if (!whole(body?.budgetAmount)) violation('budget_not_whole');
    if (!body?.endDate) violation('no_end_date');
    const geo = platform === 'google' ? body?.targeting ?? {} : body ?? {};
    if (!['countries', 'regions', 'cities', 'zips'].some((k) => Array.isArray(geo[k]) && geo[k].length)) violation('no_geo');
    const items = Array.isArray(body?.creatives) && body.creatives.length ? body.creatives : [body ?? {}];
    if (items.some((i) => typeof i.linkUrl !== 'string' || !i.linkUrl)) violation('no_link_url');
    if (platform === 'google') {
      const h = [body?.headline, ...(body?.additionalHeadlines ?? [])].filter(Boolean);
      const d = [body?.body, ...(body?.additionalDescriptions ?? [])].filter(Boolean);
      if (h.length < 3 || d.length < 2) violation('google_too_few_texts');
    } else {
      if (!ALL_OPT_OUT(body?.creativeFeatures) || !body?.creativeFeatures?.text_optimizations) violation('creative_features_not_opt_out');
      if (Array.isArray(body?.creatives) && body.creatives.some((i) => i && 'creativeFeatures' in i)) violation('creative_features_in_item');
    }
  }

  async function create(req, res, body, idemKey) {
    const zid = String(body?.accountId ?? '');
    const platform = platformOf(zid);
    if (!platform) return err(res, 404, 'account_not_found', 'not_found');
    checkCreate(body, platform, idemKey);
    const accounts = state.adAccounts[platform] ?? [];
    const acct = accounts.find((a) => a.id === body.adAccountId);
    if (!acct) return err(res, 403, 'ad_account_not_selected', 'permission_error');
    const h = hash(body);
    if (idemKey && state.idem.has(idemKey)) {
      const got = state.idem.get(idemKey);
      if (got.inFlight) return err(res, 409, 'idempotency_conflict', 'invalid_request_error', {}, { 'retry-after': '5' });
      if (got.hash !== h) return err(res, 422, 'idempotency_key_reused', 'invalid_request_error');
      return json(res, got.status, got.body, { 'idempotent-replayed': 'true' });
    }
    const mode = takeFailure('POST /ads/create');
    if (mode === 'timeout') return void state.hung.add(res);
    if (mode === '409-idempotency') return err(res, 409, 'idempotency_conflict', 'invalid_request_error', {}, { 'retry-after': '5' });
    if (mode === '422-key-mismatch') return err(res, 422, 'idempotency_key_reused', 'invalid_request_error');
    if (mode === '422-budget-too-low') return err(res, 400, 'budget_too_low', 'platform_error', { param: 'budgetAmount', platformError: { error_user_msg: 'Your budget is too low: SECRET-PLATFORM-TEXT' } });
    if (mode === '403-payment') return err(res, 403, 'ad_account_payment_required', 'permission_error', { details: { hint: 'Add a card SECRET-HINT', fix: { label: 'Billing', url: 'https://business.facebook.com/billing_hub' } } });
    if (mode === '403-ads-allowance') return err(res, 403, 'ads_allowance_exceeded', 'permission_error');
    if (mode === '402-payment') return err(res, 402, 'payment_required', 'permission_error');
    if (mode === '429-ad-account-busy') return err(res, 429, 'rate_limited', 'rate_limit_error', { details: { reason: 'ad_account_busy' } }, { 'retry-after': '15' });
    if (mode === '401-reconnect') return err(res, 401, 'reconnect_required', 'authentication_error');
    if (mode === '401-key') return err(res, 401, 'invalid_credentials', 'authentication_error');
    if (mode === 'meta-code-31') return err(res, 400, 'meta_security_check_required', 'platform_error', { details: { fix: { url: '/dashboard/zernio-only' } } });
    if (mode === '500') return err(res, 500, 'internal_error', 'api_error');
    if (mode === '502') return err(res, 502, 'platform_api_error', 'platform_error');
    if (acct.billingStatus === 'missing') return err(res, 403, 'ad_account_payment_required', 'permission_error');
    if (idemKey) state.idem.set(idemKey, { hash: h, inFlight: true });
    const release = () => {
      if (idemKey) state.idem.delete(idemKey);
    };
    if (mode === '503-left-behind') {
      const c = makeTree({ zid, platform, adAccountId: acct.id, body, withAdSet: false });
      release();
      return err(res, 503, 'temporarily_unavailable', 'api_error', { details: { stage: 'adset', adAccountId: acct.id, createdObjects: [{ type: 'campaign', id: c.id, cleanup: 'left_behind' }] } });
    }
    if (mode === '502-unconfirmed') {
      const c = makeTree({ zid, platform, adAccountId: acct.id, body, withAds: false });
      release();
      return err(res, 502, 'platform_api_error', 'platform_error', { details: { stage: 'ad', unconfirmedWrite: { type: 'ad', parentId: c.adSets[0].id }, createdObjects: [{ type: 'campaign', id: c.id, cleanup: 'kept' }] } });
    }
    if (mode === 'hang-then-create' || mode === 'created-not-stored-hang') {
      makeTree({ zid, platform, adAccountId: acct.id, body, stored: mode === 'hang-then-create' });
      // the key stays "in progress", like a request cut off mid-create
      if (mode === 'hang-then-create') return void res.socket?.destroy();
      return void state.hung.add(res);
    }
    const c = makeTree({ zid, platform, adAccountId: acct.id, body, offFirstAd: mode === '201-activation-failed' && platform === 'meta' });
    const warnings = mode === '201-activation-failed' && platform === 'meta' ? ['activation_failed: Meta refused to switch on ad #1 (SECRET-PLATFORM-TEXT)'] : [];
    const ads = c.ads().map((a) => adNode(c, a));
    const out = Array.isArray(body.creatives) && body.creatives.length ? { platformCampaignId: c.id, platformAdSetId: c.adSets[0].id, ads, appliedDefaults: {}, message: 'Ads created', warnings } : { ad: ads[0], appliedDefaults: {}, message: 'Ad created', warnings };
    if (idemKey) state.idem.set(idemKey, { hash: h, status: 201, body: out, inFlight: false });
    return json(res, 201, out);
  }

  // ───────────── reads ─────────────

  function live(res, q) {
    const zid = q.get('accountId');
    if (platformOf(zid) !== 'meta') return err(res, 501, 'feature_not_available', 'invalid_request_error');
    const adAccountId = q.get('adAccountId');
    const acct = (state.adAccounts.meta ?? []).find((a) => a.id === adAccountId);
    if (!acct) return err(res, 403, 'ad_account_not_selected', 'permission_error');
    const level = q.get('level');
    const after = q.get('after');
    if (after && !['campaign', 'adSet'].includes(level)) return err(res, 400, 'invalid_request', 'invalid_request_error');
    // older campaigns first, like an account with history: a new one lands on the last page
    const mine = [...state.campaigns.values()].filter((c) => c.platform === 'meta' && c.adAccountId === adAccountId && !c.cancelled);
    const page = (rows, k) => {
      const size = state.livePageSize;
      if (!size) return { rows, after: null };
      const from = after && level === k ? Number(after) : 0;
      return { rows: rows.slice(from, from + size), after: from + size < rows.length ? String(from + size) : null };
    };
    const cs = page(mine.map((c) => ({ platformCampaignId: c.id, campaignName: c.name, platformCampaignStatus: c.configuredStatus, configuredStatus: c.configuredStatus, status: c.configuredStatus === 'PAUSED' ? 'paused' : 'active', budget: c.campaignBudget, dailyBudget: c.campaignBudget?.amount ?? null, lifetimeBudget: c.lifetimeBudget, budgetRemaining: c.spendCap != null ? Math.max(0, c.spendCap - c.spend) : null, spendCap: c.spendCap, bidStrategy: null })), 'campaign');
    const ss = page(mine.flatMap((c) => c.adSets.map((s) => ({ platformAdSetId: s.id, adSetName: s.name, platformCampaignId: c.id, platformAdSetStatus: c.configuredStatus === 'PAUSED' ? 'CAMPAIGN_PAUSED' : s.configuredStatus, configuredStatus: s.configuredStatus, status: s.configuredStatus === 'PAUSED' ? 'paused' : 'active', budget: s.dailyBudget != null ? { amount: s.dailyBudget, type: 'daily' } : null, dailyBudget: s.dailyBudget, lifetimeBudget: null, budgetRemaining: null }))), 'adSet');
    return json(res, 200, {
      accountId: zid,
      adAccountId,
      platform: 'facebook',
      currency: acct.currency,
      readAt: iso(),
      ...(level !== 'adSet' ? { campaigns: cs.rows } : {}),
      ...(level !== 'campaign' ? { adSets: ss.rows } : {}),
      paging: { ...(level !== 'adSet' ? { campaigns: { after: cs.after } } : {}), ...(level !== 'campaign' ? { adSets: { after: ss.after } } : {}) },
    });
  }

  function tree(res, q) {
    const zid = q.get('accountId');
    const platform = platformOf(zid);
    if (!platform) return err(res, 404, 'account_not_found', 'not_found');
    if (state.backfillPending) return json(res, 202, { backfillPending: true }, { 'retry-after': '60' });
    const search = String(q.get('search') ?? '').toLowerCase();
    const ids = String(q.get('campaignId') ?? '').split(',').filter(Boolean);
    const source = q.get('source') ?? 'all';
    const list = [...state.campaigns.values()].filter((c) => c.zid === zid || (connection(c.zid)?.platform && platformOf(c.zid) === platform && c.zid === zid)).filter((c) => (source === 'zernio' ? c.stored : true)).filter((c) => (!search || c.name.toLowerCase().includes(search) || c.id === search) && (!ids.length || ids.includes(c.id)));
    const size = state.treePageSize;
    const pageNo = Math.max(1, Number(q.get('page')) || 1);
    const shown = size ? list.slice((pageNo - 1) * size, pageNo * size) : list;
    return json(res, 200, { campaigns: shown.map(campaignNode), pagination: { total: list.length, page: pageNo }, syncedAt: shown.length ? state.syncedAt ?? iso() : null });
  }

  function findAd(adId) {
    const where = state.ads.get(adId);
    if (!where) {
      for (const c of state.campaigns.values()) for (const a of c.ads()) if (a.platformAdId === adId) return { c, a };
      return null;
    }
    const c = state.campaigns.get(where.campaignId);
    const a = c?.ads().find((x) => x._id === adId);
    return c && a ? { c, a } : null;
  }

  // ───────────── updates ─────────────

  function setStatus(target, status) {
    const want = status === 'active' ? 'ACTIVE' : 'PAUSED';
    if (target.configuredStatus === want) return { updated: 0, skipped: 1 };
    target.configuredStatus = want;
    return { updated: 1, skipped: 0 };
  }

  async function update(req, res, method, p, body) {
    const template = adsTemplate(method, p);
    noteWrite(method, p, body);
    const mode = takeFailure(template);
    if (mode === 'timeout') return void state.hung.add(res);
    if (mode === '500') return err(res, 500, 'internal_error', 'api_error');
    if (mode === '502') return err(res, 502, 'platform_api_error', 'platform_error');
    if (mode === '401-reconnect') return err(res, 401, 'reconnect_required', 'authentication_error');
    if (mode === '403-ads-allowance') return err(res, 403, 'ads_allowance_exceeded', 'permission_error');
    if (mode === '429-ad-account-busy') return err(res, 429, 'rate_limited', 'rate_limit_error', { details: { reason: 'ad_account_busy' } });
    if (mode === '409-budget-level') return err(res, 409, 'BUDGET_LEVEL_MISMATCH', 'invalid_request_error');
    let m = /^\/ads\/campaigns\/([^/]+)\/status$/.exec(p);
    if (m) {
      const c = state.campaigns.get(m[1]);
      if (!c || c.cancelled) return err(res, 404, 'not_found', 'not_found');
      if (!['active', 'paused'].includes(body?.status)) return err(res, 400, 'invalid_field_value', 'invalid_request_error', { param: 'status' });
      if (c.platform === 'meta' && body.status === 'active' && !(c.spendCap > 0)) violation('activate_without_spend_cap', { campaignId: c.id });
      const out = setStatus(c, body.status);
      if (mode === 'hang-then-create') return void res.socket?.destroy();
      return json(res, 200, { status: body.status, platformCampaignStatus: c.configuredStatus, statusReadAt: iso(), ...out, skippedReasons: [] });
    }
    m = /^\/ads\/campaigns\/([^/]+)$/.exec(p);
    if (m) {
      const c = state.campaigns.get(m[1]);
      if (!c || c.cancelled) return err(res, 404, 'not_found', 'not_found');
      const psd = body?.platformSpecificData;
      if (psd && 'spendCap' in psd) {
        if (!whole(psd.spendCap)) violation('spend_cap_not_whole_or_zero', { value: psd.spendCap });
        if (psd.spendCap === 0) return err(res, 400, 'invalid_field_value', 'platform_error', { param: 'spendCap' });
        c.spendCap = psd.spendCap;
      }
      if (body?.budget) {
        if (!whole(body.budget.amount)) violation('budget_not_whole', { value: body.budget.amount });
        if (body.budget.type !== 'daily') violation('budget_type_not_daily');
        if (mode === '409-shared-budget' || state.sharedBudget.has(c.id)) return err(res, 409, 'shared_budget', 'invalid_request_error');
        if (c.budgetLevel !== 'campaign') return err(res, 409, 'BUDGET_LEVEL_MISMATCH', 'invalid_request_error');
        c.campaignBudget = { amount: body.budget.amount, type: 'daily' };
      }
      if (mode === 'hang-then-create') return void res.socket?.destroy();
      return json(res, 200, { updated: 1, budget: c.campaignBudget, budgetLevel: c.budgetLevel, spendCap: c.spendCap });
    }
    m = /^\/ads\/ad-sets\/([^/]+)(\/status)?$/.exec(p);
    if (m) {
      const c = [...state.campaigns.values()].find((x) => x.adSets.some((s) => s.id === m[1]));
      const s = c?.adSets.find((x) => x.id === m[1]);
      if (!s) return err(res, 404, 'not_found', 'not_found');
      if (m[2]) {
        const out = setStatus(s, body?.status);
        return json(res, 200, { status: body?.status, ...out });
      }
      if (body?.budget) {
        if (!whole(body.budget.amount)) violation('budget_not_whole', { value: body.budget.amount });
        if (body.budget.type !== 'daily') violation('budget_type_not_daily');
        if (c.budgetLevel !== 'adset') return err(res, 409, 'BUDGET_LEVEL_MISMATCH', 'invalid_request_error');
        s.dailyBudget = body.budget.amount;
      }
      // top-level dates are Reddit-only and silently ignored here
      const end = body?.platformSpecificData?.endDate;
      if (end !== undefined) {
        if (end === null) return err(res, 400, 'invalid_field_value', 'invalid_request_error', { param: 'endDate' });
        s.endDate = end;
      }
      if (mode === 'hang-then-create') return void res.socket?.destroy();
      return json(res, 200, { budget: s.dailyBudget != null ? { amount: s.dailyBudget, type: 'daily' } : null, budgetLevel: c.budgetLevel, status: s.configuredStatus });
    }
    m = /^\/ads\/([^/]+)(\/status)?$/.exec(p);
    if (m) {
      const got = findAd(m[1]);
      if (!got) return err(res, 404, 'not_found', 'not_found');
      const { c, a } = got;
      if (m[2]) {
        const out = setStatus(a, body?.status);
        return json(res, 200, { status: body?.status, ...out });
      }
      if (body?.creative && c.platform === 'meta') {
        a.creative = { ...a.creative, ...body.creative, creativeId: digits(15) };
        a.reviewStatus = 'in_review';
      } else if (c.platform === 'google' && (body?.headlines || body?.descriptions)) {
        if (body.headlines && (body.headlines.length < 3 || body.headlines.length > 15)) return err(res, 400, 'invalid_field_value', 'invalid_request_error', { param: 'headlines' });
        if (body.descriptions && (body.descriptions.length < 2 || body.descriptions.length > 4)) return err(res, 400, 'invalid_field_value', 'invalid_request_error', { param: 'descriptions' });
        if (body.headlines) a.headlines = body.headlines;
        if (body.descriptions) a.descriptions = body.descriptions;
        if (body.finalUrls) a.finalUrls = body.finalUrls;
        a.reviewStatus = 'in_review';
      } else return err(res, 400, 'missing_required_field', 'invalid_request_error');
      if (mode === 'hang-then-create') return void res.socket?.destroy();
      return json(res, 200, { ad: adNode(c, a), message: 'Ad updated' });
    }
    return err(res, 404, 'not_found', 'not_found');
  }

  // ───────────── the handler ─────────────

  /** p: the path under /api/v1 (starts with /ads). Answers and returns true, or false when it isn't an ads path. */
  async function handle(req, res, p, q, body, headers = {}) {
    if (!p.startsWith('/ads')) return false;
    const method = req.method;
    if (JSON.stringify(body ?? {}).includes('"validateOnly"') || q.has('validateOnly')) violation('validate_only', { path: p });
    const template = adsTemplate(method, p);
    if (method === 'GET') {
      const mode = takeFailure(template);
      if (mode === 'timeout') return void state.hung.add(res), true;
      if (mode === '500') return err(res, 500, 'internal_error', 'api_error'), true;
      if (mode === '502') return err(res, 502, 'platform_api_error', 'platform_error'), true;
      if (mode === '401-key') return err(res, 401, 'invalid_credentials', 'authentication_error'), true;
      if (mode === '403-ads-allowance') return err(res, 403, 'ads_addon_required', 'permission_error'), true;
      const zid = q.get('accountId');
      const platform = platformOf(zid);
      if (p === '/ads/accounts') {
        if (!platform) return err(res, 404, 'account_not_found', 'not_found'), true;
        return json(res, 200, { accounts: state.adAccounts[platform] ?? [] }), true;
      }
      if (p === '/ads/accounts/health') {
        if (platform !== 'meta') return err(res, 501, 'feature_not_available', 'invalid_request_error'), true;
        const a = (state.adAccounts.meta ?? []).find((x) => x.id === q.get('adAccountId'));
        if (!a) return err(res, 403, 'ad_account_not_selected', 'permission_error'), true;
        const custom = state.health[a.id];
        if (custom) return json(res, 200, { adAccountId: a.id, checkedAt: iso(), ...custom }), true;
        const pay = a.billingStatus === 'missing';
        return json(res, 200, {
          adAccountId: a.id,
          status: pay ? 'blocked' : 'ok',
          ready: !pay,
          blockers: pay ? [{ check: 'payment', code: 'ad_account_payment_required', message: 'SECRET-PLATFORM-TEXT', hint: 'x', fix: { label: 'Billing', url: 'https://business.facebook.com/billing_hub/payment_settings' } }] : [],
          checkedAt: iso(),
          checks: [
            { id: 'account_status', status: 'ok', title: 'Account', message: 'ok' },
            { id: 'payment', status: pay ? 'missing' : 'ok', title: 'Payment', message: 'x', ...(pay ? { code: 'ad_account_payment_required', fix: { url: 'https://business.facebook.com/billing_hub/payment_settings' } } : {}) },
            { id: 'page', status: 'ok', title: 'Page', message: 'x' },
            { id: 'instagram', status: 'missing', title: 'Instagram', message: 'x' },
            { id: 'spend_cap', status: 'ok', title: 'Spend cap', message: 'x' },
            { id: 'last_refusal', status: 'ok', title: 'Last refusal', message: 'x' },
          ],
        }), true;
      }
      if (p === '/ads/accounts/billing') {
        const s = state.billing[q.get('adAccountId')];
        return json(res, 200, { paymentsAccounts: [], billingSetups: s ? [{ id: '1', status: s }] : [], accountBudgets: [] }), true;
      }
      if (p === '/ads/accounts/hierarchy') {
        if (platform !== 'google') return err(res, 501, 'feature_not_available', 'invalid_request_error'), true;
        return json(res, 200, { accountId: zid, roots: state.hierarchy, directCustomers: [], unavailable: [], truncated: false, cachedAt: null, stale: false }), true;
      }
      if (p === '/ads/accounts/live') return live(res, q), true;
      if (p === '/ads/targeting/search') {
        if (!platform) return err(res, 404, 'account_not_found', 'not_found'), true;
        const term = String(q.get('q') ?? '').toLowerCase();
        const list = q.get('dimension') === 'interest' ? INTERESTS : GEO[platform];
        return json(res, 200, { results: list.filter((r) => term && r.name.toLowerCase().includes(term)).map((r) => ({ ...r, audienceSize: null })) }), true;
      }
      if (p === '/ads/tree') return tree(res, q), true;
      if (p === '/ads/timeline') {
        if (!connection(zid)) return err(res, 404, 'account_not_found', 'not_found'), true;
        return json(res, 200, { rows: [{ date: '2026-11-01', currency: 'USD', spend: 12.5, impressions: 3000, reach: 2000, clicks: 40, conversions: 2 }, { date: '2026-11-02', currency: 'USD', spend: 7.5, impressions: 1000, reach: 900, clicks: 10, conversions: 1 }] }), true;
      }
      if (p === '/ads/campaigns') {
        if (!connection(zid)) return json(res, 200, { campaigns: [] }), true;
        const search = String(q.get('search') ?? '').toLowerCase();
        const made = [...state.campaigns.values()].filter((c) => c.zid === zid && (!q.get('adAccountId') || c.adAccountId === q.get('adAccountId')) && (!search || c.name.toLowerCase().includes(search)) && (c.ads().length || q.get('includeEmpty') === 'true'));
        const canned = search || q.get('includeEmpty') ? [] : [{ platformCampaignId: '120200001', platform: 'facebook', campaignName: 'Autumn bread', status: 'active', currency: 'USD', metrics: { spend: 20, impressions: 4000, clicks: 50, conversions: 3 } }];
        return json(res, 200, { campaigns: [...canned, ...made.map((c) => ({ ...campaignNode(c), adSets: undefined }))] }), true;
      }
      let m = /^\/ads\/ad-sets\/([^/]+)$/.exec(p);
      if (m) {
        const c = [...state.campaigns.values()].find((x) => x.adSets.some((s) => s.id === m[1]));
        const s = c?.adSets.find((x) => x.id === m[1]);
        if (!s) return err(res, 404, 'not_found', 'not_found'), true;
        // a raw Meta node: money in minor units
        const end = s.endDate ? (/T/.test(s.endDate) ? s.endDate : `${s.endDate}T23:59:59-0600`) : null;
        return json(res, 200, { adSet: { id: s.id, name: s.name, status: s.configuredStatus, daily_budget: s.dailyBudget != null ? String(s.dailyBudget * 100) : null, end_time: end, learning_stage_info: s.learning ? { status: s.learning } : undefined } }), true;
      }
      m = /^\/ads\/([^/]+)\/review$/.exec(p);
      if (m) {
        const got = findAd(m[1]);
        if (!got) return err(res, 404, 'not_found', 'not_found'), true;
        const { c, a } = got;
        return json(res, 200, { adId: a._id, platform: c.platform === 'google' ? 'google' : 'facebook', platformAdId: a.platformAdId, synced: true, review: { approved: a.reviewStatus === 'approved', reviewStatus: a.reviewStatus === 'rejected' ? 'DISAPPROVED' : a.reviewStatus === 'approved' ? 'ACTIVE' : 'PENDING_REVIEW', rejections: a.rejections, readAt: iso() } }), true;
      }
      m = /^\/ads\/([^/]+)$/.exec(p);
      if (m) {
        const got = findAd(m[1]);
        if (!got) return err(res, 404, 'not_found', 'not_found'), true;
        return json(res, 200, { ad: adNode(got.c, got.a), statusReadAt: mode === 'live-read-failed' || q.get('live') !== 'true' ? null : iso() }), true;
      }
      return err(res, 404, 'not_found', 'not_found'), true;
    }
    if (method === 'POST' && p === '/ads/create') {
      noteWrite(method, p, body);
      await create(req, res, body, headers['idempotency-key'] ?? null);
      return true;
    }
    if (method === 'PUT') {
      await update(req, res, method, p, body);
      return true;
    }
    violation('unexpected_ad_write', { path: p, method });
    err(res, 501, 'feature_not_available', 'invalid_request_error');
    return true;
  }

  // ───────────── helpers for tests ─────────────

  function campaignByTag(tag) {
    return [...state.campaigns.values()].find((c) => c.name.includes(tag)) ?? null;
  }

  /** The platform reviewed a campaign's ads: approved | rejected (with reasons). Sends the ad.review.* webhook too. */
  async function review(campaignId, outcome, { reasons = [], webhook = true } = {}) {
    const c = state.campaigns.get(campaignId);
    if (!c) throw new Error('no such campaign');
    for (const a of c.ads()) {
      a.reviewStatus = outcome === 'rejected' ? 'rejected' : 'approved';
      a.rejections = outcome === 'rejected' ? [{ reasons }] : [];
    }
    if (!webhook) return [];
    const conn = connection(c.zid);
    const out = [];
    for (const a of c.ads()) {
      out.push(
        await sendWebhook({
          event: outcome === 'rejected' ? 'ad.review.rejected' : 'ad.review.approved',
          profiles: profileRef(conn?.profileId),
          account: { accountId: c.zid, platform: conn?.platform, profileId: conn?.profileId },
          adObject: { level: 'AD', platformId: a.platformAdId, platformAdAccountId: c.adAccountId, adId: a._id, name: a.name },
          review: { status: outcome, raw: outcome === 'rejected' ? 'DISAPPROVED' : 'ACTIVE', reasons: reasons.map((message) => ({ message })) },
        }),
      );
    }
    return out;
  }

  return {
    state,
    handle,
    campaignByTag,
    review,
    /** POST /__fail {route, mode, times} */
    fail(route, mode, times = 1) {
      state.failures.push({ route, mode, times: Math.max(1, Number(times) || 1) });
    },
    /** POST /__expectRepeat: the next repeated write body is a deliberate new confirm */
    expectRepeat(n = 1) {
      state.expectRepeat += Math.max(1, Number(n) || 1);
    },
    setNow(fn) {
      state.clock = fn;
    },
    /** writes this mock received (POST/PUT under /ads), in order */
    release() {
      for (const r of state.hung) {
        try {
          r.destroy?.();
          r.socket?.destroy();
        } catch {
          /* gone */
        }
      }
      state.hung.clear();
    },
  };
}
