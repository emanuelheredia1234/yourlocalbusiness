// The morning action's shared contract (shared/morning.json, read by the server too): timing, kinds, field lists,
// limits, Not useful reasons and the rule templates. contract.test.ts keeps its lists equal to the app's own.

import shared from '../../../shared/morning.json';
import type { MorningKind, MorningReason } from '@/lib/integrations/types';

export const MORNING = shared as Omit<typeof shared, 'kinds' | 'reasons'> & { kinds: MorningKind[]; reasons: { id: MorningReason; label: string }[] };

/** The local hour each business's action day starts (5). */
export const MORNING_HOUR = MORNING.hour;

/** The Not useful reasons, in order. */
export const MORNING_REASONS = MORNING.reasons;

/** Fill {name} placeholders (the server's rules.mjs `fill`). */
export const fill = (tpl: string | undefined, vars: Record<string, string | number | null | undefined>) => String(tpl ?? '').replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] == null ? '' : String(vars[k])));

const slug = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** A candidate's key (the server's keyOf): what "the same idea" means for repeats and Not useful. */
export function morningKey(c: { kind: string; title: string; target?: { planActionId?: string; postId?: string; pageType?: string; topic?: string; prompt?: string } }, newestLead = ''): string {
  const t = c.target ?? {};
  let k: string;
  if (t.planActionId) k = `plan:${t.planActionId}`;
  else if (t.postId) k = `post:${t.postId}`;
  else if (c.kind === 'leads') k = `leads:${newestLead}`;
  else if (c.kind === 'build_page') k = `build_page:${t.pageType ?? ''}`;
  else if (c.kind === 'write_post') k = `write_post:${slug(t.topic ?? c.title)}`;
  else if (c.kind === 'assistant') k = `assistant:${slug(String(t.prompt ?? '').slice(0, 40))}`;
  else k = c.kind;
  return k.slice(0, MORNING.limits.key);
}
