// The public marketplace's input rules (P7): what a seller's "Public on the web" sends (PUT /api/market/public/<id>)
// becomes one public_listings row, or a refusal in plain words. Nothing here reads the database: the caller hands in
// the seller's offer (offerOf) and the names in their public-files folder (imagesOf).
//
// - Text is normalized (NFC; control, zero-width and bidi-override characters out; spaces collapsed; capped) and stored
//   as typed: never HTML-decoded or stripped. It is escaped every time it is shown (server/market/render.mjs).
// - Links are https only, with a real host (no IP, no credentials, no localhost or .local), at most 300 characters.
//   A description holds at most 2 web addresses (shown as text, never made links).
// - Images are the seller's own hosted files, public-files/<uid>/l-<22>.<ext>, that exist in Storage. A data: URL
//   anywhere in the body is refused (IMAGE_NOT_HOSTED).
// - An offer must be the seller's own, not a draft and not archived. A Stripe offer's price and currency win over the
//   typed price (the JSON-LD price is the real checkout amount).
// - The location keeps city, region and online only: coordinates are dropped.

import crypto from 'node:crypto';
import { fail } from '../integrations/common.mjs';

export const PRICE_MODELS = Object.freeze(['one-time', 'monthly', 'yearly', 'per-session', 'project', 'quote', 'free']);
export const REPORT_REASONS = Object.freeze(['spam', 'scam', 'prohibited', 'offensive', 'misleading', 'other']);
export const LISTING_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const OFFER_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
export const CATEGORY_SLUG_RE = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,58}[a-z0-9])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_NAME_RE = /^l-[A-Za-z0-9_-]{22}\.(jpg|png|webp|gif)$/;
const MAX_MONEY = 1_000_000;
const MAX_LINKS_IN_DESCRIPTION = 2;

/** Control characters (newlines are handled by the caller), zero-width characters and bidi overrides. */
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
const INVISIBLE = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]/g;

/**
 * Text as it is stored: a string, NFC, without control, zero-width or bidi-override characters, spaces collapsed and
 * trimmed. multiline keeps line breaks (at most one blank line in a row). Over `max` characters (or not text) throws
 * 400 BAD_REQUEST naming the field. Never decodes or strips HTML.
 */
export function normalizeText(value, max, { what = 'This', multiline = false, required = false, min = 0 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max * 6) throw fail(400, 'BAD_REQUEST', `${what} must be text, at most ${max} characters.`);
  let s = value.normalize('NFC').replace(INVISIBLE, '');
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
  if (multiline) {
    s = s
      .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
      .replace(CONTROL, ' ')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else s = s.replace(/[\n\r]/g, ' ').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const n = Array.from(s).length;
  if (n > max) throw fail(400, 'BAD_REQUEST', `${what} can be at most ${max} characters.`);
  if ((required || min) && n < Math.max(1, min)) throw fail(400, 'BAD_REQUEST', min > 1 ? `${what} needs at least ${min} characters.` : `${what} is required.`);
  return s;
}

/** A host that is an address, not a name: IPv4, IPv6 (bracketed), or a bare number. */
const isIpHost = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);

/**
 * A link a visitor may follow: https only, a host with a dot, no IP literal, no user name or password, not localhost or
 * .local, at most 300 characters. → the normalized href, null for empty, or throws 400 BAD_URL.
 */
export function safeHttpsUrl(value, what = 'The link') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 300) throw fail(400, 'BAD_URL', `${what} must be a web address of at most 300 characters.`);
  const raw = value.trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw fail(400, 'BAD_URL', `${what} must be a full web address starting with https://.`);
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || !host.includes('.') || isIpHost(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || u.port) {
    throw fail(400, 'BAD_URL', `${what} must be a full web address starting with https://, without a user name, password or port.`);
  }
  const href = u.href;
  if (href.length > 300) throw fail(400, 'BAD_URL', `${what} can be at most 300 characters.`);
  return href;
}

/** How many web addresses a text holds (http(s)://…, www.…, or a bare name.tld/path). */
export function countUrls(text) {
  const s = String(text ?? '');
  const found = s.match(/\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|shop|store|biz|info|app|dev|me|us|uk|ca|xyz|site|online|link|ly)\b(?:\/[^\s<>"']*)?/gi);
  return found ? found.length : 0;
}

/** A phone number as people type it (src/lib/listingActions.ts safePhone): 6–15 digits. → the trimmed label, or null. */
export function safePhone(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (t.length > 32 || !/^[0-9+().\-\s]+$/.test(t)) return null;
  const digits = t.replace(/\D/g, '').length;
  return digits >= 6 && digits <= 15 ? t.replace(/\s+/g, ' ') : null;
}

/** ASCII-folded words: NFKD, combining marks out, lower case, everything else a hyphen. */
function fold(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A category's address part (the server derives it from the category's name). */
export function categorySlug(category) {
  const s = fold(category).slice(0, 60).replace(/-+$/g, '');
  return CATEGORY_SLUG_RE.test(s) ? s : 'other';
}

/**
 * A new listing address: up to 6 words of the title, folded, at most 50 characters, then '-' and 6 random base36
 * characters. Set once and never changed (old links keep working).
 */
export function slugFor(title, random = crypto.randomBytes) {
  const words = fold(title).split('-').filter(Boolean).slice(0, 6).join('-').slice(0, 50).replace(/-+$/g, '');
  const bytes = random(6);
  const suffix = Array.from(bytes, (b) => (b % 36).toString(36)).join('');
  const slug = `${words || 'listing'}-${suffix}`;
  return SLUG_RE.test(slug) ? slug : `listing-${suffix}`;
}

/** Dollars (the app's Listing.price) → minor units; NaN, negative or over 1,000,000 throws 400. null stays null. */
export function toMinor(value, what = 'The price') {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw fail(400, 'BAD_REQUEST', `${what} must be a number from 0 to ${MAX_MONEY.toLocaleString('en-US')}.`);
  return Math.round(n * 100);
}

/** Whether any string anywhere in a value is a data: URL (depth-limited). */
function hasDataUrl(value, depth = 0) {
  if (typeof value === 'string') return /^\s*data:/i.test(value);
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  return (Array.isArray(value) ? value : Object.values(value)).some((v) => hasDataUrl(v, depth + 1));
}

/** The rule an image path must follow for this seller: <uid>/l-<22>.<ext>. */
export const ownImagePath = (uid, path) => typeof path === 'string' && path.length <= 120 && path.startsWith(`${uid}/`) && IMAGE_NAME_RE.test(path.slice(uid.length + 1));

/** sha256 of a description, the way the duplicate check compares them (case and spacing folded). */
export const contentHash = (description) =>
  crypto
    .createHash('sha256')
    .update(String(description).toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');

/** The same refusal text the app's checkListingOffer uses. */
export const OFFER_NOT_YOURS = 'That buy link isn’t one of your active offers. Choose another one, or remove it.';

/**
 * PUT's body → the public_listings columns (without slug, status, quality). uid: the server's user id.
 * offerOf(id) → the offer row ({ id, user_id, status, provider, price_minor, currency }) or null.
 * imagesOf() → a Set of the file names in the seller's public-files folder.
 */
export async function validatePublicListing(input, { uid, offerOf, imagesOf }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'BAD_REQUEST', 'Send a JSON object.');
  if (!UUID_RE.test(String(uid))) throw fail(401, 'AUTH_REQUIRED', 'Sign in first.');
  if (hasDataUrl(input)) throw fail(400, 'IMAGE_NOT_HOSTED', 'Images must be uploaded first: data URLs can’t go on a public page.');

  const projectId = String(input.projectId ?? '');
  if (!PROJECT_ID_RE.test(projectId)) throw fail(400, 'BAD_REQUEST', 'Unknown business.');
  const kind = input.kind === 'business' ? 'business' : input.kind === 'product' ? 'product' : null;
  if (!kind) throw fail(400, 'BAD_REQUEST', 'kind must be product or business.');

  const title = normalizeText(input.title, 120, { what: 'The title', min: 4 });
  const tagline = normalizeText(input.tagline, 160, { what: 'The tagline' });
  const description = normalizeText(input.description, 5000, { what: 'The description', multiline: true, min: 80 });
  if (countUrls(description) > MAX_LINKS_IN_DESCRIPTION) throw fail(400, 'TOO_MANY_LINKS', 'Keep links to two or fewer: add your site in Website.');
  const category = normalizeText(input.category, 60, { what: 'The category', required: true });
  const sellerName = normalizeText(input.sellerName, 80, { what: 'The seller name', required: true });

  if (input.tags !== undefined && !Array.isArray(input.tags)) throw fail(400, 'BAD_REQUEST', 'tags must be a list.');
  const tags = [];
  for (const t of (input.tags ?? []).slice(0, 40)) {
    const v = normalizeText(t, 32, { what: 'A tag' }).toLowerCase();
    if (v && !tags.includes(v)) tags.push(v);
  }
  if (tags.length > 10) tags.length = 10;

  if (input.includes !== undefined && !Array.isArray(input.includes)) throw fail(400, 'BAD_REQUEST', 'includes must be a list.');
  if ((input.includes ?? []).length > 8) throw fail(400, 'BAD_REQUEST', 'List at most 8 things it includes.');
  const includes = (input.includes ?? []).map((x) => normalizeText(x, 120, { what: 'An included item' })).filter(Boolean);

  const priceModel = PRICE_MODELS.includes(input.priceModel) ? input.priceModel : null;
  if (!priceModel) throw fail(400, 'BAD_REQUEST', `priceModel must be one of ${PRICE_MODELS.join(', ')}.`);

  if (input.services !== undefined && !Array.isArray(input.services)) throw fail(400, 'BAD_REQUEST', 'services must be a list.');
  if ((input.services ?? []).length > 12) throw fail(400, 'BAD_REQUEST', 'List at most 12 services.');
  const services = (input.services ?? []).map((sv) => {
    if (!sv || typeof sv !== 'object') throw fail(400, 'BAD_REQUEST', 'Each service needs a name.');
    const name = normalizeText(sv.name, 80, { what: 'A service name', required: true });
    const out = { name, priceMinor: toMinor(sv.price ?? 0, 'A service price') };
    const duration = normalizeText(sv.duration, 40, { what: 'A service duration' });
    if (duration) out.duration = duration;
    if (sv.priceModel === 'quote' || sv.priceModel === 'free') out.priceModel = sv.priceModel;
    return out;
  });

  let location = null;
  if (input.location && typeof input.location === 'object') {
    const city = normalizeText(input.location.city, 80, { what: 'The city' });
    const region = normalizeText(input.location.region, 80, { what: 'The region' });
    const online = input.location.online === true;
    if (city || region || online) location = { city, region, online };
  }

  const website = safeHttpsUrl(input.website, 'The website');
  let outsideBuyUrl = safeHttpsUrl(input.buyUrl, 'The buy link');
  let phone = null;
  if (input.phone !== undefined && input.phone !== null && input.phone !== '') {
    phone = safePhone(input.phone);
    if (!phone) throw fail(400, 'BAD_REQUEST', 'That phone number doesn’t look right.');
  }

  let priceMinor = toMinor(input.price);
  const compareAtMinor = toMinor(input.compareAt, 'The compare-at price');
  let currency = 'usd';

  let offerId = null;
  if (input.offerId !== undefined && input.offerId !== null && input.offerId !== '') {
    if (typeof input.offerId !== 'string' || !OFFER_ID_RE.test(input.offerId)) throw fail(400, 'OFFER_NOT_YOURS', OFFER_NOT_YOURS);
    const offer = await offerOf(input.offerId);
    if (!offer || offer.user_id !== uid || offer.status === 'archived' || offer.status === 'draft') throw fail(400, 'OFFER_NOT_YOURS', OFFER_NOT_YOURS);
    offerId = offer.id;
    // the offer is how buyers pay: a typed outside link is not shown beside it
    outsideBuyUrl = null;
    if (offer.provider === 'stripe' && Number.isFinite(Number(offer.price_minor)) && offer.price_minor !== null) {
      priceMinor = Number(offer.price_minor);
      currency = String(offer.currency || 'usd').toLowerCase();
      if (currency !== 'usd') throw fail(400, 'BAD_REQUEST', 'Public listings show prices in US dollars only.');
    }
  }
  if (['quote'].includes(priceModel)) priceMinor = null;
  if (priceModel === 'free') priceMinor = 0;

  // images: the seller's own hosted files that exist
  const coverPath = input.coverPath === undefined || input.coverPath === null || input.coverPath === '' ? null : input.coverPath;
  if (input.galleryPaths !== undefined && !Array.isArray(input.galleryPaths)) throw fail(400, 'BAD_REQUEST', 'galleryPaths must be a list.');
  const galleryPaths = [...new Set(input.galleryPaths ?? [])];
  if (galleryPaths.length > 3) throw fail(400, 'BAD_REQUEST', 'A listing can show at most 3 more images.');
  const paths = [...(coverPath ? [coverPath] : []), ...galleryPaths];
  for (const p of paths) if (!ownImagePath(uid, p)) throw fail(400, 'IMAGE_NOT_HOSTED', 'Upload the listing’s images first (they must be your own listing images).');
  if (paths.length) {
    const have = await imagesOf();
    for (const p of paths) if (!have.has(p.slice(uid.length + 1))) throw fail(400, 'IMAGE_NOT_HOSTED', 'One of the listing’s images isn’t uploaded any more. Upload it again.');
  }

  return {
    project_id: projectId,
    kind,
    title,
    tagline,
    description,
    category,
    category_slug: categorySlug(category),
    tags,
    price_minor: priceMinor,
    currency,
    price_model: priceModel,
    compare_at_minor: compareAtMinor,
    services,
    includes,
    location,
    seller_name: sellerName,
    website,
    outside_buy_url: outsideBuyUrl,
    phone,
    offer_id: offerId,
    cover_path: coverPath,
    gallery_paths: galleryPaths,
    content_hash: contentHash(description),
  };
}
