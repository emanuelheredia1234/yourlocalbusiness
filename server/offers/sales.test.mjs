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
