// Social › A/B tests (P4b §A3): every A/B test of the business (posts, email and the page), newest first, with the
// month's usage. The card a badge, a morning action or the assistant asked for is shown first and scrolled to.

import { useEffect } from 'react';
import { FlaskConical } from 'lucide-react';
import type { Project } from '@/lib/types';
import { useExperiments, useProjectExperiments } from '@/store/experiments';
import { experimentsUsageLabel } from '@/lib/plans';
import { Callout, Empty, Spinner } from '../ui/primitives';
import { ExperimentCard } from './ExperimentCard';
import { EXPLAINER, LIMITS_COPY } from './MakeVariations';

export function ExperimentsTab({ project }: { project: Project }) {
  const { experiments, usage, loading, error } = useProjectExperiments(project.id);
  const openId = useExperiments((s) => s.openId);
  useEffect(() => {
    if (!openId) return;
    // the asked-for card: fresh numbers, and into view
    void useExperiments.getState().load(project.id, true);
    const t = setTimeout(() => {
      try {
        document.querySelector(`[data-testid="experiment-${openId}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch {
        /* not in a browser */
      }
    }, 50);
    return () => clearTimeout(t);
  }, [openId, project.id]);
  const list = openId ? [...experiments.filter((e) => e.id === openId), ...experiments.filter((e) => e.id !== openId)] : experiments;
  const usageLine = experimentsUsageLabel(usage);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-small text-muted">{EXPLAINER}</p>
        {usageLine && <span className="text-small text-ink-2" data-testid="ab-usage">{usageLine}</span>}
        {loading && <Spinner />}
      </div>
      {error && <Callout tone="bad">{error}</Callout>}
      {!loading && !list.length ? (
        <Empty icon={<FlaskConical />} title="No A/B tests yet" body={`Open a post’s ⋯ menu and choose Make variations, or start one from an email step or your SEO page. ${LIMITS_COPY}`} />
      ) : (
        list.map((e) => <ExperimentCard key={e.id} experiment={e} />)
      )}
    </div>
  );
}
