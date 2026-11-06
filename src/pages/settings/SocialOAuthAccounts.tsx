// Settings › Connected accounts › Direct connections. One Facebook, Instagram, TikTok, X, Pinterest,
// and YouTube connection per business, stored on this app. Connect starts only on the published app.
// The server holds the tokens. Nothing is posted from here. Upload-Post stays the posting path.
import { useEffect, useState } from 'react';
import { Pin } from 'lucide-react';
import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import type { SocialPlatform } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { Callout, CopyButton, SettingsRow, SettingsSection, Spinner, StatusDot, confirmAction } from '@/components/ui/primitives';

const PUBLIC_APP_URL = 'https://yourlocalbusiness.replit.app';
const SETTINGS_URL = `${PUBLIC_APP_URL}/?settings=accounts#workspace-settings`;

type ProviderId = 'meta' | 'instagram' | 'tiktok' | 'x' | 'pinterest' | 'youtube';
type Reconnect = 'revoked' | 'scopes' | 'unreadable';

interface ProviderSpec {
  id: ProviderId;
  label: string;
  secrets: string;
  callback: string;
  origin: string;
  path: string;
  mark: SocialPlatform | 'pinterest';
}

export const SOCIAL_OAUTH_PROVIDERS: readonly ProviderSpec[] = [
  { id: 'meta', label: 'Facebook', secrets: 'META_APP_ID and META_APP_SECRET', callback: `${PUBLIC_APP_URL}/api/integrations/meta/callback`, origin: 'https://www.facebook.com', path: '/dialog/oauth', mark: 'facebook' },
  { id: 'instagram', label: 'Instagram', secrets: 'META_APP_ID and META_APP_SECRET', callback: `${PUBLIC_APP_URL}/api/integrations/instagram/callback`, origin: 'https://www.facebook.com', path: '/dialog/oauth', mark: 'instagram' },
  { id: 'tiktok', label: 'TikTok', secrets: 'TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET', callback: `${PUBLIC_APP_URL}/api/integrations/tiktok/callback`, origin: 'https://www.tiktok.com', path: '/v2/auth/authorize', mark: 'tiktok' },
  { id: 'x', label: 'X', secrets: 'X_CLIENT_ID and X_CLIENT_SECRET', callback: `${PUBLIC_APP_URL}/api/integrations/x/callback`, origin: 'https://x.com', path: '/i/oauth2/authorize', mark: 'x' },
  { id: 'pinterest', label: 'Pinterest', secrets: 'PINTEREST_APP_ID and PINTEREST_APP_SECRET', callback: `${PUBLIC_APP_URL}/api/integrations/pinterest/callback`, origin: 'https://www.pinterest.com', path: '/oauth', mark: 'pinterest' },
  { id: 'youtube', label: 'YouTube', secrets: 'YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET', callback: `${PUBLIC_APP_URL}/api/integrations/youtube/callback`, origin: 'https://accounts.google.com', path: '/o/oauth2/', mark: 'youtube' },
];

const OUTCOMES: Record<string, string> = {
  connected: 'is connected. Nothing has been posted.',
  cancelled: 'connection was cancelled.',
  invalid_state: 'sign-in couldn’t be matched to this browser, or took longer than 10 minutes. Connect again from this browser.',
  scopes: 'didn’t grant permission to publish. Connect again and allow publishing.',
  identity: 'didn’t confirm which account this is. Connect again.',
  busy: 'Too many sign-ins at once. Wait a minute, then connect again.',
  setup: 'isn’t set up on this app yet.',
  error: 'couldn’t complete the connection. Try connecting again.',
};

interface AccountStatus {
  provider: ProviderId;
  credentialsConfigured: boolean;
  missingCredentials: string[];
  storageReady: boolean;
  connected: boolean;
  reconnect: Reconnect | null;
  scopes: string[];
  accountLabel: string;
  accountId: string;
  owner: boolean;
}

class SocialRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function socialRequest(path: string, { method = 'GET', body, base, credentials }: { method?: string; body?: unknown; base?: string; credentials?: RequestCredentials } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await serverFetch(base ?? serverBaseNow(), path, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      ...(credentials ? { credentials } : {}),
    });
  } catch {
    throw new SocialRequestError('Couldn’t reach the server. Check your connection, then try again.', 0, 'NETWORK');
  }
  const result = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const record = (result && typeof result === 'object' ? result : {}) as { error?: unknown; code?: unknown };
    throw new SocialRequestError(typeof record.error === 'string' && record.error ? record.error : `The request failed (error ${response.status}).`, response.status, typeof record.code === 'string' ? record.code : '');
  }
  return result;
}

function toAccount(raw: unknown): AccountStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.provider !== 'string' || typeof record.credentialsConfigured !== 'boolean' || typeof record.storageReady !== 'boolean' || typeof record.connected !== 'boolean' || typeof record.accountLabel !== 'string') return null;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  const provider = SOCIAL_OAUTH_PROVIDERS.find((item) => item.id === record.provider);
  if (!provider) return null;
  return {
    provider: provider.id,
    credentialsConfigured: record.credentialsConfigured,
    missingCredentials: strings(record.missingCredentials),
    storageReady: record.storageReady,
    connected: record.connected,
    reconnect: record.reconnect === 'revoked' || record.reconnect === 'scopes' || record.reconnect === 'unreadable' ? record.reconnect : null,
    scopes: strings(record.scopes),
    accountLabel: record.accountLabel,
    accountId: typeof record.accountId === 'string' ? record.accountId : '',
    owner: record.owner === true,
  };
}

function toBundle(raw: unknown): AccountStatus[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const accounts = (raw as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return null;
  const parsed = accounts.map(toAccount);
  if (parsed.some((account) => !account)) return null;
  return parsed as AccountStatus[];
}

const specFor = (id: ProviderId) => SOCIAL_OAUTH_PROVIDERS.find((item) => item.id === id)!;

function outcomeText(marker: string, owner: boolean): string {
  const dot = marker.indexOf('.');
  if (dot < 1) return '';
  const id = marker.slice(0, dot);
  const outcome = marker.slice(dot + 1);
  const spec = SOCIAL_OAUTH_PROVIDERS.find((item) => item.id === id);
  if (!spec || !Object.hasOwn(OUTCOMES, outcome)) return '';
  if (outcome === 'busy') return OUTCOMES.busy;
  if (owner && outcome === 'setup') return `${spec.label} isn’t set up yet. Add ${spec.secrets} in Replit Secrets.`;
  if (owner && outcome === 'error') return `${spec.label} couldn’t complete the connection. Check the app and the registered redirect URI.`;
  if (outcome === 'setup' || outcome === 'connected' || outcome === 'cancelled' || outcome === 'scopes') return `${spec.label} ${OUTCOMES[outcome]}`;
  return `${spec.label} ${OUTCOMES[outcome]}`;
}

function Mark({ spec }: { spec: ProviderSpec }) {
  if (spec.mark === 'pinterest') {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-surface-3 text-ink-2 [&>svg]:size-3.5" aria-hidden="true">
        <Pin />
      </span>
    );
  }
  return <PlatformMark platform={spec.mark} size={20} />;
}

/** Direct connect for the business on screen. Hidden when this server has no social OAuth routes. */
export function SocialOAuthAccounts() {
  const business = useStore((s) => s.projects.find((project) => project.id === s.activeProjectId));
  const projectId = business?.id || '';
  const [accounts, setAccounts] = useState<AccountStatus[] | null>(null);
  const [unavailable, setUnavailable] = useState(__ARTIFACT_BUILD__);
  const [loading, setLoading] = useState(!__ARTIFACT_BUILD__);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [marker, setMarker] = useState('');

  async function refresh(id = projectId) {
    if (!id) {
      setAccounts(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = toBundle(await socialRequest(`/api/integrations/social-oauth/status?projectId=${encodeURIComponent(id)}`));
      if (!next) setUnavailable(true);
      setAccounts(next);
      setError('');
    } catch (caught) {
      const missed = caught instanceof SocialRequestError && (caught.code === 'NETWORK' || caught.status === 404);
      if (missed) setUnavailable(true);
      else setError(caught instanceof Error ? caught.message : 'Could not load direct connections.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    const params = new URLSearchParams(window.location.search);
    const back = params.get('social_oauth');
    if (back) {
      setMarker(back);
      params.delete('social_oauth');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
    void refresh(projectId);
  }, [projectId]);

  async function connect(spec: ProviderSpec) {
    setBusy(spec.id);
    setError('');
    try {
      const result = await socialRequest(`/api/integrations/${spec.id}/connect`, { method: 'POST', body: { projectId }, base: PUBLIC_APP_URL, credentials: 'same-origin' });
      const url = (result as { authorizationUrl?: unknown } | null)?.authorizationUrl;
      let target: URL | null = null;
      try {
        target = typeof url === 'string' ? new URL(url) : null;
      } catch {
        target = null;
      }
      if (!target || target.origin !== spec.origin || !target.pathname.includes(spec.path)) {
        throw new Error(`${spec.label} returned an unexpected sign-in URL.`);
      }
      window.location.assign(target.toString());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not start the ${spec.label} connection.`);
      setBusy('');
    }
  }

  async function disconnect(spec: ProviderSpec) {
    const ok = await confirmAction({
      title: `Disconnect ${spec.label}?`,
      body: `The app stops using this ${spec.label} account for this business. To remove access completely, also remove the app in ${spec.label}’s settings.`,
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    setBusy(spec.id);
    setError('');
    try {
      const result = (await socialRequest(`/api/integrations/${spec.id}/connection?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' })) as { revoked?: unknown } | null;
      await refresh();
      setMarker('');
      setNotice(result?.revoked === true ? `${spec.label} was disconnected and the app’s access was removed at ${spec.label}.` : `${spec.label} was disconnected from this app. To remove access completely, also remove the app in ${spec.label}’s settings.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not disconnect ${spec.label}.`);
    } finally {
      setBusy('');
    }
  }

  if (unavailable) return null;
  const published = typeof window !== 'undefined' && window.location.origin === PUBLIC_APP_URL;
  const owner = accounts?.some((account) => account.owner) === true;
  const shown = notice || (marker && !loading ? outcomeText(marker, owner) : '');
  const name = business?.brand.name.trim() || 'This business';
  const unset = (accounts || []).filter((account) => !account.credentialsConfigured);

  return (
    <SettingsSection
      id="direct-social"
      title="Direct connections"
      description={business ? `Connect ${name}’s own Facebook, Instagram, TikTok, X, Pinterest, and YouTube here. Each business keeps its own. Nothing is posted from this section.` : 'Each business connects its own Facebook, Instagram, TikTok, X, Pinterest, and YouTube. Nothing is posted from this section.'}
    >
      {!business && <p className="pb-3 text-small text-ink-2">Open a business to connect its accounts.</p>}
      {SOCIAL_OAUTH_PROVIDERS.map((spec) => {
        const account = accounts?.find((item) => item.provider === spec.id) || null;
        const ready = !!account && account.credentialsConfigured && account.storageReady;
        const canConnect = ready && !account.connected && published && !!projectId;
        const tone = account?.connected ? 'good' : account?.reconnect ? 'warn' : 'faint';
        const label = loading ? 'Checking…' : account?.connected ? 'Connected' : account?.reconnect ? 'Reconnect needed' : 'Not connected';
        return (
          <SettingsRow key={spec.id} label={<span className="flex min-w-0 items-center gap-2.5"><Mark spec={spec} /><span className="truncate">{spec.label}</span></span>} description={account?.accountLabel || undefined}>
            <span className="flex min-w-0 flex-wrap items-center justify-end gap-3" data-direct={spec.id} data-state={account?.connected ? 'connected' : account?.reconnect ? 'needs_reconnect' : 'not_connected'}>
              <StatusDot tone={tone}>{label}</StatusDot>
              {account?.connected ? (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy === spec.id} onClick={() => void disconnect(spec)}>
                  {busy === spec.id && <Spinner size={14} />}
                  Disconnect
                </button>
              ) : canConnect ? (
                <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy || loading} onClick={() => void connect(spec)}>
                  {busy === spec.id && <Spinner size={14} />}
                  {account.reconnect ? 'Connect again' : 'Connect'}
                </button>
              ) : null}
            </span>
          </SettingsRow>
        );
      })}
      {shown && (
        <div role="status" className="pb-3">
          <Callout tone="info" onDismiss={() => { setNotice(''); setMarker(''); }}>
            {shown}
          </Callout>
        </div>
      )}
      {error && <p role="alert" className="pb-3 text-small text-bad">{error}</p>}
      {!loading && accounts && !owner && unset.length > 0 && <p className="pb-3 text-small text-muted">Some direct connections aren’t set up on this app yet.</p>}
      {!loading && accounts && owner && accounts.some((account) => !account.storageReady) && (
        <div className="pb-3">
          <Callout tone="warn">Secure token storage is unavailable. Check the Supabase server secret and confirm the app_state migration is applied.</Callout>
        </div>
      )}
      {!loading && published && accounts?.some((account) => account.credentialsConfigured && account.storageReady && !account.connected && account.reconnect) && (
        <p className="pb-3 text-small text-ink-2">
          {accounts.filter((account) => account.reconnect).map((account) => {
            const label = specFor(account.provider).label;
            if (account.reconnect === 'unreadable') return `${label}: this app can’t use the saved connection anymore. Connect it again.`;
            if (account.reconnect === 'scopes') return `${label} didn’t grant permission to publish. Connect it again and allow publishing.`;
            return `${label} no longer accepts this connection. Connect it again.`;
          }).join(' ')}
        </p>
      )}
      {!loading && accounts?.some((account) => account.credentialsConfigured && account.storageReady && !account.connected) && !published && (
        <p className="pb-3 text-small text-ink-2">
          Connect from the published app, so the network returns to the same place:{' '}
          <a className="link" href={SETTINGS_URL}>{PUBLIC_APP_URL.replace(/^https:\/\//, '')}</a>
        </p>
      )}
      {!loading && owner && unset.length > 0 && (
        <div className="pb-3">
          <Callout tone="warn" title="Owner setup">
            <p>Add the missing secrets in Replit Secrets. Don’t paste them here. Register each redirect URI on that network’s app. Platform review is still required before anyone who isn’t a tester can connect.</p>
            <ul className="mt-2 flex flex-col gap-2">
              {unset.map((account) => {
                const spec = specFor(account.provider);
                return (
                  <li key={spec.id}>
                    <p className="text-small">{spec.label}: {spec.secrets}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all font-mono text-caption">{spec.callback}</code>
                      <CopyButton size="xs" text={spec.callback} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Callout>
        </div>
      )}
    </SettingsSection>
  );
}
