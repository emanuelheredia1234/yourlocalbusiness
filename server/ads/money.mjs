// Money for ads, one function per source (spec §10.3). Every amount the app sends or decides on is in whole units
// of the ad account's own currency (Zernio's budget, bid and spendCap fields, and GET /v1/ads/accounts/live), never
// cents or micros, and no currency is ever converted. Meta's raw Graph nodes (GET /v1/ads/ad-sets/{id}) are in minor
// units and Google's *Micros fields are micros: both are for display only and never reach a money decision.
// Sums and comparisons run in integer minor units, never in floating point.

/** ISO 4217 minor-unit exponents that aren't 2. */
const EXPONENT = Object.freeze({
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
});

export const isCurrency = (c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c);
/** The minor-unit exponent of a currency (2 unless listed). */
export const exponentOf = (currency) => (Object.hasOwn(EXPONENT, currency) ? EXPONENT[currency] : 2);

/** Whole units (a Zernio or app amount) → integer minor units. NaN for anything that isn't a finite number. */
export function toMinor(amount, currency) {
  const n = Number(amount);
  if (amount === null || amount === '' || !Number.isFinite(n)) return Number.NaN;
  return Math.round(n * 10 ** exponentOf(currency));
}

/** Integer minor units → whole units (a number with at most the currency's decimals). */
export function fromMinor(minor, currency) {
  const e = exponentOf(currency);
  return Number((Number(minor) / 10 ** e).toFixed(e));
}

/** A Zernio money field (budget amount, dailyBudget, spendCap, budgetRemaining): whole units, or null. */
export function zernioWhole(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Meta raw Graph money (daily_budget on GET /v1/ads/ad-sets/{id}): minor units → whole units. Display only. */
export function metaRawToWhole(value, currency) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null;
  return fromMinor(Math.round(n), currency);
}

/** Google *Micros fields (approvedSpendingLimitMicros): micros → whole units. Display only. */
export function microsToWhole(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null;
  return n / 1_000_000;
}

/** Sum whole-unit amounts exactly (through integer minor units). */
export function sumWhole(amounts, currency) {
  let minor = 0;
  for (const a of amounts) {
    const m = toMinor(a, currency);
    if (Number.isFinite(m)) minor += m;
  }
  return fromMinor(minor, currency);
}

/** a × n in whole units, exactly (a daily amount over days). */
export function timesDays(amount, days, currency) {
  return fromMinor(toMinor(amount, currency) * Math.max(0, Math.trunc(days)), currency);
}

/** a > b, a === b, a < b in minor units (-1, 0, 1). */
export function compareWhole(a, b, currency) {
  const x = toMinor(a, currency);
  const y = toMinor(b, currency);
  return x === y ? 0 : x > y ? 1 : -1;
}

export const sameWhole = (a, b, currency) => Number.isFinite(toMinor(a, currency)) && compareWhole(a, b, currency) === 0;

/** A daily amount the customer typed (v1: whole numbers only, at least 1 and at least the account's minimum). */
export function dailyProblem(amount, minDaily = 1) {
  if (!Number.isInteger(amount) || amount < 1) return 'BUDGET_INVALID';
  if (Number.isFinite(minDaily) && minDaily > 0 && amount < minDaily) return 'BUDGET_TOO_LOW';
  if (amount > 1_000_000) return 'BUDGET_INVALID';
  return null;
}

/** An amount in its own currency, for our sentences ("$25.00", "€40.00", "¥3,000"). Never assumes dollars. */
export function formatMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  const code = isCurrency(currency) ? currency : 'USD';
  const e = exponentOf(code);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, minimumFractionDigits: e, maximumFractionDigits: e }).format(n);
  } catch {
    return `${n.toFixed(e)} ${code}`;
  }
}
