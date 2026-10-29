import { useMemo, useState } from 'react';
import { BadgeCheck, CalendarCheck, MapPin, MessageSquare, ShoppingCart, Star } from 'lucide-react';
import type { Listing, ServicePriceModel } from '@/lib/types';
import { cn, darken, fmtCompact, fmtMoney, lighten, readableOn, withAlpha } from '@/lib/utils';
import { CITIES, FORMATS } from '@/ai/knowledge';
import { Icon } from '@/components/ui/Icon';
import { MiniMark } from '@/components/brand/Logo';

export function priceLabel(price: number, model: ServicePriceModel): string {
  if (model === 'free' || price === 0) return 'Free';
  if (model === 'quote') return 'Get a quote';
  const p = fmtMoney(price);
  switch (model) {
    case 'monthly':
      return `${p}/mo`;
    case 'yearly':
      return `${p}/yr`;
    case 'per-session':
      return `${p}/session`;
    case 'project':
      return `From ${p}`;
    default:
      return p;
  }
}

export function ListingCover({ listing, className, big }: { listing: Listing; className?: string; big?: boolean }) {
  const [a, b, c] = listing.cover.colors;
  if (listing.cover.imageDataUrl) {
    return (
      <div className={cn('relative overflow-hidden', className)}>
        <img src={listing.cover.imageDataUrl} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }
  const pattern = (() => {
    switch (listing.cover.pattern) {
      case 'dots':
        return { backgroundImage: `radial-gradient(${withAlpha('#ffffff', 0.22)} 1.6px, transparent 1.8px)`, backgroundSize: '16px 16px' };
      case 'grid':
        return { backgroundImage: `linear-gradient(${withAlpha('#ffffff', 0.12)} 1px, transparent 1px), linear-gradient(90deg, ${withAlpha('#ffffff', 0.12)} 1px, transparent 1px)`, backgroundSize: '22px 22px' };
      case 'rays':
        return { backgroundImage: `repeating-conic-gradient(from 0deg at 85% 15%, ${withAlpha('#ffffff', 0.09)} 0deg 8deg, transparent 8deg 18deg)` };
      case 'waves':
        return { backgroundImage: `radial-gradient(120% 60% at 50% 120%, ${withAlpha(c, 0.75)} 40%, transparent 41%), radial-gradient(120% 60% at 30% 135%, ${withAlpha(lighten(a, 0.25), 0.8)} 45%, transparent 46%)` };
      default:
        return { backgroundImage: `radial-gradient(40% 50% at 80% 20%, ${withAlpha(c, 0.7)}, transparent 70%), radial-gradient(40% 40% at 15% 85%, ${withAlpha(lighten(a, 0.3), 0.7)}, transparent 70%)` };
    }
  })();
  const fg = readableOn(a);
  return (
    <div className={cn('relative overflow-hidden', className)} style={{ background: `linear-gradient(135deg, ${a}, ${darken(b, 0.05)})` }}>
      <div className="absolute inset-0" style={pattern} />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="flex items-center justify-center rounded-2xl" style={{ width: big ? 96 : 64, height: big ? 96 : 64, background: withAlpha('#ffffff', 0.14), boxShadow: `0 10px 30px -10px ${withAlpha('#000000', 0.45)}`, color: fg }}>
          <Icon name={listing.cover.icon} size={big ? 48 : 32} strokeWidth={1.6} />
        </span>
      </div>
    </div>
  );
}

export function Stars({ rating, reviews, size = 13 }: { rating: number; reviews?: number; size?: number }) {
  if (!rating && !reviews) return <span className="badge bg-accent/20 text-ink">New</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted" aria-label={`${rating.toFixed(1)} out of 5 stars${reviews ? `, ${reviews} reviews` : ''}`}>
      <Star size={size} className="fill-[rgb(var(--accent))] text-[rgb(var(--accent))]" />
      <b className="num text-ink">{rating.toFixed(1)}</b>
      {reviews !== undefined && <span className="num">({fmtCompact(reviews)})</span>}
    </span>
  );
}

export function ListingCard({ listing, onOpen, onAdd }: { listing: Listing; onOpen: () => void; onAdd: () => void }) {
  const isBiz = listing.kind === 'business';
  return (
    <article className="panel group flex min-w-0 flex-col overflow-hidden transition-shadow hover:shadow-pop">
      <button className="relative block text-left" onClick={onOpen} aria-label={`View ${listing.title}`}>
        <ListingCover listing={listing} className="aspect-[16/10] w-full" />
        <span className="absolute left-2 top-2 flex gap-1">
          {listing.origin === 'mine' && <span className="badge bg-accent text-on-accent">Your listing</span>}
          {listing.origin === 'community' && <span className="badge bg-info text-white">Community</span>}
          {listing.origin === 'sample' && <span className="badge bg-black/45 text-white backdrop-blur">Sample</span>}
        </span>
        <span className="absolute bottom-2 left-2 badge bg-surface/95 text-ink-2 shadow-card">
          {isBiz ? (
            <>
              <MapPin size={11} /> {listing.location?.online && listing.location.city === 'Online' ? 'Online' : `${listing.location?.city ?? 'Local'}${listing.location?.region ? `, ${listing.location.region}` : ''}`}
            </>
          ) : (
            <>
              <Icon name={FORMATS[listing.format ?? 'pdf'].icon} size={11} /> {FORMATS[listing.format ?? 'pdf'].short}
            </>
          )}
        </span>
      </button>
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="flex items-center gap-2">
          <MiniMark logo={listing.seller.logo} name={listing.seller.name} size={20} />
          <span className="min-w-0 truncate text-xs font-semibold text-ink-2">{listing.seller.name}</span>
          {listing.seller.verified && <BadgeCheck size={13} className="shrink-0 text-info" aria-label="Verified seller" />}
        </div>
        <button className="text-left" onClick={onOpen}>
          <h3 className="clamp-2 font-display text-[15.5px] font-semibold leading-snug text-ink group-hover:underline">{listing.title}</h3>
        </button>
        <p className="clamp-2 text-[12.5px] text-muted">{listing.tagline}</p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <div className="flex flex-col">
            <span className="num text-[15px] font-bold text-ink">
              {priceLabel(listing.price, listing.priceModel)}
              {listing.compareAt && listing.compareAt > listing.price && <s className="ml-1.5 text-xs font-medium text-faint">{fmtMoney(listing.compareAt)}</s>}
            </span>
            <Stars rating={listing.rating} reviews={listing.reviews} />
          </div>
          {isBiz ? (
            <button className="btn btn-secondary btn-sm" onClick={onOpen}>
              {listing.bookingType === 'inquire' ? <MessageSquare size={14} /> : <CalendarCheck size={14} />}
              {listing.bookingType === 'inquire' ? 'Inquire' : listing.bookingType === 'book' ? 'Book' : 'Order'}
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={onAdd} aria-label={`Add ${listing.title} to cart`}>
              <ShoppingCart size={14} /> Add
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

// ───────────────────────── US map filter ─────────────────────────

const OUTLINE: [number, number][] = [
  [-124.7, 48.4], [-122.75, 49.0], [-95.15, 49.0], [-89.6, 48.0], [-84.8, 46.5], [-82.5, 45.3], [-82.5, 43.0], [-83.1, 42.0], [-79.0, 42.8], [-76.3, 43.6], [-74.7, 45.0], [-71.5, 45.0], [-69.2, 47.45], [-67.8, 47.1], [-67.8, 45.7], [-67.0, 44.8], [-68.5, 44.2], [-70.2, 43.6], [-70.6, 42.6], [-70.0, 41.8], [-71.4, 41.4], [-72.9, 41.2], [-74.0, 40.6], [-74.0, 39.6], [-74.9, 38.9], [-75.5, 38.5], [-75.9, 37.2], [-76.0, 36.9], [-75.5, 35.2], [-76.7, 34.7], [-78.0, 33.9], [-79.3, 33.0], [-80.9, 32.0], [-81.4, 30.7], [-80.6, 28.4], [-80.1, 26.7], [-80.4, 25.2], [-81.1, 25.1], [-81.8, 26.1], [-82.6, 27.8], [-83.0, 29.1], [-84.3, 30.0], [-85.4, 29.7], [-86.5, 30.4], [-88.0, 30.4], [-89.4, 30.2], [-89.4, 29.2], [-90.5, 29.1], [-91.5, 29.5], [-93.8, 29.7], [-94.8, 29.3], [-96.6, 28.3], [-97.2, 27.6], [-97.2, 25.9], [-99.5, 27.5], [-101.4, 29.8], [-102.4, 29.8], [-103.2, 29.0], [-104.6, 29.6], [-106.5, 31.8], [-108.2, 31.8], [-108.2, 31.33], [-111.1, 31.33], [-114.8, 32.5], [-117.1, 32.5], [-118.5, 34.0], [-120.6, 34.6], [-121.9, 36.6], [-122.5, 37.8], [-123.8, 39.8], [-124.4, 40.4], [-124.2, 42.0], [-124.5, 42.8], [-124.0, 46.2], [-124.7, 48.4],
];

const proj = (lng: number, lat: number): [number, number] => [(lng + 126) * 16.6, (50.2 - lat) * 21];

export function UsMap({ listings, selected, onSelect }: { listings: Listing[]; selected: string; onSelect: (city: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const pins = useMemo(() => {
    const byCity = new Map<string, { city: string; region: string; lat: number; lng: number; count: number }>();
    for (const l of listings) {
      const loc = l.location;
      if (!loc || loc.city === 'Online') continue;
      const ref = loc.lat !== undefined && loc.lng !== undefined ? loc : CITIES.find((c) => c.city === loc.city);
      if (!ref || ref.lat === undefined || ref.lng === undefined) continue;
      const key = `${loc.city}, ${loc.region}`;
      const e = byCity.get(key);
      if (e) e.count++;
      else byCity.set(key, { city: loc.city, region: loc.region, lat: ref.lat, lng: ref.lng, count: 1 });
    }
    return [...byCity.entries()];
  }, [listings]);
  const d = OUTLINE.map(([lng, lat], i) => `${i ? 'L' : 'M'}${proj(lng, lat)[0].toFixed(1)},${proj(lng, lat)[1].toFixed(1)}`).join(' ') + ' Z';
  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-line bg-surface-2">
      <svg viewBox="0 0 1000 560" className="block h-auto w-full" role="img" aria-label="Map of business listings by city">
        <path d={d} fill="rgb(var(--surface))" stroke="rgb(var(--line-2))" strokeWidth="2" strokeLinejoin="round" />
        {pins.map(([key, p]) => {
          const [x, y] = proj(p.lng, p.lat);
          const active = selected === key;
          return (
            <g
              key={key}
              transform={`translate(${x} ${y})`}
              className="cursor-pointer"
              onClick={() => onSelect(active ? '' : key)}
              onMouseEnter={() => setHover(key)}
              onMouseLeave={() => setHover(null)}
              tabIndex={0}
              role="button"
              aria-label={`${key}: ${p.count} listing${p.count > 1 ? 's' : ''}`}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(active ? '' : key)}
            >
              <circle r="22" fill="transparent" />
              <circle r={active ? 13 : 10} fill={active ? 'rgb(var(--accent))' : 'rgb(var(--primary))'} stroke="rgb(var(--surface))" strokeWidth="3" />
              {p.count > 1 && (
                <text textAnchor="middle" dy="0.35em" className="num" fill={active ? 'rgb(var(--on-accent))' : 'rgb(var(--on-primary))'} style={{ fontSize: 11, fontWeight: 700 }}>
                  {p.count}
                </text>
              )}
              {(hover === key || active) && (
                <g transform="translate(0 -24)">
                  <rect x={-((key.length * 7.2) / 2) - 8} y={-14} width={key.length * 7.2 + 16} height={24} rx={6} fill="rgb(var(--ink))" />
                  <text textAnchor="middle" dy="0.32em" y={-2} fill="rgb(var(--surface))" style={{ fontSize: 12, fontWeight: 600 }}>
                    {key}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      <p className="absolute bottom-2 left-3 text-[11px] text-muted">Click a pin to filter by city</p>
    </div>
  );
}
