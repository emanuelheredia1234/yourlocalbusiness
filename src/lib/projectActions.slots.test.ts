// Every way of making a project claims its business slot first (spec §B2): the project menu and palette
// (startNewProject), Settings › Projects & data, the setup's first project, the assistant (which never buys), and a
// backup import. A full plan opens Add a business; no plan opens #plans; offline never creates anything.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const slots = vi.hoisted(() => ({ claimSlot: vi.fn() }));
vi.mock('@/lib/cloud/slots', async (orig) => ({ ...(await orig<typeof import('@/lib/cloud/slots')>()), ...slots }));
vi.mock('@/components/ui/leave', () => ({ confirmLeave: vi.fn(async () => true) }));
vi.mock('./router', async (orig) => ({ ...(await orig<typeof import('./router')>()), navigate: vi.fn(async () => true) }));

const { useStore } = await import('@/store/useStore');
const { useBilling } = await import('@/store/billing');
const { useUI } = await import('@/store/ui');
const { navigate } = await import('./router');
const { claimSlotsFor, createProjectWithSlot, startNewProject, startProject } = await import('./projectActions');

const ids = () => useStore.getState().projects.map((p) => p.id);
const paying = () => useBilling.setState({ account: { source: 'stripe', status: 'active' } as never, plan: { active: true, plan: 'launch' } as never, addOpen: false, afterAdd: null });

beforeEach(() => {
  slots.claimSlot.mockReset();
  useStore.setState({ projects: [], activeProjectId: null });
  useUI.setState({ toasts: [] });
  useBilling.setState({ addOpen: false, afterAdd: null, account: null, plan: null });
  vi.mocked(navigate).mockClear();
});

describe('createProjectWithSlot', () => {
  it('claims first, then creates the project with the same id', async () => {
    slots.claimSlot.mockResolvedValue({ ok: true });
    const id = await createProjectWithSlot('business', 'new');
    expect(id).toMatch(/^proj/);
    expect(slots.claimSlot).toHaveBeenCalledWith(id);
    expect(ids()).toEqual([id]);
    expect(useStore.getState().projects[0].track).toBe('business');
  });

  it('a full paid plan opens Add a business, and the project is made once one is added', async () => {
    paying();
    slots.claimSlot.mockResolvedValueOnce({ ok: false, reason: 'limit', limit: 1 });
    expect(await createProjectWithSlot('business')).toBeNull();
    expect(ids()).toEqual([]);
    const b = useBilling.getState();
    expect(b.addOpen).toBe(true);
    // the dialog bought a business: the same id's slot is claimed again, then the project is made
    slots.claimSlot.mockResolvedValueOnce({ ok: true });
    await b.afterAdd!();
    expect(ids()).toHaveLength(1);
    expect(slots.claimSlot.mock.calls[0][0]).toBe(slots.claimSlot.mock.calls[1][0]);
  });

  it('a full free plan only says so (nothing paid opens)', async () => {
    useBilling.setState({ account: { source: 'comp', status: 'active' } as never, plan: { active: true } as never });
    slots.claimSlot.mockResolvedValue({ ok: false, reason: 'limit', limit: 2 });
    expect(await createProjectWithSlot()).toBeNull();
    expect(useBilling.getState().addOpen).toBe(false);
    expect(useUI.getState().toasts.at(-1)?.title).toContain('Your plan includes 2 businesses');
  });

  it('no plan opens #plans; offline or locked only says so; nothing is created', async () => {
    slots.claimSlot.mockResolvedValueOnce({ ok: false, reason: 'plan_required' });
    expect(await createProjectWithSlot()).toBeNull();
    expect(navigate).toHaveBeenCalledWith('plans', { force: true });
    slots.claimSlot.mockResolvedValueOnce({ ok: false, reason: 'offline' });
    expect(await createProjectWithSlot()).toBeNull();
    expect(useUI.getState().toasts.at(-1)?.title).toContain('Couldn’t reach your account');
    expect(ids()).toEqual([]);
  });
});

describe('the project menu, the palette and the assistant', () => {
  it('startNewProject claims, creates and opens the setup', async () => {
    slots.claimSlot.mockResolvedValue({ ok: true });
    const id = await startNewProject('business');
    expect(id).not.toBeNull();
    expect(useStore.getState().projects[0]).toMatchObject({ id, track: 'business', wizardStep: 'start' });
    expect(navigate).toHaveBeenCalledWith('onboarding', { force: true });
  });

  it('the assistant (interactive: false) gets the refusal in words, and nothing paid opens', async () => {
    paying();
    slots.claimSlot.mockResolvedValue({ ok: false, reason: 'limit', limit: 1 });
    expect(await startProject('business', { interactive: false })).toEqual({ refused: 'Your plan has no free business slot. Add one in Settings › Plan.' });
    expect(useBilling.getState().addOpen).toBe(false);
    expect(navigate).not.toHaveBeenCalledWith('plans', expect.anything());
    expect(ids()).toEqual([]);
  });
});

describe('a backup import', () => {
  it('claims in order and stops at the plan’s limit (the rest wait, set aside)', async () => {
    slots.claimSlot.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: 'limit' });
    expect(await claimSlotsFor(['a', 'b', 'c'])).toEqual({ claimed: ['a'], refused: ['b', 'c'], offline: false });
    expect(slots.claimSlot).toHaveBeenCalledTimes(2);
  });

  it('a locked business doesn’t stop the others', async () => {
    slots.claimSlot.mockResolvedValueOnce({ ok: false, reason: 'locked' }).mockResolvedValueOnce({ ok: true });
    expect(await claimSlotsFor(['a', 'b'])).toEqual({ claimed: ['b'], refused: ['a'], offline: false });
  });
});

describe('every caller goes through the slot claim', () => {
  it('no page or component calls the store’s createProject directly', () => {
    const RAW = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const found = Object.entries(RAW)
      .filter(([, src]) => /createProject\(|\(s\) => s\.createProject/.test(src))
      .map(([file]) => file.replace(/^\/src\//, ''))
      .filter((file) => file !== 'store/useStore.ts');
    // projectActions and the setup's first project call it, after the claim
    expect(found.sort()).toEqual(['lib/projectActions.ts', 'pages/onboarding/Onboarding.tsx']);
  });
});
