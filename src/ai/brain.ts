import type { Directives, Framework, HookStyle, ModuleScope, Skill, SkillCategory, Tone } from '@/lib/types';
import { uid, uniq } from '@/lib/utils';

// ───────────────────────── Brain: skills the AI references on every generation ─────────────────────────

export const CATEGORY_META: Record<SkillCategory, { label: string; icon: string; desc: string }> = {
  voice: { label: 'Brand voice', icon: 'mic', desc: 'Tone, personality and how you sound' },
  audience: { label: 'Audience', icon: 'users', desc: 'Who you serve, their words, pains and goals' },
  copywriting: { label: 'Copywriting', icon: 'pen-tool', desc: 'Frameworks, hooks and persuasion rules' },
  offer: { label: 'Offer & pricing', icon: 'tag', desc: 'How offers, bonuses and guarantees are built' },
  seo: { label: 'SEO', icon: 'search', desc: 'Keywords, local search and on-page rules' },
  social: { label: 'Social media', icon: 'hash', desc: 'Platform rules, hooks, video scripting' },
  email: { label: 'Email', icon: 'mail', desc: 'Subject lines, deliverability, sequences' },
  visual: { label: 'Visual style', icon: 'palette', desc: 'Imagery, colors and art direction' },
  rules: { label: 'Rules & compliance', icon: 'shield-check', desc: 'Words to avoid, claims you cannot make' },
  knowledge: { label: 'Knowledge', icon: 'book-open', desc: 'Facts, documents and product details' },
  learned: { label: 'Learned from feedback', icon: 'sparkles', desc: 'Preferences the Brain picked up from your ratings' },
};

export const SCOPE_META: Record<ModuleScope, string> = {
  all: 'Everywhere',
  research: 'Product research',
  brand: 'Brand identity',
  studio: 'Creation studio',
  code: 'Code generator',
  email: 'Email funnel',
  seo: 'SEO sales page',
  social: 'Social posts',
  ads: 'Paid ads',
  store: 'Store listings',
};

export const TONES: { id: Tone; label: string; desc: string }[] = [
  { id: 'friendly', label: 'Friendly', desc: 'Warm, neighborly, plain-spoken' },
  { id: 'professional', label: 'Professional', desc: 'Clear, credible, precise' },
  { id: 'bold', label: 'Bold', desc: 'Confident, direct, high-energy' },
  { id: 'playful', label: 'Playful', desc: 'Light, fun, casual' },
  { id: 'luxury', label: 'Luxury', desc: 'Refined, minimal, exclusive' },
  { id: 'empathetic', label: 'Empathetic', desc: 'Gentle, supportive, reassuring' },
  { id: 'witty', label: 'Witty', desc: 'Clever, surprising, punchy' },
  { id: 'authoritative', label: 'Authoritative', desc: 'Expert, data-led, decisive' },
];

export const FRAMEWORKS: { id: Framework; label: string; desc: string }[] = [
  { id: 'PAS', label: 'PAS', desc: 'Problem → Agitate → Solution' },
  { id: 'AIDA', label: 'AIDA', desc: 'Attention → Interest → Desire → Action' },
  { id: 'BAB', label: 'BAB', desc: 'Before → After → Bridge' },
  { id: 'FAB', label: 'FAB', desc: 'Features → Advantages → Benefits' },
  { id: '4U', label: '4U', desc: 'Useful, Urgent, Unique, Ultra-specific' },
  { id: 'StoryBrand', label: 'StoryBrand', desc: 'Customer is the hero, you are the guide' },
];

export const HOOK_STYLES: { id: HookStyle; label: string }[] = [
  { id: 'question', label: 'Question' },
  { id: 'stat', label: 'Number-led' },
  { id: 'contrarian', label: 'Contrarian' },
  { id: 'story', label: 'Story' },
  { id: 'pov', label: 'POV' },
];

// ───────────── Freeform text → structured directives ─────────────

const TONE_WORDS: [RegExp, Tone][] = [
  [/\b(luxur\w*|premium|elegant|high-end|exclusive|refined)\b/i, 'luxury'],
  [/\b(playful|fun|casual|cheeky|gen[- ]?z|lighthearted)\b/i, 'playful'],
  [/\b(empath\w*|compassion\w*|supportive|gentle|reassuring|caring)\b/i, 'empathetic'],
  [/\b(witty|humou?r\w*|clever|sarcastic|funny)\b/i, 'witty'],
  [/\b(authoritative|expert|data-driven|data led|analytical)\b/i, 'authoritative'],
  [/\b(bold|confident|punchy|direct|aggressive|energetic)\b/i, 'bold'],
  [/\b(professional|formal|corporate|polished|credible)\b/i, 'professional'],
  [/\b(friendly|warm|neighbou?rly|approachable|conversational)\b/i, 'friendly'],
];

function splitList(s: string): string[] {
  return s
    .split(/,|;|\/|\bor\b|\band\b|\n/i)
    .map((x) => x.replace(/["“”'‘’.]/g, '').trim())
    .filter((x) => x.length > 1 && x.length < 48);
}

export function parseDirectives(text: string): Directives {
  const t = text || '';
  const d: Directives = {};
  for (const [re, tone] of TONE_WORDS) {
    if (re.test(t)) {
      d.tone = tone;
      break;
    }
  }
  if (/\b(no|zero|without|avoid|never use)\s+emoji/i.test(t)) d.emoji = 'none';
  else if (/\b(lots of|plenty of|heavy|many|love)\s+emoji/i.test(t) || /emoji-heavy/i.test(t)) d.emoji = 'heavy';
  else if (/\b(a few|light|some|minimal|sparing\w*)\s+emoji/i.test(t) || /\buse emojis?\b/i.test(t)) d.emoji = 'light';

  const fw = /\b(PAS|AIDA|BAB|FAB|4U|StoryBrand)\b/i.exec(t);
  if (fw) {
    const v = fw[1].toUpperCase();
    d.framework = (v === 'STORYBRAND' ? 'StoryBrand' : v) as Framework;
  } else if (/problem[, -]+agitat/i.test(t)) d.framework = 'PAS';
  else if (/before[, -]+after/i.test(t)) d.framework = 'BAB';

  if (/\b(short|concise|brief|punchy|tight|under \d+ words)\b/i.test(t)) d.length = 'short';
  else if (/\b(long-form|detailed|in-depth|thorough|comprehensive)\b/i.test(t)) d.length = 'long';

  if (/\b(simple|plain english|plain language|grade \d|easy to read|no jargon)\b/i.test(t)) d.readingLevel = 'simple';
  else if (/\b(technical|expert level|advanced audience|jargon is ok)\b/i.test(t)) d.readingLevel = 'expert';

  if (/\b(first person plural|use "?we"?|as a team|our team)\b/i.test(t)) d.person = 'we';
  else if (/\b(first person|use "?I"?\b|founder voice|from me)\b/i.test(t)) d.person = 'i';

  if (/\bquestion hooks?\b|\bopen with a question\b/i.test(t)) d.hookStyle = 'question';
  else if (/\b(stat|statistic|number)[- ]?(led|hooks?)\b|\bnumbers first\b/i.test(t)) d.hookStyle = 'stat';
  else if (/\b(contrarian|hot take|unpopular opinion|pattern interrupt)\b/i.test(t)) d.hookStyle = 'contrarian';
  else if (/\b(story|storytelling|anecdote)\b/i.test(t)) d.hookStyle = 'story';
  else if (/\bPOV\b/.test(t)) d.hookStyle = 'pov';

  const banned: string[] = [];
  const reBanned = /(?:never (?:say|use|write)|avoid(?: the)?(?: words?| phrases?| terms?)?|don['’]t (?:say|use)|banned(?: words)?)\s*:?\s*([^\n.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = reBanned.exec(t))) {
    const chunk = m[1].replace(/\bemojis?\b/gi, '');
    banned.push(...splitList(chunk).filter((w) => !/^(using|use|to|the|a|an)$/i.test(w)));
  }
  if (banned.length) d.banned = uniq(banned.map((b) => b.toLowerCase())).slice(0, 30);

  const must: string[] = [];
  const reMust = /(?:always (?:mention|include|use|say)|must include|include the (?:keywords?|phrases?)|keywords?)\s*:?\s*([^\n.]+)/gi;
  while ((m = reMust.exec(t))) must.push(...splitList(m[1]));
  if (must.length) d.mustInclude = uniq(must).slice(0, 12);

  const cta = /(?:\bCTA\b|call to action|end (?:with|every post with))\s*:?\s*(?:["“]([^"”\n]+)["”]|([^\n.]+))/i.exec(t);
  if (cta) d.cta = (cta[1] ?? cta[2] ?? '').trim().slice(0, 80) || undefined;

  const signOff = /sign(?:-| )?off(?: with| as)?\s*:?\s*(?:["“]([^"”\n]+)["”]|([^\n]+))/i.exec(t);
  if (signOff) d.signOff = (signOff[1] ?? signOff[2] ?? '').trim().slice(0, 60) || undefined;

  const tags = t.match(/#[A-Za-z][A-Za-z0-9_]{1,40}/g);
  if (tags) d.hashtags = uniq(tags).slice(0, 15);

  const aud = /(?:target audience|audience|ideal customer|we serve|for)\s*(?:is|are|:)\s*([^\n.]+)/i.exec(t);
  if (aud) d.audience = aud[1].trim().slice(0, 120);

  const facts: string[] = [];
  const factBlock = /(?:facts?|proof(?: points)?|about us)\s*:\s*\n?((?:[-•*].+\n?)+)/i.exec(t);
  if (factBlock) facts.push(...factBlock[1].split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean));
  if (facts.length) d.facts = facts.slice(0, 8);

  return d;
}

export function describeDirectives(d: Directives): string[] {
  const out: string[] = [];
  if (d.tone) out.push(`Tone: ${d.tone}`);
  if (d.emoji) out.push(`Emoji: ${d.emoji}`);
  if (d.framework) out.push(`Framework: ${d.framework}`);
  if (d.length) out.push(`Length: ${d.length}`);
  if (d.readingLevel) out.push(`Reading level: ${d.readingLevel}`);
  if (d.person) out.push(`Voice: ${d.person === 'we' ? '“we”' : d.person === 'i' ? '“I”' : '“you”'}`);
  if (d.hookStyle) out.push(`Hooks: ${d.hookStyle}`);
  if (d.cta) out.push(`CTA: “${d.cta}”`);
  if (d.signOff) out.push(`Sign-off: “${d.signOff}”`);
  if (d.audience) out.push(`Audience: ${d.audience}`);
  if (d.banned?.length) out.push(`Avoid: ${d.banned.slice(0, 6).join(', ')}${d.banned.length > 6 ? '…' : ''}`);
  if (d.mustInclude?.length) out.push(`Include: ${d.mustInclude.slice(0, 6).join(', ')}`);
  if (d.hashtags?.length) out.push(`Hashtags: ${d.hashtags.slice(0, 5).join(' ')}`);
  if (d.facts?.length) out.push(`${d.facts.length} proof points`);
  return out;
}

// ───────────── Resolution: which skills apply, merged by priority ─────────────

export function skillApplies(skill: Skill, scope: ModuleScope): boolean {
  if (!skill.enabled) return false;
  if (!skill.scope.length || skill.scope.includes('all')) return true;
  return skill.scope.includes(scope);
}

export function effectiveDirectives(skill: Skill): Directives {
  // Structured controls win over what was parsed from the instructions.
  return { ...parseDirectives(skill.instructions), ...stripEmpty(skill.directives) };
}

function stripEmpty(d: Directives): Directives {
  const out: Directives = {};
  for (const [k, v] of Object.entries(d) as [keyof Directives, unknown][]) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function mergeDirectives(skills: Skill[]): Directives {
  // Lowest priority first so higher-priority skills overwrite scalar settings.
  const ordered = skills.slice().sort((a, b) => a.priority - b.priority || a.updatedAt - b.updatedAt);
  const out: Directives = {};
  for (const s of ordered) {
    const d = effectiveDirectives(s);
    for (const [k, v] of Object.entries(d) as [keyof Directives, unknown][]) {
      if (Array.isArray(v)) {
        const prev = (out[k] as string[] | undefined) ?? [];
        (out as Record<string, unknown>)[k] = uniq([...prev, ...(v as string[])]);
      } else {
        (out as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}

export interface ResolvedBrain {
  skills: Skill[];
  directives: Directives;
  prompt: string;
}

export function resolveBrain(all: Skill[], scope: ModuleScope, useBrain = true): ResolvedBrain {
  if (!useBrain) return { skills: [], directives: {}, prompt: '' };
  const skills = all.filter((s) => skillApplies(s, scope));
  const directives = mergeDirectives(skills);
  return { skills, directives, prompt: brainPrompt(skills, directives) };
}

const PRIORITY_LABEL = { 1: 'Low', 2: 'Normal', 3: 'High' } as const;

export function brainPrompt(skills: Skill[], d: Directives): string {
  if (!skills.length) return '';
  const lines: string[] = ['BRAIN SKILLS — follow these. When two conflict, the higher priority wins.'];
  for (const s of skills.slice().sort((a, b) => b.priority - a.priority)) {
    lines.push(`\n### ${s.name} [${PRIORITY_LABEL[s.priority]} priority · ${CATEGORY_META[s.category].label}]`);
    if (s.instructions.trim()) lines.push(s.instructions.trim().slice(0, 1800));
    if (s.doc?.excerpt) lines.push(`Reference excerpt from "${s.doc.name}":\n${s.doc.excerpt.slice(0, 2500)}`);
  }
  const summary = describeDirectives(d);
  if (summary.length) lines.push(`\nSTRUCTURED DIRECTIVES (binding): ${summary.join(' · ')}`);
  if (d.banned?.length) lines.push(`Never use these words or phrases: ${d.banned.join(', ')}.`);
  if (d.mustInclude?.length) lines.push(`Work these in naturally where relevant: ${d.mustInclude.join(', ')}.`);
  if (d.facts?.length) lines.push(`Proof points you may cite (do not invent others): ${d.facts.join(' | ')}`);
  return lines.join('\n');
}

// ───────────── Art direction for image and video models ─────────────

const VISUAL_WORDS = /\b(images?|imagery|photos?|photograph\w*|pictures?|visuals?|videos?|footage|clips?|scenes?|shots?|camera|lighting|light|daylight|colou?rs?|palette|backgrounds?|props?|wardrobe|outfits?|people|persons?|faces?|models?|diverse|diversity|settings?|locations?|show|showing|depict\w*|illustrations?|aesthetic|mood|composition|close-ups?|filters?)\b/i;
// the app sets all on-image words itself, and text rules belong to the copy, not the picture
const TEXT_WORDS = /\b(write|writing|written|copy|captions?|headlines?|hashtags?|emojis?|words?|phrases?|sentences?|tone|alt text|fonts?|typograph\w*|lettering|logos?|text|cta|subject lines?|emails?|reading level|grade level)\b/i;

export interface VisualBrief {
  /** short art direction for an image or video model, '' when no skill speaks to visuals */
  text: string;
  skills: Skill[];
}

/**
 * Art direction from the Brain for image and video models. Visual-style skills count in full;
 * other skills only for their sentences about imagery. Anything about words or text is left out:
 * those models are told to draw no text at all.
 */
export function visualBrief(all: Skill[], scope: ModuleScope, useBrain = true, maxChars = 600): VisualBrief {
  if (!useBrain) return { text: '', skills: [] };
  const parts: string[] = [];
  const used: Skill[] = [];
  let total = 0;
  for (const skill of all.filter((k) => skillApplies(k, scope)).sort((a, b) => b.priority - a.priority)) {
    const sentences = (skill.instructions.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]?/g) || []).map((x) => x.trim()).filter((x) => x.length > 8 && !/^avoid words\s*:/i.test(x));
    const keep = sentences.filter((x) => !TEXT_WORDS.test(x) && (skill.category === 'visual' || VISUAL_WORDS.test(x)));
    // whole sentences only, up to ~300 characters per skill and maxChars overall
    const picked: string[] = [];
    let len = 0;
    for (const x of keep) {
      const sentence = /[.!?]$/.test(x) ? x : `${x}.`;
      if (len + sentence.length > 300 || total + len + sentence.length > maxChars) break;
      picked.push(sentence);
      len += sentence.length + 1;
    }
    if (!picked.length) continue;
    parts.push(picked.join(' '));
    used.push(skill);
    total += len;
  }
  return { text: parts.join(' '), skills: used };
}

// ───────────── Applying directives to generated text ─────────────

const SOFTER: Record<string, string> = {
  cheap: 'affordable',
  guaranteed: 'designed',
  guarantee: 'promise',
  'act now': 'join today',
  'click here': 'tap the link',
  insane: 'remarkable',
  crazy: 'surprising',
  guys: 'everyone',
  hack: 'shortcut',
  hacks: 'shortcuts',
  secret: 'method',
  secrets: 'methods',
  'buy now': 'get yours',
  'limited time': 'this week',
  synergy: 'teamwork',
  leverage: 'use',
  unlock: 'open up',
  'game-changer': 'big step forward',
  'game changer': 'big step forward',
  revolutionary: 'new',
  'get rich': 'grow your income',
  'passive income': 'recurring income',
  overnight: 'quickly',
  lame: 'dull',
  'no-brainer': 'easy choice',
  'world-class': 'carefully built',
  'best in the world': 'thoughtfully made',
  discount: 'savings',
  deal: 'offer',
  sale: 'offer',
  free: 'complimentary',
};

const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍(?:\p{Extended_Pictographic}))*/gu;

export function stripEmoji(s: string): string {
  return s
    .replace(EMOJI_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n +/g, '\n')
    .trim();
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyBanned(s: string, banned: string[] | undefined): string {
  if (!banned?.length || !s) return s;
  let out = s;
  for (const raw of banned) {
    const w = raw.trim();
    if (!w) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}#])(${escapeRe(w)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    const repl = SOFTER[w.toLowerCase()];
    out = out.replace(re, (_m, pre: string, word: string) => {
      if (!repl) return pre;
      const cased = word[0] === word[0].toUpperCase() ? repl.charAt(0).toUpperCase() + repl.slice(1) : repl;
      return pre + cased;
    });
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?;:])/g, '$1');
}

/** Final pass over any generated text: banned words, emoji policy. */
export function polishText(s: string, d: Directives): string {
  if (typeof s !== 'string' || !s) return s;
  let out = applyBanned(s, d.banned);
  if (d.emoji === 'none') out = stripEmoji(out);
  return out;
}

export function polishDeep<T>(value: T, d: Directives): T {
  if (!d.banned?.length && d.emoji !== 'none') return value;
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      // never rewrite identifiers, urls, colors or code
      if (key && /(^id$|Id$|url|Url|slug|color|html|css|js|script|icon|style|format|platform|status|type|kind|svg)/.test(key)) return v;
      return polishText(v, d);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = walk(val, k);
      return o;
    }
    return v;
  };
  return walk(value) as T;
}

// ───────────── Feedback → learned preferences ─────────────

export const FEEDBACK_REASONS: { id: string; label: string; patch: Directives; note: string }[] = [
  { id: 'too-long', label: 'Too long', patch: { length: 'short' }, note: 'Keep outputs short and skimmable.' },
  { id: 'too-short', label: 'Too short', patch: { length: 'long' }, note: 'Give more detail and depth.' },
  { id: 'too-salesy', label: 'Too salesy', patch: { tone: 'friendly', banned: ['buy now', 'limited time', 'act now', "don't miss out"] }, note: 'Lead with value; keep the pitch soft.' },
  { id: 'too-formal', label: 'Too formal', patch: { tone: 'friendly' }, note: 'Sound like a real person talking.' },
  { id: 'too-casual', label: 'Too casual', patch: { tone: 'professional', emoji: 'none' }, note: 'Keep it polished and credible.' },
  { id: 'more-emoji', label: 'More emojis', patch: { emoji: 'heavy' }, note: 'Use emojis generously.' },
  { id: 'less-emoji', label: 'Fewer emojis', patch: { emoji: 'none' }, note: 'Skip emojis.' },
  { id: 'off-brand', label: 'Off-brand', patch: {}, note: 'Match the brand voice and audience more closely.' },
  { id: 'generic', label: 'Too generic', patch: { readingLevel: 'standard' }, note: 'Be specific: use concrete numbers, names and examples from the niche.' },
  { id: 'weak-hook', label: 'Weak hook', patch: { hookStyle: 'contrarian' }, note: 'Open with a sharper, pattern-interrupting hook.' },
];

export function newSkill(partial: Partial<Skill> & Pick<Skill, 'name'>): Skill {
  const now = Date.now();
  return {
    id: uid('skill'),
    category: 'voice',
    description: '',
    instructions: '',
    scope: ['all'],
    priority: 2,
    enabled: true,
    directives: {},
    source: 'custom',
    stats: { applied: 0, up: 0, down: 0 },
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

/** Merge a feedback patch into the learned-preferences skill (creating it if needed). */
export function learnFromFeedback(skills: Skill[], reasons: string[], freeText: string, scope: string): Skill[] {
  const picked = FEEDBACK_REASONS.filter((r) => reasons.includes(r.id));
  if (!picked.length && !freeText.trim()) return skills;
  const existing = skills.find((s) => s.source === 'feedback');
  const base: Skill =
    existing ??
    newSkill({
      name: 'Learned preferences',
      category: 'learned',
      description: 'Built automatically from your thumbs-down feedback.',
      scope: ['all'],
      priority: 3,
      source: 'feedback',
    });
  let directives: Directives = { ...base.directives };
  for (const r of picked) {
    for (const [k, v] of Object.entries(r.patch) as [keyof Directives, unknown][]) {
      if (Array.isArray(v)) {
        const prev = (directives[k] as string[] | undefined) ?? [];
        directives = { ...directives, [k]: uniq([...prev, ...(v as string[])]) };
      } else {
        directives = { ...directives, [k]: v };
      }
    }
  }
  const parsed = parseDirectives(freeText);
  directives = { ...directives, ...stripEmpty(parsed) };
  const notes = picked.map((r) => `- ${r.note}`);
  if (freeText.trim()) notes.push(`- (${scope}) ${freeText.trim()}`);
  const instructions = [base.instructions.trim(), ...notes].filter(Boolean).join('\n').split('\n').slice(-24).join('\n');
  const updated: Skill = { ...base, directives, instructions, updatedAt: Date.now() };
  return existing ? skills.map((s) => (s.id === existing.id ? updated : s)) : [...skills, updated];
}

// ───────────── Brain strength ─────────────

export function brainStrength(skills: Skill[]): { score: number; covered: SkillCategory[]; tips: string[] } {
  const active = skills.filter((s) => s.enabled);
  const covered = uniq(active.map((s) => s.category));
  const core: SkillCategory[] = ['voice', 'audience', 'copywriting', 'offer', 'rules', 'knowledge'];
  const coreHits = core.filter((c) => covered.includes(c)).length;
  const depth = Math.min(1, active.reduce((s, x) => s + Math.min(1, x.instructions.length / 400), 0) / 6);
  const feedback = active.some((s) => s.source === 'feedback') ? 1 : 0;
  const score = Math.round(Math.min(100, (coreHits / core.length) * 60 + depth * 25 + feedback * 8 + Math.min(7, active.length)));
  const tips: string[] = [];
  if (!covered.includes('voice')) tips.push('Add a brand-voice skill so every caption and email sounds like you.');
  if (!covered.includes('audience')) tips.push('Describe your ideal customer so hooks and pains hit harder.');
  if (!covered.includes('knowledge')) tips.push('Upload a doc (FAQ, product notes, reviews) for real proof points.');
  if (!covered.includes('rules')) tips.push('Add words to avoid and claims you can’t make.');
  if (!covered.includes('offer')) tips.push('Teach the Brain how you package offers and guarantees.');
  if (!feedback) tips.push('Rate a few outputs: thumbs-down feedback trains learned preferences.');
  return { score, covered, tips };
}

// ───────────── Knowledge docs ─────────────

const STOP = new Set(
  'a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves also get got one two us can will just like make made use using used new way ways well much many may might must really thing things'.split(
    ' ',
  ),
);

export function extractKeywords(text: string, n = 12): string[] {
  const words = (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !STOP.has(w));
  const freq = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    freq.set(words[i], (freq.get(words[i]) || 0) + 1);
    if (i < words.length - 1) {
      const bi = `${words[i]} ${words[i + 1]}`;
      freq.set(bi, (freq.get(bi) || 0) + 1.6);
    }
  }
  return [...freq.entries()]
    .filter(([w, c]) => c >= 2 || w.includes(' '))
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .filter((w, i, arr) => !arr.slice(0, i).some((prev) => prev.includes(w)))
    .slice(0, n);
}

export function extractFacts(text: string, n = 6): string[] {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]/g) || [];
  return sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 220 && /(\d|since|founded|award|certified|licensed|guarantee|customers|clients|years)/i.test(s))
    .slice(0, n);
}

// ───────────── Skill library ─────────────

export interface LibrarySkill {
  libraryId: string;
  name: string;
  category: SkillCategory;
  description: string;
  instructions: string;
  scope: ModuleScope[];
  priority: 1 | 2 | 3;
  directives: Directives;
}

export const SKILL_LIBRARY: LibrarySkill[] = [
  {
    libraryId: 'authentic-imagery',
    name: 'Authentic, real-life imagery',
    category: 'visual',
    description: 'Real people and real use for AI photos and videos, not stock-photo poses.',
    instructions:
      'Show real, diverse people in everyday settings, not posed stock-photo models. Prefer natural daylight, candid moments and genuine expressions. Show the product or service in actual use. Avoid thumbs-up poses, forced smiles and cluttered backgrounds.',
    scope: ['social', 'studio', 'ads'],
    priority: 2,
    directives: {},
  },
  {
    libraryId: 'clean-product-visuals',
    name: 'Clean, premium product visuals',
    category: 'visual',
    description: 'Simple, uncluttered compositions with a calm brand palette.',
    instructions:
      'Keep compositions simple: one clear subject, generous empty space and soft shadows. Use a muted, cohesive palette built from the brand colors. Avoid busy patterns, neon effects and heavy filters.',
    scope: ['social', 'studio', 'ads'],
    priority: 2,
    directives: {},
  },
  {
    libraryId: 'scroll-stopping-hooks',
    name: 'Scroll-stopping hooks',
    category: 'social',
    description: 'First lines that interrupt the scroll in under two seconds.',
    instructions:
      'Open every post with a pattern interrupt: a contrarian take, a specific number, or a POV line.\nKeep the first line under 12 words.\nNever open with a greeting or the brand name.\nThe second line must promise a payoff the reader gets by continuing.',
    scope: ['social', 'ads'],
    priority: 3,
    directives: { hookStyle: 'contrarian', length: 'short' },
  },
  {
    libraryId: 'pas-copy',
    name: 'PAS copywriting',
    category: 'copywriting',
    description: 'Problem → Agitate → Solution for captions, emails and pages.',
    instructions:
      'Structure persuasive copy with PAS: name the problem in the customer’s words, agitate the cost of leaving it unsolved, then present the offer as the bridge. One clear CTA at the end.',
    scope: ['social', 'email', 'seo', 'ads'],
    priority: 2,
    directives: { framework: 'PAS' },
  },
  {
    libraryId: 'aida-sales',
    name: 'AIDA sales structure',
    category: 'copywriting',
    description: 'Attention → Interest → Desire → Action for direct-response copy.',
    instructions: 'Use AIDA for sales-driven content: grab attention, build interest with a concrete insight, create desire with a vivid outcome, then ask for one action.',
    scope: ['social', 'ads', 'seo'],
    priority: 2,
    directives: { framework: 'AIDA' },
  },
  {
    libraryId: 'value-stack',
    name: 'Irresistible value stack',
    category: 'offer',
    description: 'Stack bonuses, remove risk and anchor price against value.',
    instructions:
      'Present offers as a value stack: core offer, 3–4 bonuses that remove the next obstacle, and a strong guarantee.\nAlways show total value next to the price.\nBonuses should be fast to deliver and specific to the buyer’s next problem.\nPhrase guarantees as a confident promise, not legal fine print.',
    scope: ['studio', 'seo', 'email', 'store'],
    priority: 2,
    directives: {},
  },
  {
    libraryId: 'local-neighbor-voice',
    name: 'Friendly local neighbor voice',
    category: 'voice',
    description: 'Warm, community-first voice for local businesses.',
    instructions:
      'Sound like a trusted neighbor, not a corporation. Use “we” and mention the neighborhood or city by name when natural. Celebrate customers and staff by first name. Keep emojis light. Sign off with a warm invitation to stop by.',
    scope: ['all'],
    priority: 2,
    directives: { tone: 'friendly', person: 'we', emoji: 'light' },
  },
  {
    libraryId: 'luxury-minimal',
    name: 'Luxury minimal voice',
    category: 'voice',
    description: 'Refined and restrained. Fewer words, more weight.',
    instructions: 'Write with restraint: short sentences, precise words, no exclamation marks. Never use emojis. Avoid discount language entirely.\nAvoid words: cheap, deal, discount, bargain, hurry.',
    scope: ['all'],
    priority: 2,
    directives: { tone: 'luxury', emoji: 'none', length: 'short', banned: ['cheap', 'deal', 'discount', 'bargain', 'hurry'] },
  },
  {
    libraryId: 'genz-casual',
    name: 'Gen-Z casual voice',
    category: 'voice',
    description: 'Playful, lowercase-friendly, emoji-forward.',
    instructions: 'Keep it playful and casual like texting a friend. Short lines. Lots of emojis. Self-aware humor is welcome. Never sound corporate.',
    scope: ['social', 'ads'],
    priority: 2,
    directives: { tone: 'playful', emoji: 'heavy', length: 'short', hookStyle: 'pov' },
  },
  {
    libraryId: 'b2b-authority',
    name: 'Data-led B2B voice',
    category: 'voice',
    description: 'Credible, specific, numbers-first for business buyers.',
    instructions: 'Write for busy decision makers. Lead with a number or outcome. No emojis. Prefer concrete metrics, timelines and process over adjectives. One idea per paragraph.',
    scope: ['all'],
    priority: 2,
    directives: { tone: 'authoritative', emoji: 'none', hookStyle: 'stat', readingLevel: 'expert' },
  },
  {
    libraryId: 'founder-story',
    name: 'Founder storytelling',
    category: 'voice',
    description: 'First-person stories that build trust.',
    instructions: 'Write in first person as the founder. Open with a short, specific moment (a client call, a mistake, a breakthrough). Close with the lesson and an invitation.',
    scope: ['social', 'email'],
    priority: 2,
    directives: { person: 'i', hookStyle: 'story' },
  },
  {
    libraryId: 'local-seo',
    name: 'Local SEO expert',
    category: 'seo',
    description: 'Rank in the map pack and “near me” searches.',
    instructions:
      'Include the city and neighborhood in titles, H1 and the first paragraph. Use “near me” phrasing in FAQs. Keep name, address and phone consistent. Add LocalBusiness schema and service-area wording. Mention nearby landmarks when natural.',
    scope: ['seo', 'store', 'ads'],
    priority: 2,
    directives: { mustInclude: ['near me'] },
  },
  {
    libraryId: 'email-deliverability',
    name: 'Email deliverability rules',
    category: 'email',
    description: 'Inbox-friendly subject lines and bodies.',
    instructions:
      'Subject lines under 45 characters, no ALL CAPS, no more than one emoji. One primary CTA per email. Plain, personal tone with the reader’s first name.\nAvoid words: free money, act now, guaranteed, 100% free, click here, risk-free.',
    scope: ['email'],
    priority: 3,
    directives: { banned: ['free money', 'act now', 'guaranteed', '100% free', 'click here', 'risk-free'] },
  },
  {
    libraryId: 'no-hype',
    name: 'No-hype, compliance-safe claims',
    category: 'rules',
    description: 'Avoid income, health and result promises you can’t back up.',
    instructions:
      'Never promise specific income, weight loss, medical or legal outcomes. Use “designed to”, “helps you” and “many customers” instead of guarantees of results. Do not invent statistics or testimonials.\nAvoid words: get rich, guaranteed results, overnight, cure, passive income.',
    scope: ['all'],
    priority: 3,
    directives: { banned: ['get rich', 'guaranteed results', 'overnight', 'cure', 'passive income'] },
  },
  {
    libraryId: 'inclusive-language',
    name: 'Inclusive, accessible language',
    category: 'rules',
    description: 'Plain words, inclusive phrasing, alt-text minded.',
    instructions: 'Write in plain English at an 8th-grade level. Use inclusive phrasing (“everyone”, “folks”). Describe visuals so they work as alt text.\nAvoid words: guys, crazy, insane, lame.',
    scope: ['all'],
    priority: 2,
    directives: { readingLevel: 'simple', banned: ['guys', 'crazy', 'insane', 'lame'] },
  },
  {
    libraryId: 'short-form-video',
    name: 'Short-form video scripting',
    category: 'social',
    description: 'Hooks in the first 2 seconds, a cut every 3.',
    instructions: 'For video posts: hook on screen in the first 2 seconds, change the shot or text every 3 seconds, keep scripts under 35 seconds, end with a verbal CTA and on-screen text. Add burned-in captions.',
    scope: ['social', 'ads'],
    priority: 2,
    directives: { length: 'short' },
  },
  {
    libraryId: 'conversion-ctas',
    name: 'Conversion-focused CTAs',
    category: 'copywriting',
    description: 'Specific, benefit-led calls to action.',
    instructions: 'Every CTA names the benefit and the next step (“Get the checklist →”, “Book your spot”). Never use “click here” or “learn more” alone.\nCTA: Get started today →',
    scope: ['social', 'email', 'seo', 'ads'],
    priority: 2,
    directives: { cta: 'Get started today →', banned: ['click here'] },
  },
  {
    libraryId: 'social-proof-first',
    name: 'Social proof first',
    category: 'copywriting',
    description: 'Lead with results and real customer words.',
    instructions: 'When proof exists, open with it: a customer result, a review quote or a milestone. Quote customers in their own words. Use real numbers only.',
    scope: ['social', 'seo', 'ads', 'email'],
    priority: 2,
    directives: { hookStyle: 'stat' },
  },
];

export function skillFromLibrary(lib: LibrarySkill): Skill {
  return newSkill({
    name: lib.name,
    category: lib.category,
    description: lib.description,
    instructions: lib.instructions,
    scope: lib.scope,
    priority: lib.priority,
    directives: lib.directives,
    source: 'library',
    libraryId: lib.libraryId,
  });
}
