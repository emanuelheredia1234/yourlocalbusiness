// The public marketplace's reads and their caches (P7). Per server copy, in memory:
//   rows by slug 60 s (a miss 30 s, at most 5,000) · grid pages by (category, page) 60 s (200) · search pages by
//   normalized q 30 s (200, least recently used out first) · offers by id 60 s · the category list 5 min ·
//   pagesServeUntil per seller 10 min.
// onChanged() drops this copy's entries; other copies converge within their TTLs (60 s for a page). A database
// failure throws (the caller answers the 503 notice): a page is never served from a stale copy after a hide on this
// copy. Lookups that miss the cache are budgeted per visitor and in all (like server/offers/buy.mjs): over the budget
// the caller answers 503 with retry-after.

export const LISTING_COLUMNS = 'id,user_id,listing_id,project_id,slug,kind,title,tagline,description,category,category_slug,tags,price_minor,currency,price_model,compare_at_minor,services,includes,location,seller_name,website,outside_buy_url,phone,offer_id,cover_path,gallery_paths,content_hash,quality,status,public_at,content_updated_at,unlisted_at,hidden_at,hidden_reason,held_at,report_count,created_at,updated_at';
const CARD_COLUMNS = 'id,user_id,slug,title,seller_name,price_minor,price_model,location,category,category_slug,cover_path,content_updated_at';
const OFFER_COLUMNS = 'id,user_id,status,provider,price_minor,currency,provider_ref';
export const LOOKUP_BUDGET = Object.freeze({ perMin: 600, perClient: 60, searchPerClient: 30 });
const LOOKUP_TIMEOUT = 5000;

/** A small TTL map, least recently used out first past `max`. */
export function ttlCache({ max = 1000, ttlMs = 60_000, now = () => Date.now() } = {}) {
  const m = new Map();
  return {
    get(key) {
      const hit = m.get(key);
      if (!hit) return undefined;
      if (hit.until <= now()) {
        m.delete(key);
        return undefined;
      }
      m.delete(key);
      m.set(key, hit);
      return hit.value;
    },
    has(key) {
      return this.get(key) !== undefined;
    },
    set(key, value, ttl = ttlMs) {
      m.delete(key);
      m.set(key, { value, until: now() + ttl });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    delete: (key) => m.delete(key),
    clear: () => m.clear(),
    entries: () => [...m.entries()].map(([k, v]) => [k, v.value]),
    get size() {
      return m.size;
    },
  };
}

const timed = (p) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'DbError', code: 'UNAVAILABLE' })), LOOKUP_TIMEOUT)))]).finally(() => clearTimeout(timer));
};

/** A visitor's search words, normalized for the cache key and the query (≤ 80 characters). */
export const normalizeQuery = (q) =>
  String(q ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** db: server/integrations/db.mjs; billing: pagesServeUntil(userId); now. */
export function createMarketStore({ db, billing = null, now = () => Date.now() }) {
  const rows = ttlCache({ max: 5000, ttlMs: 60_000, now });
  const grids = ttlCache({ max: 200, ttlMs: 60_000, now });
  const searches = ttlCache({ max: 200, ttlMs: 30_000, now });
  const offers = ttlCache({ max: 5000, ttlMs: 60_000, now });
  const cats = ttlCache({ max: 1, ttlMs: 5 * 60_000, now });
  const serve = ttlCache({ max: 10_000, ttlMs: 10 * 60_000, now });
  const inflight = new Map();

  let budgetStart = 0;
  let budgetAll = 0;
  const budgetClients = new Map();
  /** One cache miss for this client (kind 'search' has its own, smaller allowance). false: over the budget. */
  function takeLookup(client, kind = 'page') {
    const t = now();
    if (t - budgetStart >= 60_000) {
      budgetStart = t;
      budgetAll = 0;
      budgetClients.clear();
    }
    const key = `${kind}:${budgetClients.size >= 10_000 && !budgetClients.has(`${kind}:${client}`) ? '(others)' : client}`;
    const mine = budgetClients.get(key) ?? 0;
    const cap = kind === 'search' ? LOOKUP_BUDGET.searchPerClient : LOOKUP_BUDGET.perClient;
    if (budgetAll >= LOOKUP_BUDGET.perMin || mine >= cap) return false;
    budgetAll++;
    budgetClients.set(key, mine + 1);
    return true;
  }
  const busy = () => Object.assign(new Error('busy'), { code: 'BUSY' });

  /** One cached read: the value, or the read once (two misses at once share it). */
  async function cached(cache, key, client, kind, read, missTtl = null) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit.value;
    const flight = `${kind}:${key}`;
    if (inflight.has(flight)) return inflight.get(flight);
    if (client !== null && !takeLookup(client, kind)) throw busy();
    const p = (async () => {
      const value = await timed(read());
      cache.set(key, { value }, value == null && missTtl ? missTtl : undefined);
      return value;
    })().finally(() => inflight.delete(flight));
    inflight.set(flight, p);
    return p;
  }

  return {
    takeLookup,
    /** One row by its address (any status), or null. */
    bySlug: (slug, client = null) => cached(rows, slug, client, 'page', async () => (await db.select('public_listings', { slug }, { select: LISTING_COLUMNS, limit: 1 }))[0] ?? null, 30_000),
    /** An offer's status and price (the Buy button and the JSON-LD availability), or null. */
    offer: (id, client = null) => cached(offers, id, client, 'page', async () => (await db.select('offers', { id }, { select: OFFER_COLUMNS, limit: 1 }))[0] ?? null, 30_000),
    /** The live categories: [{ slug, name, count }], most listings first. */
    categories: (client = null) =>
      cached(cats, 'all', client, 'page', async () => {
        const list = await db.select('public_listings', { status: 'live' }, { select: 'category,category_slug,user_id', limit: 5000 });
        const by = new Map();
        for (const r of list) {
          const c = by.get(r.category_slug) ?? { slug: r.category_slug, name: r.category, count: 0 };
          c.count++;
          by.set(r.category_slug, c);
        }
        return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      }),
    /** One grid page (live rows, newest first): { rows (≤ 24), hasNext }. */
    grid: ({ category = null, page = 1 }, client = null) =>
      cached(grids, `${category ?? ''}|${page}`, client, 'page', async () => {
        const list = await db.select('public_listings', { status: 'live', ...(category ? { category_slug: category } : {}) }, { select: CARD_COLUMNS, order: 'content_updated_at.desc,id.asc', limit: 25, offset: (page - 1) * 24 });
        return { rows: list.slice(0, 24), hasNext: list.length > 24 };
      }),
    /** A search page: { rows, hasNext }. q: normalizeQuery's. */
    search: ({ q, page = 1 }, client = null) =>
      cached(searches, `${q}|${page}`, client, 'search', async () => {
        const list = await db.select('public_listings', { status: 'live', search: ['wfts', q] }, { select: CARD_COLUMNS, order: 'content_updated_at.desc,id.asc', limit: 25, offset: (page - 1) * 24 });
        return { rows: list.slice(0, 24), hasNext: list.length > 24 };
      }),
    /** billing.pagesServeUntil(userId), cached 10 min (null: still served). */
    serveUntil: (userId) =>
      cached(serve, userId, null, 'serve', async () => {
        if (!billing?.pagesServeUntil) return null;
        try {
          return (await billing.pagesServeUntil(userId)) ?? null;
        } catch {
          return null;
        }
      }),
    /** Something changed: this copy's entries for the slug (or all), the grid, search, categories. */
    drop(slug = null) {
      if (slug) rows.delete(slug);
      else rows.clear();
      grids.clear();
      searches.clear();
      cats.clear();
    },
    dropOffer: (id) => offers.delete(id),
    dropUser(userId) {
      for (const [k, v] of rows.entries()) if (v?.value?.user_id === userId) rows.delete(k);
      serve.delete(userId);
      grids.clear();
      searches.clear();
      cats.clear();
    },
  };
}
