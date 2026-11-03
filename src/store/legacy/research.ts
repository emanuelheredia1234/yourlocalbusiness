// Product ideas saved by older versions carried a made-up "winning" score, a revenue range and
// market "signals" (search interest, competition) that nothing ever measured. This strips them,
// keeps the suggested price (the Studio may already use it) and adds "Why this could fit you"
// reasons drawn from the project's own niche, category and format. Running it again changes nothing.

import type { Project, ProductIdea } from '@/lib/types';
import { fitReasons } from '@/ai/local/research';

const INVENTED = ['score', 'revenueLow', 'revenueHigh', 'signals'] as const;
/** An angle label that claimed a gap in the market nobody checked. */
const OLD_MICRO = 'Underserved micro-niche';
const NEW_MICRO = 'Focused micro-niche';

const isDirty = (i: unknown): boolean =>
  !!i && typeof i === 'object' && (INVENTED.some((k) => k in i) || !Array.isArray((i as { fit?: unknown }).fit) || (i as { angle?: unknown }).angle === OLD_MICRO);

function cleanIdea(idea: ProductIdea, p: Project): ProductIdea {
  if (!isDirty(idea)) return idea;
  const { score: _s, revenueLow: _l, revenueHigh: _h, signals: _g, ...rest } = idea as ProductIdea & Record<(typeof INVENTED)[number], unknown>;
  const angle = rest.angle === OLD_MICRO ? NEW_MICRO : String(rest.angle ?? '');
  const fit = Array.isArray(rest.fit)
    ? rest.fit
    : fitReasons({ niche: String(p.niche ?? ''), category: String(p.category ?? ''), format: rest.format, audience: String(rest.audience ?? ''), pain: String(rest.pain ?? ''), angle });
  return { ...rest, angle, fit };
}

/** The project with its product ideas cleaned, or null when there's nothing to change. */
export function purgeResearch(p: Project): Project | null {
  const ideas = Array.isArray(p.ideas) ? p.ideas : [];
  const ideasDirty = ideas.some(isDirty);
  const ideaDirty = !!p.idea && isDirty(p.idea);
  if (!ideasDirty && !ideaDirty) return null;
  return {
    ...p,
    ideas: ideasDirty ? ideas.map((i) => cleanIdea(i, p)) : p.ideas,
    idea: ideaDirty && p.idea ? cleanIdea(p.idea, p) : p.idea,
  };
}
