// Test harness for A/B tests (tests only): the posting harness (mock Supabase, the real Upload-Post connections on
// mock Upload-Post, Trial Reels' eligibility) with the experiments module wired into posting, a billing stub (plans
// enforced or not, an account per user), a fake Omnisend (createAbDraft, abResults), the published pages module with
// the page split's hooks, and one HTTP server for /api/experiments, /api/pages, /api/leads and the pages themselves
// (any Host but the app's is someone's domain). Nothing leaves the machine.

import http from 'node:http';
import crypto from 'node:crypto';
import { startPosting } from '../social/test-helpers.mjs';
import { stubBilling } from '../morning/test-helpers.mjs';
import { createPages } from '../pages.mjs';
import { createExperiments } from './index.mjs';

export const DOMAIN = 'joes-bakery.example';
export const DOMAIN_TOKEN = `ylb-${'d'.repeat(40)}`;
const UUID = /^[0-9a-f-]{36}$/;

function sendLike(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(data);
}

function readJson(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const t = Buffer.concat(chunks).toString();
        resolve(t ? JSON.parse(t) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** A fake Omnisend for the email tests: { calls, next, results }. */
export function fakeOmnisend() {
  const state = {
    calls: [],
    /** what the next createAbDraft does: 'ab' | 'split' | an error { status, code, message, campaignMayExist? } */
    next: 'ab',
    /** abResults' answer */
    results: { status: 'ok', rates: {} },
  };
  return {
    state,
    async createAbDraft(userId, args) {
      state.calls.push(['createAbDraft', userId, args]);
      const n = state.next;
      if (n && typeof n === 'object') throw Object.assign(new Error(n.message), { status: n.status, code: n.code, publicMessage: n.message, campaignMayExist: !!n.campaignMayExist });
      if (n === 'split') return { mode: 'split', campaigns: { a: { id: 'a1'.repeat(12), name: 'A', status: 'draft', url: '' }, b: { id: 'b1'.repeat(12), name: 'B', status: 'draft', url: '' } } };
      return { mode: 'omnisend_ab', campaign: { id: 'c'.repeat(24), name: 'Test', status: 'draft', url: 'https://app.omnisend.com/campaigns/x', variantIds: { a: 'va', b: 'vb' } } };
    },
    async abResults(userId, args) {
      state.calls.push(['abResults', userId, args]);
      return state.results;
    },
  };
}

export async function startExperiments({ env: envExtra = {}, enforce = false } = {}) {
  let mod = null;
  const t = await startPosting({ env: envExtra, experimentHooks: () => mod?.postingHooks ?? null });
  t.supa.behavior.now = () => t.clock.t;
  const billing = stubBilling(t.supa, () => t.clock.t);
  billing.state.enforce = enforce;
  const omnisend = fakeOmnisend();
  const logs = t.logs;
  const log = { log: (line) => logs.push(String(line)) };
  mod = createExperiments({ auth: t.auth, db: t.db, send: sendLike, readJson, limit: t.limit, env: t.env, now: () => t.clock.t, log, billing, connections: t.connections, trialReels: t.trialReels, omnisend });
  const whoIs = async (req, res) => {
    const who = await t.auth.identify(req).catch(() => null);
    if (!who?.id) {
      sendLike(res, 401, { error: 'Sign in', code: 'AUTH_REQUIRED' });
      return null;
    }
    return { who };
  };
  const pages = createPages({
    supabaseUrl: t.supa.url,
    secretKey: t.supa.SECRET,
    auth: t.auth,
    whoIs,
    send: sendLike,
    readJson,
    experiments: mod.pageHooks,
    resolveTxt: async (name) => (name === `_ylb-domain.${DOMAIN}` ? [[DOMAIN_TOKEN]] : []),
    lookupLimits: { page: { perMin: 1e6, perClient: 1e6, bytesPerMin: 1e12, bytesPerClient: 1e12 }, domain: { perMin: 1e6, perClient: 1e6 }, image: { perMin: 1e6, perClient: 1e6, bytesPerMin: 1e12, bytesPerClient: 1e12 } },
    tuning: { pageTtl: 1, namesCheck: 0 },
  });
  mod.setPages(pages);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    (async () => {
      if (!pages.isAppHost(req)) return pages.serveDomain(req, res, url);
      if (await mod.handle(req, res, url)) return;
      if (pages.matchApi(url)) return pages.handleApi(req, res, url);
      if (req.method === 'POST' && pages.matchLead(url)) return (await pages.receiveLead(req, res, url)) || sendLike(res, 405, 'no');
      if (pages.matchPage(url) && (await pages.servePage(req, res, url))) return;
      sendLike(res, 404, { error: 'Not found' });
    })().catch((e) => {
      logs.push(`crash ${e?.stack || e}`);
      if (!res.headersSent) sendLike(res, 500, { error: 'crash' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const xbase = `http://127.0.0.1:${server.address().port}`;

  const ctx = {
    ...t,
    t,
    mod,
    pages,
    billing,
    omnisend,
    xbase,
    /** A call to the experiments / pages server. */
    async x(u, method, path, body, { headers = {}, host } = {}) {
      const res = await fetch(`${xbase}${path}`, { method, headers: { ...(u?.headers ?? {}), ...headers, ...(host ? { host } : {}) }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), redirect: 'manual' });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    /** A raw request (any Host, any headers) to the pages server: { status, headers, text }. */
    raw(path, { method = 'GET', headers = {}, body } = {}) {
      const u = new URL(xbase);
      return new Promise((resolve, reject) => {
        const req = http.request({ host: u.hostname, port: u.port, path, method, headers: { ...(body ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(body);
      });
    },
    /** An account on a plan (P1's billing_accounts shape): tier and its window. */
    plan(u, tier, over = {}) {
      billing.state.accounts.set(u.id, { source: 'stripe', tier, interval: 'month', status: 'active', business_limit: 1, current_period_start: new Date(t.clock.t - 5 * 86_400_000).toISOString(), current_period_end: new Date(t.clock.t + 25 * 86_400_000).toISOString(), created_at: new Date(t.clock.t - 40 * 86_400_000).toISOString(), ...over });
    },
    /** A draft post test of saved posts (A first). → the experiment */
    async draft(u, posts, over = {}) {
      const r = await ctx.x(u, 'POST', '/api/experiments', { projectId: 'proj-1', kind: 'post', mode: 'times', changed: 'hook', network: posts[0].platform, subjectRef: posts[0].id, variants: posts.map((p, i) => ({ key: 'abc'[i], label: `Hook ${i + 1}`, postId: p.id })), ...over });
      if (r.status !== 201) throw new Error(`draft ${r.status} ${r.text}`);
      // the app writes each post's experiment field once the test exists
      for (const [i, p] of posts.entries()) {
        p.experiment = { id: r.body.experiment.id, key: 'abc'[i] };
        await t.db.upsert('user_docs', { user_id: u.id, kind: 'post', id: p.id, data: p }, { onConflict: 'user_id,kind,id' });
      }
      return r.body.experiment;
    },
    async row(id) {
      return (await t.db.select('experiments', { id }))[0];
    },
    async variantRows(id) {
      return t.db.select('experiment_variants', { experiment_id: id }, { order: 'key.asc' });
    },
    /** Publish an SEO page through the pages API (no images unless given). */
    async publishPage(u, { projectId = 'proj-1', slug = 'joes-bakery', html, images = [], domain = null } = {}) {
      return ctx.x(u, 'PUT', `/api/pages/seo:${projectId}`, { kind: 'seo', slug, title: 'Joe’s Bakery', html, images, projectId, ...(domain ? { domain } : {}) });
    },
    /** A verified domain for a user (as if its TXT record had been found). */
    async domain(u) {
      await t.db.upsert('published_domains', { domain: DOMAIN, user_id: u.id, token: DOMAIN_TOKEN, verified_at: new Date(t.clock.t).toISOString() }, { onConflict: 'domain' });
    },
    sha: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
    isUuid: (s) => UUID.test(String(s)),
    async close() {
      mod.split.stopTimer();
      pages.close?.();
      await new Promise((r) => server.close(r));
      await t.close();
    },
  };
  return ctx;
}
