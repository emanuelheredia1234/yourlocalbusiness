// The paid-tier hook (server/ads/gate.mjs): open for everyone today, one function to replace later. Where it is
// checked (launch, resume, increases, later end dates, the canLaunch flag) and where it never is (pause, end,
// decreases, checks, reads) is tested through the routes in routes.test.mjs.
import { describe, expect, it } from 'vitest';
import { canLaunchAds } from './gate.mjs';

describe('canLaunchAds', () => {
  it('lets every signed-in user launch for now', async () => {
    await expect(canLaunchAds('0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11')).resolves.toBe(true);
    await expect(canLaunchAds('7d1e2b3c-4a5f-4b6c-8d7e-9f0a1b2c3d4e', { db: null })).resolves.toBe(true);
  });
});
