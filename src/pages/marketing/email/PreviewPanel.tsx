import { useEffect, useState } from 'react';
import { Download, ExternalLink, Mail } from 'lucide-react';
import type { Project } from '@/lib/types';
import { slugify } from '@/lib/utils';
import { renderTokens } from '@/ai/local/email';
import { delayLabel, sequenceCsv } from '@/lib/emailFunnel';
import { CopyButton, Empty } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';
import { authHeaders } from '@/lib/cloud/auth';
import { EmailView, emailTokens } from './shared';

const OMNISEND_CALLBACK_URL = 'https://yourlocalbusiness.replit.app/api/integrations/omnisend/callback';
const OMNISEND_PUBLIC_APP_URL = 'https://yourlocalbusiness.replit.app';

type OmnisendStatus = {
  credentialsConfigured: boolean;
  missingCredentials: string[];
  storageReady: boolean;
  connected: boolean;
  scopes: string[];
};

const PROVIDERS = [
  { name: 'Kit (ConvertKit)', url: 'https://kit.com' },
  { name: 'Mailchimp', url: 'https://mailchimp.com' },
  { name: 'MailerLite', url: 'https://www.mailerlite.com' },
  { name: 'Brevo', url: 'https://www.brevo.com' },
];

/** See each email the way subscribers will, then take the sequence to your email provider. */
export function PreviewPanel({ project, onWrite }: { project: Project; onWrite: () => void }) {
  const emails = project.marketing.emails;
  const tokens = emailTokens(project);
  const isPublishedApp = typeof window !== 'undefined' && window.location.origin === OMNISEND_PUBLIC_APP_URL;
  const [omnisendStatus, setOmnisendStatus] = useState<OmnisendStatus | null>(null);
  const [omnisendLoading, setOmnisendLoading] = useState(true);
  const [omnisendBusy, setOmnisendBusy] = useState(false);
  const [omnisendError, setOmnisendError] = useState('');
  const [omnisendNotice, setOmnisendNotice] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { busy?: boolean; message?: string; url?: string }>>({});

  async function omnisendRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const headers = new Headers(await authHeaders(path));
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'The Omnisend request failed.');
    return result as T;
  }

  async function refreshOmnisendStatus() {
    setOmnisendLoading(true);
    try {
      const status = await omnisendRequest<OmnisendStatus>('/api/integrations/omnisend/status');
      setOmnisendStatus(status);
      setOmnisendError('');
    } catch (error) {
      setOmnisendError(error instanceof Error ? error.message : 'Could not load the Omnisend connection.');
    } finally {
      setOmnisendLoading(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('omnisend');
    if (outcome) {
      const messages: Record<string, string> = {
        connected: 'Omnisend is connected. You can create drafts here; nothing has been sent.',
        cancelled: 'Omnisend connection was cancelled.',
        invalid_state: 'The Omnisend sign-in could not be validated. Start the connection again.',
        setup: 'Omnisend OAuth credentials are not configured yet. Add them in Replit Secrets after Omnisend issues them.',
        error: 'Omnisend could not complete the connection. Check the registered callback URL and OAuth credentials.',
      };
      setOmnisendNotice(messages[outcome] || 'Returned from Omnisend.');
      params.delete('omnisend');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
    void refreshOmnisendStatus();
  }, []);

  async function connectOmnisend() {
    setOmnisendBusy(true);
    setOmnisendError('');
    try {
      const result = await omnisendRequest<{ authorizationUrl: string }>('/api/integrations/omnisend/connect', 'POST', {});
      const target = new URL(result.authorizationUrl);
      if (target.origin !== 'https://app.omnisend.com') throw new Error('Omnisend returned an unexpected sign-in URL.');
      window.location.assign(target.toString());
    } catch (error) {
      setOmnisendError(error instanceof Error ? error.message : 'Could not start the Omnisend connection.');
      setOmnisendBusy(false);
    }
  }

  async function disconnectOmnisend() {
    setOmnisendBusy(true);
    setOmnisendError('');
    try {
      await omnisendRequest('/api/integrations/omnisend/connection', 'DELETE');
      await refreshOmnisendStatus();
      setOmnisendNotice('Omnisend was disconnected from this app. To revoke the grant completely, also remove the app in Omnisend.');
    } catch (error) {
      setOmnisendError(error instanceof Error ? error.message : 'Could not disconnect Omnisend.');
    } finally {
      setOmnisendBusy(false);
    }
  }

  async function createOmnisendDraft(emailId: string, index: number) {
    const email = emails[index];
    if (!email) return;
    setDrafts((current) => ({ ...current, [emailId]: { busy: true } }));
    try {
      const result = await omnisendRequest<{ campaign: { name: string; url?: string } }>(
        '/api/integrations/omnisend/campaign-drafts',
        'POST',
        {
          name: `${project.brand.name} — Email ${index + 1}`,
          subject: renderTokens(email.subject, tokens),
          preheader: renderTokens(email.preview, tokens),
          body: email.body,
          ctaLabel: email.ctaLabel,
          ctaUrl: email.ctaUrl,
        },
      );
      setDrafts((current) => ({
        ...current,
        [emailId]: {
          message: `Draft created in Omnisend: ${result.campaign.name}. Nothing has been sent.`,
          url: result.campaign.url || '',
        },
      }));
    } catch (error) {
      setDrafts((current) => ({
        ...current,
        [emailId]: { message: error instanceof Error ? error.message : 'Could not create the Omnisend draft.' },
      }));
    }
  }

  const omnisendPanel = (
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-labelledby="omnisend-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="omnisend-heading" className="section-title">Omnisend</h2>
          <p className="text-[13px] text-muted">Connect your own Omnisend brand to create campaign drafts. This app does not send campaigns.</p>
        </div>
        {omnisendStatus?.connected ? (
          <button className="btn btn-secondary btn-sm" disabled={omnisendBusy} onClick={() => void disconnectOmnisend()}>
            {omnisendBusy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        ) : omnisendStatus?.credentialsConfigured && omnisendStatus.storageReady && isPublishedApp ? (
          <button className="btn btn-primary btn-sm" disabled={omnisendBusy || omnisendLoading} onClick={() => void connectOmnisend()}>
            {omnisendBusy ? 'Connecting…' : 'Connect Omnisend'}
          </button>
        ) : null}
      </div>
      {omnisendNotice && <p role="status" className="rounded-lg bg-primary/10 px-3 py-2 text-sm">{omnisendNotice}</p>}
      {omnisendError && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700">{omnisendError}</p>}
      {omnisendLoading && <p className="text-sm text-muted">Checking connection…</p>}
      {!omnisendLoading && omnisendStatus && !omnisendStatus.credentialsConfigured && (
        <div className="rounded-lg bg-surface-2 p-3 text-sm">
          <p>OAuth is not configured yet. After Omnisend issues the credentials, add {omnisendStatus.missingCredentials.join(' and ')} in Replit Secrets. Do not paste them here.</p>
          <p className="mt-2">Request OAuth app credentials from <a className="font-semibold text-primary underline" href="https://forms.gle/axz6ychcELUuPrR28" target="_blank" rel="noopener noreferrer">Omnisend’s developer form</a>.</p>
          <p className="mt-2">Register this exact redirect URI:</p>
          <code className="mt-1 block break-all rounded bg-surface px-2 py-1 text-xs">{OMNISEND_CALLBACK_URL}</code>
        </div>
      )}
      {!omnisendLoading && omnisendStatus && !omnisendStatus.storageReady && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">Secure token storage is unavailable. Check the Supabase server secret and confirm the app_state migration is applied.</p>
      )}
      {!omnisendLoading && omnisendStatus?.credentialsConfigured && omnisendStatus.storageReady && !omnisendStatus.connected && !isPublishedApp && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
          Start OAuth from the published app so the callback returns to the same environment: <a className="font-semibold text-primary underline" href={`${OMNISEND_PUBLIC_APP_URL}/#marketing-email`}>{OMNISEND_PUBLIC_APP_URL}</a>
        </p>
      )}
      {omnisendStatus?.connected && (
        <p className="text-sm text-muted">Connected to your Omnisend account. Draft creation uses only your connection; it never sends.</p>
      )}
    </section>
  );

  if (!emails.length) {
    return <div className="flex flex-col gap-4">{omnisendPanel}<Empty icon={<Mail size={20} />} title="No emails yet" body="Write the 5-email sequence first, then preview and export it here." action={<button className="btn btn-primary btn-sm" onClick={onWrite}>Write the sequence</button>} /></div>;
  }
  return (
    <div className="flex flex-col gap-4">
      {omnisendPanel}
      <section className="panel flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-[70ch]">
            <h2 className="section-title">Preview & export</h2>
            <p className="text-[13px] text-muted">This app doesn’t send email. Set the sequence up as an automation in your email provider, which sends it to everyone who signs up. Merge values in brackets are placeholders your provider fills in.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary btn-sm" onClick={() => download(`${slugify(project.brand.name)}-email-sequence.csv`, sequenceCsv(project))}>
              <Download size={14} /> Export CSV
            </button>
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
          Email providers:
          {PROVIDERS.map((p) => (
            <a key={p.name} href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              {p.name} <ExternalLink size={11} />
            </a>
          ))}
        </p>
      </section>
      <ol className="flex flex-col gap-4">
        {emails.map((e, i) => (
          <li key={e.id} className="grid grid-cols-1 gap-3 lg:grid-cols-[200px_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
              <p className="text-[13px] font-semibold">Email {i + 1}</p>
              <p className="text-xs text-muted">{delayLabel(e, i)}</p>
              <div className="flex flex-wrap gap-1.5">
                <CopyButton size="xs" label="Copy subject" text={() => renderTokens(e.subject, tokens)} />
                <CopyButton size="xs" label="Copy body" text={() => e.body} />
                {omnisendStatus?.connected && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    disabled={!!drafts[e.id]?.busy}
                    onClick={() => void createOmnisendDraft(e.id, i)}
                  >
                    {drafts[e.id]?.busy ? 'Creating…' : 'Create Omnisend draft'}
                  </button>
                )}
              </div>
              {drafts[e.id]?.message && (
                <p role="status" className="text-xs text-muted">
                  {drafts[e.id]?.message}
                  {drafts[e.id]?.url && <> {' '}<a className="font-semibold text-primary underline" href={drafts[e.id]?.url} target="_blank" rel="noopener noreferrer">Open draft</a></>}
                </p>
              )}
            </div>
            <EmailView project={project} email={e} tokens={tokens} />
          </li>
        ))}
      </ol>
    </div>
  );
}
