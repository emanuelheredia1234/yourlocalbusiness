// The assistant's panel (loaded the first time it opens) and, on phones, its round launcher at the bottom right.
// From 768px wide the way in is the top bar's "Ask AI", ⌘/Ctrl+J and the command palette, so the launcher never
// sits on a page there. A chat turn isn't tied to the panel: closing it leaves a turn running (the launcher shows
// it), and the panel shows where it is when opened again. Chats waiting for Manus or Viktor are checked from here
// (every 45 seconds, panel open or not), and a reply that came while the panel was closed puts a dot on the launcher.

import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/cloud/auth';
import { useStore } from '@/store/useStore';
import { loadChats, useAssistant, type ChatMessage } from '@/store/assistant';
import { useAgentChatWatcher } from '@/ai/agents/chat';
import { Spark } from '../ai/Spark';
import { Spinner } from '../ui/primitives';

const AssistantPanel = lazy(() => import('./AssistantPanel'));

/** Where the launcher sits: the bottom-right corner, clear of the phone's safe area. */
const CORNER = { right: 'max(16px, env(safe-area-inset-right, 0px))', bottom: 'max(16px, env(safe-area-inset-bottom, 0px))' };

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
      <div role="alert" className="fixed z-overlay flex max-w-[300px] items-center gap-3 rounded-pop border border-line bg-elevated px-3.5 py-3 text-small text-ink-2 shadow-pop" style={CORNER}>
        <span className="min-w-0 flex-1">The assistant hit a snag. Your work is safe.</span>
        <button
          className="btn btn-secondary btn-xs"
          onClick={() => {
            useAssistant.getState().setOpen(false);
            this.setState({ error: null });
          }}
        >
          <RotateCcw /> Restart
        </button>
      </div>
    );
  }
}

/** Set when the panel closes, so the focus goes back: to what opened it (the top bar's Ask AI), else the launcher. */
const refocus = { next: false };
/** What had the focus when the panel opened (read as the store opens it, before the panel takes the focus). */
let opener: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  useAssistant.subscribe?.((s, prev) => {
    if (s.open && !prev.open) opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  });
}

const NO_MESSAGES: ChatMessage[] = [];

/** Who the newest reply in a chat is from ('Viktor', 'Manus'), for the unread dot. */
function newestReplyFrom(list: ChatMessage[]): string {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'external' && (list[i].from === 'manus' || list[i].from === 'viktor')) return list[i].via === 'manus' ? 'Manus' : 'Viktor';
  return '';
}

/**
 * The launcher steps out of the way while the page scrolls down (it would sit on the content being read) and comes
 * back on the way up, and it rises above a phone's bottom action bar (body[data-bottom-bar], set by StickyActionBar).
 */
function useLauncherPlace(): { hidden: boolean; lifted: boolean; show: () => void } {
  const [hidden, setHidden] = useState(false);
  const [lifted, setLifted] = useState(false);
  useEffect(() => {
    const body = document.body;
    const read = () => setLifted(body.dataset.bottomBar !== undefined);
    read();
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(read);
    mo?.observe(body, { attributes: true, attributeFilter: ['data-bottom-bar'] });
    const main = document.getElementById('main-scroll');
    let last = main?.scrollTop ?? 0;
    const onScroll = () => {
      if (!main) return;
      const top = main.scrollTop;
      const delta = top - last;
      // near the top it always shows; elsewhere it follows the direction, ignoring small jitters
      if (top < 64) setHidden(false);
      else if (delta > 8) setHidden(true);
      else if (delta < -8) setHidden(false);
      if (Math.abs(delta) > 8 || top < 64) last = top;
    };
    main?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      mo?.disconnect();
      main?.removeEventListener('scroll', onScroll);
    };
  }, []);
  return { hidden, lifted, show: () => setHidden(false) };
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
  const place = useLauncherPlace();
  useEffect(() => {
    if (!refocus.next) return;
    refocus.next = false;
    const back = opener;
    opener = null;
    // the opener when it's still on screen (a hidden element can't take the focus), else this launcher (phones)
    const target = back?.isConnected && back.getClientRects().length ? back : ref.current;
    target?.focus({ preventScroll: true });
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      onFocus={place.show}
      aria-label={news ? `Open assistant: ${news.toLowerCase()}` : 'Open assistant'}
      aria-controls="assistant-panel"
      aria-expanded={false}
      title={waiting ? 'The assistant is waiting for you to confirm' : running ? 'The assistant is working' : news || 'Ask the assistant'}
      className={cn(
        'fixed z-launcher flex h-12 w-12 items-center justify-center rounded-full shadow-ai transition-[transform,box-shadow] duration-180 ease-out md:hidden',
        // the ink fill with the aura edge; while a turn runs the edge turns (it stops under reduced motion)
        'btn-ai',
        running && 'is-running',
        place.hidden && (place.lifted ? 'translate-y-[152px]' : 'translate-y-20'),
      )}
      style={place.lifted ? { ...CORNER, bottom: `calc(${CORNER.bottom} + 72px)` } : CORNER}
    >
      <Spark size={20} />
      {/* waiting for the owner's yes (warn), or a reply from Manus or Viktor (iris): a 10px dot with a ring of the canvas */}
      {waiting ? (
        <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-warn-solid ring-2 ring-bg" />
      ) : news ? (
        <span aria-hidden="true" data-unread="" className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-bg" />
      ) : null}
    </button>
  );
}

/** While the panel's code loads: the same frame (see AssistantPanel's FRAME), with a spinner. */
function PanelFallback({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-overlay flex flex-col bg-surface sm:inset-auto sm:bottom-2 sm:right-2 sm:top-2 sm:w-[400px] sm:rounded-stage sm:border sm:border-line sm:shadow-dialog min-[1440px]:shadow-xs">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
        <Spark size={18} />
        <p className="min-w-0 flex-1 text-h4 text-ink">Assistant</p>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close assistant">
          <X />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center text-muted">
        <Spinner size={20} />
      </div>
    </div>
  );
}

/** The launcher (phones) and the panel (signed-in workspace only, not during setup). */
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
