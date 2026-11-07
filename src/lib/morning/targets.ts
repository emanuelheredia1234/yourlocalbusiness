// "Do it" for a morning action: where its button goes. The AI (or a rule) only names a kind from a fixed list and
// a few checked fields; the app maps the kind to a screen here, with the Strategy "Do it" code for the plan kinds.
// Pages go through the leave guard like every other jump. Pressing Do it marks nothing done, and the assistant kind
// only puts text in the chat's box: nothing is sent until the owner presses Send.

import type { Project } from '@/lib/types';
import type { ActionKind } from '@/lib/strategyTypes';
import type { MorningCandidate } from '@/lib/integrations/types';
import { navigate, type Route } from '@/lib/router';
import { readStrategy } from '@/lib/strategy';
import { ACTION_LABEL, ACTION_TARGET, actionTarget, runTarget } from '@/lib/strategyActions';
import { openPage, pageName } from '@/ai/assistant/nav';
import { useAssistant } from '@/store/assistant';
import { useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';

export interface DoIt {
  label: string;
  run: () => Promise<void> | void;
}

/** The 21 Strategy kinds (ACTION_LABEL's keys). */
const PLAN_KINDS = new Set(Object.keys(ACTION_LABEL));
export const isPlanKind = (k: string): k is ActionKind => PLAN_KINDS.has(k);

/** The page a candidate's button opens, in words (the assistant tool says where it leads). */
export function targetPage(c: Pick<MorningCandidate, 'kind' | 'target'>): string {
  const page = (r: Route, tab?: string) => pageName(r, tab);
  switch (c.kind) {
    case 'leads':
      return page('marketing-email', 'leads');
    case 'analytics':
      return page('analytics');
    case 'strategy':
    case 'link_settings':
    case 'outreach':
      return page('strategy');
    case 'assistant':
      return 'the assistant';
    case 'offline':
      return 'outside the app';
    case 'calendar':
      return page('calendar', 'scheduled');
    case 'build_page':
    case 'publish_page':
      return page('marketing-seo');
    case 'write_post':
      return 'the post composer';
    default: {
      const to = (ACTION_TARGET as Partial<Record<string, { route: Route; tab?: string }>>)[c.kind];
      return to ? page(to.route, to.tab) : '';
    }
  }
}

/** "Do it": its label and what it runs, or null (done outside the app, or a kind the app doesn't know). */
export function doIt(c: Pick<MorningCandidate, 'kind' | 'title' | 'target'>, project: Project): DoIt | null {
  const t = c.target ?? {};
  switch (c.kind) {
    case 'leads':
      return { label: 'Open your leads', run: () => void openPage('marketing-email', 'leads') };
    case 'analytics':
      return { label: 'Open Analytics', run: () => void navigate('analytics') };
    case 'strategy':
      return { label: 'Open your plan', run: () => void openPage('strategy', 'plan') };
    case 'assistant': {
      const prompt = (t.prompt ?? '').trim();
      return prompt ? { label: 'Ask the assistant', run: () => useAssistant.getState().openWith(prompt) } : null;
    }
    case 'calendar': {
      const post = t.postId ? useStore.getState().posts.find((p) => p.id === t.postId && p.projectId === project.id) : undefined;
      if (post) return { label: 'Open the post', run: () => useUI.getState().openPostEditor(post.id) };
      return { label: ACTION_LABEL.calendar, run: () => void openPage('calendar', 'scheduled') };
    }
    default: {
      if (!isPlanKind(c.kind)) return null;
      const hit = actionTarget({ kind: c.kind, title: c.title, pageType: t.pageType, topic: t.topic }, project, readStrategy(project));
      return hit ? { label: hit.label, run: () => runTarget(hit.target) } : null;
    }
  }
}

/** For an action done outside the app: the assistant with "Help me with today’s action: <title>" in its box. */
export function askHow(c: Pick<MorningCandidate, 'title'>): DoIt {
  return { label: 'Ask the assistant how', run: () => useAssistant.getState().openWith(`Help me with today’s action: ${c.title}`) };
}
