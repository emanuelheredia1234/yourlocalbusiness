// The chat's input, and who it sends to: "To: Assistant · Manus · Viktor", kept per project chat. To the
// assistant it works as before. To Manus or Viktor, the owner's words go exactly as typed (src/ai/agents/chat.ts),
// with up to 8 images (the paperclip, or pasted or dropped on the box) and, when they add it, their website.
// Who answers and what it costs are one click away under the box (Details). Sending to an agent never uses the
// assistant's turn, so it works while the assistant is busy, and without an AI for the assistant. Self-hosted only
// (the claude.ai build shows no To: switch), and Viktor only for the owner.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ArrowUp, Globe, Paperclip, X } from 'lucide-react';
import type { AgentId } from '@/lib/agentTypes';
import type { MediaRef, Project, PromptImage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { deleteBlob, saveMediaFile } from '@/lib/storage';
import { PROMPT_IMAGE_ACCEPT, imageKeyNumber, promptImageRefusal, reportRefusals, type RefusalCounts } from '@/lib/promptImages';
import { isSendingTo, setAgentTo, useAssistant, type AgentTo } from '@/store/assistant';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { CHAT_LIMITS, MAX_CHAT_IMAGES, chatWebsite, nextChatImageKey, sendToAgent } from '@/ai/agents/chat';
import { agentCost, agentName, agentWho, useAgentReady, type AgentReadiness } from '@/ai/agents/who';
import { MediaThumb } from '../media/MediaUpload';
import { usePasteImages } from '../ai/PromptImages';
import { Spark } from '../ai/Spark';
import { Segmented, Spinner } from '../ui/primitives';

const count = (n: number) => n.toLocaleString('en-US');
/** The box grows with what's typed, up to this height (then it scrolls). */
const MAX_BOX = 200;

/**
 * "To: Assistant · Manus · Viktor" as a segmented control: an agent that isn't ready is shown but can't be chosen,
 * with a lock and its reason (the Segmented primitive).
 */
export function ToSwitch({ projectId, to, ready, onSetup }: { projectId: string; to: AgentTo; ready: Record<AgentId, AgentReadiness>; onSetup: () => void }) {
  const ids = useId();
  const agents = (['manus', 'viktor'] as const).filter((a) => ready[a].show);
  if (__ARTIFACT_BUILD__ || !agents.length) return null;
  const options: { id: AgentTo; label: string; why: string }[] = [{ id: 'assistant', label: 'Assistant', why: '' }, ...agents.map((a) => ({ id: a as AgentTo, label: agentName(a), why: ready[a].ready ? '' : ready[a].text }))];
  const setup = agents.some((a) => !ready[a].ready && ready[a].settings);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
      <span id={`${ids}-label`} className="text-caption font-medium text-muted">
        To:
      </span>
      <Segmented<AgentTo>
        size="sm"
        aria-labelledby={`${ids}-label`}
        value={to}
        onChange={(v) => setAgentTo(projectId, v)}
        // an agent that isn't ready can stay chosen (it was ready before): sending then says why
        options={options.map((o) => ({ id: o.id, label: o.label, icon: o.id === 'assistant' ? <Spark size={14} /> : undefined, reason: o.why || undefined, disabled: !!o.why && to !== o.id }))}
      />
      {setup && (
        <button type="button" className="link text-caption" onClick={onSetup}>
          Set up
        </button>
      )}
    </div>
  );
}

export interface AgentComposerProps {
  project: Project;
  draft: string;
  setDraft: (v: string | ((d: string) => string)) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  /** the assistant is working (its own Send waits; Manus and Viktor don't) */
  running: boolean;
  /** an AI answers the assistant (otherwise it can only open pages) */
  assistantReady: boolean;
  onSendAssistant: (text: string) => void;
  /** Settings › AI keys (closing the chat first on a phone) */
  onSetup: () => void;
}

/** The chat's input: the To: switch, then the box for the assistant, or for Manus or Viktor with images, website, who and cost. */
export default function AgentComposer({ project, draft, setDraft, inputRef, running, assistantReady, onSendAssistant, onSetup }: AgentComposerProps) {
  const projectId = project.id;
  const stored = useAssistant((s) => s.agents?.[projectId]?.to ?? 'assistant');
  const credits = useAssistant((s) => s.agents?.[projectId]?.manus?.credits ?? 0);
  const manus = useAgentReady('manus', 'chat');
  const viktor = useAgentReady('viktor', 'chat');
  const ready: Record<AgentId, AgentReadiness> = { manus, viktor };
  // an agent that can't be shown here (the claude.ai build, Viktor for someone else) is never the one chosen
  const via: AgentId | null = stored !== 'assistant' && !__ARTIFACT_BUILD__ && ready[stored].show ? stored : null;
  // one message to an agent at a time (its first one waits for the owner's yes on its card meanwhile)
  const sending = useAssistant((s) => (via ? !!s.sendingTo?.[`${projectId}:${via}`] : false));
  const delivering = useAssistant((s) => (via ? (s.threads[projectId] ?? []).some((m) => m.role === 'user' && m.via === via && m.delivery === 'sending') : false));
  const [images, setImages] = useState<PromptImage[]>([]);
  const [website, setWebsite] = useState(false);
  const [adding, setAdding] = useState(false);
  const [focused, setFocused] = useState(false);
  const [details, setDetails] = useState(false);
  const latest = useRef(images);
  latest.current = images;
  const files = useRef<HTMLInputElement>(null);
  const ids = useId();
  const site = chatWebsite(project);
  const name = via ? agentName(via) : '';
  const limit = via ? CHAT_LIMITS[via] : 6000;
  const over = !!via && draft.trim().length > limit;

  // the box grows with what's typed, up to about eight lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_BOX)}px`;
  }, [draft, inputRef]);

  /** Saved images into the box, numbered in this chat's own image numbers. */
  const addMedia = (media: MediaRef[]) => {
    const next = [...latest.current];
    const refused: RefusalCounts = {};
    let outOfNumbers = false;
    for (const m of media) {
      const why = promptImageRefusal(m.mime, m.kind) ?? (next.length >= MAX_CHAT_IMAGES ? 'full' : null);
      const key = why ? '' : nextChatImageKey(projectId, next);
      if (why || !key) {
        if (why) refused[why] = (refused[why] ?? 0) + 1;
        else outOfNumbers = true;
        // saved just now: not kept when it can't be added
        void deleteBlob(m.id);
        continue;
      }
      next.push({ key, media: m });
    }
    reportRefusals(refused, MAX_CHAT_IMAGES);
    if (outOfNumbers) toast({ kind: 'error', title: 'This chat has used 99 image numbers', body: 'Start a New chat to send more images.' });
    if (next.length !== latest.current.length) setImages(next);
  };

  const paste = usePasteImages(addMedia, { room: MAX_CHAT_IMAGES - images.length, max: MAX_CHAT_IMAGES, disabled: !via, onBusy: setAdding });

  /** The paperclip: images from the device, saved on this device like any image the owner adds. */
  const pick = async (list: FileList | null) => {
    const chosen = Array.from(list ?? []);
    if (files.current) files.current.value = '';
    if (!chosen.length) return;
    const refused: RefusalCounts = {};
    const ok: File[] = [];
    for (const f of chosen) {
      const why = promptImageRefusal(f.type) ?? (ok.length >= MAX_CHAT_IMAGES - latest.current.length ? 'full' : null);
      if (why) refused[why] = (refused[why] ?? 0) + 1;
      else ok.push(f);
    }
    reportRefusals(refused, MAX_CHAT_IMAGES);
    if (!ok.length) return;
    setAdding(true);
    const saved: MediaRef[] = [];
    try {
      for (const f of ok) {
        try {
          saved.push(await saveMediaFile(f));
        } catch (e) {
          toast({ kind: 'error', title: `Couldn’t add ${f.name || 'that image'}`, body: (e as Error).message });
        }
      }
    } finally {
      setAdding(false);
    }
    if (saved.length) addMedia(saved);
  };

  const send = async () => {
    const text = draft.trim();
    if (!via) {
      if (!text || running) return;
      setDraft('');
      onSendAssistant(text);
      return;
    }
    if (!text || over || adding || sending || isSendingTo(projectId, via)) return;
    const sentImages = images;
    const sentWebsite = website && !!site;
    setDraft('');
    setImages([]);
    setWebsite(false);
    const r = await sendToAgent(projectId, via, { text, images: sentImages, website: sentWebsite });
    // (not when the owner moved to another project meanwhile: that chat's box is someone else's words)
    if ((r === 'cancelled' || r === 'failed') && useStore.getState().activeProjectId === projectId) {
      // not sent: the words (and images) go back in the box, unless something new was typed there meanwhile
      setDraft((d) => (d.trim() ? d : text));
      if (!latest.current.length) setImages(sentImages);
      if (sentWebsite) setWebsite(true);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const agentReadiness = via ? ready[via] : null;
  const canSend = via ? !!draft.trim() && !over && !adding && !sending : !!draft.trim() && !running;

  return (
    <div>
      <ToSwitch projectId={projectId} to={via ?? 'assistant'} ready={ready} onSetup={onSetup} />
      {via && (images.length > 0 || site) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
          {images.map((img) => {
            const n = imageKeyNumber(img.key);
            return (
              <span key={img.key} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface py-0.5 pl-0.5 pr-1 text-caption text-ink-2">
                <MediaThumb media={img.media} className="h-7 w-7 shrink-0" />
                Image {n}
                <button type="button" className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors duration-120 hover:bg-surface-3 hover:text-ink" aria-label={`Remove image ${n}`} onClick={() => setImages(images.filter((i) => i.key !== img.key))}>
                  <X size={12} />
                </button>
              </span>
            );
          })}
          {site && (
            <button type="button" className={cn('chip', website && 'chip-active')} aria-pressed={website} title={site} onClick={() => setWebsite(!website)}>
              <Globe aria-hidden="true" /> {website ? 'Your website goes with it' : 'Add my website'}
            </button>
          )}
        </div>
      )}
      <form
        className="ai-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="assistant-input" className="sr-only">
          {via ? `Message ${name}` : 'Message the assistant'}
        </label>
        <textarea
          id="assistant-input"
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          {...(via ? paste : {})}
          maxLength={6000}
          aria-describedby={via ? `${ids}-count` : `${ids}-keys`}
          aria-invalid={over || undefined}
          placeholder={via ? `Message ${name}…` : assistantReady ? 'Ask, or tell me what to do…' : 'Name a page to open…'}
          className="scroll-thin block max-h-[200px] min-h-[44px] w-full resize-none overflow-y-auto bg-transparent px-3 pb-1 pt-2.5 text-body text-ink outline-none placeholder:text-muted max-sm:text-body-lg"
        />
        <div className="flex items-center gap-1.5 pb-1.5 pl-1.5 pr-1.5">
          {via && (
            <>
              <input ref={files} type="file" accept={PROMPT_IMAGE_ACCEPT} multiple className="hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => void pick(e.target.files)} />
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label={`Attach images for ${name}`}
                title={images.length >= MAX_CHAT_IMAGES ? `That’s ${MAX_CHAT_IMAGES} images, the most for one message` : `Attach images (up to ${MAX_CHAT_IMAGES})`}
                disabled={adding || images.length >= MAX_CHAT_IMAGES}
                onClick={() => files.current?.click()}
              >
                {adding ? <Spinner /> : <Paperclip />}
              </button>
            </>
          )}
          {via ? (
            <span id={`${ids}-count`} className={cn('num ml-auto shrink-0 px-1 font-mono text-caption', over ? 'text-bad' : 'text-muted')}>
              {`${count(draft.trim().length)} / ${count(limit)}`}
              {over && <span className="sr-only"> characters: too long for one message</span>}
            </span>
          ) : (
            // how Enter works, shown while the empty box has the focus (always there for screen readers)
            <span id={`${ids}-keys`} className={cn('min-w-0 flex-1 truncate px-1.5 text-caption text-muted', !(focused && !draft) && 'invisible')}>
              Enter sends, Shift+Enter starts a new line.
            </span>
          )}
          <button type="submit" className={cn('btn btn-primary btn-icon btn-sm shrink-0 rounded-full', !via && 'ml-auto')} disabled={!canSend} aria-label={via ? `Send to ${name}` : 'Send'}>
            {delivering ? <Spinner /> : <ArrowUp />}
          </button>
        </div>
      </form>
      {via && (
        <div className="mt-1.5 px-1 text-caption text-muted">
          <p className="flex items-start justify-between gap-3">
            {agentReadiness && !agentReadiness.ready ? (
              <span className="min-w-0 text-warn" role="status">
                {agentReadiness.text}{' '}
                {agentReadiness.settings && (
                  <button type="button" className="link" onClick={onSetup}>
                    Set up
                  </button>
                )}
              </span>
            ) : (
              <span className="min-w-0">
                Your words go to {name} exactly as you type them.{adding ? ' Adding your image…' : ''}
              </span>
            )}
            <button type="button" className="link shrink-0 text-caption" aria-expanded={details} aria-controls={`${ids}-who`} onClick={() => setDetails((d) => !d)}>
              Details
            </button>
          </p>
          {/* who answers and what it costs: one click away, and in the page for screen readers and find */}
          <p id={`${ids}-who`} hidden={!details} className="mt-1.5">
            {`${agentWho(via, 'chat')} ${agentCost(via)}${via === 'manus' && credits > 0 ? ` Credits used in this chat: ${count(credits)}.` : ''}`}
          </p>
        </div>
      )}
    </div>
  );
}
