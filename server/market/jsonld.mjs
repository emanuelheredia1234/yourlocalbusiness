// The public marketplace's structured data (P7): one <script type="application/ld+json"> data block per page (it never
// runs: the page's CSP has no script-src), an @graph with a Product or Service and its Offer (only when there is a
// price to state) and a BreadcrumbList (only with two or more items). Never aggregateRating or review: there are no
// ratings or reviews, ever.
//
// Escaping: JSON.stringify, then < > & and U+2028/U+2029 as \u escapes, so "</script>" in any field can't end the
// block and the text stays the same JSON.

/** The JSON text of a value, safe inside <script type="application/ld+json">. */
export function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The data block for a graph of items. */
export const jsonLdScript = (graph) => `<script type="application/ld+json">${safeJson({ '@context': 'https://schema.org', '@graph': graph })}</script>`;

/** Minor units → '12.00'. */
export const priceText = (minor) => (Math.max(0, Number(minor) || 0) / 100).toFixed(2);

/** A BreadcrumbList: items [{ name, url }] in order. */
export function breadcrumbJsonLd(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })),
  };
}

/**
 * The listing's item: a Product (kind 'product') or a Service (kind 'business': Google's Product markup isn't for
 * services), with its Offer. null when there is no price to state (a quote, or no price): Google's Product snippets
 * need offers, a review or a rating, and there are never reviews or ratings, so then only the BreadcrumbList is sent.
 * A project price ("From $X") is an AggregateOffer with lowPrice, never an exact price. row: public_listings; ctx: {
 * canonical, images: [absolute https URLs], offerState: 'active' | 'paused' | 'none' } ('paused': the offer is
 * paused or its checkout isn't confirmed: OutOfStock).
 */
export function productJsonLd(row, { canonical, images = [], offerState = 'none' }) {
  const hasPrice = row.price_model !== 'quote' && ((row.price_minor !== null && row.price_minor !== undefined) || row.price_model === 'free');
  if (!hasPrice) return null;
  const service = row.kind === 'business';
  const seller = { '@type': 'Organization', name: row.seller_name };
  const item = service
    ? { '@type': 'Service', name: row.title, description: String(row.description ?? '').slice(0, 5000), url: canonical, category: row.category, provider: seller }
    : { '@type': 'Product', name: row.title, description: String(row.description ?? '').slice(0, 5000), url: canonical, sku: row.slug, category: row.category, brand: { '@type': 'Brand', name: row.seller_name } };
  if (images.length) item.image = images;
  const price = priceText(row.price_model === 'free' ? 0 : row.price_minor);
  const availability = offerState === 'paused' ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock';
  let offer;
  if (row.price_model === 'project') {
    offer = { '@type': 'AggregateOffer', lowPrice: price, priceCurrency: 'USD', availability, url: canonical, seller };
  } else {
    offer = { '@type': 'Offer', price, priceCurrency: 'USD', availability, url: canonical, seller };
    if (row.kind === 'product') offer.itemCondition = 'https://schema.org/NewCondition';
    if (row.price_model === 'monthly') offer.priceSpecification = { '@type': 'UnitPriceSpecification', price, priceCurrency: 'USD', referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' } };
    else if (row.price_model === 'yearly') offer.priceSpecification = { '@type': 'UnitPriceSpecification', price, priceCurrency: 'USD', referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'ANN' } };
    else if (row.price_model === 'per-session') offer.priceSpecification = { '@type': 'UnitPriceSpecification', price, priceCurrency: 'USD', unitText: 'session' };
  }
  item.offers = offer;
  return item;
}
