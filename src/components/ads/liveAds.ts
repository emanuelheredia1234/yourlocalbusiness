// The campaigns that keep spending when the app can no longer reach them (R12): named before deleting the app
// account or disconnecting a Meta/Google ads connection. Our own words and numbers; nothing here writes.
import type { AdsPlatform, LiveAdRow } from '@/lib/ads/launchTypes';
import { PLATFORM_LABEL } from '@/lib/ads/launchTypes';
import { getLiveAds } from '@/lib/ads/launchApi';
import { money } from '@/lib/ads/launchFormat';

/** "Spring fixes on Meta (…1234), $25.00 a day" */
export const liveAdLine = (r: LiveAdRow) => `${r.name || 'Campaign'} on ${PLATFORM_LABEL[r.platform]} (…${r.idTail}), ${money(r.daily, r.currency)} a day`;

/** The live list, or [] when it can't be read (ads off, signed out, the artifact build): the server checks again. */
export async function liveAdsFor(platform?: AdsPlatform): Promise<LiveAdRow[]> {
  if (__ARTIFACT_BUILD__) return [];
  try {
    return (await getLiveAds(platform)).live;
  } catch {
    return [];
  }
}

/** The disconnect confirm's extra words for the campaigns on that connection whose switch is on. */
export function disconnectWarning(live: LiveAdRow[]): string {
  if (!live.length) return '';
  return ` ${live.length === 1 ? 'This campaign is' : 'These campaigns are'} still on: ${live.map(liveAdLine).join('; ')}. After disconnecting, the app can’t pause ${live.length === 1 ? 'it' : 'them'}. ${live.length === 1 ? 'It keeps' : 'They keep'} running until you pause ${live.length === 1 ? 'it' : 'them'} in Ads Manager.`;
}
