// What the assistant's turn uses from the rest of the app: the AI, the danger confirm, the app's own
// windows for public actions, and pages. Tests swap these out with setAssistantHost.

import type { Route } from '@/lib/router';
import { confirmAction } from '@/components/ui/primitives';
import { useManusPost } from '@/components/posts/ManusPost';
import { useManusGroups } from '@/components/posts/ManusGroups';
import { useMarkPosted } from '@/components/posts/PostActions';
import type { DangerSpec, PubWindow } from './registry';
import { assistantAvailability, askAssistantModel, promptBudget, type Availability } from './transport';
import { openPage } from './nav';

export interface AssistantHost {
  /** one step: the AI's reply to the prompt (its JSON, or its text when it answered in prose) */
  ask: (prompt: string, signal: AbortSignal) => Promise<unknown>;
  availability: () => Availability;
  /** the longest prompt to send, in characters */
  budget: () => number;
  /** the danger confirm before a destructive tool */
  confirmDanger: (spec: DangerSpec) => Promise<boolean>;
  /** open one of the app's own windows for a public action (the owner confirms there) */
  openWindow: (w: PubWindow) => Promise<boolean>;
  /** open a page (through the leave guard), on a tab when given */
  openPage: (route: Route, tab?: string) => Promise<boolean>;
}

export const host: AssistantHost = {
  ask: askAssistantModel,
  availability: assistantAvailability,
  budget: promptBudget,
  confirmDanger: (spec) => confirmAction({ title: spec.title, body: spec.body, confirmLabel: spec.confirmLabel ?? 'Delete', cancelLabel: 'Keep it', danger: true }),
  openWindow: async (w) => {
    switch (w.kind) {
      case 'manus-post':
        useManusPost.getState().open(w.postIds);
        return true;
      case 'manus-groups':
        useManusGroups.getState().open(w.postId);
        return true;
      case 'mark-posted':
        useMarkPosted.getState().open(w.postId);
        return true;
      case 'page':
        return openPage(w.route, w.tab);
    }
  },
  openPage,
};

/** Replace parts of the host (tests). Returns a function that puts the old ones back. */
export function setAssistantHost(patch: Partial<AssistantHost>): () => void {
  const before = { ...host };
  Object.assign(host, patch);
  return () => Object.assign(host, before);
}
