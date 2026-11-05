// The SEO page: which page to build first, and direction for it (who it's for, the angle, the questions to
// answer, search phrases to check, the call to action) that can go into the SEO page's "Guide the AI" box.
import { Globe } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { CTA_LABEL } from '@/lib/strategy';
import { navigate } from '@/lib/router';
import { fmtDate } from '@/lib/utils';
import { Empty, Section } from '@/components/ui/primitives';
import { BasisTip, Cite, PageCard, SectionFooter, SourcesList, StaleNote, citedBy } from './parts';
import { seoFlow } from './apply';

export function SeoTab({ project, s }: { project: Project; s: StrategyState }) {
  const seo = s.assets?.seo;
  return (
    <div>
      {s.assets && <StaleNote project={project} s={s} step="assets" />}
      <PageCard project={project} s={s} />
      {!seo ? (
        <Empty className="mt-6" icon={<Globe />} title="No direction yet" body="The direction for your SEO page comes with “Assets to create”, step 4 of 6." />
      ) : (
        <Section
          title={
            <span className="inline-flex items-center gap-1">
              Guidance for your SEO page
              <BasisTip items={[seo]} />
            </span>
          }
        >
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(140px,auto)_1fr]">
            {seo.audience && (
              <>
                <dt className="text-small text-muted sm:text-body">Who it’s for</dt>
                <dd className="-mt-2 text-body text-ink sm:mt-0">{seo.audience}</dd>
              </>
            )}
            {seo.angle && (
              <>
                <dt className="text-small text-muted sm:text-body">Angle</dt>
                <dd className="-mt-2 text-body text-ink sm:mt-0">{seo.angle}</dd>
              </>
            )}
            {seo.objections.length > 0 && (
              <>
                <dt className="text-small text-muted sm:text-body">Questions to answer</dt>
                <dd className="-mt-2 sm:mt-0">
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-ink marker:text-faint">
                    {seo.objections.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {seo.keywords.length > 0 && (
              <>
                <dt className="text-small text-muted sm:text-body">Search terms</dt>
                <dd className="-mt-2 sm:mt-0">
                  <span className="flex flex-wrap gap-1.5">
                    {seo.keywords.map((k) => (
                      <span key={k} className="rounded-sm bg-surface-3 px-2 py-0.5 text-small text-ink-2">
                        {k}
                      </span>
                    ))}
                  </span>
                  {seo.basis !== 'web' && <span className="mt-1 block text-caption text-muted">Ideas to check, not search data</span>}
                </dd>
              </>
            )}
            <dt className="text-small text-muted sm:text-body">Call to action</dt>
            <dd className="-mt-2 text-body text-ink sm:mt-0">{CTA_LABEL[seo.cta]}</dd>
          </dl>
          {seo.why && (
            <p className="mt-4 max-w-[72ch] text-small text-ink-2">
              {seo.why}
              <Cite item={seo} all={s.sources} />
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void seoFlow(project.id)}>
              Add to the SEO page’s guidance
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void navigate('marketing-seo')}>
              Open SEO page
            </button>
            {s.applied.seo && <span className="text-small text-muted">Added {fmtDate(s.applied.seo.at)}.</span>}
          </div>
        </Section>
      )}
      {seo && <SourcesList ns={citedBy([seo])} all={s.sources} />}
      <SectionFooter project={project} s={s} step="assets" />
    </div>
  );
}
