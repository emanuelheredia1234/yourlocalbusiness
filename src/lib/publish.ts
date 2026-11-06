// Publishing a page (the sales page, or an artifact) at a public address on this app, https://<app>/<name>,
// and also on the owner's own domains. The server keeps a copy of what was published (server/pages.mjs)
// and serves it to anyone; this is its client. Publishing needs the app's server with accounts, so it's
// never offered in the claude.ai build.

import { useEffect, useState } from 'react';
import type { PromptImage, Published } from './types';
import { serverFetch } from '@/ai/claude';
import { serverBaseNow, useAuth } from './cloud/auth';
import { imageTokens, imagesForPublish, resolveImageTokens, type PublishImage } from './promptImages';
import { leadActionFor, resolveLeadAction, resolveLeadMagnet } from './leadAction';
import { hasBuyToken, resolveBuyTokens } from './buyLinks';

export type PageKind = 'seo' | 'artifact';

/** A published page, as the server lists it. */
export interface ServerPage {
  /** 'seo:<projectId>' or 'artifact:<assetId>' */
  pageId: string;
  kind: PageKind;
  slug: string;
  title: string;
  domain?: string;
  home: boolean;
  updatedAt: number;
  url: string;
  domainUrl?: string;
}

/** The DNS record that proves a domain is yours: a TXT record with this name and value. */
export interface DomainRecord {
  name: string;
  value: string;
}

/** One of the owner's own domains (or, with takenByOther, one another account added first). */
export interface DomainInfo {
  domain: string;
  token: string;
  /** its TXT record was found the last time it was checked */
  verified: boolean;
  verifiedAt: number | null;
  /** the TXT record to add at the domain's registrar */
  record: DomainRecord;
  /** another account added it first: the TXT record moves it to this account */
  takenByOther?: boolean;
}

/** The name of a domain's TXT record (the server says it too; this is in case it didn't). */
export const txtRecordName = (domain: string) => `_ylb-domain.${domain}`;

export interface PublishedList {
  pages: ServerPage[];
  domains: DomainInfo[];
  /** the app's public address, e.g. https://yourlocalbusiness.replit.app */
  appOrigin: string;
}

/** Where a publish goes, handed to the page's build so its links and canonical address match. */
export interface PublishTarget {
  slug: string;
  /** https://<app>/<slug> */
  url: string;
  /** https://<domain>/<slug>, or https://<domain>/ when it's the domain's home page */
  domainUrl?: string;
  /** the address search engines should use: the domain's when there is one, else the app's */
  canonical: string;
  /**
   * origin of `canonical`. Image tokens become /<slug>/img/<name> (which works on both addresses), so
   * `${origin}{{img-1}}` gives a full image address where one is needed (og:image).
   */
  origin: string;
}

/** What a page publishes: its HTML (images as {{img-N}} tokens) and its images. */
export interface PublishBuild {
  html: string;
  images: PromptImage[];
}

export class PublishError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
    /** the server's answer, when it sent one */
    readonly data: unknown = null,
  ) {
    super(message);
  }
}

// ───────────── names and addresses ─────────────

export const SLUG_MIN = 3;
export const SLUG_MAX = 60;
/** the server's own limits (a little under them, so a request is never refused for size) */
export const MAX_HTML_BYTES = 1_500_000;
const MAX_REQUEST_BYTES = 13.5 * 1024 * 1024;
const MAX_IMAGES = 12;
const PAGE_ID = /^(seo|artifact):[A-Za-z0-9_-]{1,80}$/;
/** A project's id as the server takes it (published_pages.project_id). */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** A page name: 3–60 lower-case letters, digits and single hyphens, starting and ending with a letter or digit. */
export function isValidSlug(slug: string): boolean {
  return slug.length >= SLUG_MIN && slug.length <= SLUG_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * A page name made from any text ("Maya’s Bakery & Café" → "mayas-bakery-and-cafe"): lower-case
 * a–z, 0–9 and single hyphens, at most 60 characters (cut at a word break), and at least 3 ("-page"
 * is added to a shorter one). '' when the text has no letters or digits to use.
 */
export function slugFrom(text: string): string {
  let s = (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > SLUG_MAX) {
    const cut = s.lastIndexOf('-', SLUG_MAX);
    s = (cut >= SLUG_MIN ? s.slice(0, cut) : s.slice(0, SLUG_MAX)).replace(/-+$/, '');
  }
  return s && s.length < SLUG_MIN ? `${s}-page` : s;
}

/** A page name as it's typed: same rules, but a hyphen may end it for now (removed by slugFrom/when checked). */
export function typedSlug(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX);
}

/**
 * A domain as the owner typed it, reduced to the name: no https://, path, port, "user@", trailing dot
 * or capitals ("HTTPS://Shop.Example.com:443/menu" → "shop.example.com"). '' when it isn't one.
 */
export function normalizeDomain(input: string): string {
  let s = (input || '').trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  try {
    return new URL(s).hostname.replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/** A domain name the server can take (the same rule as its database). */
export function isValidDomain(domain: string): boolean {
  return domain.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
}

/** The app's own address as this page knows it (the server's, when the app uses a separate one). */
export function appOriginNow(): string {
  return serverBaseNow() || (typeof location !== 'undefined' ? location.origin : '');
}

/** The addresses a publish with these settings gets. */
export function publishTarget(appOrigin: string, slug: string, domain?: string | null, home?: boolean): PublishTarget {
  const app = appOrigin.replace(/\/+$/, '');
  const url = `${app}/${slug}`;
  const domainUrl = domain ? (home ? `https://${domain}/` : `https://${domain}/${slug}`) : undefined;
  const canonical = domainUrl ?? url;
  let origin = '';
  try {
    origin = new URL(canonical).origin;
  } catch {
    /* no app address known */
  }
  return { slug, url, ...(domainUrl ? { domainUrl } : {}), canonical, origin };
}

// ───────────── fingerprints ─────────────

/** A short fingerprint of a text: the same text always gives the same one (cyrb53, plus the length). */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}-${text.length.toString(36)}`;
}

/**
 * Fingerprint of what a page publishes: its HTML (with the {{img-N}} tokens, before they become
 * addresses) and which file each token it uses is. It doesn't depend on how a device redraws the
 * images, so every device gets the same one, and "changes not published yet" means the page changed.
 */
export function buildHash(html: string, images: PromptImage[] = []): string {
  const used = new Set(imageTokens(html));
  const files = images
    .filter((i) => used.has(i.key))
    .map((i) => `${i.key}=${i.media.id}`)
    .sort();
  return fingerprint(`${html}\n${files.join('\n')}`);
}

/** key → the published address of each image (/<slug>/img/<name>), for resolveImageTokens. */
export function publishedImagePaths(slug: string, images: Pick<PublishImage, 'name'>[]): Record<string, string> {
  return Object.fromEntries(images.map((i) => [i.name.replace(/\.[a-z]+$/, ''), `/${slug}/img/${i.name}`]));
}

/**
 * A page's build, ready to send: the images it uses (redrawn for the web), its HTML with each image token
 * turned into that image's address, each {{lead-action}} into /<slug>/lead (so its forms send to Email →
 * Leads) and each {{lead-magnet}} into magnet (the business's current download id, or nothing), and its fingerprint.
 */
/**
 * The offers a page's {{buy:<id>}} links may use, asked of its business now (ask: that business's offer ids from the
 * server). undefined when the page has no buy link. A page with buy links and no business, or a business whose
 * offers can't be asked now, isn't published: its Buy buttons would go nowhere.
 */
export async function offersForPublish(html: string, projectId: string | undefined, ask: (projectId: string) => Promise<ReadonlySet<string>>): Promise<ReadonlySet<string> | undefined> {
  if (!hasBuyToken(html)) return undefined;
  if (!projectId) throw new PublishError('This page’s buy links don’t know which business they’re for. Publish it from its business.', 'OFFERS_UNAVAILABLE');
  try {
    return await ask(projectId);
  } catch {
    throw new PublishError('Couldn’t check this page’s buy links. Try again in a moment.', 'OFFERS_UNAVAILABLE');
  }
}

export async function preparePublish(build: PublishBuild, slug: string, magnet?: string, offers: ReadonlySet<string> = new Set()): Promise<{ html: string; images: PublishImage[]; hash: string }> {
  const keys = imageTokens(build.html);
  const images = keys.length ? await imagesForPublish(build.images, keys) : [];
  // each {{buy:<id>}} of the business's offers becomes /b/<id> (relative: a page on the owner's domain stays there); any other goes nowhere
  const html = resolveBuyTokens(resolveLeadMagnet(resolveLeadAction(resolveImageTokens(build.html, publishedImagePaths(slug, images)), leadActionFor(slug)), magnet), { mode: 'page', known: offers });
  return { html, images, hash: buildHash(build.html, build.images) };
}

// ───────────── is publishing on? ─────────────

export interface PagesConfig {
  enabled: boolean;
  /** the server answered */
  reachable: boolean;
}

let configAsk: Promise<PagesConfig> | null = null;

/** Whether this app's server publishes pages (GET /api/config → pages.enabled). Never in the claude.ai build. */
export function publishConfig(refresh = false): Promise<PagesConfig> {
  if (__ARTIFACT_BUILD__) return Promise.resolve({ enabled: false, reachable: false });
  if (!configAsk || refresh) {
    const ask: Promise<PagesConfig> = fetch(`${serverBaseNow()}/api/config`, { signal: AbortSignal.timeout(8000) })
      .then(async (res) => {
        const body = res.ok ? ((await res.json().catch(() => null)) as { pages?: { enabled?: unknown } } | null) : null;
        // a host without the app's server (404) answers too: it just can't publish
        return { enabled: body?.pages?.enabled === true, reachable: res.ok || res.status === 404 };
      })
      .catch(() => ({ enabled: false, reachable: false }));
    configAsk = ask;
    // couldn't reach the server: ask again next time
    void ask.then((c) => {
      if (!c.reachable && configAsk === ask) configAsk = null;
    });
  }
  return configAsk;
}

/** checking · unavailable (claude.ai build) · unreachable · off (not set up on the server) · signed-out · ready */
export type PublishAccess = 'checking' | 'unavailable' | 'unreachable' | 'off' | 'signed-out' | 'ready';

/** Whether this person can publish here, and if not, why. */
export function usePublishAccess(): { access: PublishAccess; retry: () => void } {
  const phase = useAuth((s) => s.phase);
  const [config, setConfig] = useState<PagesConfig | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    let alive = true;
    void publishConfig(tries > 0).then((c) => {
      if (alive) setConfig(c);
    });
    return () => {
      alive = false;
    };
  }, [tries]);
  const retry = () => {
    setConfig(null);
    setTries((n) => n + 1);
  };
  let access: PublishAccess;
  if (__ARTIFACT_BUILD__) access = 'unavailable';
  else if (!config || phase === 'loading') access = 'checking';
  else if (!config.reachable) access = 'unreachable';
  else if (!config.enabled) access = 'off';
  else if (phase !== 'ready') access = 'signed-out';
  else access = 'ready';
  return { access, retry };
}

// ───────────── the server's API ─────────────

/** Plain words for the server's refusals (its own message is used for the others). */
const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Your sign-in has ended. Sign in again, then try once more.',
  PAGES_OFF: 'Publishing isn’t set up on this app’s server yet.',
  SLUG_TAKEN: 'That name is already taken. Try another one.',
  TOO_LARGE: 'This page is too big to publish. Try fewer or smaller images.',
  DOMAIN_NOT_YOURS: 'That domain isn’t in your account anymore. Add it again in Settings › Domains.',
  DOMAIN_TAKEN: 'Another account added that domain first. If it’s yours, add its TXT record in Settings › Domains to move it to your account.',
  ACCOUNT_GONE: 'This account doesn’t exist anymore. Sign in again.',
  RATE_LIMIT: 'That’s a lot of changes at once. Wait a minute, then try again.',
  FORBIDDEN: 'This request was refused because it didn’t come from the app’s own page.',
};

async function api<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await serverFetch(serverBaseNow(), path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body, signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new PublishError('Couldn’t reach the server. Check your connection, then try again.', 'NETWORK');
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok) {
    const code = json?.code || (res.status === 429 ? 'RATE_LIMIT' : res.status === 401 ? 'AUTH_REQUIRED' : res.status === 413 ? 'TOO_LARGE' : `HTTP_${res.status}`);
    throw new PublishError(MESSAGES[code] ?? (json?.error || `The server couldn’t do that (error ${res.status}). Try again.`), code, res.status, json);
  }
  return (json ?? {}) as T;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const time = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) || 0 : 0);

function toServerPage(raw: unknown): ServerPage | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !PAGE_ID.test(str(r.pageId)) || !str(r.slug)) return null;
  const domain = str(r.domain);
  const domainUrl = str(r.domainUrl);
  return {
    pageId: str(r.pageId),
    kind: r.kind === 'artifact' ? 'artifact' : 'seo',
    slug: str(r.slug),
    title: str(r.title),
    ...(domain ? { domain } : {}),
    home: r.home === true,
    updatedAt: time(r.updatedAt),
    url: str(r.url),
    ...(domainUrl ? { domainUrl } : {}),
  };
}

function toDomainInfo(raw: unknown): DomainInfo | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !str(r.domain)) return null;
  const domain = str(r.domain);
  const token = str(r.token);
  const rec = (r.record && typeof r.record === 'object' ? r.record : {}) as Record<string, unknown>;
  return { domain, token, verified: r.verified === true, verifiedAt: time(r.verifiedAt) || null, record: { name: str(rec.name) || txtRecordName(domain), value: str(rec.value) || token } };
}

/** Your published pages and your domains. */
export async function listPublished(signal?: AbortSignal): Promise<PublishedList> {
  const j = await api<{ pages?: unknown[]; domains?: unknown[]; appOrigin?: unknown }>('GET', '/api/pages', undefined, signal);
  const pages = (Array.isArray(j.pages) ? j.pages : []).map(toServerPage).filter((p): p is ServerPage => !!p);
  const domains = (Array.isArray(j.domains) ? j.domains : []).map(toDomainInfo).filter((d): d is DomainInfo => !!d);
  const appOrigin = /^https?:\/\//.test(str(j.appOrigin)) ? str(j.appOrigin).replace(/\/+$/, '') : appOriginNow();
  return { pages, domains, appOrigin };
}

/** Whether a name is free for this page: taken (by another page), reserved (used by the app) or not a valid name. */
export async function checkSlug(slug: string, pageId: string, signal?: AbortSignal): Promise<{ ok: boolean; reason?: 'taken' | 'reserved' | 'format' }> {
  if (!isValidSlug(slug)) return { ok: false, reason: 'format' };
  try {
    const j = await api<{ ok?: boolean; reason?: string }>('GET', `/api/pages/check?slug=${encodeURIComponent(slug)}&pageId=${encodeURIComponent(pageId)}`, undefined, signal);
    if (j.ok === true) return { ok: true };
    return { ok: false, reason: j.reason === 'reserved' || j.reason === 'format' ? j.reason : 'taken' };
  } catch (e) {
    if (e instanceof PublishError && e.status === 400) return { ok: false, reason: 'format' };
    throw e;
  }
}

/** The page's id in an address: only letters, digits, _, - and one ':' (safe as they are). */
function pagePath(pageId: string): string {
  if (!PAGE_ID.test(pageId)) throw new PublishError('This page can’t be published: its id isn’t one the server accepts.', 'BAD_PAGE_ID');
  return pageId;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

export interface PublishInput {
  pageId: string;
  kind: PageKind;
  slug: string;
  title: string;
  /** the finished page: image tokens already replaced by /<slug>/img/<name> (see preparePublish) */
  html: string;
  images: Pick<PublishImage, 'name' | 'mime' | 'data'>[];
  /** one of your domains to also show it on, or none */
  domain?: string | null;
  /** the domain's home page (only with a domain) */
  home?: boolean;
  /** the build's fingerprint (buildHash); without it, one of what's sent */
  hash?: string;
  /** the project the page belongs to, so its leads show under that business (an SEO page's is its own id) */
  projectId?: string;
}

/**
 * Publish (or update, or rename) a page. A new name takes over at once and the old one stops working.
 * Resolves to what to keep with the page.
 */
export async function publishPage(p: PublishInput): Promise<Published> {
  if (!isValidSlug(p.slug)) throw new PublishError('Choose a name of 3 to 60 letters, numbers and hyphens.', 'BAD_SLUG');
  if (bytes(p.html) > MAX_HTML_BYTES) throw new PublishError('This page is too big to publish (over 1.5 MB). Try making it shorter.', 'TOO_LARGE');
  if (p.images.length > MAX_IMAGES) throw new PublishError(`A published page can have up to ${MAX_IMAGES} images.`, 'TOO_MANY_IMAGES');
  const domain = p.domain || null;
  const home = !!(domain && p.home);
  const projectId = p.projectId && PROJECT_ID.test(p.projectId) ? p.projectId : undefined;
  const body = JSON.stringify({ kind: p.kind, slug: p.slug, title: p.title.trim().slice(0, 300), html: p.html, images: p.images.map(({ name, mime, data }) => ({ name, mime, data })), domain, home, ...(projectId ? { projectId } : {}) });
  if (bytes(body) > MAX_REQUEST_BYTES) throw new PublishError('This page and its images are too big to send at once. Try fewer or smaller images.', 'TOO_LARGE');
  const j = await api<{ page?: unknown; url?: unknown; domainUrl?: unknown }>('PUT', `/api/pages/${pagePath(p.pageId)}`, body);
  const page = toServerPage(j.page);
  const slug = page?.slug || p.slug;
  // the server says the addresses; these are only in case it didn't
  const target = publishTarget(appOriginNow(), slug, domain, home);
  const url = str(j.url) || page?.url || target.url;
  const domainUrl = str(j.domainUrl) || page?.domainUrl || target.domainUrl;
  const finalDomain = page ? page.domain : domain ?? undefined;
  return {
    slug,
    ...(finalDomain ? { domain: finalDomain } : {}),
    ...((page ? page.home : home) ? { home: true } : {}),
    url,
    ...(finalDomain && domainUrl ? { domainUrl } : {}),
    publishedAt: Date.now(),
    hash: p.hash ?? fingerprint(`${p.html}\n${p.images.map((i) => i.name).join('\n')}`),
  };
}

/** Take a page down: its address (and its images) stop working at once. Already gone counts as done. */
export async function unpublishPage(pageId: string): Promise<void> {
  try {
    await api('DELETE', `/api/pages/${pagePath(pageId)}`);
  } catch (e) {
    if (!(e instanceof PublishError && e.status === 404)) throw e;
  }
}

/**
 * Add one of your domains (normalised first). When another account added it first, this resolves to
 * it with `takenByOther` and the TXT record that moves it to your account (see checkDomain).
 */
export async function addDomain(domain: string): Promise<DomainInfo> {
  const d = normalizeDomain(domain);
  if (!isValidDomain(d)) throw new PublishError('Enter a domain like yourbrand.com.', 'BAD_DOMAIN');
  try {
    const j = await api<unknown>('POST', '/api/domains', JSON.stringify({ domain: d }));
    return toDomainInfo(j) ?? { domain: d, token: '', verified: false, verifiedAt: null, record: { name: txtRecordName(d), value: '' } };
  } catch (e) {
    const claim = e instanceof PublishError && e.code === 'DOMAIN_TAKEN' ? toDomainInfo((e.data as { domain?: unknown } | null)?.domain) : null;
    if (claim?.token) return { ...claim, verified: false, takenByOther: true };
    throw e;
  }
}

/**
 * Ask the server to look up the domain's TXT record now. verified: it's yours (one another account
 * had moves to yours); `domain` is how it is now.
 */
export async function checkDomain(domain: string): Promise<{ verified: boolean; error?: string; domain?: DomainInfo }> {
  const j = await api<{ verified?: unknown; error?: unknown; domain?: unknown }>('POST', `/api/domains/${encodeURIComponent(domain)}/check`);
  const error = str(j.error);
  const info = toDomainInfo(j.domain);
  return { verified: j.verified === true, ...(error ? { error } : {}), ...(info ? { domain: info } : {}) };
}

/** Remove one of your domains: pages on it keep their address on this app. Already gone counts as done. */
export async function removeDomain(domain: string): Promise<void> {
  try {
    await api('DELETE', `/api/domains/${encodeURIComponent(domain)}`);
  } catch (e) {
    if (!(e instanceof PublishError && e.status === 404)) throw e;
  }
}

/** What to keep with a page that's published, from the server's listing (`hash`: what this device last published, if known). */
export function publishedFromServer(page: ServerPage, hash = '', publishedAt = page.updatedAt || Date.now()): Published {
  return {
    slug: page.slug,
    ...(page.domain ? { domain: page.domain } : {}),
    ...(page.home ? { home: true } : {}),
    url: page.url,
    ...(page.domainUrl ? { domainUrl: page.domainUrl } : {}),
    publishedAt,
    hash,
  };
}
