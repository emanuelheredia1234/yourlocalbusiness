// The assistant's chat panel: a window at the bottom right on larger screens, a full-height sheet on
// phones. Loaded the first time the chat opens. Escape closes it only while focus is inside it, so
// closing a window the assistant opened (a confirm, "Post with Manus") never closes the chat too.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AppWindow, Ban, Check, CircleAlert, Copy, Download, ExternalLink, Info, SendHorizontal, Sparkles, Square, SquarePen, Upload, X } from 'lucide-react';
import type { Route } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useRuntime } from '@/lib/platform';
import { useActiveProject, useStore } from '@/store/useStore';
import { answerCard, buttonAlive, cardWaiting, pressButton, useAssistant, type ChatMessage } from '@/store/assistant';
import type { ChatButtonIcon } from '@/ai/assistant/registry';
import { newChat, sendToAssistant, stopAssistant } from '@/ai/assistant/run';
import { assistantAvailability } from '@/ai/assistant/transport';
import { openPage } from '@/ai/assistant/nav';
import { OFFLINE_SUGGESTIONS, starterSuggestions } from '@/ai/assistant/intents';
import { workspaceSummary } from '@/ai/assistant/workspace';
import { Spinner } from '../ui/primitives';
import { ChatText } from './ChatText';

const EMPTY: ChatMessage[] = [];
const isPhone = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 639px)').matches;

const BUTTON_ICONS: Record<ChatButtonIcon, JSX.Element> = {
  download: <Download size={13} />,
  copy: <Copy size={13} />,
  upload: <Upload size={13} />,
  open: <ExternalLink size={13} />,
  check: <Check size={13} />,
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
            ? [<AppWindow size={14} className="text-info" aria-hidden="true" />, 'Waiting for you:']
            : [<Check size={14} className="text-good" aria-hidden="true" />, 'Done:'];
  return (
    <>
      {icon}
      <span className="sr-only">{words}</span>
    </>
  );
}

function Activity({ m }: { m: ChatMessage }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
        <span className="mt-[1px] shrink-0">
          <ActivityIcon status={m.status} />
        </span>
        <span className="min-w-0">
          {m.text}
          {m.ai === 'used' && <span className="badge ml-1.5 bg-accent-soft align-middle text-on-accent">Used your AI</span>}
          {m.ai === 'builtin' && <span className="badge ml-1.5 bg-surface-2 align-middle text-muted">Built-in engine</span>}
        </span>
      </p>
      {!!m.buttons?.length && (
        <div className="flex flex-wrap gap-1.5 pl-5">
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
                {busy === b.id ? <Spinner size={12} /> : b.icon ? BUTTON_ICONS[b.icon] : null}
                {b.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Card({ m }: { m: ChatMessage }) {
  const card = m.card!;
  const live = card.state === 'pending' && cardWaiting(m.id);
  return (
    <div className="rounded-lg border border-line-2 bg-surface-2/60 p-3 text-[13px]" role="group" aria-label={card.title}>
      <p className="font-semibold text-ink">{card.title}</p>
      <p className="mt-1 text-ink-2">{card.what}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[12.5px]">
        <dt className="font-semibold text-muted">Who</dt>
        <dd className="text-ink-2">{card.who}</dd>
        {card.cost && (
          <>
            <dt className="font-semibold text-muted">Cost</dt>
            <dd className="text-ink-2">{card.cost}</dd>
          </>
        )}
      </dl>
      {live ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => answerCard(m.id, true)}>
            {card.confirmLabel}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => answerCard(m.id, false)}>
            Not now
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[12px] font-semibold text-muted">{card.state === 'confirmed' ? 'You confirmed.' : card.state === 'declined' ? 'You said no.' : 'Not answered (stopped or reloaded).'}</p>
      )}
    </div>
  );
}

function Message({ m, onOpenPage, offline }: { m: ChatMessage; onOpenPage: (route: Route, tab?: string) => void; offline: boolean }) {
  switch (m.role) {
    case 'user':
      return <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[13.5px] text-on-primary">{m.text}</p>;
    case 'assistant':
      return <ChatText text={m.text} onOpenPage={onOpenPage} />;
    case 'activity':
      return <Activity m={m} />;
    case 'card':
      return m.card ? <Card m={m} /> : null;
    case 'error':
      return (
        <div className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2.5 text-[13px] text-ink-2" role="alert">
          <p>{m.text}</p>
          {(m.settings || offline) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {m.settings && (
                <button type="button" className="btn btn-secondary btn-xs" onClick={() => onOpenPage('workspace-settings', 'ai')}>
                  Open Settings → AI
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
        </div>
      );
    default:
      return (
        <p className="flex items-center justify-center gap-1.5 text-center text-[12px] text-muted">
          <Info size={12} aria-hidden="true" /> {m.text}
        </p>
      );
  }
}

export default function AssistantPanel({ onClose }: { onClose: () => void }) {
  const project = useActiveProject();
  const pid = project?.id ?? '';
  const messages = useAssistant((s) => s.threads[pid] ?? EMPTY);
  const running = useAssistant((s) => s.running);
  const stage = useAssistant((s) => s.stage);
  const runHere = useAssistant((s) => s.runProjectId === pid);
  const posts = useStore((s) => s.posts);
  const claude = useRuntime((s) => s.claude);
  const server = useRuntime((s) => s.server);
  const ai = useRuntime((s) => s.ai);
  const avail = useMemo(() => assistantAvailability(), [claude, server, ai]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(() => {
    const w = workspaceSummary();
    return starterSuggestions(w ? { name: w.project.name, due: w.posts.due, posts: w.posts.drafts + w.posts.planned + w.posts.posted, nextStep: w.readiness.next, plan: w.social.plan !== 'none' } : null);
  }, [project, posts]);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  // keep the newest message in view
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, stage, running]);
  // the input grows with what's typed, up to about six lines
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [draft]);

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
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
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
      className="fixed inset-0 z-[45] flex animate-rise-in flex-col bg-surface sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[600px] sm:max-h-[calc(100dvh-32px)] sm:w-[400px] sm:rounded-xl sm:border sm:border-line sm:shadow-pop"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="assistant-title" className="font-display text-[16px] font-semibold leading-tight">
            Assistant
          </h2>
          {project && <p className="truncate text-[11.5px] text-muted">For {project.brand.name || 'this project'}</p>}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => pid && newChat(pid)} disabled={!messages.length} title="Start over with an empty chat">
          <SquarePen size={15} /> New chat
        </button>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close assistant">
          <X size={18} />
        </button>
      </header>

      <div ref={log} role="log" aria-live="polite" aria-label="Conversation" className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {!messages.length && (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px] text-ink-2">Ask me about your workspace, or tell me what to do: I can find things, open pages and do tasks for you. I ask first before anything paid, public or permanent.</p>
            {avail.ok ? (
              <div className="flex flex-col items-start gap-1.5">
                {suggestions.map((s) => (
                  <button key={s} type="button" className="chip h-auto max-w-full whitespace-normal py-1.5 text-left" onClick={() => send(s)} disabled={running}>
                    {s}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-line bg-surface-2/60 p-3 text-[13px] text-ink-2">
                <p>{avail.reason} Until then I can only open pages.</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
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
          <Message key={m.id} m={m} onOpenPage={go} offline={!avail.ok && lastIsError && i === messages.length - 1} />
        ))}
        {running && runHere && (
          <p className="flex items-center gap-2 text-[12.5px] text-muted" role="status">
            <Spinner size={13} /> {stage || 'Working…'}
          </p>
        )}
      </div>

      <div className="border-t border-line px-3 pb-3 pt-2">
        {running && (
          <div className="mb-2 flex items-center justify-between gap-2 text-[12px] text-muted">
            <span>{runHere ? 'Working on it. You can close this; it carries on.' : 'Working in another project’s chat.'}</span>
            <button type="button" className="btn btn-secondary btn-xs" onClick={stopAssistant} aria-label="Stop the assistant">
              <Square size={11} /> Stop
            </button>
          </div>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label htmlFor="assistant-input" className="sr-only">
            Message the assistant
          </label>
          <textarea
            id="assistant-input"
            ref={input}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            maxLength={6000}
            placeholder={avail.ok ? 'Ask, or tell me what to do…' : 'Name a page to open…'}
            className="textarea scroll-thin min-h-[40px] flex-1 resize-none overflow-y-auto py-2"
          />
          <button type="submit" className="btn btn-primary btn-icon shrink-0" disabled={!draft.trim() || running} aria-label="Send">
            <SendHorizontal size={17} />
          </button>
        </form>
        <p className={cn('mt-1.5 px-1 text-[11px] text-faint')}>Enter sends, Shift+Enter starts a new line.</p>
      </div>
    </section>
  );
}
