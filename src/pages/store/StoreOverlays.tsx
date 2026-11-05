import { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, Check, Clock, ExternalLink, Mail, Phone, ShoppingBag } from 'lucide-react';
import { cn, fmtMoney } from '@/lib/utils';
import { FORMATS } from '@/ai/knowledge';
import { useUI } from '@/store/ui';
import { Badge, InfoTip, Modal } from '@/components/ui/primitives';
import { MiniMark } from '@/components/brand/Logo';
import { ListingCover } from './ListingParts';
import { priceLabel } from '@/lib/listing';
import { findListing } from './useListings';
import { listingActions, type ListingAction } from '@/lib/listingActions';

function ListingModal() {
  const id = useUI((s) => s.listingId);
  const open = useUI((s) => s.openListing);
  const l = useMemo(() => findListing(id), [id]);
  const [view, setView] = useState(0);
  useEffect(() => setView(0), [id]);
  if (!id || !l) return null;
  const close = () => open(null);
  const isBiz = l.kind === 'business';
  const services = l.services ?? [];
  const actions = listingActions(l);
  const mine = l.origin === 'mine';
  const seller = l.seller.name.trim();
  const place = isBiz && l.location ? `${l.location.city}${l.location.region ? `, ${l.location.region}` : ''}${l.location.online && l.location.city !== 'Online' ? ' · also online' : ''}` : '';
  const subtitle = [seller && seller.toLowerCase() !== l.title.trim().toLowerCase() ? seller : '', isBiz ? place : l.format ? FORMATS[l.format].label : ''].filter(Boolean).join(' · ');

  return (
    <Modal open onClose={close} size="lg" title={l.title} subtitle={subtitle || undefined} icon={<MiniMark logo={l.seller.logo} name={seller || l.title} size={24} />}>
      <div className="relative overflow-hidden rounded-pop ring-1 ring-inset ring-line">
        {view > 0 && l.gallery?.[view - 1] ? (
          <div className="flex aspect-[21/9] w-full items-center justify-center bg-surface-3">
            <img src={l.gallery[view - 1]} alt={`${l.title}: image ${view + 1}`} className="h-full w-full object-contain" />
          </div>
        ) : (
          <ListingCover listing={l} big className="aspect-[21/9] w-full" />
        )}
        {mine && (
          <span className="absolute left-3 top-3">
            <Badge className="bg-surface shadow-xs">Your listing</Badge>
          </span>
        )}
      </div>
      {!!l.gallery?.length && (
        <div className="scroll-thin -mx-1 mt-3 flex gap-2 overflow-x-auto px-1 py-1" role="tablist" aria-label="Listing images">
          {[l.cover.imageDataUrl ?? '', ...l.gallery].map((src, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={view === i}
              aria-label={i === 0 ? 'Cover' : `Image ${i + 1}`}
              className={cn('h-12 w-16 shrink-0 overflow-hidden rounded-md transition-shadow duration-120', view === i ? 'ring-[1.5px] ring-primary ring-offset-2 ring-offset-elevated' : 'ring-1 ring-line hover:ring-line-3')}
              onClick={() => setView(i)}
            >
              {i === 0 && !src ? <ListingCover listing={l} className="h-full w-full" /> : <img src={src} alt="" className="h-full w-full object-cover" />}
            </button>
          ))}
        </div>
      )}
      <div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0">
          {l.tagline && <p className="text-body-lg text-ink">{l.tagline}</p>}
          <p className="mt-3 max-w-[72ch] whitespace-pre-line text-body text-ink-2">{l.description}</p>
          {l.includes && l.includes.length > 0 && (
            <div className="mt-5">
              <h3 className="text-h4 text-ink">What’s included</h3>
              <ul className="mt-2 flex flex-col gap-1.5 text-body text-ink-2">
                {l.includes.map((i) => (
                  <li key={i} className="flex gap-2">
                    <Check size={16} className="mt-[3px] shrink-0 text-muted" aria-hidden="true" /> {i}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {l.hours && (
            <p className="mt-5 inline-flex items-center gap-1.5 text-small text-ink-2">
              <Clock size={14} className="text-muted" aria-hidden="true" /> {l.hours}
            </p>
          )}
          {l.tags.length > 0 && <p className="mt-4 text-small text-muted">{l.tags.map((t) => `#${t.replace(/\s+/g, '')}`).join(' · ')}</p>}
        </div>

        <aside className="well flex flex-col gap-4 p-4 md:self-start">
          <div>
            <p className="num text-h2 text-ink">{priceLabel(l.price, l.priceModel)}</p>
            <p className="mt-0.5 flex items-center gap-1 text-caption text-muted">
              Pay the business directly.
              <InfoTip label="How buying works">You buy, book or talk with the seller on their own site, email or phone. Yourlocalbusiness takes no payments and sends no messages.</InfoTip>
            </p>
          </div>
          {services.length > 0 && (
            <div>
              <p className="text-h4 text-ink">{isBiz ? 'Services' : 'Options'}</p>
              <ul className="mt-1.5 flex flex-col gap-1 text-small">
                {services.map((s) => (
                  <li key={s.name} className="flex justify-between gap-2">
                    <span className="min-w-0 text-ink-2">{s.name}</span>
                    <span className="num shrink-0 font-mono text-caption text-muted">
                      {s.priceModel === 'quote' ? 'Quote' : s.price && s.priceModel !== 'free' ? fmtMoney(s.price) : 'Free'}
                      {s.duration ? ` · ${s.duration}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {actions.length ? (
            <div className="flex flex-col gap-2">
              {actions.map((a, i) => (
                <a key={a.kind} href={a.href} target={a.kind === 'email' || a.kind === 'phone' ? undefined : '_blank'} rel="noopener noreferrer" className={cn('btn w-full justify-start', i === 0 ? 'btn-primary' : 'btn-secondary')} title={a.hint}>
                  {ACTION_ICON[a.kind]} {a.label}
                  <span className={cn('ml-auto min-w-0 truncate text-caption font-normal', i === 0 ? 'text-on-action/70' : 'text-muted')}>{a.hint}</span>
                </a>
              ))}
            </div>
          ) : (
            <p className="text-small text-muted">{mine ? 'Add your own buy or booking link, email or phone in the Studio (Publish tab), so people can reach you.' : 'The seller hasn’t added a way to buy or get in touch yet.'}</p>
          )}
        </aside>
      </div>
    </Modal>
  );
}

const ACTION_ICON: Record<ListingAction['kind'], React.ReactNode> = {
  buy: <ShoppingBag />,
  book: <CalendarCheck />,
  website: <ExternalLink />,
  email: <Mail />,
  phone: <Phone />,
};

export function StoreOverlays() {
  return (
    <>
      <ListingModal />
    </>
  );
}
