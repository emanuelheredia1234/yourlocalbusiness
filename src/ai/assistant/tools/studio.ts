// Business Studio tools: the offer and its price, the Marketplace listing (its words, images and
// publishing), the structure (a product's outline and chapter drafts, a business's model) and the
// product files. Not the Code & assets tab and not the SEO page builder.
//
// Each tool does what the page's own button does, through the same code (src/ai/structure.ts,
// src/ai/listingImages.ts, src/ai/listingCopy.ts, src/ai/productFiles.ts, src/lib/listingPublish.ts).
// Prices, hours and guarantees are only ever the owner's: a business with no price asks for a quote.

import type { ListingShotId, MediaRef, Project, ProductFile, ServicePackage, ServicePriceModel, Studio } from '@/lib/types';
import { fmtBytes, fmtDateTime, fmtMoney, listJoin, plural, slugify, uid } from '@/lib/utils';
import { useRuntime } from '@/lib/platform';
import { beginBusy, busyId, busyJobs, endBusy } from '@/lib/busy';
import { isOwnPhoto } from '@/lib/media';
import { useCommunity } from '@/lib/community';
import { galleryIds, leadPrice, MAX_GALLERY, priceLabel } from '@/lib/listing';
import { safeEmail, safePhone, safeUrl } from '@/lib/listingActions';
import { blockingChecks, listingChanged, listingChecks, listingsShared, liveListing, UNPUBLISH_CONFIRM, unpublishProjectListing } from '@/lib/listingPublish';
import { BUSINESS_CATEGORIES, FORMATS, PRODUCT_CATEGORIES } from '@/ai/knowledge';
import { useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { defaultImageKind, imageErrorMessage, listingShots, photoAvailability, photoRoute, type ListingShot } from '../../image';
import { fromOwnPhoto, listingShotMedia, OWN_PHOTO_PROVIDER, PHOTO_ACCEPT } from '../../listingPhotos';
import { ALL_SHOTS, listingPendingKey, makeListingShot, ownPhotoPlaced, placeListingShot, savePhotoFile } from '../../listingImages';
import { pendingManus } from '../../manus';
import { applyBusinessModel, applyItemDetail, applyOutline, applySectionDraft, businessMarkdown, outlineMarkdown, packagePriceText, projectById, updateStudioOf } from '../../structure';
import { applyListingCopy, patchListingDraft } from '../../listingCopy';
import { businessModelTask, expandItemTask, listingTask, outlineTask, sectionDraftTask } from '../../tasks';
import { primaryProvider } from '../../functions';
import { runAITask } from '../aiTask';
import { copyButton, downloadButton, fileButton, noteInChat } from '../buttons';
import { deleteConfirm, manusCard } from '../confirm';
import { host } from '../host';
import { activeProject } from '../lookup';
import { arg, clip, defineTool, untrusted, type AnyTool, type ArgValue, type ChatButton, type ConfirmCardSpec } from '../registry';

const SHOT_IDS = ['hero', 'lifestyle', 'inside', 'offer'] as const satisfies readonly ListingShotId[];
const PACKAGE_MODELS = ['per-session', 'project', 'monthly', 'one-time', 'quote', 'free'] as const satisfies readonly ServicePriceModel[];
const PRODUCT_MODELS = ['one-time', 'monthly', 'yearly'] as const;
/** The Business model tab holds up to this many packages. */
const MAX_PACKAGES = 4;
const MONEY_MAX = 1_000_000;
/** A writing tool asks on a card first when one call makes at least this many AI requests. */
const MANY_REQUESTS = 4;

const isBusiness = (p: Project) => p.track === 'business';
/** Something with one of these labels is generating now (on a page, or by the assistant). */
const busyWith = (...labels: string[]) => busyJobs().some((j) => labels.includes(j.label));
const stopped = () => Object.assign(new Error('Stopped.'), { code: 'cancelled' });
const isStop = (e: unknown) => (e as { code?: string })?.code === 'cancelled';

/** For results after an edit: a live listing shows the old details until it's published again. */
function liveNote(p: Project): { marketplace?: string } {
  return liveListing(p) ? { marketplace: 'The Marketplace shows the old listing until it’s updated (publish_listing).' } : {};
}

/** Who writes a text task here, for a card: the key that powers it, Claude, or the built-in engine. */
function writer(fns: string[]): string {
  if (__ARTIFACT_BUILD__) return 'Claude, in claude.ai.';
  const labels = [...new Set(fns.map((f) => primaryProvider(f)?.label).filter((l): l is string => !!l))];
  if (!labels.length) return 'The built-in engine: no key powers this writing in Settings → AI, so the drafts are simpler.';
  return `${listJoin(labels)}, the key${labels.length === 1 ? ' that powers' : 's that power'} this writing in Settings → AI.`;
}

/** What a card says about the requests a tool makes. */
const requestCost = (n: number) => (__ARTIFACT_BUILD__ ? `About ${plural(n, 'request')} to Claude.` : `About ${plural(n, 'AI request')}, counted toward today’s AI limit.`);

// ───────────── the offer and its price ─────────────

const packageEdit = arg.object({
  id: arg.string({ optional: true, max: 60, desc: 'omit to add' }),
  name: arg.string({ optional: true, max: 80 }),
  price: arg.number({ optional: true, min: 0, desc: '0: Get a quote' }),
  priceModel: arg.enum(PACKAGE_MODELS, { optional: true }),
  description: arg.string({ optional: true, max: 600, allowEmpty: true }),
  includes: arg.array(arg.string({ max: 160 }), { optional: true, max: 12 }),
  popular: arg.boolean({ optional: true }),
  remove: arg.boolean({ optional: true }),
});
type PackageEdit = ArgValue<typeof packageEdit>;

/** A package's price: one without a price asks for a quote; "Free" only when the owner says free. */
function priced(price: number, model: ServicePriceModel): Pick<ServicePackage, 'price' | 'priceModel'> {
  if (model === 'quote' || model === 'free') return { price: 0, priceModel: model };
  return price > 0 ? { price, priceModel: model } : { price: 0, priceModel: 'quote' };
}

function editPackage(pk: ServicePackage, e: PackageEdit): ServicePackage {
  return {
    ...pk,
    ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.description !== undefined ? { description: e.description } : {}),
    ...(e.includes ? { includes: e.includes } : {}),
    ...(e.popular === false ? { popular: false } : {}),
    ...(e.price !== undefined || e.priceModel !== undefined ? priced(e.price ?? pk.price, e.priceModel ?? pk.priceModel) : {}),
  };
}

function newPackage(e: PackageEdit, others: ServicePackage[]): ServicePackage {
  const ref = others.find((x) => x.popular) ?? others[0];
  const model = e.priceModel ?? (ref && ref.priceModel !== 'quote' && ref.priceModel !== 'free' ? ref.priceModel : 'per-session');
  return { id: uid('pkg'), name: e.name ?? 'New package', description: e.description ?? '', includes: e.includes ?? [], ...priced(e.price ?? 0, model) };
}

const updateStudio = defineTool({
  name: 'update_studio',
  class: 'L',
  summary: 'Set prices. Product: price, priceModel, compareAt. Business: edit, add (no id) or remove packages, or price with no packages. Price 0 = “Get a quote”.',
  args: {
    price: arg.number({ optional: true, min: 0 }),
    priceModel: arg.enum(PRODUCT_MODELS, { optional: true }),
    compareAt: arg.number({ optional: true, min: 0, desc: '0 clears' }),
    packages: arg.array(packageEdit, { optional: true, min: 1, max: 6 }),
  },
  validate: (a) => {
    const p = activeProject();
    if (a.price === undefined && a.priceModel === undefined && a.compareAt === undefined && !a.packages) return 'Say what to change.';
    if ([a.price, a.compareAt, ...(a.packages ?? []).map((e) => e.price)].some((n) => n !== undefined && n > MONEY_MAX)) return `Prices go up to ${fmtMoney(MONEY_MAX)}.`;
    if (!isBusiness(p)) return a.packages ? 'A digital product has no packages: set price, priceModel or compareAt.' : null;
    if (a.priceModel !== undefined || a.compareAt !== undefined) return 'A business prices each package (packages[].priceModel); priceModel and compareAt are for a digital product.';
    const ids = new Set(p.studio.packages.map((x) => x.id));
    for (const [i, e] of (a.packages ?? []).entries()) {
      if (e.id && !ids.has(e.id)) return `There’s no package with id "${e.id}". get_project with section offer lists them.`;
      if (!e.id && e.remove) return `packages[${i}]: name the package to remove by its id.`;
      if (!e.id && !e.name) return `packages[${i}]: a new package needs a name.`;
    }
    const edits = a.packages ?? [];
    if (edits.filter((e) => e.popular && !e.remove).length > 1) return 'Only one package can be the most popular.';
    const removed = new Set(edits.filter((e) => e.remove).map((e) => e.id)).size;
    const left = p.studio.packages.length - removed + edits.filter((e) => !e.id).length;
    if (removed && left < 1) return 'Keep at least one package: a business listing needs one.';
    if (left > MAX_PACKAGES) return `A business has at most ${MAX_PACKAGES} packages.`;
    // with packages, the listing leads with a package's price: there is no other price to set
    if (a.price !== undefined && left > 0) return 'This business has packages: set a package’s price instead (packages: [{id, price}]).';
    return null;
  },
  run: (a, ctx) => {
    const p = activeProject();
    const patch: Partial<Studio> = {};
    if (isBusiness(p)) {
      let pkgs = p.studio.packages;
      for (const e of a.packages ?? []) {
        if (e.remove) {
          pkgs = pkgs.filter((x) => x.id !== e.id);
          continue;
        }
        let id = e.id;
        if (id) pkgs = pkgs.map((x) => (x.id === id ? editPackage(x, e) : x));
        else {
          const made = newPackage(e, pkgs);
          id = made.id;
          pkgs = [...pkgs, made];
        }
        // one most-popular package, as the Business model tab marks it
        if (e.popular) pkgs = pkgs.map((x) => ({ ...x, popular: x.id === id }));
      }
      if (a.packages) patch.packages = pkgs;
      if (a.price !== undefined) patch.price = a.price;
    } else {
      if (a.price !== undefined) patch.price = a.price;
      if (a.priceModel !== undefined) patch.priceModel = a.priceModel;
      if (a.compareAt !== undefined) patch.compareAt = a.compareAt;
    }
    updateStudioOf(ctx.projectId, patch);
    const after = projectById(ctx.projectId)!;
    const s = after.studio;
    const lead = leadPrice(after);
    if (isBusiness(after)) {
      const packages = s.packages.map((pk) => ({ id: pk.id, name: pk.name, price: packagePriceText(pk), ...(pk.popular ? { popular: true } : {}) }));
      return {
        data: { listingPrice: priceLabel(lead.price, lead.model), packages, ...(a.price !== undefined ? { priceWithoutPackages: s.price ? fmtMoney(s.price) : 'none (Get a quote)' } : {}), ...liveNote(after) },
        note: clip(a.packages ? `Updated your packages: ${packages.map((x) => `${x.name} ${x.price}`).join(', ')}` : `Set your price to ${s.price ? fmtMoney(s.price) : 'none (Get a quote)'}`, 160),
      };
    }
    const hidden = s.compareAt > 0 && s.compareAt <= s.price;
    return {
      data: { price: priceLabel(s.price, s.priceModel), compareAt: s.compareAt ? fmtMoney(s.compareAt) : null, ...(hidden ? { compareAtShown: false, why: 'A compare-at price shows only when it’s higher than the price.' } : {}), ...liveNote(after) },
      note: `Set your price to ${priceLabel(s.price, s.priceModel)}${s.compareAt > s.price ? ` (was ${fmtMoney(s.compareAt)})` : ''}`,
    };
  },
});

// ───────────── the listing ─────────────

/** What a listing image shows now, in a few words. */
function shotShows(m: MediaRef | undefined): string {
  if (!m) return 'nothing yet';
  if (isOwnPhoto(m)) return 'your own photo';
  const g = m.generated;
  if (g?.provider === OWN_PHOTO_PROVIDER) return 'your photo with your details on it';
  if (g?.kind === 'photo') return `an AI photo (${g.provider})`;
  if (g?.kind === 'illustration') return `an AI illustration (${g.provider})`;
  return 'a built-in design';
}

function visibility(): string {
  if (listingsShared()) return 'everyone who uses the app';
  return useRuntime.getState().community === 'live' ? 'only the owner (“Show my listings to other people” is off)' : 'only the owner (no shared Marketplace in this view)';
}

const getListing = defineTool({
  name: 'get_listing',
  class: 'R',
  summary: 'The listing: words, price, links, what’s missing to publish, live or not, who sees it, the four images, brand image ids.',
  args: {},
  run: () => {
    const p = activeProject();
    const d = p.studio.listing;
    const live = liveListing(p);
    const lead = leadPrice(p);
    const checks = listingChecks(p);
    const biz = isBusiness(p);
    return {
      data: {
        title: d.title,
        tagline: d.tagline,
        description: clip(d.description, 700),
        category: d.category,
        tags: d.tags,
        price: priceLabel(lead.price, lead.model),
        ...(biz ? { howCustomersBuy: d.bookingType, hours: d.hours || null } : {}),
        buyUrl: d.buyUrl || null,
        contactEmail: d.contactEmail || null,
        phone: d.phone || null,
        website: p.brand.websiteUrl || null,
        live: live ? { since: p.studio.publishedAt ? fmtDateTime(p.studio.publishedAt) : null, upToDate: !listingChanged(p, live) } : null,
        whoSeesIt: visibility(),
        missing: checks.filter((c) => !c.ok && !c.optional).map((c) => c.label),
        tips: checks.filter((c) => !c.ok && c.optional).map((c) => c.label),
        images: listingShots(p).map((s) => {
          const m = listingShotMedia(p, s.id);
          return { shot: s.id, label: s.label, shows: shotShows(m), ...(m && d.coverImageId === m.id ? { cover: true } : {}), ...(m && galleryIds(p).includes(m.id) ? { inGallery: true } : {}), description: d.shotPrompts?.[s.id] ? 'edited by the owner' : 'suggested' };
        }),
        cover: d.coverImageId ? 'an image the owner picked' : 'made from the brand colors and logo',
        gallery: galleryIds(p).length,
        brandImages: p.brand.images
          .filter((m) => m.kind === 'image')
          .slice(-12)
          .map((m) => ({ id: m.id, name: clip(m.name, 60), own: isOwnPhoto(m) })),
      },
      note: `Read your listing${checks.some((c) => !c.ok && !c.optional) ? '' : ': ready to publish'}`,
    };
  },
});

const categoriesFor = (p: Project) => (isBusiness(p) ? BUSINESS_CATEGORIES : PRODUCT_CATEGORIES);
const findCategory = (p: Project, c: string) => (c.toLowerCase() === p.studio.listing.category.toLowerCase() ? p.studio.listing.category : categoriesFor(p).find((x) => x.toLowerCase() === c.toLowerCase()));
const isImage = (p: Project, id: string) => p.brand.images.some((m) => m.id === id && m.kind === 'image');

const LISTING_FIELDS = ['title', 'tagline', 'description', 'category', 'tags', 'bookingType', 'hours', 'buyUrl', 'contactEmail', 'phone', 'coverImageId', 'galleryIds'] as const;
const FIELD_WORDS: Record<(typeof LISTING_FIELDS)[number], string> = { title: 'title', tagline: 'tagline', description: 'description', category: 'category', tags: 'search tags', bookingType: 'how customers buy', hours: 'hours', buyUrl: 'buy or booking link', contactEmail: 'email', phone: 'phone', coverImageId: 'cover', galleryIds: 'gallery' };

const updateListingDraft = defineTool({
  name: 'update_listing_draft',
  class: 'L',
  summary: 'Edit the listing draft with the owner’s facts only (never made-up hours or guarantees). "" clears a field.',
  args: {
    title: arg.string({ optional: true, max: 90 }),
    tagline: arg.string({ optional: true, max: 140, allowEmpty: true }),
    description: arg.string({ optional: true, max: 4000 }),
    category: arg.string({ optional: true, max: 60 }),
    tags: arg.array(arg.string({ max: 40 }), { optional: true, max: 8 }),
    bookingType: arg.enum(['book', 'inquire', 'buy'], { optional: true, desc: 'business' }),
    hours: arg.string({ optional: true, max: 160, allowEmpty: true, desc: 'business' }),
    buyUrl: arg.string({ optional: true, max: 500, allowEmpty: true, desc: 'own checkout or booking page' }),
    contactEmail: arg.string({ optional: true, max: 200, allowEmpty: true }),
    phone: arg.string({ optional: true, max: 40, allowEmpty: true }),
    coverImageId: arg.string({ optional: true, max: 80, allowEmpty: true, desc: 'brand image id; "": brand cover' }),
    galleryIds: arg.array(arg.string({ max: 80 }), { optional: true, max: MAX_GALLERY }),
  },
  validate: (a) => {
    const p = activeProject();
    if (!LISTING_FIELDS.some((k) => a[k] !== undefined)) return 'Say what to change.';
    if (!isBusiness(p) && (a.bookingType !== undefined || a.hours !== undefined)) return 'How customers buy and hours are for a business listing.';
    if (a.category !== undefined && !findCategory(p, a.category)) return `category must be one of: ${categoriesFor(p).join(', ')}.`;
    if (a.buyUrl && !safeUrl(a.buyUrl)) return 'buyUrl must be a web address, like https://buy.stripe.com/… ("" clears it).';
    if (a.contactEmail && !safeEmail(a.contactEmail)) return 'contactEmail doesn’t look like an email address ("" clears it).';
    if (a.phone && !safePhone(a.phone)) return 'phone doesn’t look like a phone number ("" clears it).';
    if (a.coverImageId && !isImage(p, a.coverImageId)) return `There’s no image with id "${a.coverImageId}" in the brand images. get_listing lists them.`;
    const cover = a.coverImageId !== undefined ? a.coverImageId : p.studio.listing.coverImageId;
    for (const id of a.galleryIds ?? []) {
      if (!isImage(p, id)) return `There’s no image with id "${id}" in the brand images. get_listing lists them.`;
      if (id === cover) return 'The cover image isn’t also in the gallery: pick other images.';
    }
    if (a.galleryIds && new Set(a.galleryIds).size !== a.galleryIds.length) return 'galleryIds has the same image twice.';
    return null;
  },
  run: (a, ctx) => {
    const p = activeProject();
    const changed = LISTING_FIELDS.filter((k) => a[k] !== undefined);
    patchListingDraft(
      {
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.tagline !== undefined ? { tagline: a.tagline } : {}),
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.category !== undefined ? { category: findCategory(p, a.category)! } : {}),
        ...(a.tags ? { tags: [...new Set(a.tags.map((t) => t.toLowerCase()))] } : {}),
        ...(a.bookingType ? { bookingType: a.bookingType } : {}),
        ...(a.hours !== undefined ? { hours: a.hours } : {}),
        ...(a.buyUrl !== undefined ? { buyUrl: a.buyUrl } : {}),
        ...(a.contactEmail !== undefined ? { contactEmail: a.contactEmail } : {}),
        ...(a.phone !== undefined ? { phone: a.phone } : {}),
        ...(a.coverImageId !== undefined ? { coverImageId: a.coverImageId || undefined } : {}),
        ...(a.galleryIds ? { galleryIds: a.galleryIds } : {}),
      },
      ctx.projectId,
    );
    const after = projectById(ctx.projectId)!;
    const d = after.studio.listing;
    return {
      data: { changed, listing: { title: d.title, tagline: d.tagline, category: d.category, tags: d.tags }, missing: blockingChecks(after).map((c) => c.label), ...liveNote(after) },
      note: `Updated your listing: ${listJoin(changed.map((k) => FIELD_WORDS[k]))}`,
    };
  },
});

const writeListingCopy = defineTool({
  name: 'write_listing_copy',
  class: 'P-text',
  summary: 'AI writes the listing’s title, tagline, description and tags (1 AI request). Existing copy: replace: true after asking the owner.',
  args: { replace: arg.boolean({ optional: true }) },
  validate: ({ replace }) => {
    const d = activeProject().studio.listing;
    if (busyWith(listingTask.label)) return 'The listing copy is being written on Studio → Listing & publish right now. Wait for it to finish.';
    return d.description.trim() && !replace ? 'The listing already has a description. Ask the owner, then call again with replace: true.' : null;
  },
  run: async (_a, ctx) => {
    const r = await runAITask(listingTask, {}, ctx);
    applyListingCopy(r.data, ctx.projectId);
    const after = projectById(ctx.projectId)!;
    const d = after.studio.listing;
    return {
      data: { title: d.title, tagline: d.tagline, description: clip(d.description, 600), category: d.category, tags: d.tags, missing: blockingChecks(after).map((c) => c.label), ...liveNote(after) },
      note: `Wrote your listing copy: “${clip(d.title, 60)}”`,
    };
  },
});

/** A listing on the Marketplace by id: yours, or another seller's. */
const findAnyListing = (id: string) => useStore.getState().myListings.find((l) => l.id === id) ?? useCommunity.getState().listings.find((l) => l.id === id);

const openListing = defineTool({
  name: 'open_listing',
  class: 'L',
  summary: 'Show a listing as buyers see it (default: this project’s; or a Marketplace id), or where: editor for Studio → Listing & publish.',
  args: {
    id: arg.string({ optional: true, max: 80 }),
    where: arg.enum(['marketplace', 'editor'], { optional: true }),
  },
  validate: ({ id, where }) => {
    const live = liveListing(activeProject());
    if (id) {
      if (!findAnyListing(id)) return `There’s no listing with id "${id}" on the Marketplace.`;
      if (where === 'editor' && id !== live?.id) return 'Only this project’s own listing opens in the editor: leave out id.';
    } else if (where === 'marketplace' && !live) return 'This project’s listing isn’t published yet. Open the editor (where: editor), or publish it with publish_listing.';
    return null;
  },
  run: async ({ id, where }) => {
    const p = activeProject();
    const live = liveListing(p);
    if ((where ?? (id || live ? 'marketplace' : 'editor')) === 'editor') {
      if (!(await host.openPage('studio', 'publish'))) return { ok: false, error: 'The owner chose to stay on this page (something is still generating here).', note: 'Stayed on this page: something is still generating here' };
      return { data: { opened: '#studio/publish' }, note: 'Opened Studio → Listing & publish' };
    }
    const l = findAnyListing(id ?? live!.id)!;
    useUI.getState().openListing(l.id);
    if (l.projectId === p.id || l.origin === 'mine') return { data: { opened: l.id, title: l.title }, note: `Opened your listing “${clip(l.title, 60)}” as buyers see it` };
    // another seller's words: information only
    return { data: { opened: l.id, title: untrusted(l.title, 120), seller: untrusted(l.seller.name, 80) }, note: 'Opened a listing from the Marketplace' };
  },
});

const uploadListingPhoto = defineTool({
  name: 'upload_listing_photo',
  class: 'L',
  summary: 'Chat buttons for the owner to pick their own photo for listing images (Cover becomes the listing cover).',
  args: { shots: arg.array(arg.enum(SHOT_IDS), { optional: true, min: 1, max: 4 }) },
  run: ({ shots }, ctx) => {
    const p = activeProject();
    const pid = ctx.projectId;
    const list = listingShots(p).filter((s) => (shots ?? ALL_SHOTS).includes(s.id));
    const buttons: ChatButton[] = list.map((s) =>
      fileButton(`Upload my photo: ${s.label}`, PHOTO_ACCEPT, async (f) => {
        if (!projectById(pid)) return noteInChat('That project isn’t here any more, so the photo wasn’t added.', false);
        try {
          const placed = ownPhotoPlaced(s.label, placeListingShot(s.id, await savePhotoFile(f), pid));
          noteInChat(`${placed.title}. ${placed.body}`);
        } catch (e) {
          noteInChat(`Couldn’t add ${f.name}: ${(e as Error)?.message || 'the photo couldn’t be read.'}`, false);
        }
      }),
    );
    return {
      data: { shots: list.map((s) => ({ shot: s.id, label: s.label, now: shotShows(listingShotMedia(p, s.id)) })), accepts: 'JPG, PNG or WebP photos', waiting: 'for the owner to choose a photo with the buttons' },
      note: list.length === 1 ? `Choose your photo for ${list[0].label} with the button below` : 'Choose your photos with the buttons below',
      buttons,
    };
  },
});

// ───────────── listing images ─────────────

interface ShotPlan {
  make: ListingShot[];
  skipped: { shot: ListingShotId; label: string; why: string }[];
}

/** Which shots to make: your own photos stay unless asked, and a Manus image still on its way isn't started twice. */
function shotPlan(p: Project, a: { shots?: ListingShotId[]; replaceOwn?: boolean }): ShotPlan {
  const wanted = a.shots ?? ALL_SHOTS;
  const plan: ShotPlan = { make: [], skipped: [] };
  for (const shot of listingShots(p).filter((s) => wanted.includes(s.id))) {
    if (pendingManus.get(listingPendingKey(p.id, shot.id))) plan.skipped.push({ shot: shot.id, label: shot.label, why: 'a Manus image for it is still on its way (pick it up on Studio → Listing & publish)' });
    else if (!a.replaceOwn && fromOwnPhoto(listingShotMedia(p, shot.id))) plan.skipped.push({ shot: shot.id, label: shot.label, why: 'it shows the owner’s own photo' });
    else plan.make.push(shot);
  }
  return plan;
}

const imageKind = (kind: 'photo' | 'illustration' | undefined) => kind ?? defaultImageKind();
/** Photos come from Manus here: each is a Manus task, so the owner confirms a card first. */
const manusPhotos = (kind: 'photo' | 'illustration' | undefined) => imageKind(kind) === 'photo' && photoRoute() === 'manus';

/** An image failure in words for the owner (and the Manus task, when there is one). */
function imageFailure(e: unknown): { error: string; task?: string } {
  const m = imageErrorMessage(e);
  return { error: `${m.title}: ${m.body}`, ...(m.taskUrl ? { task: m.taskUrl } : {}) };
}

const makeListingImages = defineTool({
  name: 'make_listing_images',
  class: 'P-media',
  summary: 'Make listing images (default all 4) as photos or illustrations; Manus photos ask first. Shots with the owner’s photo stay unless replaceOwn.',
  args: {
    shots: arg.array(arg.enum(SHOT_IDS), { optional: true, min: 1, max: 4 }),
    kind: arg.enum(['photo', 'illustration'], { optional: true }),
    replaceOwn: arg.boolean({ optional: true }),
  },
  validate: (a) => {
    if (imageKind(a.kind) === 'photo') {
      const av = photoAvailability();
      if (!av.ok) return `${av.reason} Or use kind: illustration.`;
    }
    if (busyWith('Listing images')) return 'Listing images are being made right now (on Studio → Listing & publish, or by me). Wait for them to finish.';
    const plan = shotPlan(activeProject(), a);
    if (plan.make.length) return null;
    const own = plan.skipped.some((s) => s.why.includes('own photo'));
    return `Nothing to make: ${plan.skipped.map((s) => `${s.label} (${s.why})`).join('; ')}.${own ? ' To replace the owner’s photos, ask them, then call again with replaceOwn: true.' : ''}`;
  },
  media: ({ kind }) => (manusPhotos(kind) ? 'manus' : 'image'),
  card: (a) => {
    const plan = shotPlan(activeProject(), a);
    const n = plan.make.length;
    const kept = plan.skipped.length ? ` ${listJoin(plan.skipped.map((s) => s.label))} stay${plan.skipped.length === 1 ? 's' : ''} as ${plan.skipped.length === 1 ? 'it is' : 'they are'}.` : '';
    return manusCard({
      title: n === 1 ? 'Make this listing photo with Manus?' : `Make ${n} listing photos with Manus?`,
      what: `${listJoin(plan.make.map((s) => s.label))}${n > 1 ? ': one Manus task each, one after another' : ''}, from each image’s description.${kept}`,
      cost: `Uses your Manus credits: ${plural(n, 'task')}.`,
      confirmLabel: n === 1 ? 'Make the photo' : `Make ${n} photos`,
    });
  },
  run: async (a, ctx) => {
    const p = activeProject();
    const kind = imageKind(a.kind);
    const { make, skipped } = shotPlan(p, a);
    // photos from an image API come back in seconds, so a set is made at once (Manus tasks and illustrations one by one)
    const parallel = kind === 'photo' && (photoRoute() === 'muse' || photoRoute() === 'server');
    const made: { shot: ListingShotId; label: string; by: string; cover?: true; inGallery?: true }[] = [];
    const failed: { shot: ListingShotId; label: string; error: string; task?: string }[] = [];
    const job = busyId('assistant:listing-images');
    beginBusy(job, 'Listing images', 'app');
    try {
      const one = async (shot: ListingShot, i: number) => {
        const step = make.length > 1 ? `${i + 1} of ${make.length}: ${shot.label}` : shot.label;
        ctx.stage(`Making ${step}…`);
        const r = await makeListingShot({ shot, kind, projectId: ctx.projectId, signal: ctx.signal, onStage: (st) => ctx.stage(`${step} · ${st}`) });
        ctx.ai.push({ task: 'listingImage', label: 'Listing image', provider: r.art.engine, ...(r.art.note ? { note: r.art.note } : {}) });
        made.push({ shot: shot.id, label: shot.label, by: r.art.provider, ...(r.cover ? { cover: true as const } : {}), ...(r.gallery ? { inGallery: true as const } : {}) });
      };
      if (parallel) {
        const results = await Promise.allSettled(make.map(one));
        results.forEach((res, i) => res.status === 'rejected' && !isStop(res.reason) && failed.push({ shot: make[i].id, label: make[i].label, ...imageFailure(res.reason) }));
      } else {
        for (const [i, shot] of make.entries()) {
          if (ctx.signal.aborted) break;
          try {
            await one(shot, i);
          } catch (e) {
            if (isStop(e) || ctx.signal.aborted) break;
            // like the page: the first failure stops the set (a paid try is never repeated by itself)
            failed.push({ shot: shot.id, label: shot.label, ...imageFailure(e) });
            break;
          }
        }
      }
    } finally {
      endBusy(job);
    }
    if (ctx.signal.aborted) throw stopped();
    const notStarted = make.filter((s) => !made.some((m) => m.shot === s.id) && !failed.some((f) => f.shot === s.id)).map((s) => s.label);
    const data = { made, ...(skipped.length ? { skipped } : {}), ...(failed.length ? { failed } : {}), ...(notStarted.length ? { notStarted } : {}), ...(made.length ? { next: 'Publish or update the listing to show them to buyers (publish_listing).' } : {}) };
    if (!made.length) return { ok: false, error: failed[0]?.error ?? 'No image was made.', data };
    const cover = made.some((m) => m.cover);
    return { data, note: `Made ${plural(made.length, 'listing image')}${cover ? ' (one is the listing cover)' : ''}${failed.length ? `; ${failed[0].label} didn’t finish` : ''}` };
  },
});

// ───────────── publishing ─────────────

const publishListing = defineTool({
  name: 'publish_listing',
  class: 'Pub',
  summary: 'Open “Publish listing”, showing exactly what goes public; the owner publishes or updates there.',
  args: {},
  validate: () => {
    const missing = blockingChecks(activeProject());
    return missing.length ? `The listing isn’t ready to publish. Missing: ${listJoin(missing.map((c) => c.label))}. Fill them with update_listing_draft, write_listing_copy or update_studio, or the owner does it on Studio → Listing & publish.` : null;
  },
  window: () => ({ kind: 'listing', action: 'publish' }),
});

const setMarketplaceVisibility = defineTool({
  name: 'set_marketplace_visibility',
  class: 'Pub',
  summary: 'Open a confirm to show (on: true) or hide the owner’s listings to other people on the Marketplace.',
  args: { on: arg.boolean() },
  validate: ({ on }) => {
    if (useRuntime.getState().community !== 'live') return 'The shared Marketplace isn’t on in this view, so only the owner sees their listings: there’s nothing to show or hide.';
    if (useStore.getState().settings.shareToCommunity === on) return on ? 'The owner’s listings are already shown to other people.' : 'The owner’s listings are already hidden from other people.';
    return null;
  },
  window: ({ on }) => ({ kind: 'listing', action: on ? 'show' : 'hide' }),
});

const unpublishListing = defineTool({
  name: 'unpublish_listing',
  class: 'D',
  summary: 'Take the listing off the Marketplace (owner confirms; Studio work stays).',
  args: {},
  validate: () => (liveListing(activeProject()) ? null : 'This project’s listing isn’t on the Marketplace.'),
  danger: () => ({ ...UNPUBLISH_CONFIRM, body: `“${liveListing(activeProject())?.title ?? 'Your listing'}” disappears from the Marketplace. Your Studio work stays intact and you can republish anytime.` }),
  run: (_a, ctx) => {
    if (useStore.getState().activeProjectId !== ctx.projectId) return { ok: false, error: 'The owner switched projects, so nothing was unpublished.' };
    const gone = unpublishProjectListing();
    if (!gone) return { ok: false, error: 'This project’s listing isn’t on the Marketplace any more.' };
    return { data: { unpublished: gone.title }, note: `Unpublished your listing “${clip(gone.title, 60)}”` };
  },
});

// ───────────── structure: outline and chapters (a product), business model (a business) ─────────────

const productOnly = (what: string) => (isBusiness(activeProject()) ? `${what} is for a digital product. This project is a business: it has packages (generate_business_model, update_studio).` : null);
const businessOnly = (what: string) => (isBusiness(activeProject()) ? null : `${what} is for a business. This project is a digital product: it has an outline (generate_outline).`);
const noOutline = () => (activeProject().studio.outline.length ? null : 'There’s no outline yet. Write one first with generate_outline.');
const outlineBusy = () => (busyWith(outlineTask.label, 'PDF') ? 'The outline or a PDF is being made right now. Wait for it to finish.' : null);

const generateOutline = defineTool({
  name: 'generate_outline',
  class: 'P-text',
  summary: 'AI writes the product outline (1 AI request). Existing outline and drafts: replace: true after asking the owner.',
  args: { replace: arg.boolean({ optional: true }) },
  validate: ({ replace }) => productOnly('An outline') ?? outlineBusy() ?? (activeProject().studio.outline.length && !replace ? 'There is already an outline (with any chapter drafts). Ask the owner, then call again with replace: true.' : null),
  run: async (_a, ctx) => {
    const r = await runAITask(outlineTask, {}, ctx);
    applyOutline(r.data, ctx.projectId);
    return {
      data: { label: r.data.label, sections: r.data.sections.map((s) => ({ id: s.id, title: s.title, items: s.items.map((it) => ({ id: it.id, title: clip(it.title, 80) })) })) },
      note: `Wrote a ${r.data.sections.length}-section outline`,
    };
  },
});

const words = (text: string | undefined) => (text ?? '').split(/\s+/).filter(Boolean).length;

const getOutline = defineTool({
  name: 'get_outline',
  class: 'R',
  summary: 'The product outline with section and item ids, item details and drafts (word counts); one section in full with sectionId.',
  args: { sectionId: arg.string({ optional: true, max: 60 }) },
  validate: ({ sectionId }) => productOnly('An outline') ?? noOutline() ?? (sectionId && !activeProject().studio.outline.some((s) => s.id === sectionId) ? `There’s no section with id "${sectionId}".` : null),
  run: ({ sectionId }) => {
    const s = activeProject().studio;
    if (sectionId) {
      const sec = s.outline.find((x) => x.id === sectionId)!;
      return { data: { id: sec.id, title: sec.title, summary: sec.summary || null, items: sec.items.map((it) => ({ id: it.id, title: it.title, meta: it.meta || undefined, detail: clip(it.detail, 300) || undefined })), draft: sec.draft ? clip(sec.draft, 2400) : null }, note: `Read “${clip(sec.title, 60)}”` };
    }
    return {
      data: { label: s.outlineLabel, sections: s.outline.map((sec) => ({ id: sec.id, title: sec.title, draftWords: words(sec.draft), items: sec.items.map((it) => ({ id: it.id, title: clip(it.title, 70), ...(it.detail?.trim() ? { detailed: true } : {}) })) })) },
      note: `Read your outline: ${plural(s.outline.length, 'section')}`,
    };
  },
});

/** Sections by id, in outline order. */
const sectionsOf = (p: Project, ids: string[]) => p.studio.outline.filter((s) => ids.includes(s.id));

const draftSection = defineTool({
  name: 'draft_section',
  class: 'P-text',
  summary: 'AI drafts outline sections (1 AI request each; 4+ ask on a card). Existing drafts: replace: true after asking.',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 12, desc: 'section ids' }), replace: arg.boolean({ optional: true }) },
  validate: ({ ids, replace }) => {
    const p = activeProject();
    const problem = productOnly('Drafting chapters') ?? noOutline() ?? (busyWith(sectionDraftTask.label, 'PDF') ? 'A section draft or a PDF is being written right now. Wait for it to finish.' : null);
    if (problem) return problem;
    const missing = ids.find((id) => !p.studio.outline.some((s) => s.id === id));
    if (missing) return `There’s no section with id "${missing}". get_outline lists them.`;
    const drafted = sectionsOf(p, ids).filter((s) => s.draft?.trim());
    return drafted.length && !replace ? `${listJoin(drafted.map((s) => `“${s.title}”`))} already ${drafted.length === 1 ? 'has a draft' : 'have drafts'}. Ask the owner, then call again with replace: true (or leave ${drafted.length === 1 ? 'it' : 'them'} out).` : null;
  },
  card: ({ ids }) => {
    const n = new Set(ids).size;
    return n < MANY_REQUESTS ? null : { title: `Write ${n} chapter drafts?`, what: `Full drafts of ${listJoin(sectionsOf(activeProject(), ids).map((s) => `“${clip(s.title, 40)}”`))}, one after another.`, who: writer(['product']), cost: requestCost(n), confirmLabel: `Write ${n} drafts` };
  },
  run: async ({ ids }, ctx) => {
    const drafted: { id: string; title: string; words: number }[] = [];
    const list = sectionsOf(activeProject(), ids);
    for (const [i, s] of list.entries()) {
      // the section as it is now (the owner may have edited it meanwhile)
      const sec = projectById(ctx.projectId)?.studio.outline.find((x) => x.id === s.id);
      if (!sec) continue;
      ctx.stage(`Writing ${list.length > 1 ? `${i + 1} of ${list.length}: ` : ''}${clip(sec.title, 50)}…`);
      const r = await runAITask(sectionDraftTask, { section: sec }, ctx);
      applySectionDraft(sec.id, r.data.markdown, ctx.projectId);
      drafted.push({ id: sec.id, title: sec.title, words: words(r.data.markdown) });
    }
    return { data: { drafted }, note: drafted.length === 1 ? `Drafted “${clip(drafted[0].title, 60)}”` : `Drafted ${drafted.length} sections` };
  },
});

const expandItem = defineTool({
  name: 'expand_item',
  class: 'P-text',
  summary: 'AI adds talking points to outline items: named ones, else those without (1 request each; 4+ ask on a card). Existing: replace: true.',
  args: {
    sectionId: arg.string({ max: 60 }),
    itemIds: arg.array(arg.string({ max: 60 }), { optional: true, min: 1, max: 10 }),
    replace: arg.boolean({ optional: true }),
  },
  validate: ({ sectionId, itemIds, replace }) => {
    const problem = productOnly('Expanding outline items') ?? noOutline();
    if (problem) return problem;
    const sec = activeProject().studio.outline.find((s) => s.id === sectionId);
    if (!sec) return `There’s no section with id "${sectionId}". get_outline lists them.`;
    if (busyWith(expandItemTask.label)) return 'An outline item is being expanded right now. Wait for it to finish.';
    const missing = itemIds?.find((id) => !sec.items.some((it) => it.id === id));
    if (missing) return `“${sec.title}” has no item with id "${missing}". get_outline lists the items.`;
    if (!itemIds) return sec.items.some((it) => !it.detail?.trim()) ? null : `Every item in “${sec.title}” already has details. Name the items (itemIds) with replace: true to rewrite them (ask the owner first).`;
    const detailed = sec.items.filter((it) => itemIds.includes(it.id) && it.detail?.trim());
    return detailed.length && !replace ? `${listJoin(detailed.map((it) => `“${clip(it.title, 40)}”`))} already ${detailed.length === 1 ? 'has' : 'have'} details. Ask the owner, then call again with replace: true.` : null;
  },
  card: ({ sectionId, itemIds }) => {
    const sec = activeProject().studio.outline.find((s) => s.id === sectionId);
    const n = itemIds ? new Set(itemIds).size : sec?.items.filter((it) => !it.detail?.trim()).length ?? 0;
    return n < MANY_REQUESTS ? null : { title: `Expand ${n} outline items?`, what: `Talking points, an example and the deliverable for ${n} items in “${clip(sec?.title, 50)}”, one after another.`, who: writer(['product']), cost: requestCost(n), confirmLabel: `Expand ${n} items` };
  },
  run: async ({ sectionId, itemIds }, ctx) => {
    const start = activeProject().studio.outline.find((s) => s.id === sectionId)!;
    const ids = itemIds ? start.items.filter((it) => itemIds.includes(it.id)).map((it) => it.id) : start.items.filter((it) => !it.detail?.trim()).map((it) => it.id);
    const expanded: { id: string; title: string; detail: string }[] = [];
    for (const [i, id] of ids.entries()) {
      const sec = projectById(ctx.projectId)?.studio.outline.find((s) => s.id === sectionId);
      const item = sec?.items.find((it) => it.id === id);
      if (!sec || !item) continue;
      ctx.stage(`Expanding ${ids.length > 1 ? `${i + 1} of ${ids.length}: ` : ''}${clip(item.title, 50)}…`);
      const r = await runAITask(expandItemTask, { item, section: sec }, ctx);
      applyItemDetail(sec.id, item.id, r.data.detail, ctx.projectId);
      expanded.push({ id: item.id, title: item.title, detail: clip(r.data.detail, 200) });
    }
    return { data: { section: start.title, expanded }, note: expanded.length === 1 ? `Expanded “${clip(expanded[0].title, 60)}”` : `Expanded ${expanded.length} items in “${clip(start.title, 50)}”` };
  },
});

const generateBusinessModel = defineTool({
  name: 'generate_business_model',
  class: 'P-text',
  summary: 'AI writes 3 packages with suggested prices, an operating model and a value stack (1 AI request). Existing: replace: true after asking.',
  args: { replace: arg.boolean({ optional: true }) },
  validate: ({ replace }) =>
    businessOnly('A business model') ??
    (busyWith(businessModelTask.label) ? 'The business model is being written on the Studio page right now. Wait for it to finish.' : null) ??
    (activeProject().studio.packages.length && !replace ? 'There are already packages, an operating model and a value stack. Ask the owner, then call again with replace: true.' : null),
  run: async (_a, ctx) => {
    const r = await runAITask(businessModelTask, {}, ctx);
    applyBusinessModel(r.data, ctx.projectId);
    const s = projectById(ctx.projectId)!.studio;
    return {
      data: {
        packages: s.packages.map((pk) => ({ id: pk.id, name: pk.name, price: packagePriceText(pk), includes: pk.includes.slice(0, 5).map((x) => clip(x, 80)) })),
        operating: s.operating.map((b) => b.title),
        valueStack: s.valueStack.map((v) => v.title),
        prices: 'Suggested starting prices for the owner to set to their own; bonus values and any guarantee are theirs to add.',
      },
      note: `Wrote ${plural(s.packages.length, 'package')} (suggested prices: set your own), an operating model and a value stack`,
    };
  },
});

const downloadOutline = defineTool({
  name: 'download_outline',
  class: 'R',
  summary: 'Download (.md) and copy buttons: the outline with drafts, or a business’s model.',
  args: {},
  validate: () => {
    const p = activeProject();
    if (isBusiness(p)) return p.studio.packages.length ? null : 'There’s no business model yet: generate_business_model writes one.';
    return p.studio.outline.length ? null : 'There’s no outline yet: generate_outline writes one.';
  },
  run: (_a, ctx) => {
    const p = activeProject();
    const biz = isBusiness(p);
    const name = biz ? `${slugify(p.brand.name) || 'business'}-business-model.md` : `${slugify(p.idea?.title ?? p.brand.name) || 'product'}-outline.md`;
    const text = () => {
      const now = projectById(ctx.projectId) ?? p;
      return biz ? businessMarkdown(now) : outlineMarkdown(now);
    };
    return {
      data: { file: name, ...(biz ? { packages: p.studio.packages.length } : { sections: p.studio.outline.length, drafted: p.studio.outline.filter((s) => s.draft?.trim()).length }) },
      note: biz ? 'Your business model is ready to download' : 'Your outline is ready to download',
      buttons: [downloadButton(`Download ${name}`, name, text), copyButton('Copy as text', text)],
    };
  },
});

// ───────────── product files ─────────────

/** The PDF and Excel builders (pdf-lib, the workbook writer) load when a file tool runs, not when the chat opens. */
const productFiles = () => import('../../productFiles');

const fileSummary = (f: ProductFile) => ({ id: f.id, kind: f.kind, name: f.name, ...(f.pages ? { pages: f.pages } : {}), ...(f.sheets ? { tabs: f.sheets.length } : {}), size: fmtBytes(f.size), writtenBy: f.engine === 'local' ? 'built-in engine' : 'your AI' });
/** A download button for a product file (call it after productFiles() has loaded, so the click saves at once). */
const fileButtonFor = (f: ProductFile): ChatButton => ({
  label: `Download ${f.name}`,
  icon: 'download',
  run: async () => {
    await (await productFiles()).downloadProductFile(f);
  },
});
const findFile = (id: string) => activeProject().studio.productFiles?.find((f) => f.id === id);
const filesBusy = () => (busyWith('PDF', 'Spreadsheet') ? 'A product file is being built right now. Wait for it to finish.' : null);
const filesNeed = () => productOnly('Product files') ?? (activeProject().studio.outline.length ? null : 'There’s no outline yet: the files are built from it. Write one first with generate_outline.');

/** The AI requests a PDF build makes: one per chapter without a draft (when the AI writes them), plus one. */
const pdfRequests = (p: Project, draftMissing = true) => (draftMissing ? p.studio.outline.filter((s) => !s.draft?.trim()).length : 0) + 1;

const buildPdf = defineTool({
  name: 'build_pdf',
  class: 'P-text',
  summary: 'Build the designed PDF from the outline; AI first drafts chapters without one (1 request each, +1). Asks on a card first.',
  args: {
    theme: arg.enum(['modern', 'classic'], { optional: true }),
    pageSize: arg.enum(['letter', 'a4'], { optional: true }),
    workbookPages: arg.boolean({ optional: true }),
    useCover: arg.boolean({ optional: true }),
    draftMissing: arg.boolean({ optional: true }),
  },
  validate: () => filesNeed() ?? filesBusy() ?? (busyWith(sectionDraftTask.label, outlineTask.label) ? 'The outline or a chapter draft is being written right now. Wait for it to finish.' : null),
  card: (a): ConfirmCardSpec => {
    const p = activeProject();
    const missing = a.draftMissing === false ? 0 : p.studio.outline.filter((s) => !s.draft?.trim()).length;
    const kind = FORMATS[p.format ?? 'pdf']?.short.toLowerCase() ?? 'guide';
    return {
      title: 'Build the PDF?',
      what: `A designed ${kind} PDF from your ${plural(p.studio.outline.length, 'chapter')}${missing ? `; first your AI writes the ${plural(missing, 'chapter')} that ${missing === 1 ? 'has' : 'have'} no draft yet` : ''}, then the welcome page, workbook pages and next steps. It takes a few minutes.`,
      who: writer(missing ? ['product', 'files'] : ['files']),
      cost: requestCost(pdfRequests(p, a.draftMissing !== false)),
      confirmLabel: 'Build the PDF',
    };
  },
  run: async (a, ctx) => {
    const p = activeProject();
    const workbookPages = a.workbookPages ?? true;
    const job = busyId('assistant:pdf');
    beginBusy(job, 'PDF', 'app');
    try {
      const { coverMedia, createEbookFile } = await productFiles();
      const r = await createEbookFile(
        { theme: a.theme ?? 'modern', pageSize: a.pageSize ?? 'letter', workbookPages, fillable: workbookPages, useCover: (a.useCover ?? true) && !!coverMedia(p), draftMissing: a.draftMissing ?? true, reuseCopy: false },
        { signal: ctx.signal, onStage: ctx.stage, projectId: ctx.projectId },
      );
      ctx.ai.push({ task: 'ebookExtras', label: 'Product file', provider: r.file.engine, ...(r.notes[0] ? { note: r.notes[0] } : {}) });
      return {
        data: { file: fileSummary(r.file), chaptersWritten: r.drafted, ...(r.notes.length ? { notes: r.notes.slice(0, 3).map((n) => clip(n, 200)) } : {}) },
        note: `Built ${r.file.name}: ${plural(r.file.pages ?? 0, 'page')}${r.drafted ? `, ${plural(r.drafted, 'chapter')} written` : ''}`,
        buttons: [fileButtonFor(r.file)],
      };
    } finally {
      endBusy(job);
    }
  },
});

const buildWorkbook = defineTool({
  name: 'build_workbook',
  class: 'P-text',
  summary: 'Build the Excel workbook from the outline; AI designs it (1 request, asks on a card first). Without redesign, a saved design is reused.',
  args: { redesign: arg.boolean({ optional: true }) },
  validate: () => filesNeed() ?? filesBusy(),
  card: ({ redesign }) => {
    const p = activeProject();
    const design = !p.studio.workbook || redesign === true;
    if (!design) return null;
    return {
      title: p.studio.workbook ? 'Redesign the workbook?' : 'Design the workbook?',
      what: `An Excel workbook your AI designs from your ${plural(p.studio.outline.length, 'section')}: tabs, dropdowns, formulas and a dashboard. It opens in Excel, Google Sheets and Numbers.`,
      who: writer(['files']),
      cost: requestCost(1),
      confirmLabel: p.studio.workbook ? 'Redesign it' : 'Design it',
    };
  },
  run: async ({ redesign }, ctx) => {
    const p = activeProject();
    const design = !p.studio.workbook || redesign === true;
    const job = busyId('assistant:xlsx');
    beginBusy(job, 'Spreadsheet', 'app');
    try {
      const { createWorkbookFile } = await productFiles();
      const r = await createWorkbookFile({ redesign: design }, { signal: ctx.signal, onStage: ctx.stage, projectId: ctx.projectId });
      if (design) ctx.ai.push({ task: 'workbook', label: 'Spreadsheet product', provider: r.file.engine, ...(r.notes[0] ? { note: r.notes[0] } : {}) });
      return {
        data: { file: fileSummary(r.file), tabs: r.summary.sheets.map((s) => s.name), formulas: r.summary.formulas, ...(r.notes.length ? { notes: r.notes.slice(0, 3).map((n) => clip(n, 200)) } : {}), designedNow: design },
        note: `Built ${r.file.name}: ${plural(r.summary.sheets.length, 'tab')} and a dashboard`,
        buttons: [fileButtonFor(r.file)],
      };
    } finally {
      endBusy(job);
    }
  },
});

const downloadProductFileTool = defineTool({
  name: 'download_product_file',
  class: 'R',
  summary: 'Download buttons for product files (default: the newest PDF and workbook).',
  args: { ids: arg.array(arg.string({ max: 60 }), { optional: true, min: 1, max: 6 }) },
  validate: ({ ids }) => {
    const files = activeProject().studio.productFiles ?? [];
    if (!files.length) return 'There are no product files yet: build_pdf or build_workbook makes one.';
    const missing = ids?.find((id) => !findFile(id));
    return missing ? `There’s no product file with id "${missing}". get_project with section offer lists them.` : null;
  },
  run: async ({ ids }) => {
    // ready before the owner clicks, so the save happens on the click itself
    await productFiles();
    const files = activeProject().studio.productFiles ?? [];
    const list = ids ? files.filter((f) => ids.includes(f.id)) : (['pdf', 'xlsx'] as const).map((k) => files.find((f) => f.kind === k)).filter((f): f is ProductFile => !!f);
    return { data: { files: list.map(fileSummary) }, note: list.length === 1 ? `${list[0].name} is ready to download` : `${list.length} files are ready to download`, buttons: list.map(fileButtonFor) };
  },
});

const deleteProductFileTool = defineTool({
  name: 'delete_product_file',
  class: 'D',
  summary: 'Delete product files (owner confirms; downloaded copies stay).',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 12 }) },
  validate: ({ ids }) => {
    const missing = ids.find((id) => !findFile(id));
    return missing ? `There’s no product file with id "${missing}". get_project with section offer lists them.` : null;
  },
  danger: ({ ids }) => deleteConfirm({ thing: 'file', names: ids.map((id) => findFile(id)!.name), extra: 'Copies you downloaded stay where you saved them.' }),
  run: async ({ ids }) => {
    const { deleteProductFile } = await productFiles();
    const names = ids.map((id) => findFile(id)?.name).filter(Boolean);
    for (const id of ids) if (findFile(id)) await deleteProductFile(id);
    return { data: { deleted: names.length }, note: names.length === 1 ? `Deleted ${names[0]}` : `Deleted ${names.length} files` };
  },
});

export const studioTools: AnyTool[] = [
  getListing,
  updateStudio,
  updateListingDraft,
  writeListingCopy,
  openListing,
  uploadListingPhoto,
  makeListingImages,
  publishListing,
  setMarketplaceVisibility,
  unpublishListing,
  getOutline,
  generateOutline,
  draftSection,
  expandItem,
  generateBusinessModel,
  downloadOutline,
  buildPdf,
  buildWorkbook,
  downloadProductFileTool,
  deleteProductFileTool,
];
