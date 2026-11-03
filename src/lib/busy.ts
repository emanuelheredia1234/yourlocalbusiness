// What's generating right now, so leaving a page (or closing the tab) can warn that it will stop.
//
// page: it stops when you leave the page it runs on (text, AI images, product files: their requests
//       are cancelled when the page closes).
// app:  it keeps going while you move around the app, but a reload or closing the tab interrupts it
//       (handing a post to Manus).
// Videos aren't listed: they keep running on the server and their panel offers "Pick it up".
import { create } from 'zustand';

export type BusyScope = 'page' | 'app';

export interface BusyJob {
  id: string;
  /** what's being made, as people see it ("Social post", "Listing images") */
  label: string;
  scope: BusyScope;
}

export const useBusy = create<{ jobs: Record<string, BusyJob> }>(() => ({ jobs: {} }));

let seq = 0;
/** A new id for one generator (a hook instance keeps the same one for all its runs). */
export const busyId = (prefix = 'job') => `${prefix}#${++seq}`;

export function beginBusy(id: string, label: string, scope: BusyScope = 'page'): void {
  useBusy.setState((s) => ({ jobs: { ...s.jobs, [id]: { id, label, scope } } }));
}

/** Safe to call more than once (unmount, stop and finish can all end the same job). */
export function endBusy(id: string): void {
  useBusy.setState((s) => {
    if (!s.jobs[id]) return s;
    const { [id]: _gone, ...jobs } = s.jobs;
    return { jobs };
  });
}

export function busyJobs(scope?: BusyScope): BusyJob[] {
  return Object.values(useBusy.getState().jobs).filter((j) => !scope || j.scope === scope);
}

/** What to say before leaving a page: null when nothing on the page would stop. */
export function leaveMessage(jobs: BusyJob[]): { title: string; body: string } | null {
  const labels = [...new Set(jobs.filter((j) => j.scope === 'page').map((j) => j.label))];
  if (!labels.length) return null;
  const what = labels.length === 1 ? `“${labels[0]}” is still being generated` : `${labels.length} things are still being generated: ${labels.join(', ')}`;
  return {
    title: 'Stop generating?',
    body: `${what}. If you leave this page, the generation will stop and what it was making won’t be kept.`,
  };
}
