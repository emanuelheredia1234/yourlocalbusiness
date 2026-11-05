import { useEffect, useMemo, useState } from 'react';
import { Map as MapIcon, Pencil, Search, SlidersHorizontal, Store as StoreIcon, X } from 'lucide-react';
import type { Listing, ListingKind } from '@/lib/types';
import { cn, fmtDate } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { useMediaQuery } from '@/lib/hooks';
import { useRuntime } from '@/lib/platform';
import { pushMyListings, refreshCommunity, startCommunitySync } from '@/lib/community';
import { BUSINESS_CATEGORIES, FORMAT_LIST, FORMATS } from '@/ai/knowledge';
import { filterListings, listingCities, type ListingSort } from '@/lib/marketplace';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast, useTabRequest, useUI } from '@/store/ui';
import { tabsOf } from '@/lib/pageTabs';
import { Drawer, Empty, Field, MoreMenu, PageHeader, Segmented, Select, StatusDot, Tabs, Toggle, confirmAction } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { ListingCard, ListingCover, UsMap } from './ListingParts';
import { priceLabel } from '@/lib/listing';
import { useAllListings } from './useListings';
import { listingActions } from '@/lib/listingActions';

type Kind = 'all' | ListingKind;
type Sort = ListingSort;

const SORTS: { value: Sort; label: string }[] = [
  { value: 'recommended', label: 'Recommended' },
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
];

export default function Marketplace() {
  const project = useActiveProject();
  const listings = useAllListings();
  const myListings = useStore((s) => s.myListings);
  const community = useRuntime((s) => s.community);
  const openListing = useUI((s) => s.openListing);
  const [tab, setTab] = useState<'browse' | 'mine'>('browse');
  // a tab asked for from elsewhere (the assistant)
  useTabRequest<'browse' | 'mine'>('store', tabsOf('store') as ('browse' | 'mine')[], setTab);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [cat, setCat] = useState('');
  const [city, setCity] = useState('');
  const [near, setNear] = useState<number>(0);
  const [showMap, setShowMap] = useState(false);
  const [sort, setSort] = useState<Sort>('recommended');

  useEffect(() => {
    // first visit starts sharing; later visits fetch the newest listings
    void startCommunitySync().then(() => refreshCommunity());
  }, []);

  const origin = project?.location?.lat !== undefined && project.location.lng !== undefined ? { lat: project.location.lat, lng: project.location.lng } : null;

  const filtered = useMemo(() => filterListings(listings, { q, kind, cat, city, near, origin, sort }), [listings, kind, cat, city, near, origin, q, sort]);

  const cities = useMemo(() => listingCities(listings), [listings]);

  const pills = kind === 'business' ? BUSINESS_CATEGORIES.map((c) => ({ id: c, label: c })) : kind === 'product' ? FORMAT_LIST.map((f) => ({ id: f.id as string, label: f.label })) : [...FORMAT_LIST.slice(0, 5).map((f) => ({ id: f.id as string, label: f.label })), ...BUSINESS_CATEGORIES.slice(0, 4).map((c) => ({ id: c, label: c }))];
  const shared = community === 'live';
  const wide = useMediaQuery('(min-width: 640px)');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = (kind !== 'all' ? 1 : 0) + (sort !== 'recommended' ? 1 : 0) + (city ? 1 : 0) + (near ? 1 : 0);
  const kindControl = (
    <Segmented
      options={[
        { id: 'all', label: 'All' },
        { id: 'product', label: 'Digital products' },
        { id: 'business', label: 'Local & online businesses' },
      ]}
      value={kind}
      onChange={(v) => {
        setKind(v);
        setCat('');
        if (v === 'product') {
          setCity('');
          setNear(0);
        }
      }}
    />
  );
  const sortControl = (className: string) => <Select<Sort> className={className} value={sort} onChange={setSort} options={SORTS} aria-label="Sort listings" />;
  const cityControl = (className: string) => (
    <Select
      size={wide ? 'sm' : 'md'}
      className={className}
      value={city || '__any'}
      onChange={(v) => {
        const c = v === '__any' ? '' : v;
        setCity(c);
        if (c) {
          setKind('business');
          setNear(0);
        }
      }}
      aria-label="Filter by city"
      options={[{ value: '__any', label: 'Any location' }, ...cities.map((c) => ({ value: c, label: c }))]}
    />
  );
  const distanceControl = (className: string) =>
    origin ? (
      <Select
        size={wide ? 'sm' : 'md'}
        className={className}
        value={String(near)}
        onChange={(v) => {
          const n = Number(v);
          setNear(n);
          if (n) {
            setCity('');
            setKind('business');
          }
        }}
        aria-label="Distance from your business"
        options={[{ value: '0', label: 'Any distance' }, ...[10, 25, 50, 100, 250].map((m) => ({ value: String(m), label: `Within ${m} mi of ${project?.location?.city}` }))]}
      />
    ) : null;
  const filtering = !!(q.trim() || cat || city || near || kind !== 'all');
  const clearFilters = () => {
    setQ('');
    setCat('');
    setCity('');
    setNear(0);
    setKind('all');
  };

  return (
    <div>
      <PageHeader
        className="mb-4"
        title="Marketplace"
        meta={
          <>
            <StatusDot tone={shared ? 'good' : 'faint'}>{shared ? 'Shared marketplace' : 'Only you can see this'}</StatusDot>
            <span aria-hidden="true" className="max-md:hidden">
              ·
            </span>
            <span className="max-md:hidden">{shared ? 'Listings here are shared with everyone who uses this app.' : 'Right now only you can see your listings here.'}</span>
            <span aria-hidden="true">·</span>
            <span>This app takes no payments.</span>
          </>
        }
        actions={
          wide ? (
            <button type="button" className="btn btn-primary" onClick={() => navigate('studio')}>
              <StoreIcon /> List on the marketplace
            </button>
          ) : undefined
        }
      />

      <Tabs
        className="mb-5"
        tabs={[
          { id: 'browse', label: 'Browse', count: filtered.length },
          { id: 'mine', label: 'My listings', count: myListings.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'browse' && (
        <>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className={cn('relative min-w-0 flex-1', wide && 'min-w-[200px] basis-60')}>
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
                <input className="input pl-9" placeholder="Search products, businesses, cities…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the marketplace" />
              </div>
              {wide ? (
                <>
                  {kindControl}
                  {sortControl('ml-auto w-[176px]')}
                </>
              ) : (
                <button type="button" className="btn btn-secondary" onClick={() => setFiltersOpen(true)}>
                  <SlidersHorizontal /> Filters
                  {activeFilters > 0 && <span className="num font-mono text-caption text-muted">{activeFilters}</span>}
                </button>
              )}
            </div>
            {/* edge to edge, so the fades sit in the page gutter and the first chip starts unfaded */}
            <div className="scroll-fade-x -mx-4 flex gap-1.5 px-4 py-0.5 sm:-mx-6 sm:px-6">
              <button type="button" className={cn('chip', !cat && 'chip-active')} onClick={() => setCat('')}>
                All categories
              </button>
              {pills.map((p) => (
                <button type="button" key={p.id} className={cn('chip', cat === p.id && 'chip-active')} onClick={() => setCat(cat === p.id ? '' : p.id)} aria-pressed={cat === p.id}>
                  {FORMATS[p.id as keyof typeof FORMATS] && <Icon name={FORMATS[p.id as keyof typeof FORMATS].icon} size={14} />}
                  {p.label}
                </button>
              ))}
            </div>
            {wide && kind !== 'product' && (
              <div className="flex flex-wrap items-center gap-2">
                {cityControl('w-auto min-w-[160px]')}
                {distanceControl('w-auto min-w-[160px]')}
                <button type="button" className={cn('chip', showMap && 'chip-active')} onClick={() => setShowMap((m) => !m)} aria-pressed={showMap}>
                  <MapIcon /> Map
                </button>
                {(city || near > 0) && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setCity('');
                      setNear(0);
                    }}
                  >
                    <X /> Clear location
                  </button>
                )}
              </div>
            )}
            {showMap && kind !== 'product' && (
              <div className="max-w-[720px]">
                <UsMap
                  listings={listings.filter((l) => l.kind === 'business')}
                  selected={city}
                  onSelect={(c) => {
                    setCity(c);
                    setKind('business');
                    setNear(0);
                  }}
                />
              </div>
            )}
          </div>

          <div className="mt-6">
            {listings.length === 0 ? (
              <Empty
                icon={<StoreIcon />}
                title="No listings yet"
                body="Publish yours from the Studio and it shows up here."
                action={
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate('studio')}>
                    Open Studio
                  </button>
                }
              />
            ) : filtered.length === 0 ? (
              <Empty
                variant="inline"
                className="justify-center py-10"
                title={q.trim() ? `No matches for “${q.trim()}”` : 'No listings match these filters'}
                action={
                  filtering ? (
                    <button type="button" className="link" onClick={clearFilters}>
                      Clear filters
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {filtered.map((l) => (
                  <ListingCard key={l.id} listing={l} onOpen={() => openListing(l.id)} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'mine' && <MyListings />}

      {!wide && (
        <Drawer
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          title="Filters"
          footer={
            <>
              <button type="button" className="btn btn-ghost btn-sm mr-auto" onClick={clearFilters} disabled={!filtering}>
                Clear filters
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setFiltersOpen(false)}>
                Show {filtered.length} listing{filtered.length === 1 ? '' : 's'}
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <Field label="Show">{kindControl}</Field>
            <Field label="Sort">{sortControl('w-full')}</Field>
            {kind !== 'product' && (
              <Field label="Location">
                <div className="flex flex-col gap-2">
                  {cityControl('w-full')}
                  {distanceControl('w-full')}
                </div>
              </Field>
            )}
            {kind !== 'product' && <Toggle checked={showMap} onChange={setShowMap} label="Show the map" />}
          </div>
        </Drawer>
      )}
    </div>
  );
}

/** Your published listings: what each costs, when it went up, whether people can reach you, and its actions. */
function MyListings() {
  const myListings = useStore((s) => s.myListings);
  const openListing = useUI((s) => s.openListing);
  if (!myListings.length)
    return (
      <Empty
        icon={<StoreIcon />}
        title="Nothing listed yet"
        body="List your business so locals can find it."
        action={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate('studio')}>
            Open Listing & publish
          </button>
        }
      />
    );
  return (
    <div className="card overflow-hidden">
      <table className="w-full table-fixed text-left text-small">
        <thead className="border-b border-line text-caption text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Listing</th>
            <th className="hidden w-[120px] px-2 py-2 font-medium sm:table-cell">Price</th>
            <th className="hidden w-[130px] px-2 py-2 font-medium lg:table-cell">Listed</th>
            <th className="hidden w-[220px] px-2 py-2 font-medium md:table-cell">Status</th>
            <th className="w-[52px] px-2 py-2 sm:w-[212px]">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {myListings.map((l) => (
            <MyListingRow key={l.id} listing={l} onOpen={() => openListing(l.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MyListingRow({ listing: l, onOpen }: { listing: Listing; onOpen: () => void }) {
  const unpublish = useStore((s) => s.unpublishListing);
  const updateStudio = useStore((s) => s.updateProject);
  const reachable = listingActions(l).length > 0;
  const edit = () => {
    if (l.projectId) useStore.getState().setActiveProject(l.projectId);
    navigate('studio');
  };
  const remove = async () => {
    if (!(await confirmAction({ title: 'Unpublish this listing?', body: 'It will be removed from the marketplace. You can publish again anytime.', confirmLabel: 'Unpublish', danger: true }))) return;
    unpublish(l.id);
    if (l.projectId) updateStudio(l.projectId, (p) => ({ ...p, studio: { ...p.studio, publishedListingId: undefined, publishedAt: undefined } }));
    pushMyListings();
    toast({ kind: 'success', title: 'Listing unpublished' });
  };
  const status = reachable ? <StatusDot tone="good">Live</StatusDot> : <StatusDot tone="warn">No buy link or contact yet</StatusDot>;
  return (
    <tr className="transition-colors duration-120 hover:bg-surface-2">
      <td className="px-4 py-3">
        <button type="button" className="flex w-full min-w-0 items-center gap-3 text-left" onClick={onOpen} aria-label={`View ${l.title}`}>
          <ListingCover listing={l} className="aspect-[4/3] w-16 shrink-0 rounded-md" />
          <span className="min-w-0">
            <span className="block truncate text-ui text-ink">{l.title}</span>
            <span className="block truncate text-small text-muted">{l.tagline}</span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden">
              <span className="num font-mono text-caption font-semibold text-ink sm:hidden">{priceLabel(l.price, l.priceModel)}</span>
              {status}
            </span>
          </span>
        </button>
      </td>
      <td className="num hidden px-2 py-3 font-mono text-ui font-semibold text-ink sm:table-cell">{priceLabel(l.price, l.priceModel)}</td>
      <td className="num hidden px-2 py-3 font-mono text-caption text-muted lg:table-cell">{fmtDate(l.createdAt, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
      <td className="hidden px-2 py-3 md:table-cell">{status}</td>
      <td className="px-2 py-3">
        <div className="flex items-center justify-end gap-1">
          <span className="hidden items-center gap-1 sm:flex">
            <button type="button" className="btn btn-ghost btn-sm" onClick={edit}>
              <Pencil /> Edit
            </button>
            <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => void remove()}>
              Unpublish
            </button>
          </span>
          <span className="sm:hidden">
            <MoreMenu
              items={[
                { label: 'Edit', icon: <Pencil />, onSelect: edit },
                'separator',
                { label: 'Unpublish', danger: true, onSelect: () => void remove() },
              ]}
            />
          </span>
        </div>
      </td>
    </tr>
  );
}

