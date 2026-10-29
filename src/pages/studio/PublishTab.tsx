import { useMemo, useState } from 'react';
import { Check, CircleAlert, Clock, ExternalLink, Globe2, ImagePlus, Rocket, Store, Users, X } from 'lucide-react';
import type { BookingType, ListingDraft, PriceModel, Project } from '@/lib/types';
import { cn, fmtDateTime, fmtMoney } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { useRuntime } from '@/lib/platform';
import { pushMyListings, startCommunitySync } from '@/lib/community';
import { BUSINESS_CATEGORIES, PRODUCT_CATEGORIES } from '@/ai/knowledge';
import { listingTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, ChipInput, Field, Segmented, Spinner, Toggle, confirmAction } from '@/components/ui/primitives';
import { MediaDrop, MediaThumb } from '@/components/media/MediaUpload';
import { ListingCard, ListingCover, priceLabel } from '@/pages/store/ListingParts';
import { buildListing, coverFromMedia, galleryFromMedia, leadPrice } from './listing';
import { ListingImages, MAX_GALLERY } from './ListingImages';
import { VideoPanel } from '@/components/images/VideoPanel';

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

export function PublishTab({ project }: { project: Project }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const updateBrand = useStore((s) => s.updateBrand);
  const publishListing = useStore((s) => s.publishListing);
  const unpublishListing = useStore((s) => s.unpublishListing);
  const share = useStore((s) => s.settings.shareToCommunity);
  const updateSettings = useStore((s) => s.updateSettings);
  const live = useStore((s) => s.myListings.find((l) => l.id === project.studio.publishedListingId));
  const community = useRuntime((s) => s.community);
  const ai = useAI(listingTask);
  const [busy, setBusy] = useState(false);
  const d = project.studio.listing;
  const isBiz = project.track === 'business';
  const setD = (patch: Partial<ListingDraft>) => updateStudio({ listing: { ...getActiveProject()!.studio.listing, ...patch } });
  const coverMedia = d.coverImageId ? project.brand.images.find((m) => m.id === d.coverImageId) : undefined;
  const [demoPrompt, setDemoPrompt] = useState(() => demoVideoPrompt(project));
  const galleryMedia = (d.galleryIds ?? []).map((id) => project.brand.images.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m && m.id !== d.coverImageId);
  const preview = useMemo(() => {
    const l = buildListing(project, live);
    return coverMedia?.thumb ? { ...l, cover: { ...l.cover, imageDataUrl: coverMedia.thumb } } : l;
  }, [project, live, coverMedia]);
  const lp = leadPrice(project);

  const checks = [
    { ok: d.title.trim().length >= 4, label: 'Title' },
    { ok: d.description.trim().length >= 80, label: 'Description (80+ characters)' },
    { ok: lp.price > 0 || lp.model === 'free' || lp.model === 'quote', label: isBiz ? 'Package pricing' : 'Price' },
    { ok: d.tags.length >= 3, label: '3+ search tags' },
    { ok: isBiz ? project.studio.packages.length > 0 : project.studio.outline.length > 0, label: isBiz ? 'Service packages (Structure tab)' : 'Product outline (Structure tab)' },
    { ok: !!d.coverImageId, label: 'Cover photo (optional: brand cover is used otherwise)', optional: true },
  ];
  const blocking = checks.filter((c) => !c.ok && !c.optional);
  const changed = !!live && (JSON.stringify({ ...buildListing(project, live), cover: null, gallery: null }) !== JSON.stringify({ ...live, cover: null, gallery: null }) || galleryMedia.length !== (live.gallery?.length ?? 0));

  const write = async () => {
    const r = await ai.run({});
    if (r) setD({ title: r.title, tagline: r.tagline, description: r.description, category: r.category || d.category, tags: r.tags.length ? r.tags : d.tags });
  };

  const publish = async () => {
    setBusy(true);
    try {
      const p = getActiveProject()!;
      const cover = await coverFromMedia(p);
      const gallery = await galleryFromMedia(p);
      const listing = { ...buildListing(p, live, cover, gallery), gallery };
      publishListing(listing);
      updateStudio({ publishedListingId: listing.id, publishedAt: Date.now() });
      startCommunitySync();
      await pushMyListings();
      useStore.getState().notify({ kind: 'sale', title: live ? `Listing updated: ${listing.title}` : `${listing.title} is live on the Marketplace`, route: 'store' });
      toast({ kind: 'success', title: live ? 'Listing updated' : 'Published to the Marketplace', body: listing.title, action: { label: 'View listing', run: () => openInStore(listing.id) } });
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    if (!live) return;
    if (!(await confirmAction({ title: 'Unpublish this listing?', body: 'It disappears from the Marketplace. Your Studio work stays intact and you can republish anytime.', confirmLabel: 'Unpublish', danger: true }))) return;
    unpublishListing(live.id);
    updateStudio({ publishedListingId: undefined, publishedAt: undefined });
    pushMyListings();
    toast({ kind: 'info', title: 'Listing unpublished' });
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <section className="panel flex min-w-0 flex-col gap-4 p-4 sm:p-5" aria-label="Listing details">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="section-title">Marketplace listing</h2>
            <p className="text-[13px] text-muted">Pre-filled from your project. Rewrite it with AI or edit by hand.</p>
          </div>
          <GenerateButton running={ai.running} onClick={write} size="sm">
            Write listing with AI
          </GenerateButton>
        </div>
        <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} compact />
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}

        <Field label="Title" htmlFor="ls-title" right={`${d.title.length}/70`}>
          <input id="ls-title" className="input" maxLength={90} value={d.title} onChange={(e) => setD({ title: e.target.value })} />
        </Field>
        <Field label="Tagline" htmlFor="ls-tag" right={`${d.tagline.length}/110`}>
          <input id="ls-tag" className="input" maxLength={140} value={d.tagline} onChange={(e) => setD({ tagline: e.target.value })} />
        </Field>
        <Field label="Description" htmlFor="ls-desc" hint="Short intro, what they get (• bullets) and a closing line.">
          <AutoTextarea id="ls-desc" value={d.description} onChange={(v) => setD({ description: v })} minRows={6} className="text-[13.5px]" />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          <Field label="Search tags">
            <ChipInput values={d.tags} onChange={(v) => setD({ tags: v.map((t) => t.toLowerCase()) })} placeholder="Add a tag and press Enter" max={8} />
          </Field>
        </div>

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
            <Field label="Hours" htmlFor="ls-hours">
              <div className="relative">
                <Clock size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input id="ls-hours" className="input pl-8" value={d.hours} onChange={(e) => setD({ hours: e.target.value })} placeholder="Mon–Fri 8am–6pm" />
              </div>
            </Field>
            <p className="text-xs text-muted sm:col-span-2">
              Lead price <b className="num text-ink">{priceLabel(lp.price, lp.model)}</b> comes from your most popular package. Buyers can pick any of your {project.studio.packages.length || 'service'} packages.
              {!project.location && ' No city set, so the listing shows as online.'}
            </p>
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

        <ListingImages project={project} />

        <VideoPanel
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

        <Field label="Cover photo" hint="Pick one of your brand images or upload a new one. Without one, a cover is generated from your brand colors.">
          <div className="flex flex-wrap items-center gap-2">
            {project.brand.images
              .filter((m) => m.kind === 'image')
              .map((m) => (
                <button key={m.id} className={cn('relative h-16 w-24 overflow-hidden rounded-md ring-offset-2 ring-offset-surface', d.coverImageId === m.id ? 'ring-2 ring-primary' : 'ring-1 ring-line hover:ring-line-2')} onClick={() => setD({ coverImageId: d.coverImageId === m.id ? undefined : m.id })} aria-pressed={d.coverImageId === m.id} aria-label={`Use ${m.name} as cover`}>
                  <MediaThumb media={m} className="h-full w-full rounded-none border-0" />
                  {d.coverImageId === m.id && (
                    <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-on-primary">
                      <Check size={11} />
                    </span>
                  )}
                </button>
              ))}
            <MediaDrop
              compact
              accept="image/*"
              label="Upload"
              className="h-16 w-24"
              onFiles={(media) => {
                const m = media[0];
                if (!m) return;
                updateBrand({ images: [...getActiveProject()!.brand.images, m] });
                setD({ coverImageId: m.id });
              }}
            />
            {d.coverImageId && (
              <button className="btn btn-ghost btn-xs" onClick={() => setD({ coverImageId: undefined })}>
                <X size={12} /> Use brand cover
              </button>
            )}
          </div>
        </Field>
        {project.brand.images.some((m) => m.kind === 'image' && m.id !== d.coverImageId) && (
          <Field label={`Gallery (${galleryMedia.length}/${MAX_GALLERY})`} hint="Extra images buyers can flip through on your listing.">
            <div className="flex flex-wrap items-center gap-2">
              {project.brand.images
                .filter((m) => m.kind === 'image' && m.id !== d.coverImageId)
                .map((m) => {
                  const on = (d.galleryIds ?? []).includes(m.id);
                  return (
                    <button
                      key={m.id}
                      className={cn('relative h-16 w-24 overflow-hidden rounded-md ring-offset-2 ring-offset-surface', on ? 'ring-2 ring-accent' : 'ring-1 ring-line hover:ring-line-2')}
                      onClick={() => {
                        const g = d.galleryIds ?? [];
                        if (on) setD({ galleryIds: g.filter((x) => x !== m.id) });
                        else if (g.length < MAX_GALLERY) setD({ galleryIds: [...g, m.id] });
                        else toast({ kind: 'info', title: `Up to ${MAX_GALLERY} gallery images` });
                      }}
                      aria-pressed={on}
                      aria-label={`${on ? 'Remove' : 'Add'} ${m.name} ${on ? 'from' : 'to'} the gallery`}
                    >
                      <MediaThumb media={m} className="h-full w-full rounded-none border-0" />
                      {on && (
                        <span className="absolute right-1 top-1 rounded-full bg-accent p-0.5 text-on-accent">
                          <Check size={11} />
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          </Field>
        )}
      </section>

      <aside className="flex min-w-0 flex-col gap-4">
        <section className="panel p-4" aria-label="Preview and publish">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold">Live preview</h3>
            {live ? <span className="badge bg-good-soft text-good">● Live</span> : <span className="badge bg-surface-2 text-muted">Draft</span>}
          </div>
          <div className="mx-auto max-w-[340px]">
            <ListingCard listing={preview} onOpen={() => (live ? openInStore(live.id) : undefined)} onAdd={() => toast({ kind: 'info', title: 'This is a preview', body: 'Publish first, then buyers can add it to their cart.' })} />
            {galleryMedia.length > 0 && (
              <div className="mt-2 grid grid-cols-4 gap-1.5" aria-label="Gallery preview">
                {galleryMedia.map((m) => (
                  <MediaThumb key={m.id} media={m} className="aspect-square w-full" />
                ))}
              </div>
            )}
          </div>
          <ul className="mt-4 flex flex-col gap-1.5 text-[13px]">
            {checks.map((c) => (
              <li key={c.label} className={cn('flex items-center gap-2', c.ok ? 'text-ink-2' : c.optional ? 'text-muted' : 'text-warn')}>
                {c.ok ? <Check size={14} className="text-good" /> : <CircleAlert size={14} />}
                {c.label}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col gap-2">
            <button className="btn btn-primary btn-lg w-full" disabled={busy || blocking.length > 0} onClick={publish}>
              {busy ? <Spinner size={16} /> : <Rocket size={16} />}
              {live ? (changed ? 'Update listing' : 'Republish listing') : 'Publish to Marketplace'}
            </button>
            {blocking.length > 0 && <p className="text-center text-xs text-muted">Finish {blocking.length} required item{blocking.length > 1 ? 's' : ''} above to publish.</p>}
            {live && (
              <div className="flex gap-2">
                <button className="btn btn-secondary flex-1" onClick={() => openInStore(live.id)}>
                  <ExternalLink size={15} /> View in store
                </button>
                <button className="btn btn-ghost text-muted hover:text-bad" onClick={unpublish}>
                  Unpublish
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="panel flex flex-col gap-3 p-4 text-[13px]" aria-label="Visibility">
          <h3 className="flex items-center gap-2 font-semibold">
            <Globe2 size={15} className="text-primary" /> Who can see it
          </h3>
          {community === 'live' ? (
            <p className="flex gap-2 text-ink-2">
              <Users size={15} className="mt-0.5 shrink-0 text-good" /> This app is shared: everyone who opens it can browse and buy your listing, and their purchases show up in your Analytics.
            </p>
          ) : (
            <p className="flex gap-2 text-ink-2">
              <Store size={15} className="mt-0.5 shrink-0 text-muted" /> Listed on this device’s Marketplace. When the app is opened as a shared page, listings sync between everyone who has it.
            </p>
          )}
          <Toggle checked={share} onChange={(v) => { updateSettings((s) => ({ ...s, shareToCommunity: v })); setTimeout(() => pushMyListings(), 0); }} label="Share my listings with other viewers" />
          {live && (
            <p className="text-xs text-muted">
              Published {project.studio.publishedAt ? fmtDateTime(project.studio.publishedAt) : ''} · {live.sales} sale{live.sales === 1 ? '' : 's'} · {fmtMoney(live.price)}
            </p>
          )}
        </section>

        {live && (
          <section className="panel overflow-hidden" aria-label="Buyer view">
            <ListingCover listing={live} className="aspect-[21/8] w-full" />
            <div className="p-3 text-xs text-muted">
              <ImagePlus size={12} className="mr-1 inline" /> This is the cover buyers see right now.
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}

function openInStore(id: string) {
  navigate('store');
  setTimeout(() => useUI.getState().openListing(id), 60);
}
