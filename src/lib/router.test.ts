// The link back from Upload-Post's connect page: /?settings=accounts#workspace-settings opens Settings → Connected
// accounts once, and the address loses the parameter.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTES, takeSettingsSection } from './router';

afterEach(() => {
  vi.unstubAllGlobals();
});

function at(search: string) {
  const replaced: string[] = [];
  vi.stubGlobal('location', { search, pathname: '/', hash: '#workspace-settings' });
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) });
  return replaced;
}

describe('takeSettingsSection', () => {
  it('reads ?settings=accounts once and keeps the rest of the address', () => {
    const replaced = at('?settings=accounts&utm=x');
    expect(takeSettingsSection()).toBe('accounts');
    expect(replaced).toEqual(['/?utm=x#workspace-settings']);
  });

  it('ignores an address without it, or with a value that isn’t a section name', () => {
    at('');
    expect(takeSettingsSection()).toBeNull();
    at('?settings=%3Cscript%3E');
    expect(takeSettingsSection()).toBeNull();
  });
});

describe('routes', () => {
  it('has #plans, and never a word claude.ai reserves (upgrade, settings, …)', () => {
    expect(ROUTES).toContain('plans');
    for (const reserved of ['upgrade', 'settings', 'sidebar', 'customize', 'downloads']) expect(ROUTES as readonly string[]).not.toContain(reserved);
  });
});
