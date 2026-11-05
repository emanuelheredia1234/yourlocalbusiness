// treg's admin calls, with the separate admin-role token TREG_ADMIN_TOKEN. Only server/billing/* imports this
// file; no /call/ request ever carries that token (server/treg.mjs never reads it).
//
//   const admin = createTregAdmin({ env, fetch });
//   admin.budgets.putDefault(fields) · budgets.put(tag, fields) · budgets.delete(tag) · budgets.list()
//   admin.usageByTag(days) · admin.balance() · admin.call(callId) · admin.settings(fields)
//
// Never call POST /orgs/<org_id>/public-token (it would make the team a public demo). The balance is for the
// owner only and never reaches a customer. Errors are TregError with our words: never treg's body, which can
// carry the balance and a top-up link.

import { TregError } from '../treg.mjs';
import { safeLog } from '../integrations/common.mjs';

const TAG = /^cust_[0-9a-f]{24}$/;
const CALL_ID = /^[0-9a-f]{32}$/i;

export function createTregAdmin({ env = process.env, fetch = globalThis.fetch, log = console, timeoutMs = 30_000 } = {}) {
  const base = String(env.TREG_BASE_URL || 'https://treg.to').replace(/\/+$/, '');
  const token = String(env.TREG_ADMIN_TOKEN || '');
  const org = String(env.TREG_ORG_ID || '');
  const setUp = Boolean(token && org);
  const orgPath = `/orgs/${encodeURIComponent(org)}`;

  async function request(method, path, body) {
    if (!setUp) throw new TregError('config', 'treg billing isn’t set up.', { hint: 'Add TREG_ADMIN_TOKEN and TREG_ORG_ID in Replit Secrets.' });
    if (/\/public-token\b/.test(path)) throw new TregError('config', 'Not allowed.');
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { 'x-treg-token': token, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TregError(e?.name === 'TimeoutError' ? 'timeout' : 'unavailable', 'treg couldn’t be reached.');
    }
    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return { status: res.status, data };
    // treg's body is third-party text (a 402 carries the balance and a top-up link): keep a plain code only
    const reason = typeof data?.error === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(data.error) ? data.error : null;
    safeLog('treg_admin_refused', { path: path.replace(/cust_[0-9a-f]{24}|[0-9a-f]{32}/g, ':id'), status: res.status, reason }, log);
    if (res.status === 404) throw new TregError('not_found', 'treg doesn’t have that.', { status: 404 });
    if (res.status === 401 || res.status === 403) throw new TregError('config', 'treg refused the billing token.', { status: res.status, hint: 'Check TREG_ADMIN_TOKEN (an admin-role agent token) and TREG_ORG_ID in Replit Secrets.' });
    if (res.status === 429) throw new TregError('busy', 'treg is busy. Try again shortly.', { status: 429 });
    if (res.status >= 500) throw new TregError('unavailable', 'treg is unavailable. Try again shortly.', { status: res.status });
    throw new TregError('bad_request', 'treg refused that change.', { status: res.status, reason });
  }

  const tagPath = (tag) => {
    if (!TAG.test(String(tag))) throw new TregError('bad_request', 'Not a customer tag.');
    return `${orgPath}/budgets/customer/${tag}`;
  };

  return {
    setUp,
    budgets: {
      async putDefault(fields) {
        return (await request('PUT', `${orgPath}/budgets/customer`, fields)).data;
      },
      async put(tag, fields) {
        return (await request('PUT', tagPath(tag), fields)).data;
      },
      async delete(tag) {
        try {
          return (await request('DELETE', tagPath(tag))).data;
        } catch (e) {
          if (e?.kind === 'not_found') return null; // nothing to remove
          throw e;
        }
      },
      async list() {
        return (await request('GET', `${orgPath}/budgets?dim=customer`)).data;
      },
    },
    /** { key, days, rows: [{ value, charged_micro, calls }], attributed_micro, unattributed_micro, total_micro } */
    async usageByTag(days) {
      const d = Math.min(366, Math.max(1, Math.trunc(Number(days) || 30)));
      return (await request('GET', `${orgPath}/usage/by-tag?key=customer&days=${d}`)).data;
    },
    /** The team's balance: the owner only, never shown to customers. */
    async balance() {
      return (await request('GET', `${orgPath}/balance`)).data;
    },
    /** One call's audit row and the ledger's view of it (GET /calls/<id>); null when treg has no audit row. */
    async call(callId) {
      if (!CALL_ID.test(String(callId))) throw new TregError('bad_request', 'Not a call id.');
      try {
        return (await request('GET', `/calls/${callId}`)).data;
      } catch (e) {
        if (e?.kind === 'not_found') return null;
        throw e;
      }
    },
    /** PATCH /orgs/<org>/settings: used to declare { budget_dims: ['customer'], primary_dim: 'customer' }. */
    async settings(fields) {
      return (await request('PATCH', `${orgPath}/settings`, fields)).data;
    },
  };
}
