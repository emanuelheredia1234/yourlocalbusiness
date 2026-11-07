// @vitest-environment happy-dom
// Finishing setup uses up a plan chosen on #plans before signing up (it waited for the Launch step's paywall): every
// way out of setup goes through finishOnboarding, so a reload afterwards never sends the browser to Stripe Checkout
// on its own (src/components/billing/PlanBanner.tsx useBillingWatcher).
import { describe, expect, it } from 'vitest';

const { finishOnboarding } = await import('./finish');
const { readPlanIntent, savePlanIntent } = await import('@/store/billing');
const { useStore } = await import('@/store/useStore');
const { newProject } = await import('@/store/defaults');

describe('finishing setup', () => {
  it('marks the business set up and clears the plan chosen before signing up', () => {
    const p = newProject('business', 'existing');
    useStore.setState({ projects: [{ ...p, brand: { ...p.brand, name: 'Copper & Comb' } }] });
    savePlanIntent({ tier: 'grow', interval: 'year' });
    expect(readPlanIntent()).toEqual({ tier: 'grow', interval: 'year' });
    finishOnboarding(p.id);
    expect(readPlanIntent()).toBeNull();
    expect(useStore.getState().projects.find((x) => x.id === p.id)?.onboarded).toBe(true);
  });
});
