// The windows the assistant opens for the Marketplace listing (it never publishes by itself). "Publish
// listing" shows exactly what goes public and who will see it, with the same checks as Studio → Listing &
// publish, and publishes with the same code once the owner presses Publish here. "Show / hide my
// listings" switches "Show my listings to other people" once the owner confirms. Loaded the first time
// one opens (ListingWindowHost).

import { useState } from 'react';
import { Eye, EyeOff, Rocket, Users } from 'lucide-react';
import type { Listing, MediaRef, Project } from '@/lib/types';
import { fmtMoney } from '@/lib/utils';
import { useRuntime } from '@/lib/platform';
import { buildListing, galleryIds, priceLabel } from '@/lib/listing';
import { listingActions } from '@/lib/listingActions';
import { listingChanged, listingChecks, publishProjectListing, setListingsShared, type ListingCheck } from '@/lib/listingPublish';
import { FORMATS } from '@/ai/knowledge';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { noteInChat } from '@/ai/assistant/buttons';
import { openPage } from '@/ai/assistant/nav';
import { Callout, Modal, Spinner } from '../ui/primitives';
import { MediaThumb } from '../media/MediaUpload';
import type { ListingWindowAction } from './ListingWindowHost';

const BOOKING: Record<NonNullable<Listing['bookingType']>, string> = { book: 'Book a time', inquire: 'Inquire', buy: 'Buy' };

/** Who will see a published listing, in a sentence. */
export function audienceLine(community: string, share: boolean): string {
  if (community !== 'live') return 'Only you can see your listings here for now: the shared Marketplace isn’t on in this view.';
  return share ? 'Everyone who uses this app can see it. They buy or get in touch through your own link, email or phone.' : 'Only you, for now: “Show my listings to other people” is off.';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 border-b border-line py-2.5 last:border-0 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-small text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-small text-ink">{children}</dd>
    </div>
  );
}

/** Exactly what a listing shares: every field buyers see, the images, and the ways to reach you. */
export function ListingPublicSummary({ listing, cover, gallery }: { listing: Listing; cover?: MediaRef; gallery: MediaRef[] }) {
  const isBiz = listing.kind === 'business';
  const actions = listingActions(listing);
  return (
    <dl className="flex flex-col">
      <Row label="Images">
        <div className="flex flex-wrap items-center gap-2">
          {cover ? <MediaThumb media={cover} className="h-[60px] w-20" /> : <span className="text-muted">Cover made from your brand colors and logo</span>}
          {gallery.map((m) => (
            <MediaThumb key={m.id} media={m} className="h-[60px] w-20" />
          ))}
          <span className="text-caption text-muted">{cover ? 'Cover' : ''}{gallery.length ? `${cover ? ' and ' : ''}${gallery.length} gallery image${gallery.length === 1 ? '' : 's'}` : ''}</span>
        </div>
      </Row>
      <Row label="Seller">{listing.seller.name || 'Your brand'}</Row>
      <Row label="Title">{listing.title}</Row>
      {listing.tagline && <Row label="Tagline">{listing.tagline}</Row>}
      <Row label="Price">
        {priceLabel(listing.price, listing.priceModel)}
        {listing.compareAt ? <span className="ml-1.5 text-muted">(compare at {fmtMoney(listing.compareAt)})</span> : null}
      </Row>
      {isBiz && !!listing.services?.length && (
        <Row label="Packages">
          <ul className="flex flex-col gap-0.5">
            {listing.services.map((s) => (
              <li key={s.name}>
                {s.name}: {s.priceModel === 'quote' ? 'Get a quote' : s.price && s.priceModel !== 'free' ? `${fmtMoney(s.price)}${s.duration ? ` ${s.duration}` : ''}` : 'Free'}
              </li>
            ))}
          </ul>
        </Row>
      )}
      <Row label="Category">{listing.category}</Row>
      <Row label="Search tags">{listing.tags.length ? listing.tags.join(', ') : <span className="text-muted">None</span>}</Row>
      <Row label="Description">
        <p className="scroll-thin max-h-48 overflow-y-auto whitespace-pre-line">{listing.description}</p>
      </Row>
      {!!listing.includes?.length && (
        <Row label={isBiz ? 'What you get' : 'What’s inside'}>
          <ul className="list-disc pl-4">
            {listing.includes.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Row>
      )}
      {isBiz ? (
        <>
          <Row label="How customers buy">{BOOKING[listing.bookingType ?? 'book']}</Row>
          {listing.hours && <Row label="Hours">{listing.hours}</Row>}
          <Row label="Location">{listing.location?.online ? 'Online (no city set)' : [listing.location?.city, listing.location?.region].filter(Boolean).join(', ')}</Row>
        </>
      ) : (
        listing.format && <Row label="Format">{FORMATS[listing.format]?.label ?? listing.format}</Row>
      )}
      <Row label="Ways to buy or reach you">
        {actions.length ? (
          <ul className="flex flex-col gap-0.5">
            {actions.map((a) => (
              <li key={a.kind}>
                {a.label}: {a.hint}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted">None yet: add a link, email or phone in Listing & publish</span>
        )}
      </Row>
    </dl>
  );
}

/** The required checks the listing doesn't pass, with a way to fix them on the page. */
function Blocking({ checks, onOpen }: { checks: ListingCheck[]; onOpen: () => void }) {
  return (
    <div role="alert">
      <Callout
        tone="warn"
        title={`Finish ${checks.length === 1 ? 'this' : 'these'} first:`}
        action={
          <button type="button" className="btn btn-secondary btn-xs" onClick={onOpen}>
            Open Listing & publish
          </button>
        }
      >
        <ul className="mt-0.5 list-disc pl-4">
          {checks.map((c) => (
            <li key={c.label}>{c.label}</li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

function PublishWindow({ project, close }: { project: Project; close: () => void }) {
  const live = useStore((s) => s.myListings.find((l) => l.id === project.studio.publishedListingId));
  const community = useRuntime((s) => s.community);
  const share = useStore((s) => s.settings.shareToCommunity);
  const [busy, setBusy] = useState(false);
  const listing = buildListing(project, live);
  const coverId = project.studio.listing.coverImageId;
  const cover = coverId ? project.brand.images.find((m) => m.id === coverId && m.kind === 'image') : undefined;
  const gallery = galleryIds(project)
    .map((id) => project.brand.images.find((m) => m.id === id))
    .filter((m): m is MediaRef => !!m);
  const blocking = listingChecks(project, listing).filter((c) => !c.ok && !c.optional);
  const label = live ? (listingChanged(project, live) ? 'Update listing' : 'Republish listing') : 'Publish to Marketplace';

  const publish = async () => {
    setBusy(true);
    try {
      const r = await publishProjectListing();
      noteInChat(r.updated ? `Updated your listing “${r.listing.title}”` : r.shared ? `Published “${r.listing.title}” to the Marketplace` : `Saved “${r.listing.title}” to your listings (only you can see it for now)`);
      close();
    } catch (e) {
      const msg = (e as Error)?.message || 'Please try again.';
      toast({ kind: 'error', title: 'Couldn’t publish the listing', body: msg });
      noteInChat(`Couldn’t publish the listing: ${msg}`, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && close()}
      size="lg"
      title={live ? 'Update your Marketplace listing' : 'Publish your listing to the Marketplace'}
      subtitle="This is exactly what goes public."
      icon={<Rocket size={20} />}
      footer={
        <>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || blocking.length > 0} onClick={publish}>
            {busy && <Spinner size={16} />}
            {label}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {blocking.length > 0 && (
          <Blocking
            checks={blocking}
            onOpen={() => {
              close();
              void openPage('studio', 'publish');
            }}
          />
        )}
        <p className="flex items-start gap-2 text-small text-ink-2">
          <Users size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
          {audienceLine(community, share)}
        </p>
        <ListingPublicSummary listing={listing} cover={cover} gallery={gallery} />
        <p className="text-caption text-muted">This app takes no payments and sends no messages: buyers go to your own page, email or phone. You can unpublish anytime from Listing & publish.</p>
      </div>
    </Modal>
  );
}

function VisibilityWindow({ on, close }: { on: boolean; close: () => void }) {
  const listings = useStore((s) => s.myListings);
  const share = useStore((s) => s.settings.shareToCommunity);
  const community = useRuntime((s) => s.community);
  const live = community === 'live';
  const already = live && share === on;
  const titles = listings.map((l) => `“${l.title}”`);
  const named = titles.length ? (titles.length > 3 ? `${titles.slice(0, 3).join(', ')} and ${titles.length - 3} more` : titles.join(', ')) : '';

  const confirm = () => {
    setListingsShared(on);
    noteInChat(on ? 'Your listings are shown to other people on the Marketplace' : 'Your listings are hidden from other people (they stay in your listings)');
    close();
  };

  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={on ? 'Show your listings to other people?' : 'Hide your listings from other people?'}
      icon={on ? <Eye size={20} /> : <EyeOff size={20} />}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={close}>
            {live && !already ? 'Cancel' : 'Close'}
          </button>
          {live && !already && (
            <button type="button" className="btn btn-primary" onClick={confirm}>
              {on ? 'Show my listings' : 'Hide my listings'}
            </button>
          )}
        </>
      }
    >
      <p className="text-body text-ink-2">
        {!live
          ? 'The shared Marketplace isn’t on in this view, so only you can see your listings. There’s nothing to show or hide.'
          : already
            ? on
              ? 'Your listings are already shown to other people.'
              : 'Your listings are already hidden from other people.'
            : on
              ? `Everyone who uses this app will see ${named ? `your listings: ${named}` : 'the listings you publish'}. They buy or get in touch through your own link, email or phone.`
              : `Other people won’t see ${named ? `your listings (${named})` : 'your listings'} any more. They stay in your listings, and you can show them again anytime.`}
      </p>
    </Modal>
  );
}

/** The listing window the assistant opened, for the open project. */
export default function ListingWindow({ action, project, close }: { action: ListingWindowAction; project: Project; close: () => void }) {
  return action === 'publish' ? <PublishWindow project={project} close={close} /> : <VisibilityWindow on={action === 'show'} close={close} />;
}
