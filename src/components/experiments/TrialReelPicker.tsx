// "Post as" on an Instagram video (P4b §A4): a regular Reel (the default), a Trial Reel Instagram shares with
// followers if it does well within 72 hours, or one only non-followers see. The eligibility line comes from the
// server (1,000+ followers on a connected professional account); the server checks again when it's posted.
// Shown only on Instagram videos, only when A/B tests are on (never in the claude.ai build).

import { useEffect } from 'react';
import type { Post, ShareMode } from '@/lib/types';
import { useExperiments } from '@/store/experiments';
import { useExperimentsOn } from '@/lib/experiments/config';
import { SHARE_MODE_OPTIONS, TRIAL_HELP, canTrialReel, eligibilityView, isTrialMode, shareModeOf } from '@/lib/trialReels';
import { cn } from '@/lib/utils';
import { Field } from '../ui/primitives';

/** The eligibility line for a business (asks the server once every 10 minutes). */
export function TrialEligibilityLine({ projectId, className }: { projectId: string; className?: string }) {
  const el = useExperiments((s) => s.eligibility[projectId]?.value ?? null);
  useEffect(() => {
    void useExperiments.getState().loadEligibility(projectId);
  }, [projectId]);
  const view = eligibilityView(el);
  return (
    <p className={cn('text-small', view.tone === 'good' ? 'text-good' : view.tone === 'warn' ? 'text-warn' : 'text-muted', className)} data-testid="trial-eligibility">
      {view.line}
    </p>
  );
}

export function TrialReelPicker({ post, onChange }: { post: Pick<Post, 'id' | 'projectId' | 'platform' | 'format' | 'media' | 'instagram' | 'experiment' | 'status'>; onChange: (patch: Partial<Post>) => void }) {
  const on = useExperimentsOn();
  const el = useExperiments((s) => s.eligibility[post.projectId]?.value ?? null);
  useEffect(() => {
    if (on && canTrialReel(post)) void useExperiments.getState().loadEligibility(post.projectId);
  }, [on, post]);
  if (!on || __ARTIFACT_BUILD__ || !canTrialReel(post) || post.status === 'published') return null;
  const view = eligibilityView(el);
  const mode = shareModeOf(post);
  // a Trial Reels test sets each version's mode itself
  const locked = !!post.experiment;
  const set = (m: ShareMode) => onChange({ instagram: m === 'CUSTOM' ? undefined : { shareMode: m } });
  return (
    <Field label="Post as">
      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Post as" data-testid="trial-picker">
        {SHARE_MODE_OPTIONS.map((o) => {
          const disabled = locked || (isTrialMode(o.value) && view.disabled);
          return (
            <label key={o.value} className={cn('flex items-start gap-2 text-small', disabled ? 'text-muted' : 'text-ink-2')}>
              <input type="radio" name={`share-${post.id}`} className="mt-0.5" checked={mode === o.value} disabled={disabled} onChange={() => set(o.value)} />
              <span>
                <span className="font-medium text-ink">{o.label}</span> · {o.hint}
              </span>
            </label>
          );
        })}
        <TrialEligibilityLine projectId={post.projectId} />
        <p className="text-caption text-muted">{TRIAL_HELP}</p>
        {locked && <p className="text-caption text-muted">This post is a version in an A/B test, which sets how it goes out.</p>}
      </div>
    </Field>
  );
}
