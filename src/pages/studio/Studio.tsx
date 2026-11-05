import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { FORMATS } from '@/ai/knowledge';
import { navigate } from '@/lib/router';
import { useActiveProject, useStore } from '@/store/useStore';
import { useTabRequest, useUI } from '@/store/ui';
import { tabsOf } from '@/lib/pageTabs';
import { PageHeader, StatusDot, Tabs, Tooltip } from '@/components/ui/primitives';
import { StructureTab } from './StructureTab';
import { CodeTab } from './CodeTab';
import { PublishTab } from './PublishTab';
import { leadPrice, priceLabel } from '@/lib/listing';

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
  // a tab asked for from elsewhere (the assistant)
  useTabRequest<Tab>('studio', tabsOf('studio') as Tab[], setTab);
  const isBiz = project.track === 'business';
  const fmt = project.format ? FORMATS[project.format] : null;
  const lp = leadPrice(project);
  const structureCount = isBiz ? project.studio.packages.length : project.studio.outline.length;
  // "Copper & Comb · $75/session · Austin" (a product: its format instead of a city)
  const description = [project.brand.name, priceLabel(lp.price, lp.model), isBiz ? project.location?.city : fmt?.label].filter(Boolean).join(' · ');

  return (
    <div>
      <PageHeader
        className="mb-4"
        title={isBiz ? 'Business Studio' : 'Product Studio'}
        description={description}
        meta={
          live ? (
            <>
              <StatusDot tone="good">Live on Marketplace</StatusDot>
              <Tooltip content="View in the Marketplace">
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-primary transition-colors duration-120 hover:bg-primary-soft"
                  aria-label="View your listing in the Marketplace"
                  onClick={() => {
                    navigate('store');
                    setTimeout(() => useUI.getState().openListing(live.id), 60);
                  }}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                </button>
              </Tooltip>
            </>
          ) : undefined
        }
      />

      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'structure', label: isBiz ? 'Business model' : 'Structure & outline', count: structureCount || undefined },
          { id: 'code', label: 'Code & assets', count: project.studio.codeAssets.length || undefined },
          { id: 'publish', label: 'Listing & publish' },
        ]}
      />

      {tab === 'structure' && <StructureTab project={project} />}
      {tab === 'code' && <CodeTab project={project} />}
      {tab === 'publish' && <PublishTab project={project} />}
    </div>
  );
}
