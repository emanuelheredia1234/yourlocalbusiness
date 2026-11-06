import type { Project } from '@/lib/types';
import { NO_AI_SERVER, getSample, useRuntime, type AIServerState, type ClaudeImageLimits, type SampleError, type SampleOptions } from '@/lib/platform';
import { readFileAsDataURL, uid } from '@/lib/utils';
import { FORMATS } from './knowledge';
import { isAIMeta, type AIMeta } from './meta';
import { authHeaders } from '@/lib/cloud/auth';
import { safeStorage } from '@/lib/storage';
import type { AgentReady, AgentsHealth } from '@/lib/agentTypes';

// ───────────────────────── Transport ─────────────────────────

export type Tier = 'quick' | 'default';

export class AIError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly partial?: string,
  ) {
    super(message);
  }
}

export interface CallOptions {
  tier: Tier;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  images?: Blob[];
}

/** Images per request to your server (it keeps the first 4). */
export const SERVER_MAX_IMAGES = 4;

/**
 * The images Claude in claude.ai takes with one request: its types, its size limit, at most its count,
 * in order. The rest are left out rather than failing the whole request (none when it takes no images).
 */
export function fitClaudeImages(images: Blob[], limits: ClaudeImageLimits | null): Blob[] {
  if (!limits) return [];
  const types = limits.mediaTypes.length ? new Set(limits.mediaTypes.map((t) => t.toLowerCase())) : null;
  const count = limits.maxCount > 0 ? limits.maxCount : 1;
  return images.filter((b) => (!types || types.has(b.type.toLowerCase())) && (!limits.maxInputBytes || b.size <= limits.maxInputBytes)).slice(0, count);
}

/** Ask Claude through the claude.ai Artifact runtime (`sample` capability). */
export async function callArtifactClaude(prompt: string, opts: CallOptions): Promise<unknown> {
  const sample = await getSample();
  if (!sample) throw new AIError('Claude is not available in this view.', 'unavailable');
  // Only pass members that are set: the runtime rejects `signal`/`onText` keys holding undefined.
  const o: SampleOptions = { modelTier: opts.tier, cache: false };
  if (opts.signal) o.signal = opts.signal;
  if (opts.onText) {
    const cb = opts.onText;
    o.onText = ({ text }) => cb(text);
  }
  const images = opts.images?.length ? fitClaudeImages(opts.images, useRuntime.getState().claudeImageLimits) : [];
  if (images.length) o.images = images;
  try {
    const value = await sample.json(prompt, o);
    useRuntime.getState().set({ claude: 'available' });
    return value;
  } catch (e) {
    const err = e as SampleError;
    const code = err?.code ?? 'upstream_error';
    if (code === 'not_granted') useRuntime.getState().set({ claude: 'declined' });
    if (code === 'sampling_disabled' || code === 'not_declared' || code === 'capability_disabled' || code === 'capability_removed') useRuntime.getState().set({ claude: 'unavailable' });
    if (code === 'rate_limited') useRuntime.getState().set({ claude: 'limited' });
    throw new AIError(err?.message || 'Claude could not answer.', code, err?.text);
  }
}

/** Ask your server to search the web for one request (Strategy's research): how many searches, and the place. */
export interface ResearchRequest {
  web: true;
  maxSearches?: number;
  location?: { city: string; region: string } | null;
}

export interface ServerCallOptions extends CallOptions {
  serverUrl: string;
  /** the Brain switch, recorded with the request */
  brain?: boolean;
  /** web research: only for functions marked "research" (the server answers 400 otherwise) */
  research?: ResearchRequest | null;
}

/** Server error codes → the app's codes (friendlyAIError explains them). */
const SERVER_CODES: Record<string, string> = {
  NO_PROVIDER: 'no_provider',
  RATE_LIMIT: 'rate_limited',
  CREDITS: 'credits',
  AUTH: 'auth',
  AUTH_REQUIRED: 'auth',
  CONTENT_POLICY: 'refused',
  REFUSAL: 'refused',
  CUT_OFF: 'cut_off',
  DAILY_LIMIT: 'daily_limit',
  // plans (the upgrade prompt explains; the server's sentence is the message)
  PLAN_REQUIRED: 'plan_required',
  PAYMENT_REQUIRED: 'plan_required',
  CREDITS_USED: 'plan_required',
  VIDEO_WEEK_LIMIT: 'plan_required',
};

/** When your server last failed to answer (a request or a health check); 0 once it answers. */
let unreachableAt = 0;

/**
 * Ask your server's AI (server/ai-server.mjs): it sends the prompt to the keys that power this
 * function, with each key's model and effort, and says which one answered and what it used.
 */
export async function callServerAI(fn: string, prompt: string, opts: ServerCallOptions): Promise<{ value: unknown; meta: AIMeta | null }> {
  const images = opts.images?.length ? await Promise.all(opts.images.slice(0, SERVER_MAX_IMAGES).map((b) => readFileAsDataURL(b))) : undefined;
  let res: Response;
  try {
    res = await serverFetch(opts.serverUrl, '/api/ai/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fn, prompt, tier: opts.tier, images, brain: opts.brain, ...(opts.research ? { research: opts.research } : {}) }),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new AIError('Stopped.', 'cancelled');
    unreachableAt = Date.now();
    useRuntime.getState().set({ server: 'down' });
    throw new AIError('Could not reach your AI server.', 'network');
  }
  unreachableAt = 0;
  useRuntime.getState().set({ server: 'ok' });
  const body = (await res.json().catch(() => null)) as { text?: string; meta?: unknown; error?: string; code?: string } | null;
  if (!res.ok) {
    const code = SERVER_CODES[body?.code ?? ''] ?? (res.status === 429 ? 'rate_limited' : 'upstream_error');
    throw new AIError(body?.error || `AI server error ${res.status}`, code);
  }
  const text = body?.text ?? '';
  opts.onText?.(text);
  const meta = isAIMeta(body?.meta) ? body.meta : null;
  try {
    return { value: parseJsonLoose(text), meta };
  } catch {
    throw new AIError(meta ? `${meta.providerLabel} (${meta.model}) answered with something that isn’t valid JSON.` : 'The answer was not valid JSON.', 'invalid_json', text);
  }
}

export const serverBase = (serverUrl: string) => (serverUrl || '').replace(/\/+$/, '');

/** Where Settings › AI keys keeps the ADMIN_TOKEN this browser was given (without accounts, it makes this browser the owner). */
export const ADMIN_TOKEN_KEY = 'ylb-admin-token';

/** A request to your server, saying who's signed in (when accounts are on), and the admin token when this browser has one. */
export async function serverFetch(serverUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  const target = `${serverBase(serverUrl)}${path}`;
  const headers = new Headers(init.headers);
  // the sign-in token (with accounts on, the server refuses AI without it)
  for (const [key, value] of Object.entries(await authHeaders(target))) headers.set(key, value);
  // without accounts, the owner's routes (Viktor in Slack) need the ADMIN_TOKEN entered in Settings › AI keys
  const admin = safeStorage.getItem(ADMIN_TOKEN_KEY);
  if (admin && !headers.has('x-admin-token')) headers.set('x-admin-token', admin);
  const res = await fetch(target, { ...init, headers });
  // plans: a paid action the plan refused opens the upgrade prompt (the caller still gets the answer as before)
  if (planRefusalListener && (res.status === 402 || res.status === 403 || res.status === 409)) {
    const listener = planRefusalListener;
    void res
      .clone()
      .json()
      .then((body: unknown) => listener(path, res.status, body))
      .catch(() => undefined);
  }
  return res;
}

type PlanRefusalListener = (path: string, status: number, body: unknown) => void;
let planRefusalListener: PlanRefusalListener | null = null;
/** Plans: told about every 402 (and the ads gate's 403, a full plan's 409) from the app's server. */
export function setPlanRefusalListener(fn: PlanRefusalListener | null): void {
  planRefusalListener = fn;
}

/** /api/health's `agents`, when it has the expected shape (an older server sends none). */
function agentsHealth(v: unknown): AgentsHealth | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const a = v as Partial<AgentsHealth>;
  const ready = (r: unknown): r is AgentReady => !!r && typeof r === 'object' && typeof (r as AgentReady).ready === 'boolean' && typeof (r as AgentReady).reason === 'string';
  if (!a.manus || !ready(a.manus.build) || !ready(a.manus.chat) || !ready(a.viktor)) return undefined;
  const where = a.viktor.where === 'dm' || a.viktor.where === 'channel' ? a.viktor.where : '';
  return {
    manus: { build: { ready: a.manus.build.ready, reason: a.manus.build.reason }, chat: { ready: a.manus.chat.ready, reason: a.manus.chat.reason }, own: a.manus.own === true, profile: typeof a.manus.profile === 'string' ? a.manus.profile : '' },
    viktor: { ready: a.viktor.ready, reason: a.viktor.reason, where, place: typeof a.viktor.place === 'string' ? a.viktor.place : '' },
  };
}

/** Ask the server which keys are ready and what powers each function (`timeoutMs`: no answer by then counts as down). */
export async function pingServer(serverUrl: string, o: { timeoutMs?: number } = {}): Promise<boolean> {
  try {
    const res = await serverFetch(serverUrl, '/api/health', { method: 'GET', ...(o.timeoutMs ? { signal: AbortSignal.timeout(o.timeoutMs) } : {}) });
    const body = res.ok ? ((await res.json().catch(() => null)) as { ok?: boolean; ai?: Partial<AIServerState> } | null) : null;
    const ok = body?.ok === true;
    const ai = body?.ai;
    unreachableAt = ok ? 0 : Date.now();
    useRuntime.getState().set({
      server: ok ? 'ok' : 'down',
      ai: ok && ai ? { reachable: true, ready: ai.ready === true, providers: Array.isArray(ai.providers) ? ai.providers : [], routing: ai.routing && typeof ai.routing === 'object' ? ai.routing : {}, posting: ai.posting && typeof ai.posting === 'object' ? ai.posting : undefined, agents: agentsHealth(ai.agents) } : { ...NO_AI_SERVER, reachable: ok },
    });
    return ok;
  } catch {
    unreachableAt = Date.now();
    useRuntime.getState().set({ server: 'down', ai: NO_AI_SERVER });
    return false;
  }
}

let rechecking: Promise<boolean> | null = null;
/** A "server down" older than this is checked again before the app decides without your server. */
export const RECHECK_AFTER_MS = 5_000;

/**
 * One request that couldn't reach your server marks it down, and the app pings it again only when the tab
 * opens or comes back. Before deciding without it (the built-in engine instead, a free Strategy run), ask
 * again: only when it's marked down and the last failure is at least `olderThanMs` old (0: whenever it's
 * marked down), one health check at a time. True when your server answers.
 */
export async function recheckServer(serverUrl: string, olderThanMs = RECHECK_AFTER_MS): Promise<boolean> {
  const rt = useRuntime.getState();
  if (__ARTIFACT_BUILD__ || rt.server !== 'down') return rt.server === 'ok';
  if (Date.now() - unreachableAt < olderThanMs) return false;
  rechecking ??= pingServer(serverUrl, { timeoutMs: 8_000 }).finally(() => (rechecking = null));
  return rechecking;
}

/** Same tolerance as the runtime: whole reply, a fenced block, or first { / [ to last } / ]. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* continue */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* continue */
    }
  }
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new AIError('The answer was not valid JSON.', 'invalid_json', text);
}

// ───────────────────────── Prompt framing ─────────────────────────

export function projectContext(p: Project): Record<string, unknown> {
  const fmt = p.format ? FORMATS[p.format] : null;
  return {
    track: p.track === 'product' ? 'digital product' : 'business',
    startingPoint: p.origin === 'new' ? 'new' : 'existing',
    niche: p.niche,
    category: p.category,
    productFormat: fmt?.label,
    businessType: p.businessType || undefined,
    location: p.location ? `${p.location.city}${p.location.region ? `, ${p.location.region}` : ''}` : undefined,
    description: p.summary || undefined,
    brand: {
      name: p.brand.name,
      tagline: p.brand.tagline,
      pitch: p.brand.pitch,
      audience: p.brand.audience,
      personality: p.brand.personality,
      website: p.brand.websiteUrl,
    },
    product: p.idea
      ? { title: p.idea.title, hook: p.idea.hook, audience: p.idea.audience, pain: p.idea.pain, features: p.idea.features }
      : undefined,
    price: p.studio.price || undefined,
    priceModel: p.studio.priceModel,
    deliverables: p.studio.outline.length ? p.studio.outline.map((s) => s.title) : undefined,
    packages: p.studio.packages.length ? p.studio.packages.map((x) => `${x.name} ($${x.price})`) : undefined,
    leadMagnet: p.marketing.leadMagnet?.title,
  };
}

export interface FrameArgs {
  task: string;
  project?: Project;
  brainPrompt?: string;
  input?: unknown;
  shape: string;
  variation?: number;
  extraRules?: string[];
}

export function framePrompt(a: FrameArgs): string {
  const parts = [
    'You are the AI engine inside Yourlocalbusiness, a workspace that helps creators and local businesses research, build, brand and market what they sell. Write like a seasoned direct-response marketer and product strategist who knows this niche well.',
    `TASK: ${a.task}`,
  ];
  if (a.project) parts.push(`PROJECT CONTEXT (JSON):\n${JSON.stringify(projectContext(a.project), null, 1)}`);
  if (a.brainPrompt) parts.push(a.brainPrompt);
  if (a.input !== undefined) parts.push(`INPUT (JSON):\n${JSON.stringify(a.input, null, 1)}`);
  if (a.variation) parts.push(`This is regeneration #${a.variation}. Give a noticeably fresh take: new angles and wording, not a paraphrase.`);
  parts.push(
    [
      'OUTPUT: reply with only one JSON value (no prose before or after, no code fences) in exactly this shape:',
      a.shape,
      'Rules:',
      '- Be specific to this niche, audience and offer. Use concrete details, not generic filler.',
      '- Do not invent statistics, awards, certifications or customer results and present them as fact.',
      '- Plain text inside JSON strings unless a field says otherwise. Use \\n for line breaks.',
      ...(a.extraRules ?? []).map((r) => `- ${r}`),
    ].join('\n'),
  );
  return parts.join('\n\n');
}

// ───────────────────────── Conforming Claude output to app types ─────────────────────────

const PROTECTED = new Set([
  'id',
  'type',
  'kind',
  'format',
  'platform',
  'style',
  'postType',
  'status',
  'source',
  'projectId',
  'batchId',
  'planSlotId',
  'seed',
  'createdAt',
  'updatedAt',
  'index',
  'delay',
  'scheduledAt',
  'visible',
  'priceModel',
  'watermark',
]);

function cloneTemplate<T>(tpl: T): T {
  if (Array.isArray(tpl)) return tpl.map(cloneTemplate) as T;
  if (tpl && typeof tpl === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tpl as Record<string, unknown>)) {
      o[k] = k === 'id' && typeof v === 'string' ? uid(v.split('_')[0] || 'id') : cloneTemplate(v);
    }
    return o as T;
  }
  return tpl;
}

/** Deep-merge `raw` onto `base`, keeping base types and structural fields. */
export function conform<T>(base: T, raw: unknown, allow: ReadonlySet<string> = new Set()): T {
  if (raw === undefined || raw === null) return base;
  if (Array.isArray(base)) {
    if (!Array.isArray(raw) || raw.length === 0) return base;
    const tpl = base[0];
    if (tpl === undefined) return raw.filter((x) => typeof x === 'string') as unknown as T;
    return raw.slice(0, 40).map((r, i) => conform(base[i] ?? cloneTemplate(tpl), r, allow)) as unknown as T;
  }
  if (base && typeof base === 'object') {
    if (typeof raw !== 'object' || Array.isArray(raw)) return base;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const k of Object.keys(out)) {
      if (PROTECTED.has(k) && !allow.has(k)) continue;
      if (k in (raw as Record<string, unknown>)) out[k] = conform(out[k], (raw as Record<string, unknown>)[k], allow);
    }
    return out as T;
  }
  if (typeof base === 'string') {
    if (typeof raw === 'string' && raw.trim()) return raw.trim() as unknown as T;
    if (typeof raw === 'number') return String(raw) as unknown as T;
    return base;
  }
  if (typeof base === 'number') {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
    return (Number.isFinite(n) ? n : base) as unknown as T;
  }
  if (typeof base === 'boolean') return (typeof raw === 'boolean' ? raw : base) as unknown as T;
  return base;
}

/**
 * Today's limit on the app's keys was reached (server code DAILY_LIMIT). The server's message says
 * the limit and when it resets; this makes sure it always points to Settings › AI keys.
 */
export function dailyLimitText(message = ''): string {
  const m = message.trim() || 'You’ve reached today’s limit on the app’s AI keys. It resets at midnight UTC.';
  return /Settings\s*[→›]\s*AI/.test(m) ? m : `${m} To keep going now, add your own API keys in Settings › AI keys.`;
}

/** Why the built-in engine answered instead. `message` is the server's own explanation, when there is one. */
export function friendlyAIError(code: string, message = ''): string {
  const fallback = 'The built-in engine answered instead.';
  switch (code) {
    case 'not_granted':
      return 'Claude access was declined for this page, so the built-in engine answered instead.';
    case 'rate_limited':
      return message ? `${message} ${fallback}` : 'The AI is busy or a usage limit was reached. The built-in engine answered instead; try again later.';
    case 'session_expired':
      return 'Your Claude session expired. Sign in again to use Claude; the built-in engine answered instead.';
    case 'refused':
      return message ? `${message} Try rephrasing; ${fallback.toLowerCase()}` : 'The AI declined this request. Try rephrasing; the built-in engine answered instead.';
    case 'invalid_json':
      return message ? `${message} The built-in engine filled in; try again.` : 'The AI’s answer could not be read, so the built-in engine filled in. Try again.';
    case 'network':
      return 'Your AI server could not be reached (is it running?). The built-in engine answered instead.';
    case 'no_provider':
    case 'credits':
    case 'auth':
    case 'cut_off':
      return message ? `${message} ${fallback}` : fallback;
    case 'daily_limit':
      return `${dailyLimitText(message)} ${fallback}`;
    case 'unavailable':
    case 'sampling_disabled':
      return 'Claude isn’t available here. The built-in engine answered.';
    case 'image_rejected':
    case 'images_unavailable':
      return 'Claude couldn’t take the images with this request. The built-in engine answered instead; try again with fewer or smaller images.';
    case 'prompt_too_large':
      return 'This request was too long for Claude. The built-in engine answered instead; try a shorter description or fewer images.';
    default:
      return message ? `${message} ${fallback}` : 'The AI hit a temporary problem. The built-in engine answered instead.';
  }
}
