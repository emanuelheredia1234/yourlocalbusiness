// @vitest-environment happy-dom
// Settings › Owner: three rows (Billing overview, Plans, Ad limits) that open Customer usage at that section, and the
// section ids the Customer usage page carries. Who sees the row is Settings' rule (the owner only), checked below on
// the pure filter Settings uses (settingsTabAllowed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const nav = vi.hoisted(() => ({ navigate: vi.fn(async () => true) }));
vi.mock('@/lib/router', async (orig) => ({ ...(await orig<typeof import('@/lib/router')>()), navigate: nav.navigate }));

const { OwnerSection } = await import('./OwnerSection');
const { settingsTabAllowed } = await import('./tabs');
const { OWNER_SECTION_ID, openOwnerSection, takeOwnerSection, scrollToOwnerSection } = await import('@/pages/admin/ownerLinks');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  nav.navigate.mockClear();
  takeOwnerSection();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Settings › Owner', () => {
  it('lists Billing overview, Plans and Ad limits', async () => {
    await act(async () => root.render(createElement(OwnerSection)));
    const text = host.textContent ?? '';
    for (const t of ['Billing overview', 'Plans', 'Turn plans on', 'Ad limits']) expect(text).toContain(t);
    expect(host.querySelectorAll('[data-owner-section]').length).toBe(3);
  });

  it('each row opens Customer usage and asks for its section once', async () => {
    await act(async () => root.render(createElement(OwnerSection)));
    for (const section of ['plans', 'ad-limits', 'overview'] as const) {
      await act(async () => (host.querySelector(`[data-owner-section="${section}"]`) as HTMLButtonElement).click());
      expect(nav.navigate).toHaveBeenLastCalledWith('admin-billing');
      expect(takeOwnerSection()).toBe(section);
      expect(takeOwnerSection()).toBeNull();
    }
  });

  it('only the owner sees the Owner section (and never in the artifact build); the other sections keep their rules', () => {
    const base = { signedIn: true, billing: true, owner: false, artifact: false };
    expect(settingsTabAllowed('owner', base)).toBe(false);
    expect(settingsTabAllowed('owner', { ...base, owner: true })).toBe(true);
    expect(settingsTabAllowed('owner', { ...base, owner: true, artifact: true })).toBe(false);
    // a signed-out visitor is never the owner (the server says who is)
    expect(settingsTabAllowed('owner', { ...base, signedIn: false })).toBe(false);
    expect(settingsTabAllowed('plan', { ...base, billing: false })).toBe(false);
    expect(settingsTabAllowed('plan', { ...base, signedIn: false })).toBe(false);
    expect(settingsTabAllowed('account', { ...base, signedIn: false })).toBe(false);
    expect(settingsTabAllowed('payments', { ...base, artifact: true })).toBe(false);
    expect(settingsTabAllowed('brand', { ...base, signedIn: false, artifact: true })).toBe(true);
  });

  it('scrolls to a section that is drawn, and does nothing for one that is not', async () => {
    const el = document.createElement('div');
    el.id = OWNER_SECTION_ID.plans;
    const spy = vi.fn();
    (el as unknown as { scrollIntoView: () => void }).scrollIntoView = spy;
    document.body.appendChild(el);
    expect(scrollToOwnerSection('plans')).toBe(true);
    expect(spy).toHaveBeenCalled();
    expect(scrollToOwnerSection('ad-limits')).toBe(false);
    el.remove();
    await openOwnerSection('ad-limits');
    expect(takeOwnerSection()).toBe('ad-limits');
  });
});
