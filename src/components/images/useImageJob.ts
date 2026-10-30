import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRuntime } from '@/lib/platform';
import { imageErrorMessage, photoAvailability } from '@/ai/image';
import type { ManusTask } from '@/ai/manus';
import { visualBrief } from '@/ai/brain';
import { useStore } from '@/store/useStore';

export interface ImageJobState {
  running: boolean;
  stage: string;
  error: { title: string; body: string; code: string; taskUrl?: string } | null;
  /** label for the last result, e.g. "Claude illustration · 8.4s" */
  done: string;
  note: string;
  /** the Manus task working on it, for an "open in Manus" link */
  task: ManusTask | null;
}

/** Runs one image generation at a time with progress, stop and error state. */
export function useImageJob() {
  const [state, setState] = useState<ImageJobState>({ running: false, stage: '', error: null, done: '', note: '', task: null });
  const ctl = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ctl.current?.abort();
    };
  }, []);

  const run = useCallback(async <T,>(job: (signal: AbortSignal, onStage: (s: string) => void, onTask: (t: ManusTask) => void) => Promise<T>, describe?: (r: T) => { done: string; note?: string }): Promise<T | null> => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setState({ running: true, stage: 'Starting…', error: null, done: '', note: '', task: null });
    try {
      const r = await job(
        c.signal,
        (stage) => mounted.current && setState((s) => ({ ...s, stage })),
        (task) => mounted.current && setState((s) => ({ ...s, task })),
      );
      const d = describe?.(r);
      if (mounted.current) setState((s) => ({ running: false, stage: '', error: null, done: d?.done ?? '', note: d?.note ?? '', task: s.task }));
      return r;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const stopped = code === 'cancelled' || c.signal.aborted;
      if (mounted.current) setState((s) => ({ running: false, stage: '', error: stopped ? null : imageErrorMessage(e), done: '', note: stopped && s.task ? 'Stopped waiting. Manus may still finish the image in your Manus account.' : '', task: s.task }));
      return null;
    } finally {
      if (ctl.current === c) ctl.current = null;
    }
  }, []);

  const stop = useCallback(() => ctl.current?.abort(), []);
  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);
  return { ...state, run, stop, clearError };
}

/** Re-renders when photo support (your server's keys, or Zapier in claude.ai) changes. */
export function usePhotoAvailability() {
  useRuntime((s) => s.ai);
  useRuntime((s) => s.zapier);
  return photoAvailability();
}

/** The Brain skills that will shape a photo or video's art direction (for a hint under the controls). */
export function useArtDirection(purpose: 'post' | 'listing') {
  const skills = useStore((s) => s.skills);
  const useBrain = useStore((s) => s.settings.ai.useBrain);
  return useMemo(() => visualBrief(skills, purpose === 'post' ? 'social' : 'studio', useBrain), [skills, useBrain, purpose]);
}

/** One line naming the skills, e.g. "Brain art direction: Authentic, real-life imagery". */
export function artDirectionLabel(names: string[]): string {
  return names.length ? `Brain art direction: ${names.join(', ')}` : '';
}
