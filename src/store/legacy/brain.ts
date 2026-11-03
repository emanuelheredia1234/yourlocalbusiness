// Older versions offered a "Proof points" skill template filled with made-up facts ("Family-owned since 2014",
// "Over 1,200 customers served", "4.9-star average from 300+ reviews", "Licensed and insured"). A skill saved
// from it unedited fed those facts into every generation as if they were true.
// purgeSkills swaps each of those exact lines for the placeholder the template now uses and turns the skill
// off, so the owner can fill in real details and turn it back on. Lines the owner wrote are left alone.
// Running it again changes nothing.

import type { Skill } from '@/lib/types';

/** The old template lines, each with the placeholder line that replaces it. */
const TEMPLATE_LINES: [string, string][] = [
  ['- Family-owned since 2014.', '- Founded in [Year founded].'],
  ['- Over 1,200 customers served.', '- [Number of customers] customers served.'],
  ['- 4.9-star average from 300+ reviews.', '- [Average rating and where it comes from].'],
  ['- Licensed and insured.', '- [Licences or certifications].'],
];
const REPLACEMENT = new Map(TEMPLATE_LINES);

function cleanInstructions(text: string): string {
  const lines = text.split('\n');
  if (!lines.some((l) => REPLACEMENT.has(l.trim()))) return text;
  return lines.map((l) => REPLACEMENT.get(l.trim()) ?? l).join('\n');
}

/** Skills with the old made-up proof points replaced by placeholders and switched off, or null when none had them. */
export function purgeSkills(skills: Skill[]): Skill[] | null {
  let changed = false;
  const next = skills.map((s) => {
    const instructions = cleanInstructions(s.instructions);
    if (instructions === s.instructions) return s;
    changed = true;
    return { ...s, instructions, enabled: false };
  });
  return changed ? next : null;
}
