// The customer-visible ad audit log (table ad_audit, spec §10.4): one row per write attempt sent, its outcome, each
// Check status, each refused attempt, review changes from refresh or the webhook, and the owner's limit changes and
// pauses. Summaries are built from our templates; the one exception is a refusal we have no sentence for, whose
// line quotes the platform's own words, cut and labelled (messages.mjs refusalOf). A refused write keeps its
// refusal's safe fields in `after` ({ refusal }); the list passes on only its fix link, when the host is allowed.
// Append-only: this module has no update or delete, and neither has anything else in server/ads/ (a test greps for
// it); rows go only with the account (on delete cascade).

import { safeLog } from '../integrations/common.mjs';
import { cut, fixUrlFor } from './messages.mjs';

/**
 * A refusal's fix link the customer may follow (never a team-level one), from a row's `after`: ours for the policy, and
 * for a payment method the campaign's own Meta ad account's payment settings (messages.mjs fixUrlFor). acct: that
 * campaign's { ad_account_id, platform }, when looked up; a Google campaign gets Zernio's own link, never a Meta page.
 */
const refusalIn = (after) => (after && typeof after === 'object' && after.refusal && typeof after.refusal === 'object' ? after.refusal : null);
const fixOf = (after, acct) => {
  const r = refusalIn(after);
  return r && r.owner !== true ? fixUrlFor(r.code, r.fix?.url, acct?.ad_account_id, acct?.platform ?? 'meta') : undefined;
};

const ACTIONS = ['launch', 'pause', 'resume', 'end', 'budget', 'end_date', 'creative', 'check', 'limits', 'review', 'account'];
const OUTCOMES = ['sending', 'done', 'failed', 'unknown', 'refused', 'info'];

export function createAudit({ db, now = () => Date.now(), log = console } = {}) {
  /**
   * One row. entry: { userId, tag, projectId?, campaignId?, jobId?, actor, action, summary, before?, after?, outcome }.
   * Never throws: a lost audit row is logged (the write it records has already happened or been refused).
   */
  async function append(entry) {
    const row = {
      at: new Date(now()).toISOString(),
      user_id: entry.userId,
      customer_tag: entry.tag,
      project_id: entry.projectId ?? null,
      campaign_id: entry.campaignId ?? null,
      job_id: entry.jobId ?? null,
      actor: ['customer', 'owner', 'platform'].includes(entry.actor) ? entry.actor : 'customer',
      action: ACTIONS.includes(entry.action) ? entry.action : 'review',
      summary: cut(entry.summary, 500) || '—',
      before: entry.before ?? null,
      after: entry.after ?? null,
      outcome: OUTCOMES.includes(entry.outcome) ? entry.outcome : 'info',
    };
    try {
      await db.insert('ad_audit', row);
      return true;
    } catch (e) {
      safeLog('ads_audit_failed', { action: row.action, outcome: row.outcome, code: e?.code }, log);
      return false;
    }
  }

  /** The user's rows, newest first, 50 a page (before: an id to page back from). */
  async function list(userId, { projectId, campaignId, before, limit = 50 } = {}) {
    const f = { user_id: userId };
    if (projectId) f.project_id = projectId;
    if (campaignId) f.campaign_id = campaignId;
    if (Number.isInteger(before) && before > 0) f.id = ['lt', before];
    const rows = await db.select('ad_audit', f, { order: 'id.desc', limit: limit + 1 });
    const page = rows.slice(0, limit);
    // the ad accounts (and platform) of the campaigns with a payment refusal on this page, for a Meta account's own
    // payment settings link
    const payIds = [...new Set(page.filter((r) => r.campaign_id && refusalIn(r.after)?.code === 'ad_account_payment_required').map((r) => r.campaign_id))];
    const accountOf = new Map();
    if (payIds.length) for (const c of await db.select('ad_campaigns', { user_id: userId, id: ['in', payIds] }, { select: 'id,ad_account_id,platform', limit: payIds.length })) accountOf.set(c.id, c);
    return {
      entries: page.map((r) => {
        const fixUrl = fixOf(r.after, accountOf.get(r.campaign_id));
        return { id: r.id, at: r.at, campaignId: r.campaign_id ?? null, actor: r.actor, action: r.action, summary: r.summary, outcome: r.outcome, ...(fixUrl ? { fixUrl } : {}) };
      }),
      ...(rows.length > limit ? { next: page[page.length - 1].id } : {}),
    };
  }

  return { append, list };
}
