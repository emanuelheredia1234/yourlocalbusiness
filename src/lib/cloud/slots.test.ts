// Claiming a business slot before a project is created (spec §B2): skipped in the artifact build, signed out or as a
// guest, and while plans aren't enforced; otherwise the database's claim_project_slot decides, and no answer is
// never treated as ok.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./auth', async (orig) => {
  const real = await orig<typeof import('./auth')>();
  return { ...real, marketAccess: () => (real.useAuth.getState().phase === 'ready' ? { client: { rpc }, userId: 'u1' } : null) };
});

const { useAuth } = await import('./auth');
const { useBilling } = await import('@/store/billing');
const { claimSlot, slotMessage, slotsNeeded } = await import('./slots');

beforeEach(() => {
  rpc.mockReset();
  useAuth.setState({ phase: 'ready' });
  useBilling.setState({ enforce: true });
});
afterEach(() => vi.unstubAllGlobals());

describe('claimSlot', () => {
  it('asks the database once, with the project id', async () => {
    rpc.mockResolvedValue({ data: { ok: true, state: 'active', used: 2, limit: 3 }, error: null });
    expect(await claimSlot('proj_1')).toEqual({ ok: true, state: 'active', used: 2, limit: 3 });
    expect(rpc).toHaveBeenCalledWith('claim_project_slot', { p_project_id: 'proj_1' });
  });

  it('passes the database’s refusal on: limit, plan_required, locked', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, reason: 'limit', used: 1, limit: 1 }, error: null });
    expect(await claimSlot('p')).toEqual({ ok: false, reason: 'limit', used: 1, limit: 1 });
    rpc.mockResolvedValueOnce({ data: { ok: false, reason: 'plan_required' }, error: null });
    expect(await claimSlot('p')).toMatchObject({ ok: false, reason: 'plan_required' });
    rpc.mockResolvedValueOnce({ data: { ok: false, reason: 'locked' }, error: null });
    expect(await claimSlot('p')).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('no answer (network, an error, a throw) is offline: never ok', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'fetch failed' } });
    expect(await claimSlot('p')).toEqual({ ok: false, reason: 'offline' });
    rpc.mockRejectedValueOnce(new Error('network'));
    expect(await claimSlot('p')).toEqual({ ok: false, reason: 'offline' });
  });

  it('is skipped (ok) while plans aren’t enforced, signed out, as a guest, and in the artifact build', async () => {
    useBilling.setState({ enforce: false });
    expect(await claimSlot('p')).toEqual({ ok: true, skipped: true });
    useBilling.setState({ enforce: true });
    for (const phase of ['guest', 'off', 'signed-out'] as const) {
      useAuth.setState({ phase });
      expect(slotsNeeded()).toBe(false);
      expect(await claimSlot('p')).toEqual({ ok: true, skipped: true });
    }
    useAuth.setState({ phase: 'ready' });
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(await claimSlot('p')).toEqual({ ok: true, skipped: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('says a refusal in our words', () => {
    expect(slotMessage({ ok: false, reason: 'limit', limit: 2 })).toBe('Your plan includes 2 businesses. Add one in Settings › Plan.');
    expect(slotMessage({ ok: false, reason: 'offline' })).toContain('Couldn’t reach your account');
  });
});
