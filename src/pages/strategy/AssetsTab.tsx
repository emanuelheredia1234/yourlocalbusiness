// Assets to create: pages, a lead magnet, emails, tools, the listing and its images, video, product files
// or packages, each marked done when the app can see it made, with the button to the tool that makes it.
import type { ReactNode } from 'react';
import { BookOpen, CodeXml, FileText, Globe, Image, Mail, Package, PackageOpen, Store, Video } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { AssetKind, StrategyState } from '@/lib/strategyTypes';
import { ASSET_LABEL, type ActionCtx } from '@/lib/strategy';
import { assetTarget, runTarget } from '@/lib/strategyActions';
import { Badge, CopyButton, Empty } from '@/components/ui/primitives';
import { BasisTip, Cite, PageCard, SectionFooter, SourcesList, StaleNote, citedBy } from './parts';

const ICON: Record<AssetKind, ReactNode> = {
  page: <Globe />,
  lead_magnet: <BookOpen />,
  emails: <Mail />,
  code: <CodeXml />,
  listing: <Store />,
  listing_images: <Image />,
  video: <Video />,
  product_file: <FileText />,
  packages: <Package />,
  other: <PackageOpen />,
};

export function AssetsTab({ project, s, ctx }: { project: Project; s: StrategyState; ctx: ActionCtx }) {
  const a = s.assets;
  if (!a) {
    return (
      <div>
        <Empty icon={<PackageOpen />} title="Not written yet" body="It’s step 4 of 6." />
        <PageCard project={project} s={s} className="mt-6" />
      </div>
    );
  }
  return (
    <div>
      <StaleNote project={project} s={s} step="assets" />
      {a.assets.length === 0 ? (
        <Empty icon={<PackageOpen />} title="Nothing new to make" body="Your project already has what this step looks for." />
      ) : (
        <ul className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2" aria-label="Assets to create">
          {a.assets.map((x) => {
            const t = assetTarget(x, project, s, ctx);
            return (
              <li key={x.id} className="card flex min-w-0 flex-col gap-3 p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2 [&>svg]:size-4" aria-hidden="true">
                    {ICON[x.kind] ?? <PackageOpen />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="flex items-center gap-1 text-h3 text-ink">
                      <span className="min-w-0">{x.title}</span>
                      <BasisTip items={[x]} />
                    </h3>
                    <p className="text-small text-muted">{ASSET_LABEL[x.kind]}</p>
                  </div>
                  {t.done && (
                    <Badge tone="good" className="shrink-0">
                      Done in the app
                    </Badge>
                  )}
                </div>
                {x.why && (
                  <p className="text-body text-ink-2">
                    {x.why}
                    <Cite item={x} all={s.sources} />
                  </p>
                )}
                {x.kind === 'code' && x.prompt && (
                  <div className="well px-3 py-2.5">
                    <p className="text-small font-medium text-ink-2">Suggested request</p>
                    <p className="mt-0.5 text-small text-ink">{x.prompt}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <CopyButton text={x.prompt} size="xs" />
                      <span className="text-caption text-muted">Paste it in Code & assets.</span>
                    </div>
                  </div>
                )}
                {t.button && (
                  <div className="mt-auto pt-1">
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
      <PageCard project={project} s={s} className="mt-10" />
      <SourcesList ns={citedBy(a.assets)} all={s.sources} />
      <SectionFooter project={project} s={s} step="assets" />
    </div>
  );
}
