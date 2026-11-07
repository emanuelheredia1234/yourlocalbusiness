// The A/B tests on the analytics tabs (P4b §A7): Social "Recent A/B tests", Email "A/B campaigns" (each version's
// rates and Omnisend's winner) and SEO "Page versions" (visitors, leads and conversion per version, and the verdict).
// Each row opens the test's card. Nothing shows when there's no test of that kind, or A/B tests are off.

import { FlaskConical } from 'lucide-react';
import type { ExperimentKind, Project } from '@/lib/types';
import { openExperimentCard, useProjectExperiments } from '@/store/experiments';
import { metricLine, secondaryNumbers, verdictCopy, versionName } from '@/lib/experiments/math';
import { Badge } from '../ui/primitives';

const TITLE: Record<ExperimentKind, string> = { post: 'Recent A/B tests', email: 'A/B campaigns', page: 'Page versions' };

export function ExperimentsSummary({ project, kind, limit = 5 }: { project: Project; kind: ExperimentKind; limit?: number }) {
  const { on, experiments } = useProjectExperiments(project.id);
  const list = experiments.filter((e) => e.kind === kind && e.state !== 'cancelled' && e.state !== 'draft').slice(0, limit);
  if (!on || __ARTIFACT_BUILD__ || !list.length) return null;
  return (
    <section className="card flex flex-col gap-3 p-4" aria-label={TITLE[kind]} data-testid={`ab-summary-${kind}`}>
      <h3 className="flex items-center gap-2 text-h4 text-ink">
        <FlaskConical size={16} aria-hidden="true" /> {TITLE[kind]}
      </h3>
      <ul className="flex flex-col divide-y divide-line">
        {list.map((e) => {
          const v = verdictCopy(e);
          return (
            <li key={e.id} className="flex flex-col gap-1.5 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="link min-w-0 truncate text-left text-small font-medium" onClick={() => void openExperimentCard(e.id)}>
                  {e.name || 'A/B test'}
                </button>
                <Badge tone={v.tone === 'good' ? 'good' : v.tone === 'warn' ? 'warn' : 'neutral'}>{v.title}</Badge>
                {e.result.source === 'omnisend' && e.result.winner && <span className="text-caption text-muted">Omnisend’s pick: {versionName(e.result.winner)}</span>}
              </div>
              <div className="grid gap-1 text-caption text-muted sm:grid-cols-2">
                {e.variants.map((x) => (
                  <p key={x.key} className="num font-mono">
                    {x.key.toUpperCase()}: {kind === 'post' ? metricLine(e, x.key) : secondaryNumbers(e, x).map((n) => `${n.label} ${n.value}`).join(' · ')}
                  </p>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
