// The claim check (server/ads/claims.mjs, spec §6.4) keeps the planner's own word list and the template lines the
// app's clean-up removes: this test reads both TypeScript sources and compares.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAIM_TERM, findClaims, TEMPLATE_CLAIMS, unconfirmed } from './claims.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('parity with the app', () => {
  it('uses exactly the planner’s CLAIM_TERM (src/ai/local/studio.ts)', () => {
    const m = /export const CLAIM_TERM = \/(.+)\/([a-z]*);/.exec(read('src/ai/local/studio.ts'));
    expect(m).not.toBeNull();
    expect(CLAIM_TERM.source).toBe(m[1]);
    expect(CLAIM_TERM.flags).toBe(m[2]);
  });

  it('flags every template line purgeAdClaims removes (src/store/legacy/claims.ts)', () => {
    const src = read('src/store/legacy/claims.ts');
    expect(src).toContain('export function purgeAdClaims');
    for (const t of TEMPLATE_CLAIMS) expect(src, t).toContain(t.trim());
  });
});

describe('findClaims', () => {
  it('finds each claim once, with the field it was in', () => {
    const got = findClaims([
      { field: 'Ad A headline', text: 'Licensed & insured plumbers' },
      { field: 'Ad B text', text: 'We are licensed. Read our reviews.' },
    ]);
    expect(got).toEqual([
      { phrase: 'licensed', field: 'Ad A headline' },
      { phrase: 'insured', field: 'Ad A headline' },
      { phrase: 'review', field: 'Ad B text' },
    ]);
  });

  it('flags template lines from old plans', () => {
    expect(findClaims([{ field: 'Description 1', text: 'Free estimates' }]).map((c) => c.phrase)).toContain('free estimates');
    expect(findClaims([{ field: 'Headline 1', text: 'Book Online in 60 Seconds' }]).map((c) => c.phrase)).toContain('book online in 60 seconds');
  });

  it('passes plain copy', () => {
    expect(findClaims([{ field: 'x', text: 'Fresh sourdough every morning in Austin' }])).toEqual([]);
  });

  it('keeps only the flags the customer hasn’t ticked (any case)', () => {
    const claims = findClaims([{ field: 'x', text: 'Licensed and certified' }]);
    expect(unconfirmed(claims, ['LICENSED']).map((c) => c.phrase)).toEqual(['certified']);
    expect(unconfirmed(claims, ['licensed', 'certified'])).toEqual([]);
    expect(unconfirmed(claims, 'licensed').map((c) => c.phrase)).toEqual(['licensed', 'certified']);
  });
});
