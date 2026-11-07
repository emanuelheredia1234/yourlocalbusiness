// Removing a failed launch (DELETE /api/ads/campaigns/:id?projectId=): only the signed-in user's own row in that
// business, only when it failed with nothing at the platform; its jobs go with it, one audit row says so, and
// nothing is ever sent to Zernio, Meta or Google.
import { afterEach, describe, expect, it } from 'vitest';
import { startAds } from './test-helpers.mjs';
import { removeProblem, REMOVE_CHECK_MANAGER } from './remove.mjs';

let t;
let u;
afterEach(async () => {
  expect(t.violations()).toEqual([]);
  await t.close();
});

async function ready() {
  t = await startAds();
  u = await t.user('owner@acme.test');
  await t.project(u);
  await t.plan(u);
  await t.connect(u, 'meta_ads');
  await t.choose(u, 'meta');
}

/** a launch Meta refused outright: nothing created */
async function refusedLaunch() {
  t.zm.ads.fail('POST /ads/create', '403-payment');
  const r = await t.launchPlan(u, 'meta');
  expect(r.campaign.state).toBe('failed');
  return r;
}

const remove = (who, id, projectId = 'proj-1') => t.call(who, 'DELETE', `/api/ads/campaigns/${id}?projectId=${projectId}`);
const calls = () => t.zm.calls.length;

describe('removing a failed launch', () => {
  it('removes the row and its jobs, writes one audit row, and calls nothing at the platform', async () => {
    await ready();
    const r = await refusedLaunch();
    expect(r.campaign.canRemove).toBe(true);
    const before = calls();
    const auditBefore = (await t.audit(u.id)).length;
    const res = await remove(u, r.campaign.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: r.campaign.id });
    expect(calls()).toBe(before);
    expect(await t.row(r.campaign.id)).toBeUndefined();
    expect(await t.jobRow(r.job.id)).toBeUndefined();
    const audit = await t.audit(u.id);
    expect(audit).toHaveLength(auditBefore + 1);
    // earlier rows are kept as they were (append-only)
    expect(audit.at(-1)).toMatchObject({ action: 'remove', outcome: 'done', actor: 'customer', campaign_id: r.campaign.id, project_id: 'proj-1' });
    expect(audit.at(-1).summary).toMatch(/^Removed a failed launch/);
    expect(audit.some((a) => a.action === 'launch')).toBe(true);
    // the list no longer has it
    const list = await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1');
    expect(list.body.campaigns).toEqual([]);
    // a second press: not found, nothing else written
    expect((await remove(u, r.campaign.id)).status).toBe(404);
    expect(await t.audit(u.id)).toHaveLength(auditBefore + 1);
  });

  it('another user can’t remove it (404), nor can the same user from another business', async () => {
    await ready();
    const r = await refusedLaunch();
    const other = await t.user('other@else.test');
    await t.project(other);
    expect((await remove(other, r.campaign.id)).status).toBe(404);
    await t.project(u, 'proj-2');
    expect((await remove(u, r.campaign.id, 'proj-2')).status).toBe(404);
    expect((await remove(u, r.campaign.id, '')).status).toBe(400);
    expect((await remove(u, 'not-a-uuid')).status).toBe(404);
    expect(await t.row(r.campaign.id)).toBeDefined();
  });

  it('refuses a campaign that isn’t failed', async () => {
    await ready();
    const r = await t.launchPlan(u, 'meta');
    expect(r.campaign.state).not.toBe('failed');
    expect(r.campaign.canRemove).toBeUndefined();
    const res = await remove(u, r.campaign.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_FAILED');
    expect(await t.row(r.campaign.id)).toBeDefined();
  });

  it('refuses a failed launch that left parts at Meta, with the plain words to check Ads Manager', async () => {
    await ready();
    t.zm.ads.fail('POST /ads/create', '503-left-behind');
    const r = await t.launchPlan(u, 'meta');
    expect(r.campaign.state).toBe('failed');
    expect(r.campaign.canRemove).toBeUndefined();
    const before = calls();
    const res = await remove(u, r.campaign.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'MAY_EXIST_AT_PLATFORM', error: REMOVE_CHECK_MANAGER });
    expect(calls()).toBe(before);
    expect(await t.row(r.campaign.id)).toBeDefined();
    expect(await t.jobRow(r.job.id)).toBeDefined();
  });

  it('refuses a failed row with a platform campaign id, or a job that may have happened or is still sending', async () => {
    await ready();
    const r = await refusedLaunch();
    const id = r.campaign.id;
    await t.db.update('ad_campaigns', { id }, { remote: { campaignId: '120000000001' } });
    expect((await remove(u, id)).body.code).toBe('MAY_EXIST_AT_PLATFORM');
    await t.db.update('ad_campaigns', { id }, { remote: {} });
    await t.db.update('ad_jobs', { id: r.job.id }, { state: 'unknown' });
    expect((await remove(u, id)).body).toMatchObject({ code: 'JOB_LIVE' });
    await t.db.update('ad_jobs', { id: r.job.id }, { state: 'sending' });
    expect((await remove(u, id)).body).toMatchObject({ code: 'JOB_LIVE' });
    await t.db.update('ad_jobs', { id: r.job.id }, { state: 'failed', provider_ref: { createdObjects: [{ type: 'campaign', id: '1', cleanup: 'unknown' }] } });
    expect((await remove(u, id)).body.code).toBe('MAY_EXIST_AT_PLATFORM');
    // objects Zernio did delete are gone: removable
    await t.db.update('ad_jobs', { id: r.job.id }, { provider_ref: { sent: true, createdObjects: [{ type: 'campaign', id: '1', cleanup: 'deleted' }] } });
    expect((await remove(u, id)).status).toBe(200);
  });
});

describe('removeProblem', () => {
  const row = (over = {}) => ({ state: 'failed', remote: {}, ...over });
  it('allows only a failed row with nothing at the platform', () => {
    expect(removeProblem(row(), [{ state: 'failed', provider_ref: { sent: false } }])).toBeNull();
    expect(removeProblem(row({ state: 'ended' }))).toMatchObject({ code: 'NOT_FAILED' });
    expect(removeProblem(null)).toMatchObject({ code: 'NOT_FAILED' });
    expect(removeProblem(row(), [{ state: 'queued' }])).toMatchObject({ code: 'JOB_LIVE' });
    expect(removeProblem(row(), [{ state: 'failed', provider_ref: { leftBehind: [{ type: 'campaign', id: '1' }] } }])).toMatchObject({ code: 'MAY_EXIST' });
    expect(removeProblem(row(), [{ state: 'failed', provider_ref: { ids: { campaignId: '1' } } }])).toMatchObject({ code: 'MAY_EXIST' });
    expect(removeProblem(row({ remote: { adSetId: '2' } }))).toMatchObject({ code: 'MAY_EXIST' });
  });
});
