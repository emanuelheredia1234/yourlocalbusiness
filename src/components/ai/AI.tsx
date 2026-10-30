import { useRef, useState, type ReactNode } from 'react';
import { Brain, RefreshCw, Sparkles, Square, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { GenMeta, ProviderId, Skill } from '@/lib/types';
import { cn } from '@/lib/utils';
import { FEEDBACK_REASONS } from '@/ai/brain';
import { providerLabel } from '@/ai/engine';
import { metaDetails, metaLine } from '@/ai/meta';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { navigate } from '@/lib/router';
import { Popover, Spinner } from '../ui/primitives';

export function GenerateButton({
  running,
  onClick,
  children = 'Generate with AI',
  className,
  size = 'md',
  variant = 'ai',
  disabled,
  icon,
}: {
  running?: boolean;
  onClick: () => void;
  children?: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ai' | 'primary' | 'secondary';
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={running || disabled}
      onClick={onClick}
      className={cn('btn', variant === 'ai' ? 'btn-ai' : variant === 'primary' ? 'btn-primary' : 'btn-secondary', size === 'sm' && 'btn-sm', size === 'lg' && 'btn-lg', className)}
    >
      {running ? <Spinner size={15} /> : icon ?? <Sparkles size={15} className={variant === 'ai' ? 'text-accent' : undefined} />}
      {running ? 'Generating…' : children}
    </button>
  );
}

export function RegenerateButton({ onClick, running, label = 'Regenerate' }: { onClick: () => void; running?: boolean; label?: string }) {
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={onClick} disabled={running}>
      {running ? <Spinner size={14} /> : <RefreshCw size={14} />}
      {label}
    </button>
  );
}

export function AIThinking({ running, stage, chars, onStop, className, compact }: { running: boolean; stage: string; chars?: number; onStop?: () => void; className?: string; compact?: boolean }) {
  if (!running) return null;
  return (
    <div className={cn('relative overflow-hidden rounded-lg border border-line bg-surface', compact ? 'px-3 py-2' : 'px-4 py-3', className)} role="status" aria-live="polite">
      <div className="absolute inset-x-0 top-0 h-[2px] overflow-hidden">
        <div className="h-full w-1/3 animate-[shimmer_1.4s_linear_infinite] bg-gradient-to-r from-transparent via-accent to-transparent" style={{ backgroundSize: '200% 100%' }} />
      </div>
      <div className="flex items-center gap-3">
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-accent">
          <Sparkles size={14} />
          <span className="absolute inset-0 animate-ping rounded-full bg-accent/25" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-ink">{stage || 'Thinking…'}</p>
          {!compact && <p className="num text-xs text-muted">{chars ? `${chars.toLocaleString()} characters written` : 'Using your project context and Brain skills'}</p>}
        </div>
        {onStop && (
          <button className="btn btn-secondary btn-xs" onClick={onStop}>
            <Square size={11} className="fill-current" /> Stop
          </button>
        )}
      </div>
    </div>
  );
}

export function ProviderBadge({ provider, meta }: { provider: ProviderId; meta?: GenMeta }) {
  return (
    <span className={cn('badge', provider === 'local' ? 'bg-surface-2 text-ink-2' : 'bg-ink text-surface')}>
      <Sparkles size={10} className={provider === 'local' ? '' : 'text-accent'} />
      {provider === 'server' && meta ? `AI · ${meta.providerLabel}` : providerLabel(provider)}
    </span>
  );
}

/** Which key, model and effort answered, and what it used (tokens, cost), from the generation log. */
export function AIMetaLine({ meta, className }: { meta: GenMeta; className?: string }) {
  return (
    <span className={cn('num inline-flex min-w-0 items-center gap-1 truncate', className)} title={metaDetails(meta)}>
      {metaLine(meta).split(' · ').slice(1).join(' · ')}
    </span>
  );
}

export function AIResultBar({ provider, skills, ms, note, logId, className }: { provider: ProviderId; skills: Skill[]; ms?: number; note?: string; logId: string | null; className?: string }) {
  const rate = useStore((s) => s.rateGeneration);
  const log = useStore((s) => s.genLog.find((g) => g.id === logId));
  const meta = provider === 'server' ? log?.meta : undefined;
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [text, setText] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);
  const rated = log?.rating;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted', className)}>
      <ProviderBadge provider={provider} meta={meta} />
      {meta && <AIMetaLine meta={meta} />}
      {skills.length > 0 ? (
        <button className="inline-flex items-center gap-1.5 rounded px-1 hover:bg-surface-2 hover:text-ink" onClick={() => navigate('brain')} title={skills.map((s) => s.name).join(', ')}>
          <Brain size={13} className="text-primary" />
          <span>
            Brain applied {skills.length} skill{skills.length > 1 ? 's' : ''}: <span className="font-medium text-ink-2">{skills.slice(0, 2).map((s) => s.name).join(', ')}{skills.length > 2 ? '…' : ''}</span>
          </span>
        </button>
      ) : (
        <button className="inline-flex items-center gap-1.5 rounded px-1 hover:bg-surface-2 hover:text-ink" onClick={() => navigate('brain')}>
          <Brain size={13} /> No Brain skills applied · add one
        </button>
      )}
      {ms !== undefined && <span className="num">{(ms / 1000).toFixed(1)}s</span>}
      {note && <span className="w-full rounded bg-warn-soft px-2 py-1 text-[12px] text-warn">{note}</span>}
      {logId && (
        <span className="ml-auto inline-flex items-center gap-1">
          <span className="mr-1 hidden sm:inline">Was this useful?</span>
          <button
            className={cn('rounded p-1.5 hover:bg-surface-2', rated === 1 ? 'text-good' : 'hover:text-ink')}
            aria-label="Good result"
            aria-pressed={rated === 1}
            onClick={() => {
              rate(logId, 1);
              toast({ kind: 'ai', title: 'Thanks! The Brain will keep doing this.' });
            }}
          >
            <ThumbsUp size={14} />
          </button>
          <button ref={anchor} className={cn('rounded p-1.5 hover:bg-surface-2', rated === -1 ? 'text-bad' : 'hover:text-ink')} aria-label="Needs work" aria-pressed={rated === -1} onClick={() => setOpen(true)}>
            <ThumbsDown size={14} />
          </button>
          <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="w-[300px] p-3">
            <p className="text-[13px] font-semibold text-ink">What should change?</p>
            <p className="mb-2 text-xs text-muted">Your feedback trains the Brain’s learned preferences.</p>
            <div className="flex flex-wrap gap-1.5">
              {FEEDBACK_REASONS.map((r) => (
                <button
                  key={r.id}
                  className={cn('chip', reasons.includes(r.id) && 'chip-active')}
                  onClick={() => setReasons((x) => (x.includes(r.id) ? x.filter((y) => y !== r.id) : [...x, r.id]))}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <textarea className="textarea mt-2 min-h-[64px] text-[13px]" placeholder="Anything else? e.g. “mention our free shipping”" value={text} onChange={(e) => setText(e.target.value)} />
            <button
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
              <Brain size={14} /> Teach the Brain
            </button>
          </Popover>
        </span>
      )}
    </div>
  );
}
