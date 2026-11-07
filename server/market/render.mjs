// The public marketplace's HTML (P7): the grid (/market), one listing (/market/<slug>) and the report form
// (/market/<slug>/report). Server-rendered, no scripts: the only <script> is one application/ld+json data block (it
// never runs: the CSP has default-src 'none' and no script-src).
//
// Every piece of user text goes through escapeHtml here, every time (it is stored plain). URLs are built from validated
// parts (the app's origin, a slug, an offer id, a hosted image path), never from the request. Outside links carry
// rel="ugc nofollow noopener"; Buy is only ever the P3/P6 buy link /b/<offer id> (rel="nofollow"). Never an email
// address, a rating, a review or a sold count. The style follows the Ink & Aura tokens of server/legal.mjs (same font
// stack, ink and surface colours), light and dark, mobile first with a 16px gutter. The CSS is a module constant.

import { escapeHtml } from '../leads.mjs';
import { breadcrumbJsonLd, jsonLdScript, productJsonLd } from './jsonld.mjs';
import { REPORT_REASONS } from './validate.mjs';

const SITE = 'Your Local Business';
const MARKET_NAME = `${SITE} Marketplace`;
export const PER_PAGE = 24;
export const MAX_PAGE = 50;

/** The market's CSP: no scripts, images from this host and Supabase Storage only, forms to this host only. */
export function marketCsp(supabaseOrigin = '') {
  const img = ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])].join(' ');
  return `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

const CSS = `
:root { color-scheme: light dark; --ink: #0F0F12; --ink-2: #3F3F46; --muted: #6B6B73; --surface: #FFFFFF; --page: #F3F3F6; --line: #E6E6E9; --brand: #5A3AF7; --brand-ink: #FFFFFF; --soft: #ECEAFE; }
@media (prefers-color-scheme: dark) { :root { --ink: #F3F3F6; --ink-2: #D4D4D8; --muted: #A1A1AA; --surface: #17171C; --page: #0F0F12; --line: #2A2A31; --brand: #8B73FF; --brand-ink: #0F0F12; --soft: #231F3A; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--page); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 16px; line-height: 1.6; overflow-x: hidden; }
a { color: var(--brand); }
img { max-width: 100%; display: block; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 20px 16px 64px; }
header.top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 20px; margin-bottom: 16px; }
.brand { color: var(--ink); font-weight: 650; letter-spacing: -0.03em; text-decoration: none; }
nav.crumbs { font-size: 0.9rem; color: var(--muted); margin-bottom: 12px; overflow-wrap: anywhere; }
nav.crumbs a { color: var(--muted); }
h1 { font-size: 1.75rem; line-height: 1.15; letter-spacing: -0.035em; margin: 0 0 6px; overflow-wrap: anywhere; }
h2 { font-size: 1.1rem; letter-spacing: -0.02em; margin: 1.6em 0 0.4em; }
p { margin: 0 0 0.9em; color: var(--ink-2); overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.tagline { font-size: 1.05rem; color: var(--ink-2); }
.price { font-size: 1.3rem; font-weight: 650; color: var(--ink); margin: 8px 0 16px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 20px 16px; }
.gallery { display: grid; gap: 8px; grid-template-columns: 1fr; margin: 16px 0; }
.gallery img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 12px; background: var(--line); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.btn { display: inline-block; padding: 10px 18px; border-radius: 999px; background: var(--brand); color: var(--brand-ink); text-decoration: none; font-weight: 600; }
.btn.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
.note { font-size: 0.85rem; color: var(--muted); }
ul.plain { padding-left: 1.2em; margin: 0; }
ul.plain li { color: var(--ink-2); margin: 0.2em 0; overflow-wrap: anywhere; }
.svc { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid var(--line); padding: 8px 0; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); list-style: none; padding: 0; margin: 16px 0; }
.grid a.item { display: block; height: 100%; text-decoration: none; color: inherit; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
.grid .cover { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: var(--soft); }
.grid .initial { width: 100%; aspect-ratio: 4 / 3; display: grid; place-items: center; background: var(--soft); color: var(--brand); font-size: 2.5rem; font-weight: 650; }
.grid .body { padding: 12px 14px 14px; }
.grid .t { font-weight: 650; color: var(--ink); margin: 0 0 2px; overflow-wrap: anywhere; }
.grid .s, .grid .m { font-size: 0.88rem; color: var(--muted); margin: 0; overflow-wrap: anywhere; }
.grid .p { font-weight: 600; color: var(--ink); margin: 6px 0 0; }
.cats { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; padding: 0; list-style: none; }
.cats a { display: inline-block; padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; text-decoration: none; color: var(--ink-2); font-size: 0.9rem; }
.cats a[aria-current="page"] { background: var(--ink); color: var(--page); border-color: var(--ink); }
form.search { display: flex; gap: 8px; margin: 12px 0; }
input[type="search"], textarea { flex: 1; min-width: 0; font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px; }
textarea { width: 100%; min-height: 110px; }
button { font: inherit; cursor: pointer; padding: 8px 16px; border-radius: 999px; border: 1px solid var(--ink); background: var(--ink); color: var(--page); font-weight: 600; }
fieldset { border: 0; padding: 0; margin: 0 0 16px; }
label.r { display: block; padding: 6px 0; color: var(--ink-2); }
.hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
.pager { display: flex; justify-content: space-between; gap: 12px; margin: 16px 0; }
footer { margin-top: 28px; color: var(--muted); font-size: 0.88rem; }
footer a { color: var(--muted); }
@media (min-width: 720px) { .wrap { padding: 28px 24px 72px; } h1 { font-size: 2.1rem; } .gallery { grid-template-columns: repeat(2, 1fr); } .card { padding: 28px; } }
`;

/** Money as the app shows it (src/lib/utils.ts fmtMoney): $12, $12.50. */
export function fmtMoney(minor) {
  const n = (Number(minor) || 0) / 100;
  const cents = !Number.isInteger(Math.round(n * 100) / 100);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}

/** The price label, the same rules as src/lib/listing.ts priceLabel (minor units here). */
export function priceLabel(minor, model) {
  if (model === 'quote') return 'Get a quote';
  if (model === 'free' || Number(minor) === 0) return 'Free';
  if (minor === null || minor === undefined) return '';
  const p = fmtMoney(minor);
  if (model === 'monthly') return `${p}/mo`;
  if (model === 'yearly') return `${p}/yr`;
  if (model === 'per-session') return `${p}/session`;
  if (model === 'project') return `From ${p}`;
  return p;
}

/** Text cut at a word boundary to at most n characters (with … when cut). */
export function cutText(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length <= n) return s;
  const head = chars.slice(0, n - 1).join('');
  const at = head.lastIndexOf(' ');
  return `${(at > n * 0.6 ? head.slice(0, at) : head).replace(/[\s,.;:–—-]+$/u, '')}…`;
}

const placeOf = (row) => {
  const loc = row.location && typeof row.location === 'object' ? row.location : null;
  const where = [loc?.city, loc?.region].filter(Boolean).join(', ');
  return where || (loc?.online ? 'Online' : '');
};

const telOf = (phone) => String(phone ?? '').replace(/[^\d+]/g, '');

/** The page shell. head: { title, description, canonical, robots, og: [[property, content]], links: [[rel, href]] }. */
function page({ title, description, canonical, robots, meta = [], links = [], jsonld = '', body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">\n` : ''}${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">\n` : ''}<meta name="robots" content="${escapeHtml(robots)}">
${meta.map(([k, v, attr = 'property']) => `<meta ${attr}="${escapeHtml(k)}" content="${escapeHtml(v)}">`).join('\n')}${meta.length ? '\n' : ''}${links.map(([rel, href]) => `<link rel="${escapeHtml(rel)}" href="${escapeHtml(href)}">`).join('\n')}${links.length ? '\n' : ''}<style>${CSS}</style>
${jsonld}
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

const topBar = (origin) => `<header class="top"><a class="brand" href="${escapeHtml(origin)}/">${SITE}</a><a href="${escapeHtml(origin)}/market">Marketplace</a></header>`;
const footerHtml = (origin, extra = '') => `<footer>${extra}<p>Payments happen on the seller’s checkout. ${SITE} does not hold your money.</p><p><a href="${escapeHtml(origin)}/terms">Terms</a> · <a href="${escapeHtml(origin)}/privacy">Privacy</a></p></footer>`;

/** The address of a grid page: /market[?category=c][&page=n] (q never in a canonical). */
export function gridPath({ category = '', page = 1, q = '' } = {}) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (q) params.set('q', q);
  if (page > 1) params.set('page', String(page));
  const s = params.toString();
  return `/market${s ? `?${s}` : ''}`;
}

/**
 * One listing. row: public_listings; ctx: { origin (the app's), imageUrl(path) → absolute URL, offer: { state:
 * 'active' | 'paused' | 'none', test }, robots ('index, follow' | 'noindex, follow') }.
 */
export function listingHtml(row, { origin, imageUrl, offer = { state: 'none', test: false }, robots = 'index, follow' }) {
  const canonical = `${origin}/market/${row.slug}`;
  const catUrl = `${origin}${gridPath({ category: row.category_slug })}`;
  const images = [row.cover_path, ...(row.gallery_paths ?? [])].filter(Boolean).map((p) => imageUrl(p));
  const label = priceLabel(row.price_minor, row.price_model);
  const title = cutText(`${row.title} — ${row.seller_name} | ${MARKET_NAME}`, 70);
  const description = row.tagline ? cutText(row.tagline, 155) : cutText(row.description, 155);
  const graph = [productJsonLd(row, { canonical, images, offerState: offer.state }), breadcrumbJsonLd([{ name: 'Marketplace', url: `${origin}/market` }, { name: row.category, url: catUrl }, { name: row.title, url: canonical }])];
  const meta = [
    ['og:type', 'product'],
    ['og:title', row.title],
    ['og:description', description],
    ['og:url', canonical],
    ['og:site_name', SITE],
    ...(images[0] ? [['og:image', images[0]], ['og:image:alt', `${row.title} photo 1`]] : []),
    ...(label && row.price_model !== 'quote' && row.price_minor !== null && row.price_minor !== undefined ? [['product:price:amount', ((Number(row.price_minor) || 0) / 100).toFixed(2)], ['product:price:currency', 'USD']] : []),
    ['twitter:card', images[0] ? 'summary_large_image' : 'summary', 'name'],
    ['twitter:title', row.title, 'name'],
    ['twitter:description', description, 'name'],
    ...(images[0] ? [['twitter:image', images[0], 'name']] : []),
  ];
  const paragraphs = String(row.description ?? '')
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const gallery = images.length ? `<div class="gallery">${images.map((src, i) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(`${row.title} photo ${i + 1}`)}" loading="${i === 0 ? 'eager' : 'lazy'}" decoding="async">`).join('')}</div>` : '';
  const services = Array.isArray(row.services) && row.services.length
    ? `<h2>Services</h2>\n${row.services
        .map((s) => {
          const price = s.priceModel === 'quote' ? 'Get a quote' : s.priceModel === 'free' || !Number(s.priceMinor) ? 'Free' : fmtMoney(s.priceMinor);
          return `<div class="svc"><span>${escapeHtml(s.name ?? '')}${s.duration ? ` <span class="muted">· ${escapeHtml(s.duration)}</span>` : ''}</span><span>${escapeHtml(price)}</span></div>`;
        })
        .join('\n')}`
    : '';
  const includes = Array.isArray(row.includes) && row.includes.length ? `<h2>What’s included</h2>\n<ul class="plain">${row.includes.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '';
  const place = placeOf(row);
  const actions = [];
  if (row.offer_id && offer.state === 'active') actions.push(`<a class="btn" href="${escapeHtml(`${origin}/b/${row.offer_id}`)}" rel="nofollow">Buy</a>`);
  else if (row.offer_id && offer.state === 'paused') actions.push('<p class="muted">Not available to buy right now</p>');
  const outside = row.outside_buy_url || row.website;
  if (outside) actions.push(`<a class="btn ghost" href="${escapeHtml(outside)}" rel="ugc nofollow noopener" target="_blank">Visit the seller’s site</a>`);
  if (row.outside_buy_url && row.website && row.website !== row.outside_buy_url) actions.push(`<a class="btn ghost" href="${escapeHtml(row.website)}" rel="ugc nofollow noopener" target="_blank">Seller’s website</a>`);
  const tel = telOf(row.phone);
  if (row.phone && tel) actions.push(`<a class="btn ghost" href="tel:${escapeHtml(tel)}">Call ${escapeHtml(row.phone)}</a>`);
  const body = `${topBar(origin)}
<nav class="crumbs" aria-label="Breadcrumb"><a href="${escapeHtml(origin)}/market">Marketplace</a> › <a href="${escapeHtml(catUrl)}">${escapeHtml(row.category)}</a> › <span>${escapeHtml(row.title)}</span></nav>
<main class="card">
<h1>${escapeHtml(row.title)}</h1>
${row.tagline ? `<p class="tagline">${escapeHtml(row.tagline)}</p>\n` : ''}<p class="muted">By ${escapeHtml(row.seller_name)}${place ? ` · ${escapeHtml(place)}` : ''}</p>
${label ? `<p class="price">${escapeHtml(label)}</p>\n` : ''}${gallery}
<div class="actions">${actions.join('')}</div>
${offer.test && row.offer_id && offer.state !== 'none' ? '<p class="note">Test mode: this checkout takes no real payments.</p>\n' : ''}<h2>About</h2>
${paragraphs}
${services}
${includes}
${place ? `<h2>Location</h2>\n<p>${escapeHtml(place)}</p>` : ''}
</main>
${footerHtml(origin, `<p><a href="${escapeHtml(`${origin}/market/${row.slug}/report`)}" rel="nofollow">Report this listing</a></p>`)}`;
  return page({ title, description, canonical, robots, meta, jsonld: jsonLdScript(graph), body });
}

/**
 * A grid page. ctx: { origin, imageUrl, rows, categories: [{ slug, name, count }], category ({ slug, name } or null), q,
 * page, hasNext, robots, canonical }.
 */
export function gridHtml({ origin, imageUrl, rows, categories = [], category = null, q = '', page: n = 1, hasNext = false, robots, canonical }) {
  const heading = q ? `Search: ${q}` : category ? category.name : 'Marketplace';
  const title = cutText(`${q ? `“${q}” in the marketplace` : category ? `${category.name} — ${MARKET_NAME}` : MARKET_NAME}${n > 1 ? ` (page ${n})` : ''}`, 70);
  const description = category ? `${category.name} from local businesses and makers on ${SITE}.` : `Products and services from local businesses and makers on ${SITE}.`;
  const crumbs = [{ name: 'Marketplace', url: `${origin}/market` }, ...(category ? [{ name: category.name, url: `${origin}${gridPath({ category: category.slug })}` }] : [])];
  const links = [];
  if (n > 1) links.push(['prev', `${origin}${gridPath({ category: category?.slug, q, page: n - 1 })}`]);
  if (hasNext) links.push(['next', `${origin}${gridPath({ category: category?.slug, q, page: n + 1 })}`]);
  const cards = rows
    .map((r) => {
      const cover = r.cover_path ? `<img class="cover" src="${escapeHtml(imageUrl(r.cover_path))}" alt="${escapeHtml(`${r.title} photo 1`)}" loading="lazy" decoding="async">` : `<div class="initial" aria-hidden="true">${escapeHtml(Array.from(String(r.seller_name || r.title || '?'))[0].toUpperCase())}</div>`;
      const price = priceLabel(r.price_minor, r.price_model);
      const place = placeOf(r) || '';
      return `<li><a class="item" href="${escapeHtml(`${origin}/market/${r.slug}`)}">${cover}<div class="body"><p class="t">${escapeHtml(r.title)}</p><p class="s">${escapeHtml(r.seller_name)}</p>${price ? `<p class="p">${escapeHtml(price)}</p>` : ''}<p class="m">${escapeHtml([place, r.category].filter(Boolean).join(' · '))}</p></div></a></li>`;
    })
    .join('\n');
  const nav = categories.length
    ? `<ul class="cats" aria-label="Categories"><li><a href="${escapeHtml(origin)}/market"${!category && !q ? ' aria-current="page"' : ''}>All</a></li>${categories.map((c) => `<li><a href="${escapeHtml(`${origin}${gridPath({ category: c.slug })}`)}"${category?.slug === c.slug ? ' aria-current="page"' : ''}>${escapeHtml(c.name)}</a></li>`).join('')}</ul>`
    : '';
  const pager = n > 1 || hasNext ? `<nav class="pager" aria-label="Pages">${n > 1 ? `<a href="${escapeHtml(`${origin}${gridPath({ category: category?.slug, q, page: n - 1 })}`)}">← Newer</a>` : '<span></span>'}${hasNext ? `<a href="${escapeHtml(`${origin}${gridPath({ category: category?.slug, q, page: n + 1 })}`)}">Older →</a>` : ''}</nav>` : '';
  const body = `${topBar(origin)}
<nav class="crumbs" aria-label="Breadcrumb">${crumbs.map((c, i) => (i === crumbs.length - 1 ? `<span>${escapeHtml(c.name)}</span>` : `<a href="${escapeHtml(c.url)}">${escapeHtml(c.name)}</a>`)).join(' › ')}</nav>
<h1>${escapeHtml(heading)}</h1>
<form class="search" method="get" action="/market" role="search"><input type="search" name="q" maxlength="80" value="${escapeHtml(q)}" placeholder="Search listings" aria-label="Search listings"><button type="submit">Search</button></form>
${nav}
${rows.length ? `<ul class="grid">\n${cards}\n</ul>` : '<p class="muted">No listings here yet.</p>'}
${pager}
${footerHtml(origin)}`;
  return page({ title, description, canonical, robots, links, jsonld: jsonLdScript([breadcrumbJsonLd(crumbs)]), body });
}

export const REASON_LABELS = Object.freeze({
  spam: 'Spam or advertising for something else',
  scam: 'A scam or fraud',
  prohibited: 'Something that isn’t allowed to be sold',
  offensive: 'Offensive or hateful',
  misleading: 'Misleading or false',
  other: 'Something else',
});

/** The report form (no script): reason radios, an optional note, the form token and a hidden honeypot field. */
export function reportFormHtml(row, { origin, token, problem = '' }) {
  // relative: the CSP's form-action 'self' holds on whichever of the app's hosts served the form
  const action = `/market/${row.slug}/report`;
  const body = `${topBar(origin)}
<main class="card">
<h1>Report this listing</h1>
<p>${escapeHtml(row.title)} · ${escapeHtml(row.seller_name)}</p>
${problem ? `<p class="muted" role="alert">${escapeHtml(problem)}</p>\n` : ''}<form method="post" action="${escapeHtml(action)}">
<fieldset><legend>What’s wrong?</legend>
${REPORT_REASONS.map((r, i) => `<label class="r"><input type="radio" name="reason" value="${r}"${i === 0 ? ' required' : ''}> ${escapeHtml(REASON_LABELS[r])}</label>`).join('\n')}
</fieldset>
<label for="note">Anything else we should know (optional)</label>
<textarea id="note" name="note" maxlength="500"></textarea>
<input type="hidden" name="t" value="${escapeHtml(token)}">
<div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<p><button type="submit">Send report</button></p>
</form>
<p class="note">Reports go to ${SITE}. The seller doesn’t see who sent them.</p>
</main>
${footerHtml(origin)}`;
  return page({ title: `Report a listing — ${SITE}`, description: '', canonical: '', robots: 'noindex, nofollow', body });
}
