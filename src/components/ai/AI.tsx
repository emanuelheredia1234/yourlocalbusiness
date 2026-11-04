// The AI moments: the buttons that make something, the thinking strip while it works, the result
// footer with its Details, the AI card and the inline "Edit with AI" composer. The aura (purple to
// orange) appears only here and in the assistant; pages get AI styling only through these components.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brain, Copy, ImagePlus, RefreshCw, Square, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { GenMeta, MediaRef, PromptImage, ProviderId, Skill } from '@/lib/types';
import { cn } from '@/lib/utils';
import { FEEDBACK_REASONS } from '@/ai/brain';
import { providerLabel } from '@/ai/engine';
import { metaDetails, metaLine } from '@/ai/meta';
import { MAX_PROMPT_IMAGES, PROMPT_IMAGE_ACCEPT } from '@/lib/promptImages';
import { saveMediaFile } from '@/lib/storage';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { navigate } from '@/lib/router';
import { cn as mergeCn } from '../ui/shadcn/utils';
import { AutoTextarea, Badge, Callout, Popover, Spinner, Tooltip } from '../ui/primitives';
import { PromptImages, usePasteImages, usePromptImageAdder } from './PromptImages';
import { Spark } from './Spark';

export { Spark } from './Spark';

type GenerateVariant = 'ai' | 'ai-outline' | 'ai-ghost' | 'primary' | 'secondary';

const VARIANT: Record<GenerateVariant, string> = {
  ai: 'btn-ai',
  'ai-outline': 'btn-ai-outline',
  'ai-ghost': 'btn-ghost',
  primary: 'btn-primary',
  secondary: 'btn-secondary',
};

/**
 * The button that makes something with AI. `ai-outline` (the default) for most AI actions; `ai` (ink
 * fill + aura edge) only for the view's main action; `ai-ghost` inside rows. While running it keeps its
 * width, shows the breathing orb and a task verb (`runningLabel`, e.g. "Writing…").
 */
export function GenerateButton({
  running,
  onClick,
  children = 'Generate with AI',
  className,
  size = 'md',
  variant = 'ai-outline',
  disabled,
  icon,
  runningLabel = 'Working…',
}: {
  running?: boolean;
  onClick: () => void;
  children?: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: GenerateVariant;
  disabled?: boolean;
  icon?: ReactNode;
  runningLabel?: string;
}) {
  const aiLook = variant === 'ai' || variant === 'ai-outline' || variant === 'ai-ghost';
  return (
    <button
      type="button"
      disabled={running || disabled}
      aria-busy={running || undefined}
      onClick={onClick}
      className={cn('btn', VARIANT[variant], size === 'sm' && 'btn-sm', size === 'lg' && 'btn-lg', running && 'is-running', className)}
    >
      {running ? aiLook ? <span className="orb" aria-hidden="true" /> : <Spinner /> : icon ?? <Spark size={size === 'lg' ? 18 : 16} />}
      {running ? runningLabel : children}
    </button>
  );
}

export function RegenerateButton({ onClick, running, label = 'Regenerate' }: { onClick: () => void; running?: boolean; label?: string }) {
  return (
    <button type="button" className={cn('btn btn-ai-outline btn-sm', running && 'is-running')} onClick={onClick} disabled={running} aria-busy={running || undefined}>
      {running ? <span className="orb" aria-hidden="true" /> : <RefreshCw />}
      {label}
    </button>
  );
}

const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function ThinkingStrip({ stage, step, onStop, className, compact }: { stage: string; step?: string; onStop?: () => void; className?: string; compact?: boolean }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={mergeCn('thinking', compact && 'min-h-9 gap-2.5 py-1.5 pl-3 pr-1.5', className)} role="status" aria-live="polite">
      <span className="orb" aria-hidden="true" />
      <p className="shimmer-text min-w-0 flex-1 truncate text-ui">{stage || 'Thinking…'}</p>
      <span className="num shrink-0 font-mono text-caption text-muted">
        {!compact && step ? `${step} · ` : ''}
        {fmtElapsed(secs)}
      </span>
      {onStop && (
        <button type="button" className="btn btn-ghost btn-xs shrink-0" onClick={onStop}>
          <Square className="!size-3 fill-current" aria-hidden="true" /> Stop
        </button>
      )}
    </div>
  );
}

/** The thinking strip, placed where the result will land. `chars` is accepted and ignored. */
export function AIThinking({ running, stage, onStop, className, compact, step }: { running: boolean; stage: string; chars?: number; onStop?: () => void; className?: string; compact?: boolean; step?: string }) {
  if (!running) return null;
  return <ThinkingStrip stage={stage} step={step} onStop={onStop} className={className} compact={compact} />;
}

/** Who answered, as a neutral badge (still exported; the result footer keeps this behind Details). */
export function ProviderBadge({ provider, meta }: { provider: ProviderId; meta?: GenMeta }) {
  return <Badge>{provider === 'server' && meta ? `AI · ${meta.providerLabel}` : providerLabel(provider)}</Badge>;
}

/** Which key, model and effort answered, and what it used (tokens, cost), from the generation log. */
export function AIMetaLine({ meta, className }: { meta: GenMeta; className?: string }) {
  return (
    <span className={cn('num inline-flex min-w-0 items-center gap-1 truncate', className)} title={metaDetails(meta)}>
      {metaLine(meta).split(' · ').slice(1).join(' · ')}
    </span>
  );
}

/**
 * The footer under an AI result: "Written in your brand voice" (or by AI), a Details popover (who wrote
 * it, how long it took, tokens and cost, the Brain skills used), and Copy / Regenerate / Good / Needs work.
 */
export function AIResultBar({
  provider,
  skills,
  ms,
  note,
  logId,
  className,
  onCopy,
  onRegenerate,
}: {
  provider: ProviderId;
  skills: Skill[];
  ms?: number;
  note?: string;
  logId: string | null;
  className?: string;
  onCopy?: () => void;
  onRegenerate?: () => void;
}) {
  const rate = useStore((s) => s.rateGeneration);
  const log = useStore((s) => s.genLog.find((g) => g.id === logId));
  const meta = provider === 'server' ? log?.meta : undefined;
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [text, setText] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);
  const detailsAnchor = useRef<HTMLButtonElement>(null);
  const rated = log?.rating;
  const who = skills.length > 0 ? 'Written in your brand voice' : provider === 'local' ? 'Drafted by the built-in engine' : 'Written by AI';
  return (
    <div className={mergeCn('flex flex-col gap-2', className)}>
      {note && <Callout tone="warn">{note}</Callout>}
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2 text-caption text-muted">
        <Spark size={14} />
        <span>{who}</span>
        <button ref={detailsAnchor} type="button" className="link text-caption" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
          Details
        </button>
        <Popover open={details} onClose={() => setDetails(false)} anchor={detailsAnchor} align="start" className="w-80 p-3">
          <p className="text-small font-semibold text-ink">How this was made</p>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-small">
            <dt className="text-muted">Written by</dt>
            <dd className="min-w-0 text-ink-2">{meta ? `${meta.providerLabel} · ${meta.model}` : providerLabel(provider)}</dd>
            {ms !== undefined && (
              <>
                <dt className="text-muted">Time</dt>
                <dd className="num font-mono text-ink-2">{(ms / 1000).toFixed(1)}s</dd>
              </>
            )}
          </dl>
          {meta && <pre className="mt-2 whitespace-pre-wrap rounded-pop bg-surface-2 px-2.5 py-2 font-mono text-caption text-ink-2">{metaDetails(meta)}</pre>}
          <p className="mt-3 text-small font-semibold text-ink">Brain skills used</p>
          {skills.length ? (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {skills.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="link text-small"
                    onClick={() => {
                      setDetails(false);
                      navigate('brain');
                    }}
                  >
                    {s.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-small text-muted">None for this one.</p>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-xs mt-3"
            onClick={() => {
              setDetails(false);
              navigate('brain');
            }}
          >
            <Brain /> Manage Brain
          </button>
        </Popover>
        <span className="ml-auto flex items-center gap-0.5">
          {onCopy && (
            <Tooltip content="Copy">
              <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label="Copy" onClick={onCopy}>
                <Copy />
              </button>
            </Tooltip>
          )}
          {onRegenerate && (
            <Tooltip content="Regenerate">
              <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label="Regenerate" onClick={onRegenerate}>
                <RefreshCw />
              </button>
            </Tooltip>
          )}
          {logId && (
            <>
              <Tooltip content="Good result">
                <button
                  type="button"
                  className={cn('btn btn-ghost btn-icon btn-xs', rated === 1 && 'text-ink')}
                  aria-label="Good result"
                  aria-pressed={rated === 1}
                  onClick={() => {
                    rate(logId, 1);
                    toast({ kind: 'ai', title: 'Thanks. The Brain will keep doing this.' });
                  }}
                >
                  <ThumbsUp className={cn(rated === 1 && 'fill-current')} />
                </button>
              </Tooltip>
              <Tooltip content="Needs work">
                <button ref={anchor} type="button" className={cn('btn btn-ghost btn-icon btn-xs', rated === -1 && 'text-ink')} aria-label="Needs work" aria-pressed={rated === -1} onClick={() => setOpen(true)}>
                  <ThumbsDown className={cn(rated === -1 && 'fill-current')} />
                </button>
              </Tooltip>
              <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="w-[300px] p-3">
                <p className="text-small font-semibold text-ink">What should change?</p>
                <p className="mb-2 text-caption text-muted">Your feedback trains the Brain’s learned preferences.</p>
                <div className="flex flex-wrap gap-1.5">
                  {FEEDBACK_REASONS.map((r) => (
                    <button key={r.id} type="button" className={cn('chip', reasons.includes(r.id) && 'chip-active')} onClick={() => setReasons((x) => (x.includes(r.id) ? x.filter((y) => y !== r.id) : [...x, r.id]))}>
                      {r.label}
                    </button>
                  ))}
                </div>
                <textarea className="textarea mt-2 min-h-[64px]" placeholder="Anything else? e.g. “mention our free shipping”" value={text} onChange={(e) => setText(e.target.value)} />
                <button
                  type="button"
                  className="btn btn-primary btn-sm mt-2 w-full"
                  disabled={!reasons.length && !text.trim()}
                  onClick={() => {
                    rate(logId, -1, reasons, text);
                    setOpen(false);
                    setReasons([]);
                    setText('');
                    toast({ kind: 'ai', title: 'Brain updated', body: 'Future outputs will follow your learned preferences.', action: { label: 'View in Brain', run: () => navigate('brain') } });
                  }}
                >
                  <Brain /> Teach the Brain
                </button>
              </Popover>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** The one "AI card" a page may have: a hairline aura on top and a soft glow in the corner. */
export function AiCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={mergeCn('ai-card p-4 sm:p-5', className)}>{children}</div>;
}

/**
 * The inline "Edit with AI" box (SEO page, Code & assets, Brain playground): a borderless text box in
 * an aura-on-focus frame, optional images, a scope slot, and the submit button. ⌘/Ctrl+Enter submits.
 */
export function AIComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  running,
  submitLabel = 'Apply',
  images,
  onImagesChange,
  maxImages = MAX_PROMPT_IMAGES,
  scope,
  suggestions,
  onSuggestion,
  info,
  sticky,
  id,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  running?: boolean;
  submitLabel?: string;
  images?: PromptImage[];
  onImagesChange?: (images: PromptImage[]) => void;
  maxImages?: number;
  scope?: ReactNode;
  suggestions?: string[];
  onSuggestion?: (s: string) => void;
  info?: ReactNode;
  sticky?: boolean;
  id?: string;
  'aria-label'?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const withImages = !!images && !!onImagesChange;
  const addImages = usePromptImageAdder(images ?? [], onImagesChange ?? (() => {}), { max: maxImages });
  const paste = usePasteImages(addImages, { room: maxImages - (images?.length ?? 0), max: maxImages, disabled: !withImages || disabled || running, onBusy: setBusy });
  const canSubmit = !!value.trim() && !disabled && !running;
  const list = suggestions ?? [];
  const pages = Math.max(1, Math.ceil(list.length / 4));
  const shown = list.slice((page % pages) * 4, (page % pages) * 4 + 4);
  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const media: MediaRef[] = [];
    try {
      for (const f of Array.from(files)) {
        try {
          media.push(await saveMediaFile(f));
        } catch (e) {
          toast({ kind: 'error', title: `Couldn’t add ${f.name || 'that image'}`, body: (e as Error).message });
        }
      }
    } finally {
      setBusy(false);
    }
    if (media.length) addImages(media);
  };
  return (
    <div className={cn(sticky && 'sticky bottom-3 z-10')}>
      <div className={cn('ai-composer px-3 pb-2 pt-2.5', sticky && 'shadow-pop')}>
        <AutoTextarea
          id={id}
          aria-label={ariaLabel}
          value={value}
          onChange={onChange}
          minRows={2}
          placeholder={placeholder}
          disabled={disabled || running}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (canSubmit) onSubmit();
            }
          }}
          {...paste}
          className="!border-0 !bg-transparent !px-1 !py-0.5 !shadow-none"
        />
        {withImages && images!.length > 0 && <PromptImages images={images!} onChange={onImagesChange!} max={maxImages} busy={busy} disabled={disabled || running} compact className="mt-2" />}
        <div className="mt-1.5 flex items-center gap-1.5">
          {withImages && (
            <>
              <Tooltip content="Add images">
                <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Add images" disabled={disabled || running || (images?.length ?? 0) >= maxImages} onClick={() => fileInput.current?.click()}>
                  <ImagePlus />
                </button>
              </Tooltip>
              <input ref={fileInput} type="file" accept={PROMPT_IMAGE_ACCEPT} multiple className="hidden" onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ''))} />
            </>
          )}
          {scope}
          <span className="ml-auto flex items-center gap-1.5">
            {info}
            <Tooltip content="Apply" kbd="⌘↵">
              <button type="button" className={cn('btn btn-ai-outline btn-sm', running && 'is-running')} disabled={!canSubmit} aria-busy={running || undefined} onClick={onSubmit}>
                {running ? <span className="orb" aria-hidden="true" /> : <Spark size={16} />}
                {submitLabel}
              </button>
            </Tooltip>
          </span>
        </div>
      </div>
      {shown.length > 0 && onSuggestion && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {shown.map((s) => (
            <button key={s} type="button" className="chip max-w-[40ch]" title={s} disabled={disabled || running} onClick={() => onSuggestion(s)}>
              <span className="truncate">{s}</span>
            </button>
          ))}
          {pages > 1 && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setPage((p) => p + 1)}>
              More ideas
            </button>
          )}
        </div>
      )}
    </div>
  );
}
