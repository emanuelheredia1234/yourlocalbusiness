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
    const c = changeFor(row(), ad('ad.status_changed', { adObject: { level: 'CAMPAIGN', platformId: '111' }, status: { raw: 'PAUSED' } }));
    expect(c.patch).toMatchObject({ configured_status: 'PAUSED', state: 'paused' });
    expect(changeFor(row(), ad('ad.status_changed', { adObject: { level: 'CAMPAIGN', platformId: '111' }, status: { raw: 'DELETED' } })).patch).toMatchObject({ state: 'ended', review: { deleted: true } });
    expect(changeFor(row(), ad('ad.status_changed', { status: { raw: 'WITH_ISSUES' } })).patch.state).toBe('with_issues');
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
});
