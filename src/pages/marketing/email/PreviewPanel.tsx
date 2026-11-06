import { useEffect, useState } from 'react';
import { Download, ExternalLink, Mail } from 'lucide-react';
import type { EmailStep, Project } from '@/lib/types';
import { cn, slugify } from '@/lib/utils';
import { renderTokens } from '@/ai/local/email';
import { serverFetch } from '@/ai/claude';
import { delayLabel, sequenceCsv } from '@/lib/emailFunnel';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Callout, CopyButton, Empty, InfoTip, Section, StatusDot } from '@/components/ui/primitives';
import { BrowserFrame } from '@/components/frames/Frames';
import { download } from '@/components/ui/download';
import { serverBaseNow } from '@/lib/cloud/auth';
import { EmailView, PanelHead, emailTokens, hasUnknownBuyLink, missingLinkFix } from './shared';
import { useProjectOffers } from '@/store/offers';
import { toast } from '@/store/ui';

const OMNISEND_CALLBACK_URL = 'https://yourlocalbusiness.replit.app/api/integrations/omnisend/callback';
const OMNISEND_PUBLIC_APP_URL = 'https://yourlocalbusiness.replit.app';
const API = '/api/integrations/omnisend';

/** Why a saved connection can't be used until it's made again. */
type Reconnect = 'revoked' | 'scopes' | 'unreadable';

type OmnisendStatus = {
  credentialsConfigured: boolean;
  missingCredentials: string[];
  storageReady: boolean;
  connected: boolean;
  reconnect: Reconnect | null;
  scopes: string[];
  /** the app's owner: the one who can set Omnisend up */
  owner: boolean;
};

type DraftState = { busy?: boolean; message?: string; url?: string; tone?: 'done' | 'warn' | 'bad' };

const PROVIDERS = [
  { name: 'Kit (ConvertKit)', url: 'https://kit.com' },
  { name: 'Mailchimp', url: 'https://mailchimp.com' },
  { name: 'MailerLite', url: 'https://www.mailerlite.com' },
  { name: 'Brevo', url: 'https://www.brevo.com' },
];

/** How the sign-in at Omnisend went (?omnisend=… when it sends the browser back). */
const OUTCOMES: Record<string, string> = {
  connected: 'Omnisend is connected. You can create drafts here; nothing has been sent.',
  cancelled: 'Omnisend connection was cancelled.',
  invalid_state: 'The Omnisend sign-in couldn’t be matched to this browser, or took longer than 10 minutes. Connect again from this browser.',
  scopes: 'Omnisend didn’t grant the campaign and email-template permissions this app needs. Connect again and allow both.',
  busy: 'Too many Omnisend sign-ins at once. Wait a minute, then connect again.',
  setup: 'Omnisend isn’t set up on this app yet.',
  error: 'Omnisend couldn’t complete the connection. Try connecting again.',
};
/** The same, for the app's owner, where there's something to check. */
const OWNER_OUTCOMES: Record<string, string> = {
  setup: 'Omnisend OAuth credentials are not configured yet. Add them in Replit Secrets after Omnisend issues them.',
  error: 'Omnisend couldn’t complete the connection. Try again; if it keeps failing, check the OAuth credentials and the registered redirect URI.',
};
const outcomeText = (outcome: string, owner: boolean) =>
  (owner && Object.hasOwn(OWNER_OUTCOMES, outcome) ? OWNER_OUTCOMES[outcome] : Object.hasOwn(OUTCOMES, outcome) ? OUTCOMES[outcome] : '') || 'Returned from Omnisend.';

const RECONNECT: Record<Reconnect, string> = {
  revoked: 'Omnisend no longer accepts this app’s connection. Connect Omnisend again to keep creating drafts.',
  scopes: 'Omnisend didn’t grant every permission this app needs. Connect Omnisend again and allow campaigns and email templates.',
  unreadable: 'This app can’t use your saved Omnisend connection anymore. Connect Omnisend again.',
};

/** Refusals after which something may already be in Omnisend: the server's message says what to check. */
const CHECK_OMNISEND = new Set(['OUTCOME_UNKNOWN', 'TEMPLATE_UNCONFIRMED', 'DRAFT_CREATE_FAILED', 'SENDER_REQUIRED']);
/** Refusals that mean the connection has to be made again (the card then offers Connect). */
const RECONNECT_CODES = new Set(['RECONNECT_REQUIRED', 'SCOPE_REQUIRED', 'NOT_CONNECTED']);

class OmnisendRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/** A request to the app's server (as Publish and Leads make them), or to `base`. Throws OmnisendRequestError. */
async function omnisendRequest(path: string, { method = 'GET', body, base, credentials }: { method?: string; body?: unknown; base?: string; credentials?: RequestCredentials } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await serverFetch(base ?? serverBaseNow(), path, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      ...(credentials ? { credentials } : {}),
    });
  } catch {
    throw new OmnisendRequestError('Couldn’t reach the server. Check your connection, then try again.', 0, 'NETWORK');
  }
  const result = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const r = (result && typeof result === 'object' ? result : {}) as { error?: unknown; code?: unknown };
    throw new OmnisendRequestError(typeof r.error === 'string' && r.error ? r.error : `The Omnisend request failed (error ${response.status}).`, response.status, typeof r.code === 'string' ? r.code : '');
  }
  return result;
}

/** The status, when it is one (a static host's page, or an older server's other shape, isn't). */
function toStatus(raw: unknown): OmnisendStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.credentialsConfigured !== 'boolean' || typeof r.storageReady !== 'boolean' || typeof r.connected !== 'boolean' || !Array.isArray(r.missingCredentials)) return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    credentialsConfigured: r.credentialsConfigured,
    missingCredentials: strings(r.missingCredentials),
    storageReady: r.storageReady,
    connected: r.connected,
    reconnect: r.reconnect === 'revoked' || r.reconnect === 'scopes' || r.reconnect === 'unreadable' ? r.reconnect : null,
    scopes: strings(r.scopes),
    owner: r.owner === true,
  };
}

/** The server has no Omnisend routes (an older server, or no server at all): the card stays out of the way. */
const notOffered = (e: unknown) => e instanceof OmnisendRequestError && (e.code === 'NETWORK' || e.status === 404);

const isWebAddress = (value: string) => {
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** One email as its Omnisend draft: every field with the values the preview shows. */
export function omnisendDraft(project: Project, email: EmailStep, index: number, tokens: Record<string, string>) {
  const ctaLabel = renderTokens(email.ctaLabel, tokens).trim();
  return {
    name: `${project.brand.name} — Email ${index + 1}`,
    subject: renderTokens(email.subject, tokens),
    preheader: renderTokens(email.preview, tokens),
    body: renderTokens(email.body, tokens),
    ctaLabel,
    // the preview shows no button without a label: neither does the draft
    ctaUrl: ctaLabel ? renderTokens(email.ctaUrl, tokens).trim() : '',
  };
}

/** Values in [brackets] (a name, a link the brand has no address for): the owner fills them in before sending. */
const hasPlaceholders = (draft: ReturnType<typeof omnisendDraft>) => [draft.subject, draft.preheader, draft.body, draft.ctaLabel].some((text) => /\[[^\]\n]{1,60}\]/.test(text));

/** Omnisend: connect your own brand and create campaign drafts from the sequence (the app never sends). */
function useOmnisend() {
  const [status, setStatus] = useState<OmnisendStatus | null>(null);
  const [unavailable, setUnavailable] = useState(__ARTIFACT_BUILD__);
  const [loading, setLoading] = useState(!__ARTIFACT_BUILD__);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [outcome, setOutcome] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const next = toStatus(await omnisendRequest(`${API}/status`));
      // an answer that isn't a status (a static host's page): no Omnisend here
      if (!next) setUnavailable(true);
      setStatus(next);
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
    // back from Omnisend's sign-in: say how it went (once the status says who's asking), then drop the marker from the address
    const params = new URLSearchParams(window.location.search);
    const back = params.get('omnisend');
    if (back) {
      setOutcome(back);
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
      // started on the published app's own server: Omnisend sends the browser back there, and the cookie that
      // ties the return to this browser is set there (a same-origin request, so the browser keeps it)
      const result = await omnisendRequest(`${API}/connect`, { method: 'POST', body: {}, base: OMNISEND_PUBLIC_APP_URL, credentials: 'same-origin' });
      const url = (result as { authorizationUrl?: unknown } | null)?.authorizationUrl;
      let target: URL | null = null;
      try {
        target = typeof url === 'string' ? new URL(url) : null;
      } catch {
        // not an address at all: refused below like any other
      }
      if (!target || target.origin !== 'https://app.omnisend.com') throw new Error('Omnisend returned an unexpected sign-in URL.');
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
      await omnisendRequest(`${API}/connection`, { method: 'DELETE' });
      await refresh();
      setOutcome('');
      setNotice('Omnisend was disconnected from this app. To revoke the grant completely, also remove the app in Omnisend.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disconnect Omnisend.');
    } finally {
      setBusy(false);
    }
  }

  const dismiss = () => {
    setNotice('');
    setOutcome('');
  };
  // what came back from Omnisend is said once the status is in (the owner gets the setup details)
  const shown = notice || (outcome && !loading ? outcomeText(outcome, !!status?.owner) : '');
  return { status, unavailable, loading, busy, error, notice: shown, dismiss, connect, disconnect, refresh };
}

type Omnisend = ReturnType<typeof useOmnisend>;

function OmnisendCard({ omnisend }: { omnisend: Omnisend }) {
  const { status, unavailable, loading, busy, error, notice, dismiss, connect, disconnect } = omnisend;
  if (unavailable) return null;
  const isPublishedApp = typeof window !== 'undefined' && window.location.origin === OMNISEND_PUBLIC_APP_URL;
  const ready = !!status && status.credentialsConfigured && status.storageReady;
  const canConnect = ready && !status.connected && isPublishedApp;
  const owner = !!status?.owner;
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
          ) : status?.reconnect ? (
            <StatusDot tone="warn">Reconnect needed</StatusDot>
          ) : (
            <StatusDot tone="faint">Not connected</StatusDot>
          )}
          {status?.connected ? (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void disconnect()}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : canConnect ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || loading} onClick={() => void connect()}>
              {busy ? 'Connecting…' : status.reconnect ? 'Connect again' : 'Connect Omnisend'}
            </button>
          ) : null}
        </div>
      </div>
      {notice && (
        <div role="status">
          <Callout tone="info" onDismiss={dismiss}>
            {notice}
          </Callout>
        </div>
      )}
      {error && <Callout tone="bad">{error}</Callout>}
      {!loading && status && !ready && !owner && <p className="text-small text-muted">Omnisend isn’t set up on this app yet.</p>}
      {!loading && status && owner && !status.storageReady && (
        <Callout tone="warn">Secure token storage is unavailable. Check the Supabase server secret and confirm the app_state migration is applied.</Callout>
      )}
      {!loading && ready && !status.connected && (status.reconnect || !isPublishedApp) && (
        <Callout tone={status.reconnect ? 'warn' : 'info'}>
          {status.reconnect && RECONNECT[status.reconnect]}
          {status.reconnect && !isPublishedApp && ' '}
          {!isPublishedApp && (
            <>
              Connect from the published app, so Omnisend returns to the same place:{' '}
              <a className="link" href={`${OMNISEND_PUBLIC_APP_URL}/#marketing-email`}>
                {OMNISEND_PUBLIC_APP_URL.replace(/^https:\/\//, '')}
              </a>
            </>
          )}
        </Callout>
      )}
      {!loading && status && owner && !status.credentialsConfigured && (
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
  // the business's offers, so {{buy:<id>}} buttons show and send their buy links (this tab can open first)
  const { on: offersOn, loaded: offersLoaded } = useProjectOffers(project.id);
  const tokens = emailTokens(project);
  const omnisend = useOmnisend();
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const settle = (emailId: string, state: DraftState) => setDrafts((current) => ({ ...current, [emailId]: state }));

  const exportCsv = () => {
    const csv = sequenceCsv(project, tokens);
    if (hasUnknownBuyLink(csv)) toast({ kind: 'info', title: 'A buy link wasn’t filled in', body: offersOn && !offersLoaded ? 'This business’s offers are still loading. Export again in a moment.' : 'A button’s buy link isn’t one of this business’s offers. Choose one of its offers for it in Sequence.' });
    void download(`${slugify(project.brand.name)}-email-sequence.csv`, csv);
  };

  async function createOmnisendDraft(emailId: string, index: number) {
    const email = emails[index];
    if (!email) return;
    const draft = omnisendDraft(project, email, index, tokens);
    if (offersOn && !offersLoaded && (hasUnknownBuyLink(draft.ctaUrl) || hasUnknownBuyLink(draft.body))) {
      settle(emailId, { tone: 'bad', message: 'This business’s offers are still loading. Try again in a moment.' });
      return;
    }
    // a buy link that isn't one of this business's offers would go nowhere (the server refuses it anyway)
    if (hasUnknownBuyLink(draft.ctaUrl) || hasUnknownBuyLink(draft.body)) {
      settle(emailId, { tone: 'bad', message: 'This buy link isn’t one of this business’s offers. Choose one of its offers for the button, or paste a web address.' });
      return;
    }
    // the draft is what the preview shows, so its button needs somewhere to go first
    if (draft.ctaLabel && !isWebAddress(draft.ctaUrl)) {
      settle(emailId, { tone: 'bad', message: `This email’s button has no web address yet. ${missingLinkFix(project, email.ctaUrl)}` });
      return;
    }
    settle(emailId, { busy: true });
    try {
      const result = (await omnisendRequest(`${API}/campaign-drafts`, { method: 'POST', body: draft })) as { campaign?: { name?: unknown; url?: unknown } } | null;
      const name = typeof result?.campaign?.name === 'string' ? result.campaign.name : draft.name;
      const url = typeof result?.campaign?.url === 'string' && result.campaign.url.startsWith('https://app.omnisend.com/') ? result.campaign.url : '';
      const fill = hasPlaceholders(draft) ? ' Before you send it, replace the values in [brackets] in Omnisend.' : '';
      settle(emailId, { tone: 'done', message: `Draft created in Omnisend: ${name}. Nothing has been sent.${fill}`, url });
    } catch (e) {
      const code = e instanceof OmnisendRequestError ? e.code : '';
      settle(emailId, { tone: CHECK_OMNISEND.has(code) ? 'warn' : 'bad', message: e instanceof Error ? e.message : 'Could not create the Omnisend draft.' });
      // the connection has to be made again: the card says so and offers Connect
      if (RECONNECT_CODES.has(code)) void omnisend.refresh();
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
          <button type="button" className="btn btn-primary btn-sm" onClick={() => exportCsv()}>
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
                  <p role={draft.tone === 'done' ? 'status' : 'alert'} className={cn('text-caption lg:max-w-[180px]', draft.tone === 'bad' ? 'text-bad' : draft.tone === 'warn' ? 'text-warn' : 'text-muted')}>
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
