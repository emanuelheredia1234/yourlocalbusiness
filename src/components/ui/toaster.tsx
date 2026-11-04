// Toasts: Sonner draws and stacks them (swipe, hover to expand, an aria-live region), the look is ours,
// and useUI stays the source of truth (tests read useUI.getState().toasts): each new store toast is
// shown with toast.custom, and dropped from Sonner when the store drops it (its time is up, or ✕).

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Toaster as Sonner, toast as sonner } from 'sonner';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useMediaQuery } from '@/lib/hooks';
import { useUI, type Toast } from '@/store/ui';
import { Spark } from '../ai/Spark';

/**
 * Where toasts go: the corner, above the assistant's chat button (so they don't cover it), or, while its
 * panel is open, beside the docked panel on wide screens and at the top on smaller ones.
 */
export type ToastPlacement = 'corner' | 'above-launcher' | 'beside-panel';

/** The theme the page shows now (data-theme on <html>, set by the boot script and useThemeSync). */
function useResolvedTheme(): 'light' | 'dark' {
  const read = () => (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setTheme(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

function ToastCard({ t }: { t: Toast }) {
  const dismiss = () => useUI.getState().dismissToast(t.id);
  return (
    <div className="toast-card group flex w-full items-start gap-3 rounded-pop px-3.5 py-3">
      <span className="mt-0.5 flex shrink-0" aria-hidden="true">
        {t.kind === 'success' ? (
          <CircleCheck size={16} className="toast-icon-success" />
        ) : t.kind === 'error' ? (
          <CircleAlert size={16} className="toast-icon-error" />
        ) : t.kind === 'ai' ? (
          <Spark size={16} />
        ) : (
          <Info size={16} className="toast-icon-info" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-small font-medium">{t.title}</p>
        {t.body && <p className="toast-body mt-0.5 text-small">{t.body}</p>}
      </div>
      {t.action && (
        <button
          type="button"
          className="shrink-0 self-center text-small font-medium underline underline-offset-[3px] hover:no-underline"
          onClick={() => {
            t.action!.run();
            dismiss();
          }}
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        className="-mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity duration-120 hover:bg-on-inverse/10 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-surface-3 [@media(pointer:coarse)]:opacity-100"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function Toaster({ placement = 'corner' }: { placement?: ToastPlacement }) {
  const toasts = useUI((s) => s.toasts);
  const theme = useResolvedTheme();
  const phone = useMediaQuery('(max-width: 639px)');
  const docked = useMediaQuery('(min-width: 1440px)');
  const shown = useRef(new Set<string>());

  // mirror the store into Sonner
  useEffect(() => {
    const ids = new Set(toasts.map((t) => t.id));
    for (const t of toasts) {
      if (shown.current.has(t.id)) continue;
      shown.current.add(t.id);
      sonner.custom(() => <ToastCard t={t} />, { id: t.id, duration: Infinity });
    }
    for (const id of [...shown.current]) {
      if (ids.has(id)) continue;
      shown.current.delete(id);
      sonner.dismiss(id);
    }
  }, [toasts]);

  // phones: always top-centre under the header; the assistant open below 1440: top-centre;
  // docked beside the assistant (≥ 1440): bottom-right, left of the panel; otherwise bottom-right
  const top = phone || (placement === 'beside-panel' && !docked);
  const right = placement === 'beside-panel' && docked ? 24 + 408 : 24;
  const bottom = placement === 'above-launcher' ? 24 + 72 : 24;
  return (
    <Sonner
      position={top ? 'top-center' : 'bottom-right'}
      theme={theme}
      visibleToasts={3}
      gap={8}
      offset={top ? { top: 'max(68px, calc(env(safe-area-inset-top, 0px) + 60px))' } : { right, bottom }}
      mobileOffset={{ top: 'max(64px, calc(env(safe-area-inset-top, 0px) + 60px))', left: 12, right: 12 }}
      className="ylb-toaster"
      style={{ '--width': '360px', zIndex: 80 } as CSSProperties}
      toastOptions={{ unstyled: true, className: 'w-full' }}
    />
  );
}
