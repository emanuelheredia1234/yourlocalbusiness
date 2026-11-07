// The ad_jobs state machine (server/ads/jobs.mjs): a refused job keeps the refusal's safe fields (error_detail), and
// still finishes before 20261115000000_ad_job_error_detail.sql is run; a job reads back with our words for why.
import { describe, expect, it } from 'vitest';
import { DbError } from '../integrations/db.mjs';
import { createAdJobs, jobOut } from './jobs.mjs';
import { makeLog } from '../test/fakes.mjs';

const USER = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';
const JOB = '6f1d2a11-0b6f-4c58-9a0c-3a525d0e0e7c';

/** a db with one ad_jobs row; withColumn false: PostgREST refuses a patch naming error_detail (400 → BAD_REQUEST) */
function fakeDb({ withColumn = true } = {}) {
  const row = { id: JOB, user_id: USER, kind: 'launch', state: 'sending', error_code: null, provider_ref: { step: 'create' } };
  const writes = [];
  return {
    row,
    writes,
    async select(_t, f) {
      return f.id === row.id && f.user_id === row.user_id ? [{ ...row }] : [];
    },
    async update(_t, where, patch) {
      writes.push(patch);
      if (!withColumn && 'error_detail' in patch) throw new DbError(400, 'BAD_REQUEST', 'The database refused that value.');
      if (where.state && where.state !== row.state) return [];
      Object.assign(row, patch);
      return [{ ...row }];
    },
  };
}

const DETAIL = { status: 403, code: 'ad_account_payment_required', type: 'permission_error', hint: 'Add a card', fix: { url: 'https://business.facebook.com/billing_hub' } };

describe('finishing a refused job', () => {
  it('stores the refusal’s safe fields with the job, its category in error_code', async () => {
    const db = fakeDb();
    const jobs = createAdJobs({ db, now: () => Date.parse('2026-11-07T01:41:00Z') });
    const done = await jobs.finish(USER, JOB, { state: 'failed', code: 'PAYMENT_REQUIRED', ref: { sent: true }, detail: DETAIL });
    expect(done).toMatchObject({ state: 'failed', error_code: 'PAYMENT_REQUIRED', error_detail: DETAIL, provider_ref: { step: 'create', sent: true } });
    expect(db.writes).toHaveLength(1);
  });

  it('still finishes the job (without the detail) before the migration is run, and says so in the log', async () => {
    const db = fakeDb({ withColumn: false });
    const log = makeLog();
    const jobs = createAdJobs({ db, log });
    const done = await jobs.finish(USER, JOB, { state: 'failed', code: 'PAYMENT_REQUIRED', detail: DETAIL });
    expect(done).toMatchObject({ state: 'failed', error_code: 'PAYMENT_REQUIRED' });
    expect(done).not.toHaveProperty('error_detail');
    expect(db.writes.map((w) => 'error_detail' in w)).toEqual([true, false]);
    expect(log.events('ads_error_detail_not_saved')).toHaveLength(1);
    // a job with nothing to keep never names the column
    const other = fakeDb({ withColumn: false });
    await createAdJobs({ db: other }).finish(USER, JOB, { state: 'done' });
    expect(other.writes).toHaveLength(1);
  });
});

describe('a refused job as the app reads it', () => {
  const failed = (over = {}) => ({ id: JOB, kind: 'launch', state: 'failed', error_code: 'PAYMENT_REQUIRED', error_detail: DETAIL, request: { platform: 'meta', account: { currency: 'USD', timezone: 'America/Chicago' }, start: '2026-12-01', end: '2026-12-14', asap: false, days: 14 }, requested_at: '2026-11-07T01:40:00Z', ...over });

  it('our sentence for the code, what happened, the fix link', () => {
    expect(jobOut(failed(), 'meta')).toMatchObject({ state: 'failed', code: 'PAYMENT_REQUIRED', message: 'Add a payment method in Meta Ads Manager (Billing). Meta bills your ads to it; this app never charges for ad spend. Nothing was created and no money was spent.', fixUrl: 'https://business.facebook.com/billing_hub' });
    expect(JSON.stringify(jobOut(failed(), 'meta'))).not.toContain('Add a card');
  });

  it('a job finished before error_detail existed reads as before for anything but a short Meta launch', () => {
    expect(jobOut(failed({ error_code: 'REFUSED', error_detail: undefined }), 'meta').message).toBe('Meta refused the launch. Nothing was created and no money was spent.');
    expect(jobOut(failed({ kind: 'budget', error_code: 'REFUSED', error_detail: undefined }), 'meta').message).toBe('Meta refused this. Nothing was changed. Open Meta Ads Manager to see why.');
    const short = failed({ error_code: 'REFUSED', error_detail: undefined, request: { platform: 'meta', account: { timezone: 'America/Los_Angeles' }, start: '2026-11-06', end: '2026-11-06', asap: true, days: 1 } });
    expect(jobOut(short, 'meta').message).toMatch(/^Meta needs a daily-budget ad to run more than 24 hours/);
  });
});
