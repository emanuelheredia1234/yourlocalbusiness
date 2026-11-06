// For the ads route tests: the real wiring (server/integrations/wiring.mjs) on a bare HTTP server, with mock Supabase
// (database, storage, sign-in) and the real Zernio connections against the mock Zernio server (server/test/
// mock-zernio.mjs + mock-zernio-ads.mjs). Fake values only; nothing reaches Zernio, Meta or Google (R10).

import http from 'node:http';
import { createAuth } from '../auth.mjs';
import { createDb } from '../integrations/db.mjs';
import { sha256 } from '../integrations/common.mjs';
import { createIntegrations } from '../integrations/wiring.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createMockZernio, TEST_ZERNIO_KEY, TEST_ZERNIO_WEBHOOK_SECRET } from '../test/mock-zernio.mjs';
import { assertLocalZernio } from '../test/mock-zernio-ads.mjs';
import { makeStorage } from '../test/fakes.mjs';
import { createAdsRoutes } from './routes.mjs';
import { addDays, todayIn } from './build.mjs';
import { plan as planFixture, project as projectFixture } from './test-fixtures.mjs';

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
export const ADS_SECRETS = Object.freeze({
  CUSTOMER_TAG_SECRET: 'test-customer-tag-secret-0123456789',
  MEDIA_URL_SECRET: 'test-media-url-secret-abcdef0123456789',
  ADS_REVIEW_SECRET: 'test-ads-review-secret-0123456789abcdef',
});
export const DEFAULT_LIMITS = Object.freeze({ customer_tag: '*', ads_enabled: true, ads_currency: 'USD', ads_max_daily: 50, ads_max_change: 50, ads_max_campaign_total: 750, ads_launches_per_day: 3, ads_changes_per_day: 20, version: 1 });

function sendLike(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(data);
}

function readJson(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const t = Buffer.concat(chunks).toString();
        resolve(t ? JSON.parse(t) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Everything an ads test needs, started. opts: env (extra), gate (canLaunchAds stub), limits (the '*' row, or null
 * for none), timeouts (per write). Call .close() after.
 */
export async function startAds({ env: envExtra = {}, gate, limits = DEFAULT_LIMITS, timeouts = { create: 600, update: 600, creative: 600 } } = {}) {
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const supa = await (await createMockSupabase()).start();
  const zm = await createMockZernio({ now }).start();
  const env = assertLocalZernio({
    SUPABASE_URL: supa.url,
    SUPABASE_SECRET_KEY: supa.SECRET,
    MEDIA_PUBLIC_BASE_URL: 'https://app.test',
    ZERNIO_API_KEY: TEST_ZERNIO_KEY,
    ZERNIO_WEBHOOK_SECRET: TEST_ZERNIO_WEBHOOK_SECRET,
    ZERNIO_BASE_URL: zm.apiBase,
    ZERNIO_RPM: '10000',
    ADS_LAUNCH_ENABLED: '1',
    ...ADS_SECRETS,
    ...envExtra,
  });
  const db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE });
  const storage = makeStorage();
  const lines = [];
  const log = { log: (l) => lines.push(String(l)), warn: (l) => lines.push(String(l)), error: (l) => lines.push(String(l)) };
  let adsRoutes = null;
  const integrations = createIntegrations({
    env,
    auth,
    appState: storage,
    send: sendLike,
    readJson,
    db,
    now,
    log,
    factories: {
      ads: (deps) => (adsRoutes = createAdsRoutes({ ...deps, adTimeouts: timeouts, ...(gate ? { canLaunchAds: gate } : {}) })),
    },
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    (async () => {
      if (await integrations.handle(req, res, url)) return;
      sendLike(res, 404, { error: 'Not found' });
    })().catch(() => sendLike(res, 500, { error: 'crash' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  zm.webhookUrl = `${base}/api/webhooks/zernio`;
  if (limits) await db.insert('ad_limits', { ...limits, updated_at: new Date().toISOString() });
  await db.insert('billing_caps', { customer_tag: '*', daily_cap_micro: 250000, monthly_cap_micro: 3000000, calls_per_day: 400, posts_per_day: 50, x_posts_per_day: 20 }, { ignoreDuplicates: true, onConflict: 'customer_tag' });

  const impl = integrations.connections.impl.ads;
  const ctx = {
    supa,
    zm,
    db,
    env,
    storage,
    integrations,
    clock,
    lines,
    base,
    get ads() {
      return adsRoutes;
    },
    /** a day `n` days from today in the account's zone (YYYY-MM-DD) */
    day(n = 10, tz = 'America/Chicago') {
      return addDays(todayIn(tz, clock.t), n);
    },
    async user(email, { admin = false } = {}) {
      const { token, user } = await supa.tokenFor(email, 'password123', admin ? { appMetadata: { ylb_role: 'admin' } } : {});
      return { token, id: user.id, email, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
    },
    async project(u, id = 'proj-1', extra = {}) {
      const data = projectFixture({ id, ...extra });
      await db.upsert('user_docs', { user_id: u.id, kind: 'project', id, data }, { onConflict: 'user_id,kind,id' });
      return data;
    },
    /** a saved plan (user_docs kind 'ad') with its three images in the user's storage */
    async plan(u, extra = {}) {
      const p = planFixture(extra);
      await db.upsert('user_docs', { user_id: u.id, kind: 'ad', id: p.id, data: p }, { onConflict: 'user_id,kind,id' });
      for (const c of p.creatives ?? []) if (c.media?.mediaId) supa.objects.set(`media/${u.id}/${c.media.mediaId}`, { bytes: JPEG, type: 'image/jpeg', created: Date.now() });
      return p;
    },
    /** connect an ad platform for the user's business the way a customer does: the link, then Zernio's webhook */
    async connect(u, platform = 'meta_ads', { projectId = 'proj-1', username = 'acme' } = {}) {
      await integrations.connections.connectLink(u.id, platform, { projectId });
      const doc = (await storage.get(`zernio:user:${sha256(u.id)}`)).value;
      const zPlatform = platform === 'meta_ads' ? 'metaads' : 'googleads';
      const account = zm.addAccount({ platform: zPlatform, profileId: doc.profileId, username });
      const evt = zm.signed({ event: 'account.connected', profiles: zm.profileRef(doc.profileId), account: { accountId: account._id, profileId: doc.profileId, platform: zPlatform, username, displayName: `${username} ads` } });
      const res = await impl.webhook(evt.raw, evt.headers);
      if (res.status !== 200) throw new Error(`connect webhook ${res.status}`);
      return account;
    },
    async call(u, method, path, body) {
      const res = await fetch(`${base}${path}`, { method, headers: u?.headers ?? {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.status, body: json, text };
    },
    /** pick the ad account for the business (the first usable one, or by id tail) */
    async choose(u, platform = 'meta', { projectId = 'proj-1', tail } = {}) {
      const got = await ctx.call(u, 'GET', `/api/ads/accounts?projectId=${projectId}&platform=${platform}`);
      const a = got.body.accounts.find((x) => (tail ? x.idTail === tail : x.usable));
      const res = await ctx.call(u, 'PUT', '/api/ads/accounts/choice', { projectId, platform, adAccountRef: a.ref });
      if (res.status !== 200) throw new Error(`choice ${res.status} ${res.text}`);
      return a;
    },
    /** look a place up and return its ref */
    async place(u, platform = 'meta', q = 'Austin', { projectId = 'proj-1', dimension = 'geo' } = {}) {
      const got = await ctx.call(u, 'GET', `/api/ads/targeting/search?projectId=${projectId}&platform=${platform}&dimension=${dimension}&q=${encodeURIComponent(q)}`);
      return got.body.results[0]?.ref;
    },
    /** a LaunchPreviewRequest with the usual picks (override any field) */
    async request(u, platform = 'meta', extra = {}) {
      const loc = await ctx.place(u, platform, 'Austin');
      const interest = platform === 'meta' ? await ctx.place(u, platform, 'Home', { dimension: 'interest' }) : null;
      return {
        projectId: 'proj-1',
        planId: 'plan-1',
        platform,
        status: 'PAUSED',
        startDate: ctx.day(10),
        dailyBudget: 25,
        durationDays: 14,
        locations: [loc],
        radiusMi: 15,
        ...(interest ? { interests: [interest] } : {}),
        ...(platform === 'meta' ? { creativeIds: ['cr-A', 'cr-B', 'cr-C'] } : { languages: ['en'] }),
        claimsConfirmed: [],
        specialCategory: 'none',
        ...extra,
      };
    },
    preview(u, req) {
      return ctx.call(u, 'POST', '/api/ads/launch/preview', req);
    },
    launch(u, reviewToken, clientRequestId = crypto.randomUUID(), extra = {}) {
      return ctx.call(u, 'POST', '/api/ads/launch', { reviewToken, confirm: true, clientRequestId, ...extra });
    },
    /** preview + launch; waits for the background sends. → { preview, res, job, campaign } */
    async launchPlan(u, platform = 'meta', extra = {}) {
      const preview = await ctx.preview(u, await ctx.request(u, platform, extra));
      if (!preview.body?.reviewToken) throw new Error(`no token: ${JSON.stringify(preview.body?.review?.blockers ?? preview.body)}`);
      const res = await ctx.launch(u, preview.body.reviewToken);
      await ctx.settled();
      const job = res.body?.job ? (await ctx.call(u, 'GET', `/api/ads/jobs/${res.body.job.id}`)).body : null;
      return { preview, res, job: job?.job, campaign: job?.campaign };
    },
    changePreview(u, id, body) {
      return ctx.call(u, 'POST', `/api/ads/campaigns/${id}/change/preview`, body);
    },
    change(u, id, reviewToken, clientRequestId = crypto.randomUUID()) {
      return ctx.call(u, 'POST', `/api/ads/campaigns/${id}/change`, { reviewToken, confirm: true, clientRequestId });
    },
    /** preview + change; waits. → { preview, res, job, campaign } */
    async changeCampaign(u, id, body) {
      const preview = await ctx.changePreview(u, id, body);
      if (!preview.body?.reviewToken) return { preview };
      const res = await ctx.change(u, id, preview.body.reviewToken);
      await ctx.settled();
      const job = res.body?.job ? (await ctx.call(u, 'GET', `/api/ads/jobs/${res.body.job.id}`)).body : null;
      return { preview, res, job: job?.job, campaign: job?.campaign };
    },
    async settled() {
      await adsRoutes.settled();
    },
    async row(id) {
      return (await db.select('ad_campaigns', { id }))[0];
    },
    async jobRow(id) {
      return (await db.select('ad_jobs', { id }))[0];
    },
    async audit(userId) {
      return db.select('ad_audit', { user_id: userId }, { order: 'id.asc' });
    },
    /** the ad writes Zernio received (POST/PUT under /ads), in order */
    writes(from = 0) {
      return zm.calls.filter((c) => c.path.startsWith('/api/v1/ads') && c.method !== 'GET').slice(from);
    },
    violations() {
      return zm.violations;
    },
    async close() {
      await adsRoutes?.settled();
      zm.ads.release();
      await new Promise((r) => server.close(r));
      await zm.close();
      await supa.close();
    },
  };
  return ctx;
}
