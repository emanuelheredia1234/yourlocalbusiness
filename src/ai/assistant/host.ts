// What the assistant's turn uses from the rest of the app: the AI, the danger confirm, the app's own
// windows for public actions, and pages. Tests swap these out with setAssistantHost.

import type { Route } from '@/lib/router';
import { confirmAction } from '@/components/ui/primitives';
import { usePublishConfirm } from '@/components/posts/PublishConfirm';
import { usePostItYourself } from '@/components/posts/PostItYourselfModal';
import { canPostFrom, legacyManus } from '@/lib/posting';
import { useAnalytics } from '@/store/analytics';
import { useStore } from '@/store/useStore';
import { useManusGroups } from '@/components/posts/ManusGroups';
import { useMarkPosted } from '@/components/posts/PostActions';
import { openListingWindow } from '@/components/studio/ListingWindowHost';
import { openAgentBuild } from '@/components/agents/buildWindow';
import { useUI } from '@/store/ui';
import { useAdsLaunch } from '@/store/adsLaunch';
import { useMakeVariations } from '@/components/experiments/MakeVariations';
import { openExperimentCard } from '@/store/experiments';
import type { ExperimentChanged } from '@/lib/types';
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
      case 'post-now': {
        // the confirm window when the app can post on that account, else "Post it yourself": the owner confirms either way
        const post = useStore.getState().posts.find((p) => p.id === w.postId);
        if (!post) return false;
        const status = useAnalytics.getState().connections.find((c) => c.platform === post.platform);
        if (!__ARTIFACT_BUILD__ && canPostFrom(status) && !legacyManus(post)) usePublishConfirm.getState().open(post.id);
        else usePostItYourself.getState().open(post.id);
        return true;
      }
      case 'manus-groups':
        useManusGroups.getState().open(w.postId);
        return true;
      case 'mark-posted':
        useMarkPosted.getState().open(w.postId);
        return true;
      case 'listing':
        return openListingWindow(w.action);
      case 'publish': {
        // the page with the panel, then the panel itself (the page brings it into view)
        const ok = w.page === 'seo' ? await openPage('marketing-seo') : await openPage('studio', 'code');
        if (ok) useUI.getState().requestPublish(w.page === 'seo' ? { page: 'seo' } : { page: 'asset', assetId: w.assetId });
        return ok;
      }
      case 'agent-build':
        // the page (Code & assets, or the SEO page), then "Build with Manus / Viktor" there: the owner fills it in and sends it
        return openAgentBuild({ target: w.target, via: w.agent });
      case 'ad-launch': {
        // the Plans tab, then the launch window: nothing is picked for the owner (no PAUSED/ACTIVE, no ticks)
        if (__ARTIFACT_BUILD__) return false;
        const ok = await openPage('marketing-ads', 'plan');
        if (ok) useAdsLaunch.getState().openLaunch({ planId: w.planId, fromAssistant: true });
        return ok;
      }
      case 'ad-change': {
        if (__ARTIFACT_BUILD__) return false;
        const ok = await openPage('marketing-ads', 'campaigns');
        if (ok) useAdsLaunch.getState().openChange({ campaignId: w.campaignId, action: w.action });
        return ok;
      }
      case 'make-variations': {
        // A/B tests (P4b): the dialog, prefilled; nothing is generated or saved until the owner presses there
        if (__ARTIFACT_BUILD__) return false;
        const projectId = useStore.getState().activeProjectId ?? '';
        const target = w.target === 'post' ? { kind: 'post' as const, postId: w.id } : w.target === 'email' ? { kind: 'email' as const, projectId, stepId: w.id } : { kind: 'page' as const, projectId };
        useMakeVariations.getState().open(target, { ...(w.change ? { change: w.change as ExperimentChanged } : {}), ...(w.count ? { count: w.count } : {}) });
        return true;
      }
      case 'experiment':
        if (__ARTIFACT_BUILD__) return false;
        return openExperimentCard(w.experimentId);
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
