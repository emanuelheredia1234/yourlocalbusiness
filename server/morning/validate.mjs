// The schema check on the AI's answer. MORNING_OUTPUT_SCHEMA documents the shape; a small hand-written checker
// applies it (no new dependency). Each candidate is checked on its own and dropped when it breaks a rule; unknown
// fields are dropped; text is cleaned (control characters out, whitespace collapsed). Nothing here trusts the model:
// no web address, no markup, no percentage or money amount that isn't in the business's own numbers.

import { MORNING } from './config.mjs';
import { clip } from './facts.mjs';
import { keyOf } from './rules.mjs';

const L = MORNING.limits;

export const MORNING_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        required: ['kind', 'title', 'why'],
        properties: {
          kind: { enum: MORNING.kinds },
          title: { type: 'string', minLength: L.titleMin, maxLength: L.title },
          why: { type: 'string', minLength: L.whyMin, maxLength: L.why },
          steps: { type: 'array', maxItems: L.steps, items: { type: 'string', maxLength: L.step } },
          target: {
            type: 'object',
            properties: {
              pageType: { enum: MORNING.pageTypes },
              topic: { type: 'string', maxLength: L.topic },
              codeKind: { enum: MORNING.codeKinds },
              leadMagnetType: { enum: MORNING.leadMagnetTypes },
              platform: { enum: MORNING.platforms },
              planActionId: { type: 'string', description: 'one of the open plan actions given' },
              postId: { type: 'string', description: 'one of the due posts given' },
              prompt: { type: 'string', maxLength: L.prompt, description: 'required for assistant' },
            },
          },
        },
      },
    },
  },
});

/** A web address in any form: a scheme, www., a Markdown link, or a bare domain. */
const WEB = /([a-z][a-z0-9+.-]*:\/\/|\bwww\.|\[[^\]]*\]\([^)]*\)|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|co|app|dev|shop|store|biz|info|us|uk|ca|au|de|fr|es|it|nl|me|ly|site|online|xyz|ai|gg|tv|link|page|blog|so)\b)/i;
const MARKUP = /<\/?[a-z!][^>]*>|```/i;
const PERCENT = /(\d[\d,]*(?:\.\d+)?)\s*(?:%|percent\b)/gi;
const MONEY = /(?:[$€£¥₹]\s?(\d[\d,]*(?:\.\d+)?))|(?:(\d[\d,]*(?:\.\d+)?)\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b)/gi;

/** The numbers in the facts, as plain strings ("1234", "4.5"): the only percentages or amounts the AI may quote. */
export function factNumbers(facts) {
  const set = new Set();
  const walk = (v, depth = 0) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      set.add(String(v));
      set.add(String(Math.round(v)));
    } else if (v && typeof v === 'object' && depth < 6) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk({ numbers: facts?.numbers, leads: facts?.leads, sales: facts?.sales, posts: facts?.posts });
  return set;
}

const norm = (s) => String(Number(String(s).replace(/,/g, '')));

/** Whether a text quotes a percentage or an amount that isn't one of `allowed`. */
function invents(text, allowed) {
  for (const re of [PERCENT, MONEY]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const n = m[1] ?? m[2];
      if (n != null && !allowed.has(norm(n))) return true;
    }
  }
  return false;
}

const multiline = (v) => typeof v === 'string' && /[\r\n\u2028\u2029]/.test(v.trim());
const len = (s) => Array.from(s).length;

/**
 * One candidate as it may be stored, or { drop: reason }. ctx: { facts, openActions: Map id → action,
 * duePosts: Set of ids, numbers: factNumbers(facts) }.
 */
export function checkCandidate(raw, ctx) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { drop: 'shape' };
  if (!MORNING.kinds.includes(raw.kind)) return { drop: 'kind' };
  if (typeof raw.title !== 'string' || typeof raw.why !== 'string' || multiline(raw.title)) return { drop: 'text' };
  const title = clip(raw.title, L.title + 1);
  const why = clip(raw.why, L.why + 1);
  if (len(title) < L.titleMin || len(title) > L.title || len(why) < L.whyMin || len(why) > L.why) return { drop: 'length' };
  let steps;
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps) || raw.steps.length > L.steps || raw.steps.some((x) => typeof x !== 'string')) return { drop: 'steps' };
    steps = raw.steps.map((x) => clip(x, L.step + 1)).filter(Boolean);
    if (steps.some((x) => len(x) > L.step)) return { drop: 'steps' };
  }
  const rt = raw.target === undefined ? {} : raw.target;
  if (!rt || typeof rt !== 'object' || Array.isArray(rt)) return { drop: 'target' };
  const target = {};
  const list = { pageType: MORNING.pageTypes, codeKind: MORNING.codeKinds, leadMagnetType: MORNING.leadMagnetTypes, platform: MORNING.platforms };
  for (const [k, allowed] of Object.entries(list)) {
    if (rt[k] === undefined || rt[k] === null) continue;
    if (!allowed.includes(rt[k])) return { drop: k };
    target[k] = rt[k];
  }
  for (const [k, max] of [['topic', L.topic], ['prompt', L.prompt]]) {
    if (rt[k] === undefined || rt[k] === null) continue;
    if (typeof rt[k] !== 'string') return { drop: k };
    const v = clip(rt[k], max + 1);
    if (len(v) > max) return { drop: k };
    if (v) target[k] = v;
  }
  if (rt.planActionId !== undefined && rt.planActionId !== null) {
    const a = ctx.openActions.get(rt.planActionId);
    if (!a || a.kind !== raw.kind) return { drop: 'planActionId' };
    target.planActionId = a.id;
  }
  if (rt.postId !== undefined && rt.postId !== null) {
    if (!ctx.duePosts.has(rt.postId)) return { drop: 'postId' };
    target.postId = rt.postId;
  }
  if (raw.kind === 'assistant' && !target.prompt) return { drop: 'prompt' };
  const texts = [title, why, ...(steps ?? []), target.topic ?? '', target.prompt ?? ''];
  if (texts.some((x) => WEB.test(x))) return { drop: 'link' };
  if (texts.some((x) => MARKUP.test(x))) return { drop: 'markup' };
  if (texts.some((x) => invents(x, ctx.numbers))) return { drop: 'number' };
  // defaults the app needs to open the right screen
  if (raw.kind === 'build_page' && !target.pageType) target.pageType = ctx.facts?.strategy?.pageType ?? 'landing';
  if (raw.kind === 'write_post' && !target.topic) target.topic = clip(title, L.topic);
  const c = { kind: raw.kind, title, why, ...(steps?.length ? { steps } : {}), target, from: 'ai' };
  return { candidate: { ...c, key: keyOf(c, ctx.facts) } };
}

/** The context a check needs, from the facts. */
export function checkContext(facts) {
  return {
    facts,
    openActions: new Map((facts?.strategy?.plan?.open ?? []).map((a) => [a.id, a])),
    duePosts: new Set((facts?.posts?.due ?? []).map((p) => p.id)),
    numbers: factNumbers(facts),
  };
}

/** The answer as JSON after stripping one surrounding code fence, or null. */
export function parseAnswer(text) {
  let s = String(text ?? '').trim();
  const fence = /^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** → { valid: candidate[] (in the AI's order, at most 3), dropped: reasons[], parsed: boolean }. */
export function validateAnswer(text, facts) {
  const parsed = parseAnswer(text);
  const list = parsed && typeof parsed === 'object' && Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, 3) : null;
  if (!list) return { valid: [], dropped: ['not_json'], parsed: false };
  const ctx = checkContext(facts);
  const valid = [];
  const dropped = [];
  for (const raw of list) {
    const r = checkCandidate(raw, ctx);
    if (r.candidate) valid.push(r.candidate);
    else dropped.push(r.drop);
  }
  return { valid, dropped, parsed: true };
}
