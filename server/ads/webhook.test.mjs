// Ad events (server/ads/webhook.mjs): only rows of that connection AND that platform id change; review reasons stay
// cut text; nothing is ever sent to Zernio. The dispatch from the one Zernio webhook is tested in
// server/connections/zernio.test.mjs, and the whole path in routes.test.mjs.
import { describe, expect, it } from 'vitest';
import { changeFor, createAdsWebhook, rowsFor } from './webhook.mjs';
import { makeDb } from '../test/fakes.mjs';

const UID = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';
const ZID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const row = (extra = {}) => ({ id: 'c1', user_id: UID, customer_tag: 'cust_x', project_id: 'proj-1', platform: 'meta', zernio_account_id: ZID, ad_account_id: 'act_1', state: 'in_review', configured_status: 'ACTIVE', review: {}, remote: { campaignId: '111', adSetId: '222', adIds: ['333'], zernioAdIds: ['bbbbbbbbbbbbbbbbbbbbbbbb'] }, ...extra });
const ad = (event, extra = {}) => ({ id: 'evt1', event, account: { accountId: ZID }, adObject: { level: 'AD', platformId: '333', platformAdAccountId: 'act_1', adId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, ...extra });

describe('which rows an event is about', () => {
  it('matches by the platform id at the event’s level and the ad account', () => {
    expect(rowsFor([row()], ad('ad.review.rejected'))).toHaveLength(1);
    expect(rowsFor([row()], ad('ad.review.rejected', { adObject: { level: 'AD', platformId: '999', platformAdAccountId: 'act_1' } }))).toHaveLength(0);
    expect(rowsFor([row()], ad('ad.review.rejected', { adObject: { level: 'AD', platformId: '333', platformAdAccountId: 'act_2' } }))).toHaveLength(0);
    expect(rowsFor([row()], ad('ad.status_changed', { adObject: { level: 'CAMPAIGN', platformId: '111', platformAdAccountId: '1' } }))).toHaveLength(1);
    expect(rowsFor([row()], { event: 'ad_account.status_changed', adAccount: { platformAdAccountId: 'act_1' } })).toHaveLength(1);
    expect(rowsFor([row()], ad('ad.review.rejected', { adObject: { name: 'Winter pipes · Meta · YLB 1a2b3c4d5e6f' } }))).toHaveLength(0);
  });
});

describe('what an event changes', () => {
  it('a rejection: rejected, reasons as cut text', () => {
    const c = changeFor(row(), ad('ad.review.rejected', { review: { reasons: [{ message: `<b>x</b>${'y'.repeat(300)}` }, 'two'] } }));
    expect(c.patch.state).toBe('rejected');
    expect(c.patch.review.reasons[0]).toHaveLength(200);
    expect(c.patch.review.reasons[1]).toBe('two');
  });

  it('an approval: active when the switch is on, still paused when it isn’t', () => {
    expect(changeFor(row(), ad('ad.review.approved')).patch.state).toBe('active');
    expect(changeFor(row({ state: 'paused', configured_status: 'PAUSED' }), ad('ad.review.approved')).patch).toMatchObject({ state: 'paused', review: { status: 'approved' } });
  });

  it('a campaign switched in Ads Manager changes what counts as committed', () => {
    const c = changeFor(row(), ad('ad.status_changed', { adObject: { level: 'CAMPAIGN', platformId: '111' }, status: { raw: 'PAUSED' }, timestamp: '2026-11-06T10:00:00Z' }));
    expect(c.patch).toMatchObject({ configured_status: 'PAUSED', state: 'paused', remote: { switchEventAt: '2026-11-06T10:00:00.000Z' } });
    expect(changeFor(row(), ad('ad.status_changed', { adObject: { level: 'CAMPAIGN', platformId: '111' }, status: { raw: 'DELETED' } })).patch).toMatchObject({ state: 'ended', review: { deleted: true } });
    expect(changeFor(row(), ad('ad.status_changed', { status: { raw: 'WITH_ISSUES' } })).patch.state).toBe('with_issues');
  });

  it('an old or out-of-order switch event never lowers the switch over our own newer or unconfirmed write', () => {
    const paused = (ts) => ad('ad.status_changed', { adObject: { level: 'CAMPAIGN', platformId: '111' }, status: { raw: 'PAUSED' }, ...(ts ? { timestamp: ts } : {}) });
    const ownAt = Date.parse('2026-11-06T10:00:00Z');
    // the customer resumed from the app at 10:00; a PAUSED event from 09:30 (redelivered) arrives after
    expect(changeFor(row(), paused('2026-11-06T09:30:00Z'), Date.now(), { at: ownAt, live: false })).toBeNull();
    // a write still going or unconfirmed: no switch event touches the row
    expect(changeFor(row(), paused('2026-11-06T11:00:00Z'), Date.now(), { at: 0, live: true })).toBeNull();
    // an event older than the last switch event applied
    expect(changeFor(row({ remote: { campaignId: '111', switchEventAt: '2026-11-06T12:00:00.000Z' } }), paused('2026-11-06T11:00:00Z'))).toBeNull();
    // no time on the event: it may raise the switch, never lower it
    expect(changeFor(row(), paused(null))).toBeNull();
    expect(changeFor(row({ configured_status: 'PAUSED', state: 'paused' }), ad('ad.status_changed', { adObject: { level: 'CAMPAIGN', platformId: '111' }, status: { raw: 'ACTIVE' } })).patch).toMatchObject({ configured_status: 'ACTIVE' });
    // launching and unknown rows keep their switch too
    for (const state of ['launching', 'unknown']) expect(changeFor(row({ state }), paused('2026-11-06T11:00:00Z'))).toBeNull();
    // newer than our write: applied
    expect(changeFor(row(), paused('2026-11-06T10:05:00Z'), Date.now(), { at: ownAt, live: false }).patch.configured_status).toBe('PAUSED');
  });

  it('one refused ad of three leaves the campaign running; all three refused, it is refused', () => {
    const three = row({ remote: { campaignId: '111', adSetId: '222', adIds: ['331', '332', '333'], zernioAdIds: ['z1', 'z2', 'z3'] } });
    const refuse = (n, adId) => ad('ad.review.rejected', { adObject: { level: 'AD', platformId: n, platformAdAccountId: 'act_1', adId } });
    const one = changeFor(three, refuse('332', 'z2'));
    expect(one.patch.state).toBe('in_review');
    expect(one.patch.review.adsRejected).toEqual(['z2']);
    expect(one.summary).toMatch(/one of the ads/);
    let r = { ...three, review: one.patch.review };
    r = { ...r, review: changeFor(r, refuse('331')).patch.review };
    const all = changeFor(r, refuse('333', 'z3'));
    expect(all.patch).toMatchObject({ state: 'rejected', review: { status: 'rejected' } });
    expect(all.patch.review.adsRejected.sort()).toEqual(['z1', 'z2', 'z3']);
  });

  it('never moves an ended, failed, launching or unknown row', () => {
    for (const state of ['ended', 'failed', 'launching', 'unknown']) expect(changeFor(row({ state }), ad('ad.review.rejected')).patch.state).toBe(state);
  });

  it('an ad account restricted is a note on the row, not a state', () => {
    const c = changeFor(row(), { event: 'ad_account.status_changed', status: { current: 'restricted' } });
    expect(c.patch).toEqual({ review: { account: 'restricted' } });
  });
});

describe('fromWebhook', () => {
  it('updates only the user’s rows on that connection and writes a platform audit line', async () => {
    const db = makeDb();
    await db.insert('ad_campaigns', [row(), row({ id: 'c2', zernio_account_id: 'aaaaaaaaaaaaaaaaaaaaaaa9' }), row({ id: 'c3', user_id: '7d1e2b3c-4a5f-4b6c-8d7e-9f0a1b2c3d4e' })]);
    const lines = [];
    const fromWebhook = createAdsWebhook({ db, audit: { append: async (e) => void lines.push(e) } });
    expect(await fromWebhook(UID, ZID, ad('ad.review.rejected'))).toBe(1);
    const rows = await db.select('ad_campaigns', {});
    expect(rows.map((r) => [r.id, r.state])).toEqual([['c1', 'rejected'], ['c2', 'in_review'], ['c3', 'in_review']]);
    expect(lines).toEqual([expect.objectContaining({ actor: 'platform', action: 'review', campaignId: 'c1', outcome: 'info' })]);
    expect(await fromWebhook(UID, ZID, { event: 'post.published' })).toBe(0);
  });

  it('the ads tables not there yet (migration not run): nothing changes, no throw', async () => {
    const err = Object.assign(new Error('missing'), { name: 'DbError', code: 'NOT_SET_UP' });
    const db = { enabled: true, select: async () => Promise.reject(err) };
    const fromWebhook = createAdsWebhook({ db, audit: { append: async () => {} }, log: { log() {}, warn() {}, error() {} } });
    expect(await fromWebhook(UID, ZID, ad('ad.review.rejected'))).toBe(0);
  });
});
