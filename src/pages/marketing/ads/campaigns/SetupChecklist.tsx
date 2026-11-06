// What the customer must have set up at Meta or Google before launching (spec §12), from GET /api/ads/accounts.
// A "missing" item blocks the launch; "unknown" and "warn" are warnings. The words are the server's; a fix link
// is shown only for the platforms' own hosts (R6).
import { CircleAlert, CircleCheck, CircleHelp, ExternalLink, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SetupCheck } from '@/lib/ads/launchTypes';

const ALLOWED_HOSTS = ['facebook.com', 'business.facebook.com', 'www.facebook.com', 'adsmanager.facebook.com', 'ads.google.com', 'support.google.com'];

/** A link to Meta's or Google's own pages only; anything else is dropped (never a link from platform text). */
export function safeFixUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

const ICON = {
  ok: { Icon: CircleCheck, cls: 'text-good', word: 'Done' },
  warn: { Icon: TriangleAlert, cls: 'text-warn', word: 'Check' },
  unknown: { Icon: CircleHelp, cls: 'text-muted', word: 'Can’t tell' },
  missing: { Icon: CircleAlert, cls: 'text-bad', word: 'Needed' },
} as const;

export function SetupChecklist({ checks, className }: { checks: SetupCheck[]; className?: string }) {
  if (!checks.length) return null;
  return (
    <ul className={cn('flex flex-col gap-2', className)} aria-label="Setup checklist">
      {checks.map((c) => {
        const t = ICON[c.state];
        const fix = safeFixUrl(c.fixUrl);
        return (
          <li key={`${c.id}-${c.code ?? ''}`} className="flex items-start gap-2 text-small text-ink-2">
            <t.Icon size={16} className={cn('mt-0.5 shrink-0', t.cls)} aria-hidden="true" />
            <span className="sr-only">{t.word}: </span>
            <span className="min-w-0 flex-1">
              {c.message}
              {fix && (
                <a href={fix} target="_blank" rel="noopener noreferrer" className="link ml-1 inline-flex items-center gap-0.5">
                  Fix it <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "2 things to set up" / "Ready", for a one-line summary. */
export function checklistSummary(checks: SetupCheck[]): { tone: 'good' | 'warn' | 'bad'; text: string } {
  const missing = checks.filter((c) => c.state === 'missing').length;
  const warn = checks.filter((c) => c.state === 'warn' || c.state === 'unknown').length;
  if (missing) return { tone: 'bad', text: `${missing} thing${missing === 1 ? '' : 's'} to set up` };
  if (warn) return { tone: 'warn', text: `Ready, ${warn} to check` };
  return { tone: 'good', text: 'Ready' };
}
