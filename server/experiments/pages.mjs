// The SEO page split (P4b §S6): version A (the published page) and version B (stored on the test), 50/50, sticky per
// visitor, with leads attributed to the version that visitor saw. No scripts: published SEO pages run sandboxed.
//
// Serving (server/pages.mjs asks pageHooks.serve for a GET of an SEO page with a running split):
//   - a valid cookie ylbx_<first 12 hex of the test id> = <key>.<mac> keeps the version (mac: HMAC-SHA256 of the test
//     id and key with the split key, 16 bytes, base64url); without one the version is picked at random (50/50), the
//     cookie set (Path=/, 90 days, HttpOnly, Secure except on localhost, SameSite=Lax) and a visitor counted;
//   - crawlers and HEAD get A, no cookie, no count (B keeps A's canonical link);
//   - the answer is `private, no-store` with `Vary: Cookie` (other pages are unchanged);
//   - each action="/<slug>/lead" in the version's HTML becomes action="/<slug>/lead?xv=<test id>.<key>.<mac>": a
//     sandboxed page's form post is cross-site, so the cookie doesn't come with the lead; the token does.
// Counting: views and visitors per version in memory, flushed through ylb_experiment_add_counts every 30 s and on the
// hourly tick (at most 200 rows; a failed flush keeps its counts up to 10 minutes, then drops them and logs once).
// A few counts can be lost when a server copy stops: they are only counts.
// Leads (server/leads.mjs asks pageHooks.leadVariant): the xv token if its mac checks out and it names the running
// (or, within 7 days, the just-ended) split of that very page; else, on a page's own domain, the cookie. Anything else
// is ignored and the lead kept as before. A visitor can't pick a version they weren't served.
// Republishing the page stops its split (a page that changed mid-test can't be compared): onPublished.

import crypto from 'node:crypto';
import { fail, safeLog } from '../integrations/common.mjs';
import { hasLeadForm } from '../leads.mjs';
import { COOKIE_MAX_AGE_S, FLUSH_EVERY_MS, FLUSH_KEEP_MS, FLUSH_MAX_ROWS, SPLIT_TTL_MS, TOKEN_AFTER_STOP_MS, UUID_RE, WINDOW, iso, ms } from './config.mjs';
import { decide } from './math.mjs';
import { startTest } from './start.mjs';

const MAX_HTML_BYTES = 1_500_000;
const TOKEN_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([ab])\.([A-Za-z0-9_-]{22})$/;
/** Search engines, link previews and monitors: they always see A and count nothing. */
export const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|bingpreview|mediapartners|google-inspectiontool|headlesschrome|lighthouse|pingdom|ia_archiver|preview|embedly|whatsapp|telegram|skype|discord/i;
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

export const cookieName = (id) => `ylbx_${String(id).replace(/-/g, '').slice(0, 12)}`;

/** The cookies of a request, by name (the first of each). */
function cookiesOf(req) {
  const out = {};
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

const localHost = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(req.headers?.host ?? ''));

/** deps: { store, db, billing, secret, now, log }. */
export function createPageSplit(deps) {
  const { store, secret, now = () => Date.now(), log = console } = deps;
  const on = !!secret;
  const mac = (id, key) => crypto.createHmac('sha256', secret).update(`${id}:${key}`).digest().subarray(0, 16).toString('base64url');
  const tokenOf = (id, key) => `${id}.${key}.${mac(id, key)}`;
  const macOk = (id, key, got) => {
    const want = Buffer.from(mac(id, key));
    const have = Buffer.from(String(got));
    return want.length === have.length && crypto.timingSafeEqual(want, have);
  };

  // ── the running split of each page, kept SPLIT_TTL_MS (a split another server copy starts is seen within that) ──
  /** `${user_id}|${page_id}` → { at, exp: { id, user_id, page_id, bHtml, out: {} } | null } */
  const cache = new Map();
  const inflight = new Map();
  let pages = null;

  async function running(page) {
    const k = `${page.user_id}|${page.page_id}`;
    const kept = cache.get(k);
    if (kept && now() - kept.at < SPLIT_TTL_MS) return kept.exp;
    if (!inflight.has(k)) {
      inflight.set(
        k,
        (async () => {
          let exp = null;
          try {
            const e = await store.runningSplit(page.user_id, page.page_id);
            if (e) {
              const b = await store.variant(page.user_id, e.id, 'b', { withHtml: true });
              if (b?.html) exp = { id: e.id, user_id: e.user_id, page_id: e.subject_ref, bHtml: Buffer.from(b.html, 'utf8'), out: {} };
            }
          } catch (err) {
            // can't tell right now (or the migration isn't run): version A, nothing counted, for one TTL
            if (err?.code !== 'NOT_SET_UP') safeLog('experiment_split_lookup_failed', { code: err?.code || err?.name || 'Error' }, log);
          }
          cache.set(k, { at: now(), exp });
          while (cache.size > 5000) cache.delete(cache.keys().next().value);
          return exp;
        })().finally(() => inflight.delete(k)),
      );
    }
    return inflight.get(k);
  }

  // ── counters ──
  /** `${id}|${key}` → { visitors, views, leads, since } */
  const counts = new Map();
  let droppedLogged = false;
  function bump(id, key, field) {
    const k = `${id}|${key}`;
    const c = counts.get(k) ?? { visitors: 0, views: 0, leads: 0, since: now() };
    c[field] += 1;
    counts.set(k, c);
  }

  async function flush() {
    if (!counts.size) return { flushed: 0 };
    const batch = [...counts.entries()].slice(0, FLUSH_MAX_ROWS);
    for (const [k] of batch) counts.delete(k);
    const rows = batch.map(([k, c]) => {
      const [experiment_id, key] = k.split('|');
      return { experiment_id, key, visitors: c.visitors, views: c.views, leads: c.leads };
    });
    try {
      await store.addCounts(rows);
      return { flushed: rows.length };
    } catch (e) {
      // kept for the next flush (merged with what came in meanwhile), up to FLUSH_KEEP_MS
      let dropped = 0;
      for (const [k, c] of batch) {
        if (now() - c.since > FLUSH_KEEP_MS) {
          dropped += 1;
          continue;
        }
        const cur = counts.get(k);
        counts.set(k, cur ? { visitors: cur.visitors + c.visitors, views: cur.views + c.views, leads: cur.leads + c.leads, since: c.since } : c);
      }
      if (dropped && !droppedLogged) {
        droppedLogged = true;
        safeLog('experiment_counts_dropped', { rows: dropped, code: e?.code || e?.name || 'Error' }, log);
      }
      return { flushed: 0, kept: batch.length - dropped, dropped };
    }
  }
  let timer = null;

  /** The version's HTML with its lead token in each form action (computed once per version and source). */
  function render(exp, key, aHtml, slug) {
    const src = key === 'b' ? exp.bHtml : aHtml;
    const kept = exp.out[key];
    if (kept && kept.src === src) return kept.body;
    const action = `action="/${slug}/lead"`;
    const body = Buffer.from(src.toString('utf8').split(action).join(`action="/${slug}/lead?xv=${tokenOf(exp.id, key)}"`), 'utf8');
    exp.out[key] = { src, body };
    return body;
  }

  const pageHooks = {
    /**
     * A GET or HEAD of a published SEO page: null when it has no running split (serve it as always), else
     * { body (null for HEAD), headers } for the version this visitor gets.
     */
    async serve(req, page, aHtml) {
      if (!on || page?.kind !== 'seo') return null;
      const exp = await running(page);
      if (!exp) return null;
      const headers = { 'cache-control': 'private, no-store', vary: 'Cookie' };
      const ua = String(req.headers?.['user-agent'] ?? '');
      if (req.method === 'HEAD' || !ua || BOT_RE.test(ua)) return { body: req.method === 'HEAD' || !aHtml ? null : render(exp, 'a', aHtml, page.slug), headers, key: 'a' };
      const got = cookiesOf(req)[cookieName(exp.id)];
      const m = /^([ab])\.([A-Za-z0-9_-]{22})$/.exec(String(got ?? ''));
      let key;
      if (m && macOk(exp.id, m[1], m[2])) key = m[1];
      else {
        key = crypto.randomInt(2) === 1 ? 'b' : 'a';
        headers['set-cookie'] = `${cookieName(exp.id)}=${key}.${mac(exp.id, key)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${localHost(req) ? '' : '; Secure'}`;
        bump(exp.id, key, 'visitors');
      }
      bump(exp.id, key, 'views');
      return { body: render(exp, key, aHtml, page.slug), headers, key };
    },

    /**
     * The version a lead came from: { experimentId, key, html? } (html: B's, for its form check) or null (no test,
     * or a token that doesn't check out: the lead is kept as before). page: the published page (with user_id,
     * page_id). allowCookie: on the page's own domain (not sandboxed, so the first-party cookie comes too).
     */
    async leadVariant(req, url, page, { allowCookie = false } = {}) {
      if (!on || page?.kind !== 'seo') return null;
      const raw = url.searchParams.get('xv');
      let id = null;
      let key = null;
      if (raw && raw.length <= 120) {
        const m = TOKEN_RE.exec(raw);
        if (m && macOk(m[1], m[2], m[3])) [id, key] = [m[1], m[2]];
      }
      if (!id && allowCookie) {
        const exp = await running(page).catch(() => null);
        const got = exp ? cookiesOf(req)[cookieName(exp.id)] : null;
        const m = /^([ab])\.([A-Za-z0-9_-]{22})$/.exec(String(got ?? ''));
        if (exp && m && macOk(exp.id, m[1], m[2])) [id, key] = [exp.id, m[1]];
      }
      if (!id || !UUID_RE.test(id)) return null;
      try {
        const e = await store.byIdAny(id);
        if (!e || e.kind !== 'page' || e.user_id !== page.user_id || e.subject_ref !== page.page_id) return null;
        const recent = ['stopped', 'finished'].includes(e.state) && now() - (ms(e.updated_at) ?? 0) <= TOKEN_AFTER_STOP_MS;
        if (e.state !== 'running' && !recent) return null;
        if (key === 'a') return { experimentId: id, key, running: e.state === 'running' };
        const b = await store.variant(e.user_id, id, 'b', { withHtml: true });
        if (!b?.html) return null;
        return { experimentId: id, key, html: b.html, running: e.state === 'running' };
      } catch {
        return null;
      }
    },

    /** A lead was kept for this version: counted with the split's next flush. */
    countLead(experimentId, key) {
      if (UUID_RE.test(String(experimentId)) && ['a', 'b'].includes(key)) bump(experimentId, key, 'leads');
    },

    /** The page was published again (a new A): its running split stops (page_changed). Never throws. */
    async onPublished(userId, pageId) {
      if (!on) return;
      try {
        const e = await store.runningSplit(userId, pageId);
        if (!e) return;
        await flush().catch(() => {});
        await store.swap(userId, e.id, 'running', { state: 'stopped', result: { ...(e.result ?? {}), stoppedBy: 'page_changed', reason: 'page_changed', stoppedAt: iso(now()) } });
        cache.delete(`${userId}|${pageId}`);
      } catch (err) {
        if (err?.code !== 'NOT_SET_UP') safeLog('experiment_page_stop_failed', { code: err?.code || err?.name || 'Error' }, log);
      }
    },
  };

  /** Start a page test's split: version B's HTML checked and stored, then the start (counted in the month's limit). */
  async function startSplit(who, e, b) {
    if (e.kind !== 'page') throw fail(400, 'BAD_REQUEST', 'This isn’t a page test.');
    if (e.state !== 'draft') throw fail(409, 'BAD_REQUEST', e.state === 'running' ? 'This page test is already running.' : 'This A/B test has ended.');
    if (!on) throw fail(503, 'NOT_SET_UP', 'Page tests aren’t set up on this app yet.', {}, 'Page splits need SUPABASE_SECRET_KEY (or EXPERIMENT_COOKIE_SECRET) for their cookies.');
    const html = typeof b.html === 'string' ? b.html : '';
    if (!html.trim()) throw fail(400, 'BAD_REQUEST', 'Version B has no page yet.');
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw fail(413, 'TOO_LARGE', 'Version B is over 1.5 MB. Make it shorter.');
    if (typeof b.sha256 !== 'string' || b.sha256.toLowerCase() !== sha256(html)) throw fail(400, 'BAD_REQUEST', 'Version B didn’t arrive whole. Try again.');
    const page = await store.publishedPage(who.id, e.subject_ref);
    if (!page || page.kind !== 'seo') throw fail(409, 'BAD_REQUEST', 'Publish the page first: version A is the page as it’s published.');
    // B may only use the images published with the page
    const names = new Set((Array.isArray(page.images) ? page.images : []).map((i) => i?.name).filter(Boolean));
    const prefix = `/${page.slug}/img/`;
    for (let at = html.indexOf(prefix); at !== -1; at = html.indexOf(prefix, at + 1)) {
      const name = /^[A-Za-z0-9._-]{1,40}/.exec(html.slice(at + prefix.length, at + prefix.length + 41))?.[0] ?? '';
      if (!names.has(name)) throw fail(400, 'BAD_REQUEST', 'Version B uses an image that isn’t published with the page. Publish the page with both images first.');
    }
    if (hasLeadForm(page.html, page.slug) && !hasLeadForm(html, page.slug)) throw fail(400, 'VARIANT_NO_FORM', 'Version B needs the page’s form, so its leads can be compared.');
    const stored = await store.patchVariant(who.id, e.id, 'b', { html, html_sha256: sha256(html) });
    if (!stored) throw fail(409, 'BAD_REQUEST', 'This page test has no version B.');
    const { row } = await startTest(deps, who, e, { endsAt: now() + WINDOW.page });
    cache.delete(`${who.id}|${e.subject_ref}`);
    return row;
  }

  /** A page test's verdict from its counters (flushed first); past its deadline it finishes. → the row */
  async function recompute(e) {
    await flush().catch(() => {});
    const variants = await store.variants(e.user_id, e.id);
    const endsAt = ms(e.ends_at);
    const t = now();
    const result = decide({ kind: 'page', mode: 'split', changed: e.changed, metric: 'lead_rate', endsAt, now: t, variants: variants.map((v) => ({ key: v.key, visitors: Number(v.visitors) || 0, leads: Number(v.leads) || 0 })) });
    const finished = e.state === 'running' && endsAt != null && t >= endsAt;
    const row = await store.patch(e.user_id, e.id, { result: { ...result, ...(e.result?.stoppedBy ? { stoppedBy: e.result.stoppedBy } : {}) }, ...(finished ? { state: 'finished' } : {}) });
    if (finished) cache.delete(`${e.user_id}|${e.subject_ref}`);
    return row ?? e;
  }

  /** "Use the winner" with B: the page is republished with version B's HTML (one call; the button can be pressed again). */
  async function useB(who, e) {
    const b = await store.variant(who.id, e.id, 'b', { withHtml: true });
    if (!b?.html) throw fail(409, 'BAD_REQUEST', 'Version B isn’t stored any more.');
    if (!pages?.republishHtml) throw fail(503, 'UNAVAILABLE', 'The winner is saved, but the page couldn’t be updated with version B just now. Press Use the winner again in a minute.');
    try {
      const done = await pages.republishHtml(who.id, e.subject_ref, b.html);
      if (!done) throw fail(409, 'BAD_REQUEST', 'The page isn’t published any more, so version B couldn’t be put live. Publish the page again.');
    } catch (err) {
      if (err?.name === 'IntegrationError') throw err;
      safeLog('experiment_use_b_failed', { code: err?.code || err?.name || 'Error' }, log);
      throw fail(502, 'UNAVAILABLE', 'The winner is saved, but the page couldn’t be updated with version B just now. Press Use the winner again in a minute.');
    }
  }

  return {
    enabled: on,
    pageHooks,
    startSplit,
    recompute,
    useB,
    flush,
    tokenOf,
    setPages(p) {
      pages = p;
    },
    forget(row) {
      cache.delete(`${row.user_id}|${row.subject_ref}`);
    },
    forgetUser(userId) {
      for (const k of [...cache.keys()]) if (k.startsWith(`${userId}|`)) cache.delete(k);
    },
    startTimer() {
      if (timer || !on) return;
      timer = setInterval(() => void flush().catch(() => {}), FLUSH_EVERY_MS);
      timer.unref?.();
    },
    stopTimer() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** for tests */
    counts,
  };
}
