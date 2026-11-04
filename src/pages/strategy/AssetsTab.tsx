// Assets to create: pages, a lead magnet, emails, tools, the listing and its images, video, product files
// or packages, each marked done when the app can see it made, with the button to the tool that makes it.
import { Check } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { ASSET_LABEL, type ActionCtx } from '@/lib/strategy';
import { assetTarget, runTarget } from '@/lib/strategyActions';
import { CopyButton } from '@/components/ui/primitives';
import { Backing, PageCard, SectionFooter, SourcesList, StaleBanners, citedBy } from './parts';

export function AssetsTab({ project, s, ctx }: { project: Project; s: StrategyState; ctx: ActionCtx }) {
  const a = s.assets;
  if (!a) {
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">Not written yet. It’s step 4 of 6.</p>
        <PageCard project={project} s={s} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <StaleBanners project={project} s={s} step="assets" />
      {a.assets.length === 0 ? (
        <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">Nothing new to make: your project already has what this step looks for.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {a.assets.map((x) => {
            const t = assetTarget(x, project, s, ctx);
            return (
              <li key={x.id} className="panel flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="badge bg-primary-soft text-primary">{ASSET_LABEL[x.kind]}</span>
                  {t.done ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-good">
                      <Check size={13} /> Done in the app
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-muted">To do</span>
                  )}
                </div>
                <h3 className="text-[14px] font-semibold text-ink">{x.title}</h3>
                {x.why && <p className="text-[13px] text-ink-2">{x.why}</p>}
                <Backing item={x} all={s.sources} />
                {x.kind === 'code' && x.prompt && (
                  <div className="rounded-md bg-surface-2 p-2.5">
                    <p className="text-xs font-semibold text-ink-2">Suggested request</p>
                    <p className="mt-0.5 text-[13px] text-ink">{x.prompt}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <CopyButton text={x.prompt} size="xs" />
                      <span className="text-xs text-muted">Copy it, then paste it in Code & assets.</span>
                    </div>
                  </div>
                )}
                {t.button && (
                  <div>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void runTarget(t.button!.target)}>
                      {t.button.label}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <PageCard project={project} s={s} />
      <SourcesList ns={citedBy(a.assets)} all={s.sources} title="Sources this section cites" />
      <SectionFooter project={project} s={s} step="assets" />
    </div>
  );
}
