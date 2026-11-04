// Settings → AI → Viktor (Slack): connect the owner's own small Slack app, so the app can send requests to
// Viktor (viktor.com's AI employee in their Slack workspace) as them and bring Viktor's replies back. The Slack
// connector set up in Claude belongs to Claude, not to this app. The token stays on the server: the browser
// only ever sees its last 4 characters (server/providers/store.mjs slackPublic). Self-hosted only, owner only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, ExternalLink, MessageSquare, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pingServer } from '@/ai/claude';
import { readinessText } from '@/ai/agents/who';
import { toast } from '@/store/ui';
import { CopyButton, Field, Spinner, confirmAction } from '@/components/ui/primitives';

/** Settings → AI's request helper (the admin token and the sign-in go with it). */
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
    if (!(await confirmAction({ title: 'Remove the Slack connection?', body: `${revoke ? 'The token is revoked in Slack and removed here.' : 'The token is removed here (it still works in Slack until you revoke it there).'} Build with Viktor and the chat with Viktor stop until you connect again.${secrets ? ' A token in Replit Secrets stays until you remove it there.' : ''}`, confirmLabel: 'Remove', danger: true }))) return;
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

/** The card itself (rendered from what the server said; the render test draws each state). */
export function SlackCardView({ info, error = null, busy = null, bots = null, channels = null, checks = null, onRefresh = noop, onSaveToken = noop, onFindViktor = noop, onPickViktor = noop, onLoadChannels = noop, onWhere = noop, onTest = noop, onRemove = noop }: SlackCardViewProps) {
  const [token, setToken] = useState('');
  const [memberId, setMemberId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [revoke, setRevoke] = useState(true);
  const s = info?.slack ?? null;
  // the radio the owner picked (a channel is saved only once one is chosen from the list)
  const [mode, setMode] = useState<'dm' | 'channel' | ''>('');
  const shown = mode || s?.where?.kind || '';
  const connected = !!s?.configured && s.reason !== 'bad_token';
  const chip = !s || !s.configured ? { text: 'Not connected', cls: 'bg-surface-2 text-muted' } : s.ready ? { text: 'Ready', cls: 'bg-good-soft text-good' } : { text: 'Needs attention', cls: 'bg-warn-soft text-warn' };
  const where = s?.where ?? null;
  const memberOk = MEMBER_ID.test(memberId.trim());

  const saveToken = async () => {
    const t = token.trim();
    if (!t) return;
    const ok = await onSaveToken(t);
    if (ok !== false) setToken('');
  };

  return (
    <section id="settings-slack" className="panel flex flex-col gap-4 p-4 sm:p-5" aria-label="Viktor (Slack)">
      <header className="flex flex-wrap items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-primary">
          <MessageSquare size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink">
            Viktor (Slack) <span className={cn('badge', chip.cls)}>{chip.text}</span>
          </h3>
          {s?.configured && !s.ready && <p className="mt-0.5 text-[12.5px] font-medium text-warn">{readinessText('viktor', s.reason)}</p>}
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
            Viktor is the AI employee from viktor.com in your Slack workspace. To send it your requests and bring its replies back here, this app needs its own small Slack app in your workspace. The Slack connection you set up in Claude belongs to Claude, not to this app. It posts as you, only in the one place you choose below, and reads only the threads it starts.
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
          <RefreshCw size={14} /> Refresh
        </button>
      </header>

      {error && !info && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      {!info && !error && (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={14} /> Checking the Slack connection…
        </p>
      )}

      {info && s && (
        <ol className="flex flex-col gap-4">
          <Step n={1} done={s.configured} title="Create the Slack app">
            <p>In Slack: Create New App → From a manifest → choose the workspace where Viktor is → paste → Next → Create.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <a className="btn btn-primary btn-sm" href={info.manifest.createUrl} target="_blank" rel="noopener noreferrer">
                Create it from the manifest <ExternalLink size={12} />
              </a>
              <a className="btn btn-ghost btn-sm" href={NEW_APP_URL} target="_blank" rel="noopener noreferrer">
                Open Slack <ExternalLink size={12} />
              </a>
              <CopyButton text={info.manifest.yaml} label="Copy the manifest" />
            </div>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2" aria-label="The Slack app manifest">
              {info.manifest.yaml}
            </pre>
          </Step>

          <Step n={2} done={s.configured} title="Install it">
            <p>In your new app, open OAuth &amp; Permissions and press Install to Workspace, then Allow. If your workspace needs an admin to approve apps, Slack asks them first.</p>
            <p className="mt-1">Slack lists the channel permissions as optional: leave them out if you’ll only talk to Viktor in your DM.</p>
          </Step>

          <Step n={3} done={connected} title="Paste the token">
            <p>
              On the same page, under OAuth Tokens, copy the <strong className="text-ink-2">User OAuth Token</strong> (it starts with <code>xoxp-</code>). Paste it here and press Save. On Replit, you can add it as the Secret <code>{s.envKey || 'SLACK_USER_TOKEN'}</code> instead: it wins over one saved here and survives restarts.
            </p>
            {s.source === 'secrets' ? (
              <p className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-surface-2/70 px-3 py-2 text-[12.5px]">
                <ShieldCheck size={14} className="text-good" /> From Replit Secrets ({s.envKey}) <span className="num text-muted">{s.tokenHint}</span>
                {s.team && (
                  <span className="text-muted">
                    · {s.team} as {s.user}
                  </span>
                )}
                <span className="text-muted">· To remove it, delete the Secret in Replit → Secrets.</span>
              </p>
            ) : (
              <>
                {s.configured && (
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px]">
                    <ShieldCheck size={14} className="text-good" /> Connected to <strong className="text-ink-2">{s.team || 'your workspace'}</strong> as <strong className="text-ink-2">{s.user || 'you'}</strong> · <span className="num">{s.tokenHint}</span> (saved here)
                  </p>
                )}
                <form
                  className="mt-2 flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveToken();
                  }}
                >
                  <Field label={s.configured ? 'Replace the token' : 'User OAuth Token'} htmlFor="slack-token" className="min-w-[220px] flex-1">
                    <input id="slack-token" type="password" autoComplete="off" spellCheck={false} className="input" placeholder="xoxp-…" value={token} onChange={(e) => setToken(e.target.value)} />
                  </Field>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={!token.trim() || busy === 'token'}>
                    {busy === 'token' && <Spinner size={14} />} Save
                  </button>
                </form>
              </>
            )}
            {s.configured && s.missingScopes.length > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-warn">
                <CircleAlert size={14} className="mt-0.5 shrink-0" /> Missing permissions: {s.missingScopes.join(', ')}. Create the app again from the manifest and install it.
              </p>
            )}
          </Step>

          <Step n={4} done={!!s.viktor} title="Find Viktor">
            {s.viktor ? (
              <p>
                Viktor: <strong className="text-ink-2">{s.viktor.name || 'Viktor'}</strong> <span className="num text-muted">({s.viktor.userId})</span>
              </p>
            ) : (
              <p>Find Viktor among your workspace’s bots, or paste its member ID.</p>
            )}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <button type="button" className="btn btn-secondary btn-sm" disabled={!connected || busy === 'bots'} onClick={onFindViktor}>
                {busy === 'bots' ? <Spinner size={14} /> : <Search size={14} />} {s.viktor ? 'Find Viktor again' : 'Find Viktor'}
              </button>
              <Field label="Or paste Viktor’s member ID" htmlFor="slack-member" hint="In Slack, open Viktor’s profile → ⋯ → Copy member ID." className="min-w-[200px]">
                <input id="slack-member" className="input" autoComplete="off" spellCheck={false} placeholder="U0123ABCD" value={memberId} onChange={(e) => setMemberId(e.target.value)} disabled={!connected} />
              </Field>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!connected || !memberOk || busy === 'viktor'} onClick={() => onPickViktor(memberId.trim())}>
                Use this ID
              </button>
            </div>
            {bots && (
              <ul className="mt-2 flex flex-col gap-1" aria-label="Bots in your workspace">
                {bots.bots.length === 0 && <li className="text-[12.5px] text-muted">No bots found. Paste Viktor’s member ID instead.</li>}
                {bots.bots.map((b) => (
                  <li key={b.userId} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-[13px]">
                    <span className="font-medium text-ink">{botName(b)}</span>
                    <span className="num text-[11.5px] text-muted">{b.userId}</span>
                    {b.suggested && <span className="badge bg-good-soft text-good">Looks like Viktor</span>}
                    <button type="button" className="btn btn-secondary btn-xs ml-auto" disabled={busy === 'viktor' || s.viktor?.userId === b.userId} onClick={() => onPickViktor(b.userId)}>
                      {s.viktor?.userId === b.userId ? (
                        <>
                          <Check size={12} /> Chosen
                        </>
                      ) : (
                        'Choose'
                      )}
                    </button>
                  </li>
                ))}
                {bots.truncated && <li className="text-[12px] text-muted">Your workspace has many members: if Viktor isn’t listed, paste its member ID.</li>}
              </ul>
            )}
          </Step>

          <Step n={5} done={!!where} title="Where to talk to Viktor">
            <fieldset className="flex flex-col gap-2" disabled={!s.viktor}>
              <legend className="sr-only">Where to talk to Viktor</legend>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="slack-where"
                  className="mt-0.5 h-4 w-4 accent-[rgb(var(--primary))]"
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
              <label className={cn('flex items-start gap-2', !s.channelScopes && 'opacity-60')}>
                <input
                  type="radio"
                  name="slack-where"
                  className="mt-0.5 h-4 w-4 accent-[rgb(var(--primary))]"
                  checked={shown === 'channel'}
                  disabled={!s.channelScopes}
                  onChange={() => {
                    setMode('channel');
                    if (!channels) onLoadChannels();
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-ink">A channel Viktor is in</span>
                  {where?.kind === 'channel' && where.name && <span className="text-muted"> · #{where.name}</span>}
                  {!s.channelScopes && <span className="block text-[12px] text-muted">Install the app again and allow the channel permissions to use a channel.</span>}
                </span>
              </label>
              {s.channelScopes && shown === 'channel' && (
                <div className="flex flex-wrap items-end gap-2 pl-6">
                  {channels ? (
                    <>
                      <Field label="Channel" htmlFor="slack-channel" className="min-w-[200px]">
                        <select id="slack-channel" className="input" value={channelId || (where?.kind === 'channel' ? where.channelId : '')} onChange={(e) => setChannelId(e.target.value)}>
                          <option value="">Choose a channel</option>
                          {channels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.private ? '🔒 ' : '#'}
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!channelId || busy === 'where'} onClick={() => onWhere({ kind: 'channel', channelId })}>
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
            <p className="mt-2 text-[12.5px] text-muted">Each request starts its own thread. In a channel, everyone there can see it, and its first message mentions Viktor. Invite Viktor first: type /invite @Viktor in the channel.</p>
          </Step>
        </ol>
      )}

      {info && s && (
        <footer className="flex flex-col gap-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-secondary btn-sm" disabled={!s.configured || busy === 'test'} onClick={onTest}>
              {busy === 'test' ? <Spinner size={14} /> : <ShieldCheck size={14} />} Test connection
            </button>
            {s.source === 'app' && (
              <>
                <label className="ml-auto flex items-center gap-1.5 text-[12.5px] text-muted">
                  <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} /> Also revoke the token in Slack
                </label>
                <button type="button" className="btn btn-ghost btn-sm text-muted hover:text-bad" disabled={busy === 'remove'} onClick={() => onRemove(revoke)}>
                  <Trash2 size={14} /> Remove
                </button>
              </>
            )}
          </div>
          {checks && (
            <ul className="flex flex-col gap-1" aria-label="Connection checks">
              {checks.map((c) => (
                <li key={c.id} className={cn('flex items-start gap-1.5 text-[12.5px]', c.ok ? 'text-ink-2' : 'text-bad')}>
                  {c.ok ? <Check size={14} className="mt-0.5 shrink-0 text-good" /> : <CircleAlert size={14} className="mt-0.5 shrink-0" />} {c.text}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11.5px] leading-relaxed text-muted">
            What the token can do: it acts as you in Slack, and can read your direct messages and post where you can. The app keeps it on this server, encrypted, never shows it again, and only posts in the place you chose and reads the threads it started. Each request uses Viktor’s credits on your viktor.com plan; the app can’t see how many. Manus uses your Manus key above: its Powers list has Building pages &amp; assets and Chat with Manus.
          </p>
        </footer>
      )}
    </section>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={cn('num flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold', done ? 'bg-good-soft text-good' : 'bg-surface-2 text-ink-2')} aria-label={done ? `Step ${n}, done` : `Step ${n}`}>
        {done ? <Check size={13} /> : n}
      </span>
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
        <p className="font-semibold text-ink">{title}</p>
        {children}
      </div>
    </li>
  );
}
