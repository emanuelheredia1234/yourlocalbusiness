// The owner's monthly CSV (GET /api/billing/invoice.csv?month=YYYY-MM): one line per customer tag, from our
// ledger (which matches treg's usage/by-tag after reconciling). Amounts are summed as integer micro-USD and
// formatted with 6 decimals only at the end. Estimated rows (Upload-Post profiles, Zernio ad accounts, X posts) get their own
// columns, labelled estimated. Every cell is CSV-escaped and formula-guarded.

import { isCall } from './ledger.mjs';

export const INVOICE_HEADER = ['customer_tag', 'email', 'month', 'treg_usd', 'treg_calls', 'estimated_connections_usd', 'estimated_x_usd', 'total_usd', 'status'];

/** micro-USD (an integer) as dollars with 6 decimals, without floating-point rounding. */
export function microToUsd(micro) {
  const n = Math.trunc(Number(micro) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, '0')}`;
}

/** One CSV cell: a leading = + - @ (or tab / CR) gets a ' so a spreadsheet never runs it; quotes when needed. */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Whether a month string is YYYY-MM (2000-2099). */
export const isMonth = (m) => /^20\d\d-(0[1-9]|1[0-2])$/.test(String(m ?? ''));

/** [start, end) of a month as ISO. */
export function monthWindow(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() };
}

/**
 * rows: the month's ledger rows; emails: Map tag → email; statuses: Map tag → 'active'|'blocked'.
 * Returns the CSV text (CRLF line ends, header first, customers sorted by tag).
 */
export function invoiceCsv({ month, rows, emails = new Map(), statuses = new Map() }) {
  const per = new Map();
  const get = (tag) => {
    let p = per.get(tag);
    if (!p) per.set(tag, (p = { treg: 0, calls: 0, conn: 0, x: 0 }));
    return p;
  };
  for (const r of rows) {
    const p = get(r.customer_tag);
    const c = Math.trunc(Number(r.cost_micro) || 0);
    if (r.vendor === 'treg' && r.estimated !== true) {
      p.treg += c;
      if (isCall(r)) p.calls += 1;
    } else if ((r.vendor === 'uploadpost' || r.vendor === 'zernio' || r.vendor === 'nango') && r.estimated === true) p.conn += c;
    else if (r.vendor === 'x' && r.estimated === true) p.x += c;
  }
  const lines = [INVOICE_HEADER.join(',')];
  for (const tag of [...per.keys()].sort()) {
    const p = per.get(tag);
    lines.push(
      [tag, emails.get(tag) ?? '', month, microToUsd(p.treg), p.calls, microToUsd(p.conn), microToUsd(p.x), microToUsd(p.treg + p.conn + p.x), statuses.get(tag) ?? 'active'].map(csvCell).join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
