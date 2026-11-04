// What the Brain page does with skills, outside the page (the assistant uses the same steps): turning a
// knowledge document into a skill, and which skills the playground compares.

import type { Skill } from '@/lib/types';
import { extractFacts, extractKeywords, newSkill } from './brain';

/** The largest knowledge document the Brain takes (bytes). */
export const MAX_DOC = 2_000_000;

/** Shorter than this (after cleaning) and a document has too little to learn from. */
export const MIN_DOC_CHARS = 40;

/** A document's text as the Brain reads it: line endings and trailing spaces tidied. */
export function docText(body: string): string {
  return body.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * A knowledge document as a Brain skill (Brain → Knowledge docs): its proof points, key terms and an
 * excerpt, used as the source of truth. null when the text is too short to use. `projectId`: only for
 * that project (the Brain page's documents apply to every project).
 */
export function knowledgeDocSkill(docName: string, body: string, size: number, projectId?: string): Skill | null {
  const clean = docText(body);
  if (clean.length < MIN_DOC_CHARS) return null;
  const keywords = extractKeywords(clean, 12);
  const facts = extractFacts(clean, 8);
  const excerpt = clean.slice(0, 1500);
  return newSkill({
    name: docName || 'Knowledge document',
    category: 'knowledge',
    description: `Reference document with ${facts.length} proof point${facts.length === 1 ? '' : 's'} and ${keywords.length} key terms.`,
    instructions: [`Use this document as the source of truth. Prefer its facts over generic claims.`, facts.length ? `Proof points:\n${facts.map((f) => `- ${f}`).join('\n')}` : '', `Key terms: ${keywords.join(', ')}`, `Excerpt:\n${excerpt}`].filter(Boolean).join('\n\n'),
    scope: ['all'],
    priority: 2,
    source: 'document',
    directives: { facts },
    doc: { name: docName || 'Pasted text', size, keywords, excerpt: excerpt.slice(0, 280) },
    ...(projectId ? { projectId } : {}),
  });
}

/**
 * The two sets of skills a playground run compares (Brain → Playground). With your Brain: the skills that
 * are on, plus the compared skill even when it's off. Without: no skills at all (compare null), or all of
 * them but the compared one.
 */
export function playgroundSets(skills: Skill[], compare: string | null): { withSet: Skill[]; baseline: Skill[]; target?: Skill } {
  const enabled = skills.filter((s) => s.enabled);
  const target = compare ? skills.find((s) => s.id === compare) : undefined;
  const baseline = compare ? enabled.filter((s) => s.id !== compare) : [];
  const withSet = target && !target.enabled ? [...enabled, { ...target, enabled: true }] : enabled;
  return { withSet, baseline, target };
}
