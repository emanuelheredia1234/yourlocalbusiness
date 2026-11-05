import { useMemo, useState } from 'react';
import { MapPin } from 'lucide-react';
import type { Listing } from '@/lib/types';
import { cn, darken, fmtMoney, lighten, readableOn, withAlpha } from '@/lib/utils';
import { priceLabel } from '@/lib/listing';
import { CITIES, FORMATS } from '@/ai/knowledge';
import { Icon } from '@/components/ui/Icon';
import { MiniMark } from '@/components/brand/Logo';
import { Badge } from '@/components/ui/primitives';

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

/** Where a listing is (a business's city, or a digital product's format), in a few words. */
function placeLine(listing: Listing): string {
  if (listing.kind !== 'business') return FORMATS[listing.format ?? 'pdf'].label;
  const loc = listing.location;
  if (loc?.online && loc.city === 'Online') return 'Online';
  return `${loc?.city ?? 'Local'}${loc?.region ? `, ${loc.region}` : ''}${loc?.online ? ' · also online' : ''}`;
}

/**
 * A listing in a grid: the 4:3 cover, then title, seller (unless it repeats the title), price and where it
 * is. The cover opens the listing ("View {title}"), and so does the title.
 */
export function ListingCard({ listing, onOpen }: { listing: Listing; onOpen: () => void }) {
  const seller = listing.seller.name.trim();
  const showSeller = !!seller && seller.toLowerCase() !== listing.title.trim().toLowerCase();
  return (
    <article className="group flex min-w-0 flex-col">
      <button type="button" className="relative block overflow-hidden rounded-pop text-left ring-1 ring-inset ring-line transition-shadow duration-120 hover:shadow-sm" onClick={onOpen} aria-label={`View ${listing.title}`}>
        <ListingCover listing={listing} className="aspect-[4/3] w-full" />
        {listing.origin === 'mine' && (
          <span className="absolute left-2.5 top-2.5">
            <Badge className="bg-surface shadow-xs">Your listing</Badge>
          </span>
        )}
      </button>
      <div className="mt-3 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-h4 text-ink">
            <button type="button" className="block max-w-full truncate text-left hover:underline" onClick={onOpen}>
              {listing.title}
            </button>
          </h3>
          {showSeller && (
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-small text-muted">
              <MiniMark logo={listing.seller.logo} name={seller} size={16} />
              <span className="truncate">{seller}</span>
            </p>
          )}
          <p className="mt-0.5 flex min-w-0 items-center gap-1 text-caption text-muted">
            {listing.kind === 'business' ? <MapPin size={12} className="shrink-0" aria-hidden="true" /> : <Icon name={FORMATS[listing.format ?? 'pdf'].icon} size={12} className="shrink-0" />}
            <span className="truncate">{placeLine(listing)}</span>
          </p>
        </div>
        <span className="num shrink-0 text-right font-mono text-ui font-semibold text-ink">
          {priceLabel(listing.price, listing.priceModel)}
          {listing.compareAt && listing.compareAt > listing.price && <s className="block text-caption font-normal text-faint">{fmtMoney(listing.compareAt)}</s>}
        </span>
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
    <div className="well relative w-full overflow-hidden">
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
              <circle r={active ? 13 : 10} fill={active ? 'rgb(var(--ink))' : 'rgb(var(--primary))'} stroke="rgb(var(--surface))" strokeWidth="3" />
              {p.count > 1 && (
                <text textAnchor="middle" dy="0.35em" className="num" fill={active ? 'rgb(var(--surface))' : 'rgb(var(--on-primary))'} style={{ fontSize: 11, fontWeight: 600 }}>
                  {p.count}
                </text>
              )}
              {(hover === key || active) && (
                <g transform="translate(0 -24)">
                  <rect x={-((key.length * 7.2) / 2) - 8} y={-14} width={key.length * 7.2 + 16} height={24} rx={8} fill="rgb(var(--inverse))" />
                  <text textAnchor="middle" dy="0.32em" y={-2} fill="rgb(var(--on-inverse))" style={{ fontSize: 12, fontWeight: 500 }}>
                    {key}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      <p className="absolute bottom-2 left-3 text-caption text-muted">Click a pin to filter by city</p>
    </div>
  );
}
