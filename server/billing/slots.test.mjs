// Project slots (spec §A1.4–A1.6, C1.9) against mock-supabase's emulation of the billing migration: claims serialise
// like the advisory lock, are idempotent, refuse a locked or over-the-limit business, never limit the owner, and the
// user_docs rule refuses a project write without an active slot only once plans are enforced. The real policy is
// checked on a Supabase branch (docs/integrations-setup.md), never claimed from this mock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createDb } from '../integrations/db.mjs';

let supa;
let db;

const userFetch = (token) => (path, init = {}) =>
  fetch(`${supa.url}${path}`, { ...init, headers: { apikey: supa.PUBLISHABLE, authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

async function claim(token, id) {
  const res = await userFetch(token)('/rest/v1/rpc/claim_project_slot', { method: 'POST', body: JSON.stringify({ p_project_id: id }) });
  return { status: res.status, body: await res.json() };
}
async function putProject(token, userId, id, prefer = 'resolution=merge-duplicates') {
  const res = await userFetch(token)('/rest/v1/user_docs?on_conflict=user_id,kind,id', { method: 'POST', headers: { prefer }, body: JSON.stringify([{ user_id: userId, kind: 'project', id, data: { name: id } }]) });
  return { status: res.status, body: res.status === 201 ? null : await res.json() };
}
const setEnforce = (on) => supa.tables.set('billing_settings', [{ id: 1, enforce: on, card_trial_days: 0, existing_trial_days: 30 }]);
const account = (userId, over = {}) => ({
  customer_tag: `cust_${'a'.repeat(24)}`,
  source: 'stripe',
  tier: 'launch',
  interval: 'month',
  status: 'active',
  extra_businesses: 0,
  comp_extra: 0,
  business_limit: 1,
  extra_keep: 0,
  cancel_at_period_end: false,
  ...over,
});

beforeAll(async () => {
  supa = await createMockSupabase({ projectSlots: true }).then((m) => m.start());
  db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
});
afterAll(() => supa.close());
beforeEach(() => {
  for (const t of ['user_docs', 'project_slots', 'billing_accounts', 'billing_settings']) supa.tables.set(t, []);
});

describe('claim_project_slot', () => {
  it('always answers ok while plans are not enforced, and a new project gets a slot through the trigger', async () => {
    const { token, user } = await supa.tokenFor('free@example.com');
    expect((await claim(token, 'p1')).body).toEqual({ ok: true, state: 'active' });
    expect((await putProject(token, user.id, 'p2')).status).toBe(201);
    expect(supa.tables.get('project_slots').map((r) => r.project_id).sort()).toEqual(['p1', 'p2']);
  });

  it('once enforced, the first business needs no plan (setup), a second does; idempotent for one it already holds', async () => {
    const { token, user } = await supa.tokenFor('noplan@example.com');
    setEnforce(true);
    expect((await claim(token, 'p1')).body).toEqual({ ok: true, state: 'active', used: 1, limit: 1, starter: true });
    expect((await claim(token, 'p1')).body).toEqual({ ok: true, state: 'active' });
    expect((await claim(token, 'p2')).body).toEqual({ ok: false, reason: 'plan_required' });
    await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: account(user.id), p_fetched_at: new Date().toISOString() });
    expect((await claim(token, 'p1')).body).toEqual({ ok: true, state: 'active' });
    expect((await claim(token, 'p2')).body).toEqual({ ok: false, reason: 'limit', used: 1, limit: 1 });
  });

  it('a plan that ended (its oldest business kept) never gets another free first business', async () => {
    const { token, user } = await supa.tokenFor('ended@example.com');
    setEnforce(true);
    await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: account(user.id, { business_limit: 2 }), p_fetched_at: new Date().toISOString() });
    expect((await claim(token, 'a')).body.ok).toBe(true);
    expect((await claim(token, 'b')).body.ok).toBe(true);
    await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: { ...account(user.id), status: 'canceled', ended_at: new Date().toISOString() }, p_fetched_at: new Date().toISOString() });
    expect((await claim(token, 'c')).body).toEqual({ ok: false, reason: 'plan_required' });
  });

  it('lets exactly one of two concurrent claims at limit − 1 through (serialised like the advisory lock)', async () => {
    const { token, user } = await supa.tokenFor('race@example.com');
    setEnforce(true);
    await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: account(user.id, { business_limit: 2 }), p_fetched_at: new Date().toISOString() });
    expect((await claim(token, 'first')).body.ok).toBe(true);
    const both = await Promise.all([claim(token, 'a'), claim(token, 'b')]);
    expect(both.filter((r) => r.body.ok)).toHaveLength(1);
    expect(both.find((r) => !r.body.ok).body).toMatchObject({ reason: 'limit', limit: 2 });
  });

  it('answers locked for a locked business, and never limits the owner (app_metadata or an owner row)', async () => {
    const { token, user } = await supa.tokenFor('locked@example.com');
    setEnforce(true);
    supa.tables.get('project_slots').push({ user_id: user.id, project_id: 'old', state: 'locked', claimed_at: new Date().toISOString(), locked_reason: 'limit' });
    expect((await claim(token, 'old')).body).toEqual({ ok: false, reason: 'locked', state: 'locked' });
    const owner = await supa.tokenFor('owner@example.com', 'password123', { appMetadata: { ylb_role: 'admin' } });
    for (let i = 0; i < 5; i++) expect((await claim(owner.token, `o${i}`)).body.ok).toBe(true);
    const ownerRow = await supa.tokenFor('owner2@example.com');
    await db.rpc('ylb_billing_apply', { p_user: ownerRow.user.id, p_row: account(ownerRow.user.id, { source: 'owner', tier: 'owner', business_limit: null, customer_tag: `cust_${'b'.repeat(24)}` }), p_fetched_at: null });
    for (let i = 0; i < 4; i++) expect((await claim(ownerRow.token, `x${i}`)).body.ok).toBe(true);
  });

  it('is for signed-in users only (the server and anonymous callers are refused)', async () => {
    const anon = await fetch(`${supa.url}/rest/v1/rpc/claim_project_slot`, { method: 'POST', headers: { apikey: supa.PUBLISHABLE, 'content-type': 'application/json' }, body: '{"p_project_id":"x"}' });
    expect(anon.status).toBe(401);
    await expect(db.rpc('claim_project_slot', { p_project_id: 'x' })).rejects.toMatchObject({ name: 'DbError' });
  });
});

describe('the user_docs rule and the triggers', () => {
  it('refuses a project insert or update without an active slot once enforced, and other kinds are untouched', async () => {
    const { token, user } = await supa.tokenFor('rule@example.com');
    setEnforce(true);
    await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: account(user.id), p_fetched_at: new Date().toISOString() });
    const refused = await putProject(token, user.id, 'p1');
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ code: '42501', message: 'new row violates row-level security policy for table "user_docs"' });
    expect((await claim(token, 'p1')).body.ok).toBe(true);
    expect((await putProject(token, user.id, 'p1')).status).toBe(201);
    // a post is not a project
    const post = await userFetch(token)('/rest/v1/user_docs', { method: 'POST', body: JSON.stringify([{ user_id: user.id, kind: 'post', id: 'x1', data: {} }]) });
    expect(post.status).toBe(201);
    // the business gets locked: its update is refused too
    supa.tables.get('project_slots').find((r) => r.project_id === 'p1').state = 'locked';
    expect((await putProject(token, user.id, 'p1')).status).toBe(403);
    const patch = await userFetch(token)(`/rest/v1/user_docs?user_id=eq.${user.id}&kind=eq.project&id=eq.p1`, { method: 'PATCH', body: JSON.stringify({ data: { name: 'x' } }) });
    expect(patch.status).toBe(403);
  });

  it('frees the slot when the project is deleted, and users can read but never write their slots', async () => {
    const { token, user } = await supa.tokenFor('del@example.com');
    expect((await putProject(token, user.id, 'p1')).status).toBe(201);
    const read = await userFetch(token)('/rest/v1/project_slots?select=project_id,state');
    expect(await read.json()).toEqual([{ project_id: 'p1', state: 'active' }]);
    const write = await userFetch(token)('/rest/v1/project_slots', { method: 'POST', body: JSON.stringify([{ user_id: user.id, project_id: 'p9', state: 'active' }]) });
    expect(write.status).toBe(401);
    const del = await userFetch(token)(`/rest/v1/user_docs?user_id=eq.${user.id}&kind=eq.project&id=eq.p1`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(supa.tables.get('project_slots')).toEqual([]);
  });
});

describe('the server functions', () => {
  it('ylb_billing_apply never lets an older read overwrite a newer one', async () => {
    const { user } = await supa.tokenFor('order@example.com');
    const t1 = '2026-11-01T00:00:00.000Z';
    const t2 = '2026-11-02T00:00:00.000Z';
    expect(await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: account(user.id, { tier: 'grow' }), p_fetched_at: t2 })).toBe(true);
    expect(await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: account(user.id, { tier: 'launch' }), p_fetched_at: t1 })).toBe(false);
    expect(supa.tables.get('billing_accounts')[0].tier).toBe('grow');
  });

  it('ylb_apply_slots locks above the limit newest first, keeps the oldest when the plan ends, and unlocks on a new plan', async () => {
    const { user } = await supa.tokenFor('apply@example.com');
    const base = Date.parse('2026-01-01T00:00:00Z');
    supa.tables.set('project_slots', ['a', 'b', 'c'].map((id, i) => ({ user_id: user.id, project_id: id, state: 'active', claimed_at: new Date(base + i * 1000).toISOString() })));
    setEnforce(true);
    await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: account(user.id, { business_limit: 2 }), p_fetched_at: '2026-11-01T00:00:00Z' });
    const state = () => Object.fromEntries(supa.tables.get('project_slots').map((r) => [r.project_id, `${r.state}${r.locked_reason ? `:${r.locked_reason}` : ''}`]));
    expect(state()).toEqual({ a: 'active', b: 'active', c: 'locked:limit' });
    await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: { status: 'canceled' }, p_fetched_at: '2026-11-02T00:00:00Z' });
    expect(state()).toEqual({ a: 'active', b: 'locked:plan_ended', c: 'locked:limit' });
    await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: { status: 'active', business_limit: 3 }, p_fetched_at: '2026-11-03T00:00:00Z' });
    expect(state()).toEqual({ a: 'active', b: 'active', c: 'active' });
    await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: { status: 'unpaid' }, p_fetched_at: '2026-11-04T00:00:00Z' });
    expect(state()).toEqual({ a: 'active', b: 'locked:payment', c: 'locked:payment' });
  });

  it('locks a business removed at period end when lock_at passes, and never unlocks it by itself', async () => {
    const { user } = await supa.tokenFor('remove@example.com');
    let clock = Date.parse('2026-11-10T00:00:00Z');
    supa.behavior.now = () => clock;
    try {
      setEnforce(true);
      supa.tables.set('project_slots', [
        { user_id: user.id, project_id: 'a', state: 'active', claimed_at: '2026-01-01T00:00:00Z' },
        { user_id: user.id, project_id: 'b', state: 'active', claimed_at: '2026-01-02T00:00:00Z', lock_at: '2026-11-20T00:00:00.000Z' },
      ]);
      await db.rpc('ylb_billing_apply', { p_user: user.id, p_row: account(user.id, { business_limit: 2 }), p_fetched_at: '2026-11-10T00:00:00Z' });
      expect(supa.tables.get('project_slots').every((r) => r.state === 'active')).toBe(true);
      clock = Date.parse('2026-11-21T00:00:00Z');
      await db.rpc('ylb_apply_slots', { p_user: user.id });
      expect(supa.tables.get('project_slots').find((r) => r.project_id === 'b')).toMatchObject({ state: 'locked', locked_reason: 'removed', lock_at: null });
    } finally {
      supa.behavior.now = null;
    }
  });

  it('ylb_choose_active_slots keeps the chosen ones (at most the limit, all theirs) and starts existing accounts on free Grow', async () => {
    const { user } = await supa.tokenFor('choose@example.com');
    supa.tables.set('project_slots', ['a', 'b', 'c'].map((id, i) => ({ user_id: user.id, project_id: id, state: 'active', claimed_at: new Date(1e12 + i).toISOString() })));
    supa.tables.set('user_docs', ['a', 'b', 'c'].map((id) => ({ user_id: user.id, kind: 'project', id, data: {} })));
    expect(await db.rpc('ylb_billing_start_existing', { p_days: 30, p_tags: { [user.id]: `cust_${'c'.repeat(24)}` } })).toBe(1);
    expect(supa.tables.get('billing_accounts')[0]).toMatchObject({ source: 'comp', tier: 'grow', status: 'trialing', business_limit: 3, comp_extra: 2 });
    expect(await db.rpc('ylb_billing_start_existing', { p_days: 30, p_tags: { [user.id]: `cust_${'c'.repeat(24)}` } })).toBe(0);
    supa.tables.get('billing_accounts')[0].business_limit = 2;
    setEnforce(true);
    expect(await db.rpc('ylb_choose_active_slots', { p_user: user.id, p_ids: ['a', 'b', 'c'] })).toMatchObject({ ok: false, reason: 'limit' });
    expect(await db.rpc('ylb_choose_active_slots', { p_user: user.id, p_ids: ['a', 'zzz'] })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await db.rpc('ylb_choose_active_slots', { p_user: user.id, p_ids: ['c', 'a'] })).toEqual({ ok: true, active: 2 });
    expect(supa.tables.get('project_slots').find((r) => r.project_id === 'b')).toMatchObject({ state: 'locked', locked_reason: 'limit' });
  });
});
