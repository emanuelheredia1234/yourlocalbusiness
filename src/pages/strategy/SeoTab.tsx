// The SEO page: which page to build first, and direction for it (who it's for, the angle, the questions to
// answer, search phrases to check, the call to action) that can go into the SEO page's "Guide the AI" box.
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { CTA_LABEL } from '@/lib/strategy';
import { navigate } from '@/lib/router';
import { fmtDate } from '@/lib/utils';
import { Backing, PageCard, SectionFooter, SourcesList, StaleBanners, citedBy } from './parts';
import { seoFlow } from './apply';

export function SeoTab({ project, s }: { project: Project; s: StrategyState }) {
  const seo = s.assets?.seo;
  return (
    <div className="flex flex-col gap-5">
      {s.assets && <StaleBanners project={project} s={s} step="assets" />}
      <PageCard project={project} s={s} />
      {!seo ? (
        <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">The direction for your SEO page comes with “Assets to create”, step 4 of 6.</p>
      ) : (
        <section className="panel flex flex-col gap-2.5 p-4 sm:p-5" aria-label="Guidance for your SEO page">
          <h2 className="section-title">Guidance for your SEO page</h2>
          {seo.audience && <p className="text-[13.5px] text-ink">Who it’s for: {seo.audience}</p>}
          {seo.angle && <p className="text-[13.5px] text-ink">Angle: {seo.angle}</p>}
          {seo.objections.length > 0 && (
            <div>
              <p className="text-[13.5px] text-ink">Questions to answer:</p>
              <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-ink-2">
                {seo.objections.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {seo.keywords.length > 0 && (
            <div>
              <p className="text-[13.5px] text-ink">Search terms to work in:</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {seo.keywords.map((k) => (
                  <span key={k} className="chip">
                    {k}
                  </span>
                ))}
              </div>
              {seo.basis !== 'web' && <p className="mt-1 text-xs text-muted">Ideas to check, not search data</p>}
            </div>
          )}
          <p className="text-[13.5px] text-ink">Call to action: {CTA_LABEL[seo.cta]}</p>
          {seo.why && <p className="text-[13px] text-ink-2">{seo.why}</p>}
          <Backing item={seo} all={s.sources} />
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void seoFlow(project.id)}>
              Add to the SEO page’s guidance
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void navigate('marketing-seo')}>
              Open SEO page
            </button>
            {s.applied.seo && <span className="text-xs text-muted">Added {fmtDate(s.applied.seo.at)}.</span>}
          </div>
        </section>
      )}
      {seo && <SourcesList ns={citedBy([seo])} all={s.sources} title="Sources this section cites" />}
      <SectionFooter project={project} s={s} step="assets" />
    </div>
  );
}
