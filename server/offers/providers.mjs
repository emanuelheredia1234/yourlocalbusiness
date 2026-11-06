// Where a buy link (/b/<id>) may send a buyer, per provider. A redirect only ever goes to a checkout link this server
// made or checked for that offer's own provider, re-checked on every click: never to anything a visitor sent.
//
//   PROVIDERS[offer.provider].checkoutTarget(row, { site }) → { redirect: url } | { leave: url } | null
//
// - whop: the stored purchase_url, https, host exactly whop.com (production) or sandbox.whop.com (sandbox) for the
//   offer's own environment, no user name, password or port, a /checkout/<the stored ch_ id> path.
// - external: the owner's own link (http(s), no user name or password). A known checkout site
//   (shared/checkout-hosts.json) is a redirect; any other site is a "you're leaving" page on the app's address and a
//   redirect only on the owner's verified domain (their domain vouches for their link).
// - stripe: kept for later (P6: a Checkout Session per click, one shot, never retried); nothing to send to yet.

import fs from 'node:fs';
import { normalizeLink } from '../leadFiles.mjs';
import { WHOP_CHECKOUT_HOSTS } from '../payments/whopClient.mjs';
import { CHECKOUT_RE } from './store.mjs';

const LIST = JSON.parse(fs.readFileSync(new URL('../../shared/checkout-hosts.json', import.meta.url), 'utf8'));
/** Checkout sites buyers go to directly (a listed parent domain covers its subdomains). */
export const CHECKOUT_HOSTS = Object.freeze(LIST.hosts.map((h) => String(h).toLowerCase()));
const MAX_URL = 2000;

/** Whether a host (any case, www. allowed) is a known checkout site: exact, or under a listed domain on a dot boundary. */
export function isCheckoutHost(host) {
  const h = String(host ?? '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (!h) return false;
  return CHECKOUT_HOSTS.some((c) => h === c || h.endsWith(`.${c}`));
}

/**
 * A Whop checkout link as it may be stored and followed: the URL, or null. environment: the offer's;
 * checkoutId: the stored ch_ id the path must name (null while it's being made: any /checkout/ path).
 */
export function validWhopPurchaseUrl(raw, environment, checkoutId = null) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return null;
  const host = WHOP_CHECKOUT_HOSTS[environment];
  if (!host) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '' || u.hostname !== host) return null;
  const m = /^\/checkout\/([A-Za-z0-9_]+)(?:\/|$)/.exec(u.pathname);
  if (!m || !CHECKOUT_RE.test(m[1])) return null;
  if (checkoutId != null && m[1] !== checkoutId) return null;
  return u.href;
}

export const PROVIDERS = Object.freeze({
  whop: {
    checkoutTarget(row) {
      const ref = row?.provider_ref ?? {};
      if (!CHECKOUT_RE.test(String(ref.checkoutId ?? ''))) return null;
      const href = validWhopPurchaseUrl(ref.purchaseUrl, ref.environment, ref.checkoutId);
      return href ? { redirect: href } : null;
    },
  },
  external: {
    checkoutTarget(row, { site = null } = {}) {
      const href = normalizeLink(row?.provider_ref?.url);
      // a buyer is only ever sent to a checkout over https
      if (!href || !href.startsWith('https:')) return null;
      const host = new URL(href).hostname;
      return isCheckoutHost(host) || site ? { redirect: href } : { leave: href };
    },
  },
  stripe: {
    checkoutTarget() {
      return null;
    },
  },
});
