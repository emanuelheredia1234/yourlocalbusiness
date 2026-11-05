import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rateLimit.mjs';

describe('the per-minute request limit', () => {
  it('limits each key to its count a minute, reads to a multiple', () => {
    const clock = { now: 0 };
    const rateLimited = createRateLimiter({ limit: 3, now: () => clock.now });
    expect([1, 2, 3, 4].map(() => rateLimited('a'))).toEqual([false, false, false, true]);
    expect(rateLimited('b')).toBe(false);
    expect([1, 2, 3, 4, 5, 6].map(() => rateLimited('r', 2))).toEqual([false, false, false, false, false, false]);
    expect(rateLimited('r', 2)).toBe(true);
    clock.now = 60_000;
    expect(rateLimited('a')).toBe(false);
  });

  it('doesn’t keep a key for every caller: quiet keys go after a minute, and the map never passes its cap', () => {
    const clock = { now: 0 };
    const rateLimited = createRateLimiter({ limit: 30, maxKeys: 1000, now: () => clock.now });
    // one request from each of many addresses (the Omnisend callback counts callers by address, signed in or not)
    for (let i = 0; i < 5000; i += 1) rateLimited(`omnisend-callback:198.51.${i >> 8}.${i & 255}`);
    expect(rateLimited.size()).toBe(1000);
    clock.now = 61_000;
    rateLimited('pages:user:someone');
    expect(rateLimited.size()).toBe(1);
  });

  it('keeps counting a busy key while strangers fill the map', () => {
    const clock = { now: 0 };
    const rateLimited = createRateLimiter({ limit: 5, maxKeys: 100, now: () => clock.now });
    for (let round = 0; round < 5; round += 1) {
      expect(rateLimited('busy')).toBe(false);
      for (let i = 0; i < 50; i += 1) rateLimited(`stranger:${round}:${i}`);
    }
    expect(rateLimited('busy')).toBe(true);
  });
});
