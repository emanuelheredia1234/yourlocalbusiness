// Older versions made up a website for every new brand: https://{slug}.com, a domain someone else may
// own. It showed as the brand's website, the listing's "Website" link, the image watermark and the
// web address in post CTAs, the lead magnet and emails (and when the field was empty, text still fell
// back to {slug}.com). These functions take it off: the brand's website is cleared (and kept aside so
// the Dashboard can ask once "Is this your website?"), and text that carries it gets the owner's real
// website, or "the link in bio" / a clear placeholder. Posts already out, or handed to Manus, are left
// as they are. Existing businesses, and websites the owner confirmed, are never touched. Pure and
// idempotent: running them again changes nothing.

import type { EmailStep, Listing, Post, Project } from '@/lib/types';
import { brandHandle, websiteHost } from '@/lib/brandMark';

/** A URL's host, lowercased and without "www.", or '' when it isn't one. */
function hostOf(url: string | undefined): string {
  const u = (url ?? '').trim();
  if (!u) return '';
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** The websites older versions wrote for a brand: https://{slug}.com (finishing setup) and https://{slug without dashes}.com (the brand step). */
export function guessedWebsites(p: Project): string[] {
  const slug = (p.brand.slug ?? '').trim();
  if (!slug) return [];
  return [...new Set([`https://${slug}.com`, `https://${slug.replace(/-/g, '')}.com`])];
}

/** Hosts the app made up for this brand (including the "yourbrand.com" stand-in), minus one the owner holds as theirs. */
function inventedHosts(p: Project): string[] {
  const slug = (p.brand.slug ?? '').trim().toLowerCase();
  const all = new Set(['yourbrand.com', ...(slug ? [`${slug}.com`, `${slug.replace(/-/g, '')}.com`] : [])]);
  const own = hostOf(p.brand.websiteUrl);
  // an existing business gave us its own address; a confirmed one is the owner's word
  if (own && (p.origin === 'existing' || p.brand.websiteConfirmed)) all.delete(own);
  return [...all];
}

/** The owner's real website ("sparkle.co"), or '' when there is none or it's one of the made-up ones. */
function realSite(p: Project, hosts: string[]): string {
  const own = hostOf(p.brand.websiteUrl);
  return own && !hosts.includes(own) ? websiteHost(p.brand) : '';
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every mention of one of the hosts (with or without https://, www. or a path) replaced. */
function replaceHosts(text: string, hosts: string[], by: string): string {
  if (!text || !hosts.length) return text;
  const re = new RegExp(`(?<![\\w.@-])(?:https?:\\/\\/)?(?:www\\.)?(?:${hosts.map(esc).join('|')})(?![\\w-]|\\.\\w)(?:\\/[^\\s"'<>)\\]]*)?`, 'gi');
  // a sentence's closing punctuation isn't part of the address
  return text.replace(re, (m) => by + (m.match(/[.,;:!?]+$/)?.[0] ?? ''));
}

const mentions = (text: string | undefined, hosts: string[]) => !!text && replaceHosts(text, hosts, '') !== text;

function cleanEmail(e: EmailStep, hosts: string[], by: string): EmailStep {
  const subject = replaceHosts(e.subject, hosts, by);
  const preview = e.preview ? replaceHosts(e.preview, hosts, by) : e.preview;
  const body = replaceHosts(e.body, hosts, by);
  // a button pointing at the made-up site gets the offer-link token, which fills in your real link
  const ctaUrl = mentions(e.ctaUrl, hosts) ? '{{product_link}}' : e.ctaUrl;
  if (subject === e.subject && preview === e.preview && body === e.body && ctaUrl === e.ctaUrl) return e;
  return { ...e, subject, preview, body, ctaUrl };
}

/** The project without the made-up website, or null when there's nothing to change. */
export function purgeWebsite(p: Project): Project | null {
  const hosts = inventedHosts(p);
  const clearUrl = p.origin !== 'existing' && !p.brand.websiteConfirmed && guessedWebsites(p).includes(p.brand.websiteUrl);
  // the owner's own site where there is one; otherwise a placeholder they will see and fill in
  const site = realSite(p, hosts);
  const by = site || '[link to your offer]';

  const lm = p.marketing.leadMagnet;
  const cta = lm ? replaceHosts(lm.cta, hosts, by) : '';
  const lmChanged = !!lm && cta !== lm.cta;

  const emails = Array.isArray(p.marketing.emails) ? p.marketing.emails : [];
  let emailsChanged = false;
  const nextEmails = emails.map((e) => {
    const c = cleanEmail(e, hosts, by);
    if (c !== e) emailsChanged = true;
    return c;
  });

  if (!clearUrl && !lmChanged && !emailsChanged) return null;
  return {
    ...p,
    brand: clearUrl ? { ...p.brand, websiteUrl: '', guessedWebsite: p.brand.websiteUrl } : p.brand,
    marketing: {
      ...p.marketing,
      ...(lmChanged && lm ? { leadMagnet: { ...lm, cta } } : {}),
      ...(emailsChanged ? { emails: nextEmails } : {}),
    },
  };
}

/** Your own published listing without the made-up "Website" link, or null when there's nothing to change. */
export function purgeListingWebsite(l: Listing, p: Project | undefined): Listing | null {
  if (!p || l.origin !== 'mine' || (l.projectId && l.projectId !== p.id) || !l.website) return null;
  const host = hostOf(l.website);
  if (!host || !inventedHosts(p).includes(host)) return null;
  const { website: _w, ...rest } = l;
  return rest;
}

/** A post not yet out without the made-up web address in its caption, storyboard and image notes, or null when there's nothing to change. */
export function purgePostWebsite(post: Post, p: Project | undefined): Post | null {
  // what's already posted, or with Manus, stays exactly as it went out
  if (!p || post.projectId !== p.id || post.status === 'published' || post.external) return null;
  const hosts = inventedHosts(p);
  const site = realSite(p, hosts);
  const link = site || 'the link in bio';
  const mark = site || brandHandle(p.brand) || p.brand.name.trim() || 'your brand';

  const caption = replaceHosts(post.caption, hosts, link);
  const visualPrompt = replaceHosts(post.visualPrompt, hosts, mark);
  let scenesChanged = false;
  const storyboard = post.storyboard?.map((s) => {
    // a scene that was just the web address
    const whole = !!s.text.trim() && replaceHosts(s.text.trim(), hosts, '') === '';
    const text = whole ? site || 'Link in bio' : replaceHosts(s.text, hosts, link);
    if (text === s.text) return s;
    scenesChanged = true;
    return { ...s, text };
  });

  if (caption === post.caption && visualPrompt === post.visualPrompt && !scenesChanged) return null;
  return { ...post, caption, visualPrompt, ...(scenesChanged ? { storyboard } : {}) };
}
