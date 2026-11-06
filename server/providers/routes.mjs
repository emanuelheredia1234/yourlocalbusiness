// HTTP routes for AI, mounted by ai-server.mjs:
//
//   GET  /api/ai/providers                 → catalog, per-key settings (keys masked), routing, canManage
//   PUT  /api/ai/providers/:id             { apiKey?, removeKey?, enabled?, functions?, effort?, models? }   (admin)
//   PUT  /api/ai/settings                  { order }                                                         (admin)
//   GET  /api/ai/providers/:id/models?kind → built-in models plus the account's live list                   (admin)
//   POST /api/ai/providers/:id/test        { compare?: string[] } → free key check, or a paid effort comparison (admin)
//   POST /api/ai/generate                  { fn, prompt, images?, tier?, brain?, research? } → { text, meta }
//                                          (research: { web: true, maxSearches?, location? } for functions marked
//                                          "research", Strategy: a web search with sources in meta.research)
//   POST /api/ai/image                     { prompt, aspect } → image bytes (meta in the x-ai-meta header)
//   POST /api/ai/video                     { prompt, aspect, duration, firstFrame? } → job
//   GET  /api/ai/video/:id                 → job;  GET /api/ai/video/:id/content → video bytes
//   POST /api/ai/manus/create | /output | /continue   (Manus tasks, same shapes as the Zapier actions;
//                                          fn "marketResearch" sends { research: { niche, category, kind, typeLabel,
//                                          city, region } } and the server writes the task itself; so do fn "build"
//                                          { build, files?, profile?, ref, dryRun? } and fn "agentchat" { chat, … },
//                                          from server/agents/templates.mjs, and their follow-ups on /continue)
//   POST /api/ai/manus/messages | /html | /file | /stop | /verify   (a build's or chat's replies, its page as JSON,
//                                          a file's bytes, stop, and finding a task after an uncertain start)
//   /api/ai/slack…                         Viktor through the owner's Slack app (server/slack/routes.mjs)
//   GET  /api/ai/usage                     → recent requests and totals                                      (admin)
//   GET  /api/ai/limits | PUT { requestsPerDay?, usdPerDay? } → daily limits for signed-in users             (admin)
//   GET  /api/ai/usage/users?days=7        → each user's daily counters                                     (admin)
//   GET  /api/ai/my-usage                  → the signed-in user's counters: today, the last 7 days, limits
//   GET  /api/ai/my-keys | PUT /api/ai/my-keys/:provider { apiKey } | DELETE …   the signed-in user's own keys
//
// "admin" = this machine, or the ADMIN_TOKEN header (with accounts on: the owner's account).
// Generation routes refuse other sites' pages.
//
// With accounts on, a signed-in non-admin user's requests run on their own keys when they've added one
// that can do the job (never limited); otherwise on the owner's keys, within the owner's daily limits
// (429 DAILY_LIMIT once today's requests or dollars reach them; counters reset at midnight UTC).
// With accounts on but sign-in not required, signed-out visitors share the same limits, counted per
// network address in this server's memory (so signing out never lifts a limit).
//
// Plans (server/billing/stripe.mjs, through setBilling): once enforced, a request on the app's keys also needs an
// active plan (402 PLAN_REQUIRED / PAYMENT_REQUIRED) and room in the month's AI credits (402 CREDITS_USED; the daily
// dollar cap still stops bursts). Own keys are never limited by either. Videos are held to the plan's length.

import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { FUNCTIONS, FUNCTION_GROUPS, PROVIDERS, defaultEffort, describeProviders, effortLabel, fnById } from './registry.mjs';
import { AIStore } from './store.mjs';
import { UsageLog } from './usage.mjs';
import { AIRouter, asProviderError, ownLabel } from './router.mjs';
import { USER_KEY_PROVIDERS } from '../userKeys.mjs';
import { createLimits, utcDay } from '../limits.mjs';
import { ASPECTS } from './adapters/images.mjs';
import { ProviderError, parseDataUrl } from './http.mjs';
import { researchFromBody, researchInfo } from './research.mjs';
import { marketResearchFacts, marketResearchPrompt, marketResearchTitle } from './marketResearch.mjs';
import { MANUS_FILE_RE, MANUS_LIMIT, MANUS_MISSING_FILE, REF_RE, TemplateError, cleanAnswer, cleanBuild, cleanChat, cleanEdit, manusAnswer, manusBuild, manusChatLater, manusChatOpening, manusEdit } from '../agents/templates.mjs';
import { createSlackRoutes } from '../slack/routes.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Settings changes are allowed from this machine (no proxy in between) or with the ADMIN_TOKEN header. */
export function canManage(req, adminToken) {
  const token = req.headers['x-admin-token'];
  if (adminToken && typeof token === 'string' && token.length === adminToken.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminToken))) return true;
  const forwarded = req.headers['x-forwarded-for'] || req.headers.forwarded;
  return LOOPBACK.has(req.socket.remoteAddress || '') && !forwarded;
}

/** Requests must come from this app's own page (or the one allowed origin), never from another site. */
export function sameOrigin(req, allowedOrigin) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowedOrigin && origin === allowedOrigin) return true;
  try {
    const originHost = new URL(origin).host;
    if (originHost === req.headers.host) return true;

    // Replit's preview proxy sends /api requests through the local Vite proxy,
    // which changes Host to localhost:8787. Trust its forwarded host only for
    // requests that actually arrived from this machine.
    const forwardedHost = req.headers['x-forwarded-host'];
    return LOOPBACK.has(req.socket.remoteAddress || '')
      && typeof forwardedHost === 'string'
      && forwardedHost.split(',').map((host) => host.trim()).includes(originHost);
  } catch {
    return false;
  }
}

const MAX_PROMPT_CHARS = 120_000;
const MAX_MEDIA_PROMPT = 4000;
const VIDEO_ASPECTS = new Set(['9:16', '1:1', '16:9', '3:4', '4:3']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Images sent with a writing request: the first 4 (the app resizes them first, so they fit in the body limit). */
const MAX_TEXT_IMAGES = 4;

const cleanImages = (list) =>
  (Array.isArray(list) ? list : [])
    .slice(0, MAX_TEXT_IMAGES)
    .filter((u) => {
      const d = parseDataUrl(u);
      return d && IMAGE_TYPES.has(d.mime);
    });

const NO_ACCOUNTS = { enabled: false, signInRequired: false, identify: async () => null };
const LOCAL_ONLY = { enabled: false, get: async () => null, version: async () => null, put: async () => null };
const NO_USER_KEYS = { enabled: false, get: async () => null, all: async () => ({}), info: async () => Object.fromEntries(USER_KEY_PROVIDERS.map((p) => [p, null])), list: async () => [], set: async () => {}, remove: async () => {} };

/** What the browser is told about the providers a user can add their own key for. */
const OWN_KEY_PROVIDERS = USER_KEY_PROVIDERS.map((id) => ({ id, label: PROVIDERS[id].label, kinds: Object.keys(PROVIDERS[id].kinds), keyUrl: PROVIDERS[id].keyUrl }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * auth (server/auth.mjs): with accounts on, AI needs a signed-in user, the owner (ADMIN_EMAILS) manages
 * the keys, and each video job or Manus task can only be read by whoever started it.
 */
export function createAIRoutes({ send, readJson, corsHeaders, rateLimited, dataDir, adminToken = '', allowedOrigin = '', env = process.env, fetch = globalThis.fetch, baseUrls = {}, auth = NO_ACCOUNTS, userKeys = NO_USER_KEYS, appState = LOCAL_ONLY, limits = createLimits(), slackOptions = {}, billing: billingIn = null }) {
  // the plans (server/integrations/wiring.mjs integrations.billing): set after the integrations are made
  let billing = billingIn;
  // appState (server/appState.mjs): with Supabase's secret key, the owner's keys and settings, the
  // Manus task list and the usage log are also kept in Supabase, so they survive restarts
  const store = new AIStore(path.join(dataDir, 'ai-providers.json'), { env, legacyFile: path.join(dataDir, 'image-providers.json'), remote: appState });
  const usage = new UsageLog(path.join(dataDir, 'ai-usage.json'), { remote: appState });
  const router = new AIRouter({ store, usage, fetch, baseUrls, tasksFile: path.join(dataDir, 'ai-tasks.json'), remote: appState });
  // hosts that wipe the disk when the app restarts or sleeps (keys typed into the app would vanish)
  const ephemeralDisk = !!(env.REPLIT_DEPLOYMENT || env.VERCEL);

  /** A settings change is kept on this server; report if it didn't also reach Supabase. */
  const savedReply = async (req, res, who) => {
    try {
      await store.persisted();
    } catch (e) {
      return reply(req, res, 502, { error: `${e.message} The change works on this server for now, but may be lost when the app restarts.`, code: 'NOT_SAVED', cause: e.code || 'UNREACHABLE', state: state(req, who) });
    }
    return reply(req, res, 200, { state: state(req, who) });
  };

  /** Wait for a look at Supabase, but never long: a slow Supabase mustn't hold up the app. */
  const freshEnough = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref?.())]);

  /**
   * Run an AI request; if this copy of the server knows no key for it, look in Supabase once and try
   * again (a key may have just been added through another copy). "No key" is decided before anything
   * is sent to a provider, so the second try can't start paid work twice.
   */
  const withFreshKeys = async (run) => {
    try {
      return await run();
    } catch (e) {
      if (e?.code !== 'NO_PROVIDER' && e?.code !== 'USE_AGENT') throw e;
      if (!store.remote.enabled) throw e;
      await freshEnough(store.refresh({ force: true }), 2500);
      return run();
    }
  };

  const reply = (req, res, status, body, headers) => send(res, status, body, { ...corsHeaders(req), ...headers });

  const fail = (req, res, e) => {
    const err = asProviderError(e);
    if (err.code === 'UPSTREAM' && !err.provider) console.error(e);
    return reply(req, res, err.status || 502, { error: err.message, code: err.code, ...(err.attempts ? { attempts: err.attempts } : {}), ...(typeof err.filename === 'string' ? { filename: err.filename } : {}) });
  };

  /**
   * The owner. With accounts on: only someone signed in with an ADMIN_EMAILS address (an admin token
   * left in a shared browser, or a request from this machine, must not make another account the owner).
   * Without accounts: this machine, or the ADMIN_TOKEN.
   */
  const isAdmin = (req, who) => (auth.enabled ? !!who?.isAdmin : canManage(req, adminToken));

  const admin = (req, res, who) => {
    if (!sameOrigin(req, allowedOrigin)) {
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return false;
    }
    if (!isAdmin(req, who)) {
      const error = auth.enabled
        ? 'Only the app’s owner can change the AI keys. Sign in with the email in the ADMIN_EMAILS Secret.'
        : adminToken
          ? 'Enter the admin token to change AI settings.'
          : 'AI settings can only be changed from the machine running the server. On Replit, add a Secret named ADMIN_TOKEN and enter it here.';
      reply(req, res, 403, { error, code: 'FORBIDDEN' });
      return false;
    }
    return true;
  };

  /** A signed-in user is needed when accounts are on. */
  const signedIn = (req, res, who) => {
    if (auth.signInRequired && !who) {
      reply(req, res, 401, { error: 'Sign in to use AI.', code: 'AUTH_REQUIRED' });
      return false;
    }
    return true;
  };

  const generationAllowed = (req, res, bucket, who) => {
    if (!sameOrigin(req, allowedOrigin)) {
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return false;
    }
    if (!signedIn(req, res, who)) return false;
    // reads (a build card or the chat checking for replies every few seconds) get three times the limit
    if (rateLimited(`${bucket}:${who ? `user:${who.id}` : req.socket.remoteAddress || 'unknown'}`, bucket.endsWith('-read') ? 3 : 1)) {
      reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
      return false;
    }
    return true;
  };

  /** Jobs and tasks belong to whoever started them (older ones have no owner). */
  const mayUse = (req, owner, who) => !owner || owner === who?.id || isAdmin(req, who);
  const notFound = (req, res) => reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });

  /**
   * Accounts on and not the owner: requests use their own keys, or the owner's within the daily limits.
   * Signed-out visitors (allowed when sign-in isn't required) are metered too, by network address.
   */
  const isMetered = (req, who) => auth.enabled && !isAdmin(req, who);
  /** Who a metered request is counted for: the user, or `anon:<address>` (memory only). */
  const meterId = (req, who) => (who?.id ? { id: who.id, email: who.email || '' } : { id: `anon:${req.socket.remoteAddress || 'unknown'}`, email: '' });

  /** A metered user's own keys in plain text ({ provider: key }); never sent anywhere but to that provider. */
  const ownKeysOf = async (who, opts) => {
    if (!who?.id || !UUID.test(who.id) || !userKeys.all) return {};
    try {
      return await userKeys.all(who.id, opts);
    } catch (e) {
      console.warn(`Own keys: ${e.message}`);
      return {};
    }
  };

  const dailyLimitError = (st, who) => {
    const parts = [st.requestsPerDay > 0 ? `${st.requestsPerDay} request${st.requestsPerDay === 1 ? '' : 's'}` : '', st.usdPerDay > 0 ? `$${st.usdPerDay.toFixed(2)}` : ''].filter(Boolean).join(' or ');
    const next = who ? 'To keep going now, add your own API keys in Settings › AI keys.' : 'Sign in, and add your own API keys in Settings › AI keys, to keep going now.';
    const left = Math.max(0, st.usdPerDay - st.usedUsd - (st.pendingUsd || 0));
    return {
      error: st.tooCostly
        ? `This would cost about $${st.estimateUsd.toFixed(2)} on the app’s AI keys, more than what’s left of today’s $${st.usdPerDay.toFixed(2)} limit ($${left.toFixed(2)}). It resets at midnight UTC. ${next}`
        : `You’ve reached today’s limit on the app’s AI keys${parts ? ` (${parts} a day)` : ''}. It resets at midnight UTC. ${next}`,
      code: 'DAILY_LIMIT',
      limits: st,
    };
  };

  /**
   * Before an AI request: which keys it runs on, and whether the user may run it.
   * Returns null (after replying 429 DAILY_LIMIT) when they're over the limit, else
   * { ownKeys, meter, done }: pass ownKeys and meter to the router, then await done() once it finishes.
   * meter.start() marks the request as having reached a provider (only then is it counted).
   *
   * opts.estimateUsd: what the request will likely cost on the owner's keys. It's reserved (with the
   * request) before the counters are read, so parallel requests can't all pass. opts.charge: videos
   * add the estimate to the day as soon as they start (their real cost is known only when the job
   * finishes); later(usd) then records the difference. opts.strict (videos, and web research): refuse
   * when the estimate alone would take the day over the dollar limit ("too costly"), before anything runs.
   * A web research request that failed after it started (timed out, stopped, cut off) adds the estimate
   * too: its searches may be billed and its real cost never arrives (the router says so: cost(usd, { unsure })).
   */
  /**
   * The signed-in user's plan for a request on the app's keys, or null when plans don't apply (not enforced, the
   * owner, no billing). Replies 402/503 itself and answers false when the request can't run.
   */
  async function planFor(req, res, who) {
    if (!billing?.entitlement) return null;
    let ent;
    try {
      ent = who?.id ? await billing.entitlement(who.id, who) : null;
    } catch {
      // the plan can't be read: refuse only when plans are known to be on
      if (billing.config?.().enforce !== true) return null;
      reply(req, res, 503, { error: 'Couldn’t check your plan right now. Try again in a minute, or use your own AI keys.', code: 'UNAVAILABLE' });
      return false;
    }
    if (!who?.id) {
      // signed-out visitors (sign-in not required): no plan, once plans are enforced
      if (billing.config?.().enforce !== true) return null;
      reply(req, res, 402, { error: 'This needs a plan. Choose one to keep going.', code: 'PLAN_REQUIRED', need: { feature: 'ai', tier: 'launch' }, upgrade: '#plans' });
      return false;
    }
    if (ent.plan === 'legacy' || ent.plan === 'owner') return null;
    if (!ent.active) {
      const payment = ent.paused === 'payment';
      reply(req, res, 402, payment ? { error: 'Your last payment didn’t go through. Update your card in Billing to keep going.', code: 'PAYMENT_REQUIRED', upgrade: '#plans' } : { error: 'This needs a plan. Choose one to keep going.', code: 'PLAN_REQUIRED', need: { feature: 'ai', tier: 'launch' }, upgrade: '#plans' });
      return false;
    }
    return ent;
  }

  const creditsError = (ent, st) => {
    const resets = st.resetsAt ? new Date(st.resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : 'next month';
    return {
      error: `You’ve used this month’s AI credits. They renew on ${resets}. Add a business or upgrade for more, or use your own AI keys.`,
      code: 'CREDITS_USED',
      resetsAt: st.resetsAt,
      credits: { monthly: ent.creditsPerMonth },
      upgrade: '#plans',
    };
  };

  async function gate(req, res, who, kind, { estimateUsd = 0, charge = false, strict = charge, ent: knownPlan } = {}) {
    const noop = { ownKeys: null, meter: null, done: async () => {}, later: null };
    if (!isMetered(req, who)) return noop;
    const m = meterId(req, who);
    let ownKeys = await ownKeysOf(who);
    let own = router.ownRoute(kind, ownKeys).length > 0;
    let release = () => {};
    const day = utcDay();
    // own keys are never limited by a plan; on the app's keys the plan must be active and have credits left
    const plan = own ? null : knownPlan !== undefined ? knownPlan : await planFor(req, res, who);
    if (plan === false) return null;
    if (!own) {
      // reserve first (no await in between), then read: requests ahead of this one count against it
      release = limits.reserve(m.id, { usd: estimateUsd });
      const st = await limits.status(m.id, store.limits(), { reservation: release, strict });
      if (st.reached && who?.id && !st.unavailable) {
        // a key just added through another copy of the server may not be cached here yet
        ownKeys = await ownKeysOf(who, { fresh: true });
        own = router.ownRoute(kind, ownKeys).length > 0;
        if (own) {
          release();
          release = () => {};
        }
      }
      if (!own && st.reached) {
        release();
        if (st.unavailable) {
          reply(req, res, 503, { error: 'Couldn’t check today’s AI usage right now (Supabase didn’t answer). Try again in a minute, or add your own API keys in Settings › AI keys.', code: 'LIMITS_UNAVAILABLE' });
          return null;
        }
        reply(req, res, 429, dailyLimitError(st, who));
        return null;
      }
      // the month's AI credits (after the daily cap, which stops bursts)
      if (!own && plan && plan.creditsPerMonth != null && plan.creditWindow) {
        const mst = await limits.monthStatus(m.id, { budgetUsd: plan.creditsPerMonth * 0.01, sinceDay: plan.creditWindow.start.slice(0, 10), resetsAt: plan.creditWindow.resetsAt }, { reservation: release, strict });
        if (mst.reached) {
          ownKeys = await ownKeysOf(who, { fresh: true });
          own = router.ownRoute(kind, ownKeys).length > 0;
          release();
          if (!own) {
            if (mst.unavailable) {
              reply(req, res, 503, { error: 'Couldn’t check this month’s AI credits right now (Supabase didn’t answer). Try again in a minute, or add your own API keys in Settings › AI keys.', code: 'LIMITS_UNAVAILABLE' });
              return null;
            }
            reply(req, res, 402, creditsError(plan, mst));
            return null;
          }
          release = () => {};
        }
      }
    }
    const meter = {
      started: false,
      usd: 0,
      // a research request that failed after it started: what it cost is only an estimate
      unsure: false,
      start() {
        this.started = true;
      },
      cost(usd, { unsure = false } = {}) {
        if (unsure) this.unsure = true;
        if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) this.usd += usd;
      },
    };
    let settled = false;
    let early = null; // later() heard before done(): applied once done() has recorded the start
    // what was added to the day up front (videos on the owner's keys), corrected by later()
    let charged = 0;
    const add = (d) => limits.add(m.id, m.email, d, { day });
    return {
      ownKeys: own ? ownKeys : null,
      meter,
      own,
      /** Record the request (if it reached a provider) and its cost so far. failed: a video that never started. */
      done: async ({ failed = false } = {}) => {
        if (settled) return;
        settled = true;
        try {
          if (!meter.started) return;
          if (own) await add({ ownRequests: 1, ownUsd: meter.usd });
          else {
            // a started video, or a research request that failed after it started, counts at least its estimate
            const usd = (charge && !failed) || meter.unsure ? Math.max(meter.usd, estimateUsd) : meter.usd;
            charged = charge && !failed ? usd : 0;
            await add({ requests: 1, usd });
          }
        } finally {
          release();
          if (early) await later(...early);
        }
      },
      /**
       * A cost that's known later (a video's, when it finishes): usd is the cost, or null when it
       * isn't known; failed: the job made nothing (an unknown cost then means none).
       */
      later,
    };
    function later(usd, { failed = false } = {}) {
      if (!settled) {
        early = [usd, { failed }];
        return Promise.resolve();
      }
      early = null;
      const known = typeof usd === 'number' && Number.isFinite(usd);
      let d;
      if (own) d = known && usd > 0 ? { ownUsd: usd } : null;
      else {
        const real = known ? Math.max(0, usd) : failed ? 0 : charged;
        d = real !== charged ? { usd: real - charged } : null;
        charged = real;
      }
      return d ? add(d).catch((e) => console.warn(`AI limits: ${e.message}`)) : Promise.resolve();
    }
  }

  /**
   * The user's own key a video job was started with (looked up again by owner, never stored on the job).
   * null only when the key is gone; a Supabase hiccup is an error to try again after, not a removed key.
   */
  const jobKey = async (job) => {
    if (!job?.ownKey || !job.owner) return null;
    try {
      return await userKeys.get(job.owner, job.provider);
    } catch (e) {
      console.warn(`Own keys: ${e.message}`);
      throw new ProviderError('UPSTREAM', 'Couldn’t read your key to check on this video right now. Try again in a moment.', { status: 502 });
    }
  };

  async function body(req, res) {
    try {
      return await readJson(req);
    } catch (e) {
      reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
      return null;
    }
  }

  /** Aborts provider calls when the browser goes away. */
  const abortOnClose = (res) => {
    const c = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) c.abort();
    });
    return c.signal;
  };

  // Viktor through the owner's own Slack app (server/slack/routes.mjs): the same owner rule and helpers
  const slack = createSlackRoutes({ store, appState, fetch, baseUrls, dataDir, reply, body, admin, isAdmin, generationAllowed, abortOnClose, mayUse, rateLimited, corsHeaders, ...slackOptions });

  /** Where the daily counters are kept, and why Supabase isn't keeping them (if it isn't). */
  const countersWhere = () => ({ storage: limits.storage, storageProblem: limits.problem ?? null });

  const state = (req, who) => ({ ...store.list(), canManage: isAdmin(req, who), adminTokenSet: !!adminToken, imported: store.imported, storage: store.storage, storageProblem: store.storageProblem, ephemeralDisk, accounts: auth.enabled, supabaseUrlSet: !!env.SUPABASE_URL });

  /** The signed-in user behind a request (null when signed out, or accounts are off). */
  async function whoIs(req, res) {
    if (!auth.enabled || !req.headers.authorization) return { who: null };
    try {
      return { who: await auth.identify(req) };
    } catch (e) {
      reply(req, res, e.status || 503, { error: e.message, code: e.code || 'AUTH_UNAVAILABLE' });
      return null;
    }
  }

  // ───────────── building and chatting with Manus (server/agents/templates.mjs writes every message) ─────────────

  /** Files already handed to Manus with /api/ai/manus/attach (the owner's images): at most 8; null when one isn't valid. */
  const agentFiles = (list) => {
    const files = Array.isArray(list) ? list : [];
    if (files.length > 8) return null;
    const out = [];
    for (const f of files) {
      if (!f || typeof f.file_id !== 'string' || !MANUS_FILE_RE.test(f.file_id)) return null;
      out.push({ file_id: f.file_id, filename: typeof f.filename === 'string' && f.filename ? f.filename.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) : 'image.jpg' });
    }
    return out;
  };

  /** A failure starting or continuing a build or chat: which setup is missing, or Manus's "too long". */
  const agentFail = (req, res, e, prompt) => {
    const err = asProviderError(e, 'Manus');
    if (err.code === 'NO_PROVIDER') return reply(req, res, 409, { error: err.message, code: 'NO_PROVIDER', reason: store.ready('manus') ? 'not_ticked' : 'no_key' });
    if (err.code === 'BAD_REQUEST' && /too long|too many tokens|token limit|exceed|length/i.test(err.message)) return reply(req, res, 413, { error: 'Your message is too long for Manus.', code: 'TOO_LONG', chars: prompt.length, limit: MANUS_LIMIT });
    return fail(req, res, err);
  };

  /**
   * A build or chat task (one-shot: never retried). The browser sends structured fields only; the server
   * writes the task from its fixed template. dryRun: the exact message, without starting anything.
   */
  async function agentCreate(req, res, who, b) {
    const ref = typeof b.ref === 'string' ? b.ref : '';
    if (!REF_RE.test(ref)) return reply(req, res, 400, { error: 'The request needs its Ref.', code: 'BAD_REQUEST' });
    // the owner's Manus, or a signed-in user's own Manus key (their account and credits)
    const ownKey = auth.enabled && !isAdmin(req, who) ? await userKeys.get(who?.id, 'manus') : null;
    if (auth.enabled && !isAdmin(req, who) && !ownKey) return reply(req, res, 403, { error: 'Manus needs your own Manus account: add your Manus API key in Settings › AI keys.', code: 'OWN_KEY_NEEDED' });
    const tpl = b.fn === 'build' ? manusBuild(cleanBuild(b.build, 'manus'), ref) : manusChatOpening(cleanChat(b.chat, 'manus'), ref);
    if (b.dryRun === true) return reply(req, res, 200, { preview: { text: tpl.prompt, chars: tpl.prompt.length, limit: MANUS_LIMIT } });
    const files = agentFiles(b.files);
    if (!files) return reply(req, res, 400, { error: 'An image wasn’t sent to Manus first (at most 8 go with one message).', code: 'BAD_REQUEST' });
    if (!ownKey && !store.key('manus') && store.remote.enabled) await freshEnough(store.refresh({ force: true }), 2500);
    let created;
    try {
      created = await withFreshKeys(() => router.manusCreate({ fn: b.fn, prompt: tpl.prompt, title: tpl.title, files, owner: who?.id ?? null, apiKey: ownKey, profile: typeof b.profile === 'string' ? b.profile : '', ref }));
    } catch (e) {
      return agentFail(req, res, e, tpl.prompt);
    }
    // the task list must reach Supabase before the app asks another copy of the server about it
    await router.tasksSaved();
    return reply(req, res, 200, created);
  }

  /**
   * A follow-up (one-shot): a build takes a change, an answer or the fixed "send page.html" follow-up (never
   * a free prompt); a chat takes the owner's words as typed, with the website and images lines when added.
   */
  async function agentContinue(req, res, b, task, taskId, apiKey) {
    let prompt;
    let files = [];
    if (task.fn === 'build') {
      if (typeof b.prompt === 'string' && b.prompt.trim()) return reply(req, res, 400, { error: 'A build takes changes, answers or the fixed follow-up, not a free message.', code: 'BAD_REQUEST' });
      if (b.edit && typeof b.edit === 'object') {
        prompt = manusEdit(cleanEdit(b.edit, 'manus'));
        files = agentFiles(b.files);
      } else if (typeof b.answer === 'string') {
        prompt = manusAnswer(cleanAnswer(b.answer, 'manus'));
        files = agentFiles(b.files);
      } else if (b.followup === 'missing_file') prompt = MANUS_MISSING_FILE;
      else return reply(req, res, 400, { error: 'Send a change, an answer or the follow-up.', code: 'BAD_REQUEST' });
    } else {
      if (!b.chat || typeof b.chat !== 'object') return reply(req, res, 400, { error: 'Write a message first.', code: 'BAD_REQUEST' });
      prompt = manusChatLater(cleanChat(b.chat, 'manus'));
      files = agentFiles(b.files);
    }
    if (!files) return reply(req, res, 400, { error: 'An image wasn’t sent to Manus first (at most 8 go with one message).', code: 'BAD_REQUEST' });
    try {
      await router.manusContinue({ apiKey, taskId, prompt, files });
    } catch (e) {
      return agentFail(req, res, e, prompt);
    }
    return reply(req, res, 200, { ok: true });
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const ident = await whoIs(req, res);
    if (!ident) return;
    const { who } = ident;
    // keys or settings changed through another copy of the server: looked up every few seconds,
    // in the background (AI requests never wait for Supabase)
    const looked = store.refresh();

    // Viktor through the owner's Slack app (owner only)
    if (slack.match(url)) return slack.handle(req, res, url, who);

    if (p === '/api/ai/providers' && m === 'GET') {
      if (!signedIn(req, res, who)) return;
      // the settings page shows the newest settings (but doesn't wait long for them)
      await freshEnough(looked, 2500);
      // with accounts on, only the owner sees the keys' settings
      const show = !auth.enabled || isAdmin(req, who);
      return reply(req, res, 200, { catalog: describeProviders(), functions: FUNCTIONS, groups: FUNCTION_GROUPS, state: show ? state(req, who) : null, role: show ? 'admin' : 'user' });
    }

    const prov = /^\/api\/ai\/providers\/([a-z][a-z0-9]*)(\/models|\/test)?$/.exec(p);
    if (prov && PROVIDERS[prov[1]]) {
      const id = prov[1];
      if (!prov[2] && m === 'PUT') {
        if (!admin(req, res, who)) return;
        const b = await body(req, res);
        if (!b) return;
        try {
          // start from the newest settings, so this change can't undo one saved elsewhere
          await store.refresh({ force: true });
          store.update(id, b);
          return await savedReply(req, res, who);
        } catch (e) {
          return reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
        }
      }
      if (prov[2] === '/models' && m === 'GET') {
        if (!admin(req, res, who)) return;
        const kind = url.searchParams.get('kind') || 'text';
        return reply(req, res, 200, await router.models(id, kind, { signal: abortOnClose(res) }));
      }
      if (prov[2] === '/test' && m === 'POST') {
        if (!admin(req, res, who)) return;
        const b = await body(req, res);
        if (!b) return;
        try {
          if (Array.isArray(b.compare)) return reply(req, res, 200, await router.compareEfforts(id, b.compare, { signal: abortOnClose(res) }));
          return reply(req, res, 200, await router.checkKey(id, { signal: abortOnClose(res) }));
        } catch (e) {
          return fail(req, res, e);
        }
      }
    }

    if (p === '/api/ai/settings' && m === 'PUT') {
      if (!admin(req, res, who)) return;
      const b = await body(req, res);
      if (!b) return;
      try {
        await store.refresh({ force: true });
        store.setOrder(b.order);
        return await savedReply(req, res, who);
      } catch (e) {
        return reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
      }
    }

    if (p === '/api/ai/limits') {
      if (!admin(req, res, who)) return;
      if (m === 'GET') {
        await limits.probe?.();
        return reply(req, res, 200, { limits: store.limits(), ...countersWhere() });
      }
      if (m !== 'PUT') return reply(req, res, 405, { error: 'Method not allowed', code: 'METHOD' });
      const b = await body(req, res);
      if (!b) return;
      try {
        await store.refresh({ force: true });
        store.setLimits(b);
      } catch (e) {
        return reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
      }
      try {
        await store.persisted();
      } catch (e) {
        return reply(req, res, 502, { error: `${e.message} The change works on this server for now, but may be lost when the app restarts.`, code: 'NOT_SAVED', limits: store.limits() });
      }
      await limits.probe?.();
      return reply(req, res, 200, { limits: store.limits(), ...countersWhere() });
    }

    if (p === '/api/ai/usage/users' && m === 'GET') {
      if (!admin(req, res, who)) return;
      const days = Math.max(1, Math.min(90, Math.floor(Number(url.searchParams.get('days')) || 7)));
      const rows = await limits.usageByUser({ days });
      const per = new Map();
      for (const r of rows) {
        const t = per.get(r.userId) ?? { userId: r.userId, email: r.email, requests: 0, usd: 0, ownRequests: 0, ownUsd: 0 };
        if (!t.email && r.email) t.email = r.email;
        t.requests += r.requests;
        t.usd = Math.round((t.usd + r.usd) * 1e6) / 1e6;
        t.ownRequests += r.ownRequests;
        t.ownUsd = Math.round((t.ownUsd + r.ownUsd) * 1e6) / 1e6;
        per.set(r.userId, t);
      }
      const users = [...per.values()].sort((a, b) => b.usd - a.usd || b.requests - a.requests);
      return reply(req, res, 200, { days, rows, users, limits: store.limits(), ...countersWhere() });
    }

    if (p === '/api/ai/my-usage' && m === 'GET') {
      if (!sameOrigin(req, allowedOrigin)) return reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      if (!auth.enabled || !who) return reply(req, res, 401, { error: 'Sign in to see your AI usage.', code: 'AUTH_REQUIRED' });
      const days = await limits.history(who.id, { days: 7 });
      const today = days[0];
      const st = isAdmin(req, who) ? { unlimited: true } : { ...(await limits.status(who.id, store.limits())), unlimited: false };
      // plans: the month's AI credits (1 credit = $0.01 on the app's keys; own keys never count)
      let credits;
      try {
        const ent = billing?.entitlement && !isAdmin(req, who) ? await billing.entitlement(who.id, who) : null;
        if (ent && ent.creditsPerMonth != null && ent.creditWindow) {
          const used = await limits.monthUsage(who.id, ent.creditWindow.start.slice(0, 10));
          credits = { monthly: ent.creditsPerMonth, usedCredits: Math.ceil(Math.round(used.usd * 100 * 1e6) / 1e6), resetsAt: ent.creditWindow.resetsAt };
        }
      } catch {
        credits = undefined;
      }
      return reply(req, res, 200, { day: today.day, today: { requests: today.requests, usd: today.usd, ownRequests: today.ownRequests, ownUsd: today.ownUsd }, days, limits: st, ...(credits ? { credits } : {}), ...countersWhere() });
    }

    if (p === '/api/ai/usage' && m === 'GET') {
      // errors and task ids can reveal the owner's account details
      if (!admin(req, res, who)) return;
      return reply(req, res, 200, { recent: usage.recent(Number(url.searchParams.get('limit')) || 50), totals: usage.totals() });
    }

    if (p === '/api/ai/generate' && m === 'POST') {
      if (!generationAllowed(req, res, 'gen', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
      if (prompt.length > MAX_PROMPT_CHARS) return reply(req, res, 413, { error: 'Prompt too long', code: 'BAD_REQUEST' });
      const fn = typeof b.fn === 'string' ? b.fn : '';
      if (fnById[fn]?.kind !== 'text') return reply(req, res, 400, { error: 'Unknown AI function.', code: 'BAD_REQUEST' });
      // web research: only for functions marked "research"; clients choose how many searches and the place, nothing else
      let research = null;
      try {
        research = researchFromBody(b, fn);
      } catch (e) {
        return reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
      }
      // a research request reserves what searching and reading pages may cost, and is refused up front when that's too much
      const g = await gate(req, res, who, 'text', { estimateUsd: router.estimate('text', { fn, research }), strict: !!research });
      if (!g) return;
      const signal = abortOnClose(res);
      try {
        const out = await withFreshKeys(() => router.text(fn, { prompt, images: cleanImages(b.images), tier: b.tier === 'quick' ? 'quick' : 'default', brain: typeof b.brain === 'boolean' ? b.brain : null, signal, userId: who?.id, ownKeys: g.ownKeys, meter: g.meter, research }));
        await g.done();
        return reply(req, res, 200, out);
      } catch (e) {
        // failed, or stopped (the browser went away and the call was aborted): recorded either way, so
        // a research request that had started counts its estimate even when nobody is left to answer
        await g.done();
        if (signal.aborted) return;
        return fail(req, res, e);
      }
    }

    if (p === '/api/ai/image' && m === 'POST') {
      if (!generationAllowed(req, res, 'img', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
      if (prompt.length > MAX_MEDIA_PROMPT) return reply(req, res, 413, { error: 'Image prompt too long', code: 'BAD_REQUEST' });
      const g = await gate(req, res, who, 'image', { estimateUsd: router.estimate('image') });
      if (!g) return;
      const signal = abortOnClose(res);
      try {
        const out = await withFreshKeys(() => router.image({ prompt, aspect: ASPECTS[b.aspect] ? b.aspect : '1:1', signal, userId: who?.id, ownKeys: g.ownKeys, meter: g.meter }));
        await g.done();
        res.writeHead(200, {
          'content-type': out.contentType,
          'cache-control': 'no-store',
          'x-ai-meta': encodeURIComponent(JSON.stringify(out.meta)),
          ...(out.revisedPrompt ? { 'x-revised-prompt': encodeURIComponent(out.revisedPrompt.slice(0, 1500)) } : {}),
          'access-control-expose-headers': 'x-ai-meta, x-revised-prompt',
          ...corsHeaders(req),
        });
        return res.end(out.bytes);
      } catch (e) {
        await g.done();
        if (signal.aborted) return;
        return fail(req, res, e);
      }
    }

    if (p === '/api/ai/video' && m === 'POST') {
      if (!generationAllowed(req, res, 'vid', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
      if (prompt.length > MAX_MEDIA_PROMPT) return reply(req, res, 413, { error: 'Video prompt too long', code: 'BAD_REQUEST' });
      const firstFrame = typeof b.firstFrame === 'string' && parseDataUrl(b.firstFrame) && IMAGE_TYPES.has(parseDataUrl(b.firstFrame).mime) ? b.firstFrame : null;
      const aspect = VIDEO_ASPECTS.has(b.aspect) ? b.aspect : '9:16';
      const duration = Math.max(1, Math.min(15, Number(b.duration) || 8));
      // plans: the video's length and height follow the plan (asking for more than the plan allows is refused, not
      // cut short); own keys keep the app's limits
      let maxHeight;
      let ent;
      if (billing?.entitlement && isMetered(req, who) && who?.id) {
        try {
          ent = await billing.entitlement(who.id, who);
        } catch {
          ent = null;
        }
        const v = ent && ent.plan !== 'legacy' && ent.plan !== 'owner' ? ent.features?.video : null;
        if (v) {
          if (duration > v.maxSeconds) return reply(req, res, 402, { error: `Videos up to ${v.maxSeconds} seconds are part of your plan. Longer videos are part of Grow and Scale.`, code: 'PLAN_REQUIRED', need: { feature: 'video_length', tier: 'grow' }, upgrade: '#plans' });
          maxHeight = v.maxHeight;
        }
      }
      // on the owner's keys, the video's estimated cost counts toward the day as soon as it starts
      const g = await gate(req, res, who, 'video', { estimateUsd: router.estimate('video', { duration }), charge: true });
      if (!g) return;
      try {
        // one-shot paid job: started once, never retried (withFreshKeys retries only when no key was found,
        // before anything was sent). When it finishes (the server checks on it even if nobody asks), the
        // estimate is corrected to its real cost.
        const job = await withFreshKeys(() => router.startVideo({ prompt, aspect, duration, firstFrame, ...(maxHeight ? { maxHeight } : {}), owner: who?.id ?? null, ownKeys: g.ownKeys, meter: g.meter, onFinished: g.later ? (usd, j) => g.later(usd, { failed: j?.state === 'failed' }) : null }));
        await g.done();
        return reply(req, res, 200, { job });
      } catch (e) {
        await g.done({ failed: true });
        return fail(req, res, e);
      }
    }

    const vid = /^\/api\/ai\/video\/(vid_[0-9a-f-]{36})(\/content)?$/.exec(p);
    if (vid && m === 'GET') {
      if (!signedIn(req, res, who)) return;
      const job = router.jobs.get(vid[1]);
      if (!mayUse(req, job?.owner, who)) return notFound(req, res);
      try {
        // a job started with the user's own key is followed with that same key
        const apiKey = await jobKey(job);
        if (!vid[2]) return reply(req, res, 200, { job: await router.videoStatus(vid[1], { signal: abortOnClose(res), apiKey }) });
        const out = await router.videoContent(vid[1], { signal: abortOnClose(res), apiKey });
        res.writeHead(200, { 'content-type': out.contentType, 'content-length': out.bytes.length, 'cache-control': 'no-store', ...corsHeaders(req) });
        return res.end(out.bytes);
      } catch (e) {
        return fail(req, res, e);
      }
    }

    // the signed-in user's own keys: GET lists (last 4 only), PUT saves after a free check, DELETE removes
    const mk = /^\/api\/ai\/my-keys(?:\/([a-z0-9]+))?$/.exec(p);
    if (mk) {
      if (!sameOrigin(req, allowedOrigin)) return reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      if (!auth.enabled || !who) return reply(req, res, 401, { error: 'Sign in to add your own keys.', code: 'AUTH_REQUIRED' });
      const keysReply = async () => {
        const byProvider = await userKeys.info(who.id);
        const keys = USER_KEY_PROVIDERS.filter((id) => byProvider[id]).map((provider) => ({ provider, last4: byProvider[provider].last4, updatedAt: byProvider[provider].updatedAt }));
        return reply(req, res, 200, { available: userKeys.enabled, keys, byProvider, providers: OWN_KEY_PROVIDERS });
      };
      try {
        if (!mk[1]) return m === 'GET' ? await keysReply() : reply(req, res, 405, { error: 'Method not allowed', code: 'METHOD' });
        const id = mk[1];
        if (!USER_KEY_PROVIDERS.includes(id)) return reply(req, res, 404, { error: 'You can’t add your own key for that provider.', code: 'NOT_FOUND' });
        const label = PROVIDERS[id].label;
        if (m === 'DELETE') {
          if (!userKeys.enabled) return reply(req, res, 501, { error: 'Your own keys need the SUPABASE_SECRET_KEY Secret on the server. Ask the app’s owner to add it.', code: 'NOT_CONFIGURED' });
          await userKeys.remove(who.id, id);
          return await keysReply();
        }
        if (m === 'PUT') {
          if (rateLimited(`my-keys:${who.id}`)) return reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
          const b = await body(req, res);
          if (!b) return;
          const raw = typeof b.apiKey === 'string' ? b.apiKey : typeof b.key === 'string' ? b.key : '';
          const key = raw.trim();
          if (key.length < 16 || key.length > 400 || /\s/.test(key)) {
            return reply(req, res, 400, { error: id === 'manus' ? 'That doesn’t look like a Manus API key. Copy it again from Manus → Settings › Developers (API keys).' : `That doesn’t look like a ${label} API key. Copy it again from ${PROVIDERS[id].keyUrl}.`, code: 'BAD_REQUEST' });
          }
          if (!userKeys.enabled) return reply(req, res, 501, { error: 'Your own keys need the SUPABASE_SECRET_KEY Secret on the server. Ask the app’s owner to add it.', code: 'NOT_CONFIGURED' });
          try {
            // free check: lists the account's models (Manus: one task)
            await router.checkOwnKey(id, key, { signal: abortOnClose(res) });
          } catch (e) {
            const err = asProviderError(e, label);
            return reply(req, res, 400, { error: err.code === 'AUTH' ? `${label} didn’t accept that key. Check you copied all of it, or create a new one.` : `Couldn’t check the key with ${label}: ${err.message}`, code: 'BAD_KEY', cause: err.code });
          }
          await userKeys.set(who.id, id, key);
          return await keysReply();
        }
        return reply(req, res, 405, { error: 'Method not allowed', code: 'METHOD' });
      } catch (e) {
        return reply(req, res, e.status || 502, { error: e.message, code: e.code || 'UPSTREAM' });
      }
    }

    // a file for a Manus task (a post's video or image): sent to the Manus account that will run the
    // task, through Manus's upload (up to 512 MB; inline attachments stop at 20 MB). Either the bytes
    // themselves (?filename=…), or a short-lived signed link to the user's own file in Supabase Storage
    // (JSON { url, filename }), which the server downloads: big videos never pass through the browser.
    if (p === '/api/ai/manus/attach' && m === 'POST') {
      if (!generationAllowed(req, res, 'manus', who)) return;
      const ownKey = auth.enabled && !isAdmin(req, who) ? await userKeys.get(who?.id, 'manus') : null;
      if (auth.enabled && !isAdmin(req, who) && !ownKey) return reply(req, res, 403, { error: 'Manus needs your own Manus account: add your Manus API key in Settings › AI keys.', code: 'OWN_KEY_NEEDED' });
      if (!ownKey && !store.key('manus') && store.remote.enabled) await freshEnough(store.refresh({ force: true }), 2500);
      const MAX = 300 * 1024 * 1024;
      const cleanName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'file';
      try {
        let filename;
        let size;
        let stream;
        if (/application\/json/i.test(String(req.headers['content-type'] || ''))) {
          const b = await body(req, res);
          if (!b) return;
          let src;
          try {
            src = new URL(String(b.url || ''));
          } catch {
            src = null;
          }
          // only the signed-in user's own files in this app's Supabase project
          const supa = env.SUPABASE_URL ? new URL(env.SUPABASE_URL) : null;
          const prefix = who ? `/storage/v1/object/sign/media/${who.id}/` : null;
          if (!src || !supa || !prefix || src.origin !== supa.origin || !src.pathname.startsWith(prefix) || src.pathname.includes('..')) {
            return reply(req, res, 400, { error: 'That file isn’t one of yours.', code: 'BAD_REQUEST' });
          }
          const got = await fetch(src.href, { signal: abortOnClose(res) }).catch(() => null);
          if (!got?.ok || !got.body) return reply(req, res, 502, { error: 'Couldn’t read the file from your account. Try again.', code: 'UPSTREAM' });
          size = Number(got.headers.get('content-length') || 0);
          stream = got.body;
          filename = cleanName(b.filename);
        } else {
          size = Number(req.headers['content-length'] || 0);
          stream = Readable.toWeb(req);
          filename = cleanName(url.searchParams.get('filename'));
        }
        if (!size) return reply(req, res, 411, { error: 'The file’s size is missing.', code: 'BAD_REQUEST' });
        if (size > MAX) return reply(req, res, 413, { error: 'That file is over 300 MB.', code: 'TOO_LARGE' });
        const out = await router.manusUpload({ filename, size, body: stream, signal: abortOnClose(res), apiKey: ownKey });
        return reply(req, res, 200, out);
      } catch (e) {
        return fail(req, res, e);
      }
    }

    const mt = /^\/api\/ai\/manus\/(create|output|continue|messages|html|file|stop|verify)$/.exec(p);
    if (mt && m === 'POST') {
      const action = mt[1];
      const reading = action === 'output' || action === 'messages' || action === 'html' || action === 'file' || action === 'verify';
      if (!generationAllowed(req, res, reading ? 'manus-read' : 'manus', who)) return;
      const b = await body(req, res);
      if (!b) return;
      try {
        // building a page or an asset, and chatting: the server writes the message (server/agents/templates.mjs)
        if (action === 'create' && (b.fn === 'build' || b.fn === 'agentchat')) return await agentCreate(req, res, who, b);
        if (action === 'create') {
          // deep research (Strategy): the server writes the task from the owner's facts; a client prompt is ignored
          const research = b.fn === 'marketResearch';
          const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
          if (!research && !prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
          // Manus is an agent with its own browser, signed in to the owner's accounts (Facebook…), and the
          // prompt is written by the caller: with accounts on, only the owner may give it tasks
          // …unless they've added their own Manus key: then it's their own account and credits
          const ownKey = auth.enabled && !isAdmin(req, who) ? await userKeys.get(who?.id, 'manus') : null;
          if (auth.enabled && !isAdmin(req, who) && !ownKey) {
            return reply(req, res, 403, { error: 'Manus needs your own Manus account: add your Manus API key in Settings › AI keys.', code: 'OWN_KEY_NEEDED' });
          }
          let created;
          if (research) {
            // only the six facts, each one line without quotes, angle brackets or URLs; no image, files or client title
            const facts = marketResearchFacts(b.research);
            if (!facts.niche && !facts.category) return reply(req, res, 400, { error: 'Missing market details', code: 'BAD_REQUEST' });
            // one-shot write: never retried
            created = await withFreshKeys(() => router.manusCreate({ fn: 'marketResearch', prompt: marketResearchPrompt(facts), title: marketResearchTitle(facts), interactive: false, hidden: false, image: null, files: [], owner: who?.id ?? null, apiKey: ownKey }));
          } else {
            const image = typeof b.image_data_url === 'string' && parseDataUrl(b.image_data_url) ? { dataUrl: b.image_data_url, filename: typeof b.image_filename === 'string' ? b.image_filename.slice(0, 120) : 'image.jpg' } : null;
            // one-shot write: never retried
            // files already sent to Manus with /api/ai/manus/attach
            const files = (Array.isArray(b.files) ? b.files : [])
              .filter((f) => f && typeof f.file_id === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(f.file_id))
              .slice(0, 3)
              .map((f) => ({ file_id: f.file_id, filename: typeof f.filename === 'string' ? f.filename.slice(0, 120) : 'file' }));
            created = await withFreshKeys(() => router.manusCreate({ files, fn: b.fn, prompt: prompt.slice(0, 20_000), title: typeof b.title === 'string' ? b.title : '', interactive: b.interactive_mode === true || b.interactive_mode === 'true', hidden: b.hide_in_task_list === true || b.hide_in_task_list === 'true', image, owner: who?.id ?? null, apiKey: ownKey }));
          }
          // the task list must reach Supabase before the app asks another copy of the server about it
          await router.tasksSaved();
          return reply(req, res, 200, created);
        }
        if (action === 'verify') {
          // after an uncertain start: a read of the account's newest tasks, never a new task
          const ref = typeof b.ref === 'string' ? b.ref : '';
          const sentAt = Number(b.sent_at);
          if (!REF_RE.test(ref) || !Number.isFinite(sentAt) || sentAt <= 0) return reply(req, res, 400, { error: 'Send the request’s Ref and when it was sent.', code: 'BAD_REQUEST' });
          const ownKey = auth.enabled && !isAdmin(req, who) ? await userKeys.get(who?.id, 'manus') : null;
          if (auth.enabled && !isAdmin(req, who) && !ownKey) return reply(req, res, 403, { error: 'Manus needs your own Manus account: add your Manus API key in Settings › AI keys.', code: 'OWN_KEY_NEEDED' });
          if (!ownKey && !store.key('manus') && store.remote.enabled) await freshEnough(store.refresh({ force: true }), 2500);
          const hit = await router.manusVerify({ ref, sentAt, owner: who?.id ?? null, apiKey: ownKey, signal: abortOnClose(res) });
          if (hit) await router.tasksSaved();
          return reply(req, res, 200, hit ? { found: true, ...hit } : { found: false });
        }
        const taskId = typeof b.task_id === 'string' ? b.task_id.trim() : '';
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(taskId)) return reply(req, res, 400, { error: 'Missing task id', code: 'BAD_REQUEST' });
        // started by another copy of the server, or before a restart
        await router.ensureTask(taskId);
        const task = router.manusTasks.get(taskId);
        if (!mayUse(req, task?.owner, who)) return notFound(req, res);
        // a task started with someone's own key is read and continued with that key
        const apiKey = task?.ownKey ? await userKeys.get(task.owner, 'manus') : null;
        if (task?.ownKey && !apiKey) return reply(req, res, 409, { error: 'The Manus key this task was started with was removed. Add it again in Settings › AI keys.', code: 'OWN_KEY_NEEDED' });
        // the owner's task, on a copy of the server that hasn't picked up the owner's Manus key yet
        if (!apiKey && !store.key('manus') && store.remote.enabled) await freshEnough(store.refresh({ force: true }), 2500);
        if (action === 'output') {
          const out = await router.manusOutput({ apiKey, taskId, maxImages: Math.max(0, Math.min(8, Number(b.max_images) || 0)), maxImageBytes: Math.max(1, Math.min(30_000_000, Number(b.max_image_bytes) || 15_000_000)), signal: abortOnClose(res) });
          return reply(req, res, 200, out);
        }
        if (action === 'messages') return reply(req, res, 200, await router.manusMessages({ apiKey, taskId, after: typeof b.after === 'string' ? b.after.slice(0, 128) : '', signal: abortOnClose(res) }));
        // Manus's page as JSON: never answered as a page from the app's own address
        if (action === 'html') return reply(req, res, 200, await router.manusHtml({ apiKey, taskId, at: typeof b.at === 'string' ? b.at : '', signal: abortOnClose(res) }));
        if (action === 'file') {
          const out = await router.manusFile({ apiKey, taskId, at: typeof b.at === 'string' ? b.at : '', signal: abortOnClose(res) });
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': out.bytes.length,
            'content-disposition': `attachment; filename="${String(out.filename).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'file'}"`,
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
            'x-file-type': out.type,
            'access-control-expose-headers': 'x-file-type',
            ...corsHeaders(req),
          });
          return res.end(out.bytes);
        }
        if (auth.enabled && !isAdmin(req, who) && !task?.ownKey) {
          return reply(req, res, 403, { error: 'Manus runs in the app owner’s account, so only the owner can use it.', code: 'OWNER_ONLY' });
        }
        if (action === 'stop') {
          await router.manusStop({ apiKey, taskId, signal: abortOnClose(res) });
          return reply(req, res, 200, { ok: true });
        }
        // a build's or a chat's follow-up: the server writes it, and the task's own function decides which kinds it takes
        if (task?.fn === 'build' || task?.fn === 'agentchat') return await agentContinue(req, res, b, task, taskId, apiKey);
        const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
        if (!prompt) return reply(req, res, 400, { error: 'Missing message', code: 'BAD_REQUEST' });
        return reply(req, res, 200, await router.manusContinue({ apiKey, taskId, prompt: prompt.slice(0, 20_000) }));
      } catch (e) {
        if (e instanceof TemplateError) return reply(req, res, e.status, { error: e.message, code: e.code, ...e.data });
        return fail(req, res, e);
      }
    }

    return false;
  }

  return {
    store,
    router,
    usage,
    /** The plans (integrations.billing), once the integrations exist. */
    setBilling(b) {
      billing = b ?? null;
    },
    match: (url) => url.pathname.startsWith('/api/ai/'),
    handle,
    /** Who's calling (for routes outside /api/ai/*). */
    whoIs,
    /** For /api/health: which keys are ready, their model and effort per kind, and what powers each function. */
    /** At start-up: settings, Manus tasks and the usage log from Supabase (when it keeps them). */
    init: async () => {
      const [settings] = await Promise.all([store.loadRemote(), usage.loadRemote(), router.loadTasksRemote()]);
      return settings;
    },
    health: async (who = null, req = null) => {
      if (auth.signInRequired && !who) return { ready: false, providers: [], routing: {}, signedIn: false };
      // the app routes on this answer: a key just saved through another copy must show up here
      await freshEnough(store.refresh({ every: 1000 }), 2000);
      // with accounts on, the owner's Manus is the owner's alone; others can add their own Manus key
      const hide = auth.enabled && !who?.isAdmin ? new Set(['manus']) : new Set();
      const ownManus = hide.size && who?.id ? !!(await userKeys.get(who.id, 'manus').catch(() => null)) : false;
      const ids = store.order().filter((id) => !hide.has(id));
      const base = {
      signedIn: !!who,
      ready: ids.some((id) => store.ready(id)),
      providers: ids.map((id) => {
        const s = store.settings(id);
        return {
          id,
          label: PROVIDERS[id].label,
          ready: store.ready(id),
          models: s.models,
          effort: Object.fromEntries(Object.entries(s.effort).map(([kind, value]) => [kind, { id: value, label: value ? effortLabel(id, kind, value) : 'Set by the model' }])),
          // can search the web for Strategy with its writing model, and the list price per search
          research: researchInfo(id, s.models.text),
        };
      }),
      routing: Object.fromEntries(Object.entries(store.routing()).map(([fn, list]) => [fn, list.filter((id) => !hide.has(id))])),
      };
      // why posting with Manus does or doesn't work for this person, so the app can say what to fix
      base.posting = hide.size
        ? { ready: ownManus, reason: ownManus ? 'ok' : 'own_key_needed' }
        : !store.ready('manus')
          ? { ready: false, reason: 'no_key' }
          : !store.powers('manus', 'facebook')
            ? { ready: false, reason: 'not_ticked' }
            : { ready: true, reason: 'ok' };
      // building pages and assets, and chatting, with Manus and with Viktor (through the owner's Slack)
      const agentReady = (fn) => {
        const reason = hide.size ? (ownManus ? 'ok' : 'own_key_needed') : !store.ready('manus') ? 'no_key' : !store.powers('manus', fn) ? 'not_ticked' : 'ok';
        return { ready: reason === 'ok', reason };
      };
      // Viktor posts as the owner in Slack: only for the owner (same origin; with accounts, the owner's account)
      const viktorAllowed = !!req && sameOrigin(req, allowedOrigin) && isAdmin(req, who);
      base.agents = {
        manus: { build: agentReady('build'), chat: agentReady('agentchat'), own: !!ownManus, profile: store.settings('manus').effort.agent },
        viktor: viktorAllowed ? slack.health() : { ready: false, reason: 'owner_only', where: '', place: '' },
      };
      if (ownManus) {
        const s = store.settings('manus');
        base.ready = true;
        base.providers.push({ id: 'manus', label: 'Manus (your key)', ready: true, own: true, models: s.models, effort: Object.fromEntries(Object.entries(s.effort).map(([kind, value]) => [kind, { id: value, label: value ? effortLabel('manus', kind, value) : 'Set by the model' }])), research: null });
        base.routing.facebook = ['manus'];
        base.routing.marketResearch = ['manus'];
        base.routing.build = ['manus'];
        base.routing.agentchat = ['manus'];
        base.routing.photos = [...(base.routing.photos ?? []), 'manus'];
      }
      // a signed-in user's own keys: functions of a kind they can do run on them (and only them)
      const metered = auth.enabled && !!who?.id && !who.isAdmin && UUID.test(who.id);
      if (metered) {
        const ownKeys = await ownKeysOf(who);
        const ownIds = USER_KEY_PROVIDERS.filter((id) => id !== 'manus' && ownKeys[id]);
        for (const id of ownIds) {
          const models = {};
          const effort = {};
          for (const [kind, k] of Object.entries(PROVIDERS[id].kinds)) {
            models[kind] = k.defaultModel;
            const e = defaultEffort(id, kind, k.defaultModel);
            effort[kind] = { id: e, label: e ? effortLabel(id, kind, e) : 'Set by the model' };
          }
          // the owner's key with the same id is never used for this user: theirs replaces it
          base.providers = base.providers.filter((x) => x.id !== id);
          base.providers.push({ id, label: ownLabel(id), ready: true, own: true, models, effort, research: researchInfo(id, PROVIDERS[id].kinds.text?.defaultModel) });
        }
        if (ownIds.length) base.ready = true;
        for (const f of FUNCTIONS) {
          if (f.kind === 'agent') continue;
          const own = router.ownRoute(f.kind, ownKeys);
          if (!own.length) continue;
          // photos made by their own Manus stay listed after their own photo keys
          base.routing[f.id] = [...own, ...(f.id === 'photos' && ownManus ? ['manus'] : [])];
        }
        const st = await limits.status(who.id, store.limits());
        base.limits = { unlimited: false, requestsPerDay: st.requestsPerDay, usdPerDay: st.usdPerDay, usedRequests: st.usedRequests, usedUsd: st.usedUsd, resetsAt: st.resetsAt, reached: st.reached };
        // functions that run on their own keys (never limited); the rest use the owner's keys within the limits
        base.ownKeyFunctions = FUNCTIONS.filter((f) => f.kind !== 'agent' && router.ownRoute(f.kind, ownKeys).length).map((f) => f.id);
      } else if (auth.enabled && who?.isAdmin) {
        base.limits = { unlimited: true };
      }
      return base;
    },
  };
}
