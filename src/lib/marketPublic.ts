// The public marketplace (P7): the client for /api/market (server/market/index.mjs). A listing published in the app can
// also be "Public on the web": the app sends it to the server, which checks it and serves it as its own page at
// <app>/market/<slug> that Google can index. The in-app Marketplace (market_listings, signed in only) is unchanged.
//
// - Images go up first as hosted files (POST /api/public-images?use=listing → public-files/<uid>/l-<random>.<ext>):
//   the payload carries only their paths, never a data URL.
// - Only what the public page shows is sent: no email, no map coordinates.
// - The server's limits and refusals come back in its own words (plan limit, hidden by the owner, paused plan).
// - None of this is in the claude.ai build: every call refuses there before any request, and the config says "off".

import quality from '../../shared/marketQuality.json';
import type { Listing, MediaRef, Project } from './types';
import { serverFetch } from '@/ai/claude';
import { serverBaseNow, useAuth } from '@/lib/cloud/auth';
import { SLUG_RE } from './marketConfig';
import { getBlob } from '@/lib/storage';
import { loadImage } from '@/lib/imageCanvas';
import { readFileAsDataURL } from '@/lib/utils';
import { uploadPublicImage } from './leadFiles';
import { galleryIds } from './listing';
import { safeUrl } from './listingActions';

export type PublicStatus = 'live' | 'thin' | 'held' | 'unlisted' | 'hidden' | 'over_limit';
export type ReportReason = 'spam' | 'scam' | 'prohibited' | 'offensive' | 'misleading' | 'other';

/** A listing's public page as the server describes it to its seller. */
export interface PublicListingState {
  listingId: string;
  projectId: string;
  slug: string;
  /** <app>/market/<slug> */
  url: string;
  status: PublicStatus;
  /** shown on Google (status live) */
  indexable: boolean;
  /** what keeps it off Google: keys of shared/marketQuality.json (MISSING_TEXT) */
  missing: string[];
  /** open visitor reports (a count only: never who or what) */
  reportCount: number;
  hiddenReason?: ReportReason;
  publicAt: string | null;
  contentUpdatedAt: string | null;
}

/** What PUT /api/market/public/<listingId> takes: the public page's content, prices in dollars. */
export interface PublicListingInput {
  projectId: string;
  kind: 'product' | 'business';
  title: string;
  tagline: string;
  description: string;
  category: string;
  tags: string[];
  price: number;
  priceModel: string;
  compareAt?: number;
  services?: { name: string; price: number; duration?: string; priceModel?: 'quote' | 'free' }[];
  includes: string[];
  location?: { city: string; region: string; online: boolean };
  sellerName: string;
  website?: string;
  /** a typed outside link, only when there is no offer */
  buyUrl?: string;
  phone?: string;
  /** the attached P3/P6 offer: Buy goes through its /b/ link */
  offerId?: string;
  coverPath?: string;
  galleryPaths: string[];
}

export class MarketError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The reasons a visitor or user can report a listing for, in plain words. */
export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'spam', label: 'Spam or junk' },
  { value: 'scam', label: 'Looks like a scam' },
  { value: 'prohibited', label: 'Something that can’t be sold' },
  { value: 'offensive', label: 'Offensive or hateful' },
  { value: 'misleading', label: 'Misleading or false' },
  { value: 'other', label: 'Something else' },
];
export const reasonLabel = (r: string | undefined): string => REPORT_REASONS.find((x) => x.value === r)?.label ?? 'Other';

/** The server's quality keys (shared with server/market/quality.mjs). */
export const QUALITY_KEYS: readonly string[] = quality.keys;

/** What each quality key asks the seller to do, so Google shows the page. */
export const MISSING_TEXT: Record<string, string> = {
  description_length: `Write at least ${quality.minDescriptionChars} characters (about ${quality.minDescriptionWords} words) so Google sees a full page.`,
  title_caps: 'Write the title in normal case, without long runs of the same letter.',
  cover: 'Choose a cover photo.',
  tags: `Add at least ${quality.minTags} search tags.`,
  action: 'Add a way to buy or reach you: attach payment, or add a buy link, website or phone.',
  price: 'Set a price, or choose “Get a quote” or Free.',
  duplicate: 'Write your own description: this one is the same as another seller’s listing.',
  trial: 'Listings show on Google from your first paid month. Until then the page works but isn’t indexed.',
};
export const missingText = (key: string): string => MISSING_TEXT[key] ?? 'Finish the listing so Google shows it.';

/** What the seller reads about Google, everywhere (sellers never submit anything themselves). */
export const GOOGLE_NOTE = 'Google picks up new listings on its own schedule, usually within days to weeks. Nothing is guaranteed.';

export { marketConfig, marketOn, marketOrigin, SLUG_RE, useMarketConfig, webOf, type MarketConfig } from './marketConfig';

// ───────────── calls ─────────────

const NOT_HERE = 'Public web listings need the app’s own server, so they aren’t available here.';
const here = () => {
  if (__ARTIFACT_BUILD__) throw new MarketError(NOT_HERE, 'NOT_HERE');
};

/** Plain words for refusals whose server sentence isn't for sellers (the server's own words are used otherwise). */
const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Your sign-in has ended. Sign in again, then try once more.',
  FORBIDDEN: 'This request was refused because it didn’t come from the app’s own page.',
  NETWORK: 'Couldn’t reach the server. Check your connection, then try again.',
  NOT_SET_UP: 'Public web listings aren’t set up on this app’s server yet.',
  RATE_LIMIT: 'That’s a lot of changes at once. Wait a minute, then try again.',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function call<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, json?: unknown): Promise<{ status: number; body: T }> {
  here();
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    res = await serverFetch(serverBaseNow(), path, { method, headers, body });
  } catch {
    throw new MarketError(MESSAGES.NETWORK, 'NETWORK');
  }
  const got = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = str(got?.code) || (res.status === 429 ? 'RATE_LIMITED' : res.status === 401 ? 'AUTH_REQUIRED' : `HTTP_${res.status}`);
    const { error: _e, code: _c, hint: _h, ...extra } = got ?? {};
    // the server's sentences are ours (limits, hidden, paused plan…), except these two
    const own = code === 'NOT_SET_UP' || code === 'AUTH_REQUIRED';
    const message = (own ? MESSAGES[code] : '') || str(got?.error) || MESSAGES[code] || `The server couldn’t do that (error ${res.status}). Try again.`;
    throw new MarketError(message, code, res.status, extra);
  }
  return { status: res.status, body: (got ?? {}) as T };
}

const STATUSES: PublicStatus[] = ['live', 'thin', 'held', 'unlisted', 'hidden', 'over_limit'];
const REASONS = REPORT_REASONS.map((r) => r.value);

export function toPublicState(raw: unknown): PublicListingState | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !str(r.listingId) || !SLUG_RE.test(str(r.slug)) || !/^https?:\/\//.test(str(r.url))) return null;
  return {
    listingId: str(r.listingId),
    projectId: str(r.projectId),
    slug: str(r.slug),
    url: str(r.url),
    status: STATUSES.includes(r.status as PublicStatus) ? (r.status as PublicStatus) : 'unlisted',
    indexable: r.indexable === true,
    missing: Array.isArray(r.missing) ? r.missing.filter((m): m is string => typeof m === 'string').slice(0, 12) : [],
    reportCount: typeof r.reportCount === 'number' && r.reportCount > 0 ? Math.floor(r.reportCount) : 0,
    ...(REASONS.includes(r.hiddenReason as ReportReason) ? { hiddenReason: r.hiddenReason as ReportReason } : {}),
    publicAt: str(r.publicAt) || null,
    contentUpdatedAt: str(r.contentUpdatedAt) || null,
  };
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const idPath = (id: string) => {
  if (!ID_RE.test(id)) throw new MarketError('That listing can’t be found.', 'BAD_ID');
  return id;
};

/** Your public listings (one business's, or all), with your plan's limit (null: unlimited) and how many are on. */
export async function fetchPublicListings(projectId?: string): Promise<{ listings: PublicListingState[]; limit: number | null; used: number }> {
  const { body } = await call<{ listings?: unknown; limit?: unknown; used?: unknown }>('GET', `/api/market/public${projectId ? `?projectId=${encodeURIComponent(idPath(projectId))}` : ''}`);
  return {
    listings: (Array.isArray(body.listings) ? body.listings : []).map(toPublicState).filter((x): x is PublicListingState => !!x),
    limit: typeof body.limit === 'number' && body.limit >= 0 ? body.limit : null,
    used: typeof body.used === 'number' && body.used >= 0 ? body.used : 0,
  };
}

/** Put a listing on the web, or update its page. created: the first time. */
export async function setListingPublic(listingId: string, input: PublicListingInput): Promise<{ listing: PublicListingState; created: boolean }> {
  const { status, body } = await call<{ listing?: unknown }>('PUT', `/api/market/public/${idPath(listingId)}`, input);
  const listing = toPublicState(body.listing);
  if (!listing) throw new MarketError('The server’s answer couldn’t be read. Try again.', 'BAD_ANSWER');
  return { listing, created: status === 201 };
}

/** Take a listing off the web: its address answers "gone" and Google drops it. Already off counts as done. */
export async function unlistPublic(listingId: string): Promise<void> {
  await call('DELETE', `/api/market/public/${idPath(listingId)}`);
}

/** Report another seller's public listing to the app's owner. */
export async function reportListing(slug: string, reason: ReportReason, note = ''): Promise<void> {
  if (!SLUG_RE.test(slug)) throw new MarketError('That listing isn’t on the web.', 'NOT_FOUND');
  await call('POST', '/api/market/reports', { slug, reason, ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}) });
}

// ───────────── owner moderation ─────────────

export interface AdminListingRef {
  id: string;
  slug: string;
  title: string;
  seller_name: string;
  status?: string;
}
export interface MarketAdmin {
  reports: { id: string; reason: string; note: string; from: string; at: string; listing: AdminListingRef | null }[];
  held: (AdminListingRef & { report_count?: number; held_at?: string })[];
  hidden: (AdminListingRef & { hidden_reason?: string; hidden_at?: string })[];
  submit: { lastAt: string | null; outcome: string | null; changedSince: boolean; property: boolean };
  /** the treg owner alert, when there is one */
  alert: string | null;
}
export type SubmitOutcome = { outcome: 'ok' | 'failed' | 'unknown' | 'skipped'; alreadySubmittedAt?: string; reason?: string };

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const alertText = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === 'string') return v;
  const o = v as Record<string, unknown>;
  return str(o.message) || str(o.text) || str(o.kind) || 'The Search Console connection needs attention.';
};

export async function fetchMarketAdmin(): Promise<MarketAdmin> {
  const { body } = await call<Record<string, unknown>>('GET', '/api/market/admin');
  const s = (body.submit ?? {}) as Record<string, unknown>;
  return {
    reports: arr<MarketAdmin['reports'][number]>(body.reports).map((r) => ({ id: str(r.id), reason: str(r.reason), note: str(r.note), from: str(r.from), at: str(r.at), listing: r.listing ?? null })),
    held: arr(body.held),
    hidden: arr(body.hidden),
    submit: { lastAt: str(s.lastAt) || null, outcome: str(s.outcome) || null, changedSince: s.changedSince === true, property: s.property === true },
    alert: alertText(body.alert),
  };
}
const uuidPath = (id: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new MarketError('That item can’t be found.', 'BAD_ID');
  return id;
};
export const hideListing = async (id: string, reason: ReportReason, note = ''): Promise<void> => void (await call('POST', `/api/market/admin/listings/${uuidPath(id)}/hide`, { reason, ...(note.trim() ? { note: note.trim() } : {}) }));
export const unhideListing = async (id: string): Promise<void> => void (await call('POST', `/api/market/admin/listings/${uuidPath(id)}/unhide`));
export const dismissReport = async (id: string): Promise<void> => void (await call('POST', `/api/market/admin/reports/${uuidPath(id)}/dismiss`));
export async function submitMarketSitemap(): Promise<SubmitOutcome> {
  const { body } = await call<Record<string, unknown>>('POST', '/api/market/admin/submit-sitemap', { confirm: true });
  const o = str(body.outcome);
  return { outcome: o === 'ok' || o === 'failed' || o === 'skipped' ? o : 'unknown', ...(str(body.alreadySubmittedAt) ? { alreadySubmittedAt: str(body.alreadySubmittedAt) } : {}), ...(str(body.reason) ? { reason: str(body.reason) } : {}) };
}

// ───────────── hosted images and the payload ─────────────

/** [longest side, quality]: a sharp public image under 1.5 MB. */
export const WEB_IMAGE_STEPS: readonly (readonly [number, number])[] = [
  [1600, 0.85],
  [1280, 0.8],
  [1024, 0.75],
];
export const WEB_IMAGE_BYTES = 1.5 * 1024 * 1024;

/** One stored image as a WebP (or JPEG where the browser can't write WebP), long edge ≤ 1600 px, under 1.5 MB. */
async function encodeForWeb(blob: Blob): Promise<{ blob: Blob; name: string } | null> {
  const img = await loadImage(await readFileAsDataURL(blob));
  for (const [max, q] of WEB_IMAGE_STEPS) {
    const scale = Math.min(1, max / Math.max(img.width, img.height, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const toBlob = (type: string) => new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, q));
    let out = await toBlob('image/webp');
    let name = 'listing.webp';
    if (!out || out.type !== 'image/webp') {
      out = await toBlob('image/jpeg');
      name = 'listing.jpg';
    }
    if (out && out.size <= WEB_IMAGE_BYTES) return { blob: out, name };
  }
  return null;
}

export interface WebImageDeps {
  /** the stored image's bytes */
  read: (media: MediaRef) => Promise<Blob | null | undefined>;
  /** the bytes made web-sized (null: couldn't) */
  encode: (blob: Blob) => Promise<{ blob: Blob; name: string } | null>;
  /** POST /api/public-images?use=listing → { path } */
  upload: (blob: Blob, name: string) => Promise<{ path: string }>;
  /** the signed-in user's id: a cached path under anyone else's folder is uploaded again */
  uid: string;
}
const defaultDeps = (): WebImageDeps => ({
  read: (m) => getBlob(m.id),
  encode: encodeForWeb,
  upload: (blob, name) => uploadPublicImage(blob, name, undefined, 'listing'),
  uid: useAuth.getState().user?.id ?? '',
});

/** The cache key of a source image: its id and size (a changed image is a new upload). */
export const webImageKey = (m: MediaRef): string => `${m.id}:${m.size}`;
const LISTING_PATH = /^[0-9a-f-]{36}\/l-[A-Za-z0-9_-]{22}\.(jpg|png|webp|gif)$/;

/**
 * The listing's cover and gallery as hosted public images: each uploaded once (the paths are cached in
 * p.studio.listing.webImages by source image), only the seller's own listing images. fresh: upload them all again
 * (the server said one is gone). → the paths, and the cache to keep.
 */
export async function publicImagesFor(p: Project, opts: { fresh?: boolean; deps?: Partial<WebImageDeps> } = {}): Promise<{ coverPath?: string; galleryPaths: string[]; cache: Record<string, string> }> {
  here();
  const deps = { ...defaultDeps(), ...opts.deps };
  const before = opts.fresh ? {} : (p.studio.listing.webImages ?? {});
  const cache: Record<string, string> = {};
  const pathOf = async (id: string | undefined): Promise<string | undefined> => {
    const media = id ? p.brand.images.find((m) => m.id === id && m.kind === 'image') : undefined;
    if (!media) return undefined;
    const key = webImageKey(media);
    const had = before[key];
    if (had && LISTING_PATH.test(had) && had.startsWith(`${deps.uid}/`)) {
      cache[key] = had;
      return had;
    }
    const blob = await deps.read(media);
    if (!blob) return undefined;
    const web = await deps.encode(blob).catch(() => null);
    if (!web) return undefined;
    const { path } = await deps.upload(web.blob, web.name);
    if (!LISTING_PATH.test(path)) throw new MarketError('The server’s answer couldn’t be read. Try again.', 'BAD_ANSWER');
    cache[key] = path;
    return path;
  };
  const coverPath = await pathOf(p.studio.listing.coverImageId);
  const galleryPaths: string[] = [];
  for (const id of galleryIds(p)) {
    const path = await pathOf(id);
    if (path && path !== coverPath && !galleryPaths.includes(path)) galleryPaths.push(path);
  }
  return { ...(coverPath ? { coverPath } : {}), galleryPaths: galleryPaths.slice(0, 3), cache };
}

/** A phone number the server keeps (server/market/validate.mjs safePhone): 6–15 digits, only phone characters. */
const serverPhone = (raw: string | undefined): string | undefined => {
  const t = (raw ?? '').trim();
  if (!t || t.length > 32 || !/^[0-9+().\-\s]+$/.test(t)) return undefined;
  const digits = t.replace(/\D/g, '').length;
  return digits >= 6 && digits <= 15 ? t : undefined;
};
/** An https address (the public page links https sites only; others are left off it). */
const httpsUrl = (raw: string | undefined): string | undefined => {
  const u = safeUrl(raw);
  return u && u.startsWith('https://') && u.length <= 300 ? u : undefined;
};

/**
 * The public page's content from the published listing and its hosted images: no data URLs, no email, no
 * coordinates; an offer's id only when one is attached (and then no typed buy link).
 */
export function publicInput(l: Listing, images: { coverPath?: string; galleryPaths: string[] }): PublicListingInput {
  const offerId = l.offer?.id;
  const loc = l.location;
  return {
    projectId: l.projectId ?? '',
    kind: l.kind === 'business' ? 'business' : 'product',
    title: l.title,
    tagline: l.tagline ?? '',
    description: l.description,
    category: l.category,
    tags: l.tags.slice(0, 10),
    price: l.price,
    priceModel: l.priceModel,
    ...(l.compareAt ? { compareAt: l.compareAt } : {}),
    ...(l.services?.length ? { services: l.services.slice(0, 12).map((s) => ({ name: s.name, price: s.price, ...(s.duration ? { duration: s.duration } : {}), ...(s.priceModel ? { priceModel: s.priceModel } : {}) })) } : {}),
    includes: (l.includes ?? []).slice(0, 8),
    ...(loc ? { location: { city: loc.online ? '' : loc.city, region: loc.online ? '' : loc.region, online: loc.online === true } } : {}),
    sellerName: l.seller.name,
    ...(httpsUrl(l.website) ? { website: httpsUrl(l.website) } : {}),
    ...(!offerId && httpsUrl(l.buyUrl) ? { buyUrl: httpsUrl(l.buyUrl) } : {}),
    ...(serverPhone(l.phone) ? { phone: serverPhone(l.phone) } : {}),
    ...(offerId ? { offerId } : {}),
    ...(images.coverPath ? { coverPath: images.coverPath } : {}),
    galleryPaths: images.galleryPaths,
  };
}

/** The words of a public listing's status, for its seller. */
export function statusLine(s: PublicListingState | undefined): { tone: 'success' | 'warning' | 'danger' | 'neutral'; text: string } | null {
  if (!s) return null;
  switch (s.status) {
    case 'live':
      return { tone: 'success', text: 'On the web' };
    case 'thin':
      return { tone: 'warning', text: 'On the web, not shown on Google yet' };
    case 'held':
      return { tone: 'warning', text: 'Under review after visitor reports' };
    case 'hidden':
      return { tone: 'danger', text: `Hidden by Your Local Business: ${reasonLabel(s.hiddenReason).toLowerCase()}` };
    case 'over_limit':
      return { tone: 'neutral', text: 'Off the web: over your plan’s limit' };
    default:
      return null;
  }
}

/** Whether a listing is on the web now (the toggle's "on"). */
export const isOnWeb = (s: PublicListingState | undefined): boolean => !!s && (s.status === 'live' || s.status === 'thin' || s.status === 'held');

export const limitText = (limit: number): string => `Your plan includes ${limit} public listing${limit === 1 ? '' : 's'}. Upgrade or turn one off.`;
