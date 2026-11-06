// Deleting a business disconnects its social accounts (each business has its own, one Upload-Post profile each), so
// its business slot comes back: from Settings, the assistant, a cancelled setup, a workspace reset or an import.
// One request per business that holds a slot, never retried; nothing for one without social accounts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ releaseProjectSocial: vi.fn(), getConnections: vi.fn() }));
vi.mock('@/lib/integrations/api', async (original) => ({ ...(await original<typeof import('@/lib/integrations/api')>()), ...api }));
vi.mock('./community', () => ({ pushMyListings: vi.fn(async () => undefined) }));

const { useAnalytics } = await import('@/store/analytics');
const { useAuth } = await import('@/lib/cloud/auth');
const { useStore } = await import('@/store/useStore');
const { newProject } = await import('@/store/defaults');
const { deleteProjectEverywhere, holdsSocialSlot, releaseSocialFor, socialDeleteNote } = await import('./projectActions');

const biz = (id: string) => ({ ...newProject('business', 'existing'), id });

beforeEach(() => {
  useAuth.setState({ phase: 'ready' });
  for (const f of Object.values(api)) f.mockReset();
  api.releaseProjectSocial.mockResolvedValue({ ok: true, freed: true });
  useStore.setState({ projects: [biz('biz-a'), biz('biz-b')], activeProjectId: 'biz-a' });
  useAnalytics.setState({ slots: { used: 1, cap: 3, projects: ['biz-b'] } });
});

describe('deleting a business', () => {
  it('disconnects its social accounts (one request) when it holds a slot, and says so in the confirm', async () => {
    expect(holdsSocialSlot('biz-b')).toBe(true);
    expect(socialDeleteNote('biz-b')).toBe(' Its connected social accounts are disconnected too, which frees one of your business slots.');
    deleteProjectEverywhere('biz-b');
    await vi.waitFor(() => expect(api.releaseProjectSocial).toHaveBeenCalledTimes(1));
    expect(api.releaseProjectSocial).toHaveBeenCalledWith('biz-b');
    expect(useStore.getState().projects.map((p) => p.id)).toEqual(['biz-a']);
    expect(useAnalytics.getState().slots).toEqual({ used: 0, cap: 3, projects: [] });
  });

  it('asks nothing for a business without social accounts (and the confirm doesn’t mention them)', async () => {
    expect(socialDeleteNote('biz-a')).toBe('');
    deleteProjectEverywhere('biz-a');
    await new Promise((r) => setTimeout(r, 10));
    expect(api.releaseProjectSocial).not.toHaveBeenCalled();
  });

  it('a reset or an import frees every gone business that holds a slot; with no slot list yet, it reads one first', async () => {
    useAnalytics.setState({ slots: { used: 2, cap: 3, projects: ['biz-a', 'biz-b'] } });
    await releaseSocialFor(['biz-a', 'biz-b', 'biz-c']);
    expect(api.releaseProjectSocial.mock.calls.map((c) => c[0])).toEqual(['biz-a', 'biz-b']);
    api.releaseProjectSocial.mockClear();
    useAnalytics.setState({ slots: undefined });
    api.getConnections.mockResolvedValue({ connections: [], available: ['facebook'], setUp: true, slots: { used: 1, cap: 3, projects: ['biz-c'] } });
    await releaseSocialFor(['biz-c']);
    expect(api.getConnections).toHaveBeenCalledTimes(1);
    expect(api.releaseProjectSocial.mock.calls.map((c) => c[0])).toEqual(['biz-c']);
    // social off: nothing to free, nothing sent
    api.releaseProjectSocial.mockClear();
    useAnalytics.setState({ slots: undefined });
    api.getConnections.mockResolvedValue({ connections: [], available: [], setUp: false });
    await releaseSocialFor(['biz-d']);
    expect(api.releaseProjectSocial).not.toHaveBeenCalled();
    // signed out: nothing is asked at all
    useAuth.setState({ phase: 'signed-out' });
    useAnalytics.setState({ slots: { used: 1, cap: 3, projects: ['biz-e'] } });
    api.getConnections.mockClear();
    await releaseSocialFor(['biz-e']);
    expect(api.getConnections).not.toHaveBeenCalled();
    expect(api.releaseProjectSocial).not.toHaveBeenCalled();
  });
});
