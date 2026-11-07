// The sale rule (server/offers/sales.mjs) and the SQL it mirrors (record_sale), and the mock database's copy of the
// offers tables and functions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SALE_RANK, SALE_STATUSES, mergeSale } from './sales.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createDb } from '../integrations/db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(here, '..', '..', 'supabase', 'migrations', '20261113000000_offers.sql'), 'utf8');
// P6 replaces record_sale (the fee fields): the newest definition is the one that runs
const CONNECT_SQL = fs.readFileSync(path.join(here, '..', '..', 'supabase', 'migrations', '20261118000000_stripe_connect.sql'), 'utf8');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const event = (over = {}) => ({
  user_id: U1,
  project_id: 'p1',
  offer_id: 'o'.repeat(22),
  provider: 'whop',
  environment: 'production',
  provider_account: 'biz_abcd1234',
  provider_payment_id: 'pay_1',
  provider_membership_id: null,
  status: 'paid',
  amount_minor: 4900,
  refunded_minor: 0,
  net_minor: 4500,
  currency: 'usd',
  buyer_email: 'buyer@example.com',
  paid_at: '2026-11-06T10:00:00.000Z',
  last_event_at: '2026-11-06T10:00:00.000Z',
  ...over,
});

describe('mergeSale', () => {
  it('inserts the first event', () => {
    const { outcome, row } = mergeSale(null, event());
    expect(outcome).toBe('inserted');
    expect(row).toMatchObject({ status: 'paid', amount_minor: 4900, refunded_minor: 0, currency: 'usd' });
  });

  it('keeps a repeated delivery', () => {
    const first = mergeSale(null, event()).row;
    expect(mergeSale(first, event()).outcome).toBe('kept');
  });

  it('never moves a sale backwards: failed after paid, pending after refunded', () => {
    const paid = mergeSale(null, event()).row;
    const late = mergeSale(paid, event({ status: 'failed', last_event_at: '2026-11-06T11:00:00.000Z' }));
    expect(late.row.status).toBe('paid');
    const refunded = mergeSale(paid, event({ status: 'refunded', refunded_minor: 4900, last_event_at: '2026-11-06T12:00:00.000Z' })).row;
    expect(refunded.status).toBe('refunded');
    expect(mergeSale(refunded, event({ status: 'pending', last_event_at: '2026-11-07T00:00:00.000Z' })).row.status).toBe('refunded');
  });

  it('a refund that arrives before the payment ends refunded', () => {
    const refund = mergeSale(null, event({ status: 'refunded', refunded_minor: 4900, last_event_at: '2026-11-06T12:00:00.000Z' })).row;
    const paid = mergeSale(refund, event({ last_event_at: '2026-11-06T10:00:00.000Z' }));
    expect(paid.row.status).toBe('refunded');
    expect(paid.row.refunded_minor).toBe(4900);
  });

  it('between pending and failed, the newer event wins', () => {
    const failed = mergeSale(null, event({ status: 'failed', last_event_at: '2026-11-06T10:00:00.000Z' })).row;
    expect(mergeSale(failed, event({ status: 'pending', last_event_at: '2026-11-06T09:00:00.000Z' })).row.status).toBe('failed');
    expect(mergeSale(failed, event({ status: 'pending', last_event_at: '2026-11-06T11:00:00.000Z' })).row.status).toBe('pending');
  });

  it('refunds only grow; a dispute is last', () => {
    let row = mergeSale(null, event()).row;
    row = mergeSale(row, event({ status: 'partially_refunded', refunded_minor: 1000, last_event_at: '2026-11-06T11:00:00.000Z' })).row;
    row = mergeSale(row, event({ status: 'partially_refunded', refunded_minor: 500, last_event_at: '2026-11-06T12:00:00.000Z' })).row;
    expect(row.refunded_minor).toBe(1000);
    row = mergeSale(row, event({ status: 'disputed', last_event_at: '2026-11-06T13:00:00.000Z' })).row;
    expect(row.status).toBe('disputed');
    expect(mergeSale(row, event({ status: 'refunded', refunded_minor: 4900 })).row.status).toBe('disputed');
  });

  it('fills what was missing, keeps what was set, never touches another user’s row', () => {
    const bare = mergeSale(null, event({ buyer_email: null, net_minor: null, amount_minor: 0 })).row;
    const filled = mergeSale(bare, event({ buyer_email: 'b@example.com' })).row;
    expect(filled).toMatchObject({ buyer_email: 'b@example.com', net_minor: 4500, amount_minor: 4900 });
    expect(mergeSale(filled, event({ buyer_email: 'other@example.com' })).row.buyer_email).toBe('b@example.com');
    expect(mergeSale(filled, event({ user_id: U2, status: 'refunded' })).outcome).toBe('kept');
  });

  it('has the same ranks as the SQL', () => {
    const body = /create or replace function public\.ylb_sale_rank[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(SQL)[1];
    const sqlRanks = Object.fromEntries([...body.matchAll(/when '([a-z_]+)' then (\d+)/g)].map((m) => [m[1], Number(m[2])]));
    expect(sqlRanks).toEqual({ ...SALE_RANK });
    expect(Object.keys(SALE_RANK).sort()).toEqual([...SALE_STATUSES].sort());
    // the same rule: same-or-later rank, or newer between pending and failed
    expect(SQL).toMatch(/ylb_sale_rank\(v_status\) >= public\.ylb_sale_rank\(r\.status\)\s+or \(v_at > r\.last_event_at and r\.status in \('pending', 'failed'\) and v_status in \('pending', 'failed'\)\)/);
    expect(SQL).toMatch(/n_refunded := greatest\(r\.refunded_minor, v_refunded\)/);
    expect(SQL).toMatch(/r\.user_id <> \(p->>'user_id'\)::uuid/);
  });

  it('P6: the newest record_sale keeps every P3 rule and sets the fee fields once (coalesce), as mergeSale does', () => {
    const fn = /create or replace function public\.record_sale\(p jsonb\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(CONNECT_SQL)[1];
    expect(fn).toMatch(/ylb_sale_rank\(v_status\) >= public\.ylb_sale_rank\(r\.status\)\s+or \(v_at > r\.last_event_at and r\.status in \('pending', 'failed'\) and v_status in \('pending', 'failed'\)\)/);
    expect(fn).toMatch(/n_refunded := greatest\(r\.refunded_minor, v_refunded\)/);
    expect(fn).toMatch(/r\.user_id <> \(p->>'user_id'\)::uuid/);
    for (const [col, cast] of [['checkout_session_id', ''], ['fee_pct', '::smallint'], ['fee_tier', ''], ['application_fee_id', ''], ['application_fee_minor', '::bigint']]) {
      expect(fn, col).toMatch(new RegExp(`coalesce\\(r\\.${col}, \\(?p->>'${col}'\\)?${cast.replace(/:/g, ':')}\\)`));
      expect(fn, col).toMatch(new RegExp(`${col} = n_`));
    }
    // the JS: set once, kept after
    let row = mergeSale(null, event({ provider: 'stripe', provider_payment_id: 'pi_1', checkout_session_id: 'cs_test_1', fee_pct: 3, fee_tier: 'launch', application_fee_minor: null })).row;
    expect(row).toMatchObject({ checkout_session_id: 'cs_test_1', fee_pct: 3, fee_tier: 'launch', application_fee_id: null, application_fee_minor: null });
    const later = mergeSale(row, event({ provider: 'stripe', provider_payment_id: 'pi_1', checkout_session_id: 'cs_test_2', fee_pct: 1, fee_tier: 'grow', application_fee_id: 'fee_1', application_fee_minor: 147 }));
    expect(later.outcome).toBe('updated');
    row = later.row;
    expect(row).toMatchObject({ checkout_session_id: 'cs_test_1', fee_pct: 3, fee_tier: 'launch', application_fee_id: 'fee_1', application_fee_minor: 147 });
    expect(mergeSale(row, event({ provider: 'stripe', provider_payment_id: 'pi_1', application_fee_id: 'fee_2', application_fee_minor: 1 })).outcome).toBe('kept');
  });
});

describe('the mock database’s offers tables', () => {
  let supa;
  let db;
  let uid;
  beforeAll(async () => {
    supa = await createMockSupabase().then((m) => m.start());
    db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
    uid = (await supa.tokenFor('seller@example.com')).user.id;
  });
  afterAll(() => supa.close());

  it('record_sale inserts, keeps and updates as the SQL does', async () => {
    const p = event({ user_id: uid, provider_payment_id: 'pay_mock1' });
    expect(await db.rpc('record_sale', { p })).toBe('inserted');
    expect(await db.rpc('record_sale', { p })).toBe('kept');
    // a later failed event: the status stays paid (only the event time moves)
    await db.rpc('record_sale', { p: { ...p, status: 'failed', last_event_at: '2026-11-07T00:00:00.000Z' } });
    expect((await db.select('sales', { provider_payment_id: 'pay_mock1' }))[0].status).toBe('paid');
    expect(await db.rpc('record_sale', { p: { ...p, status: 'refunded', refunded_minor: 4900, last_event_at: '2026-11-08T00:00:00.000Z' } })).toBe('updated');
    const rows = await db.select('sales', { provider_payment_id: 'pay_mock1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'refunded', refunded_minor: 4900, amount_minor: 4900 });
  });

  it('P6: record_sale_dispute keeps the newest; sale_downloaded stops at the limit; connect_alert counts', async () => {
    const p = event({ user_id: uid, provider: 'stripe', provider_payment_id: 'pi_mockdisp', checkout_session_id: 'cs_test_disp' });
    await db.rpc('record_sale', { p });
    const args = (status, at) => ({ p_provider: 'stripe', p_env: 'production', p_payment_id: 'pi_mockdisp', p_user: uid, p_status: status, p_amount: 4900, p_at: at });
    expect(await db.rpc('record_sale_dispute', args('needs_response', '2026-11-07T00:00:00.000Z'))).toBe('updated');
    expect(await db.rpc('record_sale_dispute', args('won', '2026-11-09T00:00:00.000Z'))).toBe('updated');
    // an older event after a newer one changes nothing
    expect(await db.rpc('record_sale_dispute', args('under_review', '2026-11-08T00:00:00.000Z'))).toBe('kept');
    expect(await db.rpc('record_sale_dispute', { ...args('lost', '2026-11-10T00:00:00.000Z'), p_user: U2 })).toBe('missing');
    let [s] = await db.select('sales', { provider_payment_id: 'pi_mockdisp' });
    expect(s).toMatchObject({ status: 'disputed', dispute_status: 'won', dispute_amount_minor: 4900, downloads: 0, fee_returned_minor: 0 });
    // a second session id on another payment is refused (one sale per session)
    await expect(db.rpc('record_sale', { p: event({ user_id: uid, provider: 'stripe', provider_payment_id: 'pi_other', checkout_session_id: 'cs_test_disp' }) })).rejects.toBeTruthy();
    expect(await db.rpc('sale_downloaded', { p_id: s.id, p_max: 2 })).toBe(1);
    expect(await db.rpc('sale_downloaded', { p_id: s.id, p_max: 2 })).toBe(2);
    expect(await db.rpc('sale_downloaded', { p_id: s.id, p_max: 2 })).toBeNull();
    [s] = await db.select('sales', { provider_payment_id: 'pi_mockdisp' });
    expect(s.downloads).toBe(2);
    await db.rpc('connect_alert', { p_kind: 'fee_return_failed', p_detail: { code: 'x' } });
    await db.rpc('connect_alert', { p_kind: 'fee_return_failed', p_detail: { code: 'y' } });
    const [a] = await db.select('connect_alerts', { kind: 'fee_return_failed' });
    expect(a).toMatchObject({ count: 2, detail: { code: 'y' }, resolved_at: null });
  });

  it('P6: connect_accounts: one live row per user and environment, one row per Stripe account; Stripe offers need an account and a price', async () => {
    const base = { user_id: uid, environment: 'sandbox', country: 'US', terms_version: 'v1', terms_accepted_at: new Date().toISOString(), create_key: 'k' };
    await db.insert('connect_accounts', { ...base, id: 'f'.repeat(22) });
    await expect(db.insert('connect_accounts', { ...base, id: 'g'.repeat(22) })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(db.insert('connect_accounts', { ...base, id: 'h'.repeat(22), environment: 'production', status: 'active' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await db.update('connect_accounts', { id: 'f'.repeat(22) }, { stripe_account_id: 'acct_abcdef123', status: 'onboarding' });
    await db.update('connect_accounts', { id: 'f'.repeat(22) }, { status: 'disconnected' });
    await db.insert('connect_accounts', { ...base, id: 'g'.repeat(22) });
    await expect(db.update('connect_accounts', { id: 'g'.repeat(22) }, { stripe_account_id: 'acct_abcdef123', status: 'onboarding' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const offer = { id: 'k'.repeat(22), user_id: uid, project_id: 'p1', title: 'Course', provider: 'stripe', provider_ref: {} };
    await expect(db.insert('offers', offer)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(db.insert('offers', { ...offer, connect_account_id: 'g'.repeat(22), price_minor: 0, currency: 'usd' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(db.insert('offers', { ...offer, connect_account_id: 'g'.repeat(22), price_minor: 900, currency: 'usd', delivery: { kind: 'file' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await db.insert('offers', { ...offer, connect_account_id: 'g'.repeat(22), price_minor: 900, currency: 'usd', delivery: { kind: 'file', fileId: 'm'.repeat(22) } });
    await expect(db.insert('lead_files', { id: 'n'.repeat(22), user_id: uid, project_id: 'p1', kind: 'file', purpose: 'paid' })).rejects.toBeTruthy();
  });

  it('offer_clicked counts; one live connection per environment', async () => {
    const row = { id: 'a'.repeat(22), user_id: uid, provider: 'whop', environment: 'sandbox', account_id: 'biz_abcd1234', key_ciphertext: 'x', key_last4: 'abcd' };
    await db.insert('payment_connections', row);
    await expect(db.insert('payment_connections', { ...row, id: 'b'.repeat(22) })).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.insert('payment_connections', { ...row, id: 'c'.repeat(22), environment: 'production' });
    await db.insert('offers', { id: 'd'.repeat(22), user_id: uid, project_id: 'p1', title: 'Course', provider: 'external', provider_ref: { url: 'https://buy.stripe.com/x' } });
    await expect(db.insert('offers', { id: 'e'.repeat(22), user_id: uid, project_id: 'p1', title: 'Course', provider: 'whop', provider_ref: {} })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await db.rpc('offer_clicked', { p_id: 'd'.repeat(22) });
    await db.rpc('offer_clicked', { p_id: 'd'.repeat(22) });
    const [o] = await db.select('offers', { id: 'd'.repeat(22) });
    expect(o.clicks).toBe(2);
    expect(o.created_at).toBeTruthy();
  });
});
