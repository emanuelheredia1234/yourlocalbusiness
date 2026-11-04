// The assistant's brand group: the brand kit, the Brain (skills, the library, knowledge documents,
// ratings, the playground), the brand voice Manus learns from a social profile, analytics, the
// Marketplace, product ideas, and projects (new, delete, backup). Each tool does what its page's button
// does, through the same functions (src/lib/brandSave, kpis, marketplace, backup, projectActions;
// src/ai/brainSkills; src/store/voice).

import type { Brand, ModuleScope, Project, Skill, SkillCategory, SocialPlatform } from '@/lib/types';
import { beginBusy, busyId, busyJobs, endBusy } from '@/lib/busy';
import { ensureUrl, fmtRelative, listJoin, plural, readFileAsText, uniq } from '@/lib/utils';
import { backupFileName, backupJson } from '@/lib/backup';
import { brandCopyFrom, saveBrand } from '@/lib/brandSave';
import { refreshCommunity, startCommunitySync } from '@/lib/community';
import { computeKpis, countBy, postedSince } from '@/lib/kpis';
import { allListings, filterListings, listingCities, priceLabel } from '@/lib/marketplace';
import { useRuntime } from '@/lib/platform';
import { deleteProjectEverywhere, startNewProject } from '@/lib/projectActions';
import { CATEGORY_META, FEEDBACK_REASONS, SCOPE_META, SKILL_LIBRARY, describeDirectives, effectiveDirectives, newSkill, skillFromLibrary, templatePlaceholders, unfilledPlaceholders } from '@/ai/brain';
import { MAX_DOC, knowledgeDocSkill, playgroundSets } from '@/ai/brainSkills';
import { runTask, type RunResult } from '@/ai/engine';
import { FORMATS, FORMAT_LIST, PLATFORMS, SOCIAL_PLATFORMS } from '@/ai/knowledge';
import { paletteFrom } from '@/ai/local/brand';
import { VOICE_POSTS, profileTarget, sameProfile, voiceNetworkName, voiceSkillName, voiceSummary } from '@/ai/manusVoice';
import { brandKitTask, productIdeasTask, skillTestTask } from '@/ai/tasks';
import { getActiveProject, useStore } from '@/store/useStore';
import { isStartingVoiceRead, profileLabel, readVoice, setVoiceLearn, voiceOf, voiceReadRunning, voiceSkill, voiceSkillEdited } from '@/store/voice';
import { manusSetupHint } from '@/components/posts/ManusPost';
import { voiceErrorCopy } from '@/components/brand/SocialVoice';
import { runAITask } from '../aiTask';
import { downloadButton, fileButton, noteInChat } from '../buttons';
import { deleteConfirm, manusCard } from '../confirm';
import { activeProject } from '../lookup';
import { arg, clip, defineTool, untrusted, type AnyTool, type ChatButton, type ConfirmCardSpec, type ToolContext } from '../registry';
import { manusReadyNow } from '../workspace';

const SKILL_CATEGORIES = Object.keys(CATEGORY_META) as SkillCategory[];
const SCOPES = Object.keys(SCOPE_META) as ModuleScope[];
const PRIORITY = { low: 1, normal: 2, high: 3 } as const;
const PRIORITY_NAME = { 1: 'low', 2: 'normal', 3: 'high' } as const;
const SOURCE: Record<Skill['source'], string> = { custom: 'you', library: 'library', feedback: 'your ratings', document: 'a document', social: 'your posts (Manus)' };
const FORMAT_IDS = FORMAT_LIST.map((f) => f.id);
const FEEDBACK_IDS = FEEDBACK_REASONS.map((r) => r.id);

const s = () => useStore.getState();
const words = (n: number, one: string, many?: string) => plural(n, one, many);
/** Text cut to `max` characters, keeping its lines (skill text is one idea per line). */
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const projectName = (id: string | undefined) => s().projects.find((p) => p.id === id)?.brand.name || 'Untitled project';
const openInNewTab = (url: string) => {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
};

// ───────────── the brand kit ─────────────

const PROFILE = arg.string({ optional: true, allowEmpty: true, max: 200 });
const HEX = /^#[0-9a-f]{6}$/i;
const COPY_FIELDS = ['name', 'tagline', 'pitch', 'valueProp', 'audience', 'mission'] as const;
const FIELD_LABEL: Record<(typeof COPY_FIELDS)[number], string> = { name: 'name', tagline: 'tagline', pitch: 'pitch', valueProp: 'value proposition', audience: 'audience', mission: 'mission' };

/** A listed project's Marketplace listing is what was published: brand changes show there once it's updated. */
function listingLine(p: Project): string | undefined {
  return s().myListings.some((l) => l.projectId === p.id) ? 'The Marketplace listing still shows what was published: update it in Studio → Listing & publish to show these changes.' : undefined;
}

const updateBrand = defineTool({
  name: 'update_brand',
  class: 'L',
  summary: 'Change the brand kit: name, tagline, pitch, value proposition, audience, mission, personality, the owner’s own website, social profiles, colors.',
  args: {
    patch: arg.object({
      name: arg.string({ optional: true, min: 2, max: 80 }),
      tagline: arg.string({ optional: true, max: 160, allowEmpty: true }),
      pitch: arg.string({ optional: true, max: 600, allowEmpty: true }),
      valueProp: arg.string({ optional: true, max: 400, allowEmpty: true }),
      audience: arg.string({ optional: true, max: 400, allowEmpty: true }),
      mission: arg.string({ optional: true, max: 300, allowEmpty: true }),
      personality: arg.array(arg.string({ max: 40 }), { optional: true, max: 8 }),
      website: arg.string({ optional: true, max: 200, allowEmpty: true, desc: 'only a site the owner gave' }),
      socials: arg.object({ instagram: PROFILE, facebook: PROFILE, tiktok: PROFILE, linkedin: PROFILE, x: PROFILE, youtube: PROFILE }, { optional: true, desc: 'link or @handle; "" removes' }),
      colors: arg.object({ primary: arg.string({ optional: true, pattern: HEX }), secondary: arg.string({ optional: true, pattern: HEX }), accent: arg.string({ optional: true, pattern: HEX }) }, { optional: true, desc: '#RRGGBB' }),
    }),
  },
  validate: ({ patch: p }) => {
    const simple = Object.keys(p).filter((k) => k !== 'socials' && k !== 'colors');
    if (!simple.length && !Object.keys(p.socials ?? {}).length && !Object.keys(p.colors ?? {}).length) return 'Say what to change.';
    for (const [platform, raw] of Object.entries(p.socials ?? {}) as [SocialPlatform, string][]) {
      const t = raw ? profileTarget(platform, raw) : null;
      if (t && 'error' in t) return `${PLATFORMS[platform].label}: ${t.error}`;
    }
    if (p.website && !/^(https?:\/\/)?[^\s/@]+\.[a-z]{2,}(\/\S*)?$/i.test(p.website)) return 'The website must be a web address, like copperkettle.com.';
    return null;
  },
  run: ({ patch: p }) => {
    const project = activeProject();
    const b = project.brand;
    const next: Partial<Brand> = {};
    const changed: string[] = [];
    for (const k of COPY_FIELDS) {
      if (p[k] !== undefined && p[k] !== b[k]) {
        next[k] = p[k];
        changed.push(FIELD_LABEL[k]);
      }
    }
    if (p.personality) {
      next.personality = uniq(p.personality.filter(Boolean)).slice(0, 8);
      changed.push('personality');
    }
    if (p.website !== undefined) {
      next.websiteUrl = p.website ? ensureUrl(p.website) : '';
      changed.push('website');
    }
    const voiceNotes: string[] = [];
    const socials = Object.entries(p.socials ?? {}) as [SocialPlatform, string][];
    if (socials.length) {
      next.socials = { ...b.socials, ...p.socials };
      for (const [platform, raw] of socials) {
        changed.push(`${PLATFORMS[platform].label} profile`);
        const v = b.voiceFrom?.[platform];
        if (v?.report && !sameProfile(platform, v.profile, raw)) voiceNotes.push(`The ${voiceNetworkName(platform)} voice was learned from ${profileLabel(platform, v.profile)}: read the new profile to learn from it.`);
        if (voiceReadRunning(v)) voiceNotes.push(`Manus is reading the old ${voiceNetworkName(platform)} profile: nothing is learned from that read now.`);
      }
    }
    if (p.colors && Object.keys(p.colors).length) {
      next.colors = paletteFrom([p.colors.primary ?? b.colors.primary, p.colors.secondary ?? b.colors.secondary, p.colors.accent ?? b.colors.accent]);
      changed.push('colors');
    }
    if (!changed.length) return { data: { changed: [] }, note: 'Your brand already says that' };
    saveBrand(next);
    const now = activeProject().brand;
    return {
      data: {
        changed,
        brand: { name: now.name, tagline: clip(now.tagline, 120) || undefined, website: now.websiteUrl || null, socials: Object.fromEntries(Object.entries(now.socials).filter(([, v]) => v)), colors: next.colors ? { primary: now.colors.primary, secondary: now.colors.secondary, accent: now.colors.accent } : undefined },
        ...(voiceNotes.length ? { voice: voiceNotes } : {}),
        listing: listingLine(project),
      },
      note: `Updated your brand’s ${listJoin(changed)}`,
    };
  },
});

const refreshBrandCopy = defineTool({
  name: 'refresh_brand_copy',
  class: 'P-text',
  summary: 'Rewrite the brand copy with AI (tagline, pitch, value proposition, audience, personality, mission, name ideas). Keeps name, logo and colors; replaces the current copy.',
  args: {},
  validate: () => (busyJobs().some((j) => j.id.startsWith(`${brandKitTask.id}#`)) ? 'The brand kit is being written on its page right now: wait for it to finish.' : null),
  run: async (_a, ctx) => {
    const project = activeProject();
    const b = project.brand;
    const before = { tagline: b.tagline, pitch: b.pitch, valueProp: b.valueProp, audience: b.audience, personality: b.personality, mission: b.mission, nameOptions: b.nameOptions, domainIdeas: b.domainIdeas };
    const r = await runAITask(brandKitTask, {}, ctx);
    if (s().activeProjectId !== project.id) throw new Error('The project changed while the copy was being written, so nothing was applied.');
    const copy = brandCopyFrom(r.data);
    saveBrand(copy);
    const undo: ChatButton = {
      label: 'Put the old copy back',
      icon: 'check',
      run: () => {
        if (s().activeProjectId !== project.id) return noteInChat('Open that project again to put its old copy back.', false);
        saveBrand(before);
        noteInChat('Put your old brand copy back');
      },
    };
    return {
      data: {
        tagline: copy.tagline,
        pitch: clip(copy.pitch, 300),
        valueProp: clip(copy.valueProp, 200),
        audience: clip(copy.audience, 200),
        personality: copy.personality,
        mission: clip(copy.mission, 200),
        nameIdeas: copy.nameOptions.map((n) => n.name),
        kept: 'name, logo and colors',
        logId: r.logId,
        listing: listingLine(project),
      },
      note: 'Refreshed your brand copy (name, logo and colors kept)',
      buttons: [undo],
    };
  },
});

// ───────────── the Brain ─────────────

const findSkill = (id: string) => s().skills.find((k) => k.id === id);
const missingSkill = (id: string) => `There’s no skill with id "${id}". Use list_skills.`;
const skillsExist = ({ ids }: { ids: string[] }) => ids.map((id) => (findSkill(id) ? '' : missingSkill(id))).find(Boolean) || null;

/**
 * Blanks a skill's text must not keep: the Proof points template's placeholders (the skill editor refuses
 * those too), and any other [fill-in] left in text the AI wrote. Skill text goes into every output as true.
 */
function blanksIn(text: string | undefined): string | null {
  if (!text) return null;
  const template = templatePlaceholders(text);
  if (template.length) return `Replace ${listJoin(template)} with the owner’s real details, or leave those lines out: the AI uses skill text as true.`;
  const other = unfilledPlaceholders(text);
  if (other.length) return `The text still has blanks to fill in: ${listJoin(other.slice(0, 4))}. Ask the owner for the real details, or leave those lines out.`;
  return null;
}

const normScope = (scope: ModuleScope[] | undefined): ModuleScope[] => (!scope?.length || scope.includes('all') ? ['all'] : uniq(scope));

function skillLine(k: Skill, pid: string) {
  return {
    id: k.id,
    name: clip(k.name, 60),
    category: k.category,
    on: k.enabled,
    from: SOURCE[k.source],
    ...(k.priority !== 2 ? { priority: PRIORITY_NAME[k.priority] } : {}),
    ...(k.projectId ? { onlyFor: k.projectId === pid ? 'this project' : projectName(k.projectId) } : {}),
    used: k.stats.applied,
  };
}

function skillDetail(k: Skill, pid: string) {
  // documents and what Manus read come from outside the chat: shown as data
  const outside = k.source === 'document' || k.source === 'social';
  return {
    ...skillLine(k, pid),
    priority: PRIORITY_NAME[k.priority],
    appliesTo: k.scope,
    description: clip(k.description, 200) || undefined,
    instructions: outside ? untrusted(k.instructions, 1500) : cut(k.instructions, 1500),
    rules: describeDirectives(effectiveDirectives(k)),
    doc: k.doc ? { name: clip(k.doc.name, 80), keyTerms: k.doc.keywords.slice(0, 8) } : undefined,
    ratings: { up: k.stats.up, down: k.stats.down },
    lastUsed: k.stats.lastApplied ? fmtRelative(k.stats.lastApplied) : null,
  };
}

const listSkills = defineTool({
  name: 'list_skills',
  class: 'R',
  summary: 'The Brain’s skills: id, name, category, on or off, where it came from, project. With id: that skill in full (text, rules, ratings).',
  args: {
    id: arg.string({ optional: true, max: 80, desc: 'one skill in full' }),
    category: arg.enum(SKILL_CATEGORIES, { optional: true }),
    q: arg.string({ optional: true, max: 80, desc: 'words in its name or text' }),
  },
  validate: ({ id }) => (id && !findSkill(id) ? missingSkill(id) : null),
  run: ({ id, category, q }) => {
    const p = activeProject();
    const brain = s().settings.ai.useBrain ? 'on' : 'off (no skill is used until it’s on)';
    if (id) {
      const k = findSkill(id)!;
      return { data: { brain, skill: skillDetail(k, p.id) }, note: `Read the skill “${clip(k.name, 60)}”` };
    }
    const ql = q?.toLowerCase();
    const all = s().skills;
    const found = all
      .filter((k) => (!category || k.category === category) && (!ql || `${k.name} ${k.description} ${k.instructions}`.toLowerCase().includes(ql)))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.priority - a.priority || b.updatedAt - a.updatedAt);
    const shown = found.slice(0, 30).map((k) => skillLine(k, p.id));
    return { data: { brain, total: found.length, shown: shown.length, skills: shown }, note: `Looked at your Brain: ${words(all.length, 'skill')}, ${all.filter((k) => k.enabled).length} on` };
  },
});

const listSkillLibrary = defineTool({
  name: 'list_skill_library',
  class: 'R',
  summary: 'Ready-made skills the owner can add to the Brain: id, name, what it does, already added or not.',
  args: { category: arg.enum(SKILL_CATEGORIES, { optional: true }) },
  run: ({ category }) => {
    const installed = new Set(s().skills.map((k) => k.libraryId).filter(Boolean));
    const lib = SKILL_LIBRARY.filter((l) => !category || l.category === category);
    return {
      data: { total: lib.length, skills: lib.map((l) => ({ id: l.libraryId, name: l.name, category: l.category, about: clip(l.description, 70), added: installed.has(l.libraryId) })) },
      note: 'Looked at the skill library',
    };
  },
});

const addSkill = defineTool({
  name: 'add_skill',
  class: 'L',
  summary: 'Add a Brain skill in plain language (rules every AI output follows). Only what the owner said: no invented facts, no [blanks].',
  args: {
    name: arg.string({ min: 2, max: 80 }),
    category: arg.enum(SKILL_CATEGORIES),
    instructions: arg.string({ min: 10, max: 1800, desc: 'one idea per line' }),
    description: arg.string({ optional: true, max: 200 }),
    scope: arg.array(arg.enum(SCOPES), { optional: true, max: 10, desc: 'default all' }),
    priority: arg.enum(['low', 'normal', 'high'], { optional: true }),
    onlyThisProject: arg.boolean({ optional: true }),
  },
  validate: (a) => blanksIn(a.instructions) ?? blanksIn(a.description),
  run: (a) => {
    const p = activeProject();
    const skill = newSkill({ name: a.name, category: a.category, description: a.description ?? '', instructions: a.instructions, scope: normScope(a.scope), priority: PRIORITY[a.priority ?? 'normal'], ...(a.onlyThisProject ? { projectId: p.id } : {}) });
    s().addSkill(skill);
    return {
      data: { ...skillLine(skill, p.id), rules: describeDirectives(effectiveDirectives(skill)), ...(s().settings.ai.useBrain ? {} : { brain: 'off: no skill is used until it’s on' }) },
      note: `Added the skill “${clip(skill.name, 60)}” to the Brain`,
    };
  },
});

const addLibrarySkill = defineTool({
  name: 'add_library_skill',
  class: 'L',
  summary: 'Add skills from the skill library to the Brain (ids from list_skill_library).',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 10, desc: 'library ids' }) },
  validate: ({ ids }) => ids.map((id) => (SKILL_LIBRARY.some((l) => l.libraryId === id) ? '' : `There’s no library skill "${id}". Use list_skill_library.`)).find(Boolean) || null,
  run: ({ ids }) => {
    const installed = new Set(s().skills.map((k) => k.libraryId).filter(Boolean));
    const added: { id: string; name: string }[] = [];
    const already: string[] = [];
    for (const id of uniq(ids)) {
      const lib = SKILL_LIBRARY.find((l) => l.libraryId === id)!;
      if (installed.has(id)) {
        already.push(lib.name);
        continue;
      }
      const skill = skillFromLibrary(lib);
      s().addSkill(skill);
      added.push({ id: skill.id, name: skill.name });
    }
    const quoted = (xs: string[]) => listJoin(xs.map((x) => `“${x}”`));
    const note = added.length ? `Added ${quoted(added.map((x) => x.name))} to the Brain` : `${quoted(already)} ${already.length === 1 ? 'is' : 'are'} already in your Brain`;
    return { data: { added, alreadyInBrain: already }, note };
  },
});

const updateSkill = defineTool({
  name: 'update_skill',
  class: 'L',
  summary: 'Change a Brain skill: name, text, category, where it applies, priority, or turn it on or off.',
  args: {
    id: arg.string({ max: 80, desc: 'a skill id' }),
    name: arg.string({ optional: true, min: 2, max: 80 }),
    instructions: arg.string({ optional: true, min: 10, max: 1800 }),
    description: arg.string({ optional: true, max: 200, allowEmpty: true }),
    category: arg.enum(SKILL_CATEGORIES, { optional: true }),
    scope: arg.array(arg.enum(SCOPES), { optional: true, min: 1, max: 10 }),
    priority: arg.enum(['low', 'normal', 'high'], { optional: true }),
    on: arg.boolean({ optional: true }),
  },
  validate: (a) => {
    const k = findSkill(a.id);
    if (!k) return missingSkill(a.id);
    const { id: _id, ...change } = a;
    if (!Object.keys(change).length) return 'Say what to change.';
    const blanks = blanksIn(a.instructions) ?? blanksIn(a.description);
    if (blanks) return blanks;
    // as the Brain's switch: a skill still holding the template's placeholders stays off
    const unfilled = a.on ? templatePlaceholders(a.instructions ?? k.instructions) : [];
    return unfilled.length ? `Fill in this skill first: replace ${listJoin(unfilled)} with the owner’s real details, or delete those lines. The AI uses these facts as true.` : null;
  },
  run: (a) => {
    const p = activeProject();
    const k = findSkill(a.id)!;
    const patch: Partial<Skill> = {};
    const changed: string[] = [];
    if (a.name !== undefined) (patch.name = a.name), changed.push('name');
    if (a.instructions !== undefined) (patch.instructions = a.instructions), changed.push('text');
    if (a.description !== undefined) (patch.description = a.description), changed.push('description');
    if (a.category) (patch.category = a.category), changed.push('category');
    if (a.scope) (patch.scope = normScope(a.scope)), changed.push('where it applies');
    if (a.priority) (patch.priority = PRIORITY[a.priority]), changed.push('priority');
    if (a.on !== undefined) (patch.enabled = a.on), changed.push(a.on ? 'on' : 'off');
    s().updateSkill(k.id, patch);
    const now = findSkill(k.id)!;
    const onlyToggle = changed.length === 1 && a.on !== undefined;
    const voice = k.source === 'social' && (a.instructions !== undefined || a.description !== undefined) ? 'This is a brand voice Manus learned: since the owner edited it, a new read asks before replacing it.' : undefined;
    return {
      data: { ...skillLine(now, p.id), changed, rules: describeDirectives(effectiveDirectives(now)), ...(voice ? { voice } : {}) },
      note: onlyToggle ? `Turned ${a.on ? 'on' : 'off'} the skill “${clip(now.name, 60)}”` : `Updated the skill “${clip(now.name, 60)}”: ${listJoin(changed)}`,
    };
  },
});

const deleteSkill = defineTool({
  name: 'delete_skill',
  class: 'D',
  summary: 'Delete Brain skills (the owner confirms first).',
  args: { ids: arg.array(arg.string({ max: 80 }), { min: 1, max: 20, desc: 'skill ids' }) },
  validate: skillsExist,
  danger: ({ ids }) => deleteConfirm({ thing: 'skill', names: uniq(ids).map((id) => findSkill(id)!.name), extra: 'Future generations stop using them.' }),
  run: ({ ids }) => {
    const gone = uniq(ids).filter((id) => findSkill(id));
    const names = gone.map((id) => findSkill(id)!.name);
    for (const id of gone) s().deleteSkill(id);
    return { data: { deleted: gone.length, names }, note: gone.length === 1 ? `Deleted the skill “${clip(names[0], 60)}”` : `Deleted ${words(gone.length, 'skill')}` };
  },
});

const DOC_FILES = '.txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json';

const addKnowledgeDoc = defineTool({
  name: 'add_knowledge_doc',
  class: 'L',
  summary: 'Add the owner’s own document (FAQ, service menu, policies…) to the Brain; its facts and key terms shape outputs. Their text exactly as given, or no text for a file button.',
  args: {
    name: arg.string({ optional: true, max: 120, desc: 'e.g. Service FAQ' }),
    text: arg.string({ optional: true, max: 8000, desc: 'the owner’s text, unchanged' }),
    onlyThisProject: arg.boolean({ optional: true }),
  },
  validate: ({ text }) => (text !== undefined && !knowledgeDocSkill('', text, 0) ? 'That text is too short: the Brain needs at least a few sentences.' : null),
  run: ({ name, text, onlyThisProject }) => {
    const p = activeProject();
    const forProject = onlyThisProject ? p.id : undefined;
    if (text === undefined) {
      const pick = fileButton('Choose a text file', DOC_FILES, async (f) => {
        if (f.size > MAX_DOC) return noteInChat('That file is over 2 MB: split it, or paste the most useful parts in the chat.', false);
        const body = await readFileAsText(f).catch(() => null);
        if (body === null) return noteInChat('Couldn’t read that file. Try a plain-text file, or paste the text in the chat.', false);
        const skill = knowledgeDocSkill(name || f.name.replace(/\.[a-z0-9]+$/i, ''), body, f.size, forProject);
        if (!skill) return noteInChat('That document is too short: the Brain needs at least a few sentences.', false);
        s().addSkill(skill);
        noteInChat(`Added “${clip(skill.name, 60)}” to the Brain: ${words(skill.directives.facts?.length ?? 0, 'proof point')}, ${words(skill.doc?.keywords.length ?? 0, 'key term')}`);
      });
      return { data: { waiting: 'for the owner to choose a .txt, .md, .csv or .json file (up to 2 MB) with the button' }, note: 'Choose the document to add to the Brain', buttons: [pick] };
    }
    const skill = knowledgeDocSkill(name ?? '', text, new Blob([text]).size, forProject)!;
    s().addSkill(skill);
    const facts = skill.directives.facts ?? [];
    return {
      data: { id: skill.id, name: skill.name, proofPoints: facts.slice(0, 5).map((f) => clip(f, 140)), keyTerms: skill.doc?.keywords.slice(0, 8) ?? [], ...(forProject ? { onlyFor: 'this project' } : {}) },
      note: `Added “${clip(skill.name, 60)}” to the Brain: ${words(facts.length, 'proof point')}, ${words(skill.doc?.keywords.length ?? 0, 'key term')}`,
    };
  },
});

/** The generation to rate: the one named, or the latest one in this project. */
function generationFor(logId: string | undefined, projectId: string | undefined) {
  const log = s().genLog;
  return logId ? log.find((g) => g.id === logId) : log.find((g) => g.projectId === projectId);
}

const rateGeneration = defineTool({
  name: 'rate_generation',
  class: 'L',
  summary: 'Rate something the AI made, up or down (logId from a tool result; default: this project’s latest). Down needs reasons or a note: it teaches the Brain’s learned preferences.',
  args: {
    rating: arg.enum(['up', 'down']),
    logId: arg.string({ optional: true, max: 80 }),
    reasons: arg.array(arg.enum(FEEDBACK_IDS), { optional: true, max: FEEDBACK_IDS.length }),
    note: arg.string({ optional: true, max: 300, desc: 'what should change' }),
  },
  validate: ({ rating, logId, reasons, note }) => {
    if (!generationFor(logId, getActiveProject()?.id)) return logId ? `There’s no generation with id "${logId}" in the Brain’s activity log.` : 'Nothing was made with AI in this project yet.';
    return rating === 'down' && !reasons?.length && !note ? `Say what should change: reasons (${FEEDBACK_IDS.join(', ')}) or a note.` : null;
  },
  run: ({ rating, logId, reasons, note }) => {
    const g = generationFor(logId, activeProject().id)!;
    s().rateGeneration(g.id, rating === 'up' ? 1 : -1, reasons ?? [], note ?? '');
    const learned = rating === 'down' ? s().skills.find((k) => k.source === 'feedback') : undefined;
    return {
      data: { rated: g.label, made: fmtRelative(g.createdAt), rating, ...(learned ? { learnedSkill: { id: learned.id, rules: describeDirectives(effectiveDirectives(learned)) } } : {}) },
      note: rating === 'up' ? `Rated “${g.label}” as useful` : `Taught the Brain from your feedback on “${g.label}”`,
    };
  },
});

type Sample = 'caption' | 'email' | 'headline' | 'ad';
const SAMPLE_LABEL: Record<Sample, string> = { caption: 'social caption', email: 'sales email', headline: 'SEO title', ad: 'ad' };

/**
 * The playground's two runs, as the Brain page does them: the same task with the same variation, so only
 * the skills differ, and not saved (no activity log). An app-wide job; stops with the chat's Stop.
 */
async function playgroundRuns(sample: Sample, sets: { withSet: Skill[]; baseline: Skill[] }, ctx: ToolContext): Promise<[RunResult<{ text: string }>, RunResult<{ text: string }>]> {
  const st = s();
  const project = activeProject();
  const variation = Math.floor(Math.random() * 1000);
  const job = busyId(`assistant:${skillTestTask.id}`);
  beginBusy(job, skillTestTask.label, 'app');
  ctx.stage('Writing two samples to compare…');
  try {
    const opts = (skills: Skill[]) => ({ project, skills, settings: st.settings, variation, signal: ctx.signal });
    const runs = await Promise.all([runTask(skillTestTask, { sample }, opts(sets.withSet)), runTask(skillTestTask, { sample }, opts(sets.baseline))]);
    for (const r of runs) ctx.ai.push({ task: skillTestTask.id, label: skillTestTask.label, provider: r.provider, ...(r.note ? { note: r.note } : {}) });
    return runs;
  } finally {
    endBusy(job);
  }
}

const brainTest = defineTool({
  name: 'brain_test',
  class: 'P-text',
  summary: 'Write one sample with and without the Brain (or without one skill) to see what the skills change. 2 AI requests; nothing is saved.',
  args: { sample: arg.enum(['caption', 'email', 'headline', 'ad']), without: arg.string({ optional: true, max: 80, desc: 'a skill id: compare without just that skill' }) },
  validate: ({ without }) => {
    if (without && !findSkill(without)) return missingSkill(without);
    return s().settings.ai.useBrain ? null : 'The Brain is off, so both samples would be the same. Ask the owner whether to turn it on (set_preferences useBrain).';
  },
  run: async ({ sample, without }, ctx) => {
    const sets = playgroundSets(s().skills, without ?? null);
    const [a, b] = await playgroundRuns(sample, sets, ctx);
    const textA = a.data.text.trim();
    const textB = b.data.text.trim();
    const what = sets.target ? `without “${clip(sets.target.name, 60)}”` : 'without any skills';
    return {
      data: { sample: SAMPLE_LABEL[sample], withBrain: { skillsUsed: a.skills.length, text: cut(textA, 700) }, compare: { what, text: cut(textB, 700) }, same: textA === textB, saved: 'nothing (playground runs stay out of the project and the activity log)' },
      note: `Wrote a ${SAMPLE_LABEL[sample]} with your Brain and ${what}${textA === textB ? ': the same result' : ''}`,
    };
  },
});

// ───────────── brand voice (Manus reads a social profile) ─────────────

/** Turning learning on reads the profile with Manus, unless a read is running or the same profile was read already. */
function onStartsRead(p: Project | null, platform: SocialPlatform): boolean {
  if (!p) return false;
  const v = p.brand.voiceFrom?.[platform];
  return !voiceReadRunning(v) && !(v?.report && sameProfile(platform, v.profile, p.brand.socials[platform]));
}

/** What's missing before Manus can read the profile ('' when nothing is). */
function profileProblem(p: Project, platform: SocialPlatform): string {
  const name = voiceNetworkName(platform);
  if (isStartingVoiceRead(p.id, platform)) return `A read of the ${name} profile is starting right now.`;
  const raw = p.brand.socials[platform] ?? '';
  if (!raw.trim()) return `Add the ${name} profile first (update_brand with patch.socials.${platform}).`;
  const t = profileTarget(platform, raw);
  return t && 'error' in t ? t.error : '';
}

const notReady = () => `Manus can’t read the posts yet: it uses the same Manus setup as posting. ${manusSetupHint()}`;

/** What the owner sees on the card before Manus reads a profile. */
function voiceCard(platform: SocialPlatform, again: boolean, replace = false): ConfirmCardSpec {
  const p = getActiveProject();
  const name = voiceNetworkName(platform);
  const label = profileLabel(platform, p?.brand.socials[platform]) || `your ${name} profile`;
  return manusCard({
    title: again ? `Read your ${name} posts again?` : `Learn your brand voice from ${name}?`,
    what: `Manus opens ${label} in its own browser and reads its ${VOICE_POSTS} latest posts. It only reads: it never posts, likes, follows, comments or messages. What it learns becomes a Brain skill for this project${replace ? ', replacing your edits to that skill' : ''}. Manus may ask you to sign in the first time.`,
    cost: 'One Manus task on your Manus credits. It usually takes a few minutes.',
    confirmLabel: again ? 'Read again' : 'Start reading',
  });
}

/** Why a read didn't start, as the profile's switch says it (an uncertain start: check Manus before trying again). */
function readFailure(e: unknown): Error {
  const c = voiceErrorCopy(e);
  return new Error(`${c.title.replace(/[.!]$/, '')}. ${c.body}`);
}

function watchButton(url: string | undefined): ChatButton[] {
  return url ? [{ label: 'Watch in Manus', icon: 'open', run: () => openInNewTab(url) }] : [];
}

function voiceRow(p: Project, platform: SocialPlatform) {
  const v = p.brand.voiceFrom?.[platform];
  const raw = p.brand.socials[platform] ?? '';
  const skill = voiceSkill(p.id, platform);
  const task = v?.task;
  return {
    platform,
    profile: raw.trim() ? profileLabel(platform, raw) : null,
    learning: !!v?.learn,
    read: task ? task.state : v?.report ? 'done' : 'never',
    ...(task && voiceReadRunning(v) ? { started: fmtRelative(task.requestedAt) } : {}),
    // Manus's own words (why it stopped, what it needs): data only
    ...(task?.message && task.state !== 'working' && task.state !== 'done' ? { manusSays: untrusted(task.message, 200) } : {}),
    ...(v?.report ? { learned: untrusted(voiceSummary(v.report), 200), from: profileLabel(platform, v.profile), postsRead: v.postsRead ?? null, when: v.analyzedAt ? fmtRelative(v.analyzedAt) : null } : {}),
    ...(v?.report && raw.trim() && !sameProfile(platform, v.profile, raw) ? { profileChangedSince: true } : {}),
    ...(skill ? { skill: { id: skill.id, name: skill.name, on: skill.enabled, editedByOwner: voiceSkillEdited(p.id, platform) } } : {}),
    ...(v?.keptEdits ? { newerReadNotUsed: 'the owner had edited the skill, so the last read was kept aside' } : {}),
  };
}

const getVoiceStatus = defineTool({
  name: 'get_voice_status',
  class: 'R',
  summary: 'The brand voice Manus learns from social profiles: per profile, learning on or off, the read (working, done, failed…), what it learned, its Brain skill; and whether Manus is ready.',
  args: {},
  run: () => {
    const p = activeProject();
    const rows = SOCIAL_PLATFORMS.filter((pl) => (p.brand.socials[pl] ?? '').trim() || p.brand.voiceFrom?.[pl]).map((pl) => voiceRow(p, pl));
    const on = rows.filter((r) => r.learning).length;
    return {
      data: { manus: manusReadyNow() ? 'ready' : `not set up: ${manusSetupHint()}`, brain: s().settings.ai.useBrain ? 'on' : 'off (learned voices aren’t used until it’s on)', profiles: rows, ...(rows.length ? {} : { none: 'No social profiles yet: add them with update_brand (patch.socials).' }) },
      note: rows.length ? `Checked your brand voice: ${on ? `learning from ${words(on, 'profile')}` : 'not learning from any profile'}` : 'Checked your brand voice: no social profiles yet',
    };
  },
});

const setVoiceLearning = defineTool({
  name: 'set_voice_learning',
  class: 'P-media',
  summary: '“Learn my brand voice” for a social profile. On: Manus reads its latest posts (the owner confirms a card) unless it read them already; off: its Brain skill stops being used (kept).',
  args: { platform: arg.enum(SOCIAL_PLATFORMS), on: arg.boolean() },
  validate: ({ platform, on }) => {
    const p = activeProject();
    if (!on) return null;
    const problem = profileProblem(p, platform);
    if (problem) return problem;
    return onStartsRead(p, platform) && !manusReadyNow() ? notReady() : null;
  },
  // only a new read is a Manus task (asks first); off, or turning a profile Manus already read back on, runs at once
  media: ({ platform, on }) => (on && onStartsRead(getActiveProject(), platform) ? 'manus' : 'image'),
  card: ({ platform }) => voiceCard(platform, false),
  run: async ({ platform, on }) => {
    const p = activeProject();
    const name = voiceNetworkName(platform);
    if (!on && !voiceOf(p.id, platform)?.learn) return { data: { platform, learning: false }, note: `Learning your ${name} voice was already off` };
    let r: Awaited<ReturnType<typeof setVoiceLearn>>;
    try {
      r = await setVoiceLearn(p.id, platform, on);
    } catch (e) {
      throw readFailure(e);
    }
    const v = voiceOf(p.id, platform);
    const profile = profileLabel(platform, p.brand.socials[platform]);
    switch (r) {
      case 'off':
        return { data: { platform, learning: false, skill: 'switched off and kept: turning learning back on costs nothing' }, note: `Stopped using your ${name} voice (its Brain skill is kept)` };
      case 'reused':
        return { data: { platform, learning: true, read: 'not needed: what Manus learned from this profile applies again' }, note: `Your ${name} voice is back on` };
      case 'reading':
        return { data: { platform, learning: true, read: 'Manus is still reading this profile' }, note: `Learning your ${name} voice: Manus is still reading it` };
      default:
        return {
          data: { platform, learning: true, read: 'started', profile, next: 'The app checks every 45 seconds while it’s open; what Manus learns becomes this project’s Brain skill.' },
          note: `Manus is reading your ${name} posts (it only reads; usually a few minutes)`,
          buttons: watchButton(v?.task?.taskUrl),
        };
    }
  },
});

const readVoiceNow = defineTool({
  name: 'read_voice_now',
  class: 'P-media',
  summary: 'Have Manus read a profile’s latest posts again, to refresh the learned voice (learning must be on). The owner confirms a card first; uses Manus credits.',
  args: { platform: arg.enum(SOCIAL_PLATFORMS), replace: arg.boolean({ optional: true, desc: 'the owner agreed to replace their edits to the learned skill' }) },
  validate: ({ platform, replace }) => {
    const p = activeProject();
    const name = voiceNetworkName(platform);
    const v = p.brand.voiceFrom?.[platform];
    if (!v?.learn) return `Learning the ${name} voice is off: turn it on with set_voice_learning (it reads the profile when needed).`;
    if (voiceReadRunning(v)) return `Manus is already reading the ${name} posts (started ${fmtRelative(v.task!.requestedAt)}).`;
    const problem = profileProblem(p, platform);
    if (problem) return problem;
    if (!manusReadyNow()) return notReady();
    if (voiceSkillEdited(p.id, platform) && !replace) return `The owner edited “${voiceSkillName(platform)}” in the Brain, and a new read replaces it. Ask the owner, then call again with replace: true.`;
    return null;
  },
  media: 'manus',
  card: ({ platform, replace }) => voiceCard(platform, true, !!replace),
  run: async ({ platform, replace }) => {
    const p = activeProject();
    const name = voiceNetworkName(platform);
    const before = voiceOf(p.id, platform)?.task?.taskId;
    try {
      await readVoice(p.id, platform, { replace: !!replace });
    } catch (e) {
      throw readFailure(e);
    }
    const task = voiceOf(p.id, platform)?.task;
    if (!task || task.taskId === before) return { ok: false, error: 'No new read started (another one may be starting). Check the profile in Settings → Brand.' };
    return {
      data: { platform, read: 'started', profile: profileLabel(platform, p.brand.socials[platform]), next: 'The app checks every 45 seconds while it’s open; the learned skill updates when Manus is done.' },
      note: `Manus is reading your ${name} posts again (it only reads; usually a few minutes)`,
      buttons: watchButton(task.taskUrl),
    };
  },
});

// ───────────── analytics ─────────────

const pct = (d: number | null) => (d === null ? 'new (none before)' : `${d >= 0 ? '+' : ''}${Math.round(d * 100)}%`);
const tally = <K extends string>(keys: K[]) => Object.fromEntries(countBy(keys).map((r) => [r.key, r.n]));

const getAnalytics = defineTool({
  name: 'get_analytics',
  class: 'R',
  summary: 'Real counts for the last N days (default 30), as Analytics shows them: posted (by Manus or marked), planned, due, made with AI, change vs the days before, by network, type and format.',
  args: { days: arg.number({ optional: true, int: true, min: 1, max: 365, desc: 'default 30' }) },
  run: ({ days = 30 }) => {
    const p = activeProject();
    const st = s();
    const k = computeKpis({ projectId: p.id, posts: st.posts, genLog: st.genLog }, days);
    const posted = postedSince(st.posts, p.id, k.since);
    const busy = k.series.filter((d) => d.posted || d.planned || d.made).slice(-14);
    return {
      data: {
        days,
        from: k.series[0].date,
        to: k.series[k.series.length - 1].date,
        posted: k.posted,
        byManus: k.byManus,
        markedByOwner: k.posted - k.byManus,
        plannedAhead: k.upcoming,
        due: k.due,
        madeWithAI: k.made,
        change: { posted: pct(k.delta.posted), madeWithAI: pct(k.delta.made), vs: `the ${days} days before` },
        postedBy: { network: tally(posted.map((x) => x.platform)), type: tally(posted.map((x) => x.postType)), format: tally(posted.map((x) => x.format)) },
        activeDays: busy.map((d) => ({ date: d.date, posted: d.posted, planned: d.planned, made: d.made })),
        latestPosted: posted.slice(0, 5).map((x) => ({ id: x.id, platform: x.platform, headline: clip(x.headline, 70), at: x.publishedAt, by: x.publishedBy === 'manus' ? 'Manus' : 'owner', link: x.postUrl ?? null })),
        notTracked: 'Likes, views, clicks, followers and sales live on each network and checkout: the app doesn’t read or estimate them.',
      },
      note: `Checked your analytics for the last ${words(days, 'day')}: ${k.posted} posted, ${k.made} made with AI`,
    };
  },
});

// ───────────── the Marketplace ─────────────

/** The page's exact filter value for what the AI typed (any case): a format id or label, or a listing's category. */
function categoryValue(input: string, listings: ReturnType<typeof allListings>): string | null {
  const t = input.trim().toLowerCase();
  const format = FORMAT_LIST.find((f) => f.id === t || f.label.toLowerCase() === t || f.short.toLowerCase() === t);
  if (format) return format.id;
  return uniq(listings.map((l) => l.category)).find((c) => c.toLowerCase() === t) ?? null;
}

/** The page's location choices that match what the AI typed ("austin", "Austin, TX", "online"). */
function cityValues(input: string, cities: string[]): string[] {
  const t = input.trim().toLowerCase();
  const exact = cities.filter((c) => c.toLowerCase() === t);
  if (exact.length) return exact;
  return cities.filter((c) => c.split(',')[0].trim().toLowerCase() === t);
}

/** Wait for the shared Marketplace to load, as opening its page does (a few seconds at most). */
async function loadCommunity(signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 5000);
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  try {
    await Promise.race([startCommunitySync().then(() => refreshCommunity()), late]);
  } catch {
    /* offline: what's loaded already is listed */
  } finally {
    clearTimeout(timer);
  }
}

const listMarketplace = defineTool({
  name: 'list_marketplace',
  class: 'R',
  summary: 'Marketplace listings, the owner’s first, then the newest: filter by words, category, city or kind. Other sellers’ text comes back as untrusted data.',
  args: {
    q: arg.string({ optional: true, max: 80, desc: 'words' }),
    category: arg.string({ optional: true, max: 60, desc: 'a product format (pdf, course…) or a business category' }),
    city: arg.string({ optional: true, max: 60, desc: 'a city, or Online' }),
    kind: arg.enum(['product', 'business'], { optional: true }),
    limit: arg.number({ optional: true, int: true, min: 1, max: 20, desc: 'default 10' }),
  },
  run: async (a, ctx) => {
    ctx.stage('Loading the Marketplace…');
    await loadCommunity(ctx.signal);
    const p = activeProject();
    const all = allListings();
    const shared = useRuntime.getState().community === 'live';
    const cities = listingCities(all);
    const cat = a.category ? categoryValue(a.category, all) : undefined;
    const places = a.city ? cityValues(a.city, cities) : undefined;
    let found: typeof all = [];
    if (cat !== null && (!places || places.length)) {
      const base = { q: a.q, kind: a.kind ?? 'all', cat: cat ?? undefined } as const;
      found = places ? filterListings(all, base).filter((l) => places.some((c) => filterListings([l], { city: c }).length)) : filterListings(all, base);
    }
    const shown = found.slice(0, a.limit ?? 10).map((l) => {
      const place = l.kind === 'business' && l.location ? (l.location.online && !l.location.lat ? 'Online' : `${l.location.city}${l.location.region ? `, ${l.location.region}` : ''}`) : undefined;
      if (l.origin === 'mine') return { id: l.id, yours: true, kind: l.kind, title: clip(l.title, 90), category: l.category, place, price: priceLabel(l.price, l.priceModel), project: l.projectId === p.id ? 'this project' : projectName(l.projectId) };
      const text = [`${l.title}${l.tagline ? ` — ${l.tagline}` : ''}`, clip(l.description, 160), `Seller: ${l.seller.name}`, `Category: ${l.category}`, place ? `Where: ${place}` : '', `Price: ${priceLabel(l.price, l.priceModel)}`].filter(Boolean).join('. ');
      return { id: clip(l.id, 64), yours: false, kind: l.kind === 'business' ? 'business' : 'product', listing: untrusted(text, 360) };
    });
    return {
      data: {
        shared: shared ? 'yes: everyone who uses the app sees published listings' : 'no: only the owner’s own listings show here',
        total: found.length,
        shown: shown.length,
        listings: shown,
        ...(cat === null ? { categoryNotFound: `No listing has the category “${a.category}”. Formats: ${FORMAT_IDS.join(', ')}.` } : {}),
        ...(places && !places.length ? { cityNotFound: `No business is listed in “${a.city}”. Places with listings: ${cities.slice(0, 15).join('; ') || 'none'}.` } : {}),
      },
      note: `Looked at the Marketplace: ${words(found.length, 'listing')} found`,
    };
  },
});

// ───────────── product ideas ─────────────

const productIdeas = defineTool({
  name: 'product_ideas',
  class: 'P-text',
  summary: 'Suggest 3-5 digital product ideas for a niche, a specific category and a format (defaults: the project’s). Ideas only: nothing in the project changes; prices are suggestions.',
  args: {
    niche: arg.string({ optional: true, max: 80 }),
    category: arg.string({ optional: true, max: 80, desc: 'specific, e.g. Freelancer Tax Tracking' }),
    format: arg.enum(FORMAT_IDS, { optional: true }),
    count: arg.number({ optional: true, int: true, min: 3, max: 5 }),
  },
  validate: (a) => {
    const p = activeProject();
    const niche = (a.niche ?? p.niche).trim();
    const category = (a.category ?? p.category).trim();
    return niche.length < 2 || category.length < 2 || !(a.format ?? p.format) ? `Say the niche, a specific category and the format (${FORMAT_IDS.join(', ')}).` : null;
  },
  run: async (a, ctx) => {
    const p = activeProject();
    const niche = (a.niche ?? p.niche).trim();
    const category = (a.category ?? p.category).trim();
    const format = (a.format ?? p.format)!;
    // the project as the ideas are asked for (the project itself doesn't change)
    const r = await runAITask(productIdeasTask, { niche, category, format, count: a.count ?? 4 }, ctx, { project: { ...p, niche, category, format } });
    const ideas = r.data.map((i) => ({
      title: clip(i.title, 90),
      hook: clip(i.hook, 140),
      audience: clip(i.audience, 100),
      problem: clip(i.pain, 100),
      suggestedPrice: `${priceLabel(i.price, i.priceModel)}${i.priceModel === 'one-time' ? ' one-time' : ''}`,
      angle: clip(i.angle, 40),
      features: i.features.slice(0, 3).map((f) => clip(f, 80)),
    }));
    return {
      data: { niche, category, format: FORMATS[format].label, ideas, logId: r.logId, about: 'Suggestions only, from no market data: nothing in the project changed, and the owner sets real prices.' },
      note: `Suggested ${words(ideas.length, 'product idea')} for “${clip(category, 50)}”`,
    };
  },
});

// ───────────── projects ─────────────

const createProject = defineTool({
  name: 'create_project',
  class: 'L',
  summary: 'Start a new business or digital product project and open its setup (it becomes the open project; this chat stays here, so this ends your turn).',
  args: { track: arg.enum(['business', 'product']) },
  run: async ({ track }) => {
    const id = await startNewProject(track);
    if (!id) return { ok: false, error: 'The owner chose to stay (something is still generating).', note: 'Stayed here: something is still generating' };
    return { data: { projectId: id, track, next: 'Its setup is open; the owner finishes it there.' }, note: `Started a new ${track === 'business' ? 'business' : 'product'} project: its setup is open`, end: true };
  },
});

const deleteProject = defineTool({
  name: 'delete_project',
  class: 'D',
  summary: 'Delete another project with its posts, campaigns and Marketplace listing (the owner confirms first). Not the project this chat is in.',
  args: { id: arg.string({ max: 80, desc: 'a project id (list_projects)' }) },
  validate: ({ id }) => {
    const st = s();
    const p = st.projects.find((x) => x.id === id);
    if (!p) return `There’s no project with id "${id}". Use list_projects.`;
    if (id === st.activeProjectId) return `“${projectName(id)}” is the project this chat is in. To delete it, the owner switches to another project first, or deletes it in Settings → Projects & data.`;
    return null;
  },
  danger: ({ id }) => deleteConfirm({ thing: 'project', names: [projectName(id)], extra: 'Its posts, campaigns and Marketplace listing are removed too.' }),
  run: ({ id }) => {
    const name = projectName(id);
    deleteProjectEverywhere(id);
    return { data: { deleted: name }, note: `Deleted the project “${clip(name, 60)}”` };
  },
});

const exportBackup = defineTool({
  name: 'export_backup',
  class: 'R',
  summary: 'A button to download the workspace backup (.json; no images or videos). Importing a backup stays with the owner in Settings.',
  args: {},
  run: () => {
    const st = s();
    const file = backupFileName();
    return {
      data: { file, projects: st.projects.length, posts: st.posts.length, skills: st.skills.length, notIncluded: 'uploaded images and videos', button: 'the owner downloads it with the button in the chat' },
      note: 'Your backup is ready to download',
      buttons: [downloadButton('Download backup (.json)', file, () => backupJson())],
    };
  },
});

export const brandTools: AnyTool[] = [
  updateBrand,
  refreshBrandCopy,
  listSkills,
  listSkillLibrary,
  addSkill,
  addLibrarySkill,
  updateSkill,
  deleteSkill,
  addKnowledgeDoc,
  rateGeneration,
  brainTest,
  getVoiceStatus,
  setVoiceLearning,
  readVoiceNow,
  getAnalytics,
  listMarketplace,
  productIdeas,
  createProject,
  deleteProject,
  exportBackup,
];
