// A side sheet (the Drawer primitive) opens from a button of the page, not from a trigger of its own, so when it
// closes nothing gets the focus back: it drops to the page and a keyboard user starts again from the top. This
// hands it back to the button that opened the sheet. (Phase 3: the Drawer should do this itself; then this goes.)
import { useEffect, useRef } from 'react';

/** Pass the button that opened a side sheet to the function this returns; once `open` is false again, it gets the focus back. */
export function useFocusBack(open: boolean): (opener: HTMLElement | null) => void {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    const el = opener.current;
    // after the sheet's own clean-up (it runs on a timer too), and only when the focus was dropped
    const t = setTimeout(() => {
      const at = document.activeElement;
      if (el?.isConnected && !(el as HTMLButtonElement).disabled && (!at || at === document.body)) el.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [open]);
  return (el) => {
    opener.current = el;
  };
}
