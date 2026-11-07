// Sending the sitemap to Google for the market (P7 S7), against a fake treg (no live calls): the owner's button submits
// once with the property and <origin>/sitemap.xml under the shared 24-hour claim; the cron only when the market
// changed; a refusal before Google was asked gives the claim back; team-level errors show only to the owner; a
// seller's change never calls treg; an unknown outcome is not sent again without a read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP, marketServer } from './test-helpers.mjs';
import { fakeTreg, tregError } from '../analytics/test-helpers.mjs';

const SUBMIT = 'google-search-console.x.webmasters-sitemaps-submit';
const READ = 'google-search-console.sitemaps';
let s;
let answer;
let alert;
beforeEach(async () => {
  answer = () => ({});
  alert = null;
  const treg = fakeTreg((id, req) => answer(id, req));
  treg.alert = async () => alert;
  s = await marketServer({ treg });
});
afterEach(async () => {
  await s.close();
});
const submits = () => s.treg.calls.filter((c) => c.endpointId === SUBMIT);

describe('the owner’s button', () => {
  it('submits once with the property and the app’s sitemap; a second press within 24 h is skipped', async () => {
    const owner = await s.user('owner@example.com', { isAdmin: true });
    expect((await s.call(owner, 'POST', '/api/market/admin/submit-sitemap', {})).status).toBe(400);
    const r = await s.call(owner, 'POST', '/api/market/admin/submit-sitemap', { confirm: true });
    expect(r.body).toEqual({ outcome: 'ok' });
    expect(submits()).toHaveLength(1);
    expect(submits()[0].request).toEqual({ method: 'PUT', query: { siteUrl: `${APP}/`, feedpath: `${APP}/sitemap.xml` } });
    expect(submits()[0].opts.oneShot).toBe(true);
    expect(submits()[0].ctx.userId).toBe(owner.id);
    const again = await s.call(owner, 'POST', '/api/market/admin/submit-sitemap', { confirm: true });
    expect(again.body).toMatchObject({ outcome: 'skipped', alreadySubmittedAt: expect.any(String) });
    expect(submits()).toHaveLength(1);
    const view = await s.call(owner, 'GET', '/api/market/admin');
    expect(view.body.submit).toMatchObject({ lastAt: expect.any(String), outcome: 'ok', changedSince: false, property: true });
  });

  it('a refusal before Google was asked gives the shared claim back; team_unavailable shows the owner alert', async () => {
    const owner = await s.user('owner2@example.com', { isAdmin: true });
    answer = (id) => {
      if (id === SUBMIT) throw tregError('team_unavailable');
      return {};
    };
    alert = { kind: 'insufficient_balance', at: new Date().toISOString() };
    const r = await s.call(owner, 'POST', '/api/market/admin/submit-sitemap', { confirm: true });
    expect(r.body.outcome).toBe('failed');
    expect(s.storage.documents.get('gsc:app:lastSubmit').value.at).toBeUndefined();
    const view = await s.call(owner, 'GET', '/api/market/admin');
    expect(view.body.alert).toEqual(alert);
    // a seller never sees it
    const seller = await s.user('seller@example.com');
    const mine = await s.call(seller, 'GET', '/api/market/public');
    expect(mine.text).not.toMatch(/insufficient|alert|team/);
  });

  it('without GSC_APP_PROPERTY: not set up, and no call', async () => {
    const t = await marketServer({ env: { GSC_APP_PROPERTY: '' } });
    try {
      const owner = await t.user('owner3@example.com', { isAdmin: true });
      const r = await t.call(owner, 'POST', '/api/market/admin/submit-sitemap', { confirm: true });
      expect([r.status, r.body.code]).toEqual([503, 'NOT_SET_UP']);
      expect(r.body.hint).toContain('GSC_APP_PROPERTY');
      expect(t.treg.calls).toHaveLength(0);
    } finally {
      await t.close();
    }
  });
});

describe('the daily job', () => {
  it('a seller’s change never calls treg; the cron submits only after a change, once', async () => {
    const owner = await s.user('cron-owner@example.com', { isAdmin: true });
    await s.call(owner, 'GET', '/api/market/admin');
    expect(await s.market.submitter.cron()).toEqual({ skipped: 'unchanged' });
    const a = await s.user('cron-seller@example.com');
    await s.put(a, 'lst_1', s.listing(a));
    expect(s.treg.calls).toHaveLength(0);
    expect((await s.market.submitter.cron()).outcome).toBe('ok');
    expect(submits()).toHaveLength(1);
    expect(await s.market.submitter.cron()).toEqual({ skipped: 'unchanged' });
    expect(submits()).toHaveLength(1);
  });

  it('nothing live, or no owner known yet: no call', async () => {
    const a = await s.user('cron-thin@example.com');
    await s.put(a, 'lst_1', s.listing(a, { coverPath: null }));
    expect(await s.market.submitter.cron()).toEqual({ skipped: 'nothing_live' });
    await s.put(a, 'lst_2', s.listing(a));
    expect(await s.market.submitter.cron()).toEqual({ skipped: 'no_owner' });
    expect(s.treg.calls).toHaveLength(0);
  });

  it('an unknown outcome is not sent again without the sitemaps read', async () => {
    const owner = await s.user('cron-unknown@example.com', { isAdmin: true });
    await s.call(owner, 'GET', '/api/market/admin');
    const a = await s.user('cron-unknown-seller@example.com');
    await s.put(a, 'lst_1', s.listing(a));
    answer = (id) => {
      if (id === SUBMIT) throw tregError('timeout');
      return {};
    };
    expect((await s.market.submitter.cron()).outcome).toBe('unknown');
    expect(submits()).toHaveLength(1);
    // the next day: the change is still newer than the claim; the read shows Google took it after the change
    s.advance(25 * 3_600_000);
    await s.put(a, 'lst_1', s.listing(a, { title: 'Changed title again' }));
    answer = (id) => (id === READ ? { sitemap: [{ path: `${APP}/sitemap.xml`, lastSubmitted: new Date(Date.now() + 26 * 3_600_000).toISOString() }] } : {});
    expect(await s.market.submitter.cron()).toEqual({ outcome: 'skipped', reason: 'already_submitted' });
    expect(s.treg.calls.filter((c) => c.endpointId === READ)).toHaveLength(1);
    expect(submits()).toHaveLength(1);
  });

  it('asks for both jobs, daily', () => {
    expect(s.market.cronJobs().map((j) => [j.name, j.dailyAtUtc])).toEqual([
      ['market-sweep', '04:20'],
      ['market-sitemap-submit', '05:40'],
    ]);
  });
});
