// Today's action: the one most useful thing to do today for this business, on its Dashboard by about 5 am in its
// own time zone (P4). The server makes it (the hourly tick, or the first Dashboard visit after 5 am); in the claude.ai
// build, without accounts or as a guest it's a built-in, rule-based version made in this browser with no request.
//
// A plain card (the plan card stays the page's one AI card) with no filled button: the page keeps its one filled
// button on the next post. "Do it" opens the right screen (or the assistant with a prefilled message); Done and Not
// useful are kept by the server (or this device). Nothing is ever posted, sent or bought from here, and a failed day
// is never re-run by itself: the owner presses "Get today's action".
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Compass, RefreshCw } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { MorningAction, MorningCandidate, MorningReason, MorningToday, MorningVerdict } from '@/lib/integrations/types';
import type { ActionCtx } from '@/lib/strategy';
import { cn } from '@/lib/utils';
import { browserTimeZone, projectTimeZone, timeZoneLabel } from '@/lib/timeZone';
import { useAuth } from '@/lib/cloud/auth';
import { useNow } from '@/lib/hooks';
import { showUpgrade } from '@/lib/billing/upgrade';
import { MORNING, MORNING_REASONS } from '@/lib/morning/contract';
import { useMorningMode } from '@/lib/morning/config';
import { localFeedback, localMorning, useLocalMorningVersion } from '@/lib/morning/local';
import { askHow, doIt } from '@/lib/morning/targets';
import { openPage } from '@/ai/assistant/nav';
import { entryOf, useMorningStore, type MorningEntry } from '@/store/morning';
import { AIThinking, GenerateButton, Spark } from '@/components/ai/AI';
import { Badge, InfoTip, Skeleton } from '@/components/ui/primitives';
import { MORNING_AREA, MORNING_ICON, writes } from './actionMeta';

/** "5:00 AM", the hour every business's action day starts. */
export const MORNING_TIME = `${MORNING.hour}:00 AM`;

/** " (Chicago time)" when the business's zone isn't the browser's. */
export function zoneNote(tz: string, browser = browserTimeZone()): string {
  if (!tz || tz === browser) return '';
  const city = timeZoneLabel(tz).replace(/\s*\(.*\)$/, '');
  return ` (${city} time)`;
}

/** The muted line for a fallback the customer should know about (our words; nothing else about AI trouble shows). */
export function fallbackLine(a: Pick<MorningAction, 'fallback'>): string {
  if (a.fallback === 'own_key') return 'Your own AI key didn’t answer, so this one is from your plan.';
  if (a.fallback === 'credits') return 'This month’s AI credits are used up, so this one is from your plan.';
  if (a.fallback === 'daily_limit') return 'Today’s AI limit is reached, so this one is from your plan.';
  return '';
}

const upgradeLabel = (code: string) => (code === 'PAYMENT_REQUIRED' ? 'Update your card' : code === 'BUSINESS_LIMIT' ? 'See your plan' : 'Start your free trial');

export interface MorningViewProps {
  project: Project;
  /** the built-in version (no server) */
  local: boolean;
  entry: Pick<MorningEntry, 'today' | 'loading' | 'starting' | 'error' | 'notice' | 'locked' | 'stalled'>;
  browserZone?: string;
  onStart: () => void;
  onRefresh: () => void;
  /** the action as it is after the answer (or true when not known), false/null when it wasn't saved */
  onFeedback: (v: MorningVerdict, reason?: MorningReason, note?: string) => Promise<MorningAction | boolean | null> | MorningAction | boolean | null;
  onUpgrade: (code: string) => void;
  /** tests: open the Not useful panel */
  asking?: boolean;
}

function Header({ badge, extra }: { badge?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex min-w-0 items-center gap-2">
        <Spark size={18} />
        <h2 className="truncate text-h3 text-ink">Today’s action</h2>
      </span>
      {badge}
      {extra && <span className="num ml-auto shrink-0 text-small text-muted">{extra}</span>}
    </div>
  );
}

/** The card's body for each state (drawn in tests with fixed data). */
export function MorningCardView({ project, local, entry, browserZone, onStart, onRefresh, onFeedback, onUpgrade, asking = false }: MorningViewProps) {
  const [ask, setAsk] = useState(asking);
  const [reason, setReason] = useState<MorningReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState('');
  // another business: nothing typed, asked or announced for the last one carries over
  const [forId, setForId] = useState(project.id);
  if (forId !== project.id) {
    setForId(project.id);
    setAsk(false);
    setReason(null);
    setNote('');
    setBusy(false);
    setLive('');
  }
  const shownId = useRef(project.id);
  shownId.current = project.id;
  const { today, loading, starting, error, notice, locked, stalled } = entry;
  const tz = today?.timeZone ?? projectTimeZone(project);
  const at = `${MORNING_TIME}${zoneNote(tz, browserZone)}`;
  const a = today?.action ?? null;

  const send = async (v: MorningVerdict, r?: MorningReason, n?: string) => {
    if (busy) return;
    const from = project.id;
    setBusy(true);
    const out = await onFeedback(v, r, n);
    // the owner switched business meanwhile: that answer isn't this card's to announce
    if (shownId.current !== from) return;
    setBusy(false);
    if (!out) {
      setLive('Couldn’t save that. Try again.');
      return;
    }
    setAsk(false);
    setReason(null);
    setNote('');
    if (v === 'done') setLive('Marked done. Nice work.');
    else if (v === 'undo') setLive('Marked not done.');
    // the last idea answered: no other idea today
    else setLive(typeof out === 'object' && out.state === 'dismissed' ? 'Thanks. We’ll pick differently tomorrow.' : 'Thanks. Here’s another idea.');
  };

  let body: ReactNode;
  let badge: ReactNode = null;
  let extra: ReactNode = null;

  if (locked && !local) {
    body = (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-ui text-ink-2">Your morning action is part of every plan.</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onUpgrade(locked)}>
          {upgradeLabel(locked)}
        </button>
      </div>
    );
  } else if (!today && (loading || (!error && !local))) {
    body = (
      <div className="mt-4 flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  } else if (!today) {
    body = (
      <p className="mt-3 text-ui text-ink-2">
        Couldn’t load today’s action.{' '}
        <button type="button" className="link" onClick={onRefresh}>
          Try again
        </button>
      </p>
    );
  } else if (starting || a?.state === 'generating') {
    body = (
      <>
        <AIThinking running compact stage="Picking today’s action…" className="mt-4" />
        <div className="mt-4 flex flex-col gap-2" aria-hidden="true">
          <Skeleton ai className="h-5 w-2/3" />
          <Skeleton ai className="h-4 w-11/12" />
          <Skeleton ai className="h-4 w-3/5" />
        </div>
        {stalled && (
          <p className="mt-3 text-small text-muted">
            {notice}{' '}
            <button type="button" className="link" onClick={onRefresh}>
              Refresh
            </button>
          </p>
        )}
      </>
    );
  } else if (a?.state === 'failed' || (!a && !today.late && (today.dueNow || !!error || !!notice))) {
    const out = a?.state === 'failed' && today.attemptsLeft <= 0;
    body = (
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-ui text-ink-2">{a?.state === 'failed' ? 'Today’s action didn’t come through.' : 'Today’s action isn’t ready yet.'}</p>
        {out ? (
          <p className="text-small text-muted">Try again tomorrow.</p>
        ) : (
          <div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onStart}>
              <RefreshCw /> Get today’s action
            </button>
          </div>
        )}
      </div>
    );
  } else if (!a) {
    body = <p className="mt-3 text-ui text-ink-2">Your next action comes at {at}.</p>;
  } else if (a.state === 'done') {
    body = (
      <div className="mt-3 flex flex-col gap-1">
        <p className="flex items-center gap-2 text-ui text-ink">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary" aria-hidden="true">
            <Check size={14} strokeWidth={3} />
          </span>
          Done. Nice work.
          <button type="button" className="link text-small" disabled={busy} onClick={() => void send('undo')}>
            Undo
          </button>
        </p>
        {a.chosen != null && a.candidates[a.chosen] && <p className="clamp-2 text-small text-muted">{a.candidates[a.chosen].title}</p>}
        <p className="text-small text-muted">Tomorrow’s action comes at {at}.</p>
      </div>
    );
  } else if (a.state === 'dismissed') {
    body = <p className="mt-3 text-ui text-ink-2">{a.candidates.length && a.feedback.length ? `Thanks. We’ll pick differently tomorrow at ${at}.` : `Nothing new for today. Tomorrow’s action comes at ${at}.`}</p>;
  } else {
    const c: MorningCandidate | undefined = a.chosen != null ? a.candidates[a.chosen] : undefined;
    badge = local ? <Badge>Built in</Badge> : a.engine === 'ai' ? <Badge tone="ai">AI pick</Badge> : <Badge>From your plan</Badge>;
    extra = a.feedback.length > 0 && a.chosen != null ? `Idea ${a.chosen + 1} of ${a.candidates.length}` : null;
    body = c ? <Ready project={project} a={a} c={c} at={at} local={local} busy={busy} ask={ask} setAsk={setAsk} reason={reason} setReason={setReason} note={note} setNote={setNote} send={send} /> : <p className="mt-3 text-ui text-ink-2">Your next action comes at {at}.</p>;
  }

  return (
    <section aria-label="Today's action" className="card p-4 sm:p-5">
      <Header badge={badge} extra={extra} />
      {body}
      {(error || (notice && !stalled)) && today && <p className="mt-3 text-small text-muted">{error || notice}</p>}
      <p className="sr-only" aria-live="polite">
        {live || (today ? error : '')}
      </p>
    </section>
  );
}

function Ready(p: {
  project: Project;
  a: MorningAction;
  c: MorningCandidate;
  at: string;
  local: boolean;
  busy: boolean;
  ask: boolean;
  setAsk: (v: boolean) => void;
  reason: MorningReason | null;
  setReason: (r: MorningReason | null) => void;
  note: string;
  setNote: (v: string) => void;
  send: (v: MorningVerdict, r?: MorningReason, n?: string) => Promise<void>;
}) {
  const { project, a, c, at, local, busy, ask, setAsk, reason, setReason, note, setNote, send } = p;
  const go = doIt(c, project);
  const how = c.kind === 'offline' ? askHow(c) : null;
  const line = local ? '' : fallbackLine(a);
  return (
    <>
      <div className="mt-3 flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2 [&>svg]:size-4" aria-hidden="true">
          {MORNING_ICON[c.kind] ?? <Compass />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="clamp-2 text-h4 text-ink">{c.title}</p>
          <p className="clamp-3 mt-1 text-small text-ink-2">{c.why}</p>
          {c.steps && c.steps.length > 0 && (
            <ol className="mt-2 list-decimal pl-5 text-small text-ink-2">
              {c.steps.slice(0, 3).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          )}
        </div>
      </div>
      {ask ? (
        <div className="well mt-4 flex flex-col gap-3 p-3">
          <p className="text-small text-ink">What didn’t work about this one?</p>
          <div className="flex flex-wrap gap-2">
            {MORNING_REASONS.map((r) => (
              <button key={r.id} type="button" className={cn('chip', reason === r.id && 'chip-active')} aria-pressed={reason === r.id} onClick={() => setReason(reason === r.id ? null : r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-small text-ink-2">
            Tell us more (optional)
            <input className="input input-sm" maxLength={MORNING.limits.note} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void send('not_useful', reason ?? undefined, note.trim() || undefined)}>
              Send
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void send('not_useful')}>
              Skip
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAsk(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {go &&
            (writes(c.kind) ? (
              <GenerateButton variant="ai-outline" size="sm" onClick={() => void go.run()}>
                {go.label}
              </GenerateButton>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void go.run()}>
                {go.label} <ArrowRight aria-hidden="true" />
              </button>
            ))}
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void send('done')}>
            <Check /> Done
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAsk(true)}>
            Not useful
          </button>
          {how && (
            <button type="button" className="link text-small" onClick={() => void how.run()}>
              {how.label}
            </button>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-3 text-small text-muted">
        <span>{MORNING_AREA[c.kind] ?? 'Today'}</span>
        <span aria-hidden="true">·</span>
        <span>Tomorrow’s comes at {at}</span>
        {local && (
          <>
            <span aria-hidden="true">·</span>
            <span>Built in: from your plan</span>
          </>
        )}
        {!local && a.engine === 'ai' && a.credits != null && (
          <InfoTip label="How today’s action was picked">
            Picked from your plan, posts, leads, sales and numbers. Uses about {a.credits} AI credit{a.credits === 1 ? '' : 's'}.
          </InfoTip>
        )}
      </div>
      {line && (
        <p className="mt-2 text-small text-muted">
          {line}
          {a.fallback === 'own_key' && (
            <>
              {' '}
              <button type="button" className="link" onClick={() => void openPage('workspace-settings', 'ai')}>
                Settings › AI keys
              </button>
            </>
          )}
        </p>
      )}
    </>
  );
}

// ───────────── wiring ─────────────

let lastAccount: string | null = null;

/** The server's version: load on open and on a switch of business or zone, reload at the next 5 am, keep the zone in step. */
function useServerMorning(project: Project, on: boolean): { entry: MorningEntry; tz: string } {
  const tz = projectTimeZone(project);
  const account = useAuth((s) => (s.phase === 'ready' ? s.user?.id ?? '' : ''));
  const entry = useMorningStore((s) => entryOf(s, project.id));
  const nextAt = entry.today?.nextAt;
  const served = entry.today?.timeZone;
  const synced = useRef(new Set<string>());

  useEffect(() => {
    if (!on) return;
    if (lastAccount !== null && lastAccount !== account) useMorningStore.getState().reset();
    lastAccount = account;
  }, [on, account]);
  // the business's zone goes with every read, so a zone changed in Settings is used at once
  useEffect(() => {
    if (on && account) void useMorningStore.getState().load(project.id, tz);
  }, [on, account, project.id, tz]);
  // a Dashboard left open over 5 am picks up the new day
  useEffect(() => {
    if (!on || !nextAt) return;
    const wait = Date.parse(nextAt) - Date.now() + 90_000;
    if (!Number.isFinite(wait) || wait > 2 ** 31 - 1) return;
    const t = setTimeout(() => void useMorningStore.getState().load(project.id, tz), Math.max(1000, wait));
    return () => clearTimeout(t);
  }, [on, nextAt, project.id, tz]);
  // the server answered in another zone than the business's own (its save hasn't reached the server yet): ask once more shortly
  useEffect(() => {
    const k = `${project.id}:${tz}`;
    if (!on || !served || served === tz || synced.current.has(k)) return;
    synced.current.add(k);
    const t = setTimeout(() => void useMorningStore.getState().load(project.id, tz), 15_000);
    return () => clearTimeout(t);
  }, [on, served, tz, project.id]);
  return { entry, tz };
}

/** The built-in version: made in this browser for the action day, Done and Not useful kept on this device. */
function useLocalMorning(project: Project, ctx: ActionCtx, on: boolean): { today: MorningToday | null; feedback: (v: MorningVerdict, r?: MorningReason, n?: string) => MorningAction | null } {
  const now = useNow(60_000);
  // bumped by every localFeedback (this card's buttons or the assistant's tool), so the card shows it at once
  const version = useLocalMorningVersion((s) => s.version);
  const today = useMemo(() => (on ? localMorning(project, { ...ctx, now }, now) : null), [on, project, ctx, now, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const feedback = (v: MorningVerdict, r?: MorningReason, n?: string) => localFeedback(project, v, r, n);
  return { today, feedback };
}

/** Today's action on the Dashboard (nothing in `off` mode; the Dashboard leaves it out while it shows its first steps). */
export function MorningCard({ project, ctx, className }: { project: Project; ctx: ActionCtx; className?: string }) {
  const mode = useMorningMode();
  const server = useServerMorning(project, mode === 'server');
  const local = useLocalMorning(project, ctx, mode === 'local');
  if (mode === 'off') return null;
  const store = useMorningStore.getState();
  const view =
    mode === 'local' ? (
      <MorningCardView
        project={project}
        local
        entry={{ today: local.today, loading: false, starting: false, error: '', notice: '', locked: null, stalled: false }}
        onStart={() => {}}
        onRefresh={() => {}}
        onFeedback={local.feedback}
        onUpgrade={() => {}}
      />
    ) : (
      <MorningCardView
        project={project}
        local={false}
        entry={server.entry}
        onStart={() => void store.start(project.id, 'manual', server.tz)}
        onRefresh={() => void store.load(project.id, server.tz)}
        onFeedback={async (v, r, n) => {
          const id = server.entry.today?.action?.id;
          if (!id || !(await store.feedback(project.id, id, v, r, n))) return false;
          return entryOf(useMorningStore.getState(), project.id).today?.action ?? true;
        }}
        onUpgrade={(code) => showUpgrade({ code, error: '' })}
      />
    );
  return <div className={className}>{view}</div>;
}
