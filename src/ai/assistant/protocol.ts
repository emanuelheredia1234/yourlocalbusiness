// The assistant's reply protocol. Every AI request in a chat turn is one prompt (prompt.ts), and every
// reply is one JSON object:  {"reply": string, "actions": [{"tool": string, "args": object}], "done": boolean}
// The app runs the actions, writes their results into the next prompt, and asks again until done (or
// the step cap). Text providers have no native tool calling here, so this plain-text protocol works the
// same on every key and in claude.ai.

import { parseJsonLoose } from '../claude';

/** Starts every assistant prompt (the provider mock answers these with scripted steps for QA). */
export const ASSISTANT_MARKER = '[ylb-assistant-protocol v1]';

/** Section titles the prompt uses (the provider mock reads the same ones). */
export const SECTIONS = {
  guide: 'App guide',
  now: 'Now',
  workspace: 'Workspace (JSON)',
  tools: 'Tools',
  history: 'Conversation so far (oldest first)',
  message: 'Latest message from the owner',
  results: 'Tool results so far this turn (JSON)',
  format: 'Reply format',
} as const;

export const MAX_ACTIONS_PER_STEP = 8;
export const MAX_REPLY_CHARS = 4000;

export interface Action {
  tool: string;
  args: Record<string, unknown>;
}

export interface Step {
  /** short markdown for the owner ('' when there's nothing to say yet) */
  reply: string;
  actions: Action[];
  /** this reply finishes the request (no actions also means done) */
  done: boolean;
  /** the AI answered in plain text, not the protocol: its text is the reply */
  prose: boolean;
}

const firstString = (...vals: unknown[]): string | undefined => vals.find((v): v is string => typeof v === 'string' && v.trim() !== '');

function clipReply(text: string): string {
  const t = text.trim();
  return t.length > MAX_REPLY_CHARS ? `${t.slice(0, MAX_REPLY_CHARS - 1)}…` : t;
}

function toAction(raw: unknown): Action | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = firstString(o.tool, o.name, o.function);
  if (!name) return null;
  let args: unknown = o.args ?? o.arguments ?? o.input ?? o.parameters ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return {
    tool: name.trim().toLowerCase().replace(/[\s-]+/g, '_'),
    args: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
  };
}

const prose = (text: string): Step => ({ reply: clipReply(text), actions: [], done: true, prose: true });

/** A reply cut off mid-JSON still says something: keep its "reply" text rather than showing raw JSON. */
function salvage(text: string): Step | null {
  if (!/^\s*(```(?:json)?\s*)?\{/i.test(text)) return null;
  const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return null;
  try {
    return { reply: clipReply(JSON.parse(`"${m[1]}"`) as string), actions: [], done: true, prose: true };
  } catch {
    return null;
  }
}

/**
 * One step of the AI's answer: the parsed JSON object, or (from the text path) the raw text. JSON in a
 * code fence is fine; plain prose becomes the reply as it is.
 */
export function parseStep(raw: unknown): Step {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return prose('');
    try {
      value = parseJsonLoose(text);
    } catch {
      return salvage(text) ?? prose(text);
    }
    if (typeof value === 'string') return prose(value);
  }
  if (Array.isArray(value)) {
    // a bare list of actions
    const actions = value.map(toAction).filter((a): a is Action => !!a).slice(0, MAX_ACTIONS_PER_STEP);
    if (actions.length) return { reply: '', actions, done: false, prose: false };
    return prose(typeof raw === 'string' ? raw : '');
  }
  if (!value || typeof value !== 'object') return prose(typeof raw === 'string' ? raw : value == null ? '' : String(value));
  const o = value as Record<string, unknown>;
  const reply = firstString(o.reply, o.message, o.text, o.answer) ?? '';
  const list = Array.isArray(o.actions) ? o.actions : Array.isArray(o.tools) ? o.tools : o.action ? [o.action] : [];
  const actions = list.map(toAction).filter((a): a is Action => !!a).slice(0, MAX_ACTIONS_PER_STEP);
  const done = typeof o.done === 'boolean' ? o.done : typeof o.continue === 'boolean' ? !o.continue : actions.length === 0;
  return { reply: clipReply(reply), actions, done: done || actions.length === 0, prose: false };
}
