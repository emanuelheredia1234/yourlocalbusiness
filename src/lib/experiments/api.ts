// Typed calls to the A/B test routes (server/experiments/index.mjs, P4b §S3), one request each, never retried here.
// Refusals throw IntegrationApiError with the server's { error, code } (EXPERIMENT_LIMIT, TOO_SOON, …), the same as
// posting. In the claude.ai build none of these reach a server: the feature is hidden there, and every call refuses
// before any request.

import { IntegrationApiError, call } from '@/lib/integrations/api';
import type { Experiment, ExperimentChanged, ExperimentKind, ExperimentLearning, ExperimentMetric, ExperimentMode, ExperimentUsage, PostPlatform, ShareMode, TrialEligibility, VariantKey } from '@/lib/types';

const noServer = () => Promise.reject(new IntegrationApiError(503, { error: 'A/B tests need the app’s server.', code: 'NOT_SET_UP' }));
const seg = encodeURIComponent;
const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const t = s.toString();
  return t ? `?${t}` : '';
};

export interface NewExperiment {
  projectId: string;
  kind: ExperimentKind;
  mode: ExperimentMode;
  changed: ExperimentChanged;
  network?: PostPlatform;
  metric?: ExperimentMetric;
  subjectRef: string;
  name?: string;
  variants: { key: VariantKey; label: string; postId?: string; plannedAt?: string; shareMode?: ShareMode }[];
}

export interface ExperimentPatch {
  name?: string;
  variants?: { key: VariantKey; label?: string; plannedAt?: string | null }[];
  addVariant?: { key: 'c'; label: string; postId: string; plannedAt?: string; shareMode?: ShareMode };
  removeVariant?: 'c';
}

/** One version of an A/B email: its block doc and the values the app owns (P5; the server renders it), or the old plain shape. */
export interface EmailVersion {
  subject: string;
  preheader?: string;
  body?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  doc?: import('../types').EmailDoc;
  values?: Record<string, string>;
  brand?: { name: string; colors: Record<string, string> };
  footerNote?: string;
  assetLinks?: Record<string, string>;
}

export interface EmailDraftAnswer {
  experiment: Experiment;
  campaign: { id: string; url?: string; status?: string; variantIds?: Partial<Record<'a' | 'b', string>> };
  /** Omnisend doesn't offer A/B for this brand: two regular drafts were made */
  split?: { campaigns: Record<'a' | 'b', { id: string; url?: string }>; note: string };
}

export const listExperiments = (projectId: string, o: { kind?: ExperimentKind; state?: string } = {}): Promise<{ experiments: Experiment[]; usage: ExperimentUsage }> =>
  __ARTIFACT_BUILD__ ? noServer() : call('GET', `/api/experiments${q({ projectId, kind: o.kind, state: o.state })}`);
export const getExperiment = (id: string): Promise<{ experiment: Experiment }> => (__ARTIFACT_BUILD__ ? noServer() : call('GET', `/api/experiments/${seg(id)}`));
export const getExperimentUsage = (): Promise<ExperimentUsage> => (__ARTIFACT_BUILD__ ? noServer() : call('GET', '/api/experiments/usage'));
export const getTrialEligibility = (projectId: string): Promise<TrialEligibility> => (__ARTIFACT_BUILD__ ? noServer() : call('GET', `/api/experiments/trial-reels/eligibility${q({ projectId })}`));
/** A draft: nothing goes out and nothing counts yet. */
export const createExperiment = (body: NewExperiment): Promise<{ experiment: Experiment }> => (__ARTIFACT_BUILD__ ? noServer() : call('POST', '/api/experiments', body));
export const patchExperiment = (id: string, body: ExperimentPatch): Promise<{ experiment: Experiment }> => (__ARTIFACT_BUILD__ ? noServer() : call('PATCH', `/api/experiments/${seg(id)}`, body));
export const deleteExperiment = (id: string): Promise<{ ok: true }> => (__ARTIFACT_BUILD__ ? noServer() : call('DELETE', `/api/experiments/${seg(id)}`));
/** Version B's page: stored, then the split goes live (counted in the month's tests). */
export const startPageSplit = (id: string, html: string, sha256: string): Promise<{ experiment: Experiment }> => (__ARTIFACT_BUILD__ ? noServer() : call('POST', `/api/experiments/${seg(id)}/page`, { html, sha256 }));
/** The Omnisend A/B draft (counted). One request: a 502 CAMPAIGN_UNCONFIRMED means check Omnisend first. */
export const createEmailAbDraft = (id: string, variants: { a: EmailVersion; b: EmailVersion }, settings: { testSizePercent?: number; decisionHours?: number } = {}): Promise<EmailDraftAnswer> =>
  __ARTIFACT_BUILD__ ? noServer() : call('POST', `/api/experiments/${seg(id)}/email`, { variants, settings });
/** "Update results" (409 TOO_SOON within 15 minutes of the last read). */
export const refreshExperiment = (id: string): Promise<{ experiment: Experiment }> => (__ARTIFACT_BUILD__ ? noServer() : call('POST', `/api/experiments/${seg(id)}/refresh`, {}));
export const stopExperiment = (id: string): Promise<{ experiment: Experiment }> => (__ARTIFACT_BUILD__ ? noServer() : call('POST', `/api/experiments/${seg(id)}/stop`, {}));
/** "Use the winner" (override: "Pick one anyway" on a test too close to call or a tie). */
export const pickExperimentWinner = (id: string, key: VariantKey, override = false): Promise<{ experiment: Experiment; learning: ExperimentLearning }> =>
  __ARTIFACT_BUILD__ ? noServer() : call('POST', `/api/experiments/${seg(id)}/winner`, { key, ...(override ? { override: true } : {}) });

/** Plain words for a refused A/B request (the server's own words for most codes). */
export function experimentErrorCopy(e: unknown): string {
  if (!(e instanceof IntegrationApiError)) return 'Something went wrong. Try again shortly.';
  switch (e.code) {
    case 'NETWORK':
      return 'Couldn’t reach the app’s server. Check your connection and try again.';
    case 'NOT_SET_UP':
      return 'A/B tests aren’t set up on this app yet.';
    case 'RATE_LIMITED':
      return 'Too many requests at once. Try again in a few minutes.';
    default:
      return e.message;
  }
}
