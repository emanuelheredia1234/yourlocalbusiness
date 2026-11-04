import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Map as MapIcon, Package, Pencil, Search, Store as StoreIcon, Users, X } from 'lucide-react';
import type { ListingKind } from '@/lib/types';
import { cn, fmtDateTime } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { useRuntime } from '@/lib/platform';
import { pushMyListings, refreshCommunity, startCommunitySync } from '@/lib/community';
import { BUSINESS_CATEGORIES, FORMAT_LIST, FORMATS } from '@/ai/knowledge';
import { filterListings, listingCities, type ListingSort } from '@/lib/marketplace';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast, useTabRequest, useUI } from '@/store/ui';
import { tabsOf } from '@/lib/pageTabs';
import { Empty, Segmented, Tabs, confirmAction } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { ListingCard, ListingCover, UsMap } from './ListingParts';
import { priceLabel } from '@/lib/listing';
import { useAllListings } from './useListings';
import { listingActions } from '@/lib/listingActions';

type Kind = 'all' | ListingKind;
type Sort = ListingSort;


export default function Marketplace() {
  const project = useActiveProject();
  const listings = useAllListings();
  const myListings = useStore((s) => s.myListings);
  const unpublish = useStore((s) => s.unpublishListing);
  const updateStudio = useStore((s) => s.updateProject);
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


  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="page-title">Marketplace</h1>
          <p className="mt-1 max-w-[66ch] text-body text-muted">
            Digital products and local businesses. You buy, book or get in touch on each seller’s own site, email or phone: this app takes no payments.{' '}
            {community === 'live' ? 'Listings here are shared with everyone who uses this app.' : 'Right now only you can see your listings here.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('badge h-7 px-2.5', community === 'live' ? 'bg-good-soft text-good' : 'bg-surface-2 text-muted')} title={community === 'live' ? 'Everyone who uses this app sees the listings' : 'Only you see your listings'}>
            <Users size={12} /> {community === 'live' ? 'Shared marketplace' : 'Only you can see this'}
          </span>
          <button className="btn btn-primary" onClick={() => navigate('studio')}>
            <StoreIcon size={16} /> List on the marketplace
          </button>
        </div>
      </div>

      <Tabs
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
              <div className="relative min-w-[220px] flex-1">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input className="input pl-9" placeholder="Search products, businesses, cities…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the marketplace" />
              </div>
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
              <select className="select w-auto" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort listings">
                <option value="recommended">Recommended</option>
                <option value="newest">Newest</option>
                <option value="price-asc">Price: low to high</option>
                <option value="price-desc">Price: high to low</option>
              </select>
            </div>
            <div className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              <button className={cn('chip', !cat && 'chip-active')} onClick={() => setCat('')}>
                All categories
              </button>
              {pills.map((p) => (
                <button key={p.id} className={cn('chip', cat === p.id && 'chip-active')} onClick={() => setCat(cat === p.id ? '' : p.id)}>
                  {FORMATS[p.id as keyof typeof FORMATS] && <Icon name={FORMATS[p.id as keyof typeof FORMATS].icon} size={12} />}
                  {p.label}
                </button>
              ))}
            </div>
            {kind !== 'product' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-caption font-semibold text-muted">Location</span>
                <select
                  className="select input-sm w-auto"
                  value={city}
                  onChange={(e) => {
                    setCity(e.target.value);
                    if (e.target.value) {
                      setKind('business');
                      setNear(0);
                    }
                  }}
                  aria-label="Filter by city"
                >
                  <option value="">Any location</option>
                  {cities.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                {origin && (
                  <select
                    className="select input-sm w-auto"
                    value={near}
                    onChange={(e) => {
                      setNear(Number(e.target.value));
                      if (Number(e.target.value)) {
                        setCity('');
                        setKind('business');
                      }
                    }}
                    aria-label="Distance from your business"
                  >
                    <option value={0}>Any distance</option>
                    {[10, 25, 50, 100, 250].map((m) => (
                      <option key={m} value={m}>
                        Within {m} mi of {project?.location?.city}
                      </option>
                    ))}
                  </select>
                )}
                <button className={cn('btn btn-sm', showMap ? 'btn-ai' : 'btn-secondary')} onClick={() => setShowMap((m) => !m)}>
                  <MapIcon size={14} /> {showMap ? 'Hide map' : 'Map'}
                </button>
                {(city || near > 0) && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setCity('');
                      setNear(0);
                    }}
                  >
                    <X size={14} /> Clear location
                  </button>
                )}
              </div>
            )}
            {showMap && kind !== 'product' && (
              <UsMap
                listings={listings.filter((l) => l.kind === 'business')}
                selected={city}
                onSelect={(c) => {
                  setCity(c);
                  setKind('business');
                  setNear(0);
                }}
              />
            )}
          </div>

          {listings.length === 0 ? (
            <Empty icon={<StoreIcon size={20} />} title="No listings yet" body="Publish yours from the Studio and it shows up here." action={<button className="btn btn-primary btn-sm" onClick={() => navigate('studio')}>Open Studio</button>} />
          ) : filtered.length === 0 ? (
            <Empty icon={<Search size={20} />} title="No listings match" body="Try another search, category or location." action={<button className="btn btn-secondary btn-sm" onClick={() => { setQ(''); setCat(''); setCity(''); setNear(0); setKind('all'); }}>Reset filters</button>} />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((l) => (
                <ListingCard key={l.id} listing={l} onOpen={() => openListing(l.id)} />
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'mine' && (
        <div className="flex flex-col gap-3">
          {myListings.length === 0 ? (
            <Empty icon={<Package size={20} />} title="You haven’t published anything yet" body="Build your product or business in the Studio, then publish it here in one click." action={<button className="btn btn-primary btn-sm" onClick={() => navigate('studio')}>Open Studio</button>} />
          ) : (
            myListings.map((l) => (
              <div key={l.id} className="panel flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                <ListingCover listing={l} className="aspect-[16/10] w-full shrink-0 rounded-md sm:w-40" />
                <div className="min-w-0 flex-1">
                  <p className="text-h3 font-semibold">{l.title}</p>
                  <p className="truncate text-small text-muted">{l.tagline}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-caption text-muted">
                    <span className="num font-semibold text-ink">{priceLabel(l.price, l.priceModel)}</span>
                    <span>Listed {fmtDateTime(l.createdAt)}</span>
                    {!listingActions(l).length && <span className="text-warn">No buy link or contact yet</span>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-secondary btn-sm" onClick={() => openListing(l.id)}>
                    <ExternalLink size={14} /> View
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => { if (l.projectId) useStore.getState().setActiveProject(l.projectId); navigate('studio'); }}>
                    <Pencil size={14} /> Edit
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      if (!(await confirmAction({ title: 'Unpublish this listing?', body: 'It will be removed from the marketplace. You can publish again anytime.', confirmLabel: 'Unpublish', danger: true }))) return;
                      unpublish(l.id);
                      if (l.projectId) updateStudio(l.projectId, (p) => ({ ...p, studio: { ...p.studio, publishedListingId: undefined, publishedAt: undefined } }));
                      pushMyListings();
                      toast({ kind: 'success', title: 'Listing unpublished' });
                    }}
                  >
                    Unpublish
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

    </div>
  );
}
