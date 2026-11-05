// Where the business's page ranks in Google's results (pure; tested).
//
// App-host pages share one host with every other customer's pages, so they match on the full address
// (https://<app>/<slug>, ignoring a trailing slash, the query and the fragment). A custom-domain page matches on
// the host (www. ignored). No match: rank null ("Not in top 10").

/** An address reduced for comparison: lower-case host, no www., no query or fragment, no trailing slash. */
export function normalizeUrl(value) {
  try {
    const u = new URL(String(value ?? ''));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return '';
  }
}

export function hostOf(value) {
  try {
    return new URL(String(value ?? '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Whether a result's address is the business's page. page: { url, host: 'app'|'custom', domain? }. */
export function matchesPage(resultUrl, page) {
  if (!page?.url) return false;
  if (page.host === 'custom') {
    const want = String(page.domain || hostOf(page.url)).toLowerCase().replace(/^www\./, '');
    return !!want && hostOf(resultUrl) === want;
  }
  const want = normalizeUrl(page.url);
  return !!want && normalizeUrl(resultUrl) === want;
}

/**
 * The rank of the business's page among organic rows ({ url, position? } or DataForSEO's { url, rank_group,
 * type }): the first match's position, else null.
 */
export function rankOf(rows, page) {
  if (!Array.isArray(rows) || !page) return null;
  let i = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (r.type && r.type !== 'organic') continue;
    i += 1;
    if (matchesPage(r.url, page)) {
      const pos = Number(r.position ?? r.rank_group ?? i);
      return Number.isFinite(pos) && pos > 0 ? pos : i;
    }
  }
  return null;
}

/** The organic rows of a SERP answer (Crawl4AI's results[], or DataForSEO's tasks[0].result[0].items[]). */
export function organicRows(data) {
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.output?.results)) return data.output.results;
  const items = data?.tasks?.[0]?.result?.[0]?.items;
  return Array.isArray(items) ? items.filter((r) => r?.type === 'organic') : [];
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const digits = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);

/**
 * The business's Maps position: the row with the stored place_id or cid; without one, the first row whose name
 * (letters and digits) and, when both are known, phone match. Returns { position, placeId?, cid? } or null.
 */
export function mapsPosition(rows, { placeId, cid, name, phone } = {}) {
  if (!Array.isArray(rows)) return null;
  const list = rows.filter((r) => r && typeof r === 'object');
  let hit = null;
  if (placeId || cid) hit = list.find((r) => (placeId && r.place_id === placeId) || (cid && String(r.cid) === String(cid)));
  else if (squash(name)) hit = list.find((r) => squash(r.name) === squash(name) && (!digits(phone) || !digits(r.phone) || digits(r.phone) === digits(phone)));
  if (!hit) return null;
  const position = Number(hit.position ?? list.indexOf(hit) + 1);
  return { position, ...(hit.place_id ? { placeId: String(hit.place_id) } : {}), ...(hit.cid ? { cid: String(hit.cid) } : {}) };
}
