// Email A/B tests (P4b §S8): Omnisend's own A/B draft (type abTest: variants a and b, a test size, the winning
// metric and a decision time; Omnisend picks the winner), or, when Omnisend refuses that type for the brand, two
// regular drafts the customer sends to half of the list each (mode split). The app never sends: it makes drafts.
// The test counts in the month's limit when the draft is made; a draft that certainly wasn't made gives it back.
// Results: the hourly job (at most every 6 hours) reads Omnisend's pick and each version's sent, open and click
// rates (the email reports, inside REPORTS_PER_DAY). Omnisend's pick is the verdict for an abTest draft; our own math
// (math.mjs) decides the split fallback and is shown next to Omnisend's pick.

import { fail } from '../integrations/common.mjs';
import { EMAIL_EVERY_MS, WINDOW, HOUR_MS, iso, ms } from './config.mjs';
import { decide } from './math.mjs';
import { startTest } from './start.mjs';

const HEX24 = /^[0-9a-f]{24}$/;

/** deps: { store, billing, omnisend (server/omnisend.mjs routes: createAbDraft, abResults), now, log }. */
export function createEmailExperiments(deps) {
  const { store, omnisend, now = () => Date.now() } = deps;

  /** "Create A/B draft in Omnisend": the draft, then the test is running (counted). → { row, campaign, split? } */
  async function createDraft(who, e, b) {
    if (e.kind !== 'email') throw fail(400, 'BAD_REQUEST', 'This isn’t an email test.');
    if (e.state !== 'draft') throw fail(409, 'BAD_REQUEST', 'This email test already has its Omnisend draft.');
    if (!omnisend?.createAbDraft) throw fail(503, 'NOT_SET_UP', 'Omnisend isn’t set up on this app yet.');
    const v = b?.variants;
    if (!v || typeof v !== 'object' || typeof v.a !== 'object' || typeof v.b !== 'object' || !v.a || !v.b) throw fail(400, 'BAD_REQUEST', 'Both versions need a subject and a body.');
    const s = b.settings && typeof b.settings === 'object' ? b.settings : {};
    const settings = {
      testSizePercent: Number.isInteger(s.testSizePercent) ? Math.max(10, Math.min(50, s.testSizePercent)) : 30,
      decisionHours: Number.isInteger(s.decisionHours) ? Math.max(4, Math.min(48, s.decisionHours)) : 24,
      winningMetric: e.metric === 'click_rate' ? 'clickRate' : 'openRate',
    };
    // counted first (the limit is checked before anything is made in Omnisend); given back when nothing was made
    const { row: started, started: mine } = await startTest(deps, who, e, { endsAt: now() + settings.decisionHours * HOUR_MS + WINDOW.emailExtra });
    let made;
    try {
      made = await omnisend.createAbDraft(who.id, { name: e.name || '', variants: { a: v.a, b: v.b }, settings });
    } catch (err) {
      if (mine && !err?.campaignMayExist) await store.swap(who.id, e.id, 'running', { state: 'draft', started_at: null, counted_month: null, ends_at: null }).catch(() => {});
      if (typeof err?.status === 'number' && typeof err?.code === 'string') throw fail(err.status, err.code, err.publicMessage ?? err.message);
      throw err;
    }
    if (made.mode === 'omnisend_ab') {
      const id = HEX24.test(made.campaign.id) ? made.campaign.id : null;
      for (const key of ['a', 'b']) await store.patchVariant(who.id, e.id, key, { omnisend_campaign_id: id, omnisend_variant_id: made.campaign.variantIds?.[key] ?? null });
      return { row: (await store.byId(who.id, e.id)) ?? started, campaign: made.campaign };
    }
    for (const key of ['a', 'b']) await store.patchVariant(who.id, e.id, key, { omnisend_campaign_id: HEX24.test(made.campaigns[key]?.id) ? made.campaigns[key].id : null });
    const row = (await store.patch(who.id, e.id, { mode: 'split' })) ?? started;
    return {
      row,
      campaign: made.campaigns.a,
      split: { campaigns: made.campaigns, note: 'Omnisend doesn’t offer A/B tests for this brand, so two drafts were made. Send version A to half of your list and version B to the other half, using two segments you make in Omnisend.' },
    };
  }

  /** Read an email test's results and recompute its verdict. → { row } */
  async function readEmailTest(e, { force = false } = {}) {
    const t = now();
    const userId = e.user_id;
    const last = ms(e.last_read_at);
    const variants = await store.variants(userId, e.id);
    if (!force && last != null && t - last < EMAIL_EVERY_MS) return { row: e };
    const abId = e.mode === 'omnisend_ab' ? variants.find((v) => v.omnisend_campaign_id)?.omnisend_campaign_id ?? null : null;
    const got = omnisend?.abResults ? await omnisend.abResults(userId, { abCampaignId: abId }) : { status: 'error', errorCode: 'UNAVAILABLE' };
    if (got.status !== 'ok') {
      const code = got.errorCode === 'NEEDS_RECONNECT' ? 'reconnect' : got.errorCode === 'NOT_CONNECTED' ? 'not_connected' : 'unavailable';
      for (const v of variants) await store.patchVariant(userId, e.id, v.key, { metrics_error: code });
    } else {
      for (const v of variants) {
        const id = e.mode === 'omnisend_ab' ? v.omnisend_variant_id : v.omnisend_campaign_id;
        const r = id ? got.rates[id] : null;
        if (r) await store.patchVariant(userId, e.id, v.key, { metrics: { sent: r.sent, openRate: r.openRate, clickRate: r.clickRate }, metrics_at: iso(t), metrics_error: null });
      }
    }
    const fresh = await store.variants(userId, e.id);
    const endsAt = ms(e.ends_at);
    const ours = decide({ kind: 'email', mode: e.mode, changed: e.changed, metric: e.metric, endsAt, now: t, variants: fresh.map((v) => ({ key: v.key, metrics: v.metrics ?? {} })) });
    let result = ours;
    // Omnisend's own pick wins for its A/B draft (ours is shown beside it)
    const picked = got.status === 'ok' && got.winnerId ? fresh.find((v) => v.omnisend_variant_id === got.winnerId || v.omnisend_campaign_id === got.winnerId) : null;
    if (picked) result = { ...ours, verdict: 'winner', winner: picked.key, source: 'omnisend', ours: { verdict: ours.verdict, ...(ours.winner ? { winner: ours.winner } : {}) } };
    if (got.status === 'ok' && got.campaignStatus) result = { ...result, campaignStatus: got.campaignStatus };
    const finished = (picked && e.state === 'running') || (endsAt != null && t >= endsAt && e.state === 'running');
    const row = await store.patch(userId, e.id, { result, last_read_at: iso(t), ...(finished ? { state: 'finished' } : {}) });
    return { row: row ?? e };
  }

  return { createDraft, readEmailTest };
}
