// Settings › Connected accounts › Gmail. One mailbox per signed-in customer, for outreach later.
// Connect starts only on the published app (the OAuth callback is registered there, as for Omnisend).
// The server holds the tokens; this card never sees them. Nothing is sent from here.
import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import { Callout, CopyButton, SettingsRow, SettingsSection, Spinner, StatusDot, confirmAction } from '@/components/ui/primitives';

const GMAIL_PUBLIC_APP_URL = 'https://yourlocalbusiness.replit.app';
export const GMAIL_CALLBACK_URL = `${GMAIL_PUBLIC_APP_URL}/api/integrations/gmail/callback`;
const GMAIL_SETTINGS_URL = `${GMAIL_PUBLIC_APP_URL}/?settings=accounts#workspace-settings`;
const API = '/api/integrations/gmail';

type Reconnect = 'revoked' | 'scopes' | 'unreadable';

type GmailStatus = {
  credentialsConfigured: boolean;
  missingCredentials: string[];
  storageReady: boolean;
  connected: boolean;
  reconnect: Reconnect | null;
  scopes: string[];
  email: string;
  owner: boolean;
};

const OUTCOMES: Record<string, string> = {
  connected: 'Gmail is connected. Nothing has been sent.',
  cancelled: 'Gmail connection was cancelled.',
  invalid_state: 'The Google sign-in couldn’t be matched to this browser, or took longer than 10 minutes. Connect again from this browser.',
  scopes: 'Google didn’t grant permission to send mail. Connect again and allow sending.',
  identity: 'Google didn’t confirm which mailbox this is. Connect again and allow the email address permission.',
  busy: 'Too many Gmail sign-ins at once. Wait a minute, then connect again.',
  setup: 'Gmail isn’t set up on this app yet.',
  error: 'Google couldn’t complete the connection. Try connecting again.',
};
const OWNER_OUTCOMES: Record<string, string> = {
  setup: 'Gmail OAuth credentials are not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Replit Secrets.',
  error: 'Google couldn’t complete the connection. Try again; if it keeps failing, check the OAuth client and the registered redirect URI.',
};
const outcomeText = (outcome: string, owner: boolean) =>
  (owner && Object.hasOwn(OWNER_OUTCOMES, outcome) ? OWNER_OUTCOMES[outcome] : Object.hasOwn(OUTCOMES, outcome) ? OUTCOMES[outcome] : '') || 'Returned from Google.';

const RECONNECT: Record<Reconnect, string> = {
  revoked: 'Google no longer accepts this connection. Connect Gmail again.',
  scopes: 'Google didn’t grant permission to send. Connect Gmail again and allow sending.',
  unreadable: 'This app can’t use your saved Gmail connection anymore. Connect Gmail again.',
};

class GmailRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function gmailRequest(path: string, { method = 'GET', body, base, credentials }: { method?: string; body?: unknown; base?: string; credentials?: RequestCredentials } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await serverFetch(base ?? serverBaseNow(), path, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      ...(credentials ? { credentials } : {}),
    });
  } catch {
    throw new GmailRequestError('Couldn’t reach the server. Check your connection, then try again.', 0, 'NETWORK');
  }
  const result = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const r = (result && typeof result === 'object' ? result : {}) as { error?: unknown; code?: unknown };
    throw new GmailRequestError(typeof r.error === 'string' && r.error ? r.error : `The Gmail request failed (error ${response.status}).`, response.status, typeof r.code === 'string' ? r.code : '');
  }
  return result;
}

function toStatus(raw: unknown): GmailStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.credentialsConfigured !== 'boolean' || typeof r.storageReady !== 'boolean' || typeof r.connected !== 'boolean' || !Array.isArray(r.missingCredentials) || typeof r.email !== 'string') return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    credentialsConfigured: r.credentialsConfigured,
    missingCredentials: strings(r.missingCredentials),
    storageReady: r.storageReady,
    connected: r.connected,
    reconnect: r.reconnect === 'revoked' || r.reconnect === 'scopes' || r.reconnect === 'unreadable' ? r.reconnect : null,
    scopes: strings(r.scopes),
    email: r.email,
    owner: r.owner === true,
  };
}

const notOffered = (e: unknown) => e instanceof GmailRequestError && (e.code === 'NETWORK' || e.status === 404);

/** Gmail for later outreach: connect or disconnect the signed-in customer's mailbox. Hidden when this server has no Gmail routes. */
export function GmailAccount() {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [unavailable, setUnavailable] = useState(__ARTIFACT_BUILD__);
  const [loading, setLoading] = useState(!__ARTIFACT_BUILD__);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [outcome, setOutcome] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const next = toStatus(await gmailRequest(`${API}/status`));
      if (!next) setUnavailable(true);
      setStatus(next);
      setError('');
    } catch (e) {
      if (notOffered(e)) setUnavailable(true);
      else setError(e instanceof Error ? e.message : 'Could not load the Gmail connection.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    const params = new URLSearchParams(window.location.search);
    const back = params.get('gmail');
    if (back) {
      setOutcome(back);
      params.delete('gmail');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
    void refresh();
  }, []);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      const result = await gmailRequest(`${API}/connect`, { method: 'POST', body: {}, base: GMAIL_PUBLIC_APP_URL, credentials: 'same-origin' });
      const url = (result as { authorizationUrl?: unknown } | null)?.authorizationUrl;
      let target: URL | null = null;
      try {
        target = typeof url === 'string' ? new URL(url) : null;
      } catch {
        // not an address at all: refused below
      }
      if (!target || target.origin !== 'https://accounts.google.com' || !target.pathname.startsWith('/o/oauth2/')) {
        throw new Error('Google returned an unexpected sign-in URL.');
      }
      window.location.assign(target.toString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the Gmail connection.');
      setBusy(false);
    }
  }

  async function disconnect() {
    const ok = await confirmAction({
      title: 'Disconnect Gmail?',
      body: 'The app stops using this mailbox. If Google still lists the app, remove it in your Google Account as well.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const result = (await gmailRequest(`${API}/connection`, { method: 'DELETE' })) as { revoked?: unknown } | null;
      await refresh();
      setOutcome('');
      setNotice(result?.revoked === true ? 'Gmail was disconnected and the app’s access was removed at Google.' : 'Gmail was disconnected from this app. To remove access completely, also remove the app in your Google Account.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disconnect Gmail.');
    } finally {
      setBusy(false);
    }
  }

  if (unavailable) return null;
  const isPublishedApp = typeof window !== 'undefined' && window.location.origin === GMAIL_PUBLIC_APP_URL;
  const ready = !!status && status.credentialsConfigured && status.storageReady;
  const canConnect = ready && !status.connected && isPublishedApp;
  const owner = !!status?.owner;
  const shown = notice || (outcome && !loading ? outcomeText(outcome, owner) : '');
  const tone = status?.connected ? 'good' : status?.reconnect ? 'warn' : 'faint';
  const label = loading ? 'Checking…' : status?.connected ? 'Connected' : status?.reconnect ? 'Reconnect needed' : 'Not connected';

  return (
    <SettingsSection id="gmail-account" title="Gmail" description="Your own Gmail, for outreach later. The app can send mail as you, and never reads your inbox.">
      <SettingsRow
        label={
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-surface-3 text-ink-2 [&>svg]:size-3.5" aria-hidden="true">
              <Mail />
            </span>
            <span className="truncate">Gmail</span>
          </span>
        }
        description={status?.email || undefined}
      >
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-3" data-integration="gmail" data-state={status?.connected ? 'connected' : status?.reconnect ? 'needs_reconnect' : 'not_connected'}>
          <StatusDot tone={tone}>{label}</StatusDot>
          {status?.connected ? (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void disconnect()}>
              {busy && <Spinner size={14} />}
              Disconnect
            </button>
          ) : canConnect ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || loading} onClick={() => void connect()}>
              {busy && <Spinner size={14} />}
              {status.reconnect ? 'Connect again' : 'Connect'}
            </button>
          ) : null}
        </span>
      </SettingsRow>
      {shown && (
        <div role="status" className="pb-3">
          <Callout tone="info" onDismiss={() => { setNotice(''); setOutcome(''); }}>
            {shown}
          </Callout>
        </div>
      )}
      {error && (
        <p role="alert" className="pb-3 text-small text-bad">
          {error}
        </p>
      )}
      {!loading && status && !ready && !owner && <p className="pb-3 text-small text-muted">Connecting Gmail isn’t set up on this app yet.</p>}
      {!loading && status && owner && !status.storageReady && (
        <div className="pb-3">
          <Callout tone="warn">Secure token storage is unavailable. Check the Supabase server secret and confirm the app_state migration is applied.</Callout>
        </div>
      )}
      {!loading && ready && !status.connected && status.reconnect && <p className="pb-3 text-small text-ink-2">{RECONNECT[status.reconnect]}</p>}
      {!loading && ready && !status.connected && !isPublishedApp && (
        <p className="pb-3 text-small text-ink-2">
          Connect from the published app, so Google returns to the same place:{' '}
          <a className="link" href={GMAIL_SETTINGS_URL}>
            {GMAIL_PUBLIC_APP_URL.replace(/^https:\/\//, '')}
          </a>
        </p>
      )}
      {!loading && status && owner && !status.credentialsConfigured && (
        <div className="pb-3">
          <Callout tone="warn" title="Owner setup">
            <p>
              Add {status.missingCredentials.join(' and ')} in Replit Secrets. Don’t paste them here. Create a Google OAuth web client and register this exact redirect URI:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-caption">{GMAIL_CALLBACK_URL}</code>
              <CopyButton size="xs" text={GMAIL_CALLBACK_URL} />
            </div>
          </Callout>
        </div>
      )}
    </SettingsSection>
  );
}
