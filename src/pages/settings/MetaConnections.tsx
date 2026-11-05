import { useEffect, useState } from 'react';
import { authHeaders } from '@/lib/cloud/auth';

const API = '/api/integrations/meta';
const PUBLIC_APP = 'https://yourlocalbusiness.replit.app';
const CALLBACKS = [
  `${PUBLIC_APP}/api/integrations/meta/callback/facebook`,
  `${PUBLIC_APP}/api/integrations/meta/callback/instagram`,
];

type MetaAccount = { id: string; name: string; username?: string; kind: 'facebook_page' | 'instagram'; login: 'facebook' | 'instagram' };
type MetaStatus = { credentialsConfigured: boolean; missingCredentials: string[]; storageReady: boolean; accounts: MetaAccount[]; owner: boolean };

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers = new Headers(await authHeaders(path));
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Meta could not complete the request.');
  return result as T;
}

export function MetaConnections() {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const published = typeof window !== 'undefined' && window.location.origin === PUBLIC_APP;

  async function refresh() {
    setLoading(true);
    try {
      setStatus(await request<MetaStatus>(`${API}/status`));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load Meta account connections.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('meta');
    if (outcome) {
      setNotice(outcome === 'connected' ? 'Meta account connected.' : outcome === 'cancelled' ? 'Meta connection was cancelled.' : 'Meta could not complete the connection. Check the setup and try again.');
      params.delete('meta');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
    void refresh();
  }, []);

  async function connect(provider: 'facebook' | 'instagram') {
    setBusy(true);
    setError('');
    try {
      const result = await request<{ authorizationUrl: string }>(`${API}/connect/${provider}`, 'POST', {});
      const target = new URL(result.authorizationUrl);
      const expected = provider === 'facebook' ? 'https://www.facebook.com' : 'https://www.instagram.com';
      if (target.origin !== expected) throw new Error('Meta returned an unexpected sign-in address.');
      window.location.assign(target.toString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the Meta connection.');
      setBusy(false);
    }
  }

  async function disconnect(account: MetaAccount) {
    if (!window.confirm(`Disconnect ${account.name} from this app? This won’t revoke the app in Meta.`)) return;
    setBusy(true);
    try {
      await request(`${API}/accounts/${encodeURIComponent(account.id)}`, 'DELETE');
      await refresh();
      setNotice(`${account.name} disconnected from this app. Revoke the app in Meta to remove its grant too.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disconnect the account.');
    } finally {
      setBusy(false);
    }
  }

  const ready = !!status?.credentialsConfigured && !!status.storageReady;
  return (
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-labelledby="meta-connections-title">
      <div>
        <h2 id="meta-connections-title" className="section-title">Direct posting to Facebook & Instagram</h2>
        <p className="mt-1 text-sm text-muted">Connect your own Facebook Pages or Instagram professional accounts. Personal Facebook and Instagram accounts cannot publish through Meta’s APIs.</p>
      </div>
      {loading && <p className="text-sm text-muted">Checking Meta setup…</p>}
      {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-primary/10 px-3 py-2 text-sm">{notice}</p>}
      {!loading && status?.owner && !status.credentialsConfigured && (
        <div className="rounded-lg bg-surface-2 p-3 text-sm">
          <p>Create a Meta developer app with Facebook Login for Pages and Instagram Login, then add {status.missingCredentials.join(' and ')} in Replit Secrets. These are separate from the AI model key; don’t paste them here.</p>
          <p className="mt-2">Register these exact OAuth callback URLs in the Meta app:</p>
          {CALLBACKS.map((uri) => <code key={uri} className="mt-1 block break-all rounded bg-surface px-2 py-1 text-xs">{uri}</code>)}
          <a className="mt-2 inline-block font-semibold text-primary underline" href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">Meta developer apps</a>
        </div>
      )}
      {!loading && status?.owner && !status.storageReady && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">Secure storage is unavailable. Check the Supabase server secret and confirm the app_state migration is applied.</p>}
      {!published && ready && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
          Start account connection on the published app so Meta returns to the same environment:{' '}
          <a className="font-semibold text-primary underline" href={`${PUBLIC_APP}/#workspace-settings`}>{PUBLIC_APP}</a>
        </p>
      )}
      {ready && published && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void connect('facebook')}>{busy ? 'Connecting…' : 'Connect Facebook Page'}</button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void connect('instagram')}>{busy ? 'Connecting…' : 'Connect Instagram professional account'}</button>
        </div>
      )}
      {!loading && status && !status.owner && !status.credentialsConfigured && <p className="text-sm text-muted">Meta publishing isn’t set up on this app yet.</p>}
      {!!status?.accounts.length && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {status.accounts.map((account) => (
            <li key={`${account.kind}:${account.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="text-sm font-medium">{account.kind === 'facebook_page' ? 'Facebook Page' : 'Instagram'} · {account.name}{account.login === 'instagram' ? ' · Instagram Login' : ''}</span>
              <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void disconnect(account)}>Disconnect</button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">Posts require review before publishing. Scheduled posts run from the app’s server; nothing is sent through Manus.</p>
    </section>
  );
}
