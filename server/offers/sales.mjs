// How one provider event changes a stored sale: the rule public.record_sale applies in Postgres
// (supabase/migrations/20261113000000_offers.sql, replaced by 20261118000000_stripe_connect.sql), as one JS function. The mock database uses it, and a test reads
// the SQL to keep the two the same. Nothing here touches money: it only decides what a sale row says.
//
// - A status changes only to one of the same or a later rank (pending < failed < paid < partly refunded < refunded,
//   disputed last), or, between pending and failed only, to a newer event's.
// - refunded_minor only grows; amount_minor is filled once (while it's 0); net, email, paid time and membership are
//   kept once set. currency, offer, business and owner are what the first event wrote.
// - P6 (Stripe): checkout_session_id, fee_pct, fee_tier, application_fee_id and application_fee_minor are set once
//   (the stored value, else the incoming one). dispute_status has its own function (record_sale_dispute).
// - A row of another user is never changed.
// So a repeated delivery, or an older event arriving after a newer one, changes nothing.

export const SALE_STATUSES = Object.freeze(['pending', 'failed', 'paid', 'partially_refunded', 'refunded', 'disputed']);
export const SALE_RANK = Object.freeze({ pending: 0, failed: 1, paid: 2, partially_refunded: 3, refunded: 4, disputed: 5 });

const rank = (s) => SALE_RANK[s] ?? -1;
const time = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : 0;
};
const big = (v) => (v == null || v === '' ? null : Number(v));
const coalesce = (a, b) => (a == null ? (b ?? null) : a);

/**
 * stored: the sale row or null; incoming: the record_sale payload (same column names). → { outcome, row } with
 * outcome 'inserted' | 'updated' | 'kept' and row the row as it is afterwards (null when kept as nothing).
 */
export function mergeSale(stored, incoming) {
  const p = incoming;
  if (!stored) {
    return {
      outcome: 'inserted',
      row: {
        user_id: p.user_id,
        project_id: p.project_id,
        offer_id: p.offer_id ?? null,
        provider: p.provider,
        environment: p.environment,
        provider_account: p.provider_account,
        provider_payment_id: p.provider_payment_id,
        provider_membership_id: p.provider_membership_id ?? null,
        status: p.status,
        amount_minor: big(p.amount_minor) ?? 0,
        refunded_minor: big(p.refunded_minor) ?? 0,
        net_minor: big(p.net_minor),
        application_fee_minor: big(p.application_fee_minor),
        currency: p.currency,
        buyer_email: p.buyer_email ?? null,
        paid_at: p.paid_at ?? null,
        last_event_at: p.last_event_at,
        checkout_session_id: p.checkout_session_id ?? null,
        fee_pct: big(p.fee_pct),
        fee_tier: p.fee_tier ?? null,
        application_fee_id: p.application_fee_id ?? null,
      },
    };
  }
  const r = stored;
  if (String(r.user_id) !== String(p.user_id)) return { outcome: 'kept', row: r };
  const newer = time(p.last_event_at) > time(r.last_event_at);
  const early = (s) => s === 'pending' || s === 'failed';
  const applies = rank(p.status) >= rank(r.status) || (newer && early(r.status) && early(p.status));
  const next = {
    status: applies ? p.status : r.status,
    last_event_at: newer ? p.last_event_at : r.last_event_at,
    refunded_minor: Math.max(Number(r.refunded_minor) || 0, big(p.refunded_minor) ?? 0),
    amount_minor: Number(r.amount_minor) > 0 ? Number(r.amount_minor) : Math.max(Number(r.amount_minor) || 0, big(p.amount_minor) ?? 0),
    net_minor: coalesce(big(r.net_minor), big(p.net_minor)),
    buyer_email: coalesce(r.buyer_email, p.buyer_email),
    paid_at: coalesce(r.paid_at, p.paid_at),
    provider_membership_id: coalesce(r.provider_membership_id, p.provider_membership_id),
    checkout_session_id: coalesce(r.checkout_session_id, p.checkout_session_id),
    fee_pct: coalesce(big(r.fee_pct), big(p.fee_pct)),
    fee_tier: coalesce(r.fee_tier, p.fee_tier),
    application_fee_id: coalesce(r.application_fee_id, p.application_fee_id),
    application_fee_minor: coalesce(big(r.application_fee_minor), big(p.application_fee_minor)),
  };
  const same =
    next.status === r.status &&
    time(next.last_event_at) === time(r.last_event_at) &&
    next.refunded_minor === (Number(r.refunded_minor) || 0) &&
    next.amount_minor === (Number(r.amount_minor) || 0) &&
    next.net_minor === big(r.net_minor) &&
    next.buyer_email === (r.buyer_email ?? null) &&
    time(next.paid_at) === time(r.paid_at) &&
    next.provider_membership_id === (r.provider_membership_id ?? null) &&
    next.checkout_session_id === (r.checkout_session_id ?? null) &&
    next.fee_pct === big(r.fee_pct) &&
    next.fee_tier === (r.fee_tier ?? null) &&
    next.application_fee_id === (r.application_fee_id ?? null) &&
    next.application_fee_minor === big(r.application_fee_minor);
  if (same) return { outcome: 'kept', row: r };
  return { outcome: 'updated', row: { ...r, ...next } };
}
