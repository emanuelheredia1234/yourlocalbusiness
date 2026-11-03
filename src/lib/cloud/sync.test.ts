// Cloud saving against a stand-in for Supabase (server/test/mock-supabase.mjs), through the real
// supabase-js client: rows, row-level security, Storage uploads and downloads.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createMockSupabase } from '../../../server/test/mock-supabase.mjs';
import { initial, useStore } from '@/store/useStore';
import { deleteBlob, getBlob, putBlob, safeStorage, setMediaAccount } from '@/lib/storage';
const localStorage_set = (k: string, v: string) => safeStorage.setItem(k, v);
import { chunkBySize, createSync, supabaseBackend, useSyncStatus } from './sync';
import { createMediaSync } from './media';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supa: any;
let client: SupabaseClient;
let userId: string;

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  const { user } = await supa.tokenFor('maker@example.com');
  userId = user.id;
  client = createClient(supa.url, supa.PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: 'maker@example.com', password: 'password123' });
  expect(error).toBeNull();
});
afterAll(() => supa.close());

/** A device opening the account for the first time. */
function newDevice() {
  const { version: _v, ...fresh } = initial();
  useStore.setState({ ...fresh, skills: [] });
  return createSync({ backend: supabaseBackend(client, userId), userId, delay: 5 });
}
const rows = () => (supa.tables.get('user_docs') ?? []) as { user_id: string; kind: string; id: string; data: Record<string, unknown>; updated_at: string }[];

describe('saving the workspace to the account', () => {
  beforeEach(() => {
    supa.tables.set('user_docs', []);
  });

  it('saves each change as its own row and opens it on another device', async () => {
    const a = newDevice();
    expect((await a.pull()).remoteEmpty).toBe(true);
    a.start();
    const s = useStore.getState();
    const projectId = s.createProject('product');
    s.updateBrand({ name: 'Candle Co' });
    s.addPosts([{ id: 'post_1', projectId, status: 'draft', platform: 'instagram', createdAt: 1, updatedAt: 1, headline: 'Hello', body: 'First post' } as never]);
    s.updateSettings((x) => ({ ...x, profile: { ...x.profile, name: 'Maya' }, theme: 'dark' }));
    expect(await a.flush()).toBe(true);
    a.stop();

    const saved = rows().map((r) => `${r.kind}:${r.id}`).sort();
    expect(saved).toEqual([`post:post_1`, `project:${projectId}`, 'settings:user']);
    expect(rows().every((r) => r.user_id === userId)).toBe(true);
    // theme is this device's choice, not the account's
    expect(rows().find((r) => r.kind === 'settings')?.data).toMatchObject({ profile: { name: 'Maya' }, useBrain: true });
    expect(JSON.stringify(rows().find((r) => r.kind === 'settings')?.data)).not.toContain('dark');
    a.forget();

    const b = newDevice();
    const r = await b.pull();
    expect(r).toMatchObject({ remoteEmpty: false, downloaded: 3 });
    const got = useStore.getState();
    expect(got.projects.map((p) => p.brand.name)).toEqual(['Candle Co']);
    expect(got.activeProjectId).toBe(projectId);
    expect(got.posts.map((p) => p.id)).toEqual(['post_1']);
    expect(got.settings.profile.name).toBe('Maya');
    expect(got.settings.theme).toBe('system');
    expect(b.pending()).toBe(0);
    b.forget();
  });

  it('downloads only what changed elsewhere, and removes what was deleted elsewhere', async () => {
    const a = newDevice();
    await a.pull();
    a.start();
    const s = useStore.getState();
    const p1 = s.createProject('product');
    const p2 = s.createProject('business');
    await a.flush();
    const fetches: string[] = [];
    const backend = supabaseBackend(client, userId);
    const watched = { ...backend, fetch: (kind: never, ids: string[]) => (fetches.push(...ids), backend.fetch(kind, ids)) };
    a.stop();
    const again = createSync({ backend: watched, userId, delay: 5 });
    await again.pull();
    expect(fetches).toEqual([]); // nothing new

    // another device renames p1 and deletes p2
    const row = rows().find((r) => r.id === p1)!;
    row.data = { ...row.data, brand: { ...(row.data.brand as object), name: 'Renamed elsewhere' } };
    row.updated_at = new Date(Date.now() + 1000).toISOString();
    supa.tables.set('user_docs', rows().filter((r) => r.id !== p2));
    const r = await again.pull();
    expect(fetches).toEqual([p1]);
    expect(r).toMatchObject({ downloaded: 1, removed: 1 });
    expect(useStore.getState().projects.map((p) => [p.id, p.brand.name])).toEqual([[p1, 'Renamed elsewhere']]);
    expect(useStore.getState().activeProjectId).toBe(p1);
    again.forget();
  });

  it('keeps changes made offline and saves them later, even after a reload', async () => {
    const a = newDevice();
    await a.pull();
    a.start();
    supa.behavior.down = true;
    const id = useStore.getState().createProject('product');
    expect(await a.flush()).toBe(false);
    expect(useSyncStatus.getState().problem).not.toBeNull();
    expect(useSyncStatus.getState().pending).toBeGreaterThan(0);
    a.stop();
    // reload: a new engine for the same account reads what's waiting
    supa.behavior.down = false;
    const b = createSync({ backend: supabaseBackend(client, userId), userId, delay: 5 });
    expect(b.pending()).toBeGreaterThan(0);
    await b.pull();
    expect(useStore.getState().projects.map((p) => p.id)).toEqual([id]); // not lost by the pull
    expect(await b.flush()).toBe(true);
    expect(rows().some((r) => r.id === id)).toBe(true);
    expect(useSyncStatus.getState().problem).toBeNull();
    b.forget();
  });

  it('sends deletions, and a change made during a save is saved next', async () => {
    const a = newDevice();
    await a.pull();
    a.start();
    const s = useStore.getState();
    const id = s.createProject('product');
    s.addPosts([{ id: 'post_x', projectId: id, status: 'draft', platform: 'x', createdAt: 2, updatedAt: 2, headline: 'x', body: 'x' } as never]);
    await a.flush();
    s.deletePosts(['post_x']);
    const saving = a.flush();
    useStore.getState().updateBrand({ name: 'Typed while saving' });
    await saving;
    await a.flush();
    expect(rows().some((r) => r.id === 'post_x')).toBe(false);
    expect((rows().find((r) => r.id === id)?.data.brand as { name: string }).name).toBe('Typed while saving');
    expect(a.pending()).toBe(0);
    a.stop();
    a.forget();
  });

  it('a deletion on another device beats a stale change here (e.g. an auto-published post)', async () => {
    const a = newDevice();
    await a.pull();
    a.start();
    const id = useStore.getState().createProject('product');
    useStore.getState().addPosts([{ id: 'post_due', projectId: id, status: 'scheduled', platform: 'x', createdAt: 3, updatedAt: 3, headline: 'x', body: 'x' } as never]);
    await a.flush();
    a.stop();
    // the phone deletes the post; this device, not yet up to date, publishes it
    supa.tables.set('user_docs', rows().filter((r) => r.id !== 'post_due'));
    const stale = createSync({ backend: supabaseBackend(client, userId), userId, delay: 5, refreshAfter: 0 });
    stale.start();
    useStore.getState().updatePost('post_due', { status: 'published' } as never);
    expect(await stale.flush()).toBe(true);
    expect(rows().some((r) => r.id === 'post_due')).toBe(false);
    expect(useStore.getState().posts.some((p) => p.id === 'post_due')).toBe(false);
    stale.stop();
    stale.forget();
  });

  it('never deletes from the account for save marks left without the workspace', async () => {
    const a = newDevice();
    await a.pull();
    a.start();
    const id = useStore.getState().createProject('product');
    await a.flush();
    a.stop();
    // marks from an interrupted sign-out, then a fresh open with a blank workspace
    localStorage_set(`ylb-sync:${userId}`, JSON.stringify({ v: {}, d: { [`project:${id}`]: 'up', 'settings:user': 'up' } }));
    const { version: _v, ...fresh } = initial();
    useStore.setState({ ...fresh, skills: [] });
    const leftover = createSync({ backend: supabaseBackend(client, userId), userId, delay: 5 });
    await leftover.flush();
    expect(rows().some((r) => r.id === id)).toBe(true);
    // a device opening the account for the first time starts with no marks at all
    expect(createSync({ backend: supabaseBackend(client, userId), userId, fresh: true }).pending()).toBe(0);
    leftover.forget();
  });

  it('can’t touch another account’s rows', async () => {
    const other = await supa.tokenFor('other@example.com');
    supa.tables.set('user_docs', [{ user_id: other.user.id, kind: 'project', id: 'proj_theirs', data: { id: 'proj_theirs' }, updated_at: new Date().toISOString() }]);
    const a = newDevice();
    expect((await a.pull()).remoteEmpty).toBe(true);
    expect(useStore.getState().projects).toEqual([]);
    await expect(supabaseBackend(client, other.user.id).upsert([{ kind: 'project', id: 'p', data: { id: 'p' } }])).rejects.toThrow(/row-level security/);
    a.forget();
  });
});

describe('files in the account', () => {
  it('uploads stored files, downloads them on another device, and deletes them', async () => {
    const m = createMediaSync(client, userId);
    setMediaAccount(userId, m);
    m.start();
    await putBlob('media_test1', new Blob(['hello photo'], { type: 'image/png' }));
    expect(await m.settle(5000)).toBe(true);
    const obj = supa.objects.get(`media/${userId}/media_test1`);
    expect(obj?.bytes.toString()).toBe('hello photo');
    expect(obj?.type).toBe('image/png');
    m.stop();

    // another device: nothing local, so it downloads once
    const m2 = createMediaSync(client, userId);
    setMediaAccount(userId, m2);
    m2.start();
    const blob = await getBlob('media_test1');
    expect(await blob?.text()).toBe('hello photo');
    expect(await getBlob('media_missing')).toBeNull();

    await deleteBlob('media_test1');
    expect(await m2.settle(5000)).toBe(true);
    expect(supa.objects.has(`media/${userId}/media_test1`)).toBe(false);
    m2.stop();
    m.forget();
    setMediaAccount(null, null);
  });
});

describe('batching', () => {
  it('splits big saves into requests of a sensible size', () => {
    const parts = chunkBySize([5, 5, 5, 20, 1], (n) => n, 10);
    expect(parts).toEqual([[5, 5], [5], [20], [1]]);
    expect(chunkBySize(Array.from({ length: 450 }, () => 1), (n) => n, 1e9).map((p) => p.length)).toEqual([200, 200, 50]);
  });
});
