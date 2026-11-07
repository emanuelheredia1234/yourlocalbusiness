// The public marketplace's structured data (P7): one <script type="application/ld+json"> data block per page (it never
// runs: the page's CSP has no script-src), an @graph with a Product (and its Offer when there is a price to state)
// and a BreadcrumbList. Never aggregateRating or review: there are no ratings or reviews, ever.
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
 * The Product. row: public_listings; ctx: { canonical, images: [absolute https URLs], offerState: 'active' | 'paused' |
 * 'none' } ('paused': the offer is paused or its checkout isn't confirmed: OutOfStock).
 */
export function productJsonLd(row, { canonical, images = [], offerState = 'none' }) {
  const product = {
    '@type': 'Product',
    name: row.title,
    description: String(row.description ?? '').slice(0, 5000),
    url: canonical,
    sku: row.slug,
    category: row.category,
    brand: { '@type': 'Brand', name: row.seller_name },
  };
  if (images.length) product.image = images;
  const hasPrice = row.price_model !== 'quote' && ((row.price_minor !== null && row.price_minor !== undefined) || row.price_model === 'free');
  if (hasPrice) {
    const price = priceText(row.price_model === 'free' ? 0 : row.price_minor);
    const offer = {
      '@type': 'Offer',
      price,
      priceCurrency: 'USD',
      availability: offerState === 'paused' ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      url: canonical,
      seller: { '@type': 'Organization', name: row.seller_name },
    };
    if (row.kind === 'product') offer.itemCondition = 'https://schema.org/NewCondition';
    if (row.price_model === 'monthly') offer.priceSpecification = { '@type': 'UnitPriceSpecification', price, priceCurrency: 'USD', referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' } };
    else if (row.price_model === 'yearly') offer.priceSpecification = { '@type': 'UnitPriceSpecification', price, priceCurrency: 'USD', referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'ANN' } };
    else if (row.price_model === 'per-session') offer.priceSpecification = { '@type': 'UnitPriceSpecification', price, priceCurrency: 'USD', unitText: 'session' };
    product.offers = offer;
  }
  return product;
}
