import { describe, expect, it } from 'vitest';
import { newSkill, unfilledPlaceholders } from '@/ai/brain';
import { purgeSkills } from './brain';

const OLD_TEXT = 'Facts you can use:\n- Family-owned since 2014.\n- Over 1,200 customers served.\n- 4.9-star average from 300+ reviews.\n- Licensed and insured.';

describe('purgeSkills', () => {
  it('replaces the made-up proof points with placeholders and turns the skill off', () => {
    const old = newSkill({ name: 'Proof points', category: 'knowledge', instructions: OLD_TEXT });
    const mine = newSkill({ name: 'Voice', instructions: 'Tone: warm.' });
    const out = purgeSkills([old, mine])!;
    expect(out).not.toBeNull();
    expect(out[0].enabled).toBe(false);
    expect(out[0].instructions).not.toMatch(/2014|1,200|4\.9|Licensed and insured/);
    expect(unfilledPlaceholders(out[0].instructions)).toEqual(['[Year founded]', '[Number of customers]', '[Average rating and where it comes from]', '[Licences or certifications]']);
    expect(out[1]).toBe(mine);
    expect(purgeSkills(out)).toBeNull();
  });

  it('keeps the lines the owner wrote and only swaps the exact template lines', () => {
    const edited = newSkill({ name: 'Proof', category: 'knowledge', instructions: 'Facts you can use:\n- Family-owned since 1998.\n- Licensed and insured.' });
    const out = purgeSkills([edited])!;
    expect(out[0].instructions).toBe('Facts you can use:\n- Family-owned since 1998.\n- [Licences or certifications].');
    expect(purgeSkills(out)).toBeNull();
  });

  it('leaves skills without the template alone', () => {
    expect(purgeSkills([newSkill({ name: 'Facts', category: 'knowledge', instructions: 'Family-owned since 2014 (really).' })])).toBeNull();
    expect(purgeSkills([])).toBeNull();
  });
});

describe('unfilledPlaceholders', () => {
  it('finds template placeholders but not links or numbered references', () => {
    expect(unfilledPlaceholders('Founded in [Year founded]. See [our site](https://x.test) and [1].')).toEqual(['[Year founded]']);
    expect(unfilledPlaceholders('Founded in 2009.')).toEqual([]);
  });
});
