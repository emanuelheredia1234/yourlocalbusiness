import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Map as MapIcon, Package, Pencil, Search, Store as StoreIcon, Users, X } from 'lucide-react';
import type { Listing, ListingKind } from '@/lib/types';
import { cn, fmtDateTime, fmtMoney, slugify } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { useRuntime } from '@/lib/platform';
import { pushMyListings, startCommunitySync } from '@/lib/community';
import { BUSINESS_CATEGORIES, distanceMi, FORMAT_LIST, FORMATS } from '@/ai/knowledge';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { Empty, Segmented, Tabs, Toggle, confirmAction } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { download } from '@/components/ui/download';
import { ListingCard, ListingCover, priceLabel, Stars, UsMap } from './ListingParts';
import { useAllListings } from './useListings';
import { accessFile, addListingToCart } from './actions';

type Kind = 'all' | ListingKind;
type Sort = 'recommended' | 'newest' | 'price-asc' | 'price-desc' | 'rating';


export default function Marketplace() {
  const project = useActiveProject();
  const listings = useAllListings();
  const myListings = useStore((s) => s.myListings);
  const orders = useStore((s) => s.orders);
  const sales = useStore((s) => s.sales);
  const showSamples = useStore((s) => s.settings.showSampleListings);
  const updateSettings = useStore((s) => s.updateSettings);
  const unpublish = useStore((s) => s.unpublishListing);
  const updateStudio = useStore((s) => s.updateProject);
  const community = useRuntime((s) => s.community);
  const openListing = useUI((s) => s.openListing);
  const [tab, setTab] = useState<'browse' | 'mine' | 'purchases'>('browse');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [cat, setCat] = useState('');
  const [city, setCity] = useState('');
  const [near, setNear] = useState<number>(0);
  const [showMap, setShowMap] = useState(false);
  const [sort, setSort] = useState<Sort>('recommended');

  useEffect(() => {
    startCommunitySync();
  }, []);

  const origin = project?.location?.lat !== undefined && project.location.lng !== undefined ? { lat: project.location.lat, lng: project.location.lng } : null;

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let out = listings.filter((l) => {
      if (kind !== 'all' && l.kind !== kind) return false;
      if (cat) {
        if (l.kind === 'product' && !(l.format === cat || l.category === cat)) return false;
        if (l.kind === 'business' && l.category !== cat) return false;
      }
      if (city) {
        if (l.kind !== 'business') return false;
        if (city === 'Online') {
          if (!l.location?.online) return false;
        } else if (`${l.location?.city}, ${l.location?.region}` !== city) return false;
      }
      if (near && origin) {
        if (l.kind !== 'business' || l.location?.lat === undefined || l.location.lng === undefined) return false;
        if (distanceMi(origin, { lat: l.location.lat, lng: l.location.lng }) > near) return false;
      }
      if (ql) {
        const hay = `${l.title} ${l.tagline} ${l.description} ${l.seller.name} ${l.category} ${l.tags.join(' ')} ${l.location?.city ?? ''}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
    const score = (l: Listing) => l.rating * Math.log10(10 + l.reviews) + (l.origin === 'mine' ? 1000 : l.origin === 'community' ? 100 : 0);
    out = out.slice().sort((a, b) => {
      switch (sort) {
        case 'newest':
          return b.createdAt - a.createdAt;
        case 'price-asc':
          return a.price - b.price;
        case 'price-desc':
          return b.price - a.price;
        case 'rating':
          return b.rating - a.rating || b.reviews - a.reviews;
        default:
          return score(b) - score(a);
      }
    });
    return out;
  }, [listings, kind, cat, city, near, origin, q, sort]);

  const cities = useMemo(() => {
    const set = new Set<string>();
    listings.forEach((l) => l.kind === 'business' && l.location && set.add(l.location.city === 'Online' || l.location.online && !l.location.lat ? 'Online' : `${l.location.city}, ${l.location.region}`));
    return [...set].sort();
  }, [listings]);

  const pills = kind === 'business' ? BUSINESS_CATEGORIES.map((c) => ({ id: c, label: c })) : kind === 'product' ? FORMAT_LIST.map((f) => ({ id: f.id as string, label: f.label })) : [...FORMAT_LIST.slice(0, 5).map((f) => ({ id: f.id as string, label: f.label })), ...BUSINESS_CATEGORIES.slice(0, 4).map((c) => ({ id: c, label: c }))];

  const myRevenue = (id: string) => sales.filter((s) => s.listingId === id).reduce((n, s) => n + s.amount, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="page-title">Marketplace</h1>
          <p className="mt-1 max-w-[62ch] text-[14px] text-muted">Digital products from creators and services from local businesses. Anyone can buy from anyone, and everything you publish from the Studio appears here instantly.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('badge h-7 px-2.5', community === 'live' ? 'bg-good-soft text-good' : 'bg-surface-2 text-muted')} title={community === 'live' ? 'Listings sync with everyone this workspace is shared with' : 'Listings are stored on this device'}>
            <Users size={12} /> {community === 'live' ? 'Shared marketplace: live' : 'Local marketplace'}
          </span>
          <button className="btn btn-primary" onClick={() => navigate('studio')}>
            <StoreIcon size={16} /> Sell on the marketplace
          </button>
        </div>
      </div>

      <Tabs
        tabs={[
          { id: 'browse', label: 'Browse', count: filtered.length },
          { id: 'mine', label: 'My listings', count: myListings.length },
          { id: 'purchases', label: 'Purchases', count: orders.length },
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
                <option value="rating">Top rated</option>
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
                <span className="text-xs font-semibold text-muted">Location</span>
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
                <span className="ml-auto">
                  <Toggle checked={showSamples} onChange={(v) => updateSettings((s) => ({ ...s, showSampleListings: v }))} label="Show sample listings" />
                </span>
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

          {filtered.length === 0 ? (
            <Empty icon={<Search size={20} />} title="No listings match" body="Try another search, category or location." action={<button className="btn btn-secondary btn-sm" onClick={() => { setQ(''); setCat(''); setCity(''); setNear(0); setKind('all'); }}>Reset filters</button>} />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((l) => (
                <ListingCard key={l.id} listing={l} onOpen={() => openListing(l.id)} onAdd={() => addListingToCart(l)} />
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
                  <p className="font-display text-[16px] font-semibold">{l.title}</p>
                  <p className="truncate text-[13px] text-muted">{l.tagline}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted">
                    <span className="num font-semibold text-ink">{priceLabel(l.price, l.priceModel)}</span>
                    <Stars rating={l.rating} reviews={l.reviews} />
                    <span className="num">{l.sales} sold · {fmtMoney(myRevenue(l.id))} revenue</span>
                    <span>Listed {fmtDateTime(l.createdAt)}</span>
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

      {tab === 'purchases' && (
        <div className="flex flex-col gap-3">
          {orders.length === 0 ? (
            <Empty icon={<Package size={20} />} title="No purchases yet" body="Products you buy and services you book show up here." action={<button className="btn btn-secondary btn-sm" onClick={() => setTab('browse')}>Browse the marketplace</button>} />
          ) : (
            orders.map((o) => (
              <div key={o.id} className="panel p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-display text-[15px] font-semibold">Order {o.number}</p>
                    <p className="text-xs text-muted">
                      {fmtDateTime(o.createdAt)} · {o.paymentMethod}
                      {o.last4 ? ` •••• ${o.last4}` : ''}
                    </p>
                  </div>
                  <span className="num text-[15px] font-bold">{fmtMoney(o.total, { cents: true })}</span>
                </div>
                <ul className="flex flex-col divide-y divide-line">
                  {o.items.map((it) => (
                    <li key={it.id} className="flex flex-wrap items-center gap-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-semibold">{it.title}</span>
                        <span className="block text-xs text-muted">
                          {it.sellerName}
                          {it.option ? ` · ${it.option}` : ''}
                          {it.bookingAt ? ` · ${fmtDateTime(it.bookingAt)}` : ''}
                        </span>
                      </span>
                      <span className="num text-[13px]">
                        {it.qty} × {fmtMoney(it.price)}
                      </span>
                      {it.kind === 'product' && (
                        <button
                          className="btn btn-secondary btn-xs"
                          onClick={async () => {
                            await download(`${slugify(it.title)}-access.md`, accessFile(o, it));
                          }}
                        >
                          <Download size={12} /> Access file
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
