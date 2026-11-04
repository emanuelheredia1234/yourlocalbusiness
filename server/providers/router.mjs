// Sends each AI request to the keys that power its function, in priority order, with each key's
// own model and effort, and records what it cost.
//
// Falling back to the next key: writing and photos move on after any provider failure except a
// content-policy block or refusal (the same request would fail elsewhere too). Videos and agent
// tasks are paid jobs, so they move on only when the provider certainly started nothing.
//
// Web research (Strategy, research.mjs): keys that can search go first. Once a key was asked to
// search, a failure moves on only when the provider certainly started nothing (a 4xx): after a
// timeout or a cut-off answer the searches may already be billed, so the owner decides.
//
// A signed-in user's own keys (ownKeys: { provider: key }) go first: if any of them can do the
// request's kind, only those are used (with the registry's default model and effort), never the
// owner's keys. `meter` hears when a request reaches a provider (start) and what it cost (cost),
// so the routes can count it against the owner's daily limits.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS, adapterId, defaultEffort, effortIds, effortLabel, estimateCost, fnById, kindDef } from './registry.mjs';
import { USER_KEY_PROVIDERS } from '../userKeys.mjs';
import { ProviderError } from './http.mjs';
import { RESEARCH_TIMEOUT_MS, canResearch, researchMeta, searchPrice } from './research.mjs';
import { MARKET_RESEARCH_SCHEMA, parseMarketResearch } from './marketResearch.mjs';
import anthropic from './adapters/anthropic.mjs';
import google from './adapters/google.mjs';
import manus from './adapters/manus.mjs';
import meta from './adapters/meta.mjs';
import openai from './adapters/openai.mjs';
import openrouter from './adapters/openrouter.mjs';
import xai from './adapters/xai.mjs';

export const ADAPTERS = { openrouter, google, xai, anthropic, meta, manus, openai };

export const SYSTEM =
  'You generate content for the Yourlocalbusiness app (product research, branding, sales pages, emails, social posts, ads and code widgets for creators and local businesses). Follow the instructions in the user message exactly and reply with only the JSON value it asks for.';

/** A small pricing puzzle: it rewards reasoning, so effort shows up in the token counts. */
export const COMPARE_PROMPT =
  'A candle shop sells 240 candles a month at $18 each. Every $1 price increase loses 12 sales a month (and every $1 decrease gains 12). Each candle costs $7 to make. Which whole-dollar or half-dollar price gives the most monthly profit? Reply with only JSON: {"price": number, "monthlyProfit": number}';

const MAX_JOBS = 40;
const JOB_TTL = 6 * 3600_000;
const TASK_TTL = 7 * 24 * 3600_000;

export function asProviderError(e, label = '') {
  if (e instanceof ProviderError) return e;
  return new ProviderError('UPSTREAM', `${label || 'The provider'} had an unexpected error: ${e?.message || e}`, { provider: label });
}

function canFallBack(err, kind) {
  if (err.code === 'ABORTED') return false;
  if (kind === 'video' || kind === 'agent') return err.notStarted;
  return !['CONTENT_POLICY', 'REFUSAL'].includes(err.code);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * What a request is assumed to cost when the price list can't say (for the owner's daily dollar
 * limit): writing and photos per request, videos per second. On the high side on purpose.
 */
export const FALLBACK_ESTIMATE = { text: 0.02, image: 0.08, videoPerSecond: 0.05 };
/** How often the server checks on a video running on the owner's keys, so its cost is counted even if nobody asks. */
const WATCH_MS = 15_000;

/** A research request's size for the daily-limit estimate: the pages it reads arrive as input tokens. */
const RESEARCH_TOKENS = { input: 40_000, output: 6_000 };
/** …and what it's assumed to cost when the price list can't say. */
const RESEARCH_FALLBACK = 0.15;

/** The label a user's own key is shown with. */
export const ownLabel = (id) => `${PROVIDERS[id].label} (your key)`;

/** Manus tasks the app may start, by function. */
const MANUS_FUNCTIONS = new Set(['photos', 'facebook', 'marketResearch']);

export class AIRouter {
  /**
   * tasksFile: where the Manus tasks this app started are remembered (only those can be read or continued).
   * researchTimeoutMs: how long a web research request may take (tests make it short).
   */
  constructor({ store, usage, fetch = globalThis.fetch, baseUrls = {}, adapters = ADAPTERS, tasksFile = '', remote = { enabled: false }, researchTimeoutMs = RESEARCH_TIMEOUT_MS }) {
    this.researchTimeoutMs = researchTimeoutMs;
    this.remote = remote;
    this.taskChain = Promise.resolve();
    this.store = store;
    this.usage = usage;
    this.fetch = fetch;
    this.baseUrls = baseUrls;
    this.adapters = adapters;
    this.jobs = new Map();
    this.watches = new Map(); // job → timer: videos on the owner's keys the server checks on by itself
    this.tasksFile = tasksFile;
    this.manusTasks = new Map();
    try {
      const raw = tasksFile ? JSON.parse(fs.readFileSync(tasksFile, 'utf8')) : null;
      for (const [id, t] of Object.entries(raw?.tasks ?? {})) if (Date.now() - (t.at ?? 0) < TASK_TTL) this.manusTasks.set(id, t);
    } catch {
      /* none yet */
    }
  }

  /** Merge the Manus tasks kept in Supabase into this server's list (started by another copy, or before a restart). */
  async loadTasksRemote() {
    if (!this.remote.enabled) return;
    try {
      const got = await this.remote.get('ai-tasks');
      // (a list saved under another secret can't be read: it's replaced at the next save; tasks expire anyway)
      for (const [id, t] of Object.entries(got?.unreadable ? {} : (got?.value?.tasks ?? {}))) {
        if (!this.manusTasks.has(id) && Date.now() - (t?.at ?? 0) < TASK_TTL) this.manusTasks.set(id, t);
      }
    } catch (e) {
      console.warn(`Manus tasks: ${e.message}`);
    }
  }

  /** Resolves when the task list has been saved to Supabase (never rejects). */
  tasksSaved() {
    return this.taskChain;
  }

  /** Before reading or continuing a task: if this server doesn't know it, look in Supabase. */
  async ensureTask(taskId) {
    if (!this.manusTasks.has(taskId)) await this.loadTasksRemote();
  }

  saveTasks() {
    if (this.remote.enabled) {
      // merge with the list in Supabase, then save it there (one save at a time)
      this.taskChain = this.taskChain.then(async () => {
        try {
          await this.loadTasksRemote();
          for (const [id, t] of this.manusTasks) if (Date.now() - (t.at ?? 0) > TASK_TTL) this.manusTasks.delete(id);
          await this.remote.put('ai-tasks', { tasks: Object.fromEntries(this.manusTasks) });
        } catch (e) {
          console.warn(`Manus tasks: ${e.message}`);
        }
      });
    }
    if (!this.tasksFile) return;
    try {
      fs.mkdirSync(path.dirname(this.tasksFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.tasksFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ tasks: Object.fromEntries(this.manusTasks) }), { mode: 0o600 });
      fs.renameSync(tmp, this.tasksFile);
    } catch (e) {
      console.error('Could not save the Manus task list:', e.message);
    }
  }

  /** Only tasks this app started can be read or continued: the key's other Manus tasks stay private. */
  knownTask(taskId) {
    const t = this.manusTasks.get(taskId);
    if (!t) throw new ProviderError('NOT_FOUND', 'This Manus task wasn’t started by this app.', { status: 404 });
    return t;
  }

  /** What an adapter needs for a key slot; apiKey: a user's own key instead of the owner's (kept only for this call). */
  ctx(id, apiKey = null) {
    const a = adapterId(id);
    const base = String(this.baseUrls[id] || this.baseUrls[a] || this.adapters[a].base).replace(/\/+$/, '');
    return apiKey ? { fetch: this.fetch, base, key: apiKey, label: ownLabel(id) } : { fetch: this.fetch, base, key: this.store.key(id), label: PROVIDERS[id].label };
  }

  /** A user's own keys that can do a kind of work, in routing order (Manus works as tasks, see manusCreate). */
  ownRoute(kind, ownKeys) {
    if (!ownKeys) return [];
    return USER_KEY_PROVIDERS.filter((id) => id !== 'manus' && typeof ownKeys[id] === 'string' && ownKeys[id] && kindDef(id, kind));
  }

  /**
   * The keys a request runs on, in order: the user's own keys that can do it (default model and effort),
   * or else the owner's keys that power the function (their saved model and effort).
   */
  plan(fn, kind, ownKeys = null) {
    const own = this.ownRoute(kind, ownKeys);
    if (own.length) {
      return own.map((id) => {
        const model = kindDef(id, kind).defaultModel;
        return { id, key: ownKeys[id], model, effort: defaultEffort(id, kind, model), own: true };
      });
    }
    let route = this.store.route(fn);
    if (kind === 'image') route = route.filter((id) => id !== 'manus');
    return route.map((id) => {
      const s = this.store.settings(id);
      return { id, key: null, model: s.models[kind], effort: s.effort[kind], own: false };
    });
  }

  /** Mark what a user's own key served (shown and logged as "<Provider> (your key)"). */
  ownMeta(meta, step) {
    if (step.own) {
      meta.providerLabel = ownLabel(step.id);
      meta.ownKey = true;
    }
    return meta;
  }

  ownExtra(step) {
    return step.own ? { ownKey: true, providerLabel: ownLabel(step.id) } : {};
  }

  /**
   * What a request on the owner's keys will likely cost (the most expensive key it could run on),
   * for the daily dollar limit. Videos: the price per second at the key's effort, times the length.
   * Web research (research: { maxSearches }): a research-sized request plus its searches at list price.
   */
  estimate(kind, { fn = kind === 'video' ? 'videos' : kind === 'image' ? 'photos' : '', duration = 8, research = null } = {}) {
    let route = fn ? this.store.route(fn) : [];
    if (kind === 'image') route = route.filter((id) => id !== 'manus');
    const searching = kind === 'text' && !!research;
    let best = 0;
    for (const id of route) {
      const s = this.store.settings(id);
      const model = s.models?.[kind];
      let usd = null;
      if (kind === 'video') usd = estimateCost(id, 'video', model, null, { seconds: duration, effort: s.effort?.[kind] }) ?? FALLBACK_ESTIMATE.videoPerSecond * duration;
      else if (kind === 'image') usd = estimateCost(id, 'image', model, null) ?? FALLBACK_ESTIMATE.image;
      else if (searching && canResearch(id, model)) usd = (estimateCost(id, 'text', model, RESEARCH_TOKENS) ?? RESEARCH_FALLBACK) + searchPrice(id) * research.maxSearches;
      else usd = FALLBACK_ESTIMATE.text;
      best = Math.max(best, usd);
    }
    if (!route.length) best = kind === 'video' ? FALLBACK_ESTIMATE.videoPerSecond * duration : searching ? RESEARCH_FALLBACK + 0.01 * research.maxSearches : FALLBACK_ESTIMATE[kind] ?? 0;
    return round6(best);
  }

  /** The adapter for a key slot (extra OpenRouter slots use OpenRouter's). */
  adapter(id) {
    return this.adapters[adapterId(id)];
  }

  noProvider(fn) {
    const label = fnById[fn]?.label ?? fn;
    return new ProviderError('NO_PROVIDER', `No API key powers ${label} yet. Add one in Settings → AI and tick ${label} in its “Powers” list.`, { status: 409 });
  }

  /**
   * What served a request, with the effort it ran at and what it used. searches: web searches it ran;
   * without a cost from the provider, they're added to the estimate at the list price.
   */
  describe(id, kind, fn, { model, effort, ms, usage, cost, credits, params, note, searches = 0 }) {
    const k = kindDef(id, kind);
    const tokenUsd = cost == null && usage ? estimateCost(id, kind, model, usage) : null;
    const searchUsd = cost == null && searches > 0 ? searches * searchPrice(id) : 0;
    const estimate = tokenUsd == null && !searchUsd ? null : (tokenUsd ?? 0) + searchUsd;
    const usd = cost ?? estimate;
    return {
      provider: id,
      providerLabel: PROVIDERS[id].label,
      fn,
      kind,
      model,
      effort: effort || '',
      effortLabel: effort ? effortLabel(id, kind, effort) : 'Set by the model',
      effortField: k?.field || '',
      ms,
      usage: usage ? { input: usage.input ?? 0, output: usage.output ?? 0, reasoning: usage.reasoning ?? null } : null,
      ...(searches ? { searches } : {}),
      cost: usd != null ? { usd: round6(usd), source: cost != null ? 'provider' : 'estimate' } : null,
      credits: credits ?? null,
      params: params ?? null,
      note: note || '',
    };
  }

  /** Logs what a request used (never its sources or queries: the log is synced and holds no research). */
  log(meta, extra = {}) {
    const { provider, fn, kind, model, effort, ms, usage, cost, credits } = meta;
    return this.usage.add({ ok: true, provider, fn, kind, model, effort, ms, usage, cost, credits, searches: meta.searches ?? 0, ...extra });
  }

  logFailure(id, kind, fn, model, effort, t0, err, extra = {}) {
    this.usage.add({ ok: false, provider: id, fn, kind, model, effort, ms: Date.now() - t0, code: err.code, error: err.message, ...extra });
  }

  // ───────────── writing ─────────────

  /**
   * research: { maxSearches, location } (research.mjs researchFromBody) asks the key to search the web.
   * Keys that can search go first; the reply's meta then says what the searches found (meta.research).
   */
  async text(fn, { prompt, images = [], tier = 'default', signal, brain = null, userId = null, ownKeys = null, meter = null, research = null }) {
    if (fnById[fn]?.kind !== 'text') throw new ProviderError('BAD_REQUEST', 'Unknown AI function.', { status: 400 });
    let route = this.plan(fn, 'text', ownKeys);
    if (!route.length) throw this.noProvider(fn);
    if (research) {
      // keys that can search go first, in their order; the others stay after them
      const can = route.filter((s) => canResearch(s.id, s.model));
      route = [...can, ...route.filter((s) => !can.includes(s))];
    }
    const flag = research ? { research: true } : {};
    const attempts = [];
    let last = null;
    for (const step of route) {
      const { id, model, effort } = step;
      const web = research && canResearch(id, model) ? research : null;
      const t0 = Date.now();
      try {
        meter?.start?.();
        const r = await this.adapter(id).text(this.ctx(id, step.key), { model, effort, system: SYSTEM, prompt, images, tier, signal, ...(web ? { research: web, timeoutMs: this.researchTimeoutMs } : {}) });
        const meta = this.ownMeta(this.describe(id, 'text', fn, { model: r.model || model, effort, ms: Date.now() - t0, usage: r.usage, cost: r.cost, credits: r.credits, searches: web ? (r.research?.searches ?? 0) : 0 }), step);
        if (research) {
          meta.research = researchMeta(!!web, web ? (r.research ?? {}) : {});
          meta.searches = meta.research.searches;
        }
        if (attempts.length) meta.attempts = attempts;
        this.log(meta, { brain, userId, ...this.ownExtra(step), ...flag });
        meter?.cost?.(meta.cost?.usd);
        return { text: r.text, meta };
      } catch (e) {
        last = asProviderError(e, step.own ? ownLabel(id) : PROVIDERS[id].label);
        this.logFailure(id, 'text', fn, model, effort, t0, last, { brain, userId, ...this.ownExtra(step), ...flag });
        attempts.push({ provider: id, providerLabel: step.own ? ownLabel(id) : PROVIDERS[id].label, code: last.code, error: last.message });
        // a key asked to search may have run (and billed) searches: move on only if it certainly started nothing
        const next = web ? last.notStarted && !['CONTENT_POLICY', 'REFUSAL', 'ABORTED'].includes(last.code) : canFallBack(last, 'text');
        if (!next || signal?.aborted) break;
      }
    }
    last.attempts = attempts;
    throw last;
  }

  // ───────────── photos ─────────────

  /** One photo from the first key that can make it. Manus works as a task instead (see manusCreate). */
  async image({ prompt, aspect, signal, userId = null, ownKeys = null, meter = null }) {
    const fn = 'photos';
    const route = this.plan(fn, 'image', ownKeys);
    if (!route.length) {
      if (this.store.powers('manus', fn)) throw new ProviderError('USE_AGENT', 'Manus makes your photos: the app starts a Manus task.', { status: 409 });
      throw this.noProvider(fn);
    }
    const attempts = [];
    let last = null;
    for (const step of route) {
      const { id, model, effort } = step;
      const t0 = Date.now();
      try {
        meter?.start?.();
        const r = await this.adapter(id).image(this.ctx(id, step.key), { model, effort, prompt, aspect, signal });
        const meta = this.ownMeta(this.describe(id, 'image', fn, { model: r.model || model, effort, ms: Date.now() - t0, usage: r.usage, cost: r.cost, credits: r.credits, params: r.params }), step);
        if (attempts.length) meta.attempts = attempts;
        if (r.dropped?.length) meta.note = `${PROVIDERS[id].label} didn’t accept ${r.dropped.join(', ')}, so it was left out.`;
        this.log(meta, { userId, ...this.ownExtra(step) });
        meter?.cost?.(meta.cost?.usd);
        return { bytes: r.bytes, contentType: r.contentType, revisedPrompt: r.revisedPrompt || '', meta };
      } catch (e) {
        last = asProviderError(e, step.own ? ownLabel(id) : PROVIDERS[id].label);
        this.logFailure(id, 'image', fn, model, effort, t0, last, { userId, ...this.ownExtra(step) });
        attempts.push({ provider: id, providerLabel: step.own ? ownLabel(id) : PROVIDERS[id].label, code: last.code, error: last.message });
        if (!canFallBack(last, 'image') || signal?.aborted) break;
      }
    }
    last.attempts = attempts;
    throw last;
  }

  // ───────────── videos (jobs) ─────────────

  pruneJobs(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      if (now - job.createdAt > JOB_TTL) this.jobs.delete(id);
      // finished files are kept for an hour after they were collected
      else if (job.bytes && job.collectedAt && now - job.collectedAt > 3600_000) job.bytes = null;
    }
    while (this.jobs.size > MAX_JOBS) this.jobs.delete(this.jobs.keys().next().value);
  }

  jobView(job) {
    const meta = this.describe(job.provider, 'video', 'videos', {
      model: job.model,
      effort: job.effort,
      ms: (job.finishedAt || Date.now()) - job.createdAt,
      usage: job.tokens ?? null,
      cost: job.cost ?? null,
      params: job.params,
      note: job.note,
    });
    if (meta.cost == null && job.state === 'done') {
      const est = estimateCost(job.provider, 'video', job.model, null, { seconds: job.seconds || job.params?.duration, effort: job.effort });
      if (est != null) meta.cost = { usd: round6(est), source: 'estimate' };
    }
    if (job.attempts?.length) meta.attempts = job.attempts;
    if (job.ownKey) this.ownMeta(meta, { id: job.provider, own: true });
    return { id: job.id, state: job.state, progress: job.progress ?? null, error: job.error || '', meta };
  }

  finishJob(job, patch) {
    Object.assign(job, patch, { finishedAt: Date.now() });
    const view = this.jobView(job);
    this.usage.update(job.usageId, { ok: job.state === 'done', pending: false, ms: view.meta.ms, cost: view.meta.cost, usage: view.meta.usage, ...(job.error ? { error: job.error } : {}) });
    this.unwatch(job);
    // the cost counts toward the user's day once it's known (only once, kept in memory with the job);
    // null when it isn't known
    const onFinished = job.onFinished;
    job.onFinished = null;
    if (onFinished) {
      try {
        onFinished(view.meta.cost?.usd ?? null, job);
      } catch (e) {
        console.warn(`Video job: ${e.message}`);
      }
    }
  }

  /**
   * owner: the user who started it (only they, or the admin, may follow it). A job started with their
   * own key remembers only that it was (ownKey): the key is looked up again by owner to poll and collect.
   * onFinished(usd, job): called once when the job finishes, with its cost (null when unknown). A job on
   * the owner's keys that has to be polled is checked by the server too, so it finishes (and its cost
   * is counted) even if nobody asks about it.
   */
  async startVideo({ prompt, aspect = '9:16', duration = 8, firstFrame = null, signal, owner = null, ownKeys = null, meter = null, onFinished = null }) {
    const fn = 'videos';
    let route = this.plan(fn, 'video', ownKeys);
    if (!route.length) throw this.noProvider(fn);
    // keys whose video model can make this shape go first
    const fits = route.filter((step) => (kindDef(step.id, 'video')?.aspects ?? []).includes(aspect));
    route = [...fits, ...route.filter((step) => !fits.includes(step))];
    const attempts = [];
    let last = null;
    for (const step of route) {
      const { id, model, effort } = step;
      const t0 = Date.now();
      try {
        meter?.start?.();
        const started = await this.adapter(id).video.start(this.ctx(id, step.key), { model, effort, prompt, aspect, duration, firstFrame, signal });
        const job = {
          id: `vid_${crypto.randomUUID()}`,
          provider: id,
          model,
          effort,
          createdAt: t0,
          upstreamId: started.upstreamId,
          pollingUrl: started.pollingUrl || '',
          params: started.params ?? null,
          note: [started.note, fits.includes(step) ? '' : `${PROVIDERS[id].label} can’t make ${aspect} videos, so it used its nearest shape.`].filter(Boolean).join(' '),
          state: 'running',
          attempts,
          owner,
          ...(step.own ? { ownKey: true } : {}),
          onFinished,
        };
        job.usageId = this.usage.add({ ok: true, pending: true, provider: id, fn, kind: 'video', model, effort, ms: 0, userId: owner, ...this.ownExtra(step) });
        if (started.run) {
          // providers that answer in one long call: the job finishes when the call does
          started.run.then(
            (out) => this.finishJob(job, { state: 'done', bytes: out.bytes, contentType: out.contentType, tokens: out.usage ? { input: out.usage.input, output: out.usage.output, reasoning: out.usage.reasoning } : null }),
            (err) => this.finishJob(job, { state: 'failed', error: asProviderError(err, PROVIDERS[id].label).message }),
          );
        }
        this.jobs.set(job.id, job);
        this.pruneJobs();
        if (!started.run && onFinished && !step.own) this.watchJob(job);
        return this.jobView(job);
      } catch (e) {
        last = asProviderError(e, step.own ? ownLabel(id) : PROVIDERS[id].label);
        this.logFailure(id, 'video', fn, model, effort, t0, last, { userId: owner, ...this.ownExtra(step) });
        attempts.push({ provider: id, providerLabel: step.own ? ownLabel(id) : PROVIDERS[id].label, code: last.code, error: last.message });
        if (!canFallBack(last, 'video') || signal?.aborted) break;
      }
    }
    last.attempts = attempts;
    throw last;
  }

  /** Checks on a job in the background until it finishes (or is too old, or is dropped). */
  watchJob(job) {
    if (!this.adapter(job.provider).video?.status) return;
    const timer = setInterval(() => {
      if (job.state !== 'running' || this.jobs.get(job.id) !== job || Date.now() - job.createdAt > JOB_TTL) {
        this.unwatch(job);
        // dropped or too old without an answer: count what's known
        if (job.state === 'running' && job.onFinished) {
          const f = job.onFinished;
          job.onFinished = null;
          try {
            f(null, job);
          } catch {
            /* nothing to do */
          }
        }
        return;
      }
      this.videoStatus(job.id).catch(() => {});
    }, WATCH_MS);
    timer.unref?.();
    this.watches.set(job, timer);
  }

  unwatch(job) {
    const timer = this.watches.get(job);
    if (timer) clearInterval(timer);
    this.watches.delete(job);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new ProviderError('NOT_FOUND', 'This video job isn’t on the server any more (the server may have restarted). Start the video again.', { status: 404 });
    return job;
  }

  /** The key a job is followed with: the owner's, or (ownKey jobs) the user's own key, passed in as apiKey. */
  jobCtx(job, apiKey) {
    if (!job.ownKey) return this.ctx(job.provider);
    if (!apiKey) throw new ProviderError('OWN_KEY_NEEDED', `The ${PROVIDERS[job.provider].label} key this video was started with was removed. Add it again in Settings → AI.`, { status: 409 });
    return this.ctx(job.provider, apiKey);
  }

  async videoStatus(jobId, { signal, apiKey = null } = {}) {
    const job = this.getJob(jobId);
    const adapter = this.adapter(job.provider).video;
    if (job.state === 'running' && adapter.status && Date.now() - (job.checkedAt || 0) > 2500) {
      const ctx = this.jobCtx(job, apiKey);
      job.checkedAt = Date.now();
      try {
        const s = await adapter.status(ctx, job, { signal });
        job.failures = 0;
        if (s.state === 'done') this.finishJob(job, { state: 'done', url: s.url, cost: s.cost ?? job.cost, seconds: s.seconds ?? job.seconds });
        else if (s.state === 'failed') this.finishJob(job, { state: 'failed', error: s.error, cost: s.cost ?? job.cost });
        else job.progress = s.progress ?? job.progress;
      } catch (e) {
        const err = asProviderError(e, PROVIDERS[job.provider].label);
        if (err.code === 'ABORTED') throw err;
        // a status read is safe to repeat: give up only after several failures in a row
        job.failures = (job.failures || 0) + 1;
        if (job.failures >= 6 || err.code === 'AUTH') this.finishJob(job, { state: 'failed', error: err.message });
      }
    }
    return this.jobView(job);
  }

  async videoContent(jobId, { signal, apiKey = null } = {}) {
    const job = this.getJob(jobId);
    if (job.state !== 'done') throw new ProviderError('NOT_READY', 'The video isn’t ready yet.', { status: 409 });
    if (!job.bytes) {
      const out = await this.adapter(job.provider).video.content(this.jobCtx(job, apiKey), job, { signal });
      job.bytes = out.bytes;
      job.contentType = out.contentType;
    }
    job.collectedAt = Date.now();
    return { bytes: job.bytes, contentType: job.contentType || 'video/mp4' };
  }

  // ───────────── Manus tasks (photos, Facebook posts and deep research) ─────────────

  /** The owner's Manus key, or a user's own (apiKey): their task runs in their Manus account. */
  manusCtx(apiKey) {
    return apiKey ? { ...this.ctx('manus'), key: apiKey, label: 'Manus (your key)' } : this.ctx('manus');
  }

  /**
   * Deep research (fn 'marketResearch'): the prompt is the server's fixed template (marketResearch.mjs);
   * it never asks questions, stays in the task list, fills in the research schema and runs without the
   * account's connected apps.
   */
  async manusCreate({ fn, prompt, title, interactive, hidden, image, files = [], signal, owner = null, apiKey = null }) {
    const kind = fnById[fn]?.kind;
    if (!MANUS_FUNCTIONS.has(fn)) throw new ProviderError('BAD_REQUEST', 'Unknown Manus task.', { status: 400 });
    if (!apiKey && !this.store.powers('manus', fn)) throw new ProviderError('NO_PROVIDER', `Your Manus key isn’t set to power ${fnById[fn].label}. Turn it on in Settings → AI.`, { status: 409 });
    const profile = this.store.settings('manus').effort[kind];
    const research = fn === 'marketResearch';
    const task = research ? { interactive: false, hidden: false, image: null, files: [], structuredOutputSchema: MARKET_RESEARCH_SCHEMA, clearConnectors: true } : { interactive, hidden, image, files };
    const t0 = Date.now();
    try {
      const out = await this.adapters.manus.create(this.manusCtx(apiKey), { prompt, title, profile, ...task, signal });
      const meta = this.describe('manus', kind, fn, { model: 'manus', effort: profile, ms: Date.now() - t0 });
      if (apiKey) meta.providerLabel = 'Manus (your key)';
      const usageId = this.usage.add({ ok: true, pending: true, provider: 'manus', fn, kind, model: 'manus', effort: profile, ms: meta.ms, taskId: out.task_id, userId: owner, ...(apiKey ? { ownKey: true } : {}) });
      this.manusTasks.set(out.task_id, { usageId, fn, kind, profile, at: Date.now(), owner, ...(apiKey ? { ownKey: true } : {}) });
      for (const [id, t] of this.manusTasks) if (Date.now() - (t.at ?? 0) > TASK_TTL) this.manusTasks.delete(id);
      this.saveTasks();
      return { ...out, meta };
    } catch (e) {
      const err = asProviderError(e, 'Manus');
      this.logFailure('manus', kind, fn, 'manus', profile, t0, err, { userId: owner });
      throw err;
    }
  }

  async manusOutput({ taskId, maxImages, maxImageBytes, signal, apiKey = null }) {
    const t = this.knownTask(taskId);
    const out = await this.adapters.manus.output(this.manusCtx(apiKey), { taskId, maxImages, maxImageBytes, signal });
    this.usage.update(t.usageId, { credits: out.credit_usage || null, pending: !out.done, ok: out.status !== 'error' });
    out.meta = this.describe('manus', t.kind, t.fn, { model: 'manus', effort: t.profile, ms: 0, credits: out.credit_usage || null });
    // a deep research report, checked and capped (the raw structured output never goes to the app)
    if (t.fn === 'marketResearch' && out.done) out.research = parseMarketResearch(out.text, out.structured_output);
    delete out.structured_output;
    return out;
  }

  async manusContinue({ taskId, prompt, signal, apiKey = null }) {
    this.knownTask(taskId);
    return this.adapters.manus.send(this.manusCtx(apiKey), { taskId, prompt, signal });
  }

  /** Upload a file to the Manus account behind this key (the owner's, or a user's own). */
  async manusUpload({ filename, size, body, signal, apiKey = null }) {
    if (!apiKey && !this.store.powers('manus', 'facebook') && !this.store.powers('manus', 'photos')) throw new ProviderError('NO_PROVIDER', 'Your Manus key is off, or isn’t set to power Social posting. Turn it on in Settings → AI.', { status: 409 });
    return this.adapters.manus.uploadFile(this.manusCtx(apiKey), { filename, size, body, signal });
  }

  /** A free check of a user's own Manus key (lists one task). */
  async checkManusKey(apiKey, { signal } = {}) {
    await this.adapters.manus.check(this.manusCtx(apiKey), { signal });
  }

  /**
   * A free check of a user's own key for any provider. Throws if it fails. Providers whose model list
   * answers without a key (OpenRouter) are checked with an authenticated call (checkAuth) instead.
   */
  async checkOwnKey(id, apiKey, { signal } = {}) {
    if (!PROVIDERS[id] || !apiKey) throw new ProviderError('BAD_REQUEST', 'Unknown provider.', { status: 400 });
    const a = this.adapter(id);
    const ctx = this.ctx(id, apiKey);
    if (a.check) return void (await a.check(ctx, { signal }));
    if (a.checkAuth) return void (await a.checkAuth(ctx, { signal }));
    await a.listModels(ctx, Object.keys(PROVIDERS[id].kinds)[0], { signal });
  }

  // ───────────── settings helpers ─────────────

  /** A free check that a key works (lists its models; Manus lists one task). */
  async checkKey(id, { signal } = {}) {
    if (!this.store.key(id)) return { ok: false, code: 'NO_KEY', error: 'Add an API key first.' };
    const a = this.adapter(id);
    try {
      if (a.check) {
        await a.check(this.ctx(id), { signal });
        return { ok: true, message: `${PROVIDERS[id].label} accepted the key.` };
      }
      const kind = Object.keys(PROVIDERS[id].kinds)[0];
      // a public model list says nothing about the key: check it first
      if (a.checkAuth) await a.checkAuth(this.ctx(id), { signal });
      const ids = await a.listModels(this.ctx(id), kind, { signal });
      const model = this.store.settings(id).models[kind];
      const listed = !ids.length || ids.includes(model);
      return { ok: true, message: listed ? `Key works, and ${model} is available.` : `Key works, but ${model} isn’t in this account’s model list. Pick another model.`, modelListed: listed };
    } catch (e) {
      const err = asProviderError(e, PROVIDERS[id].label);
      return { ok: false, code: err.code, error: err.message };
    }
  }

  /** Models for a kind: the built-in list, plus whatever the key's account offers. */
  async models(id, kind, { signal } = {}) {
    const k = kindDef(id, kind);
    if (!k) return { models: [], source: 'builtin' };
    const builtin = k.models.map((x) => ({ id: x.id, label: x.label }));
    if (!this.store.key(id) || !this.adapter(id).listModels) return { models: builtin, source: 'builtin' };
    try {
      const ids = await this.adapter(id).listModels(this.ctx(id), kind, { signal });
      const known = new Set(builtin.map((b) => b.id));
      const extra = ids.filter((x) => !known.has(x)).sort().slice(0, 600).map((x) => ({ id: x, label: x }));
      return { models: [...builtin.map((b) => ({ ...b, available: !ids.length || ids.includes(b.id) })), ...extra], source: 'live' };
    } catch (e) {
      return { models: builtin, source: 'builtin', error: asProviderError(e, PROVIDERS[id].label).message };
    }
  }

  /** Run the same short prompt at each effort, to show what effort does to tokens and cost (paid). */
  async compareEfforts(id, efforts, { signal } = {}) {
    if (!kindDef(id, 'text')) throw new ProviderError('BAD_REQUEST', `${PROVIDERS[id].label} doesn’t write text.`, { status: 400 });
    if (!this.store.key(id)) throw new ProviderError('NO_KEY', 'Add an API key first.', { status: 400 });
    const model = this.store.settings(id).models.text;
    const allowed = effortIds(id, 'text', model);
    let pick = (Array.isArray(efforts) ? efforts : []).filter((e) => allowed.includes(e));
    if (!pick.length) pick = [allowed[0], allowed[allowed.length - 1]];
    pick = [...new Set(pick.filter(Boolean))].slice(0, 3);
    if (!pick.length) throw new ProviderError('BAD_REQUEST', `${model} has no effort setting to compare.`, { status: 400 });
    const results = [];
    for (const effort of pick) {
      const t0 = Date.now();
      try {
        const r = await this.adapter(id).text(this.ctx(id), { model, effort, system: SYSTEM, prompt: COMPARE_PROMPT, images: [], tier: 'quick', signal });
        const meta = this.describe(id, 'text', 'test', { model: r.model || model, effort, ms: Date.now() - t0, usage: r.usage, cost: r.cost, credits: r.credits });
        this.log(meta);
        results.push({ effort, effortLabel: meta.effortLabel, ok: true, ms: meta.ms, usage: meta.usage, cost: meta.cost, answer: r.text.trim().slice(0, 240) });
      } catch (e) {
        const err = asProviderError(e, PROVIDERS[id].label);
        this.logFailure(id, 'text', 'test', model, effort, t0, err);
        results.push({ effort, effortLabel: effortLabel(id, 'text', effort), ok: false, code: err.code, error: err.message });
        if (err.code === 'ABORTED') break;
      }
    }
    return { provider: id, model, field: kindDef(id, 'text').field, results };
  }
}
