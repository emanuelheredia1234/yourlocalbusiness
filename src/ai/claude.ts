import type { Project } from '@/lib/types';
import { NO_AI_SERVER, getSample, useRuntime, type AIServerState, type SampleError, type SampleOptions } from '@/lib/platform';
import { readFileAsDataURL, uid } from '@/lib/utils';
import { FORMATS } from './knowledge';
import { isAIMeta, type AIMeta } from './meta';

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
  if (opts.images?.length) o.images = opts.images;
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

export interface ServerCallOptions extends CallOptions {
  serverUrl: string;
  /** the Brain switch, recorded with the request */
  brain?: boolean;
}

/** Server error codes → the app's codes (friendlyAIError explains them). */
const SERVER_CODES: Record<string, string> = {
  NO_PROVIDER: 'no_provider',
  RATE_LIMIT: 'rate_limited',
  CREDITS: 'credits',
  AUTH: 'auth',
  CONTENT_POLICY: 'refused',
  REFUSAL: 'refused',
  CUT_OFF: 'cut_off',
};

/**
 * Ask your server's AI (server/ai-server.mjs): it sends the prompt to the keys that power this
 * function, with each key's model and effort, and says which one answered and what it used.
 */
export async function callServerAI(fn: string, prompt: string, opts: ServerCallOptions): Promise<{ value: unknown; meta: AIMeta | null }> {
  const images = opts.images?.length ? await Promise.all(opts.images.slice(0, 2).map((b) => readFileAsDataURL(b))) : undefined;
  let res: Response;
  try {
    res = await fetch(`${serverBase(opts.serverUrl)}/api/ai/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fn, prompt, tier: opts.tier, images, brain: opts.brain }),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new AIError('Stopped.', 'cancelled');
    useRuntime.getState().set({ server: 'down' });
    throw new AIError('Could not reach your AI server.', 'network');
  }
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

/** Ask the server which keys are ready and what powers each function. */
export async function pingServer(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverBase(serverUrl)}/api/health`, { method: 'GET' });
    const body = res.ok ? ((await res.json().catch(() => null)) as { ok?: boolean; ai?: Partial<AIServerState> } | null) : null;
    const ok = body?.ok === true;
    const ai = body?.ai;
    useRuntime.getState().set({
      server: ok ? 'ok' : 'down',
      ai: ok && ai ? { reachable: true, ready: ai.ready === true, providers: Array.isArray(ai.providers) ? ai.providers : [], routing: ai.routing && typeof ai.routing === 'object' ? ai.routing : {} } : { ...NO_AI_SERVER, reachable: ok },
    });
    return ok;
  } catch {
    useRuntime.getState().set({ server: 'down', ai: NO_AI_SERVER });
    return false;
  }
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
    case 'unavailable':
    case 'sampling_disabled':
      return 'Claude isn’t available here. The built-in engine answered.';
    default:
      return message ? `${message} ${fallback}` : 'The AI hit a temporary problem. The built-in engine answered instead.';
  }
}
