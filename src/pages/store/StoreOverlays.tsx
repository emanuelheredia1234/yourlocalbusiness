import { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, Check, Clock, ExternalLink, Info, Mail, MapPin, Phone, ShoppingBag } from 'lucide-react';
import { cn, fmtMoney } from '@/lib/utils';
import { FORMATS } from '@/ai/knowledge';
import { useUI } from '@/store/ui';
import { Modal } from '@/components/ui/primitives';
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

  return (
    <Modal open onClose={close} size="lg" bodyClass="p-0">
      <div className="relative">
        {view > 0 && l.gallery?.[view - 1] ? (
          <div className="flex aspect-[21/8] w-full items-center justify-center bg-surface-3">
            <img src={l.gallery[view - 1]} alt={`${l.title}: image ${view + 1}`} className="h-full w-full object-contain" />
          </div>
        ) : (
          <ListingCover listing={l} big className="aspect-[21/8] w-full" />
        )}
        <div className="absolute left-3 top-3 flex gap-1">
          {l.origin === 'mine' && <span className="badge bg-accent text-on-accent">Your listing</span>}
          {l.origin === 'community' && <span className="badge bg-info text-white">Community seller</span>}
        </div>
      </div>
      {!!l.gallery?.length && (
        <div className="scroll-thin flex gap-2 overflow-x-auto border-b border-line px-5 py-2.5" role="tablist" aria-label="Listing images">
          {[l.cover.imageDataUrl ?? '', ...l.gallery].map((src, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={view === i}
              aria-label={i === 0 ? 'Cover' : `Image ${i + 1}`}
              className={cn('h-14 w-20 shrink-0 overflow-hidden rounded-md ring-offset-2 ring-offset-surface', view === i ? 'ring-2 ring-primary' : 'ring-1 ring-line hover:ring-line-2')}
              onClick={() => setView(i)}
            >
              {i === 0 && !src ? <ListingCover listing={l} className="h-full w-full" /> : <img src={src} alt="" className="h-full w-full object-cover" />}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 p-5 md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <MiniMark logo={l.seller.logo} name={l.seller.name} size={24} />
            <span className="text-small font-semibold">{l.seller.name}</span>
          </div>
          <h2 className="text-h2 font-semibold leading-tight tracking-[-0.01em]">{l.title}</h2>
          <p className="mt-1 text-body text-ink-2">{l.tagline}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-caption text-muted">
            {isBiz && l.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} /> {l.location.city}
                {l.location.region ? `, ${l.location.region}` : ''}
                {l.location.online && l.location.city !== 'Online' ? ' · also online' : ''}
              </span>
            )}
            {!isBiz && l.format && <span>{FORMATS[l.format].label}</span>}
          </div>
          <p className="mt-4 whitespace-pre-line text-body leading-relaxed text-ink-2">{l.description}</p>
          {l.includes && l.includes.length > 0 && (
            <div className="mt-4">
              <p className="eyebrow mb-2">What’s included</p>
              <ul className="flex flex-col gap-1.5 text-small">
                {l.includes.map((i) => (
                  <li key={i} className="flex gap-2">
                    <Check size={15} className="mt-0.5 shrink-0 text-primary" /> {i}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isBiz && (
            <div className="mt-4 flex flex-wrap gap-4 text-small text-ink-2">
              {l.hours && (
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={14} /> {l.hours}
                </span>
              )}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-1.5">
            {l.tags.map((t) => (
              <span key={t} className="rounded-full bg-surface-2 px-2.5 py-1 text-caption text-ink-2">
                #{t.replace(/\s+/g, '')}
              </span>
            ))}
          </div>
        </div>

        <aside className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/50 p-4 md:self-start">
          <p className="num text-h1 font-semibold">{priceLabel(l.price, l.priceModel)}</p>
          {services.length > 0 && (
            <div>
              <p className="label">{isBiz ? 'Services' : 'Options'}</p>
              <ul className="flex flex-col gap-1 text-small">
                {services.map((s) => (
                  <li key={s.name} className="flex justify-between gap-2">
                    <span className="min-w-0">{s.name}</span>
                    <span className="num shrink-0 text-ink-2">
                      {s.priceModel === 'quote' ? 'Get a quote' : s.price && s.priceModel !== 'free' ? fmtMoney(s.price) : 'Free'}
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
                <a key={a.kind} href={a.href} target={a.kind === 'email' || a.kind === 'phone' ? undefined : '_blank'} rel="noopener noreferrer" className={cn('btn', i === 0 ? 'btn-primary' : 'btn-secondary')} title={a.hint}>
                  {ACTION_ICON[a.kind]} {a.label}
                  <span className="min-w-0 truncate text-caption font-normal opacity-80">{a.hint}</span>
                </a>
              ))}
            </div>
          ) : (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-small text-muted">{mine ? 'Add your own buy or booking link, email or phone in the Studio (Publish tab), so people can reach you.' : 'The seller hasn’t added a way to buy or get in touch yet.'}</p>
          )}
          <p className="flex items-start gap-1.5 text-caption text-muted">
            <Info size={12} className="mt-0.5 shrink-0" /> You buy, book or talk with the seller on their own site, email or phone. Yourlocalbusiness takes no payments and sends no messages.
          </p>
        </aside>
      </div>
    </Modal>
  );
}

const ACTION_ICON: Record<ListingAction['kind'], React.ReactNode> = {
  buy: <ShoppingBag size={15} />,
  book: <CalendarCheck size={15} />,
  website: <ExternalLink size={15} />,
  email: <Mail size={15} />,
  phone: <Phone size={15} />,
};

export function StoreOverlays() {
  return (
    <>
      <ListingModal />
    </>
  );
}
