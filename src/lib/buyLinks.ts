// Buy links in text and HTML. Assets, the SEO page, listings and emails never hold a checkout provider's address:
// they hold the offer, written {{buy:<offer id>}} where a link goes. This turns the token into the offer's permanent
// link, https://<app>/b/<id> (server/offers/buy.mjs sends buyers on to the checkout), at the last moment: publishing
// (relative, so a page on the owner's own domain stays there), an email or a copy (the full address), the in-app
// preview (#buy-preview: a preview never opens a checkout). Pure: no store, no network.

/** An offer id (22 URL-safe characters, as the server makes them). */
export const OFFER_ID = /^[A-Za-z0-9_-]{22}$/;

/** {{buy:<id>}}, spaces allowed inside the braces. Global: reset lastIndex or use it through replace(). */
export const BUY_TOKEN = /\{\{\s*buy:([A-Za-z0-9_-]{22})\s*\}\}/g;

/** The token for an offer. */
export const buyToken = (id: string): string => `{{buy:${id}}}`;

/** Whether a text has a buy token. */
export const hasBuyToken = (text: string): boolean => new RegExp(BUY_TOKEN.source).test(text);

/** The offer ids a text names, once each, in order. */
export function buyTokenIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(BUY_TOKEN.source, 'g'))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** page: /b/<id> · absolute: <origin>/b/<id> · preview: #buy-preview */
export type BuyMode = 'page' | 'absolute' | 'preview';

export interface BuyResolveOptions {
  mode: BuyMode;
  /** the app's own origin (absolute mode) */
  origin?: string;
  /** the business's offers: any other id becomes '#'. Left out in preview mode: every id is shown as a preview link. */
  known?: ReadonlySet<string>;
  /** html (the default): only inside href="…" / href='…', never inside <script>; text: everywhere (emails) */
  format?: 'html' | 'text';
}

/** Where one offer's link goes in this mode ('#' for an id that isn't the business's). */
export function buyHref(id: string, o: Pick<BuyResolveOptions, 'mode' | 'origin' | 'known'>): string {
  if (!OFFER_ID.test(id)) return '#';
  if (o.known ? !o.known.has(id) : o.mode !== 'preview') return '#';
  if (o.mode === 'preview') return '#buy-preview';
  if (o.mode === 'page') return `/b/${id}`;
  const origin = (o.origin ?? '').replace(/\/+$/, '');
  return /^https?:\/\/[^/]+$/i.test(origin) ? `${origin}/b/${id}` : `/b/${id}`;
}

/** An offer's link (absolute: the full address, the same as the server's offer.link). */
export function offerHref(offer: { id: string }, mode: BuyMode, origin = ''): string {
  return buyHref(offer.id, { mode, origin, known: new Set([offer.id]) });
}

const SCRIPT = /<script\b[\s\S]*?(?:<\/script\s*>|$)/gi;
const HREF = /(\shref\s*=\s*)(["'])([^"']*)\2/gi;

/**
 * Every {{buy:<id>}} in a text, resolved for `mode`. In HTML the token works only as a link's href: one anywhere
 * else in the markup is removed (it would show as text), and scripts are left exactly as they are.
 */
export function resolveBuyTokens(text: string, o: BuyResolveOptions): string {
  if (!text || !text.includes('{{')) return text;
  const one = (_: string, id: string) => buyHref(id, o);
  if (o.format === 'text') return text.replace(new RegExp(BUY_TOKEN.source, 'g'), one);
  const outside = (chunk: string) =>
    chunk
      .replace(HREF, (_whole, pre: string, q: string, value: string) => `${pre}${q}${value.replace(new RegExp(BUY_TOKEN.source, 'g'), one)}${q}`)
      .replace(new RegExp(BUY_TOKEN.source, 'g'), '');
  let out = '';
  let at = 0;
  for (const m of text.matchAll(SCRIPT)) {
    out += outside(text.slice(at, m.index)) + m[0];
    at = (m.index ?? 0) + m[0].length;
  }
  return out + outside(text.slice(at));
}

const A_TAG = /<a\b[^>]*>/gi;

/**
 * Generated or imported HTML: {{buy:<id>}} stays only as the href of an <a> (and, with `allowed`, only for those
 * offers: another id becomes '#'); anywhere else, scripts included, it's removed. Like {{lead-action}}, the token is
 * the app's to place.
 */
export function keepBuyLinksOnly(html: string, allowed?: ReadonlySet<string>): string {
  if (!html || !html.includes('{{')) return html;
  const re = () => new RegExp(BUY_TOKEN.source, 'g');
  const strip = (chunk: string) => chunk.replace(re(), '');
  const inTag = (tag: string) => {
    let kept = false;
    const out = tag.replace(HREF, (_whole, pre: string, q: string, value: string) => {
      const v = value.replace(re(), (_tok: string, id: string) => (allowed && !allowed.has(id) ? '#' : ((kept = true), buyToken(id))));
      return `${pre}${q}${v}${q}`;
    });
    // a token in any other attribute of the link goes
    return kept ? out.replace(/(\s(?!href\b)[a-z-]+\s*=\s*)(["'])([^"']*)\2/gi, (_w, pre: string, q: string, value: string) => `${pre}${q}${strip(value)}${q}`) : strip(out);
  };
  const outside = (chunk: string) => {
    let out = '';
    let at = 0;
    for (const m of chunk.matchAll(A_TAG)) {
      out += strip(chunk.slice(at, m.index)) + inTag(m[0]);
      at = (m.index ?? 0) + m[0].length;
    }
    return out + strip(chunk.slice(at));
  };
  let out = '';
  let at = 0;
  for (const m of html.matchAll(SCRIPT)) {
    out += outside(html.slice(at, m.index)) + strip(m[0]);
    at = (m.index ?? 0) + m[0].length;
  }
  return out + outside(html.slice(at));
}
