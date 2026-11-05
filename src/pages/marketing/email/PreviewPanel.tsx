import { useEffect, useState } from 'react';
import { Download, ExternalLink, Mail } from 'lucide-react';
import type { Project } from '@/lib/types';
import { slugify } from '@/lib/utils';
import { renderTokens } from '@/ai/local/email';
import { delayLabel, sequenceCsv } from '@/lib/emailFunnel';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Callout, CopyButton, Empty, InfoTip, Section, StatusDot } from '@/components/ui/primitives';
import { BrowserFrame } from '@/components/frames/Frames';
import { download } from '@/components/ui/download';
import { authHeaders } from '@/lib/cloud/auth';
import { EmailView, PanelHead, emailTokens } from './shared';

const OMNISEND_CALLBACK_URL = 'https://yourlocalbusiness.replit.app/api/integrations/omnisend/callback';
const OMNISEND_PUBLIC_APP_URL = 'https://yourlocalbusiness.replit.app';

type OmnisendStatus = {
  credentialsConfigured: boolean;
  missingCredentials: string[];
  storageReady: boolean;
  connected: boolean;
  scopes: string[];
};

type DraftState = { busy?: boolean; message?: string; url?: string };

const PROVIDERS = [
  { name: 'Kit (ConvertKit)', url: 'https://kit.com' },
  { name: 'Mailchimp', url: 'https://mailchimp.com' },
  { name: 'MailerLite', url: 'https://www.mailerlite.com' },
  { name: 'Brevo', url: 'https://www.brevo.com' },
];

async function omnisendRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers = new Headers(await authHeaders(path));
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error : 'The Omnisend request failed.'), { status: response.status });
  return result as T;
}

/** The server has no Omnisend routes (an older server, or no server at all): the card stays out of the way. */
const notOffered = (e: unknown) => e instanceof TypeError || (e as { status?: number })?.status === 404;

/** Omnisend: connect your own brand and create campaign drafts from the sequence (the app never sends). */
function useOmnisend() {
  const [status, setStatus] = useState<OmnisendStatus | null>(null);
  const [unavailable, setUnavailable] = useState(__ARTIFACT_BUILD__);
  const [loading, setLoading] = useState(!__ARTIFACT_BUILD__);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      setStatus(await omnisendRequest<OmnisendStatus>('/api/integrations/omnisend/status'));
      setError('');
    } catch (e) {
      if (notOffered(e)) setUnavailable(true);
      else setError(e instanceof Error ? e.message : 'Could not load the Omnisend connection.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    // back from Omnisend's sign-in: say how it went, then drop the marker from the address
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
      setNotice(messages[outcome] || 'Returned from Omnisend.');
      params.delete('omnisend');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
    void refresh();
  }, []);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      const result = await omnisendRequest<{ authorizationUrl: string }>('/api/integrations/omnisend/connect', 'POST', {});
      const target = new URL(result.authorizationUrl);
      if (target.origin !== 'https://app.omnisend.com') throw new Error('Omnisend returned an unexpected sign-in URL.');
      window.location.assign(target.toString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the Omnisend connection.');
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await omnisendRequest('/api/integrations/omnisend/connection', 'DELETE');
      await refresh();
      setNotice('Omnisend was disconnected from this app. To revoke the grant completely, also remove the app in Omnisend.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disconnect Omnisend.');
    } finally {
      setBusy(false);
    }
  }

  return { status, unavailable, loading, busy, error, notice, setNotice, connect, disconnect };
}

type Omnisend = ReturnType<typeof useOmnisend>;

function OmnisendCard({ omnisend }: { omnisend: Omnisend }) {
  const { status, unavailable, loading, busy, error, notice, setNotice, connect, disconnect } = omnisend;
  if (unavailable) return null;
  const isPublishedApp = typeof window !== 'undefined' && window.location.origin === OMNISEND_PUBLIC_APP_URL;
  const canConnect = !!status && !status.connected && status.credentialsConfigured && status.storageReady && isPublishedApp;
  const needsSetup = !loading && !!status && !status.credentialsConfigured;
  return (
    <section className="card flex flex-col gap-3 p-4" aria-labelledby="omnisend-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="omnisend-heading" className="text-h4 text-ink">
            Omnisend
          </h2>
          <p className="text-small text-muted">Create campaign drafts in your own Omnisend brand. This app never sends them.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {loading ? (
            <span className="text-small text-muted">Checking connection…</span>
          ) : status?.connected ? (
            <StatusDot tone="good">Connected</StatusDot>
          ) : (
            <StatusDot tone="faint">Not connected</StatusDot>
          )}
          {status?.connected ? (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void disconnect()}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : canConnect ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || loading} onClick={() => void connect()}>
              {busy ? 'Connecting…' : 'Connect Omnisend'}
            </button>
          ) : null}
        </div>
      </div>
      {notice && (
        <div role="status">
          <Callout tone="info" onDismiss={() => setNotice('')}>
            {notice}
          </Callout>
        </div>
      )}
      {error && <Callout tone="bad">{error}</Callout>}
      {!loading && status && !status.storageReady && (
        <Callout tone="warn">Secure token storage is unavailable. Check the Supabase server secret and confirm the app_state migration is applied.</Callout>
      )}
      {!loading && status?.credentialsConfigured && status.storageReady && !status.connected && !isPublishedApp && (
        <Callout tone="info">
          Connect from the published app, so Omnisend returns to the same place:{' '}
          <a className="link" href={`${OMNISEND_PUBLIC_APP_URL}/#marketing-email`}>
            {OMNISEND_PUBLIC_APP_URL.replace(/^https:\/\//, '')}
          </a>
        </Callout>
      )}
      {needsSetup && (
        <Accordion type="single" collapsible>
          <AccordionItem value="setup" className="border-b-0">
            <AccordionTrigger className="py-2 text-small">How to set up Omnisend</AccordionTrigger>
            <AccordionContent className="text-small text-ink-2">
              <p>
                Ask Omnisend for OAuth app credentials with{' '}
                <a className="link" href="https://forms.gle/axz6ychcELUuPrR28" target="_blank" rel="noopener noreferrer">
                  their developer form
                </a>
                . When they arrive, add {status.missingCredentials.join(' and ')} in Replit Secrets. Don’t paste them here.
              </p>
              <p className="mt-2">Register this exact redirect URI with Omnisend:</p>
              <div className="well mt-1 flex items-center gap-2 px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-caption">{OMNISEND_CALLBACK_URL}</code>
                <CopyButton size="xs" text={OMNISEND_CALLBACK_URL} />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </section>
  );
}

/** See each email the way subscribers will, then take the sequence to your email provider. */
export function PreviewPanel({ project, onWrite }: { project: Project; onWrite: () => void }) {
  const emails = project.marketing.emails;
  const tokens = emailTokens(project);
  const omnisend = useOmnisend();
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});

  async function createOmnisendDraft(emailId: string, index: number) {
    const email = emails[index];
    if (!email) return;
    setDrafts((current) => ({ ...current, [emailId]: { busy: true } }));
    try {
      const result = await omnisendRequest<{ campaign: { name: string; url?: string } }>('/api/integrations/omnisend/campaign-drafts', 'POST', {
        name: `${project.brand.name} — Email ${index + 1}`,
        subject: renderTokens(email.subject, tokens),
        preheader: renderTokens(email.preview, tokens),
        body: email.body,
        ctaLabel: email.ctaLabel,
        ctaUrl: email.ctaUrl,
      });
      setDrafts((current) => ({
        ...current,
        [emailId]: { message: `Draft created in Omnisend: ${result.campaign.name}. Nothing has been sent.`, url: result.campaign.url || '' },
      }));
    } catch (e) {
      setDrafts((current) => ({ ...current, [emailId]: { message: e instanceof Error ? e.message : 'Could not create the Omnisend draft.' } }));
    }
  }

  if (!emails.length) {
    return (
      <div className="flex flex-col gap-4">
        <OmnisendCard omnisend={omnisend} />
        <div className="card">
          <Empty
            icon={<Mail />}
            title="No emails yet"
            body="Write the five welcome emails first, then preview and export them here."
            action={
              <button type="button" className="btn btn-secondary btn-sm" onClick={onWrite}>
                Write the sequence
              </button>
            }
          />
        </div>
      </div>
    );
  }
  const connected = !!omnisend.status?.connected;
  return (
    // the panel sits right under the tabs (a Section's own top margin is for a section after another)
    <Section className="mt-0">
      <PanelHead
        title={
          <span className="inline-flex items-center gap-1">
            Preview & export
            <InfoTip title="Email tools that send it">
              <span className="block">This app doesn’t send email. Set the sequence up as an automation in your email tool, which sends it to everyone who signs up.</span>
              <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {PROVIDERS.map((p) => (
                  <a key={p.name} href={p.url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
                    {p.name} <ExternalLink size={12} aria-hidden="true" />
                  </a>
                ))}
              </span>
            </InfoTip>
          </span>
        }
        description="Set it up as an automation in your email tool. Values in [brackets] are filled in by it."
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => download(`${slugify(project.brand.name)}-email-sequence.csv`, sequenceCsv(project))}>
            <Download /> Export CSV
          </button>
        }
      />
      {!omnisend.unavailable && (
        <div className="mb-6">
          <OmnisendCard omnisend={omnisend} />
        </div>
      )}
      <ol className="flex flex-col gap-6">
        {emails.map((e, i) => {
          const draft = drafts[e.id];
          return (
            <li key={e.id} className="grid grid-cols-1 gap-3 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-6">
              <div className="flex flex-row flex-wrap items-center gap-x-3 gap-y-2 lg:flex-col lg:items-start">
                <div>
                  <p className="text-h4 text-ink">Email {i + 1}</p>
                  <p className="num font-mono text-caption text-muted">{delayLabel(e, i)}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <CopyButton size="xs" label="Copy subject" text={() => renderTokens(e.subject, tokens)} />
                  <CopyButton size="xs" label="Copy body" text={() => e.body} />
                  {connected && (
                    <button type="button" className="btn btn-secondary btn-xs" disabled={!!draft?.busy} onClick={() => void createOmnisendDraft(e.id, i)}>
                      {draft?.busy ? 'Creating…' : 'Create Omnisend draft'}
                    </button>
                  )}
                </div>
                {draft?.message && (
                  <p role="status" className="text-caption text-muted lg:max-w-[180px]">
                    {draft.message}
                    {draft.url && (
                      <>
                        {' '}
                        <a className="link" href={draft.url} target="_blank" rel="noopener noreferrer">
                          Open draft
                        </a>
                      </>
                    )}
                  </p>
                )}
              </div>
              <BrowserFrame className="max-w-[720px]">
                <EmailView project={project} email={e} tokens={tokens} />
              </BrowserFrame>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
