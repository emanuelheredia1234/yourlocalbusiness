// Removing a failed launch (DELETE /api/ads/campaigns/:id?projectId=): only the signed-in user's own row in that
// business, only when it failed with nothing at the platform; its jobs go with it, one audit row says so, and
// nothing is ever sent to Zernio, Meta or Google.
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startAds } from './test-helpers.mjs';
import { GOOGLE_NOT_CREATED_WAIT_MS, removeKind, removeProblem, removeWords, REMOVE_CHECK_MANAGER, REMOVE_GOOGLE_WAIT, REMOVE_TOO_SOON } from './remove.mjs';
import { REVIEW_TTL_MS } from './preview.mjs';

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

/** past the launch confirm's 10 minutes (the job row is what keeps a review token to one launch) */
const later = () => {
  t.clock.t += REVIEW_TTL_MS + 60_000;
};
const listed = async (id) => (await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1')).body.campaigns.find((c) => c.id === id);

const remove = (who, id, projectId = 'proj-1') => t.call(who, 'DELETE', `/api/ads/campaigns/${id}?projectId=${projectId}`);
const calls = () => t.zm.calls.length;

describe('removing a failed launch', () => {
  it('removes the row and its jobs, writes one audit row, and calls nothing at the platform', async () => {
    await ready();
    const r = await refusedLaunch();
    later();
    expect((await listed(r.campaign.id)).canRemove).toBe(true);
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
    expect(audit.at(-1).summary).toMatch(/^Removed a failed launch \(.+, Meta\) from the list\. Nothing was created at Meta, so nothing changes there\.$/);
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
    later();
    expect((await remove(u, id)).status).toBe(200);
  });
});

describe('removing: review fixes', () => {
  it('waits out the launch confirm, so the same token can never launch again after a removal', async () => {
    await ready();
    const r = await refusedLaunch();
    expect(r.campaign.canRemove).toBeUndefined();
    const res = await remove(u, r.campaign.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TOO_SOON', error: REMOVE_TOO_SOON });
    expect(await t.row(r.campaign.id)).toBeDefined();
    const sameRequest = (await t.jobRow(r.job.id)).client_request_id;
    expect(sameRequest).toBeTruthy();
    later();
    expect((await remove(u, r.campaign.id)).status).toBe(200);
    // the open window resends the same confirm: the token has run out, nothing reaches Zernio
    const writes = t.writes().length;
    const again = await t.launch(u, r.preview.body.reviewToken, sameRequest);
    await t.settled();
    expect(again.status).toBe(409);
    expect(await t.db.select('ad_campaigns', { user_id: u.id })).toEqual([]);
    expect(t.writes().length).toBe(writes);
  });

  it('a refused create whose campaign Zernio kept, or couldn’t say, can’t be removed; one it deleted can, with true words', async () => {
    await ready();
    for (const cleanup of ['kept', 'unknown']) {
      t.zm.ads.fail('POST /ads/create', `created:${cleanup}`);
      const r = await t.launchPlan(u, 'meta');
      expect(r.campaign.state).toBe('failed');
      expect((await t.jobRow(r.job.id)).provider_ref.createdObjects).toEqual([expect.objectContaining({ type: 'campaign', cleanup })]);
      later();
      expect((await listed(r.campaign.id)).canRemove, cleanup).toBeUndefined();
      expect((await remove(u, r.campaign.id)).body).toMatchObject({ code: 'MAY_EXIST_AT_PLATFORM', error: REMOVE_CHECK_MANAGER });
      expect(await t.row(r.campaign.id)).toBeDefined();
    }
    t.zm.ads.fail('POST /ads/create', 'created:deleted');
    const r = await t.launchPlan(u, 'meta');
    later();
    const c = await listed(r.campaign.id);
    expect(c).toMatchObject({ canRemove: true, removeKind: 'deleted' });
    expect((await remove(u, r.campaign.id)).status).toBe(200);
    expect((await t.audit(u.id)).at(-1).summary).toMatch(/What it made at Meta was deleted again, so nothing changes there\.$/);
  });

  it('refuses a PARTIAL_LEFT job saved without its list (older rows)', async () => {
    await ready();
    const r = await refusedLaunch();
    await t.db.update('ad_jobs', { id: r.job.id }, { error_code: 'PARTIAL_LEFT', provider_ref: { sent: true } });
    later();
    expect((await remove(u, r.campaign.id)).body.code).toBe('MAY_EXIST_AT_PLATFORM');
  });

  it('an older job with platform ids blocks it, in the list and the route alike', async () => {
    await ready();
    const r = await refusedLaunch();
    const old = await t.jobRow(r.job.id);
    await t.db.update('ad_jobs', { id: old.id }, { provider_ref: { ids: { campaignId: '120000000009' } }, requested_at: new Date(t.clock.t - 60 * 60_000).toISOString() });
    await t.db.insert('ad_jobs', { ...old, id: crypto.randomUUID(), client_request_id: crypto.randomUUID(), review_nonce: null, provider_ref: { sent: false }, requested_at: new Date(t.clock.t).toISOString() });
    later();
    expect((await listed(r.campaign.id)).canRemove).toBeUndefined();
    expect((await remove(u, r.campaign.id)).body.code).toBe('MAY_EXIST_AT_PLATFORM');
  });

  it('writes the audit row first: when it can’t be recorded, nothing is removed', async () => {
    await ready();
    const r = await refusedLaunch();
    later();
    t.supa.behavior.fail = (method, pathname) => (method === 'POST' && pathname === '/rest/v1/ad_audit' ? { status: 503, body: { message: 'down' } } : null);
    try {
      const res = await remove(u, r.campaign.id);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('NOT_RECORDED');
    } finally {
      t.supa.behavior.fail = null;
    }
    expect(await t.row(r.campaign.id)).toBeDefined();
    expect(await t.jobRow(r.job.id)).toBeDefined();
  });
});

describe('removeProblem', () => {
  const row = (over = {}) => ({ state: 'failed', remote: {}, ...over });
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  it('a Google "not created" waits a day, and its words don’t claim more than the read showed', () => {
    const g = row({ platform: 'google' });
    const job = (ms) => [{ state: 'failed', error_code: 'NOT_CREATED', provider_ref: {}, requested_at: ago(ms) }];
    expect(removeProblem(g, job(REVIEW_TTL_MS + 60_000))).toMatchObject({ code: 'TOO_SOON', message: REMOVE_GOOGLE_WAIT });
    expect(removeProblem(g, job(GOOGLE_NOT_CREATED_WAIT_MS + 60_000))).toBeNull();
    expect(removeKind(g, job(0))).toBe('unseen');
    expect(removeWords('google', 'unseen')).toBe('Google showed none of it when it was checked, so nothing changes there.');
    expect(removeWords('meta', 'none')).toBe('Nothing was created at Meta, so nothing changes there.');
  });

  it('allows only a failed row with nothing at the platform', () => {
    expect(removeProblem(row(), [{ state: 'failed', provider_ref: { sent: false }, requested_at: ago(REVIEW_TTL_MS + 1000) }])).toBeNull();
    expect(removeProblem(row(), [{ state: 'failed', provider_ref: { sent: false }, requested_at: ago(1000) }])).toMatchObject({ code: 'TOO_SOON' });
    expect(removeProblem(row(), [{ state: 'failed', error_code: 'PARTIAL_LEFT', provider_ref: {} }])).toMatchObject({ code: 'MAY_EXIST' });
    expect(removeProblem(row({ state: 'ended' }))).toMatchObject({ code: 'NOT_FAILED' });
    expect(removeProblem(null)).toMatchObject({ code: 'NOT_FAILED' });
    expect(removeProblem(row(), [{ state: 'queued' }])).toMatchObject({ code: 'JOB_LIVE' });
    expect(removeProblem(row(), [{ state: 'failed', provider_ref: { leftBehind: [{ type: 'campaign', id: '1' }] } }])).toMatchObject({ code: 'MAY_EXIST' });
    expect(removeProblem(row(), [{ state: 'failed', provider_ref: { ids: { campaignId: '1' } } }])).toMatchObject({ code: 'MAY_EXIST' });
    expect(removeProblem(row({ remote: { adSetId: '2' } }))).toMatchObject({ code: 'MAY_EXIST' });
  });
});
