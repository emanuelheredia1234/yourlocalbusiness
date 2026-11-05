// "Guide my other tabs with this strategy": what Strategy writes, and where, only when the owner clicks and
// after a preview. Two project-bound Brain skills (social posts, the email funnel) whose notes sit in the
// skill's document excerpt (no rules, no art direction), a marked block in the SEO page's "Guide the AI"
// box, a patch to the campaign settings, and per-network link placement, each with a record to undo or
// spot the owner's own edits. Everything here is pure except the apply* writers at the end.
import type { CampaignConfig, LinkPlacement, PostPlatform, PostType, Project, Skill } from './types';
import type { AppliedRecord, OwnerFacts, StrategyContent, StrategyState } from './strategyTypes';
import { hashStr } from './utils';
import { useStore } from '@/store/useStore';
import { newSkill, parseDirectives } from '@/ai/brain';
import { PLATFORMS } from '@/ai/knowledge';
import { campaignProblem } from '@/ai/socialPlan';
import { LINK_PLACEMENTS, LINK_PLACEMENT_LABEL, placementFor } from './pageLink';
import { claimFree, noLinks, POST_NETWORKS, POST_TYPE_IDS } from './strategyNormalize';
import { CTA_LABEL, GOAL_LABEL, LEAD_MAGNET_LABEL, MIX_WORD, POST_TYPE_WORD, capStrategy, ownerFacts, readStrategy } from './strategy';

export type SkillArea = 'social' | 'email';

// ───────────── the two skills ─────────────

export const strategySkillId = (pid: string, area: SkillArea) => `skill_strategy_${pid}_${area}`.slice(0, 80);

const HEADER: Record<SkillArea, string> = {
  social: 'Direction from this project’s Strategy for social posts: recommendations, not facts about the business. Use the notes below where they fit. The project details and the other skills come first.',
  email: 'Direction from this project’s Strategy for the email funnel: recommendations, not facts about the business. Use the notes below where they fit. The project details and the other skills come first.',
};
export const SKILL_HEADER = HEADER;

/** The notes, one per line: links, emails and phones out, then claimFree, then trimmed; cut at `max` on a line boundary. */
export function cleanNotes(lines: string[], owner: OwnerFacts, max: number): string {
  const out: string[] = [];
  let len = 0;
  for (const raw of lines) {
    const line = claimFree(noLinks(raw.replace(/\s*\n\s*/g, ' '), 'drop'), owner).trim();
    if (!line) continue;
    if (len + line.length + (out.length ? 1 : 0) > max) break;
    out.push(line);
    len += line.length + (out.length > 1 ? 1 : 0);
  }
  return out.join('\n');
}

const end = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);
const netLabel = (n: string) => PLATFORMS[n as PostPlatform]?.label ?? n;

/** Notes for social posts: who to talk to, the angle, the pillars, what works on each network, the mix and the links. Recommendations only (never findings, sources or prices). */
export function socialNotes(s: StrategyState): string[] {
  const out: string[] = [];
  const pr = s.promote;
  const c = s.content;
  if (pr?.positioning.who) out.push(`Who to talk to: ${end(pr.positioning.who)}`);
  if (pr?.positioning.line) out.push(`Angle: ${end(pr.positioning.line)}`);
  for (const p of c?.pillars ?? []) out.push(`Content pillars: ${p.name}${p.why ? `: ${end(p.why)}` : '.'}`);
  for (const f of c?.formats ?? []) out.push(`On ${netLabel(f.platform)}: ${end(f.what)}`);
  if (c) {
    const top = POST_TYPE_IDS.filter((t) => c.campaign.postMix[t] >= 2).sort((a, b) => c.campaign.postMix[b] - c.campaign.postMix[a]);
    if (top.length) out.push(`Post mix: more ${top.map((t) => POST_TYPE_WORD[t]).join(', ')}.`);
  }
  for (const [n, l] of Object.entries(pr?.links ?? {})) if (l) out.push(`Where the link goes: ${netLabel(n)}: ${LINK_PLACEMENT_LABEL[l.placement]}.`);
  return out;
}

/** Notes for the email funnel: the lead magnet idea, the welcome emails' angle, the questions to answer. */
export function emailNotes(s: StrategyState): string[] {
  const out: string[] = [];
  const e = s.outreach?.email;
  if (e?.idea) out.push(`Lead magnet idea (${LEAD_MAGNET_LABEL[e.leadMagnetType]}): ${end(e.idea)}`);
  if (e?.welcomeAngle) out.push(`Welcome emails: ${end(e.welcomeAngle)}`);
  const q = s.assets?.seo.objections ?? [];
  if (q.length) out.push(`Questions to answer: ${end(q.join('; '))}`);
  return out;
}

/** When a skill's area was last written in Strategy (the sections its notes come from). */
export function areaAt(s: StrategyState, area: SkillArea): number {
  return area === 'social' ? Math.max(s.promote?.at ?? 0, s.content?.at ?? 0) : Math.max(s.outreach?.at ?? 0, s.assets?.at ?? 0);
}

/** The skill for one area of this project, as Strategy writes it. */
export function strategySkill(p: Project, area: SkillArea, s: StrategyState, at = Date.now()): Partial<Skill> & Pick<Skill, 'name'> {
  const excerpt = cleanNotes(area === 'social' ? socialNotes(s) : emailNotes(s), ownerFacts(p, s.inputs), 1500);
  return {
    name: area === 'social' ? 'Strategy · Social posts' : 'Strategy · Email funnel',
    category: area,
    description: `From your Strategy (${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}). Change it in Strategy, or turn it off here.`,
    instructions: HEADER[area],
    scope: [area],
    priority: 1,
    directives: {},
    doc: { name: `Strategy notes: ${area === 'social' ? 'social posts' : 'email funnel'}`, size: excerpt.length, keywords: [], excerpt },
    source: 'custom',
    libraryId: `strategy-${area}-${p.id}`,
    projectId: p.id,
  };
}

/** What the owner's edits change: the instructions, the notes, the scope and the rules. */
export const strategyFingerprint = (k: Pick<Skill, 'instructions' | 'directives' | 'doc' | 'scope'>) => hashStr(`${k.instructions}\n${k.doc?.excerpt ?? ''}\n${k.scope.join(',')}\n${JSON.stringify(k.directives ?? {})}`).toString(36);

/** Would the Brain read a rule (tone, CTA, length, banned or must-include words, audience…) out of this text? */
export const makesStrategyRule = (text: string) => Object.values(parseDirectives(`${text} zz zz`)).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0));

export type SkillRowState = 'none' | 'on' | 'off' | 'edited' | 'missing';

/** Where a skill row stands: not added, on, off in the Brain, changed there, or removed; and whether a copy is also in the Brain. */
export function skillState(pid: string, area: SkillArea, s: StrategyState, skills: Skill[]): { state: SkillRowState; copy: boolean; skill?: Skill; applied?: AppliedRecord; update: boolean } {
  const applied = s.applied[area];
  const id = strategySkillId(pid, area);
  const skill = skills.find((k) => k.id === id);
  const copy = skills.some((k) => k.id !== id && k.libraryId === `strategy-${area}-${pid}`);
  if (!applied) return { state: 'none', copy, update: false };
  if (!skill) return { state: 'missing', copy, applied, update: false };
  if (applied.written && strategyFingerprint(skill) !== applied.written) return { state: 'edited', copy, skill, applied, update: false };
  if (skill.enabled === false) return { state: 'off', copy, skill, applied, update: false };
  return { state: 'on', copy, skill, applied, update: applied.from < areaAt(s, area) };
}

// ───────────── the SEO page's guidance ─────────────

export const SEO_BLOCK_HEADER = 'From your Strategy (edit freely):';
export const SEO_GUIDE_MAX = 2000;

/** The block for the SEO page's "Guide the AI" box, from the strategy's direction for it (lines that come out empty are left out). */
export function seoBlock(s: StrategyState, p: Project): string {
  const seo = s.assets?.seo;
  if (!seo) return '';
  const owner = ownerFacts(p, s.inputs);
  const lines = [
    seo.audience ? `Who it's for: ${seo.audience}` : '',
    seo.angle ? `Angle: ${seo.angle}` : '',
    seo.objections.length ? `Questions to answer: ${seo.objections.join('; ')}` : '',
    seo.keywords.length ? `Search terms to work in: ${seo.keywords.join(', ')}` : '',
    `Call to action: ${CTA_LABEL[seo.cta]}`,
  ]
    .map((l) => (l ? cleanNotes([l], owner, 600) : ''))
    .filter(Boolean)
    .map((l) => `- ${l}`);
  return lines.length ? [SEO_BLOCK_HEADER, ...lines].join('\n') : '';
}

/**
 * The guidance with the block: replacing Strategy's own earlier block (found as written), appended after a
 * blank line otherwise. 'edited' when the earlier block isn't there as written any more (the owner changed
 * it: they choose to add a new one or not); 'full' when not even the header fits in the box's 2,000 characters.
 * Lines are dropped from the end of the block until it fits.
 */
export function withSeoBlock(guide: string, block: string, prev?: string): { mode: 'replace' | 'append' | 'edited' | 'full'; text: string; block: string } {
  const current = guide ?? '';
  if (prev && !current.includes(prev)) return { mode: 'edited', text: current, block };
  const mode = prev ? 'replace' : 'append';
  const lines = block.split('\n');
  for (let n = lines.length; n >= 2; n--) {
    const b = lines.slice(0, n).join('\n');
    // a function, so "$&", "$'" or "$$" in the AI's words are written as they are (never as replace patterns)
    const text = prev ? current.replace(prev, () => b) : current.trim() ? `${current.replace(/\s+$/, '')}\n\n${b}` : b;
    if (text.length <= SEO_GUIDE_MAX) return { mode, text, block: b };
  }
  return { mode: 'full', text: current, block };
}

// ───────────── campaign settings ─────────────

export type CampaignBefore = Pick<CampaignConfig, 'goal' | 'platforms' | 'postTypes' | 'videosPerDay' | 'videoStyles'>;

const mixLine = (mix: Record<PostType, number>) =>
  POST_TYPE_IDS.filter((t) => mix[t] > 0)
    .sort((a, b) => mix[b] - mix[a])
    .map((t) => `${MIX_WORD[Math.min(3, Math.max(0, Math.round(mix[t])))]} ${POST_TYPE_WORD[t]}`)
    .join(', ');
const nets = (list: PostPlatform[]) => list.map(netLabel).join(', ');
const same = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The campaign settings with Strategy's recommendation: its goal, networks, post mix and how much video.
 * Days, times, watermark, start date and posts per day stay. Refused (with why) when the result couldn't
 * make a plan (as Campaign setup checks).
 */
export function campaignPatch(cur: CampaignConfig, rec: StrategyContent['campaign']): { ok: true; next: CampaignConfig; before: CampaignBefore; lines: string[] } | { ok: false; problem: string } {
  const platforms = rec.platforms.filter((x, i, a) => POST_NETWORKS.includes(x) && a.indexOf(x) === i);
  const mix = Object.fromEntries(POST_TYPE_IDS.map((t) => [t, Math.min(3, Math.max(0, Math.round(Number(rec.postMix?.[t]) || 0)))])) as Record<PostType, number>;
  const postTypes = POST_TYPE_IDS.some((t) => mix[t] > 0) ? mix : cur.postTypes;
  let videosPerDay = rec.videoShare === 'none' ? 0 : rec.videoShare === 'most' ? cur.postsPerDay : cur.videosPerDay > 0 ? cur.videosPerDay : 1;
  videosPerDay = Math.max(0, Math.min(cur.postsPerDay, videosPerDay));
  const next: CampaignConfig = { ...cur, goal: rec.goal, platforms: platforms.length ? platforms : cur.platforms, postTypes, videosPerDay, videoStyles: videosPerDay > 0 && !cur.videoStyles.length ? ['ugc'] : cur.videoStyles };
  const problem = campaignProblem(next);
  if (problem) return { ok: false, problem };
  const lines = [
    `Goal: ${GOAL_LABEL[next.goal]}${next.goal !== cur.goal ? ` (was: ${GOAL_LABEL[cur.goal]})` : ''}`,
    `Networks: ${nets(next.platforms)}${!same(next.platforms, cur.platforms) ? ` (was: ${nets(cur.platforms)})` : ''}`,
    `Post mix: ${mixLine(next.postTypes)}${!same(next.postTypes, cur.postTypes) ? ` (was: ${mixLine(cur.postTypes)})` : ''}`,
    `Videos: ${rec.videoShare} (${next.videosPerDay} a day${next.videosPerDay !== cur.videosPerDay ? `, was ${cur.videosPerDay}` : ''})`,
  ];
  return { ok: true, next, before: { goal: cur.goal, platforms: cur.platforms, postTypes: cur.postTypes, videosPerDay: cur.videosPerDay, videoStyles: cur.videoStyles }, lines };
}

// ───────────── where links go ─────────────

/** The link settings with Strategy's: only real networks and placements. Each post can still choose its own. */
export function linksPatch(cur: Partial<Record<PostPlatform, LinkPlacement>> | undefined, rec: Partial<Record<PostPlatform, { placement: LinkPlacement }>>): Partial<Record<PostPlatform, LinkPlacement>> {
  const out: Partial<Record<PostPlatform, LinkPlacement>> = { ...(cur ?? {}) };
  for (const n of POST_NETWORKS) {
    const pl = rec[n]?.placement;
    if (pl && LINK_PLACEMENTS.includes(pl)) out[n] = pl;
  }
  return out;
}

/** "Instagram: In the post → Bio" for each network that changes. */
export function linksPreview(p: Project, rec: Partial<Record<PostPlatform, { placement: LinkPlacement }>>): string[] {
  const next = linksPatch(p.marketing.linkPlacement, rec);
  return POST_NETWORKS.filter((n) => rec[n] && next[n] !== placementFor(p, n)).map((n) => `${netLabel(n)}: ${LINK_PLACEMENT_LABEL[placementFor(p, n)]} → ${LINK_PLACEMENT_LABEL[next[n]!]}`);
}

// ───────────── the writers (each one updateProject on the latest project) ─────────────

const projectOf = (pid: string) => useStore.getState().projects.find((p) => p.id === pid) ?? null;

/** Change a project's marketing and its strategy's record in one write. */
function writeBoth(pid: string, fn: (p: Project, s: StrategyState) => { marketing?: Partial<Project['marketing']>; strategy: StrategyState } | null): boolean {
  let done = false;
  useStore.getState().updateProject(pid, (p) => {
    const out = fn(p, readStrategy(p));
    if (!out) return p;
    done = true;
    return { ...p, marketing: { ...p.marketing, ...(out.marketing ?? {}) }, strategy: capStrategy({ ...out.strategy, updatedAt: Date.now() }) };
  });
  return done;
}

/** Add or update the area's skill (an update keeps it on or off as the owner left it). */
export function applySkill(pid: string, area: SkillArea): boolean {
  const p = projectOf(pid);
  if (!p) return false;
  const s = readStrategy(p);
  const now = Date.now();
  const built = strategySkill(p, area, s, now);
  const id = strategySkillId(pid, area);
  const store = useStore.getState();
  if (store.skills.some((k) => k.id === id)) store.updateSkill(id, built);
  else store.addSkill({ ...newSkill(built), id, enabled: true });
  return writeBoth(pid, (_p, st) => ({ strategy: { ...st, applied: { ...st.applied, [area]: { at: now, skillId: id, written: strategyFingerprint({ instructions: built.instructions ?? '', directives: built.directives ?? {}, doc: built.doc, scope: built.scope ?? [area] }), from: areaAt(st, area) } } } }));
}

/** Turn the area's skill on or off in the Brain. */
export function setSkillOn(pid: string, area: SkillArea, on: boolean): void {
  useStore.getState().updateSkill(strategySkillId(pid, area), { enabled: on });
}

/** Write the SEO block (as a new block when `asNew`). Returns what happened. */
export function applySeo(pid: string, asNew = false): 'replace' | 'append' | 'edited' | 'full' | 'none' {
  let result: 'replace' | 'append' | 'edited' | 'full' | 'none' = 'none';
  writeBoth(pid, (p, s) => {
    const block = seoBlock(s, p);
    if (!block) return null;
    const r = withSeoBlock(p.marketing.seoGuide ?? '', block, asNew ? undefined : s.applied.seo?.block);
    result = r.mode;
    if (r.mode === 'edited' || r.mode === 'full') return null;
    return { marketing: { seoGuide: r.text }, strategy: { ...s, applied: { ...s.applied, seo: { at: Date.now(), block: r.block, from: s.assets?.at ?? 0 } } } };
  });
  return result;
}

/** Use the recommended campaign settings; the replaced ones are kept for one Undo. */
export function applyCampaign(pid: string): { ok: true } | { ok: false; problem: string } {
  let out: { ok: true } | { ok: false; problem: string } = { ok: false, problem: 'There’s no campaign recommendation yet.' };
  writeBoth(pid, (p, s) => {
    if (!s.content) return null;
    const r = campaignPatch(p.marketing.campaign, s.content.campaign);
    if (!r.ok) {
      out = r;
      return null;
    }
    out = { ok: true };
    return { marketing: { campaign: r.next }, strategy: { ...s, applied: { ...s.applied, campaign: { at: Date.now(), before: r.before, from: s.content.at } } } };
  });
  return out;
}

/** Put the campaign settings back as they were (one step). */
export function undoCampaign(pid: string): boolean {
  return writeBoth(pid, (p, s) => {
    const before = s.applied.campaign?.before as Partial<CampaignBefore> | undefined;
    if (!before) return null;
    const { campaign: _gone, ...applied } = s.applied;
    const cur = p.marketing.campaign;
    return {
      marketing: {
        campaign: {
          ...cur,
          goal: before.goal ?? cur.goal,
          platforms: before.platforms?.length ? before.platforms : cur.platforms,
          postTypes: (before.postTypes as CampaignConfig['postTypes']) ?? cur.postTypes,
          videosPerDay: Math.min(cur.postsPerDay, typeof before.videosPerDay === 'number' ? before.videosPerDay : cur.videosPerDay),
          videoStyles: (before.videoStyles as CampaignConfig['videoStyles']) ?? cur.videoStyles,
        },
      },
      strategy: { ...s, applied },
    };
  });
}

/** Use the recommended link placement for each network; the replaced settings are kept for one Undo. */
export function applyLinks(pid: string): boolean {
  return writeBoth(pid, (p, s) => {
    if (!s.promote) return null;
    const cur = p.marketing.linkPlacement;
    return { marketing: { linkPlacement: linksPatch(cur, s.promote.links) }, strategy: { ...s, applied: { ...s.applied, links: { at: Date.now(), before: cur ?? {}, from: s.promote.at } } } };
  });
}

/** Put the link settings back as they were (one step). */
export function undoLinks(pid: string): boolean {
  return writeBoth(pid, (_p, s) => {
    if (!s.applied.links) return null;
    const before = (s.applied.links.before ?? {}) as Partial<Record<PostPlatform, LinkPlacement>>;
    const { links: _gone, ...applied } = s.applied;
    return { marketing: { linkPlacement: Object.keys(before).length ? before : undefined }, strategy: { ...s, applied } };
  });
}
