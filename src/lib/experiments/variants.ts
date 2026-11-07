// "Make variations" (P4b §A2), the pure part: what can differ for each kind, what it costs, how a version is put
// together from the one changed piece, how the review spots anything else that changed, the rule-based versions the
// built-in engine makes, and the Post now order and gap of a "different times" test. No requests here.

import type { EmailStep, Experiment, ExperimentChanged, ExperimentKind, Post, VariantKey } from '@/lib/types';
import { uid } from '@/lib/utils';
import { eachBlock, type Block, type EmailDoc } from '../../../shared/email/blocks.mjs';
import { plainFromDoc } from '../../../shared/email/migrate.mjs';

export type PostChange = 'hook' | 'caption' | 'visual' | 'cta' | 'time';
export type EmailChange = 'subject' | 'opening';
export type PageChange = 'headline' | 'hero' | 'cta';

export const CHANGES: Record<ExperimentKind, { id: ExperimentChanged; label: string; hint: string }[]> = {
  post: [
    { id: 'hook', label: 'Hook', hint: 'The first line people see.' },
    { id: 'caption', label: 'Caption', hint: 'The whole text, same idea.' },
    { id: 'visual', label: 'Visual', hint: 'A new image or video, same words.' },
    { id: 'cta', label: 'Call to action', hint: 'The last line: what to do next.' },
    { id: 'time', label: 'Posting time', hint: 'The same post at 2–3 different times. No AI.' },
  ],
  email: [
    { id: 'subject', label: 'Subject line', hint: 'What shows in the inbox.' },
    { id: 'opening', label: 'Opening', hint: 'The first paragraph.' },
  ],
  page: [
    { id: 'headline', label: 'Headline', hint: 'The big line at the top.' },
    { id: 'hero', label: 'Hero', hint: 'Headline, subheading and hero image.' },
    { id: 'cta', label: 'Call to action', hint: 'The button’s text.' },
  ],
};

/** About what one variations request costs in AI credits (one short text request, whatever the count). */
export const TEXT_REQUEST_CREDITS = 3;
export const KEYS: VariantKey[] = ['a', 'b', 'c'];
/** "Same network, different times": the least time between two versions. */
export const GAP_MS = 12 * 3_600_000;

export interface CostLine {
  text: string;
  /** Visual on a video with this week's videos used up */
  disabled?: boolean;
  reason?: string;
}

/** "about 3 AI credits (none on your own AI keys)": requests on the user's own keys never use credits. */
const TEXT_COST = `about ${TEXT_REQUEST_CREDITS} AI credits (none on your own AI keys)`;

/** The cost shown before generating (P4b: text credits; images; this week's videos): the exact count it makes. */
export function costLine(kind: ExperimentKind, change: ExperimentChanged, o: { count: number; video?: boolean; videosLeft?: number | null } = { count: 1 }): CostLine {
  if (change === 'time') return { text: 'No AI: the same post goes out at different times.' };
  const n = Math.max(1, Math.round(o.count));
  if (kind === 'post' && change === 'visual') {
    if (o.video) {
      const left = o.videosLeft;
      if (left != null && left < n) return { text: `Uses ${n} of this week’s videos (${left} left)`, disabled: true, reason: left === 0 ? 'This week’s videos are used up.' : `Only ${left} of this week’s videos left.` };
      return { text: `Uses ${n} of this week’s videos${left != null ? ` (${left} left)` : ''}, plus ${TEXT_COST}` };
    }
    return { text: `Makes ${n === 1 ? '1 new image' : `${n} new images`} (image credits), plus ${TEXT_COST}` };
  }
  return { text: `${TEXT_COST[0].toUpperCase()}${TEXT_COST.slice(1)}` };
}

// ───────────── a post's parts ─────────────

const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export interface CaptionParts {
  hook: string;
  body: string;
  cta: string;
}

/** A caption as hook (the first line), body, and call to action (the last line, when there's more than one). */
export function captionParts(caption: string): CaptionParts {
  const lines = caption.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first === -1) return { hook: '', body: '', cta: '' };
  let last = lines.length - 1;
  while (last > first && !lines[last].trim()) last--;
  if (last === first) return { hook: lines[first].trim(), body: '', cta: '' };
  return { hook: lines[first].trim(), body: lines.slice(first + 1, last).join('\n'), cta: lines[last].trim() };
}

export function joinCaption(p: CaptionParts): string {
  return [p.hook, p.body, p.cta].filter((x, i) => x || i === 1).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The fields a post version can differ in. */
export type PostFields = Pick<Post, 'headline' | 'caption' | 'hashtags' | 'visualPrompt'>;

/** What changed between a post and a version of it, as dimensions (hook, body, cta, headline, hashtags, visual). */
export function postDiff(a: PostFields, b: PostFields): string[] {
  const pa = captionParts(a.caption);
  const pb = captionParts(b.caption);
  const out: string[] = [];
  if (norm(pa.hook) !== norm(pb.hook)) out.push('hook');
  if (norm(pa.body) !== norm(pb.body)) out.push('body');
  if (norm(pa.cta) !== norm(pb.cta)) out.push('cta');
  if (norm(a.headline) !== norm(b.headline)) out.push('headline');
  if (a.hashtags.map(norm).join(' ') !== b.hashtags.map(norm).join(' ')) out.push('hashtags');
  if (norm(a.visualPrompt) !== norm(b.visualPrompt)) out.push('visual');
  return out;
}

/** Which of those a change is allowed to touch. */
const ALLOWED: Record<string, string[]> = {
  hook: ['hook'],
  caption: ['hook', 'body', 'cta'],
  cta: ['cta'],
  visual: ['visual', 'media'],
  time: [],
  subject: ['subject'],
  opening: ['opening'],
  headline: ['headline'],
  hero: ['headline', 'subheadline', 'image'],
};

const PART_LABEL: Record<string, string> = { hook: 'hook', body: 'caption', cta: 'call to action', headline: 'on-image headline', hashtags: 'hashtags', visual: 'visual', media: 'image or video', subject: 'subject', preview: 'preview text', opening: 'opening', rest: 'email body', subheadline: 'subheading', image: 'hero image', ctaLabel: 'button text' };

/** "Also changed": the parts an edit touched besides the chosen one (plain words), [] when none. */
export function alsoChanged(change: ExperimentChanged, diff: string[]): string[] {
  const ok = ALLOWED[change] ?? [];
  return diff.filter((d) => !ok.includes(d)).map((d) => PART_LABEL[d] ?? d);
}

/** A post version from the source and the one new piece. */
export function applyPostChange(source: PostFields, change: PostChange, value: string): PostFields {
  const parts = captionParts(source.caption);
  switch (change) {
    case 'hook':
      return { ...source, caption: joinCaption({ ...parts, hook: value.trim() }) };
    case 'cta':
      return { ...source, caption: parts.cta ? joinCaption({ ...parts, cta: value.trim() }) : `${source.caption.trim()}\n${value.trim()}` };
    case 'caption':
      return { ...source, caption: value.trim() };
    case 'visual':
      return { ...source, visualPrompt: value.trim() };
    default:
      return { ...source };
  }
}

/** The piece a change is about, in a post. */
export function postPiece(p: PostFields, change: PostChange): string {
  const parts = captionParts(p.caption);
  return change === 'hook' ? parts.hook : change === 'cta' ? parts.cta : change === 'caption' ? p.caption : change === 'visual' ? p.visualPrompt : '';
}

// ───────────── email and page ─────────────

export type EmailFields = Pick<EmailStep, 'subject' | 'preview' | 'body'> & { doc?: EmailDoc };

const paragraphs = (body: string) => body.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);

export const firstParagraph = (body: string) => paragraphs(body)[0] ?? '';

/**
 * Which paragraph of the body is the email's opening. A plain email: the first. An email with blocks: the first
 * paragraph of its first text block (its body starts with the headings' words, so paragraph 0 is often a heading).
 */
export function openingIndex(source: Pick<EmailFields, 'body' | 'doc'>): number {
  const doc = source.doc;
  if (!doc) return 0;
  let first: Block | null = null;
  eachBlock(doc, (b) => {
    if (!first && b?.type === 'text' && String(b.text ?? '').trim()) first = b;
  });
  if (!first) return 0;
  const opening = firstParagraph(plainFromDoc({ ...doc, blocks: [first] }).body);
  const at = paragraphs(source.body).findIndex((x) => x.trim() === opening.trim());
  return at < 0 ? 0 : at;
}

/** The email's opening paragraph (see openingIndex). */
export const openingOf = (source: Pick<EmailFields, 'body' | 'doc'>): string => paragraphs(source.body)[openingIndex(source)] ?? '';

/** Version B's opening: the paragraph of B's body where A's opening is (B shares A's blocks). */
export const variantOpening = (a: Pick<EmailFields, 'body' | 'doc'>, bBody: string): string => paragraphs(bBody)[openingIndex(a)] ?? '';

export function applyEmailChange<T extends EmailFields>(source: T, change: EmailChange, value: string): T {
  if (change === 'subject') return { ...source, subject: value.trim() };
  const paras = paragraphs(source.body);
  paras[openingIndex(source)] = value.trim();
  return { ...source, body: paras.join('\n\n') };
}

/** What differs between two versions; the opening is the one of version A (both share A's blocks). */
export function emailDiff(a: EmailFields, b: EmailFields): string[] {
  const out: string[] = [];
  if (norm(a.subject) !== norm(b.subject)) out.push('subject');
  if (norm(a.preview) !== norm(b.preview)) out.push('preview');
  const at = openingIndex(a);
  const ra = paragraphs(a.body);
  const rb = paragraphs(b.body);
  if (norm(ra[at]) !== norm(rb[at])) out.push('opening');
  if (norm(ra.filter((_, i) => i !== at).join(' ')) !== norm(rb.filter((_, i) => i !== at).join(' '))) out.push('rest');
  return out;
}

export interface HeroFields {
  headline: string;
  subheadline: string;
  ctaLabel: string;
  imageId?: string;
}

export function heroDiff(a: HeroFields, b: HeroFields): string[] {
  const out: string[] = [];
  if (norm(a.headline) !== norm(b.headline)) out.push('headline');
  if (norm(a.subheadline) !== norm(b.subheadline)) out.push('subheadline');
  if (norm(a.ctaLabel) !== norm(b.ctaLabel)) out.push('ctaLabel');
  if ((a.imageId ?? '') !== (b.imageId ?? '')) out.push('image');
  return out;
}

/** "Also changed" for the page: the cta change is the button's text. */
export function heroAlsoChanged(change: PageChange, diff: string[]): string[] {
  const ok = change === 'cta' ? ['ctaLabel'] : (ALLOWED[change] ?? []);
  return diff.filter((d) => !ok.includes(d)).map((d) => (d === 'headline' ? 'headline' : (PART_LABEL[d] ?? d)));
}

// ───────────── what the AI returns ─────────────

export interface VariantPiece {
  label: string;
  /** the new piece (hook line, caption, cta line, image description, subject, opening, headline, button text) */
  text: string;
  /** hero: the new subheading */
  sub?: string;
}

export interface VariantsResult {
  variants: VariantPiece[];
  /** the AI's answer didn't fit (the dialog offers one Try again) */
  problem?: string;
}

const ONE_LINE = new Set(['hook', 'cta', 'subject', 'headline']);
const MAX_LEN: Record<string, number> = { hook: 220, cta: 220, caption: 2200, visual: 600, subject: 120, opening: 800, headline: 120, hero: 120 };

/**
 * Check an AI answer: the right number of versions, each with its one piece, different from the original and from
 * each other, on one line where it must be, not too long. Only the named piece comes back, so nothing else can
 * change. → the versions, or a problem.
 */
export function validatePieces(raw: unknown, o: { change: ExperimentChanged; count: number; original: string; originalSub?: string }): VariantsResult {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { variants?: unknown }).variants) ? ((raw as { variants: unknown[] }).variants as unknown[]) : null;
  if (!list) return { variants: [], problem: 'The AI’s answer wasn’t in the expected shape.' };
  const out: VariantPiece[] = [];
  for (const item of list.slice(0, o.count)) {
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    const sub = typeof r.sub === 'string' ? r.sub.trim() : undefined;
    const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 80) : '';
    if (!text) return { variants: [], problem: 'A version came back empty.' };
    if (ONE_LINE.has(o.change) && /\n/.test(text)) return { variants: [], problem: 'A version came back on more than one line.' };
    if ([...text].length > (MAX_LEN[o.change] ?? 2000)) return { variants: [], problem: 'A version came back too long.' };
    if (norm(text) === norm(o.original) && (o.change !== 'hero' || norm(sub) === norm(o.originalSub))) return { variants: [], problem: 'A version came back the same as the original.' };
    if (out.some((v) => norm(v.text) === norm(text))) return { variants: [], problem: 'Two versions came back the same.' };
    out.push({ label, text, ...(o.change === 'hero' ? { sub: sub ?? o.originalSub ?? '' } : {}) });
  }
  if (out.length < o.count) return { variants: [], problem: `The AI made ${out.length} of ${o.count} versions.` };
  return { variants: out.map((v, i) => ({ ...v, label: v.label || `Version ${KEYS[i + 1].toUpperCase()}` })) };
}

// ───────────── the built-in engine's versions (no AI) ─────────────

const lower1 = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const bare = (s: string) => s.replace(/[.!?…:]+$/, '').trim();

/** Rule-based versions of a piece (the claude.ai build and no-key fallback): a question, a number, a direct line. */
export function localPieces(change: ExperimentChanged, original: string, o: { count: number; topic?: string; originalSub?: string }): VariantPiece[] {
  const base = bare(original) || bare(o.topic ?? '') || 'this';
  const pick = (cands: VariantPiece[]) => cands.filter((c) => norm(c.text) !== norm(original)).slice(0, o.count);
  switch (change) {
    case 'hook':
    case 'headline':
    case 'subject':
      return pick([
        { label: 'Question', text: `Ever wondered about ${lower1(base)}?` },
        { label: 'Straight to it', text: `Here’s the short version: ${lower1(base)}.` },
        { label: 'Three things', text: `3 things to know: ${lower1(base)}` },
      ]);
    case 'cta':
      return pick([
        { label: 'Book now', text: 'Book your spot today.' },
        { label: 'Message us', text: 'Send us a message to find out more.' },
        { label: 'Save it', text: 'Save this for later.' },
      ]);
    case 'caption': {
      const p = captionParts(original);
      return pick([
        { label: 'Shorter', text: joinCaption({ hook: p.hook, body: '', cta: p.cta }) || base },
        { label: 'Question first', text: joinCaption({ ...p, hook: `Ever wondered about ${lower1(bare(p.hook) || base)}?` }) },
      ]);
    }
    case 'visual':
      return pick([
        { label: 'Close-up', text: `${base}, close-up detail, natural light` },
        { label: 'People in it', text: `${base}, wide shot with people using it, warm light` },
      ]);
    case 'opening':
      return pick([
        { label: 'Quick note', text: `Quick one today. ${original.trim()}` },
        { label: 'Question', text: `Have you ever wondered about ${lower1(bare(o.topic ?? base))}? ${original.trim()}` },
      ]);
    case 'hero':
      return pick([{ label: 'Question', text: `Ever wondered about ${lower1(base)}?`, sub: o.originalSub ?? '' }]);
    default:
      return [];
  }
}

// ───────────── saving post versions ─────────────

/** The default planned times: the source's time (or the next hour), then one day later each, at the same hour. */
export function defaultPlannedTimes(sourceAt: string | undefined, count: number, now = Date.now()): string[] {
  let t = sourceAt && Number.isFinite(Date.parse(sourceAt)) ? Date.parse(sourceAt) : NaN;
  if (!Number.isFinite(t) || t < now) t = Math.ceil(now / 3_600_000) * 3_600_000 + 3_600_000;
  return Array.from({ length: count }, (_, i) => new Date(t + i * 86_400_000).toISOString());
}

/** A new post for a version: a copy of the source with its new fields (unposted, same plan slot, the test set). */
export function variantPost(source: Post, fields: Partial<PostFields> & Partial<Pick<Post, 'media' | 'scheduledAt'>>, ref: { id: string; key: VariantKey }, now = Date.now()): Post {
  const { external: _e, publishedAt: _p, publishedBy: _b, postUrl: _u, statusBeforePosted: _s, groupShare: _g, ...rest } = source;
  return {
    ...rest,
    ...fields,
    id: uid('post'),
    status: source.status === 'published' ? 'draft' : source.status,
    experiment: ref,
    createdAt: now,
    updatedAt: now,
  };
}

// ───────────── Post now order and gap ─────────────

export interface PostNowGate {
  ok: boolean;
  /** why not yet, in plain words */
  reason?: string;
}

/**
 * Whether a version may go out now: in key order, and for "different times" at least 12 hours after the version
 * before it went out (the server checks again). Trial Reels may go back to back.
 */
export function postNowGate(e: Pick<Experiment, 'mode' | 'state' | 'variants'>, key: VariantKey, postedAt: (postId: string | null) => number | null, now = Date.now(), failed: (postId: string | null) => boolean = () => false): PostNowGate {
  if (e.state !== 'draft' && e.state !== 'running') return { ok: false, reason: 'This test has ended.' };
  const list = [...e.variants].sort((x, y) => (x.key < y.key ? -1 : 1));
  const i = list.findIndex((v) => v.key === key);
  if (i === -1) return { ok: false, reason: 'No such version.' };
  // a version is out once its job is, unless that job failed (the server counts only jobs that went out, or may have)
  const out = (v: (typeof list)[number]) => !!v.jobId && !failed(v.postId);
  if (out(list[i])) return { ok: false, reason: 'Already posted.' };
  if (i === 0) return { ok: true };
  const prev = list[i - 1];
  if (!out(prev)) return { ok: false, reason: `Post version ${prev.key.toUpperCase()} first.` };
  if (e.mode !== 'times') return { ok: true };
  const at = postedAt(prev.postId);
  if (at == null) return { ok: true };
  const wait = at + GAP_MS - now;
  if (wait > 0) {
    const h = Math.ceil(wait / 3_600_000);
    return { ok: false, reason: `Wait ${h} more hour${h === 1 ? '' : 's'}: versions go out at least 12 hours apart.` };
  }
  return { ok: true };
}
