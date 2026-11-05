// The assistant's chat panel: docked at the right of the window from 1440px wide (the stage makes room for it),
// a sheet over the page from 640px, full screen on phones. Loaded the first time the chat opens. Escape closes it
// only while focus is inside it, so closing a window the assistant opened (a confirm, "Post on Facebook") never
// closes the chat too.
//
// The same chat talks to Manus and Viktor (its To: switch, AgentComposer): their replies show as their own
// kind of message (ExternalMessage), and while the chat is open a reply that's due is checked for every few
// seconds; opening it clears the unread dot for this project. "Ask AI: …" from the command palette arrives as a
// draft (useAssistant's draft): it lands in the box, for the assistant, ready to send.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Ban, CalendarDays, Check, CircleAlert, CircleHelp, Compass, Copy, Download, ExternalLink, Info, MessageSquare, PenLine, Square, SquarePen, Upload, X } from 'lucide-react';
import type { Route } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useRuntime } from '@/lib/platform';
import { useActiveProject, useStore } from '@/store/useStore';
import { answerCard, buttonAlive, cardWaiting, clearUnread, pressButton, setAgentTo, useAssistant, type ChatMessage } from '@/store/assistant';
import type { ChatButtonIcon } from '@/ai/assistant/registry';
import { newChat, sendToAssistant, stopAssistant } from '@/ai/assistant/run';
import { assistantAvailability } from '@/ai/assistant/transport';
import { openPage } from '@/ai/assistant/nav';
import { OFFLINE_SUGGESTIONS, starterSuggestions } from '@/ai/assistant/intents';
import { workspaceSummary } from '@/ai/assistant/workspace';
import { useAgentChatPolling } from '@/ai/agents/chat';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Callout, CopyButton, Spinner, Tooltip } from '../ui/primitives';
import { Spark } from '../ai/Spark';
import { ChatText } from './ChatText';
import AgentComposer from './AgentComposer';
import { AgentUserMessage, ExternalMessage, OpenInAgent } from './ExternalMessage';

const EMPTY: ChatMessage[] = [];
const isPhone = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 639px)').matches;

/**
 * The panel's frame: full screen on phones; from 640px a 400px sheet inset 8px at the right, over the page with a
 * dialog shadow; from 1440px the same box docked beside the stage (App moves the stage over), with the stage's
 * own hairline shadow. No scrim: the page stays usable.
 */
const FRAME =
  'fixed inset-0 z-overlay flex flex-col bg-surface text-ink animate-rise-in sm:inset-auto sm:bottom-2 sm:right-2 sm:top-2 sm:w-[400px] sm:animate-slide-in-right sm:rounded-stage sm:border sm:border-line sm:shadow-dialog min-[1440px]:shadow-xs';

const BUTTON_ICONS: Record<ChatButtonIcon, JSX.Element> = {
  download: <Download />,
  copy: <Copy />,
  upload: <Upload />,
  open: <ExternalLink />,
  check: <Check />,
};

/** How an action went: an icon, and the same in words for screen readers. */
function ActivityIcon({ status }: { status: ChatMessage['status'] }) {
  const [icon, words] =
    status === 'failed'
      ? [<CircleAlert size={14} className="text-bad" aria-hidden="true" />, 'Didn’t work:']
      : status === 'refused'
        ? [<Ban size={14} className="text-warn" aria-hidden="true" />, 'Not something I do:']
        : status === 'declined' || status === 'cancelled'
          ? [<X size={14} className="text-muted" aria-hidden="true" />, 'Not done:']
          : status === 'opened'
            ? [<AppWindow size={14} className="text-primary" aria-hidden="true" />, 'Waiting for you:']
            : [<Check size={14} className="text-good" aria-hidden="true" />, 'Done:'];
  return (
    <>
      {icon}
      <span className="sr-only">{words}</span>
    </>
  );
}

/** What the assistant did: one muted line with how it went, and the buttons that need the owner's own click. */
function Activity({ m }: { m: ChatMessage }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-2 text-small text-muted">
        <span className="mt-[3px] flex shrink-0">
          <ActivityIcon status={m.status} />
        </span>
        <span className="min-w-0">
          {m.text}
          {m.ai === 'used' && ' · Used your AI'}
          {m.ai === 'builtin' && ' · Built-in engine'}
        </span>
      </p>
      {!!m.buttons?.length && (
        <div className="flex flex-wrap gap-1.5 pl-[22px]">
          {m.buttons.map((b) => {
            const alive = buttonAlive(b.id);
            return (
              <button
                key={b.id}
                type="button"
                className="btn btn-secondary btn-xs"
                disabled={!alive || busy === b.id}
                title={alive ? undefined : 'This button expired when the page reloaded. Ask again.'}
                onClick={async () => {
                  setBusy(b.id);
                  try {
                    await pressButton(b.id);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === b.id ? <Spinner size={14} /> : b.icon ? BUTTON_ICONS[b.icon] : null}
                {b.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A confirm card: what it does, the exact message when there is one, who does it and what it costs (one click
 * away), then the owner's answer. Once answered the buttons go and the card stays, saying what was decided.
 */
function Card({ m }: { m: ChatMessage }) {
  const card = m.card!;
  const live = card.state === 'pending' && cardWaiting(m.id);
  const [open, setOpen] = useState('');
  return (
    <div className="rounded-lg border border-line-2 bg-surface p-4 shadow-xs" role="group" aria-label={card.title}>
      <p className="text-h4 text-ink">{card.title}</p>
      <p className="mt-1 text-small text-ink-2">{card.what}</p>
      {card.quote && (
        <div className="well relative mt-3">
          {/* the exact text that goes, in full */}
          <p className="scroll-thin max-h-[20rem] overflow-y-auto whitespace-pre-wrap break-words py-2.5 pl-3 pr-20 text-small text-ink" tabIndex={0} aria-label="The exact message">
            {card.quote}
          </p>
          <span className="absolute right-1.5 top-1.5">
            <CopyButton text={card.quote} size="xs" label="Copy" />
          </span>
        </div>
      )}
      <Accordion type="single" collapsible value={open} onValueChange={setOpen} className="mt-2">
        <AccordionItem value="who" className="border-0">
          <AccordionTrigger className="justify-start gap-1 py-1.5 text-caption text-muted hover:text-ink [&>svg]:h-3.5 [&>svg]:w-3.5">Who does it and what it costs</AccordionTrigger>
          {/* kept in the page while closed (hidden), so it's there to find and to read the moment it opens */}
          <AccordionContent forceMount hidden={open !== 'who'} className="pb-1 pt-0.5">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-small">
              <dt className="text-muted">Who</dt>
              <dd className="text-ink-2">{card.who}</dd>
              {card.cost && (
                <>
                  <dt className="text-muted">Cost</dt>
                  <dd className="text-ink-2">{card.cost}</dd>
                </>
              )}
            </dl>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      {live ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ai btn-sm" onClick={() => answerCard(m.id, true)}>
            {card.confirmLabel}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => answerCard(m.id, false)}>
            Not now
          </button>
        </div>
      ) : (
        <p className={cn('mt-2 flex items-center gap-1.5 text-small', card.state === 'confirmed' ? 'text-ink-2' : 'text-muted')}>
          {card.state === 'confirmed' && <Check size={14} className="shrink-0 text-good" aria-hidden="true" />}
          {card.state === 'confirmed' ? 'You confirmed.' : card.state === 'declined' ? 'You said no.' : 'Not answered (stopped or reloaded).'}
        </p>
      )}
    </div>
  );
}

const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The thinking strip while the assistant works in this chat: what it's doing, for how long, and Stop. */
function Working({ stage }: { stage: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="thinking min-h-11 gap-2.5 py-1.5 pl-3 pr-1.5">
        <span className="orb" aria-hidden="true" />
        {/* only the stage is announced: the clock ticks every second and would be read out each time */}
        <p className="shimmer-text min-w-0 flex-1 truncate text-ui" role="status" aria-live="polite">
          {stage || 'Working…'}
        </p>
        <span className="num shrink-0 font-mono text-caption text-muted" aria-hidden="true">
          {fmtElapsed(secs)}
        </span>
        <button type="button" className="btn btn-ghost btn-xs shrink-0" onClick={stopAssistant} aria-label="Stop the assistant">
          <Square className="!size-3 fill-current" aria-hidden="true" /> Stop
        </button>
      </div>
      <p className="px-1 text-caption text-muted">You can close this; it carries on.</p>
    </div>
  );
}

interface MessageProps {
  m: ChatMessage;
  projectId: string;
  onOpenPage: (route: Route, tab?: string) => void;
  offline: boolean;
  /** an opening or progress message from Manus that a result came after */
  folded?: boolean;
  /** Manus's question with choices that waits for the owner */
  answerable?: boolean;
  /** a reply's page is opening one of the app's pages (on a phone the chat gets out of the way) */
  onLeave?: () => void;
}

function Message({ m, projectId, onOpenPage, offline, folded, answerable, onLeave }: MessageProps) {
  switch (m.role) {
    case 'user':
      if (m.via) return <AgentUserMessage m={m} projectId={projectId} />;
      return <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-action px-3.5 py-2 text-body text-on-action">{m.text}</p>;
    case 'external':
      return <ExternalMessage m={m} projectId={projectId} folded={folded} answerable={answerable} onLeave={onLeave} />;
    case 'assistant':
      return (
        <div className="flex gap-2.5">
          <Spark size={16} className="mt-[3px]" />
          <ChatText text={m.text} onOpenPage={onOpenPage} />
        </div>
      );
    case 'activity':
      return <Activity m={m} />;
    case 'card':
      return m.card ? <Card m={m} /> : null;
    case 'error':
      return (
        <Callout tone="bad">
          <p>{m.text}</p>
          {(m.settings || offline) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {m.settings && (
                <button type="button" className="btn btn-secondary btn-xs" onClick={() => onOpenPage('workspace-settings', 'ai')}>
                  Open Settings › AI keys
                </button>
              )}
              {offline &&
                OFFLINE_SUGGESTIONS.filter((s) => !(m.settings && s.tab === 'ai')).map((s) => (
                  <button key={s.label} type="button" className="btn btn-ghost btn-xs" onClick={() => onOpenPage(s.route, s.tab)}>
                    {s.label}
                  </button>
                ))}
            </div>
          )}
        </Callout>
      );
    default:
      return (
        <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-2 text-center text-caption text-muted">
          <Info size={12} className="shrink-0" aria-hidden="true" /> {m.text}
          {m.via && <OpenInAgent m={m} className="text-caption" />}
        </p>
      );
  }
}

/** Manus's opening and progress messages that a result came after (they fold away), newest round last. */
function foldedIds(messages: ChatMessage[]): Set<string> {
  const out = new Set<string>();
  let resultAfter = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const x = messages[i];
    if (x.role !== 'external' || x.via !== 'manus') continue;
    if (x.deliveryKind === 'opening' || x.deliveryKind === 'progress') {
      if (resultAfter) out.add(x.id);
    } else resultAfter = true;
  }
  return out;
}

/** The message whose choices the owner can pick from: Manus's newest message, when it asks with choices and nothing went to Manus after it. */
function answerableId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const x = messages[i];
    if (x.role === 'user' && x.via === 'manus') return null;
    if (x.role === 'external' && x.via === 'manus') return x.options?.length ? x.id : null;
  }
  return null;
}

/** A starter's icon, from what it asks about. */
function starterIcon(s: string) {
  if (/due|calendar|planned|week/i.test(s)) return <CalendarDays size={16} />;
  if (/post/i.test(s)) return <PenLine size={16} />;
  if (/next|plan/i.test(s)) return <Compass size={16} />;
  if (/what can you do/i.test(s)) return <CircleHelp size={16} />;
  return <MessageSquare size={16} />;
}

export default function AssistantPanel({ onClose }: { onClose: () => void }) {
  const project = useActiveProject();
  const pid = project?.id ?? '';
  const messages = useAssistant((s) => s.threads[pid] ?? EMPTY);
  const running = useAssistant((s) => s.running);
  const stage = useAssistant((s) => s.stage);
  const runHere = useAssistant((s) => s.runProjectId === pid);
  const handed = useAssistant((s) => s.draft ?? null);
  const posts = useStore((s) => s.posts);
  const claude = useRuntime((s) => s.claude);
  const server = useRuntime((s) => s.server);
  const ai = useRuntime((s) => s.ai);
  const avail = useMemo(() => assistantAvailability(), [claude, server, ai]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const folded = useMemo(() => foldedIds(messages), [messages]);
  const answerable = useMemo(() => answerableId(messages), [messages]);

  // replies from Manus or Viktor that are due are checked every few seconds while the chat is open
  useAgentChatPolling(pid || null);
  // the chat is on screen: its replies are read
  useEffect(() => {
    if (pid) clearUnread(pid);
  }, [pid, messages.length]);

  const suggestions = useMemo(() => {
    const w = workspaceSummary();
    return starterSuggestions(w ? { name: w.project.name, due: w.posts.due, posts: w.posts.drafts + w.posts.planned + w.posts.posted, nextStep: w.readiness.next, plan: w.social.plan !== 'none' } : null);
  }, [project, posts]);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  // "Ask AI: …" from the command palette: the words go in the box, for the assistant (the owner sends them)
  useEffect(() => {
    if (handed === null) return;
    const text = useAssistant.getState().takeDraft();
    if (text === null) return;
    if (pid) setAgentTo(pid, 'assistant');
    setDraft(text);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(text.length, text.length);
    });
  }, [handed, pid]);
  // keep the newest message in view
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, stage, running]);
  const go = (route: Route, tab?: string) => {
    // on a phone the chat covers the page: get out of the way
    if (isPhone()) onClose();
    void openPage(route, tab);
  };
  const send = (text = draft) => {
    const t = text.trim();
    if (!t || running) return;
    setDraft('');
    void sendToAssistant(t);
  };
  // a page from Manus or Viktor opened as an asset or the SEO page: on a phone the chat covers it
  const leave = () => {
    if (isPhone()) onClose();
  };
  const lastIsError = messages[messages.length - 1]?.role === 'error';

  return (
    <section
      id="assistant-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="assistant-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.stopPropagation();
          onClose();
        }
      }}
      className={FRAME}
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
        <Spark size={18} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 id="assistant-title" className="shrink-0 text-h4 text-ink">
            Assistant
          </h2>
          {project && <p className="min-w-0 truncate text-caption text-muted">For {project.brand.name || 'this project'}</p>}
        </div>
        <button type="button" className="btn btn-ghost btn-icon btn-sm disabled:bg-transparent" onClick={() => pid && newChat(pid)} disabled={!messages.length} title="Start over with an empty chat" aria-label="New chat">
          <SquarePen />
        </button>
        <Tooltip content="Close" kbd="Esc">
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close assistant">
            <X />
          </button>
        </Tooltip>
      </header>

      <div ref={log} role="log" aria-live="polite" aria-label="Conversation" className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-5">
        {!messages.length && (
          <div className="flex flex-1 flex-col justify-end gap-4">
            <div>
              <h3 className="text-h2 text-ink">What should we work on?</h3>
              <p className="mt-1 text-small text-muted">I find things, open pages and do tasks. I ask before anything paid, public or permanent.</p>
            </div>
            {avail.ok ? (
              <div className="grid grid-cols-2 gap-2">
                {suggestions.map((s, i) => (
                  <button
                    key={s}
                    type="button"
                    className={cn(
                      'flex min-h-[84px] flex-col items-start gap-2 rounded-pop border border-line bg-surface p-3 text-left text-small text-ink-2 transition-colors duration-120 hover:border-line-3 hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:text-faint',
                      suggestions.length % 2 === 1 && i === suggestions.length - 1 && 'col-span-2 min-h-0',
                    )}
                    onClick={() => send(s)}
                    disabled={running}
                  >
                    <span className="text-muted" aria-hidden="true">
                      {starterIcon(s)}
                    </span>
                    {s}
                  </button>
                ))}
              </div>
            ) : (
              <div className="well p-3 text-small text-ink-2">
                <p>{avail.reason} Until then I can only open pages.</p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {OFFLINE_SUGGESTIONS.filter((s) => avail.settings || s.tab !== 'ai').map((s) => (
                    <button key={s.label} type="button" className="btn btn-secondary btn-xs" onClick={() => go(s.route, s.tab)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={m.id} m={m} projectId={pid} onOpenPage={go} offline={!avail.ok && lastIsError && i === messages.length - 1} folded={folded.has(m.id)} answerable={answerable === m.id} onLeave={leave} />
        ))}
        {running && runHere && <Working stage={stage} />}
      </div>

      <div className="shrink-0 px-3 pb-3 pt-1">
        {running && !runHere && (
          <div className="mb-2 flex items-center justify-between gap-2 px-1 text-caption text-muted">
            <span>Working in another project’s chat.</span>
            <button type="button" className="btn btn-secondary btn-xs" onClick={stopAssistant} aria-label="Stop the assistant">
              <Square className="!size-3 fill-current" aria-hidden="true" /> Stop
            </button>
          </div>
        )}
        {project && (
          <AgentComposer
            key={pid}
            project={project}
            draft={draft}
            setDraft={setDraft}
            inputRef={input}
            running={running}
            assistantReady={avail.ok}
            onSendAssistant={(t) => send(t)}
            onSetup={() => go('workspace-settings', 'ai')}
          />
        )}
      </div>
    </section>
  );
}
