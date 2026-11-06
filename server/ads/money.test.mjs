// Money for ads (server/ads/money.mjs, spec §10.3): whole units from Zernio, minor units from Meta's raw nodes,
// micros from Google, sums in integer minor units, no currency ever assumed or converted.
import { describe, expect, it } from 'vitest';
import { compareWhole, dailyProblem, exponentOf, formatMoney, fromMinor, metaRawToWhole, microsToWhole, sameWhole, sumWhole, timesDays, toMinor, zernioWhole } from './money.mjs';

describe('units per source', () => {
  it('reads Zernio budget, spendCap and accounts/live fields as whole units', () => {
    expect(zernioWhole(25)).toBe(25);
    expect(zernioWhole('40')).toBe(40);
    expect(zernioWhole(null)).toBeNull();
    expect(zernioWhole('')).toBeNull();
    expect(zernioWhole(-1)).toBeNull();
    expect(zernioWhole('abc')).toBeNull();
  });

  it('reads Meta raw Graph money (daily_budget) as minor units by the ISO 4217 exponent', () => {
    expect(metaRawToWhole('2500', 'USD')).toBe(25);
    expect(metaRawToWhole('3000', 'JPY')).toBe(3000);
    expect(metaRawToWhole('12345', 'KWD')).toBe(12.345);
    expect(metaRawToWhole(null, 'USD')).toBeNull();
  });

  it('reads Google *Micros fields as millionths', () => {
    expect(microsToWhole(25_000_000)).toBe(25);
    expect(microsToWhole('1500000')).toBe(1.5);
    expect(microsToWhole(undefined)).toBeNull();
  });

  it('knows the exponents (2 unless listed)', () => {
    expect(exponentOf('USD')).toBe(2);
    expect(exponentOf('EUR')).toBe(2);
    expect(exponentOf('JPY')).toBe(0);
    expect(exponentOf('KWD')).toBe(3);
  });
});

describe('sums and comparisons in integer minor units', () => {
  it('adds without floating-point drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumWhole([0.1, 0.2], 'USD')).toBe(0.3);
    expect(sumWhole([25, 15.5, 9.5], 'USD')).toBe(50);
    expect(sumWhole([1.001, 2.002], 'KWD')).toBe(3.003);
  });

  it('multiplies a daily amount by days exactly', () => {
    expect(timesDays(25, 14, 'USD')).toBe(350);
    expect(timesDays(19.99, 3, 'USD')).toBe(59.97);
    expect(timesDays(25, -2, 'USD')).toBe(0);
  });

  it('compares through minor units', () => {
    expect(compareWhole(50, 50.0, 'USD')).toBe(0);
    expect(compareWhole(50.01, 50, 'USD')).toBe(1);
    expect(compareWhole(49.99, 50, 'USD')).toBe(-1);
    expect(sameWhole(0.3, 0.1 + 0.2, 'USD')).toBe(true);
    expect(toMinor(25, 'USD')).toBe(2500);
    expect(fromMinor(2500, 'USD')).toBe(25);
    expect(Number.isNaN(toMinor(null, 'USD'))).toBe(true);
  });
});

describe('what the customer types', () => {
  it('takes whole numbers of at least 1 and the account minimum (v1)', () => {
    expect(dailyProblem(25)).toBeNull();
    expect(dailyProblem(25.5)).toBe('BUDGET_INVALID');
    expect(dailyProblem(0)).toBe('BUDGET_INVALID');
    expect(dailyProblem(Number.NaN)).toBe('BUDGET_INVALID');
    expect(dailyProblem(3, 5)).toBe('BUDGET_TOO_LOW');
    expect(dailyProblem(5, 5)).toBeNull();
  });

  it('formats in the account’s own currency, never dollars by default', () => {
    expect(formatMoney(25, 'USD')).toBe('$25.00');
    expect(formatMoney(40, 'EUR')).toBe('€40.00');
    expect(formatMoney(40, 'EUR')).not.toContain('$');
    expect(formatMoney(3000, 'JPY')).toBe('¥3,000');
    expect(formatMoney('x', 'USD')).toBe('');
  });
});
