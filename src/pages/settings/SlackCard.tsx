// Settings › AI keys › Viktor (Slack): connect the owner's own small Slack app, so the app can send requests to
// Viktor (viktor.com's AI employee in their Slack workspace) as them and bring Viktor's replies back. The Slack
// connector set up in Claude belongs to Claude, not to this app. The token stays on the server: the browser
// only ever sees its last 4 characters (server/providers/store.mjs slackPublic). Self-hosted only, owner only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, ExternalLink, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pingServer } from '@/ai/claude';
import { readinessText } from '@/ai/agents/who';
import { toast } from '@/store/ui';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Badge, Callout, CopyButton, Field, InfoTip, Spinner, Stepper, Tooltip, confirmAction } from '@/components/ui/primitives';

/** Settings › AI keys' request helper (the admin token and the sign-in go with it). */
export type SlackCall = <T>(method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; json: (T & { error?: string; code?: string }) | null }>;

/** What the server says about the connection (never the token). */
export interface SlackPublic {
  configured: boolean;
  source: '' | 'app' | 'secrets';
  envKey: string;
  tokenHint: string;
  team: string;
  teamId: string;
  user: string;
  userId: string;
  url: string;
  scopes: string[];
  missingScopes: string[];
  channelScopes: boolean;
  viktor: { userId: string; botId: string; name: string } | null;
  where: { kind: 'dm' | 'channel'; channelId: string; name?: string; private?: boolean } | null;
  problem: { code: string; needed?: string[] } | null;
  ready: boolean;
  reason: string;
  checkedAt: number;
}
export interface SlackInfo {
  slack: SlackPublic;
  manifest: { yaml: string; json: string; createUrl: string };
}
export interface SlackBot {
  userId: string;
  botId?: string;
  name: string;
  realName: string;
  displayName: string;
  suggested: boolean;
}
export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
}
export interface SlackCheck {
  id: string;
  ok: boolean;
  text: string;
}

const NEW_APP_URL = 'https://api.slack.com/apps?new_app=1';
const MEMBER_ID = /^[UW][A-Z0-9]{6,}$/;
const botName = (b: SlackBot) => b.displayName || b.realName || b.name;

/** The card, talking to the server. */
export function SlackCard({ call, serverUrl }: { call: SlackCall; serverUrl: string }) {
  const [info, setInfo] = useState<SlackInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bots, setBots] = useState<{ bots: SlackBot[]; truncated: boolean } | null>(null);
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [checks, setChecks] = useState<SlackCheck[] | null>(null);
  const loads = useRef(0);

  const load = useCallback(async () => {
    const n = ++loads.current;
    const r = await call<SlackInfo>('GET', '/api/ai/slack');
    if (n !== loads.current) return;
    if (r.ok && r.json?.slack) {
      setInfo({ slack: r.json.slack, manifest: r.json.manifest });
      setError(null);
    } else setError(r.json?.error ?? 'Couldn’t load the Slack connection.');
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a change; the server answers with the connection as it now is. */
  const change = async (what: string, method: string, path: string, body: unknown, success?: string): Promise<boolean> => {
    setBusy(what);
    const r = await call<SlackInfo>(method, path, body);
    setBusy(null);
    if (r.json?.slack) setInfo({ slack: r.json.slack, manifest: r.json.manifest ?? info?.manifest ?? { yaml: '', json: '', createUrl: NEW_APP_URL } });
    // the rest of the app (the Build with Viktor buttons, the chat's To: switch) reads the new readiness
    void pingServer(serverUrl);
    if (!r.ok && !(r.status === 502 && r.json?.code === 'NOT_SAVED')) {
      toast({ kind: 'error', title: 'Couldn’t save', body: r.json?.error ?? 'Please try again.' });
      return false;
    }
    if (r.json?.code === 'NOT_SAVED') toast({ kind: 'error', title: 'Working now, but not kept in Supabase', body: r.json.error ?? '' });
    else if (success) toast({ kind: 'success', title: success });
    return true;
  };

  const findViktor = async () => {
    setBusy('bots');
    const r = await call<{ bots: SlackBot[]; truncated: boolean }>('GET', '/api/ai/slack/bots');
    setBusy(null);
    if (r.ok && r.json?.bots) setBots({ bots: r.json.bots, truncated: !!r.json.truncated });
    else toast({ kind: 'error', title: 'Couldn’t list the bots', body: r.json?.error ?? 'Please try again.' });
  };

  const loadChannels = async () => {
    setBusy('channels');
    const r = await call<{ channels: SlackChannel[] }>('GET', '/api/ai/slack/channels');
    setBusy(null);
    if (r.ok && r.json?.channels) setChannels(r.json.channels);
    else toast({ kind: 'error', title: 'Couldn’t list your channels', body: r.json?.error ?? 'Please try again.' });
  };

  const test = async () => {
    setBusy('test');
    setChecks(null);
    const r = await call<{ ok: boolean; checks: SlackCheck[] }>('POST', '/api/ai/slack/test', {});
    setBusy(null);
    setChecks(r.json?.checks ?? [{ id: 'token', ok: false, text: r.json?.error ?? 'No answer from your server.' }]);
    void load();
    void pingServer(serverUrl);
  };

  const remove = async (revoke: boolean) => {
    const secrets = info?.slack.source === 'secrets';
    if (!(await confirmAction({ title: 'Remove the Slack connection?', body: `${revoke ? 'The token is revoked in Slack and removed here.' : 'The token is removed here (it still works in Slack until you revoke it there).'} Build with Viktor and the chat with Viktor stop until you connect again.${secrets ? ' A token set as a server secret stays until you remove it there.' : ''}`, confirmLabel: 'Remove', danger: true }))) return;
    if (await change('remove', 'PUT', '/api/ai/slack', { removeToken: true, revoke }, 'Slack connection removed')) {
      setBots(null);
      setChannels(null);
      setChecks(null);
    }
  };

  return (
    <SlackCardView
      info={info}
      error={error}
      busy={busy}
      bots={bots}
      channels={channels}
      checks={checks}
      onRefresh={() => void load()}
      onSaveToken={(token) => change('token', 'PUT', '/api/ai/slack', { token }, 'Slack connected')}
      onFindViktor={() => void findViktor()}
      onPickViktor={(userId) => void change('viktor', 'PUT', '/api/ai/slack/viktor', { userId }, 'Viktor chosen')}
      onLoadChannels={() => void loadChannels()}
      onWhere={(where) => void change('where', 'PUT', '/api/ai/slack/where', where, where.kind === 'dm' ? 'Your DM with Viktor is set' : 'Channel set')}
      onTest={() => void test()}
      onRemove={(revoke) => void remove(revoke)}
    />
  );
}

export interface SlackCardViewProps {
  info: SlackInfo | null;
  error?: string | null;
  busy?: string | null;
  bots?: { bots: SlackBot[]; truncated: boolean } | null;
  channels?: SlackChannel[] | null;
  checks?: SlackCheck[] | null;
  /** which step starts open (0–4); by default the first one that isn't done */
  initialStep?: number;
  onRefresh?: () => void;
  onSaveToken?: (token: string) => Promise<boolean> | void;
  onFindViktor?: () => void;
  onPickViktor?: (userId: string) => void;
  onLoadChannels?: () => void;
  onWhere?: (where: { kind: 'dm' } | { kind: 'channel'; channelId: string }) => void;
  onTest?: () => void;
  onRemove?: (revoke: boolean) => void;
}

const noop = () => {};
const STEPS = ['Create the Slack app', 'Install it', 'Paste the token', 'Find Viktor', 'Where to talk to Viktor'];

/** The card itself (rendered from what the server said; the render test draws each state). */
export function SlackCardView({ info, error = null, busy = null, bots = null, channels = null, checks = null, initialStep, onRefresh = noop, onSaveToken = noop, onFindViktor = noop, onPickViktor = noop, onLoadChannels = noop, onWhere = noop, onTest = noop, onRemove = noop }: SlackCardViewProps) {
  const [token, setToken] = useState('');
  const [memberId, setMemberId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [revoke, setRevoke] = useState(true);
  // a step the owner opened themselves; before the token, steps 1–2 happen in Slack, so "Next" moves on
  const [view, setView] = useState<number | null>(initialStep ?? null);
  const [reached, setReached] = useState(0);
  const s = info?.slack ?? null;
  // the radio the owner picked (a channel is saved only once one is chosen from the list)
  const [mode, setMode] = useState<'dm' | 'channel' | ''>('');
  const shown = mode || s?.where?.kind || '';
  const connected = !!s?.configured && s.reason !== 'bad_token';
  const chip: { text: string; tone: 'neutral' | 'good' | 'warn' } = !s || !s.configured ? { text: 'Not connected', tone: 'neutral' } : s.ready ? { text: 'Connected', tone: 'good' } : { text: 'Needs attention', tone: 'warn' };
  const where = s?.where ?? null;
  const memberOk = MEMBER_ID.test(memberId.trim());

  const saveToken = async () => {
    const t = token.trim();
    if (!t) return;
    const ok = await onSaveToken(t);
    if (ok !== false) {
      setToken('');
      setView(null);
    }
  };

  const done = s ? [s.configured, s.configured, connected, !!s.viktor, !!where] : [false, false, false, false, false];
  const firstOpen = done.findIndex((d) => !d);
  const current = view ?? (firstOpen === -1 ? -1 : !s?.configured && firstOpen < 2 ? Math.max(firstOpen, reached) : firstOpen);
  const next = (i: number) => {
    setReached(i + 1);
    setView(null);
  };
  // before the token, a step counts as done when the server says so, or (steps 1–2, done in Slack) when the
  // owner has moved past it; opening a later step never marks the token or Viktor as done
  const doneAt = (i: number) => done[i] || (i < current && !s?.configured && i < 2);
  const title = (i: number) => {
    const doneHere = doneAt(i);
    const label = (
      <>
        <span className="sr-only">
          Step {i + 1}
          {doneHere ? ', done' : ''}:{' '}
        </span>
        {STEPS[i]}
      </>
    );
    return i === current ? (
      label
    ) : (
      <button type="button" className="text-left hover:underline" onClick={() => setView(i)}>
        {label}
      </button>
    );
  };
  const stateOf = (i: number): 'done' | 'current' | 'upcoming' => (i === current ? 'current' : doneAt(i) ? 'done' : 'upcoming');

  const tokenSummary = !s ? '' : s.source === 'secrets' ? (
    <>
      From the server’s secrets ({s.envKey}) <span className="num font-mono">{s.tokenHint}</span>
      {s.team && (
        <>
          {' '}
          · {s.team} as {s.user}
        </>
      )}
    </>
  ) : (
    <>
      Connected to <strong className="text-ink-2">{s.team || 'your workspace'}</strong> as <strong className="text-ink-2">{s.user || 'you'}</strong> · <span className="num font-mono">{s.tokenHint}</span> (saved here)
    </>
  );

  return (
    <section id="settings-slack" className="card" aria-label="Viktor (Slack)">
      <div className="flex items-start justify-between gap-3 px-5 pb-1 pt-5">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-h3 text-ink">
            Viktor (Slack) <Badge tone={chip.tone}>{chip.text}</Badge>
          </h3>
          <p className="mt-0.5 text-small text-muted">Viktor is viktor.com’s AI employee in your Slack. The Slack connection you set up in Claude belongs to Claude, not to this app.</p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <InfoTip title="How the Slack app works" label="How the Slack app works">
            To send Viktor your requests and bring its replies back here, this app needs its own small Slack app in your workspace. It posts as you, only in the one place you choose, and reads only the threads it starts. Each request uses Viktor’s credits on your viktor.com plan.
          </InfoTip>
          <Tooltip content="Check the connection again">
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onRefresh} aria-label="Refresh">
              <RefreshCw />
            </button>
          </Tooltip>
        </span>
      </div>

      <div className="px-5 pb-5">
        {s?.configured && !s.ready && <p className="mt-2 text-small text-warn">{readinessText('viktor', s.reason)}</p>}
        {s?.configured && s.missingScopes.length > 0 && (
          <div className="mt-3">
            <Callout tone="warn">Missing permissions: {s.missingScopes.join(', ')}. Create the app again from the manifest and install it.</Callout>
          </div>
        )}
        {error && !info && (
          <p role="alert" className="mt-3 flex items-center gap-1.5 text-small text-bad">
            <CircleAlert size={14} className="shrink-0" aria-hidden="true" /> {error}
          </p>
        )}
        {!info && !error && (
          <p className="mt-3 flex items-center gap-2 text-small text-muted">
            <Spinner size={14} /> Checking the Slack connection…
          </p>
        )}

        {info && s && (
          <div className="mt-4">
            <Stepper
              steps={[
                {
                  title: title(0),
                  state: stateOf(0),
                  summary: s.configured ? 'Created from the manifest' : 'Done in Slack',
                  content: (
                    <div className="flex flex-col gap-3 text-small text-ink-2">
                      <p>
                        In Slack: Create New App › From a manifest › choose the workspace where Viktor is › paste › Next › Create.{' '}
                        <a className="link inline-flex items-center gap-1" href={NEW_APP_URL} target="_blank" rel="noopener noreferrer">
                          Open Slack <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <a className="btn btn-primary btn-sm" href={info.manifest.createUrl} target="_blank" rel="noopener noreferrer">
                          Create it from the manifest <ExternalLink />
                        </a>
                        <CopyButton text={info.manifest.yaml} label="Copy the manifest" />
                        {!s.configured && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => next(0)}>
                            Next <ArrowRight />
                          </button>
                        )}
                      </div>
                      <Accordion type="single" collapsible className="border-t border-line">
                        <AccordionItem value="manifest" className="border-b-0">
                          <AccordionTrigger className="py-2.5 text-small font-medium">View manifest</AccordionTrigger>
                          <AccordionContent className="pb-1">
                            <pre className="well scroll-thin max-h-[200px] overflow-auto p-3 font-mono text-caption text-ink-2" aria-label="The Slack app manifest">
                              {info.manifest.yaml}
                            </pre>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    </div>
                  ),
                },
                {
                  title: title(1),
                  state: stateOf(1),
                  summary: s.configured ? 'Installed in your workspace' : 'Done in Slack',
                  content: (
                    <div className="flex flex-col gap-3 text-small text-ink-2">
                      <p>In your new app, open OAuth &amp; Permissions and press Install to Workspace, then Allow. If your workspace needs an admin to approve apps, Slack asks them first.</p>
                      <p className="text-muted">Slack lists the channel permissions as optional: leave them out if you’ll only talk to Viktor in your DM.</p>
                      {!s.configured && (
                        <span>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => next(1)}>
                            Next <ArrowRight />
                          </button>
                        </span>
                      )}
                    </div>
                  ),
                },
                {
                  title: title(2),
                  state: stateOf(2),
                  summary: tokenSummary,
                  content: (
                    <div className="flex flex-col gap-3 text-small text-ink-2">
                      {s.source === 'secrets' ? (
                        <p className="flex flex-wrap items-center gap-1.5">
                          <ShieldCheck size={14} className="shrink-0 text-good" aria-hidden="true" /> {tokenSummary}
                        </p>
                      ) : (
                        <>
                          <p>
                            On the same page, under OAuth Tokens, copy the <strong className="font-medium text-ink">User OAuth Token</strong> (it starts with <code className="font-mono">xoxp-</code>), paste it here and press Save.
                          </p>
                          {s.configured && (
                            <p className="flex flex-wrap items-center gap-1.5">
                              <ShieldCheck size={14} className="shrink-0 text-good" aria-hidden="true" /> {tokenSummary}
                            </p>
                          )}
                          <form
                            className="flex flex-wrap items-end gap-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void saveToken();
                            }}
                          >
                            <Field label={s.configured ? 'Replace the token' : 'User OAuth Token'} htmlFor="slack-token" className="min-w-[220px] flex-1">
                              <input id="slack-token" type="password" autoComplete="off" spellCheck={false} className="input font-mono" placeholder="xoxp-…" value={token} onChange={(e) => setToken(e.target.value)} />
                            </Field>
                            <button type="submit" className="btn btn-secondary" disabled={!token.trim() || busy === 'token'}>
                              {busy === 'token' && <Spinner size={14} />} Save
                            </button>
                          </form>
                        </>
                      )}
                      <p className="text-caption text-muted">
                        What the token can do: it acts as you in Slack, and can read your direct messages and post where you can. The app keeps it on this server, encrypted, never shows it again, and only posts in the place you chose and reads the threads it started. Each request uses Viktor’s credits on your viktor.com plan; the app can’t see how many. Manus uses your Manus key in Your keys: its Powers list has Building pages &amp; assets and Chat with Manus.
                      </p>
                    </div>
                  ),
                },
                {
                  title: title(3),
                  state: stateOf(3),
                  summary: s.viktor ? (
                    <>
                      {s.viktor.name || 'Viktor'} <span className="num font-mono text-caption">({s.viktor.userId})</span>
                    </>
                  ) : undefined,
                  content: (
                    <div className="flex flex-col gap-3 text-small text-ink-2">
                      {s.viktor ? (
                        <p>
                          Viktor: <strong className="font-medium text-ink">{s.viktor.name || 'Viktor'}</strong> <span className="num font-mono text-caption text-muted">({s.viktor.userId})</span>
                        </p>
                      ) : (
                        <p>Find Viktor among your workspace’s bots, or paste its member ID.</p>
                      )}
                      <div className="flex flex-wrap items-end gap-2">
                        <button type="button" className="btn btn-secondary" disabled={!connected || busy === 'bots'} onClick={onFindViktor}>
                          {busy === 'bots' ? <Spinner size={14} /> : <Search />} {s.viktor ? 'Find Viktor again' : 'Find Viktor'}
                        </button>
                        <Field label="Or paste Viktor’s member ID" htmlFor="slack-member" className="min-w-[200px] flex-1">
                          <input id="slack-member" className="input font-mono" autoComplete="off" spellCheck={false} placeholder="U0123ABCD" value={memberId} onChange={(e) => setMemberId(e.target.value)} disabled={!connected} />
                        </Field>
                        <button type="button" className="btn btn-ghost" disabled={!connected || !memberOk || busy === 'viktor'} onClick={() => onPickViktor(memberId.trim())}>
                          Use this ID
                        </button>
                      </div>
                      <p className="text-caption text-muted">In Slack, open Viktor’s profile › ⋯ › Copy member ID.</p>
                      {bots && (
                        <ul className="flex flex-col divide-y divide-line rounded-pop border border-line" aria-label="Bots in your workspace">
                          {bots.bots.length === 0 && <li className="px-3 py-2.5 text-small text-muted">No bots found. Paste Viktor’s member ID instead.</li>}
                          {bots.bots.map((b) => (
                            <li key={b.userId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                              <span className="text-small font-medium text-ink">{botName(b)}</span>
                              <span className="num font-mono text-caption text-muted">{b.userId}</span>
                              {b.suggested && <Badge tone="good">Looks like Viktor</Badge>}
                              <button type="button" className="btn btn-secondary btn-xs ml-auto" disabled={busy === 'viktor' || s.viktor?.userId === b.userId} onClick={() => onPickViktor(b.userId)}>
                                {s.viktor?.userId === b.userId ? (
                                  <>
                                    <Check /> Chosen
                                  </>
                                ) : (
                                  'Choose'
                                )}
                              </button>
                            </li>
                          ))}
                          {bots.truncated && <li className="px-3 py-2 text-caption text-muted">Your workspace has many members: if Viktor isn’t listed, paste its member ID.</li>}
                        </ul>
                      )}
                    </div>
                  ),
                },
                {
                  title: title(4),
                  state: stateOf(4),
                  summary: where ? (where.kind === 'dm' ? 'Your DM with Viktor' : `#${where.name || 'a channel'}`) : undefined,
                  content: (
                    <div className="flex flex-col gap-3 text-small text-ink-2">
                      <fieldset className="flex flex-col gap-2.5" disabled={!s.viktor}>
                        <legend className="sr-only">Where to talk to Viktor</legend>
                        <label className="flex items-start gap-2.5">
                          <input
                            type="radio"
                            name="slack-where"
                            className="mt-[3px] h-4 w-4"
                            checked={shown === 'dm'}
                            onChange={() => {
                              setMode('dm');
                              onWhere({ kind: 'dm' });
                            }}
                          />
                          <span>
                            <span className="font-medium text-ink">Your DM with Viktor</span> <span className="text-muted">(recommended; only you see it)</span>
                          </span>
                        </label>
                        <label className="flex items-start gap-2.5">
                          <input
                            type="radio"
                            name="slack-where"
                            className="mt-[3px] h-4 w-4"
                            checked={shown === 'channel'}
                            disabled={!s.channelScopes}
                            onChange={() => {
                              setMode('channel');
                              if (!channels) onLoadChannels();
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className={cn('font-medium', s.channelScopes ? 'text-ink' : 'text-faint')}>A channel Viktor is in</span>
                            {where?.kind === 'channel' && where.name && <span className="text-muted"> · #{where.name}</span>}
                            {!s.channelScopes && <span className="block text-caption text-muted">Install the app again and allow the channel permissions to use a channel.</span>}
                          </span>
                        </label>
                        {s.channelScopes && shown === 'channel' && (
                          <div className="flex flex-wrap items-end gap-2 pl-6">
                            {channels ? (
                              <>
                                <Field label="Channel" htmlFor="slack-channel" className="min-w-[200px]">
                                  <select id="slack-channel" className="select" value={channelId || (where?.kind === 'channel' ? where.channelId : '')} onChange={(e) => setChannelId(e.target.value)}>
                                    <option value="">Choose a channel</option>
                                    {channels.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.private ? '🔒 ' : '#'}
                                        {c.name}
                                      </option>
                                    ))}
                                  </select>
                                </Field>
                                <button type="button" className="btn btn-secondary" disabled={!channelId || busy === 'where'} onClick={() => onWhere({ kind: 'channel', channelId })}>
                                  {busy === 'where' && <Spinner size={14} />} Use this channel
                                </button>
                              </>
                            ) : (
                              <button type="button" className="btn btn-ghost btn-sm" disabled={!s.viktor || busy === 'channels'} onClick={onLoadChannels}>
                                {busy === 'channels' && <Spinner size={14} />} Choose a channel…
                              </button>
                            )}
                          </div>
                        )}
                      </fieldset>
                      <p className="text-caption text-muted">Each request starts its own thread. In a channel, everyone there can see it, and its first message mentions Viktor. Invite Viktor first: type /invite @Viktor in the channel.</p>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </div>

      {info && s && (
        <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" className="btn btn-secondary btn-sm" disabled={!s.configured || busy === 'test'} onClick={onTest}>
              {busy === 'test' ? <Spinner size={14} /> : <ShieldCheck />} Test connection
            </button>
            {s.source === 'secrets' && <span className="text-caption text-muted">To remove the token, delete the secret on the server.</span>}
            {s.source === 'app' && (
              <>
                <label className="ml-auto flex items-center gap-1.5 text-small text-muted">
                  <input type="checkbox" className="h-4 w-4" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} /> Also revoke the token in Slack
                </label>
                <button type="button" className="btn btn-danger-ghost btn-sm" disabled={busy === 'remove'} onClick={() => onRemove(revoke)}>
                  <Trash2 /> Remove
                </button>
              </>
            )}
          </div>
          {checks && (
            <ul className="flex flex-col gap-1" aria-label="Connection checks">
              {checks.map((c) => (
                <li key={c.id} className={cn('flex items-start gap-1.5 text-small', c.ok ? 'text-ink-2' : 'text-bad')}>
                  {c.ok ? <Check size={14} className="mt-[3px] shrink-0 text-good" aria-hidden="true" /> : <CircleAlert size={14} className="mt-[3px] shrink-0" aria-hidden="true" />} {c.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
