// The assistant's round chat button at the bottom right, and its panel (loaded the first time it opens).
// A chat turn isn't tied to the panel: closing it leaves a turn running (the button shows it), and
// the panel shows where it is when opened again. Chats waiting for Manus or Viktor are checked from here
// (every 45 seconds, panel open or not), and a reply that came while the panel was closed puts a dot on
// the button.

import { Component, Suspense, lazy, useEffect, useRef, type ReactNode } from 'react';
import { MessageCircle, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/cloud/auth';
import { useStore } from '@/store/useStore';
import { loadChats, useAssistant, type ChatMessage } from '@/store/assistant';
import { useAgentChatWatcher } from '@/ai/agents/chat';
import { Spinner } from '../ui/primitives';

const AssistantPanel = lazy(() => import('./AssistantPanel'));

/** Keeps a broken assistant from taking the app down with it; offers to start it again. */
class AssistantBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="fixed z-[45] flex max-w-[300px] items-center gap-2 rounded-lg border border-line bg-surface p-3 text-[12.5px] text-ink-2 shadow-pop" style={{ right: 'max(16px, env(safe-area-inset-right, 0px))', bottom: 'max(16px, env(safe-area-inset-bottom, 0px))' }}>
        <span className="min-w-0 flex-1">The assistant hit a snag. Your work is safe.</span>
        <button
          className="btn btn-secondary btn-xs"
          onClick={() => {
            useAssistant.getState().setOpen(false);
            this.setState({ error: null });
          }}
        >
          <RotateCcw size={13} /> Restart
        </button>
      </div>
    );
  }
}

/** Set when the panel closes, so the button that replaces it takes the focus back. */
const refocus = { next: false };

const NO_MESSAGES: ChatMessage[] = [];

/** Who the newest reply in a chat is from ('Viktor', 'Manus'), for the unread dot. */
function newestReplyFrom(list: ChatMessage[]): string {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'external' && (list[i].from === 'manus' || list[i].from === 'viktor')) return list[i].via === 'manus' ? 'Manus' : 'Viktor';
  return '';
}

function Launcher({ onOpen }: { onOpen: () => void }) {
  const running = useAssistant((s) => s.running);
  const waiting = useAssistant((s) => !!s.runProjectId && (s.threads[s.runProjectId] ?? []).some((m) => m.card?.state === 'pending'));
  const pid = useStore((s) => s.activeProjectId);
  // replies from Manus or Viktor that came while the chat was closed
  const unread = useAssistant((s) => (pid ? s.unread?.[pid] ?? 0 : 0));
  const thread = useAssistant((s) => (pid ? s.threads[pid] ?? NO_MESSAGES : NO_MESSAGES));
  const from = unread ? newestReplyFrom(thread) : '';
  const news = unread ? `New reply from ${from || 'Manus or Viktor'}` : '';
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!refocus.next) return;
    refocus.next = false;
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-label={news ? `Open assistant: ${news.toLowerCase()}` : 'Open assistant'}
      aria-controls="assistant-panel"
      aria-expanded={false}
      title={waiting ? 'The assistant is waiting for you to confirm' : running ? 'The assistant is working' : news || 'Ask the assistant'}
      className="fixed z-[45] flex h-14 w-14 items-center justify-center rounded-full bg-primary text-on-primary shadow-pop transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30 motion-reduce:transition-none motion-reduce:hover:scale-100"
      style={{ right: 'max(16px, env(safe-area-inset-right, 0px))', bottom: 'max(16px, env(safe-area-inset-bottom, 0px))' }}
    >
      <MessageCircle size={26} aria-hidden="true" />
      <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 rounded-full border-2 border-surface bg-accent px-1 text-[9px] font-bold leading-[14px] text-on-accent">
        AI
      </span>
      {(running || waiting) && (
        <span aria-hidden="true" className={cn('absolute -bottom-0.5 -left-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface', waiting ? 'bg-warn' : 'animate-pulse-dot bg-good')} />
      )}
      {!!news && <span aria-hidden="true" data-unread="" className="absolute -left-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface bg-info" />}
    </button>
  );
}

function PanelFallback({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[45] flex flex-col bg-surface sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[600px] sm:max-h-[calc(100dvh-32px)] sm:w-[400px] sm:rounded-xl sm:border sm:border-line sm:shadow-pop">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <p className="font-display text-[16px] font-semibold">Assistant</p>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close assistant">
          <X size={18} />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center text-muted">
        <Spinner size={20} />
      </div>
    </div>
  );
}

/** The chat button and panel (signed-in workspace only, not during setup). */
export function Assistant() {
  const open = useAssistant((s) => s.open);
  const setOpen = useAssistant((s) => s.setOpen);
  const close = () => {
    refocus.next = true;
    setOpen(false);
  };
  const userId = useAuth((s) => (s.phase === 'ready' ? s.user?.id ?? null : null));
  const hasProject = useStore((s) => !!s.activeProjectId);
  // this account's chats on this device
  useEffect(() => loadChats(userId), [userId]);
  // replies from Manus and Viktor, panel open or not (self-hosted only)
  useAgentChatWatcher();
  if (!hasProject) return null;
  return (
    <AssistantBoundary>
      {open ? (
        <Suspense fallback={<PanelFallback onClose={close} />}>
          <AssistantPanel onClose={close} />
        </Suspense>
      ) : (
        <Launcher onOpen={() => setOpen(true)} />
      )}
    </AssistantBoundary>
  );
}
