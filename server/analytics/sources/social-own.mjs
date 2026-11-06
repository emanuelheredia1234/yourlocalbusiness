// The business's own stats from its connected account, normalized to SocialNetworkStats with origin 'own'. Reads
// only, through Upload-Post (server/connections/uploadpost.mjs insights(): the account's followers, reach, views,
// engagement, the reach series and its cached top posts), via the run's runner (one slot set per user).
//
// Numbers and post text from the network are data: kept as numbers and plain text (normalize/util.mjs).

import { engagementOf } from './social-public.mjs';

const DAY = 86_400_000;

/**
 * One network's own stats, or null when the business has no account chosen there (the caller then uses public
 * data). Throws { kind: 'reconnect'|'busy'|'upstream'|'config' } when a read was refused or failed.
 */
export async function ownStats(network, { runner, now = Date.now(), handle }) {
  const until = now;
  const since = now - 30 * DAY;
  const got = await runner.insights(network, { since, until });
  if (!got) return null;
  const topPosts = Array.isArray(got.topPosts) ? [...got.topPosts].sort((a, b) => engagementOf([b]) - engagementOf([a])).slice(0, 10) : undefined;
  const out = { network, origin: 'own' };
  if (handle) out.handle = handle;
  for (const k of ['followers', 'postsCount', 'reach', 'views', 'engagement']) if (got[k] !== undefined && got[k] !== null && Number.isFinite(got[k])) out[k] = got[k];
  if (got.series?.length) out.series = got.series;
  if (topPosts?.length) out.topPosts = topPosts;
  return out;
}
