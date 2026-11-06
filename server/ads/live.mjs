// Meta's live campaigns and ad sets (GET /v1/ads/accounts/live), followed page by page. Each level is paged on its
// own (paging.campaigns.after / paging.adSets.after, read again with `level` and `after`), so an ad account with more
// campaigns or ad sets than one page still finds ours. Reads only, at most LIVE_MAX_PAGES reads per level. A level
// that wasn't read to its last page is reported incomplete, and nobody decides "not there" from an incomplete level.

export const LIVE_MAX_PAGES = 10;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const rowsOf = (body, k) => (Array.isArray(body?.[k]) ? body[k] : []).filter(isObj);

/**
 * campaign: (c) => bool, the campaign wanted (first match). adSet: (s, campaign) => bool, the ad sets wanted;
 * allAdSets: keep reading until the last page (else stop at the first match).
 * → { ok: true, readAt, campaign, adSets, complete: { campaigns, adSets } } | { ok: false, code }
 */
export async function findLive(ctx, zid, adAccountId, lctx, { campaign: wantC = null, adSet: wantS = null, allAdSets = false } = {}) {
  const read = (o) => ctx.zads.reads.liveEntities(zid, adAccountId, lctx, o);
  const first = await read();
  if (!first.ok) return { ok: false, code: first.code };
  const readAt = typeof first.body.readAt === 'string' ? first.body.readAt : null;

  let campaign = wantC ? rowsOf(first.body, 'campaigns').find(wantC) ?? null : null;
  let after = first.body.paging?.campaigns?.after ?? null;
  for (let pages = 1; wantC && !campaign && after && pages < LIVE_MAX_PAGES; pages += 1) {
    const got = await read({ level: 'campaign', after });
    if (!got.ok) return { ok: false, code: got.code };
    campaign = rowsOf(got.body, 'campaigns').find(wantC) ?? null;
    after = got.body.paging?.campaigns?.after ?? null;
  }
  const campaignsComplete = !!campaign || !after;

  const adSets = [];
  if (wantS) {
    const keep = (body) => adSets.push(...rowsOf(body, 'adSets').filter((s) => wantS(s, campaign)));
    keep(first.body);
    let next = first.body.paging?.adSets?.after ?? null;
    for (let pages = 1; next && (allAdSets || !adSets.length) && pages < LIVE_MAX_PAGES; pages += 1) {
      const got = await read({ level: 'adSet', after: next });
      if (!got.ok) return { ok: false, code: got.code };
      keep(got.body);
      next = got.body.paging?.adSets?.after ?? null;
    }
    return { ok: true, readAt, campaign, adSets, complete: { campaigns: campaignsComplete, adSets: !next || (!allAdSets && adSets.length > 0) } };
  }
  return { ok: true, readAt, campaign, adSets, complete: { campaigns: campaignsComplete, adSets: true } };
}

/** One known campaign (and its ad set) of a launched row. */
export function findOwn(ctx, row, lctx, { campaignId = row.remote?.campaignId, adSetId = row.remote?.adSetId } = {}) {
  return findLive(ctx, row.zernio_account_id, row.ad_account_id, lctx, {
    campaign: (c) => String(c.platformCampaignId) === String(campaignId),
    ...(adSetId ? { adSet: (s) => String(s.platformAdSetId) === String(adSetId) } : {}),
  });
}
