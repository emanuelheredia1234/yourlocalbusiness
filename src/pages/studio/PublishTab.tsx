import { useMemo, useState, type ReactNode } from 'react';
import { Check, Circle, CircleAlert, CircleCheck, Clock, ExternalLink, Link2, Mail, Phone, Store, Users, X } from 'lucide-react';
import type { BookingType, ListingDraft, MediaRef, PriceModel, Project } from '@/lib/types';
import { cn, fmtDateTime } from '@/lib/utils';
import { safeEmail, safePhone, safeUrl } from '@/lib/listingActions';
import { useRuntime } from '@/lib/platform';
import { BUSINESS_CATEGORIES, PRODUCT_CATEGORIES } from '@/ai/knowledge';
import { listingTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { applyListingCopy } from '@/ai/listingCopy';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, Callout, ChipInput, Empty, Field, InfoTip, Section, Segmented, Skeleton, Spinner, StatusDot, StickyActionBar, Toggle, confirmAction } from '@/components/ui/primitives';
import { MediaThumb } from '@/components/media/MediaUpload';
import { ListingCard } from '@/pages/store/ListingParts';
import { buildListing, galleryIds, leadPrice, listingSuggestions, MAX_GALLERY, priceLabel } from '@/lib/listing';
import { listingChanged, listingChecks, openInStore, publishProjectListing, setListingsShared, UNPUBLISH_CONFIRM, unpublishProjectListing } from '@/lib/listingPublish';
import { listingShots } from '@/ai/image';
import { listingShotMedia } from '@/ai/listingPhotos';
import { ListingImages, PhotoUploadButton } from './ListingImages';
import { VideoPanel } from '@/components/images/VideoPanel';
import { AttachPayment } from '@/components/offers/AttachPayment';
import { OffersPanel } from '@/components/offers/OffersPanel';
import { PublicWebToggle } from '@/components/market/PublicWebToggle';

/** A starting description for the listing's demo video. */
function demoVideoPrompt(project: Project): string {
  const d = project.studio.listing;
  const name = d.title || project.brand.name;
  const what = d.tagline || project.brand.tagline;
  if (project.track === 'business') {
    const where = project.location?.city ? ` in ${project.location.city}` : '';
    return `Short promo video for ${name}${where}: ${what}. Show the service in action with real people, smooth slow camera moves, bright natural light, a happy customer at the end.`;
  }
  return `Product demo video of ${name}: ${what}. Show it on a laptop and phone in a bright modern workspace, someone using it with a satisfied smile, smooth slow camera moves and close-ups.`;
}

/** An input with a 14px icon inside, on the left. */
function IconInput({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-muted [&>svg]:size-3.5" aria-hidden="true">
        {icon}
      </span>
      {children}
    </div>
  );
}

/** A brand image to pick (the cover, or one for the gallery): selected ones get the option-card ring and a check. */
function PickThumb({ media, on, onClick, label }: { media: MediaRef; on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className="group relative h-[60px] w-20 overflow-hidden rounded-md" onClick={onClick} aria-pressed={on} aria-label={label}>
      <MediaThumb media={media} className="h-full w-full rounded-none" />
      {/* over the picture, so it shows: the option-card ring when picked, a hairline otherwise */}
      <span
        className={cn('pointer-events-none absolute inset-0 rounded-md ring-inset transition-shadow duration-120', on ? 'ring-[1.5px] ring-primary' : 'ring-1 ring-ink/5 group-hover:ring-line-3')}
        aria-hidden="true"
      />
      {on && (
        <span className="absolute right-1 top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-primary text-on-primary" aria-hidden="true">
          <Check size={12} strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

export function PublishTab({ project }: { project: Project }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const updateBrand = useStore((s) => s.updateBrand);
  const share = useStore((s) => s.settings.shareToCommunity);
  const live = useStore((s) => s.myListings.find((l) => l.id === project.studio.publishedListingId));
  const community = useRuntime((s) => s.community);
  const ai = useAI(listingTask);
  const [busy, setBusy] = useState(false);
  // a listing nobody wrote yet: an empty state first, until the owner writes it with AI or by hand
  const [byHand, setByHand] = useState(false);
  const d = project.studio.listing;
  const isBiz = project.track === 'business';
  const setD = (patch: Partial<ListingDraft>) => updateStudio({ listing: { ...getActiveProject()!.studio.listing, ...patch } });
  const coverMedia = d.coverImageId ? project.brand.images.find((m) => m.id === d.coverImageId) : undefined;
  const [demoPrompt, setDemoPrompt] = useState(() => demoVideoPrompt(project));
  const galleryMedia = galleryIds(project).map((id) => project.brand.images.find((m) => m.id === id)!);
  const galleryChoices = project.brand.images.filter((m) => m.kind === 'image' && m.id !== d.coverImageId);
  /** Your own photos for the gallery: added to your brand images, and to the gallery while there's room. */
  const addGalleryPhotos = (media: MediaRef[]) => {
    const p = getActiveProject()!;
    updateBrand({ images: [...p.brand.images, ...media] });
    const g = galleryIds(p);
    const room = Math.max(0, MAX_GALLERY - g.length);
    setD({ galleryIds: [...g, ...media.slice(0, room).map((m) => m.id)] });
    const left = media.length - room;
    if (left > 0) toast({ kind: 'info', title: room ? `${room} added to the gallery` : 'The gallery is full', body: `It shows up to ${MAX_GALLERY} images. ${left === 1 ? 'The other photo is' : `The other ${left} photos are`} in your brand images: remove one from the gallery to swap it in.` });
  };
  const preview = useMemo(() => {
    const l = buildListing(project, live);
    return coverMedia?.thumb ? { ...l, cover: { ...l.cover, imageDataUrl: coverMedia.thumb } } : l;
  }, [project, live, coverMedia]);
  const lp = leadPrice(project);
  // the business type's typical hours and an example guarantee: shown as suggestions, used only if the owner clicks
  const suggest = listingSuggestions(project);

  const checks = listingChecks(project, preview);
  const blocking = checks.filter((c) => !c.ok && !c.optional);
  const changed = listingChanged(project, live);
  // nothing written, picked or made for the listing yet: it starts on its empty state (anything the owner set, a
  // photo, a tag, a link, keeps the form open after a reload)
  const untouched =
    !d.title.trim() &&
    !d.tagline.trim() &&
    !d.description.trim() &&
    !d.tags.length &&
    !(d.hours ?? '').trim() &&
    !d.buyUrl?.trim() &&
    !d.contactEmail?.trim() &&
    !d.phone?.trim() &&
    !d.coverImageId &&
    !d.galleryIds?.length &&
    !Object.keys(d.shotPrompts ?? {}).length &&
    !Object.keys(d.shotImageIds ?? {}).length &&
    !d.demoVideo &&
    !listingShots(project).some((s) => listingShotMedia(project, s.id));

  const write = async () => {
    const r = await ai.run({});
    if (r) applyListingCopy(r);
  };

  const publish = async () => {
    setBusy(true);
    try {
      await publishProjectListing();
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t publish the listing', body: (e as Error)?.message || 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    if (!live) return;
    if (!(await confirmAction({ ...UNPUBLISH_CONFIRM, danger: true }))) return;
    unpublishProjectListing();
  };

  // ── not written yet ──
  if (untouched && !byHand && !live) {
    return (
      <div>
        {ai.error && (
          <Callout tone="bad" className="mb-4">
            {ai.error}
          </Callout>
        )}
        {ai.running ? (
          <div className="mx-auto max-w-[720px]">
            <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} />
            <div className="mt-6 flex flex-col gap-3" aria-hidden="true">
              <Skeleton ai className="h-9 w-2/3" />
              <Skeleton ai className="h-5 w-1/2" />
              <Skeleton ai className="h-32 w-full" />
            </div>
          </div>
        ) : (
          <Empty
            variant="page"
            icon={<Store />}
            title="Get found in the Marketplace"
            body="Your listing uses your brand, prices and photos."
            action={
              <>
                <GenerateButton running={ai.running} runningLabel="Writing…" onClick={() => void write()}>
                  Write listing with AI
                </GenerateButton>
                <button type="button" className="link text-small" onClick={() => setByHand(true)}>
                  Fill it in yourself
                </button>
              </>
            }
          />
        )}
      </div>
    );
  }

  const publishLabel = live ? (changed ? 'Update listing' : 'Republish listing') : 'Publish to Marketplace';
  const descriptionTip = (
    <InfoTip
      label="How to write the description"
      link={suggest.guarantee && !d.description.includes(suggest.guarantee) ? { label: 'Add the example guarantee', onClick: () => setD({ description: `${d.description.trimEnd()}\n\n${suggest.guarantee}` }) } : undefined}
    >
      A short intro, what buyers get (• bullets) and a closing line.
      {suggest.guarantee && !d.description.includes(suggest.guarantee) && (
        <span className="mt-1.5 block">
          No guarantee is shown unless you add one. Example: “{suggest.guarantee}” Add it only if you offer it, and edit it to match.
        </span>
      )}
    </InfoTip>
  );

  return (
    <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-12 lg:gap-8">
      <div className="min-w-0 lg:col-span-7" aria-label="Listing details" role="group">
        {d.needsReview && (
          <Callout tone="warn" title="Review your listing." onDismiss={() => setD({ needsReview: undefined })} className="mb-8">
            Opening hours, a guarantee or a delivery promise had been filled in from a template, not by you, so they were removed. Add your own if you have them, then publish again.
          </Callout>
        )}

        <Section title="Basics">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="ls-title" right={<span className="num font-mono">{d.title.length}/70</span>} className="sm:col-span-2">
              <input id="ls-title" className="input" maxLength={90} value={d.title} onChange={(e) => setD({ title: e.target.value })} />
            </Field>
            <Field label="Tagline" htmlFor="ls-tag" right={<span className="num font-mono">{d.tagline.length}/110</span>} className="sm:col-span-2">
              <input id="ls-tag" className="input" maxLength={140} value={d.tagline} onChange={(e) => setD({ tagline: e.target.value })} />
            </Field>
            <Field label="Category" htmlFor="ls-cat">
              <select id="ls-cat" className="select" value={d.category} onChange={(e) => setD({ category: e.target.value })}>
                {!d.category && <option value="">Choose a category</option>}
                {(isBiz ? BUSINESS_CATEGORIES : PRODUCT_CATEGORIES).concat(d.category && !(isBiz ? BUSINESS_CATEGORIES : PRODUCT_CATEGORIES).includes(d.category) ? [d.category] : []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            {isBiz && (
              <Field
                label="Hours"
                htmlFor="ls-hours"
                hint={
                  !(d.hours ?? '').trim() && suggest.hours ? (
                    <>
                      Not shown when empty.{' '}
                      <button type="button" className="link text-caption" title={suggest.hours} onClick={() => setD({ hours: suggest.hours })}>
                        Use typical hours
                      </button>
                    </>
                  ) : undefined
                }
              >
                <IconInput icon={<Clock />}>
                  <input id="ls-hours" className="input pl-8" value={d.hours} onChange={(e) => setD({ hours: e.target.value })} placeholder="Your opening hours" />
                </IconInput>
              </Field>
            )}
          </div>
        </Section>

        <Section
          title={
            <span className="inline-flex items-center gap-1">
              Description {descriptionTip}
            </span>
          }
          divider
          actions={
            <GenerateButton size="sm" running={ai.running} runningLabel="Writing…" onClick={() => void write()}>
              Write listing with AI
            </GenerateButton>
          }
        >
          <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} compact className="mb-3" />
          {ai.result && !ai.running && <AIResultBar className="mb-3" provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
          {ai.error && (
            <Callout tone="bad" className="mb-3">
              {ai.error}
            </Callout>
          )}
          <label htmlFor="ls-desc" className="sr-only">
            Description
          </label>
          <AutoTextarea id="ls-desc" value={d.description} onChange={(v) => setD({ description: v })} minRows={6} />
        </Section>

        <Section title="Pricing" divider description="This app takes no payments: buyers use your own link, email or phone.">
          <div className="flex flex-col gap-4">
            {isBiz ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="How customers buy">
                  <Segmented<BookingType>
                    size="sm"
                    value={d.bookingType}
                    onChange={(v) => setD({ bookingType: v })}
                    options={[
                      { id: 'book', label: 'Book a time' },
                      { id: 'inquire', label: 'Inquire' },
                      { id: 'buy', label: 'Buy' },
                    ]}
                  />
                </Field>
                <div className="min-w-0">
                  <p className="label flex items-center gap-1">
                    Lead price
                    <InfoTip label="Where the lead price comes from">
                      It comes from the package you marked popular, or your first package if none is marked. Buyers can pick any of your {project.studio.packages.length || 'service'} packages.
                      {!project.location && ' No city set, so the listing shows as online.'}
                    </InfoTip>
                  </p>
                  <p className="num flex h-9 items-center text-ui text-ink">{priceLabel(lp.price, lp.model)}</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="Price" htmlFor="ls-price">
                  <input id="ls-price" type="number" min={0} className="input num" value={project.studio.price} onChange={(e) => updateStudio({ price: Math.max(0, Number(e.target.value) || 0) })} />
                </Field>
                <Field label="Compare at" htmlFor="ls-compare">
                  <input id="ls-compare" type="number" min={0} className="input num" value={project.studio.compareAt || ''} placeholder="—" onChange={(e) => updateStudio({ compareAt: Math.max(0, Number(e.target.value) || 0) })} />
                </Field>
                <Field label="Billing" htmlFor="ls-model" className="col-span-2 sm:col-span-1">
                  <select id="ls-model" className="select" value={project.studio.priceModel} onChange={(e) => updateStudio({ priceModel: e.target.value as PriceModel })}>
                    <option value="one-time">One-time</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </Field>
              </div>
            )}
            {/* an offer (Whop or your own checkout) as the buy link, or your own link typed as before */}
            {!isBiz || d.bookingType === 'buy' ? (
              <AttachPayment
                projectId={project.id}
                value={d.offerId}
                label="Attach payment as the buy link"
                onAttach={(o) => setD({ offerId: o.id })}
                onDetach={() => setD({ offerId: undefined })}
                fallback={
                <Field
                  label={isBiz ? (d.bookingType === 'book' ? 'Your booking link' : d.bookingType === 'inquire' ? 'Your contact or quote page' : 'Your order page') : 'Your checkout link'}
                  htmlFor="ls-buy"
                  hint={isBiz ? 'For example Calendly, Square Appointments, Acuity, or your own site.' : 'For example a Stripe Payment Link, Gumroad, Etsy, Shopify or Lemon Squeezy page.'}
                  error={d.buyUrl?.trim() && !safeUrl(d.buyUrl) ? 'Use a web address, like https://buy.stripe.com/…' : undefined}
                >
                  <IconInput icon={<Link2 />}>
                    <input id="ls-buy" className="input pl-8" inputMode="url" value={d.buyUrl ?? ''} onChange={(e) => setD({ buyUrl: e.target.value })} placeholder="https://" aria-invalid={d.buyUrl?.trim() && !safeUrl(d.buyUrl) ? true : undefined} />
                  </IconInput>
                </Field>
                }
              />
            ) : (
              <Field
                label={isBiz ? (d.bookingType === 'book' ? 'Your booking link' : d.bookingType === 'inquire' ? 'Your contact or quote page' : 'Your order page') : 'Your checkout link'}
                htmlFor="ls-buy"
                hint={isBiz ? 'For example Calendly, Square Appointments, Acuity, or your own site.' : 'For example a Stripe Payment Link, Gumroad, Etsy, Shopify or Lemon Squeezy page.'}
                error={d.buyUrl?.trim() && !safeUrl(d.buyUrl) ? 'Use a web address, like https://buy.stripe.com/…' : undefined}
              >
                <IconInput icon={<Link2 />}>
                  <input id="ls-buy" className="input pl-8" inputMode="url" value={d.buyUrl ?? ''} onChange={(e) => setD({ buyUrl: e.target.value })} placeholder="https://" aria-invalid={d.buyUrl?.trim() && !safeUrl(d.buyUrl) ? true : undefined} />
                </IconInput>
              </Field>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Email (optional)" htmlFor="ls-email" error={d.contactEmail?.trim() && !safeEmail(d.contactEmail) ? 'That doesn’t look like an email address.' : undefined}>
                <IconInput icon={<Mail />}>
                  <input id="ls-email" className="input pl-8" type="email" value={d.contactEmail ?? ''} onChange={(e) => setD({ contactEmail: e.target.value })} placeholder="you@yourbusiness.com" aria-invalid={d.contactEmail?.trim() && !safeEmail(d.contactEmail) ? true : undefined} />
                </IconInput>
              </Field>
              <Field label="Phone (optional)" htmlFor="ls-phone" error={d.phone?.trim() && !safePhone(d.phone) ? 'That doesn’t look like a phone number.' : undefined}>
                <IconInput icon={<Phone />}>
                  <input id="ls-phone" className="input pl-8" type="tel" value={d.phone ?? ''} onChange={(e) => setD({ phone: e.target.value })} placeholder="(555) 123-4567" aria-invalid={d.phone?.trim() && !safePhone(d.phone) ? true : undefined} />
                </IconInput>
              </Field>
            </div>
            {project.brand.websiteUrl && <p className="text-small text-muted">Your website ({project.brand.websiteUrl}) is shown too.</p>}
          </div>
        </Section>

        <ListingImages project={project}>
          <div className="mt-8 grid grid-cols-1 gap-6">
            <Field label="Cover" hint="Without one, a cover is made from your brand colors and logo.">
              <div className="flex flex-wrap items-center gap-2.5">
                {project.brand.images
                  .filter((m) => m.kind === 'image')
                  .map((m) => (
                    <PickThumb key={m.id} media={m} on={d.coverImageId === m.id} onClick={() => setD({ coverImageId: d.coverImageId === m.id ? undefined : m.id })} label={`Use ${m.name} as cover`} />
                  ))}
                <PhotoUploadButton
                  label="Upload"
                  ariaLabel="Upload a cover photo"
                  className="btn btn-secondary btn-sm"
                  onPhotos={(media) => {
                    const m = media[0];
                    if (!m) return;
                    updateBrand({ images: [...getActiveProject()!.brand.images, m] });
                    setD({ coverImageId: m.id });
                  }}
                />
                {d.coverImageId && (
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => setD({ coverImageId: undefined })}>
                    <X /> Use brand cover
                  </button>
                )}
              </div>
            </Field>
            <Field label="Gallery" right={<span className="num font-mono">{galleryMedia.length} of {MAX_GALLERY}</span>} hint={`Extra images buyers can flip through. Pick up to ${MAX_GALLERY}, or upload your own.`}>
              <div className="flex flex-wrap items-center gap-2.5">
                {galleryChoices.map((m) => {
                  const on = galleryMedia.some((x) => x.id === m.id);
                  return (
                    <PickThumb
                      key={m.id}
                      media={m}
                      on={on}
                      onClick={() => {
                        const g = galleryIds(getActiveProject()!);
                        if (on) setD({ galleryIds: g.filter((x) => x !== m.id) });
                        else if (g.length < MAX_GALLERY) setD({ galleryIds: [...g, m.id] });
                        else toast({ kind: 'info', title: `Up to ${MAX_GALLERY} gallery images`, body: 'Remove one from the gallery first.' });
                      }}
                      label={`${on ? 'Remove' : 'Add'} ${m.name} ${on ? 'from' : 'to'} the gallery`}
                    />
                  );
                })}
                <PhotoUploadButton multiple label={galleryChoices.length ? 'Upload photos' : 'Upload gallery photos'} className="btn btn-secondary btn-sm" onPhotos={addGalleryPhotos} />
              </div>
            </Field>
          </div>
        </ListingImages>

        <Section title="Video" divider>
          <VideoPanel
            className="border-0 bg-transparent p-0"
            title="Product demo video"
            prompt={demoPrompt}
            onPromptChange={setDemoPrompt}
            defaultAspect="16:9"
            startImage={coverMedia?.kind === 'image' ? coverMedia : null}
            media={d.demoVideo}
            onChange={(m) => setD({ demoVideo: m ?? undefined })}
            name={`${(d.title || project.brand.name || 'listing').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 36)}-demo`}
            pendingKey={`listing-video:${project.id}`}
            purpose="listing"
          />
        </Section>

        <Section title="Tags" divider description="Up to 8 words people search for, like your service, city or style.">
          <ChipInput values={d.tags} onChange={(v) => setD({ tags: v.map((t) => t.toLowerCase()) })} placeholder="Add a tag and press Enter" max={8} />
        </Section>

        {!__ARTIFACT_BUILD__ && <OffersPanel project={project} />}
      </div>

      <aside className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-6 lg:col-span-5" aria-label="Preview and publish">
        <div className="rounded-stage border border-line bg-surface p-4 shadow-product sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-small text-muted">How buyers see it</p>
            {live ? community === 'live' ? <StatusDot tone="good">Published</StatusDot> : <StatusDot tone="faint">Saved</StatusDot> : <StatusDot tone="faint">Draft</StatusDot>}
          </div>
          <ListingCard listing={preview} onOpen={() => (live ? openInStore(live.id) : toast({ kind: 'info', title: 'This is a preview', body: 'Publish it first, then open it in the Marketplace.' }))} />
          {galleryMedia.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Gallery preview">
              {galleryMedia.map((m) => (
                <MediaThumb key={m.id} media={m} className="aspect-[4/3] w-full rounded-md" />
              ))}
            </div>
          )}
        </div>

        <section aria-label="Before you publish">
          <h3 className="text-h4 text-ink">Before you publish</h3>
          <ul className="mt-3 flex flex-col gap-2">
            {checks.map((c) => (
              <li key={c.label} className={cn('flex items-start gap-2 text-small', c.ok ? 'text-ink-2' : c.optional ? 'text-muted' : 'text-ink')}>
                {c.ok ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-good" aria-label="Done" /> : c.optional ? <Circle size={16} className="mt-0.5 shrink-0 text-faint" aria-label="Optional" /> : <CircleAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-label="To do" />}
                {c.label}
              </li>
            ))}
          </ul>
        </section>

        <div className="flex flex-col gap-2">
          <StickyActionBar>
            <button type="button" className="btn btn-primary flex-1 sm:btn-lg" disabled={busy || blocking.length > 0} onClick={() => void publish()}>
              {busy && <Spinner size={16} />}
              {publishLabel}
            </button>
          </StickyActionBar>
          {blocking.length > 0 && <p className="text-center text-caption text-muted">Finish {blocking.length} required item{blocking.length > 1 ? 's' : ''} above to publish.</p>}
          {live && changed && <p className="text-center text-caption text-muted">Buyers see the last published version until you update it.</p>}
          {live && (
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary flex-1" onClick={() => openInStore(live.id)}>
                <ExternalLink /> View in store
              </button>
              <button type="button" className="btn btn-danger-ghost" onClick={() => void unpublish()}>
                Unpublish
              </button>
            </div>
          )}
        </div>

        {!__ARTIFACT_BUILD__ && live && <PublicWebToggle project={project} listing={live} />}

        <section className="flex flex-col gap-3 border-t border-line pt-5" aria-label="Visibility">
          <h3 className="text-h4 text-ink">Who can see it</h3>
          {community === 'live' ? (
            <p className="flex gap-2 text-small text-ink-2">
              <Users size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" /> This app is shared: everyone who uses it can see your listing. They buy or get in touch through your own link, email or phone.
            </p>
          ) : (
            <p className="flex gap-2 text-small text-ink-2">
              <Store size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" /> For now only you can see your listing here. Share its links (your checkout, website) wherever your customers are.
            </p>
          )}
          {community === 'live' && <Toggle checked={share} onChange={setListingsShared} label="Show my listings to other people" />}
          {live && (
            <p className="num text-caption text-muted">
              Published {project.studio.publishedAt ? fmtDateTime(project.studio.publishedAt) : ''} · {priceLabel(live.price, live.priceModel)}
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
