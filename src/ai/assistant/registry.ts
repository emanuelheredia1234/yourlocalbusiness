// The assistant's tools: how one is defined, how its arguments are checked, and the catalog the model reads.
//
// Every tool has a class. The app enforces what each class may do, whatever the model asks (policy.ts):
//   R        reads only: runs right away
//   L        a local change (nothing leaves the app, nothing is paid): runs right away
//   P-text   an AI text task (counts toward the daily AI limits): runs right away, noted "Used your AI";
//            one that makes many requests (a whole PDF) can ask on a card first (its `card`)
//   P-media  AI images run right away; videos, anything done by Manus, and a message drafted for Manus or
//            Viktor first wait for the owner's OK on a card in the chat (what it does, who does it, what it costs)
//   Pub      goes public: the tool only names one of the app's own windows, the app opens it and the
//            owner confirms there (the tool itself never posts or publishes)
//   D        destructive: the app asks with a danger confirm first, and runs it only on yes
//   X        never done by the assistant: the app explains why and opens the page where the owner does it

import type { ProviderId } from '@/lib/types';
import type { Route } from '@/lib/router';

export type ToolClass = 'R' | 'L' | 'P-text' | 'P-media' | 'Pub' | 'D' | 'X';

// ───────────── argument schemas ─────────────

interface SpecBase {
  /** a few words the model reads next to the argument ("YYYY-MM-DD", "a post id") */
  desc?: string;
  optional?: boolean;
}
export interface StringSpec extends SpecBase {
  type: 'string';
  /** length limits (default max 8,000 characters) */
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** "" is a value (e.g. to clear a field); otherwise empty text counts as missing */
  allowEmpty?: boolean;
}
export interface NumberSpec extends SpecBase {
  type: 'number';
  min?: number;
  max?: number;
  /** whole numbers only (a decimal is rounded) */
  int?: boolean;
}
export interface BooleanSpec extends SpecBase {
  type: 'boolean';
}
export interface EnumSpec<V extends string = string> extends SpecBase {
  type: 'enum';
  values: readonly V[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ArraySpec<I extends ArgSpec = any> extends SpecBase {
  type: 'array';
  items: I;
  /** item count limits (default max 100) */
  min?: number;
  max?: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ObjectSpec<P extends ArgProps = any> extends SpecBase {
  type: 'object';
  props: P;
}
export type ArgSpec = StringSpec | NumberSpec | BooleanSpec | EnumSpec | ArraySpec | ObjectSpec;
export type ArgProps = Record<string, ArgSpec>;

/** The value an argument holds once checked. */
export type ArgValue<S> = S extends { type: 'string' }
  ? string
  : S extends { type: 'number' }
    ? number
    : S extends { type: 'boolean' }
      ? boolean
      : S extends EnumSpec<infer V>
        ? V
        : S extends ArraySpec<infer I>
          ? ArgValue<I>[]
          : S extends ObjectSpec<infer P>
            ? InferArgs<P>
            : unknown;
type OptionalKeys<P> = { [K in keyof P]-?: P[K] extends { optional: true } ? K : never }[keyof P];
type RequiredKeys<P> = Exclude<keyof P, OptionalKeys<P>>;
/** The checked arguments a tool's functions receive (optional ones may be missing). */
export type InferArgs<P> = { -readonly [K in RequiredKeys<P>]: ArgValue<P[K]> } & { -readonly [K in OptionalKeys<P>]?: ArgValue<P[K]> };

type Opts<S> = Omit<S, 'type'>;

/** Argument builders: `arg.string({ desc: 'a post id' })`, `arg.enum(['draft', 'scheduled'], { optional: true })`… */
export const arg = {
  string: <const O extends Opts<StringSpec> = Record<never, never>>(o?: O) => ({ ...o, type: 'string' }) as StringSpec & O,
  number: <const O extends Opts<NumberSpec> = Record<never, never>>(o?: O) => ({ ...o, type: 'number' }) as NumberSpec & O,
  boolean: <const O extends Opts<BooleanSpec> = Record<never, never>>(o?: O) => ({ ...o, type: 'boolean' }) as BooleanSpec & O,
  enum: <const V extends string, const O extends Omit<Opts<EnumSpec>, 'values'> = Record<never, never>>(values: readonly V[], o?: O) => ({ ...o, type: 'enum', values }) as EnumSpec<V> & O,
  array: <I extends ArgSpec, const O extends Omit<Opts<ArraySpec>, 'items'> = Record<never, never>>(items: I, o?: O) => ({ ...o, type: 'array', items }) as ArraySpec<I> & O,
  object: <P extends ArgProps, const O extends Omit<Opts<ObjectSpec>, 'props'> = Record<never, never>>(props: P, o?: O) => ({ ...o, type: 'object', props }) as ObjectSpec<P> & O,
};

const DEFAULT_MAX_STRING = 8000;
const DEFAULT_MAX_ITEMS = 100;

type Checked = { ok: true; value: unknown } | { ok: false; error: string };

function checkValue(spec: ArgSpec, raw: unknown, path: string): Checked {
  switch (spec.type) {
    case 'string': {
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return { ok: false, error: `${path} must be text` };
      const v = String(raw).trim();
      const max = spec.max ?? DEFAULT_MAX_STRING;
      if (v.length > max) return { ok: false, error: `${path} is too long (at most ${max} characters)` };
      if (spec.min !== undefined && v.length < spec.min) return { ok: false, error: `${path} is too short (at least ${spec.min} characters)` };
      if (spec.pattern && !spec.pattern.test(v)) return { ok: false, error: `${path} isn’t in the right form${spec.desc ? ` (${spec.desc})` : ''}` };
      return { ok: true, value: v };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(n)) return { ok: false, error: `${path} must be a number` };
      const v = spec.int ? Math.round(n) : n;
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) {
        return { ok: false, error: `${path} must be ${spec.min !== undefined && spec.max !== undefined ? `between ${spec.min} and ${spec.max}` : spec.min !== undefined ? `at least ${spec.min}` : `at most ${spec.max}`}` };
      }
      return { ok: true, value: v };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 1 || raw === 0) return { ok: true, value: raw === 1 };
      if (typeof raw === 'string' && /^(true|yes|on)$/i.test(raw.trim())) return { ok: true, value: true };
      if (typeof raw === 'string' && /^(false|no|off)$/i.test(raw.trim())) return { ok: true, value: false };
      return { ok: false, error: `${path} must be true or false` };
    }
    case 'enum': {
      const s = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
      const hit = spec.values.find((v) => v === s) ?? spec.values.find((v) => v.toLowerCase() === s.toLowerCase());
      return hit !== undefined ? { ok: true, value: hit } : { ok: false, error: `${path} must be one of: ${spec.values.join(', ')}` };
    }
    case 'array': {
      // one value where a list was expected is a list of one
      const list = Array.isArray(raw) ? raw : [raw];
      const max = spec.max ?? DEFAULT_MAX_ITEMS;
      if (list.length > max) return { ok: false, error: `${path} has too many items (at most ${max})` };
      if (spec.min !== undefined && list.length < spec.min) return { ok: false, error: `${path} needs at least ${spec.min} item${spec.min === 1 ? '' : 's'}` };
      const out: unknown[] = [];
      for (let i = 0; i < list.length; i++) {
        const c = checkValue(spec.items, list[i], `${path}[${i}]`);
        if (!c.ok) return c;
        out.push(c.value);
      }
      return { ok: true, value: out };
    }
    case 'object': {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${path} must be an object` };
      return checkProps(spec.props, raw as Record<string, unknown>, `${path}.`);
    }
  }
}

function checkProps(props: ArgProps, raw: Record<string, unknown>, prefix: string): Checked {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(props)) {
    const v = raw[key];
    const missing = v === undefined || v === null || (typeof v === 'string' && !v.trim() && !(spec.type === 'string' && spec.allowEmpty));
    if (missing) {
      if (spec.optional) continue;
      return { ok: false, error: `${prefix}${key} is missing` };
    }
    const c = checkValue(spec, v, `${prefix}${key}`);
    if (!c.ok) return c;
    out[key] = c.value;
  }
  // anything else the model sent is left out
  return { ok: true, value: out };
}

/** Check a tool's arguments against its schema: unknown ones are dropped, simple mix-ups (a number sent as text) are fixed. */
export function checkArgs(props: ArgProps, raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const c = checkProps(props, obj, '');
  return c.ok ? { ok: true, args: c.value as Record<string, unknown> } : { ok: false, error: c.error };
}

// ───────────── tools ─────────────

/** Which AI wrote what a tool made (runAITask records it; the chat says "Used your AI"). */
export interface AIUse {
  task: string;
  label: string;
  provider: ProviderId;
  /** why the built-in engine answered, or which key answered after another failed */
  note?: string;
}

export interface ToolContext {
  /** the chat's Stop: pass it to anything slow (runAITask does) */
  signal: AbortSignal;
  /** the project this turn started in (the active project; the run stops if the owner switches) */
  projectId: string;
  /** a short status for the working indicator ("Writing 7 posts…") */
  stage: (text: string) => void;
  /** filled in by runAITask */
  ai: AIUse[];
}

export type ChatButtonIcon = 'download' | 'copy' | 'upload' | 'open' | 'check';

/** A button in the chat for what needs the owner's own click (a download, copying, picking a file). */
export interface ChatButton {
  label: string;
  /** runs on the owner's click; kept in memory only, so after a reload the button shows as expired */
  run: () => void | Promise<void>;
  icon?: ChatButtonIcon;
}

export interface ToolResult {
  /** false: the tool couldn't do it (`error` says why); default true */
  ok?: boolean;
  /** what the model reads back: small and JSON-able (ids, counts, short text), never secrets */
  data?: unknown;
  error?: string;
  /** the one-line activity note in the chat ("Opened the calendar", "Added 2 drafts") */
  note?: string;
  buttons?: ChatButton[];
  /** stop this turn after this tool (e.g. it switched projects) */
  end?: boolean;
}

/** agent: a message to Manus or Viktor (draft_agent_message), sent as the owner's only after their yes on the card */
export type MediaKind = 'image' | 'video' | 'manus' | 'agent';

/** The card a P-media tool shows before a video or a Manus job: what it does, who does it, what it costs. */
export interface ConfirmCardSpec {
  title: string;
  what: string;
  who: string;
  cost?: string;
  confirmLabel?: string;
  /** the exact text that goes (a drafted message), shown in full with a Copy button */
  quote?: string;
}

/** The danger confirm a D tool shows first. */
export interface DangerSpec {
  title: string;
  body: string;
  confirmLabel?: string;
}

/** The app's own windows a public (Pub) tool may open; the owner confirms there. */
export type PubWindow =
  | { kind: 'post-now'; postId: string }
  | { kind: 'manus-groups'; postId: string }
  | { kind: 'mark-posted'; postId: string }
  /** the open project's Marketplace listing: publish it (the window shows exactly what goes public), or show or hide your listings to other people */
  | { kind: 'listing'; action: 'publish' | 'show' | 'hide' }
  /** a page's Publish panel at a public address (the SEO page, or a code asset): the owner chooses the address and publishes there */
  | { kind: 'publish'; page: 'seo' }
  | { kind: 'publish'; page: 'asset'; assetId: string; name: string }
  /** "Build with Manus" or "Build with Viktor" for the SEO page or a Code & assets asset: the owner fills it in and sends it there */
  | { kind: 'agent-build'; target: 'asset' | 'seo'; agent: 'manus' | 'viktor' }
  /** the Ads planner's launch window for a plan: the owner picks everything that spends and confirms the spend there */
  | { kind: 'ad-launch'; planId: string }
  /** a launched campaign's change window (pause, resume, budget…): the owner reviews and confirms there */
  | { kind: 'ad-change'; campaignId: string; action: 'pause' | 'resume' | 'end' | 'budget' | 'end_date' | 'creative' }
  /** A/B tests (P4b): "Make variations" prefilled for a post, an email step or the SEO page; the owner generates and saves a draft there */
  | { kind: 'make-variations'; target: 'post' | 'email' | 'page'; id: string; change?: string; count?: 1 | 2 }
  /** A/B tests (P4b): a test's card in Social › A/B tests, where the owner posts a version or uses the winner */
  | { kind: 'experiment'; experimentId: string; name: string }
  | { kind: 'page'; route: Route; tab?: string };

/** Why an excluded tool isn't done by the assistant, and the page where the owner does it. */
export interface Refusal {
  text: string;
  route?: Route;
  tab?: string;
}

type Run<P> = (args: InferArgs<P>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;

/**
 * A tool's arguments by name. Typed loosely on purpose: a tighter bound makes TypeScript infer the
 * argument types from the bound instead of from `args` (route would be string, not the routes).
 * CheckedArgs still refuses anything that isn't an argument spec.
 */
type SpecMap = Record<string, object>;
type CheckedArgs<P> = { [K in keyof P]: P[K] extends ArgSpec ? P[K] : ArgSpec };

interface ToolBase<P extends SpecMap> {
  /** snake_case, unique across all groups */
  name: string;
  /** one line for the catalog: what it does (and what it returns, for reads) */
  summary: string;
  /** build them with arg.* */
  args: P & CheckedArgs<P>;
  /** something to read first, before validate and any card (e.g. an eligibility the card shows); never a write */
  prepare?: (args: InferArgs<P>, ctx: ToolContext) => Promise<void>;
  /** a check the schema can't express (e.g. that a post id exists): return the problem, or nothing */
  validate?: (args: InferArgs<P>, ctx: ToolContext) => string | null | undefined | void;
}

export interface RunTool<P extends SpecMap = ArgProps> extends ToolBase<P> {
  class: 'R' | 'L' | 'P-text';
  /** P-text only: a card the owner confirms in the chat first, for work that makes many AI requests (null: none needed this time) */
  card?: (args: InferArgs<P>, ctx: ToolContext) => ConfirmCardSpec | null;
  run: Run<P>;
}
export interface MediaTool<P extends SpecMap = ArgProps> extends ToolBase<P> {
  class: 'P-media';
  /** image: runs right away; video or manus: the owner confirms a card first */
  media: MediaKind | ((args: InferArgs<P>) => MediaKind);
  /** the card's text (a plain one is made from the summary when missing) */
  card?: (args: InferArgs<P>, ctx: ToolContext) => ConfirmCardSpec;
  run: Run<P>;
}
export interface PublicTool<P extends SpecMap = ArgProps> extends ToolBase<P> {
  class: 'Pub';
  /** the window to open (a string is a problem to report instead) */
  window: (args: InferArgs<P>, ctx: ToolContext) => PubWindow | string | Promise<PubWindow | string>;
}
export interface DangerTool<P extends SpecMap = ArgProps> extends ToolBase<P> {
  class: 'D';
  /** what the danger confirm says (the names of what goes, and that it can't be undone) */
  danger: (args: InferArgs<P>, ctx: ToolContext) => DangerSpec;
  run: Run<P>;
}
export interface ExcludedTool<P extends SpecMap = ArgProps> extends ToolBase<P> {
  class: 'X';
  refusal: Refusal;
}

export type ToolDef<P extends SpecMap = ArgProps> = RunTool<P> | MediaTool<P> | PublicTool<P> | DangerTool<P> | ExcludedTool<P>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any>;

/** Define one tool. The arguments' types follow from `args`. */
export function defineTool<const P extends SpecMap>(tool: ToolDef<P>): ToolDef<P> {
  return tool;
}

// ───────────── the catalog the model reads ─────────────
// Every line goes into every prompt, so the schema is written compactly: an argument that is plain text
// shows only its name ("caption", "date? (YYYY-MM-DD)"), a list of text adds [] ("ids[]", "tags[]?"),
// the others show their type ("limit?: 1-50", "due?: bool", "kind?: photo|illustration"). The prompt's
// legend says so.

function typeText(spec: ArgSpec): string {
  switch (spec.type) {
    case 'string':
      return 'text';
    case 'number':
      return spec.min !== undefined && spec.max !== undefined ? `${spec.min}-${spec.max}` : 'number';
    case 'boolean':
      return 'bool';
    case 'enum':
      return spec.values.join('|');
    case 'array':
      return `[${typeText(spec.items)}]`;
    case 'object':
      return `{${propsText(spec.props)}}`;
  }
}

/** Several keys that take the very same argument read as one: {educational|tip|question?: 0-3}. */
function sharedSpec(props: ArgProps): string | null {
  const entries = Object.entries(props);
  const [first] = entries;
  if (entries.length < 3 || entries.some(([, s]) => s !== first[1])) return null;
  return propsText({ [entries.map(([k]) => k).join('|')]: first[1] });
}

function propsText(props: ArgProps): string {
  const shared = sharedSpec(props);
  if (shared) return shared;
  return Object.entries(props)
    .map(([k, s]) => {
      const texts = s.type === 'array' && s.items.type === 'string';
      const type = s.type === 'string' || texts ? '' : `: ${typeText(s)}`;
      return `${k}${texts ? '[]' : ''}${s.optional ? '?' : ''}${type}${s.desc ? ` (${s.desc})` : ''}`;
    })
    .join(', ');
}

/** One catalog line: `name(args) [class] summary`. An excluded tool lists no arguments: it only explains and opens a page. */
export function catalogLine(t: AnyTool): string {
  return `- ${t.name}(${t.class === 'X' ? '' : propsText(t.args as ArgProps)}) [${t.class}] ${t.summary}`;
}

export interface Registry {
  tools: AnyTool[];
  get: (name: string) => AnyTool | undefined;
  catalog: () => string;
}

const NAME = /^[a-z][a-z0-9_]{1,47}$/;

/** The tools by name. Two tools with one name, or a badly formed name, is a mistake caught at start-up (and by the tests). */
export function createRegistry(tools: AnyTool[]): Registry {
  const byName = new Map<string, AnyTool>();
  for (const t of tools) {
    if (!NAME.test(t.name)) throw new Error(`Assistant tool name "${t.name}" must be snake_case.`);
    if (byName.has(t.name)) throw new Error(`Two assistant tools are named "${t.name}".`);
    byName.set(t.name, t);
  }
  let text: string | null = null;
  return {
    tools,
    get: (name) => byName.get(name),
    catalog: () => (text ??= tools.map(catalogLine).join('\n')),
  };
}

// ───────────── helpers for tool results ─────────────

/** Text from outside the owner's own workspace (other sellers' listings, Manus reports, imported files): shown to the model as data only. */
export function untrusted(text: string | undefined | null, max = 300): { untrusted: string } | undefined {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return { untrusted: t.length > max ? `${t.slice(0, max - 1)}…` : t };
}

/** Shorten text for a tool result. */
export function clip(text: string | undefined | null, max = 160): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
