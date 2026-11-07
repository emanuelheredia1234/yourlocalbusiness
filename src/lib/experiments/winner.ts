// "Use the winner" (P4b §A6): the server records the pick (POST /winner, which also republishes the page with
// version B when B won); the app then makes the workspace match and learns from it:
//
//   posts  the test is marked; a Brain skill learns the winning style; unposted upcoming posts on the same network
//          are offered a one-click "Rewrite N upcoming posts in this style" (metered, only on the owner's confirm)
//   email  the step's subject or opening becomes the winner's (the sequence keeps it for later drafts); B is dropped
//   page   B won: the saved page gets B's hero (so the saved project matches what's live); A won: B is dropped
//
// The Brain skill is one per business and dimension ("Learned: hooks"), scope by kind, priority 2; each result adds a
// line and only the last 5 are kept. It shows on the Brain page like any learned skill and can be edited or turned off.

import type { Directives, Experiment, ExperimentLearning, HookStyle, ModuleScope, Post, Project, Skill, VariantKey } from '@/lib/types';
import { newSkill } from '@/ai/brain';
import { runTask } from '@/ai/engine';
import { postTask } from '@/ai/tasks';
import { rewriteInput, rewritePatch } from '@/ai/socialPosts';
import { useStore } from '@/store/useStore';
import { useExperiments } from '@/store/experiments';
import { pickExperimentWinner } from './api';
import { withSeoVariant } from './page';
import { applyEmailChange, captionParts, variantOpening } from './variants';
import { normalizeDoc } from '../../../shared/email/blocks.mjs';
import { plainOf, variantDoc } from '@/lib/emailDoc';

const DIMENSION_NAME: Record<string, string> = { hook: 'hooks', caption: 'captions', visual: 'visuals', cta: 'calls to action', time: 'posting times', subject: 'subject lines', opening: 'email openings', headline: 'page headlines', hero: 'page heroes' };
export const MAX_LEARNED_LINES = 5;

const scopeOf = (kind: Experiment['kind']): ModuleScope[] => (kind === 'email' ? ['email'] : kind === 'page' ? ['seo'] : ['social']);

const HOOK_STYLES: { style: HookStyle; rx: RegExp }[] = [
  { style: 'question', rx: /question|\?/i },
  { style: 'stat', rx: /number|stat|\d/i },
  { style: 'contrarian', rx: /contrarian|myth|bold|unpopular/i },
  { style: 'story', rx: /story|behind/i },
  { style: 'pov', rx: /pov|point of view/i },
];

/** The hook style a winning version's label or text shows, if any. */
export function hookStyleOf(...texts: string[]): HookStyle | undefined {
  for (const t of texts) for (const h of HOOK_STYLES) if (t && h.rx.test(t)) return h.style;
  return undefined;
}

/**
 * The Brain skill after a result: created, or the business's one for that dimension with the new line added (the
 * last 5 kept). Pure: returns the skill to save and whether it's new.
 */
export function learnedSkill(skills: Skill[], o: { projectId: string; kind: Experiment['kind']; learning: ExperimentLearning; winnerText?: string; now?: number }): { skill: Skill; isNew: boolean } {
  const tag = `ab:${o.projectId}:${o.learning.changed}`;
  const existing = skills.find((s) => s.libraryId === tag);
  const line = o.learning.summary.trim();
  const lines = [...(existing?.instructions ?? '').split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => l !== line), line].slice(-MAX_LEARNED_LINES);
  const directives: Directives = { ...(existing?.directives ?? {}) };
  if (o.learning.changed === 'hook') {
    const style = hookStyleOf(o.learning.winnerLabel, o.winnerText ?? '');
    if (style) directives.hookStyle = style;
  }
  if (o.learning.changed === 'cta' && o.winnerText?.trim()) directives.cta = o.winnerText.trim().slice(0, 200);
  const now = o.now ?? Date.now();
  const base =
    existing ??
    newSkill({
      name: `Learned: ${DIMENSION_NAME[o.learning.changed] ?? o.learning.changed}`,
      category: 'learned',
      source: 'feedback',
      libraryId: tag,
      projectId: o.projectId,
      scope: scopeOf(o.kind),
      priority: 2,
      description: 'What your A/B tests found. Each new result adds a line; the last 5 are kept.',
    });
  return { skill: { ...base, instructions: lines.join('\n'), directives, updatedAt: now }, isNew: !existing };
}

/** Unposted, upcoming posts on the same network in this business (not versions of a test): "Rewrite N upcoming posts". */
export function upcomingPosts(posts: Post[], o: { projectId: string; network: Post['platform'] | null; now?: number }): Post[] {
  const now = o.now ?? Date.now();
  return posts.filter((p) => p.projectId === o.projectId && (!o.network || p.platform === o.network) && p.status !== 'published' && !p.external && !p.experiment && Number.isFinite(Date.parse(p.scheduledAt)) && Date.parse(p.scheduledAt) > now);
}

/** The text that won (the hook line, the call to action, a subject …), when the app has it. */
function winnerTextOf(e: Experiment, key: VariantKey, project: Project | undefined, posts: Post[]): string | undefined {
  if (e.kind === 'post') {
    const post = posts.find((p) => p.id === e.variants.find((v) => v.key === key)?.postId);
    if (!post) return undefined;
    const parts = captionParts(post.caption);
    return e.changed === 'hook' ? parts.hook : e.changed === 'cta' ? parts.cta : undefined;
  }
  if (e.kind === 'email' && key === 'b') {
    const step = project?.marketing.emails.find((s) => s.variants?.experimentId === e.id);
    if (!step?.variants) return undefined;
    return e.changed === 'subject' ? step.variants.b.subject : variantOpening(step, step.variants.b.body);
  }
  return undefined;
}

export interface WinnerOutcome {
  experiment: Experiment;
  learning: ExperimentLearning;
  /** posts: the upcoming posts that could be rewritten in the winner's style */
  upcoming: Post[];
}

/** Press "Use the winner" (or "Pick one anyway"): one request, then the workspace follows. */
export async function applyWinner(e: Experiment, key: VariantKey, o: { override?: boolean } = {}): Promise<WinnerOutcome> {
  const { experiment, learning } = await pickExperimentWinner(e.id, key, !!o.override);
  useExperiments.getState().upsert(experiment);
  const st = useStore.getState();
  const project = st.projects.find((p) => p.id === e.projectId);
  const winnerText = winnerTextOf(e, key, project, st.posts);

  if (e.kind === 'email' && project) {
    st.updateProject(project.id, (p) => ({
      ...p,
      marketing: {
        ...p.marketing,
        emails: p.marketing.emails.map((s) => {
          if (s.variants?.experimentId !== e.id) return s;
          const { variants, ...rest } = s;
          if (key !== 'b') return rest;
          if (variants.changed === 'subject') return { ...rest, subject: variants.b.subject };
          // an email with blocks: its doc gets B's opening too (every render, export and draft uses the doc)
          if (s.doc) {
            const doc = normalizeDoc(variantDoc(s, p) ?? s.doc).doc;
            return { ...rest, doc, ...plainOf(doc, p) };
          }
          return { ...rest, body: applyEmailChange(rest, 'opening', variantOpening(rest, variants.b.body)).body };
        }),
      },
    }));
  }
  if (e.kind === 'page' && project?.marketing.seoVariant?.experimentId === e.id) {
    const overrides = project.marketing.seoVariant.overrides;
    st.updateProject(project.id, (p) => {
      // B won: the saved page gets B's hero, matching what the server just put live
      const next = key === 'b' ? withSeoVariant(p, overrides) : p;
      return { ...next, marketing: { ...next.marketing, seoVariant: undefined } };
    });
  }

  const { skill, isNew } = learnedSkill(useStore.getState().skills, { projectId: e.projectId, kind: e.kind, learning, winnerText });
  if (isNew) useStore.getState().addSkill(skill);
  else useStore.getState().updateSkill(skill.id, skill);

  const upcoming = e.kind === 'post' ? upcomingPosts(useStore.getState().posts, { projectId: e.projectId, network: e.network }) : [];
  return { experiment, learning, upcoming };
}

/**
 * "Rewrite N upcoming posts in this style": each post's caption rewritten by the AI (metered like any Rewrite), with
 * the new Brain skill in force. Only on the owner's confirm; one request per post, in order; a failure stops there.
 * → how many were rewritten.
 */
export async function rewriteUpcoming(ids: string[], o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<number> {
  let done = 0;
  for (const id of ids) {
    if (o.signal?.aborted) break;
    const st = useStore.getState();
    const post = st.posts.find((p) => p.id === id);
    const project = st.projects.find((p) => p.id === post?.projectId);
    if (!post || !project || post.status === 'published' || post.external) continue;
    const input = rewriteInput(project, post);
    const res = await runTask(postTask, input, { project, skills: st.skills, settings: st.settings, signal: o.signal });
    if (res.code) break;
    useStore.getState().updatePost(id, rewritePatch(project, post, res.data, input.link ?? null));
    done++;
    o.onProgress?.(done, ids.length);
  }
  return done;
}
