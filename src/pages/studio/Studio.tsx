import { useState } from 'react';
import { Code2, ExternalLink, ListTree, Rocket, Store } from 'lucide-react';
import { FORMATS, matchBusinessType } from '@/ai/knowledge';
import { navigate } from '@/lib/router';
import { useActiveProject, useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { Tabs } from '@/components/ui/primitives';
import { priceLabel } from '@/pages/store/ListingParts';
import { StructureTab } from './StructureTab';
import { CodeTab } from './CodeTab';
import { PublishTab } from './PublishTab';
import { leadPrice } from './listing';

type Tab = 'structure' | 'code' | 'publish';
const KEY = 'ylb-studio-tab';

function readTab(): Tab {
  try {
    const v = sessionStorage.getItem(KEY);
    return v === 'code' || v === 'publish' ? v : 'structure';
  } catch {
    return 'structure';
  }
}

export default function Studio() {
  const project = useActiveProject()!;
  const live = useStore((s) => s.myListings.find((l) => l.id === project.studio.publishedListingId));
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      sessionStorage.setItem(KEY, t);
    } catch {
      /* per-viewer convenience only */
    }
  };
  const isBiz = project.track === 'business';
  const fmt = project.format ? FORMATS[project.format] : null;
  const bt = isBiz ? matchBusinessType(`${project.businessType} ${project.category} ${project.niche}`) : null;
  const lp = leadPrice(project);
  const structureCount = isBiz ? project.studio.packages.length : project.studio.outline.length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1">{isBiz ? 'Business Studio' : 'Product Studio'}</p>
          <h1 className="page-title truncate">{isBiz ? project.brand.name : project.idea?.title ?? project.brand.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-muted">
            <span>{isBiz ? bt?.label : fmt?.label ?? 'Digital product'}</span>
            <span aria-hidden="true">·</span>
            <span className="num">{priceLabel(lp.price, lp.model)}</span>
            {project.location?.city && (
              <>
                <span aria-hidden="true">·</span>
                <span>{project.location.city}</span>
              </>
            )}
            {(project.idea?.audience || project.brand.audience) && (
              <>
                <span aria-hidden="true">·</span>
                <span className="max-w-[420px] truncate">for {project.idea?.audience || project.brand.audience}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {live ? (
            <button
              className="btn btn-secondary"
              onClick={() => {
                navigate('store');
                setTimeout(() => useUI.getState().openListing(live.id), 60);
              }}
            >
              <span className="h-2 w-2 rounded-full bg-good" aria-hidden="true" /> Live on Marketplace <ExternalLink size={14} />
            </button>
          ) : null}
          <button className="btn btn-primary" onClick={() => setTab('publish')}>
            <Rocket size={16} /> {live ? 'Update listing' : 'Publish to Store'}
          </button>
        </div>
      </header>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'structure', label: isBiz ? 'Business model' : 'Structure & outline', icon: <ListTree size={15} />, count: structureCount || undefined },
          { id: 'code', label: 'Code & assets', icon: <Code2 size={15} />, count: project.studio.codeAssets.length || undefined },
          { id: 'publish', label: 'Listing & publish', icon: <Store size={15} /> },
        ]}
      />

      {tab === 'structure' && <StructureTab project={project} />}
      {tab === 'code' && <CodeTab project={project} />}
      {tab === 'publish' && <PublishTab project={project} />}
    </div>
  );
}
