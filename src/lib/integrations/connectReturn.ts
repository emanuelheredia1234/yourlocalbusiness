// Coming back from Zernio's connect page (ad accounts). Zernio sends the browser to the redirect the server gave it
// (the app's address with ?ylb_connect=<our platform>) and adds its own parameters:
//   success: ?connected=<zernio platform>&profileId=…&accountId=…
//   failure: ?error=…&platform=…&error_reason=…&error_message=…&is_user_fixable=…
// parseConnectReturn reads them (pure); takeConnectReturn reads them once and takes them out of the address bar.
// Zernio's error_message is third-party text: it is never shown. The reason is shown in our words, and the two that
// are the team's problem (the ads add-on, Zernio's billing) say what to fix only to the owner.

import { AD_PLATFORMS, type ConnectPlatform } from './types';

/** Zernio's ads account platform names → ours (social names such as "facebook" are only read with ylb_connect). */
const FROM_ZERNIO: Record<string, ConnectPlatform> = {
  metaads: 'meta_ads',
  googleads: 'google_ads',
  linkedinads: 'linkedin_ads',
  tiktokads: 'tiktok_ads',
  pinterestads: 'pinterest_ads',
  xads: 'x_ads',
  redditads: 'reddit_ads',
  microsoftads: 'microsoft_ads',
};

export const CONNECT_ERROR_REASONS = ['no_pages_granted', 'page_not_granted', 'ad_accounts_not_granted', 'ads_addon_required', 'payment_required', 'state_expired', 'invalid_state', 'reconnect_required', 'meta_ads_authorization_denied', 'connection_failed', 'cancelled'] as const;
export type ConnectErrorReason = (typeof CONNECT_ERROR_REASONS)[number];

export type ConnectReturn =
  | { kind: 'connected'; platform: ConnectPlatform | null; accountId?: string }
  | { kind: 'error'; platform: ConnectPlatform | null; reason: ConnectErrorReason; userFixable: boolean };

/** The parameters this module reads (and takes out of the address bar). */
export const CONNECT_PARAMS = ['ylb_connect', 'connected', 'profileId', 'accountId', 'error', 'platform', 'error_reason', 'error_message', 'is_user_fixable'] as const;

const ZID = /^[0-9a-f]{24}$/i;

function platformOf(v: string | null, ours: boolean): ConnectPlatform | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (ours && (AD_PLATFORMS as readonly string[]).includes(s)) return s as ConnectPlatform;
  return FROM_ZERNIO[s] ?? ((AD_PLATFORMS as readonly string[]).includes(s) ? (s as ConnectPlatform) : null);
}

export const isConnectErrorReason = (r: unknown): r is ConnectErrorReason => typeof r === 'string' && (CONNECT_ERROR_REASONS as readonly string[]).includes(r);

/** What an address's query says about a connect that just came back (null when it says nothing). */
export function parseConnectReturn(search: string): ConnectReturn | null {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    return null;
  }
  const ours = q.get('ylb_connect');
  const connected = q.get('connected');
  const error = q.get('error');
  // ?error= alone, from somewhere else (a sign-in page), isn't ours: a Zernio error carries error_reason or our marker
  if (!ours && !connected && !(error && (q.get('error_reason') || q.get('platform')))) return null;
  const platform = platformOf(ours, true) ?? platformOf(connected, false) ?? platformOf(q.get('platform'), false);
  if (error || q.get('error_reason')) {
    const r = (q.get('error_reason') || '').trim().toLowerCase();
    return { kind: 'error', platform, reason: isConnectErrorReason(r) ? r : 'connection_failed', userFixable: q.get('is_user_fixable') === 'true' };
  }
  const accountId = q.get('accountId');
  return { kind: 'connected', platform, ...(accountId && ZID.test(accountId) ? { accountId } : {}) };
}

/** The address without the connect parameters (the rest of the query and the hash kept). */
export function withoutConnectParams(href: string): string {
  const u = new URL(href);
  for (const k of CONNECT_PARAMS) u.searchParams.delete(k);
  const rest = u.searchParams.toString();
  return `${u.pathname}${rest ? `?${rest}` : ''}${u.hash}`;
}

/** Read the connect return once: the parameters leave the address bar either way. */
export function takeConnectReturn(): ConnectReturn | null {
  if (typeof location === 'undefined') return null;
  const ret = parseConnectReturn(location.search);
  if (!ret) return null;
  try {
    history.replaceState(history.state, '', withoutConnectParams(location.href));
  } catch {
    /* it's still handled once: the caller takes it */
  }
  return ret;
}

/** What the person is told about a connect that came back with an error. owner: the app's owner reads what to fix. */
export function connectErrorMessage(reason: ConnectErrorReason, name: string, owner = false): string {
  switch (reason) {
    case 'no_pages_granted':
      return `${name} didn’t share any Facebook Page. Connect again and tick at least one Page.`;
    case 'page_not_granted':
      return `The Page you picked wasn’t shared. Connect again and allow that Page.`;
    case 'ad_accounts_not_granted':
      return `No ad account was shared. Connect again and tick the ad account you want to use.`;
    case 'ads_addon_required':
      return owner ? 'The ads add-on is off for your Zernio team. Turn it on in the Zernio dashboard, then connect again.' : `Connecting ${name} isn’t available right now. Try again later.`;
    case 'payment_required':
      return owner ? 'Zernio’s billing needs attention: add a card or pay the open invoice in the Zernio dashboard, then connect again.' : `Connecting ${name} isn’t available right now. Try again later.`;
    case 'state_expired':
    case 'invalid_state':
      return 'That sign-in took too long or was opened twice. Start again from Connected accounts.';
    case 'reconnect_required':
      return `${name} asked you to sign in again. Press Reconnect.`;
    case 'meta_ads_authorization_denied':
      return 'Meta didn’t allow access to your ads. Connect again and choose Allow.';
    case 'cancelled':
      return 'The sign-in was closed before it finished. Connect again when you’re ready.';
    default:
      return `${name} didn’t connect. Try again.`;
  }
}
