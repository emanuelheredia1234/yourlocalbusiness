// Yourlocalbusiness — AI server + static file server.
//
// Keeps your AI provider keys on the server. The web app calls /api/ai/… (see providers/routes.mjs):
// writing, photos, videos and Manus agent tasks, each sent to the keys that power that function in
// Settings › AI keys, with each key's own model and effort. GET /api/health says which keys are ready.
// When ./dist exists (npm run build), everything else is served from it.
//
// Keys: Replit Secrets / env vars OPENROUTER_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY), XAI_API_KEY,
//   ANTHROPIC_API_KEY, META_MODEL_API_KEY, MANUS_API_KEY, OPENAI_API_KEY; or add them in the app
//   (saved in DATA_DIR/ai-providers.json, never sent back to the browser). Secrets win over keys typed in the app.
//   SLACK_USER_TOKEN: the User OAuth Token (xoxp-…) of the owner's own Slack app, so the app can talk to Viktor
//   (viktor.com) as the owner (server/slack/routes.mjs); or paste it in Settings › AI keys › Viktor (Slack).
// Optional env: PORT (8787), HOST (0.0.0.0), ALLOWED_ORIGIN (enable CORS for one origin), RATE_LIMIT_PER_MIN (30),
//   DATA_DIR (./.data), ADMIN_TOKEN (lets a remote browser change AI settings; otherwise only this machine can),
//   AI_PROVIDER_BASE_URLS (JSON map of provider id → base URL, for a proxy or a test server; "slack" is Slack's
//   Web API base, e.g. the stand-in from node server/test/mock-providers.mjs).
// Accounts (Supabase): SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY (account deletion), ADMIN_EMAILS
//   (the owner's email: manages the AI keys), SIGN_IN_REQUIRED (default true). See server/auth.mjs.
//   With the secret key, users' own keys (server/userKeys.mjs) and their daily AI counters (server/limits.mjs) live in Supabase,
//   and people can publish pages at https://<app>/<name> and on their own domains (server/pages.mjs; env APP_HOSTS,
//   PAGES_DNS_SERVERS, TRUSTED_PROXY_HOPS).
// Hosts: the app and /api answer only on the app's own hosts (*.replit.app, localhost, IP addresses, ALLOWED_ORIGIN's host,
//   APP_HOSTS). Any other host shows only published pages of a verified domain, so the app's own custom domain goes in APP_HOSTS.
// Connected accounts, posting from the app, analytics, usage and "publish my page to Google" (server/integrations/wiring.mjs,
//   docs/integrations-setup.md; they need supabase/migrations/20261105000000_integrations.sql). Secrets: TREG_TOKEN (treg
//   member-role agent token), TREG_ADMIN_TOKEN (admin-role, billing only), CUSTOMER_TAG_SECRET (32+ random bytes, never
//   rotated), MEDIA_URL_SECRET (32+ random bytes; needed to post photos and videos), UPLOAD_POST_API_KEY (turns social
//   accounts, posting and social stats on, through Upload-Post), UPLOAD_POST_WEBHOOK_SECRET (+ _PREVIOUS only while
//   rotating), ZERNIO_API_KEY (turns ad accounts on, through Zernio), ZERNIO_WEBHOOK_SECRET (+ _PREVIOUS only while
//   rotating), ADS_REVIEW_SECRET (32+ random bytes; signs the ad launch reviews, else derived from CUSTOMER_TAG_SECRET),
//   NANGO_SECRET_KEY (future non-social integrations only; off by default), NANGO_WEBHOOK_SIGNING_KEY.
//   Gmail (customer outreach, server/gmail.mjs, not Nango): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
//   Redirect URI: https://yourlocalbusiness.replit.app/api/integrations/gmail/callback (no localhost callback).
//   Plain env: TREG_ORG_ID, CONNECTIONS_PROVIDER (unset; "off" keeps connected accounts off), UPLOAD_POST_RPM (150),
//   UPLOAD_POST_ALERT_REMAINING (5), UPLOAD_POST_MAX_PROFILES_PER_USER (3: businesses with social accounts per user,
//   one Upload-Post profile each), UPLOAD_POST_NEW_PROFILES_PER_DAY (20), UPLOAD_POST_RECLAIM_DAYS (7),
//   UPLOAD_POST_X_LINKS, UPLOAD_POST_X_LINK_POSTS_PER_CUSTOMER (5), UPLOAD_POST_BRAND_LOGO_URL, UPLOAD_POST_CONNECT_TITLE,
//   UPLOAD_POST_CONNECT_DESCRIPTION, UPLOAD_POST_BACK_BUTTON_TEXT, ZERNIO_RPM (60), ZERNIO_BRAND_NAME,
//   ZERNIO_BRAND_LOGO_URL, ZERNIO_BRAND_COLOR, ADS_LAUNCH_ENABLED ("1" lets customers launch ads and raise budgets;
//   unset = off, pausing still works), ADS_HARD_MAX_DAILY (500), ADS_HARD_MAX_CHANGE (200), NANGO_INTEGRATIONS (JSON, booking tools and CRMs only), GSC_APP_PROPERTY
//   (the app's own address; also where the back button on Upload-Post's connect page goes),
//   GSC_APP_VERIFICATION_FILE; CRON_SECRET (the bearer for POST /api/cron/tick, the same value as the Supabase Vault
//   secret cron_secret; CRON_BUDGET_MS, 40000 by default, is one tick's time budget); for tests UPLOAD_POST_BASE_URL, ZERNIO_BASE_URL, NANGO_BASE_URL, TREG_BASE_URL. Keys are never printed: the startup notes name what's missing.
// Offers and buy links /b/<id> with the customers' own Whop accounts (server/offers/index.mjs; they need
//   supabase/migrations/20261113000000_offers.sql): PAYMENT_KEYS_SECRET (seals their Whop keys), APP_PUBLIC_URL,
//   OFFERS_PROVIDER (off), WHOP_ENABLED (off), OFFER_CLICKS_PER_IP_PER_HOUR (60), OFFER_CLICKS_PER_OFFER_PER_HOUR (3000).
// Morning action (server/morning/index.mjs; it needs supabase/migrations/20261116000000_morning_action.sql): plain env
//   MORNING_ACTIONS (off), MORNING_PER_TICK (24 businesses per hourly tick), MORNING_CONCURRENCY (6 at a time).
// A/B tests (server/experiments/index.mjs; it needs supabase/migrations/20261117000000_experiments.sql): plain env
//   EXPERIMENTS (off), EXPERIMENT_READS_PER_TICK (40); EXPERIMENT_COOKIE_SECRET is optional (else derived from
//   SUPABASE_SECRET_KEY).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAIRoutes, sameOrigin } from './providers/routes.mjs';
import { createOmnisendRoutes } from './omnisend.mjs';
import { createGmailRoutes } from './gmail.mjs';
import { serveLegal } from './legal.mjs';
import { createRateLimiter } from './rateLimit.mjs';
import { authFromEnv } from './auth.mjs';
import { userKeysFromEnv } from './userKeys.mjs';
import { limitsFromEnv } from './limits.mjs';
import { videoWeekFromEnv } from './videoWeek.mjs';
import { MIGRATION, appStateFromEnv } from './appState.mjs';
import { pagesFromEnv } from './pages.mjs';
import { createIntegrations } from './integrations/wiring.mjs';
import { createCron } from './cron/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, '..', '.data'));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BODY = 14 * 1024 * 1024; // prompt + up to two images

let BASE_URLS = {};
try {
  BASE_URLS = JSON.parse(process.env.AI_PROVIDER_BASE_URLS || '{}');
} catch {
  console.warn('AI_PROVIDER_BASE_URLS is not valid JSON; ignoring it.');
}

// ───────────── helpers ─────────────

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function corsHeaders(req) {
  if (!ALLOWED_ORIGIN || req.headers.origin !== ALLOWED_ORIGIN) return {};
  return { 'access-control-allow-origin': ALLOWED_ORIGIN, 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-admin-token, authorization', vary: 'origin' };
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Over the per-minute limit for this key (a bucket and a user or address)? factor: reads get a multiple of it. Bounded: see rateLimit.mjs. */
const rateLimited = createRateLimiter({ limit: RATE_LIMIT });

// ───────────── static files (production build) ─────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, url) {
  if (!fs.existsSync(DIST)) return send(res, 404, 'Build the app first: npm run build');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  let file = path.normalize(path.join(DIST, rel));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file).toLowerCase();
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  // a file that can't be read after all ends this response, not the server
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

/**
 * The request's address, read once and safely: a target like //x:y is a path here, never a host, and
 * an absolute one (http://host/path, from a proxy) keeps its path. null when it can't be read.
 */
function requestUrl(req) {
  let target = String(req.url || '/');
  try {
    if (!target.startsWith('/')) {
      if (!/^https?:\/\//i.test(target)) target = '/';
      else {
        const u = new URL(target);
        target = `${u.pathname}${u.search}`;
      }
    }
    return new URL(`http://local${target}`);
  } catch {
    return null;
  }
}

// ───────────── router ─────────────

const auth = authFromEnv();
const appState = appStateFromEnv();
const ai = createAIRoutes({ send, readJson, corsHeaders, rateLimited, dataDir: DATA_DIR, adminToken: ADMIN_TOKEN, allowedOrigin: ALLOWED_ORIGIN, baseUrls: BASE_URLS, auth, userKeys: userKeysFromEnv(), appState, limits: limitsFromEnv(), videoWeek: videoWeekFromEnv() });
// Omnisend campaign drafts (server/omnisend.mjs): the callback's per-caller limit counts callers as published pages do
const omnisend = createOmnisendRoutes({
  auth,
  storage: appState,
  send,
  readJson,
  rateLimited,
  corsHeaders,
  sameOrigin: (req) => sameOrigin(req, ALLOWED_ORIGIN),
  clientKey: (req) => pages.visitor(req),
});
// Customer Gmail (server/gmail.mjs): the customer's own mailbox for later outreach. Not Nango.
const gmail = createGmailRoutes({
  auth,
  storage: appState,
  send,
  readJson,
  rateLimited,
  corsHeaders,
  sameOrigin: (req) => sameOrigin(req, ALLOWED_ORIGIN),
  clientKey: (req) => pages.visitor(req),
});
// connected accounts, posting, analytics, usage and SEO on Google (server/integrations/wiring.mjs)
const integrations = createIntegrations({
  auth,
  appState,
  omnisend,
  send,
  readJson,
  rateLimited,
  corsHeaders,
  sameOrigin: (req) => sameOrigin(req, ALLOWED_ORIGIN),
  clientKey: (req) => pages.visitor(req),
  // the morning action writes through the same gate and metering as /api/ai/generate
  aiText: (...a) => ai.generateText(...a),
  aiPowered: () => ai.store.route('morning').some((id) => ai.store.ready(id)),
});
// periodic jobs (server/cron): Supabase pg_cron calls POST /api/cron/tick hourly with "Authorization: Bearer
// <CRON_SECRET>"; each job runs once per period behind an app_state claim. Local dev (no CRON_SECRET, not a Replit
// deployment) ticks in-process instead.
// plans (server/billing/stripe.mjs): the AI routes gate on them once they're enforced
ai.setBilling(integrations.billing);
const cron = createCron({ storage: appState });
for (const job of integrations.cronJobs()) cron.register(job);
// keys and settings saved in Supabase (when its secret key is set) before the first request
// (never more than a few seconds: a slow Supabase must not keep the app from starting)
const settingsFrom = await Promise.race([ai.init(), new Promise((r) => setTimeout(() => r('slow'), 5000))]);

/**
 * DELETE /api/account[?ackLiveAds=1]: the signed-in user's account and files go for good (their saved data is removed
 * with the account). While an ad campaign launched from the app is still on, it answers 409 ADS_LIVE with the list
 * ({live}) unless ackLiveAds=1: after deletion the app can't pause it.
 */
async function deleteAccount(req, res) {
  if (!sameOrigin(req, ALLOWED_ORIGIN)) return send(res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' }, corsHeaders(req));
  const ident = await ai.whoIs(req, res);
  if (!ident) return;
  if (!ident.who) return send(res, 401, { error: 'Sign in first.', code: 'AUTH_REQUIRED' }, corsHeaders(req));
  const ackLiveAds = new URL(req.url, 'http://local').searchParams.get('ackLiveAds') === '1';
  try {
    // launched ads first (409 ADS_LIVE unless acknowledged), then connected accounts (their vendor connections are
    // deleted while the ids are still known), then posting, analytics, SEO and billing, then Omnisend, then Gmail
    try {
      await integrations.forgetUser(ident.who.id, { ackLiveAds });
    } catch (e) {
      await integrations.unforgetUser(ident.who.id);
      throw e;
    }
    try {
      await omnisend.forgetUser(ident.who.id);
    } catch (e) {
      await integrations.unforgetUser(ident.who.id);
      throw e;
    }
    try {
      await gmail.forgetUser(ident.who.id);
    } catch (e) {
      await omnisend.unforgetUser(ident.who.id);
      await integrations.unforgetUser(ident.who.id);
      throw e;
    }
    try {
      await auth.deleteUser(ident.who.id);
    } catch (e) {
      // the account stays: don't keep it from connecting Omnisend or Gmail for a week
      await gmail.unforgetUser(ident.who.id);
      await omnisend.unforgetUser(ident.who.id);
      await integrations.unforgetUser(ident.who.id);
      throw e;
    }
    pages.forgetUser(ident.who.id);
    await integrations.userDeleted(ident.who.id);
    return send(res, 200, { ok: true }, corsHeaders(req));
  } catch (e) {
    // our own refusals carry their extra fields (ADS_LIVE: the campaigns still on); nothing else's text goes out: a
    // provider's or the database's failure (or anything without our code) is a plain "try again" here
    const ours = e?.code && typeof e.code === 'string' && e?.name !== 'StripeError' && e?.name !== 'DbError';
    if (!ours) {
      console.error('account_delete_failed', e?.name ?? 'Error', e?.code ?? '');
      return send(res, 503, { error: 'We couldn’t delete your account just now. Try again shortly.', code: 'UNAVAILABLE' }, corsHeaders(req));
    }
    const live = e?.code === 'ADS_LIVE' && Array.isArray(e.extra?.live) ? { live: e.extra.live } : {};
    return send(res, e.status || 500, { error: e.message, code: e.code, ...live }, corsHeaders(req));
  }
}

// published pages: the signed-in API, the pages themselves, and people's own domains
// (appHostExtras: the app host's /sitemap.xml, /robots.txt and Search Console file, server/seo/sitemap.mjs)
// (offers: the buy links /b/<id>, server/offers/buy.mjs)
// (experiments: the A/B page split, server/experiments/pages.mjs; "Use the winner" republishes a page through pages)
const pages = pagesFromEnv(process.env, { auth, whoIs: ai.whoIs, send, readJson, rateLimited, corsHeaders, allowedOrigin: ALLOWED_ORIGIN, distDir: DIST, appHostExtras: integrations.appHostExtras, billing: integrations.billing, offers: integrations.offers?.buy ?? null, experiments: integrations.experimentPages });
integrations.setPages(pages);

const crashed = (req, res, e) => {
  console.error(e);
  if (!res.headersSent) send(res, 500, { error: 'Unexpected server error' }, corsHeaders(req));
  else res.destroy();
};

function route(req, res, url) {
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    // what the browser needs to sign in (the publishable key is meant to be public), and whether it can publish pages
    // billing: whether plans are set up and enforced (no key, no ids)
    // offers: whether buy links and Whop are on (booleans only)
    // experiments: whether A/B tests are on (P4b)
    return send(res, 200, { accounts: auth.publicConfig(), pages: pages.config(), billing: integrations.billing.config(), offers: integrations.offersConfig(), morning: integrations.morningConfig(), experiments: integrations.experimentsConfig() }, corsHeaders(req));
  }
  if (url.pathname === '/api/health' && req.method === 'GET') {
    // `ok`: the server is up; `ai` says which keys are ready and what powers each function (signed-in users only, with accounts on)
    return void ai
      .whoIs(req, res)
      .then(async (ident) => ident && send(res, 200, { ok: true, ai: await ai.health(ident.who, req) }, corsHeaders(req)))
      .catch((e) => crashed(req, res, e));
  }
  if (cron.match(url)) return void cron.handle(req, res, url, send).catch((e) => crashed(req, res, e));
  if (url.pathname.startsWith('/api/integrations/omnisend/')) return void omnisend.handle(req, res, url).catch((e) => crashed(req, res, e));
  if (url.pathname.startsWith('/api/integrations/gmail/')) return void gmail.handle(req, res, url).catch((e) => crashed(req, res, e));
  // connected accounts, the Upload-Post, Zernio and Nango webhooks (raw body), posting, public media links, analytics, SEO on Google, billing
  if (integrations.match(url)) return void integrations.handle(req, res, url).catch((e) => crashed(req, res, e));
  if (url.pathname === '/api/account' && req.method === 'DELETE') return void deleteAccount(req, res).catch((e) => crashed(req, res, e));
  if (pages.matchApi(url)) return void pages.handleApi(req, res, url).catch((e) => crashed(req, res, e));
  if (ai.match(url)) {
    return void ai.handle(req, res, url).then((handled) => {
      if (handled === false) send(res, 404, { error: 'Not found' }, corsHeaders(req));
    }, (e) => crashed(req, res, e));
  }
  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' }, corsHeaders(req));
  // the app's short public routes: /m/<id> (a lead magnet's download, server/leadFiles.mjs), /b/<id> (a buy link,
  // server/offers/buy.mjs), /o/ (not yet)
  if (pages.matchPublicRoute(url)) return void pages.servePublicRoute(req, res, url).catch((e) => crashed(req, res, e));
  // a visitor sending a published page's form (/<name>/lead; server/leads.mjs)
  if (req.method === 'POST' && pages.matchLead(url)) return void pages.receiveLead(req, res, url).then((handled) => handled || send(res, 405, 'Method not allowed'), (e) => crashed(req, res, e));
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  // Privacy and Terms are real HTML documents (server/legal.mjs), not the SPA shell. No sign-in.
  if (serveLegal(req, res, url)) return;
  // the app host's /sitemap.xml, /robots.txt and Search Console file (server/seo/sitemap.mjs), then pages and the app
  return void pages.serveAppHostExtras(req, res, url).then((handled) => handled || servePageOrApp(req, res, url), (e) => crashed(req, res, e));
}

function servePageOrApp(req, res, url) {
  // a published page (/<name>, /<name>/img/…), unless the name is one of the app's own paths
  if (pages.matchPage(url)) return void pages.servePage(req, res, url).then((handled) => handled || serveStatic(req, res, url), (e) => crashed(req, res, e));
  return serveStatic(req, res, url);
}

function handle(req, res) {
  const url = requestUrl(req);
  if (!url) return send(res, 400, 'Bad request');
  // The app and /api answer only on the app's own hosts. Any other host may be someone's domain, now or
  // later, so only published pages (of a verified domain) answer there, whatever the database says.
  if (!pages.isAppHost(req)) return void pages.serveDomain(req, res, url).catch((e) => crashed(req, res, e));
  return route(req, res, url);
}

const server = http.createServer((req, res) => {
  // nothing a request does may stop the server: an unexpected error answers 500
  try {
    handle(req, res);
  } catch (e) {
    crashed(req, res, e);
  }
});
// a promise that fails with nothing waiting for it is logged, not the end of every request this copy is serving
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

server.listen(PORT, HOST, async () => {
  const h = await ai.health({ id: 'startup' });
  console.log(`Yourlocalbusiness server on http://localhost:${PORT}`);
  const ready = h.providers.filter((p) => p.ready).map((p) => p.label);
  console.log(ready.length ? `AI keys ready: ${ready.join(', ')}` : 'No AI keys yet: add them in Settings › AI keys, or as Secrets (e.g. OPENROUTER_API_KEY).');
  console.log(auth.enabled ? `Accounts: on (Supabase)${auth.signInRequired ? ', sign-in required' : ''}` : 'Accounts: off (add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to turn them on).');
  if (auth.enabled) console.log(pages.enabled ? 'Publishing pages: on (needs supabase/migrations/20261103040000_published_pages.sql in Supabase). Own domains are proven with a TXT record, _ylb-domain.<domain>.' : 'Publishing pages: off (add the SUPABASE_SECRET_KEY Secret to turn it on).');
  console.log(pages.appHostsNote());
  if (pages.enabled) console.log(pages.visitorsNote());
  console.log(
    ai.store.storage === 'supabase'
      ? {
          loaded: 'AI keys and settings: kept in Supabase, encrypted (loaded).',
          uploaded: 'AI keys and settings: kept in Supabase, encrypted (this server’s keys were uploaded).',
          empty: 'AI keys and settings: kept in Supabase, encrypted (none saved yet).',
          'no-table': `AI keys and settings: NOT kept yet. Run ${MIGRATION} in Supabase → SQL Editor, then restart.`,
          unreadable: 'AI keys and settings: the copy in Supabase was encrypted with a different secret and can’t be read (see Settings › AI keys).',
          slow: 'AI keys and settings: Supabase is slow to answer; using this server’s copy until it does.',
        }[settingsFrom] ?? 'AI keys and settings: Supabase couldn’t be reached; using this server’s copy for now.'
      : process.env.SUPABASE_URL
        ? 'AI keys and settings: kept on this server’s disk. Add the SUPABASE_SECRET_KEY Secret to keep them in Supabase (published Replit apps wipe the disk when they restart).'
        : 'AI keys and settings: kept on this server’s disk. To keep them in Supabase, add the SUPABASE_URL and SUPABASE_SECRET_KEY Secrets (published Replit apps wipe the disk when they restart).',
  );
  if (auth.enabled && pages.enabled) console.log('Lead forms: on (they need supabase/migrations/20261103050000_page_leads.sql in Supabase too; limits: LEADS_PER_IP_PER_HOUR, LEADS_PER_PAGE_PER_HOUR).');
  if (auth.enabled && pages.enabled) {
    // the tickets' secret is never logged: only whether it's set, and its last 4 characters (masked like the others)
    const own = String(process.env.LEAD_LINK_SECRET ?? '');
    const signing = own.length >= 16 ? `LEAD_LINK_SECRET (…${own.slice(-4)})` : `a key derived from SUPABASE_SECRET_KEY${own ? ' (LEAD_LINK_SECRET is set but shorter than 16 characters, so it isn’t used)' : ''}`;
    console.log(`Lead magnets: on at /m/<id> (they need supabase/migrations/20261112000000_leads_p2.sql; limits: MAGNET_HITS_PER_IP_PER_HOUR, MAGNET_DOWNLOADS_PER_FILE_PER_HOUR, MAGNET_SIGNUPS_PER_FILE_PER_HOUR; download tickets signed with ${signing}).`);
  }
  if (ai.store.imported) console.log('Imported your image keys from the old Image generation settings.');
  for (const line of integrations.notes()) console.log(line);
  for (const line of gmail.notes()) console.log(line);
  for (const line of cron.notes()) console.log(line);
  // the startup sweeps: stuck posting jobs and analytics runs, unsettled treg calls (never a resend)
  void integrations.start();
  // local dev only: the periodic jobs tick in this process (on a deployment POST /api/cron/tick is the only driver)
  cron.startLocal();
  if (!fs.existsSync(DIST)) console.log('No ./dist yet: run `npm run build` to serve the app from here, or use `npm run dev` (it proxies /api to this server).');
});

process.on('SIGTERM', async () => {
  ai.usage.flush();
  // the usage log's latest entries, if Supabase keeps it (don't wait long: the host is stopping us)
  await Promise.race([ai.usage.flushRemote(), new Promise((r) => setTimeout(r, 2500))]);
  process.exit(0);
});
