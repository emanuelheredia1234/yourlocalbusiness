// "Leave this page?" while something is generating (see src/lib/busy.ts).
import { busyJobs, leaveMessage, useBusy } from '@/lib/busy';
import { setLeaveGuard } from '@/lib/router';
import { confirmAction } from './primitives';

/** Ask before something closes the page while it's generating. true (right away) when nothing would stop. */
export function confirmLeave(): boolean | Promise<boolean> {
  const msg = leaveMessage(busyJobs());
  if (!msg) return true;
  return confirmAction({ ...msg, confirmLabel: 'Leave anyway', cancelLabel: 'Stay on this page', danger: true });
}

const onBeforeUnload = (e: BeforeUnloadEvent) => {
  // browsers show their own "Leave site?" text; custom words aren't allowed there
  e.preventDefault();
  e.returnValue = '';
};

/** Install the page-change guard, and the browser's own prompt on reload or close while anything runs. Returns the undo. */
export function installLeaveGuard(): () => void {
  setLeaveGuard(() => confirmLeave());
  let on = false;
  const sync = (busy: boolean) => {
    // only while busy, so the browser's back/forward cache keeps working otherwise
    if (busy && !on) window.addEventListener('beforeunload', onBeforeUnload);
    else if (!busy && on) window.removeEventListener('beforeunload', onBeforeUnload);
    on = busy;
  };
  sync(Object.keys(useBusy.getState().jobs).length > 0);
  const unsub = useBusy.subscribe((s) => sync(Object.keys(s.jobs).length > 0));
  return () => {
    unsub();
    setLeaveGuard(null);
    if (on) window.removeEventListener('beforeunload', onBeforeUnload);
  };
}
