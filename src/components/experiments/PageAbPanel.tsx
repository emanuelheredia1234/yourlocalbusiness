// The SEO page's A/B test (P4b §A2, §S6): "Make variations" of the hero, then "Start the split" sends version B's
// page (built now, like a publish) and half of the visitors see it. Leads are counted per version. The split is one
// request, never retried here; starting counts as one of the month's A/B tests.

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import type { Project } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { openExperimentCard, useExperiments, useProjectExperiments } from '@/store/experiments';
import { deleteExperiment, experimentErrorCopy, startPageSplit, stopExperiment } from '@/lib/experiments/api';
import { buildVersionB, heroOf } from '@/lib/experiments/page';
import { experimentsUsageLabel } from '@/lib/plans';
import { Callout, Spinner } from '../ui/primitives';
import { useMakeVariations } from './MakeVariations';

export function PageAbPanel({ project }: { project: Project }) {
  const { experiments, usage } = useProjectExperiments(project.id);
  const v = project.marketing.seoVariant;
  const running = experiments.find((e) => e.kind === 'page' && e.state === 'running');
  const exp = v ? experiments.find((e) => e.id === v.experimentId) : running;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  if (__ARTIFACT_BUILD__) return null;
  const hero = heroOf(project);
  const published = !!project.marketing.seoPublished;

  const clear = () => useStore.getState().updateProject(project.id, (p) => ({ ...p, marketing: { ...p.marketing, seoVariant: undefined } }));

  const start = async () => {
    if (!v || busy) return;
    setBusy('Starting the split…');
    setError('');
    try {
      const b = await buildVersionB(project, v.overrides);
      const { experiment } = await startPageSplit(v.experimentId, b.html, b.sha256);
      useExperiments.getState().upsert(experiment);
    } catch (e) {
      setError(e instanceof Error && !('code' in e) ? e.message : experimentErrorCopy(e));
    } finally {
      setBusy('');
    }
  };
  const stop = async () => {
    if (!exp || busy) return;
    setBusy('Stopping…');
    try {
      const { experiment } = await stopExperiment(exp.id);
      useExperiments.getState().upsert(experiment);
    } catch (e) {
      setError(experimentErrorCopy(e));
    } finally {
      setBusy('');
    }
  };
  const drop = async () => {
    if (!v) return;
    await deleteExperiment(v.experimentId).catch(() => {});
    useExperiments.getState().drop(project.id, v.experimentId);
    clear();
  };

  return (
    <div className="flex flex-col gap-3" data-testid="page-ab">
      <p className="text-small text-ink-2">Show half of your visitors a different hero and see which brings more leads. Version A is the page as it’s published.</p>
      {v && hero && (
        <div className="grid gap-2 text-small text-ink-2">
          <p>
            <span className="label">A · Original</span>
            {v.changed === 'cta' ? hero.ctaLabel : hero.headline}
          </p>
          <p>
            <span className="label">B</span>
            {v.changed === 'cta' ? v.overrides.ctaLabel : v.overrides.headline}
          </p>
        </div>
      )}
      {!v && !running && (
        <button type="button" className="btn btn-secondary btn-sm self-start" disabled={!hero} onClick={() => useMakeVariations.getState().open({ kind: 'page', projectId: project.id })}>
          <FlaskConical /> Make variations
        </button>
      )}
      {v && exp?.state === 'draft' && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !published} onClick={() => void start()}>
            {busy && <Spinner />} Start the split
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void drop()}>
            Drop version B
          </button>
        </div>
      )}
      {v && exp?.state === 'draft' && !published && <p className="text-caption text-muted">Publish the page first: version A is the page as it’s published.</p>}
      {exp && exp.state === 'running' && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openExperimentCard(exp.id)}>
            See the results
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void stop()}>
            Stop the split
          </button>
        </div>
      )}
      {exp && (exp.state === 'finished' || exp.state === 'stopped') && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openExperimentCard(exp.id)}>
            See the results
          </button>
          {v && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>
              Clear version B
            </button>
          )}
        </div>
      )}
      {error && <Callout tone="bad">{error}</Callout>}
      <p className="text-caption text-muted">
        Changing and publishing the page again stops a running split. Starting one counts as one of this month’s A/B tests.
        {experimentsUsageLabel(usage) ? ` ${experimentsUsageLabel(usage)}.` : ''}
      </p>
    </div>
  );
}
