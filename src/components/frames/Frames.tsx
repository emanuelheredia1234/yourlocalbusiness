// Product frames: the business's own posts and pages shown the way they'll look out in the world
// (a social post, a phone, a browser window), with the soft product shadow.

import type { ReactNode } from 'react';
import { Ellipsis, Lock } from 'lucide-react';
import { cn, initials } from '@/lib/utils';

/** A social post: avatar and handle, the media at the platform's aspect, the caption. */
export function PostFrame({
  handle,
  avatar,
  meta,
  children,
  caption,
  footer,
  corner,
  className,
}: {
  handle: string;
  avatar?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  caption?: ReactNode;
  footer?: ReactNode;
  corner?: ReactNode;
  className?: string;
}) {
  return (
    <article className={cn('overflow-hidden rounded-stage border border-line bg-surface shadow-product', className)}>
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3 text-micro text-ink-2">{avatar ?? initials(handle)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-small font-semibold text-ink">{handle}</span>
          {meta && <span className="block truncate text-caption text-muted">{meta}</span>}
        </span>
        {corner ?? <Ellipsis size={16} className="shrink-0 text-muted" aria-hidden="true" />}
      </header>
      <div className="relative">{children}</div>
      {caption && (
        <p className="clamp-3 px-3 py-2.5 text-small text-ink-2">
          <span className="mr-1 font-semibold text-ink">{handle}</span>
          {caption}
        </p>
      )}
      {footer && <div className="border-t border-line px-3 py-2 text-caption text-muted">{footer}</div>}
    </article>
  );
}

/** The phone bezel stays ink in both themes (it's hardware, not chrome). */
const BEZEL = '#0F0F12';

/** A phone (300×620): ink bezel in both themes, an island, the screen clipped inside. */
export function PhoneFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('relative h-[620px] w-[300px] shrink-0 p-2 shadow-product dark:ring-1 dark:ring-line', className)} style={{ borderRadius: 44, background: BEZEL }}>
      <div className="relative h-full w-full overflow-hidden bg-surface" style={{ borderRadius: 36 }}>
        <span aria-hidden="true" className="absolute left-1/2 top-2 z-10 h-[26px] w-[90px] -translate-x-1/2 rounded-full" style={{ background: BEZEL }} />
        {children}
      </div>
    </div>
  );
}

/** A browser window: three dots, the page's address, an optional toolbar, the page. */
export function BrowserFrame({ url, children, toolbar, className, bodyClassName }: { url?: string; children: ReactNode; toolbar?: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-pop border border-line bg-surface shadow-product', className)}>
      <div className="flex h-8 items-center gap-3 border-b border-line bg-surface-2 px-3">
        <span className="flex shrink-0 gap-1.5" aria-hidden="true">
          <span className="h-2 w-2 rounded-full bg-line-3" />
          <span className="h-2 w-2 rounded-full bg-line-3" />
          <span className="h-2 w-2 rounded-full bg-line-3" />
        </span>
        {url && (
          <span className="mx-auto flex min-w-0 max-w-[70%] items-center gap-1.5 rounded bg-surface px-2.5 py-0.5 ring-1 ring-inset ring-line">
            <Lock size={12} className="shrink-0 text-muted" aria-hidden="true" />
            <span className="truncate font-mono text-caption text-muted">{url}</span>
          </span>
        )}
        {toolbar && <span className={cn('flex shrink-0 items-center gap-1', !url && 'ml-auto')}>{toolbar}</span>}
      </div>
      <div className={cn('relative', bodyClassName)}>{children}</div>
    </div>
  );
}
