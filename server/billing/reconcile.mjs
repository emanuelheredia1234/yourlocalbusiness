// Our ledger against treg's own numbers, for the owner (GET /api/billing/reconcile), and the job that settles
// treg's 202 "pending" answers.
//
// reconcile(): closed UTC days only (the ledger before today 00:00 UTC; treg's usage/by-tag for the same number
// of days). A difference on a customer counts as a mismatch only if no one-day lag explains it (the window
// shifted back a day, or reaching into today). Pending rows not settled yet are listed apart, never as
// mismatches. For a mismatched customer, up to 20 of our call ids are looked up at treg to find the gap.
//
// settlePending(): every 5 minutes, for 'pending' rows older than 2 minutes, GET /calls/<id> (a read). When treg
// has settled it, a correcting row (outcome 'settled', cost = charged − reserved, same call_id) is written.
// The shape of /calls/<id> is UNVERIFIED (treg-digest §7): charged_micro is read from `ledger.charged_micro`,
// then `charged_micro`; a call still pending (or with no charge yet) is left for the next round.

import { dayStart, isCall, isReal } from './ledger.mjs';
import { safeLog } from '../integrations/common.mjs';

const DAY = 86_400_000;
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

function sumByTag(rows, from, to) {
  const out = new Map();
  for (const r of rows) {
    const at = String(r.created_at);
    if (at < from || at >= to || !isReal(r)) continue;
    out.set(r.customer_tag, (out.get(r.customer_tag) ?? 0) + int(r.cost_micro));
  }
  return out;
}

/**
 * ledger: server/billing/ledger.mjs; admin: server/billing/tregAdmin.mjs. Returns the ReconcileReport
 * (src/lib/integrations/types.ts) plus, per mismatched row, `checkedCalls` / `missingAtTreg`.
 */
export async function reconcile({ ledger, admin, now = () => Date.now(), days = 30 } = {}) {
  const d = Math.min(366, Math.max(1, Math.trunc(Number(days) || 30)));
  const at = now();
  const closedEnd = dayStart(at);
  const start = new Date(Date.parse(closedEnd) - d * DAY).toISOString();
  const earlyStart = new Date(Date.parse(start) - DAY).toISOString();
  const earlyEnd = new Date(Date.parse(closedEnd) - DAY).toISOString();
  const nowIso = new Date(at + 1).toISOString();

  const report = await admin.usageByTag(d);
  const attributed = int(report?.attributed_micro);
  const unattributed = int(report?.unattributed_micro);
  const total = int(report?.total_micro);
  const tregRows = new Map();
  for (const r of Array.isArray(report?.rows) ? report.rows : []) {
    const tag = String(r?.value ?? '');
    if (tag) tregRows.set(tag, (tregRows.get(tag) ?? 0) + int(r.charged_micro));
  }

  const rows = await ledger.rows({ vendor: 'treg', since: earlyStart, select: 'customer_tag,cost_micro,created_at,outcome,vendor,estimated,call_id' });
  const closed = sumByTag(rows, start, closedEnd);
  const withToday = sumByTag(rows, start, nowIso);
  const shifted = sumByTag(rows, earlyStart, earlyEnd);

  const tags = [...new Set([...tregRows.keys(), ...closed.keys()])].sort();
  let mismatches = 0;
  const out = [];
  for (const tag of tags) {
    const tregMicro = tregRows.get(tag) ?? 0;
    const ledgerMicro = closed.get(tag) ?? 0;
    const diffMicro = tregMicro - ledgerMicro;
    const row = { customerTag: tag, tregMicro, ledgerMicro, diffMicro };
    const explained = diffMicro === 0 || (withToday.get(tag) ?? 0) === tregMicro || (shifted.get(tag) ?? 0) === tregMicro;
    if (!explained) {
      mismatches += 1;
      row.mismatch = true;
      // which of our calls treg has no record of (a 404 means "no audit row", so this is a lead, not proof)
      const ids = [...new Set(rows.filter((r) => r.customer_tag === tag && r.call_id && String(r.created_at) >= start && String(r.created_at) < closedEnd && isCall(r)).map((r) => r.call_id))].slice(-20);
      let missing = 0;
      let checked = 0;
      for (const id of ids) {
        try {
          const found = await admin.call(id);
          checked += 1;
          if (!found) missing += 1;
        } catch {
          break; // treg busy: the totals above still stand
        }
      }
      row.checkedCalls = checked;
      row.missingAtTreg = missing;
    }
    out.push(row);
  }

  let pending = [];
  try {
    pending = (await ledger.pending(nowIso)).filter((r) => String(r.created_at) >= start).map((r) => ({ customerTag: r.customer_tag, callId: r.call_id, at: String(r.created_at) }));
  } catch {
    pending = [];
  }

  return {
    days: d,
    window: { from: start, to: closedEnd },
    treg: { attributedMicro: attributed, unattributedMicro: unattributed, totalMicro: total, sumOk: attributed + unattributed === total },
    rows: out,
    unattributedOk: unattributed === 0,
    mismatches,
    pending,
    checkedAt: new Date(at).toISOString(),
  };
}

/** The charged amount in a /calls/<id> answer, or null while it's still pending. */
export function chargedFrom(info) {
  if (!info || typeof info !== 'object') return null;
  const state = String(info.outcome ?? info.status ?? info.call?.outcome ?? '').toLowerCase();
  if (state === 'pending' || state === 'running') return null;
  for (const v of [info.ledger?.charged_micro, info.charged_micro, info.call?.charged_micro]) if (v != null && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return null;
}

/** Settle 'pending' rows older than 2 minutes. Returns how many were settled. One read per row; no retries. */
export async function settlePending({ ledger, admin, now = () => Date.now(), log = console, max = 100 } = {}) {
  if (!admin?.setUp || !ledger?.enabled) return 0;
  const cutoff = new Date(now() - 120_000).toISOString();
  let settled = 0;
  let rows;
  try {
    rows = await ledger.pending(cutoff);
  } catch (e) {
    safeLog('billing_settle_failed', { code: e?.code }, log);
    return 0;
  }
  const seen = new Set();
  for (const r of rows.slice(0, max)) {
    if (seen.has(r.call_id)) continue;
    seen.add(r.call_id);
    let info;
    try {
      info = await admin.call(r.call_id);
    } catch (e) {
      safeLog('billing_settle_failed', { kind: e?.kind }, log);
      break;
    }
    const charged = chargedFrom(info);
    if (charged == null) continue;
    const ok = await ledger.write({
      customer_tag: r.customer_tag,
      user_id: r.user_id ?? null,
      project_id: r.project_id ?? null,
      feature: r.feature,
      vendor: 'treg',
      endpoint: r.endpoint,
      call_id: r.call_id,
      run_id: r.run_id ?? null,
      outcome: 'settled',
      cost_micro: charged - int(r.cost_micro),
      served_by: r.served_by ?? null,
    });
    if (ok) settled += 1;
  }
  return settled;
}
