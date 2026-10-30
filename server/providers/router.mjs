// Sends each AI request to the keys that power its function, in priority order, with each key's
// own model and effort, and records what it cost.
//
// Falling back to the next key: writing and photos move on after any provider failure except a
// content-policy block or refusal (the same request would fail elsewhere too). Videos and agent
// tasks are paid jobs, so they move on only when the provider certainly started nothing.

import crypto from 'node:crypto';
import { PROVIDERS, effortIds, effortLabel, estimateCost, fnById, kindDef } from './registry.mjs';
import { ProviderError } from './http.mjs';
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

export class AIRouter {
  constructor({ store, usage, fetch = globalThis.fetch, baseUrls = {}, adapters = ADAPTERS }) {
    this.store = store;
    this.usage = usage;
    this.fetch = fetch;
    this.baseUrls = baseUrls;
    this.adapters = adapters;
    this.jobs = new Map();
    this.manusTasks = new Map();
  }

  ctx(id) {
    return { fetch: this.fetch, base: String(this.baseUrls[id] || this.adapters[id].base).replace(/\/+$/, ''), key: this.store.key(id), label: PROVIDERS[id].label };
  }

  noProvider(fn) {
    const label = fnById[fn]?.label ?? fn;
    return new ProviderError('NO_PROVIDER', `No API key powers ${label} yet. Add one in Settings → AI and tick ${label} in its “Powers” list.`, { status: 409 });
  }

  /** What served a request, with the effort it ran at and what it used. */
  describe(id, kind, fn, { model, effort, ms, usage, cost, credits, params, note }) {
    const k = kindDef(id, kind);
    const estimate = cost == null && usage ? estimateCost(id, kind, model, usage) : null;
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
      cost: usd != null ? { usd: round6(usd), source: cost != null ? 'provider' : 'estimate' } : null,
      credits: credits ?? null,
      params: params ?? null,
      note: note || '',
    };
  }

  log(meta, extra = {}) {
    const { provider, fn, kind, model, effort, ms, usage, cost, credits } = meta;
    return this.usage.add({ ok: true, provider, fn, kind, model, effort, ms, usage, cost, credits, ...extra });
  }

  logFailure(id, kind, fn, model, effort, t0, err, extra = {}) {
    this.usage.add({ ok: false, provider: id, fn, kind, model, effort, ms: Date.now() - t0, code: err.code, error: err.message, ...extra });
  }

  // ───────────── writing ─────────────

  async text(fn, { prompt, images = [], tier = 'default', signal, brain = null }) {
    if (fnById[fn]?.kind !== 'text') throw new ProviderError('BAD_REQUEST', 'Unknown AI function.', { status: 400 });
    const route = this.store.route(fn);
    if (!route.length) throw this.noProvider(fn);
    const attempts = [];
    let last = null;
    for (const id of route) {
      const s = this.store.settings(id);
      const model = s.models.text;
      const effort = s.effort.text;
      const t0 = Date.now();
      try {
        const r = await this.adapters[id].text(this.ctx(id), { model, effort, system: SYSTEM, prompt, images, tier, signal });
        const meta = this.describe(id, 'text', fn, { model: r.model || model, effort, ms: Date.now() - t0, usage: r.usage, cost: r.cost, credits: r.credits });
        if (attempts.length) meta.attempts = attempts;
        this.log(meta, { brain });
        return { text: r.text, meta };
      } catch (e) {
        last = asProviderError(e, PROVIDERS[id].label);
        this.logFailure(id, 'text', fn, model, effort, t0, last, { brain });
        attempts.push({ provider: id, providerLabel: PROVIDERS[id].label, code: last.code, error: last.message });
        if (!canFallBack(last, 'text') || signal?.aborted) break;
      }
    }
    last.attempts = attempts;
    throw last;
  }

  // ───────────── photos ─────────────

  /** One photo from the first key that can make it. Manus works as a task instead (see manusCreate). */
  async image({ prompt, aspect, signal }) {
    const fn = 'photos';
    const route = this.store.route(fn).filter((id) => id !== 'manus');
    if (!route.length) {
      if (this.store.powers('manus', fn)) throw new ProviderError('USE_AGENT', 'Manus makes your photos: the app starts a Manus task.', { status: 409 });
      throw this.noProvider(fn);
    }
    const attempts = [];
    let last = null;
    for (const id of route) {
      const s = this.store.settings(id);
      const model = s.models.image;
      const effort = s.effort.image;
      const t0 = Date.now();
      try {
        const r = await this.adapters[id].image(this.ctx(id), { model, effort, prompt, aspect, signal });
        const meta = this.describe(id, 'image', fn, { model: r.model || model, effort, ms: Date.now() - t0, usage: r.usage, cost: r.cost, credits: r.credits, params: r.params });
        if (attempts.length) meta.attempts = attempts;
        if (r.dropped?.length) meta.note = `${PROVIDERS[id].label} didn’t accept ${r.dropped.join(', ')}, so it was left out.`;
        this.log(meta);
        return { bytes: r.bytes, contentType: r.contentType, revisedPrompt: r.revisedPrompt || '', meta };
      } catch (e) {
        last = asProviderError(e, PROVIDERS[id].label);
        this.logFailure(id, 'image', fn, model, effort, t0, last);
        attempts.push({ provider: id, providerLabel: PROVIDERS[id].label, code: last.code, error: last.message });
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
    return { id: job.id, state: job.state, progress: job.progress ?? null, error: job.error || '', meta };
  }

  finishJob(job, patch) {
    Object.assign(job, patch, { finishedAt: Date.now() });
    const view = this.jobView(job);
    this.usage.update(job.usageId, { ok: job.state === 'done', pending: false, ms: view.meta.ms, cost: view.meta.cost, usage: view.meta.usage, ...(job.error ? { error: job.error } : {}) });
  }

  async startVideo({ prompt, aspect = '9:16', duration = 8, firstFrame = null, signal }) {
    const fn = 'videos';
    let route = this.store.route(fn);
    if (!route.length) throw this.noProvider(fn);
    // keys whose video model can make this shape go first
    const fits = route.filter((id) => (kindDef(id, 'video')?.aspects ?? []).includes(aspect));
    route = [...fits, ...route.filter((id) => !fits.includes(id))];
    const attempts = [];
    let last = null;
    for (const id of route) {
      const s = this.store.settings(id);
      const model = s.models.video;
      const effort = s.effort.video;
      const t0 = Date.now();
      try {
        const started = await this.adapters[id].video.start(this.ctx(id), { model, effort, prompt, aspect, duration, firstFrame, signal });
        const job = {
          id: `vid_${crypto.randomUUID()}`,
          provider: id,
          model,
          effort,
          createdAt: t0,
          upstreamId: started.upstreamId,
          pollingUrl: started.pollingUrl || '',
          params: started.params ?? null,
          note: [started.note, fits.includes(id) ? '' : `${PROVIDERS[id].label} can’t make ${aspect} videos, so it used its nearest shape.`].filter(Boolean).join(' '),
          state: 'running',
          attempts,
        };
        job.usageId = this.usage.add({ ok: true, pending: true, provider: id, fn, kind: 'video', model, effort, ms: 0 });
        if (started.run) {
          // providers that answer in one long call: the job finishes when the call does
          started.run.then(
            (out) => this.finishJob(job, { state: 'done', bytes: out.bytes, contentType: out.contentType, tokens: out.usage ? { input: out.usage.input, output: out.usage.output, reasoning: out.usage.reasoning } : null }),
            (err) => this.finishJob(job, { state: 'failed', error: asProviderError(err, PROVIDERS[id].label).message }),
          );
        }
        this.jobs.set(job.id, job);
        this.pruneJobs();
        return this.jobView(job);
      } catch (e) {
        last = asProviderError(e, PROVIDERS[id].label);
        this.logFailure(id, 'video', fn, model, effort, t0, last);
        attempts.push({ provider: id, providerLabel: PROVIDERS[id].label, code: last.code, error: last.message });
        if (!canFallBack(last, 'video') || signal?.aborted) break;
      }
    }
    last.attempts = attempts;
    throw last;
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new ProviderError('NOT_FOUND', 'This video job isn’t on the server any more (the server may have restarted). Start the video again.', { status: 404 });
    return job;
  }

  async videoStatus(jobId, { signal } = {}) {
    const job = this.getJob(jobId);
    const adapter = this.adapters[job.provider].video;
    if (job.state === 'running' && adapter.status && Date.now() - (job.checkedAt || 0) > 2500) {
      job.checkedAt = Date.now();
      try {
        const s = await adapter.status(this.ctx(job.provider), job, { signal });
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

  async videoContent(jobId, { signal } = {}) {
    const job = this.getJob(jobId);
    if (job.state !== 'done') throw new ProviderError('NOT_READY', 'The video isn’t ready yet.', { status: 409 });
    if (!job.bytes) {
      const out = await this.adapters[job.provider].video.content(this.ctx(job.provider), job, { signal });
      job.bytes = out.bytes;
      job.contentType = out.contentType;
    }
    job.collectedAt = Date.now();
    return { bytes: job.bytes, contentType: job.contentType || 'video/mp4' };
  }

  // ───────────── Manus tasks (photos and Facebook scheduling) ─────────────

  async manusCreate({ fn, prompt, title, interactive, hidden, image, signal }) {
    const kind = fnById[fn]?.kind;
    if (fn !== 'photos' && fn !== 'facebook') throw new ProviderError('BAD_REQUEST', 'Unknown Manus task.', { status: 400 });
    if (!this.store.powers('manus', fn)) throw new ProviderError('NO_PROVIDER', `Your Manus key isn’t set to power ${fnById[fn].label}. Turn it on in Settings → AI.`, { status: 409 });
    const profile = this.store.settings('manus').effort[kind];
    const t0 = Date.now();
    try {
      const out = await this.adapters.manus.create(this.ctx('manus'), { prompt, title, profile, interactive, hidden, image, signal });
      const meta = this.describe('manus', kind, fn, { model: 'manus', effort: profile, ms: Date.now() - t0 });
      const usageId = this.usage.add({ ok: true, pending: true, provider: 'manus', fn, kind, model: 'manus', effort: profile, ms: meta.ms, taskId: out.task_id });
      this.manusTasks.set(out.task_id, { usageId, fn, kind, profile });
      return { ...out, meta };
    } catch (e) {
      const err = asProviderError(e, 'Manus');
      this.logFailure('manus', kind, fn, 'manus', profile, t0, err);
      throw err;
    }
  }

  async manusOutput({ taskId, maxImages, maxImageBytes, signal }) {
    const out = await this.adapters.manus.output(this.ctx('manus'), { taskId, maxImages, maxImageBytes, signal });
    const t = this.manusTasks.get(taskId);
    if (t) {
      this.usage.update(t.usageId, { credits: out.credit_usage || null, pending: !out.done, ok: out.status !== 'error' });
      out.meta = this.describe('manus', t.kind, t.fn, { model: 'manus', effort: t.profile, ms: 0, credits: out.credit_usage || null });
    }
    return out;
  }

  async manusContinue({ taskId, prompt, signal }) {
    return this.adapters.manus.send(this.ctx('manus'), { taskId, prompt, signal });
  }

  // ───────────── settings helpers ─────────────

  /** A free check that a key works (lists its models; Manus lists one task). */
  async checkKey(id, { signal } = {}) {
    if (!this.store.key(id)) return { ok: false, code: 'NO_KEY', error: 'Add an API key first.' };
    const a = this.adapters[id];
    try {
      if (a.check) {
        await a.check(this.ctx(id), { signal });
        return { ok: true, message: `${PROVIDERS[id].label} accepted the key.` };
      }
      const kind = Object.keys(PROVIDERS[id].kinds)[0];
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
    if (!this.store.key(id) || !this.adapters[id].listModels) return { models: builtin, source: 'builtin' };
    try {
      const ids = await this.adapters[id].listModels(this.ctx(id), kind, { signal });
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
        const r = await this.adapters[id].text(this.ctx(id), { model, effort, system: SYSTEM, prompt: COMPARE_PROMPT, images: [], tier: 'quick', signal });
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
