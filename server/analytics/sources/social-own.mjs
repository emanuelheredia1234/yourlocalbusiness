// The user's own stats from a connected account (connections.request, nango-digest §3), normalized to
// SocialNetworkStats with origin 'own'. Reads only.
//
// Target ids never leave the connections implementation, so paths name the chosen target with placeholders that
// the implementation fills from the stored target (server/connections/index.mjs request()):
//   {target}   the chosen target's real id (Page id, LinkedIn organization id, ad account id, GSC site)
//   {ig_user}  the Instagram professional account id of the chosen Facebook Page
//
// Facebook's insights need the Page's own token: it is read through the proxy once (GET /v26.0/{target}
// ?fields=access_token), kept in memory for this call only, and sent straight to graph.facebook.com as a
// bearer header (never in a URL, a log, a proxy header or storage).

import { engagementOf } from './social-public.mjs';
import { num, post } from '../normalize/util.mjs';

const DAY = 86_400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A connection read that answered 2xx: its body; anything else throws { kind } like a TregError. */
function okBody(res) {
  if (res && res.status >= 200 && res.status < 300) return res.body;
  const kind = res?.status === 401 || res?.status === 403 ? 'reconnect' : res?.status === 429 ? 'busy' : 'upstream';
  throw Object.assign(new Error('own-account read failed'), { kind, status: res?.status });
}

/** Graph insights { data: [{ name, values: [{ value, end_time }] }] } → { name: [{date, value}] }. */
function insightSeries(body) {
  const out = {};
  for (const m of Array.isArray(body?.data) ? body.data : []) {
    if (!isObj(m) || typeof m.name !== 'string') continue;
    out[m.name] = (Array.isArray(m.values) ? m.values : []).map((v) => ({ date: String(v?.end_time ?? '').slice(0, 10), value: num(v?.value) ?? 0 }));
  }
  return out;
}
const sum = (list = []) => list.reduce((a, x) => a + (x.value ?? 0), 0);

async function facebook({ runner, fetch, env, since, until }) {
  const tokenRes = okBody(await runner.own('facebook', { method: 'GET', path: '/v26.0/{target}', query: { fields: 'access_token' } }));
  const pageToken = typeof tokenRes?.access_token === 'string' ? tokenRes.access_token : '';
  const pageId = /^\d{1,30}$/.test(String(tokenRes?.id ?? '')) ? String(tokenRes.id) : '';
  if (!pageToken || !pageId) throw Object.assign(new Error('no page token'), { kind: 'reconnect' });
  const base = String(env.GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, '');
  const q = new URLSearchParams({ metric: 'page_media_view,page_total_media_view_unique,page_post_engagements,page_follows,page_daily_follows_unique', period: 'day', since: ymd(since), until: ymd(until) });
  let res;
  try {
    res = await fetch(`${base}/v26.0/${pageId}/insights?${q}`, { headers: { authorization: `Bearer ${pageToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw Object.assign(new Error('graph unreachable'), { kind: 'busy' });
  }
  const body = okBody({ status: res.status, body: await res.json().catch(() => null) });
  const s = insightSeries(body);
  const follows = s.page_follows ?? [];
  const engagement = sum(s.page_post_engagements);
  const byDate = new Map();
  for (const [name, key] of [['page_follows', 'followers'], ['page_total_media_view_unique', 'reach'], ['page_post_engagements', 'engagement']]) {
    for (const p of s[name] ?? []) if (p.date) byDate.set(p.date, { ...(byDate.get(p.date) ?? { date: p.date }), [key]: p.value });
  }
  return {
    followers: follows.length ? follows[follows.length - 1].value : undefined,
    reach: sum(s.page_total_media_view_unique),
    views: sum(s.page_media_view),
    engagement,
    series: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

async function instagram({ runner, since, until }) {
  const ins = okBody(await runner.own('instagram', { method: 'GET', path: '/v26.0/{ig_user}/insights', query: { metric: 'reach,views,accounts_engaged,total_interactions', period: 'day', metric_type: 'total_value', since: String(Math.floor(since / 1000)), until: String(Math.floor(until / 1000)) } }));
  const total = (name) => num((Array.isArray(ins?.data) ? ins.data : []).find((m) => m?.name === name)?.total_value?.value) ?? 0;
  const media = okBody(await runner.own('instagram', { method: 'GET', path: '/v26.0/{ig_user}/media', query: { fields: 'id,caption,timestamp,permalink,like_count,comments_count', limit: '25' } }));
  const posts = (Array.isArray(media?.data) ? media.data : []).map((m) => post({ id: m?.id, url: m?.permalink, text: m?.caption ?? '', at: m?.timestamp, likes: m?.like_count, comments: m?.comments_count })).filter(Boolean);
  return { reach: total('reach'), views: total('views'), engagement: total('total_interactions') || engagementOf(posts), topPosts: posts, postsCount: posts.length };
}

async function linkedin({ runner, status, env }) {
  if (status?.targetKind === 'li_org') {
    const stats = okBody(await runner.own('linkedin', { method: 'GET', path: '/rest/organizationalEntityShareStatistics', query: { q: 'organizationalEntity', organizationalEntity: 'urn:li:organization:{target}' }, headers: { 'LinkedIn-Version': '202610', 'X-Restli-Protocol-Version': '2.0.0' } }));
    const t = (Array.isArray(stats?.elements) ? stats.elements : [])[0]?.totalShareStatistics ?? {};
    let followers;
    try {
      const f = okBody(await runner.own('linkedin', { method: 'GET', path: '/rest/organizationalEntityFollowerStatistics', query: { q: 'organizationalEntity', organizationalEntity: 'urn:li:organization:{target}' }, headers: { 'LinkedIn-Version': '202610', 'X-Restli-Protocol-Version': '2.0.0' } }));
      const counts = (Array.isArray(f?.elements) ? f.elements : [])[0]?.followerCountsByAssociationType;
      if (Array.isArray(counts)) followers = counts.reduce((a, c) => a + (num(c?.followerCounts?.organicFollowerCount) ?? 0) + (num(c?.followerCounts?.paidFollowerCount) ?? 0), 0);
    } catch {
      /* follower counts are optional */
    }
    return { followers, reach: num(t.uniqueImpressionsCount), views: num(t.impressionCount), engagement: (num(t.likeCount) ?? 0) + (num(t.commentCount) ?? 0) + (num(t.shareCount) ?? 0) };
  }
  // a member profile: only when LinkedIn granted r_member_postAnalytics; otherwise public data is used
  if (String(env.LINKEDIN_MEMBER_ANALYTICS_APPROVED || '') !== '1') return null;
  const body = okBody(await runner.own('linkedin', { method: 'GET', path: '/rest/memberCreatorPostAnalytics', query: { q: 'me', queryType: 'IMPRESSION', aggregation: 'DAILY' }, headers: { 'LinkedIn-Version': '202610', 'X-Restli-Protocol-Version': '2.0.0' } }));
  const rows = Array.isArray(body?.elements) ? body.elements : [];
  return { views: rows.reduce((a, r) => a + (num(r?.count) ?? 0), 0) };
}

async function tiktok({ runner }) {
  const info = okBody(await runner.own('tiktok', { method: 'GET', path: '/v2/user/info/', query: { fields: 'follower_count,following_count,likes_count,video_count' } }));
  const u = info?.data?.user ?? {};
  const list = okBody(await runner.own('tiktok', { method: 'POST', path: '/v2/video/list/', query: { fields: 'id,title,create_time,view_count,like_count,comment_count,share_count' }, body: { max_count: 20 } }));
  const posts = (Array.isArray(list?.data?.videos) ? list.data.videos : []).map((v) => post({ id: v?.id, text: v?.title ?? '', at: v?.create_time, likes: v?.like_count, comments: v?.comment_count, shares: v?.share_count, views: v?.view_count })).filter(Boolean);
  return { followers: num(u.follower_count), postsCount: num(u.video_count), engagement: engagementOf(posts), views: posts.reduce((a, p) => a + (p.views ?? 0), 0), topPosts: posts };
}

async function x({ runner, recordEstimate }) {
  const me = okBody(await runner.own('x', { method: 'GET', path: '/2/users/me', query: { 'user.fields': 'public_metrics' }, baseUrlOverride: 'https://api.x.com' }));
  const id = /^\d{1,25}$/.test(String(me?.data?.id ?? '')) ? me.data.id : '';
  const pm = me?.data?.public_metrics ?? {};
  let posts = [];
  if (id) {
    const tw = okBody(await runner.own('x', { method: 'GET', path: `/2/users/${id}/tweets`, query: { 'tweet.fields': 'public_metrics,created_at', max_results: '20' }, baseUrlOverride: 'https://api.x.com' }));
    const list = Array.isArray(tw?.data) ? tw.data : [];
    // X bills reads (about $0.005 per post read): an estimated ledger row, never counted toward a cap
    await recordEstimate?.('x', 'x:GET /2/users/:id/tweets', list.length * 5000);
    posts = list.map((t) => post({ id: t?.id, url: t?.id ? `https://x.com/i/web/status/${t.id}` : undefined, text: t?.text ?? '', at: t?.created_at, likes: t?.public_metrics?.like_count, comments: t?.public_metrics?.reply_count, shares: t?.public_metrics?.retweet_count, views: t?.public_metrics?.impression_count })).filter(Boolean);
  }
  return { followers: num(pm.followers_count), postsCount: num(pm.tweet_count), engagement: engagementOf(posts), topPosts: posts };
}

async function youtube({ runner, since, until }) {
  const rep = okBody(await runner.own('youtube', { method: 'GET', path: '/v2/reports', baseUrlOverride: 'https://youtubeanalytics.googleapis.com', query: { ids: 'channel==MINE', startDate: ymd(since), endDate: ymd(until), metrics: 'views,estimatedMinutesWatched,likes,comments,subscribersGained', dimensions: 'day' } }));
  const ch = okBody(await runner.own('youtube', { method: 'GET', path: '/youtube/v3/channels', query: { part: 'statistics', mine: 'true' } }));
  const st = (Array.isArray(ch?.items) ? ch.items : [])[0]?.statistics ?? {};
  const rows = Array.isArray(rep?.rows) ? rep.rows : [];
  const views = rows.reduce((a, r) => a + (num(r?.[1]) ?? 0), 0);
  const engagement = rows.reduce((a, r) => a + (num(r?.[3]) ?? 0) + (num(r?.[4]) ?? 0), 0);
  return {
    followers: num(st.subscriberCount),
    postsCount: num(st.videoCount),
    views,
    engagement,
    series: rows.filter((r) => typeof r?.[0] === 'string').map((r) => ({ date: r[0], engagement: (num(r[3]) ?? 0) + (num(r[4]) ?? 0) })),
  };
}

const READERS = { facebook, instagram, linkedin, tiktok, x, youtube };

/**
 * One network's own stats, or null when this network has no own-stats reader for this connection (the caller
 * then uses public data). Throws { kind: 'reconnect'|'busy'|'upstream' } when the provider refused or failed.
 */
export async function ownStats(network, { runner, fetch = globalThis.fetch, env = process.env, now = Date.now(), status, handle, recordEstimate }) {
  const read = READERS[network];
  if (!read) return null;
  const until = now;
  const since = now - 30 * DAY;
  const got = await read({ runner, fetch, env, since, until, status, recordEstimate });
  if (!got) return null;
  const topPosts = Array.isArray(got.topPosts) ? [...got.topPosts].sort((a, b) => engagementOf([b]) - engagementOf([a])).slice(0, 10) : undefined;
  const out = { network, origin: 'own' };
  if (handle) out.handle = handle;
  for (const k of ['followers', 'postsCount', 'reach', 'views', 'engagement']) if (got[k] !== undefined && got[k] !== null && Number.isFinite(got[k])) out[k] = got[k];
  if (got.series?.length) out.series = got.series;
  if (topPosts?.length) out.topPosts = topPosts;
  return out;
}

