// "Submit to Google" for the project's sales page (spec §1.6):
//   POST /api/seo/google/publish {projectId, confirm: true, resend?: true}  → {result: SeoPublishResult}
//   GET  /api/seo/google/status?projectId=                                  → {status: SeoGoogleStatus}
//
// Every address comes from the requester's own published page for this project (never from the browser).
//
// App-host page (https://<app>/<slug>): the owner's Search Console property (GSC_APP_PROPERTY) through treg's
// team connection. The sitemap is shared by every customer, so it is submitted at most once per 24 h across all
// users (claimed in appState before the call); URL inspection draws on the property's 2,000 a day (refused above
// 1,500, and above 20 per customer), at most once a week per page until it is indexed.
//
// Custom-domain page: the user's own connected Search Console. Steps, each one-shot and stored per page
// (seo_google_steps): the DNS TXT token, Verify, add the site, submit the domain's sitemap, inspect the page. A later
// press skips steps already 'ok'. A step whose outcome is 'unknown' is first checked with a read (sites, sitemaps);
// it is sent again only when the read doesn't show it AND the user confirmed (resend: true).
//
// Nothing here is retried by itself. There is no API to "request indexing": Google decides when to index.

import crypto from 'node:crypto';
import { ensureCustomer, fail, notSetUp, oneShot, seoPageIdFor } from '../integrations/common.mjs';
import { createKit } from '../analytics/http.mjs';
import { createRunner, publicCode } from '../analytics/runner.mjs';
import { loadProject, ownSeoPage, projectIdFrom } from '../analytics/snapshots.mjs';
import { appOrigin } from './sitemap.mjs';
import { domainProperty, inspectionFields } from './gsc.mjs';
import { claimInspection, claimStep, claimSubmit, inspectionDue, readSteps, recordSubmit, releaseSubmit, stillSending, writeStep } from './steps.mjs';

const PREFIX = '/api/seo/google/';
const STEP_ORDER = ['verify_token', 'verify', 'site_add', 'sitemap', 'inspect'];
/** treg error kinds that mean Google was never asked (or refused outright): the step failed, nothing was done. */
const DEFINITE = new Set(['bad_request', 'config', 'not_found', 'customer_cap', 'customer_blocked', 'too_expensive', 'team_unavailable']);
/** Of those, the ones where treg itself refused, so Google was never asked at all. */
const NEVER_SENT = new Set(['config', 'customer_cap', 'customer_blocked', 'too_expensive', 'team_unavailable']);

/** One attempt of a write: 'ok' | 'failed' | 'unknown' (+ the value). A treg refusal before anything happened is failed. */
async function attempt(fn) {
  return oneShot(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e?.kind && DEFINITE.has(e.kind)) return { status: 400, kind: e.kind };
      throw e;
    }
  });
}

export function createSeoGoogleRoutes(deps = {}) {
  const { db, storage, treg, connections, env = process.env, now = () => Date.now() } = deps;
  const kit = createKit(deps);

  const property = () => String(env.GSC_APP_PROPERTY || '').trim();

  async function setup(who, projectId) {
    await loadProject(db, who.id, projectId);
    const page = await ownSeoPage(db, who.id, projectId, appOrigin(env));
    return { page, pageId: seoPageIdFor(projectId) };
  }

  async function gscConnected(userId) {
    const all = await connections.status(userId).catch(() => []);
    return all.find((s) => s.platform === 'google_search_console')?.state === 'connected';
  }

  // ───────────── status ─────────────

  async function status(who, projectId) {
    const { page, pageId } = await setup(who, projectId);
    if (!page) return { host: null, published: false };
    const steps = await readSteps(db, who.id, pageId);
    const out = { host: page.host, published: true };
    if (page.host === 'custom') out.connected = await gscConnected(who.id);
    if (steps.sitemap?.outcome === 'ok') out.submittedAt = steps.sitemap.at;
    Object.assign(out, inspectionFields({ inspectionResult: { indexStatusResult: steps.inspect?.detail ?? {} } }));
    const list = STEP_ORDER.filter((s) => steps[s]).map((s) => ({ step: s, outcome: steps[s].outcome, at: steps[s].at }));
    if (list.length) out.steps = list;
    return out;
  }

  // ───────────── app-host page ─────────────

  async function publishApp(who, page, pageId, runner, customerTag) {
    const prop = property();
    if (!prop) throw notSetUp('Add GSC_APP_PROPERTY (https://yourlocalbusiness.replit.app/) once that Search Console property is verified.', 'Sending pages to Google isn’t set up on this app yet.');
    const origin = appOrigin(env);
    const steps = [];
    const stored = await readSteps(db, who.id, pageId);

    // 1. the shared sitemap: claimed before the call, so two presses at once submit once
    const claim = await claimSubmit(storage, now());
    if (!claim.won) {
      steps.push({ step: 'sitemap', outcome: 'skipped', alreadySubmittedAt: claim.at });
      // the page was in the sitemap when it went, and Google took that submit: it covers this page too (a
      // submit still in flight, failed or unknown covers nothing)
      if (claim.outcome === 'ok' && stored.sitemap?.outcome !== 'ok' && Date.parse(page.updatedAt) <= Date.parse(claim.at)) await writeStep(db, who.id, pageId, 'sitemap', 'ok', { shared: true }, Date.parse(claim.at));
    } else {
      const got = await attempt(() => runner.treg('gsc.submit', { siteUrl: prop, feedpath: `${origin}/sitemap.xml` }, 'gsc'));
      if (got.outcome === 'failed' && NEVER_SENT.has(got.value?.kind)) await releaseSubmit(storage, claim.at, claim.previous).catch(() => {});
      else await recordSubmit(storage, claim.at, got.outcome).catch(() => {});
      await writeStep(db, who.id, pageId, 'sitemap', got.outcome, {}, now());
      steps.push({ step: 'sitemap', outcome: got.outcome });
    }

    // 2. inspect the page (a read), within the property's and the customer's daily budget
    const last = stored.inspect;
    if (!inspectionDue(last, now())) {
      steps.push({ step: 'inspect', outcome: 'skipped', ...(last?.detail ?? {}) });
    } else if (!(await claimInspection(storage, customerTag, now()))) {
      steps.push({ step: 'inspect', outcome: 'skipped', detail: 'INSPECTION_QUOTA' });
    } else {
      try {
        const got = await runner.treg('gsc.inspect', { inspectionUrl: page.url, siteUrl: prop, languageCode: 'en-US' }, 'gsc');
        const fields = inspectionFields(got.data);
        await writeStep(db, who.id, pageId, 'inspect', 'ok', fields, now());
        steps.push({ step: 'inspect', outcome: 'ok', ...fields });
      } catch (e) {
        steps.push({ step: 'inspect', outcome: 'failed', detail: publicCode(e) });
      }
    }
    return { host: 'app', steps };
  }

  // ───────────── custom-domain page ─────────────

  async function publishCustom(who, page, pageId, runner, resend) {
    if (!(await gscConnected(who.id))) throw fail(409, 'NOT_CONNECTED', 'Connect Google Search Console to send pages on your own domain to Google.');
    const site = domainProperty(page.domain);
    const feed = `https://${page.domain}/sitemap.xml`;
    const steps = [];
    const stored = await readSteps(db, who.id, pageId);
    const google = (request) => runner.own('google_search_console', { oneShot: true, timeoutMs: 120_000, ...request });
    const read = (request) => runner.own('google_search_console', { oneShot: false, timeoutMs: 30_000, ...request });
    const dnsRecord = (token) => ({ type: 'TXT', name: page.domain, value: String(token).slice(0, 300) });

    /** A stored 'unknown' step: did it happen after all? (a read) → true / false / null (no read for it). */
    async function happened(step) {
      if (step === 'site_add') {
        const res = await read({ method: 'GET', path: '/v3/sites' });
        return Array.isArray(res?.body?.siteEntry) ? res.body.siteEntry.some((s) => s?.siteUrl === site) : false;
      }
      if (step === 'sitemap') {
        const res = await read({ method: 'GET', path: `/v3/sites/${encodeURIComponent(site)}/sitemaps` });
        return Array.isArray(res?.body?.sitemap) ? res.body.sitemap.some((s) => s?.path === feed) : false;
      }
      return null;
    }

    const WRITES = {
      verify_token: () => google({ method: 'POST', path: '/siteVerification/v1/token', baseUrlOverride: 'https://www.googleapis.com', body: { site: { type: 'INET_DOMAIN', identifier: page.domain }, verificationMethod: 'DNS_TXT' } }),
      verify: () => google({ method: 'POST', path: '/siteVerification/v1/webResource', baseUrlOverride: 'https://www.googleapis.com', query: { verificationMethod: 'DNS_TXT' }, body: { site: { type: 'INET_DOMAIN', identifier: page.domain } } }),
      site_add: () => google({ method: 'PUT', path: `/v3/sites/${encodeURIComponent(site)}` }),
      sitemap: () => google({ method: 'PUT', path: `/v3/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(feed)}` }),
    };

    for (const step of STEP_ORDER) {
      const before = stored[step];
      if (step === 'inspect') {
        if (!inspectionDue(before, now())) {
          steps.push({ step, outcome: 'skipped', ...(before?.detail ?? {}) });
          break;
        }
        const res = await read({ method: 'POST', path: '/v1/urlInspection/index:inspect', baseUrlOverride: 'https://searchconsole.googleapis.com', body: { inspectionUrl: page.url, siteUrl: site, languageCode: 'en-US' } }).catch(() => null);
        if (res?.status >= 200 && res.status < 300) {
          const fields = inspectionFields(res.body);
          await writeStep(db, who.id, pageId, step, 'ok', fields, now());
          steps.push({ step, outcome: 'ok', ...fields });
        } else steps.push({ step, outcome: 'failed' });
        break;
      }
      if (before?.outcome === 'ok') {
        steps.push({ step, outcome: 'skipped' });
        continue;
      }
      if (before?.outcome === 'unknown') {
        // another press is sending this step right now: never a second send
        if (stillSending(before, now())) throw fail(409, 'ALREADY_PUBLISHING', 'This page is already being sent to Google. Check again in a few minutes.');
        const done = await happened(step).catch(() => null);
        if (done === true) {
          const { sending: _sending, ...kept } = before.detail ?? {};
          await writeStep(db, who.id, pageId, step, 'ok', kept, now());
          steps.push({ step, outcome: 'ok' });
          continue;
        }
        if (!resend) {
          steps.push({ step, outcome: 'unknown', detail: 'CONFIRM_RESEND' });
          return { host: 'custom', steps };
        }
      }
      // claimed before the call (stored 'unknown'): two presses at once send once, and a crash mid-call leaves
      // 'unknown' for the next press to read and confirm, never a silent second send
      if (!(await claimStep(db, who.id, pageId, step, before ?? null, now()))) throw fail(409, 'ALREADY_PUBLISHING', 'This page is already being sent to Google. Check again in a few minutes.');
      const got = await attempt(WRITES[step]);
      let detail = {};
      if (step === 'verify_token' && got.outcome === 'ok') {
        const token = typeof got.value?.body?.token === 'string' ? got.value.body.token : '';
        if (!token) {
          await writeStep(db, who.id, pageId, step, 'failed', {}, now());
          steps.push({ step, outcome: 'failed' });
          return { host: 'custom', steps };
        }
        detail = { token: token.slice(0, 300) };
      }
      await writeStep(db, who.id, pageId, step, got.outcome, detail, now());
      steps.push({ step, outcome: got.outcome, ...(step === 'verify' && got.outcome === 'failed' ? { detail: 'DNS_RECORD_NOT_FOUND' } : {}) });
      // the TXT record has to be added at the DNS host before Verify: stop here and show it
      if (step === 'verify_token' && got.outcome === 'ok') return { host: 'custom', steps, dnsRecord: dnsRecord(detail.token) };
      if (got.outcome !== 'ok') {
        const token = stored.verify_token?.detail?.token;
        return { host: 'custom', steps, ...(step === 'verify' && token ? { dnsRecord: dnsRecord(token) } : {}) };
      }
    }
    return { host: 'custom', steps };
  }

  async function publish(who, body) {
    if (body.confirm !== true) throw fail(400, 'BAD_REQUEST', 'Confirm first.');
    const projectId = projectIdFrom(body.projectId);
    const { page, pageId } = await setup(who, projectId);
    if (!page) throw fail(409, 'BAD_REQUEST', 'Publish your page first.');
    const customerTag = await ensureCustomer(db, who.id, env);
    const runner = createRunner({ treg, connections, ctx: { userId: who.id, projectId, runId: crypto.randomUUID(), customerTag } });
    return page.host === 'app' ? publishApp(who, page, pageId, runner, customerTag) : publishCustom(who, page, pageId, runner, body.resend === true);
  }

  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith(PREFIX)) return false;
      const who = await kit.user(req, res);
      if (!who) return true;
      try {
        // everything here reads through treg (server/treg.mjs): until that wrapper is in this copy of the app,
        // these routes are plainly not set up (the owner's hint says why)
        if (treg?.stub) throw notSetUp('The treg wrapper (server/treg.mjs) isn’t built into this copy of the app yet.', 'Sending pages to Google isn’t available yet.');
        if (url.pathname === `${PREFIX}publish` && req.method === 'POST') {
          if (kit.limited(req, res, { key: `seo-google:user:${who.id}` })) return true;
          const result = await publish(who, await kit.body(req));
          kit.reply(req, res, 200, { result });
        } else if (url.pathname === `${PREFIX}status` && req.method === 'GET') {
          if (kit.limited(req, res, { key: `seo-google-read:user:${who.id}`, factor: 3 })) return true;
          kit.reply(req, res, 200, { status: await status(who, projectIdFrom(url.searchParams.get('projectId'))) });
        } else throw fail(404, 'NOT_FOUND', 'Not found.');
      } catch (e) {
        kit.failWith(req, res, e, who);
      }
      return true;
    },
    async forgetUser() {},
    async unforgetUser() {},
  };
}
