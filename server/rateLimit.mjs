// The server's per-minute request limit, by key (a bucket and a user or address).
//
// Keys come from callers the server doesn't know (the Omnisend callback counts each address), so the map must
// not grow for the life of the process: a key whose hits are all older than the window is dropped (checked at
// most once a window), and past maxKeys the least recently used key goes first.

/**
 * limit: requests per window per key; factor (per call) multiplies it (reads get a multiple).
 * Returns rateLimited(key, factor): true when this request is over the limit. `.size()` is for tests.
 */
export function createRateLimiter({ limit, windowMs = 60_000, maxKeys = 50_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  let sweptAt = now();

  function sweep(at) {
    for (const [key, times] of hits) {
      if (!times.length || at - times[times.length - 1] >= windowMs) hits.delete(key);
    }
    sweptAt = at;
  }

  function rateLimited(key, factor = 1) {
    const at = now();
    if (at - sweptAt >= windowMs) sweep(at);
    const recent = (hits.get(key) || []).filter((t) => at - t < windowMs);
    recent.push(at);
    // re-inserted, so the map's order is least recently used first
    hits.delete(key);
    hits.set(key, recent);
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    return recent.length > limit * factor;
  }

  rateLimited.size = () => hits.size;
  return rateLimited;
}
