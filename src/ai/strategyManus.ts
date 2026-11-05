// Deep research with Manus (Strategy, optional, self-hosted only): Manus opens public pages about the
// market and reports what each page says, with its link. The app sends only six short facts the owner typed
// (the server writes the whole task from them); Manus's report is untrusted web content: checked and capped
// here again, rendered as text, never written into the Brain and never sent back to Manus. Starting is a
// one-shot paid action behind a confirm: never started or retried by itself.
import { useEffect } from 'react';
import type { Project } from '@/lib/types';
import type { FindingTopic, StrategyFinding, StrategyManus, StrategyState } from '@/lib/strategyTypes';
import { FORMATS, matchBusinessType } from './knowledge';
import { ManusError, parseManusCreate, parseManusState, serverManus } from './manus';
import { addSource, domainOf, isHttpUrl, normCtx, readStrategy } from '@/lib/strategy';
import { FINDING_TOPICS, STRATEGY_CAPS, clip, enumOf, normalizeFindings } from '@/lib/strategyNormalize';
import { writeStrategy } from '@/lib/strategyWrite';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { confirmAction } from '@/components/ui/primitives';
import { openPage } from './assistant/nav';
import { strategyWho } from './strategyWho';

/** The six facts Manus gets: the owner's niche and category, local or online, the kind of business or product, and the place (local only). */
export function manusFacts(p: Project): { niche: string; category: string; kind: 'local' | 'online'; typeLabel: string; city: string; region: string } {
  const local = p.track === 'business';
  const typeLabel = local ? (matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`).label ?? '') : p.format ? FORMATS[p.format]?.label ?? '' : '';
  return { niche: clip(p.niche || p.businessType, 80), category: clip(p.category, 80), kind: local ? 'local' : 'online', typeLabel: clip(typeLabel, 80), city: local ? clip(p.location?.city, 80) : '', region: local ? clip(p.location?.region, 80) : '' };
}

export interface ManusResearch {
  state: 'done' | 'failed';
  pagesRead: number;
  reason: string;
  findings: { topic: FindingTopic; text: string; url: string; quote?: string }[];
}

/** The server's research report, checked again: http(s) links only, short texts, at most 12 findings. null when there's none. */
export function readManusResearch(v: unknown): ManusResearch | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.state !== 'done' && r.state !== 'failed') return null;
  const findings: ManusResearch['findings'] = [];
  for (const x of Array.isArray(r.findings) ? r.findings.slice(0, 40) : []) {
    const f = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const url = typeof f.url === 'string' ? f.url.trim() : '';
    const text = clip(f.text, 300);
    // a page address the strategy can't keep as a source (the server's limit too) is no finding
    if (!text || !isHttpUrl(url) || url.length > STRATEGY_CAPS.sources.url) continue;
    const quote = clip(f.quote, 200);
    findings.push({ topic: enumOf(f.topic, FINDING_TOPICS, 'other'), text, url, ...(quote ? { quote } : {}) });
    if (findings.length >= 12) break;
  }
  const pages = typeof r.pagesRead === 'number' && Number.isFinite(r.pagesRead) ? Math.min(999, Math.max(0, Math.round(r.pagesRead))) : 0;
  return { state: r.state, pagesRead: pages, reason: clip(r.reason, 300), findings };
}

const project = (pid: string) => useStore.getState().projects.find((p) => p.id === pid);

/** The confirm's words (and whose Manus account it uses). */
export function deepConfirm(again: boolean): { title: string; body: string; confirmLabel: string } {
  const own = strategyWho().deep.own;
  return {
    title: 'Start deep research with Manus?',
    body: `Manus (${own ? 'your key' : 'the app’s Manus account'}) reads public pages about your market. It usually takes several minutes or more and uses Manus credits; the amount depends on the task. You can keep working meanwhile.${again ? ' Check your Manus tasks first: the last one may still be running.' : ''}`,
    confirmLabel: 'Start (uses Manus credits)',
  };
}

/**
 * Start deep research for a project, after the confirm. One request, never retried: an uncertain start is
 * saved as failed with what to check; a refused one (no key, not ticked) is only a toast.
 */
export async function startDeepResearch(pid: string, o: { confirm?: (c: { title: string; body: string; confirmLabel: string }) => Promise<boolean> } = {}): Promise<'started' | 'cancelled' | 'unavailable' | 'failed' | 'refused'> {
  const p = project(pid);
  const deep = strategyWho().deep;
  if (!p || !deep.show || !deep.ok) {
    if (deep.reason) toast({ kind: 'info', title: 'Deep research isn’t available', body: deep.reason });
    return 'unavailable';
  }
  const again = readStrategy(p).manus?.state === 'failed';
  const ok = await (o.confirm ?? confirmAction)(deepConfirm(again));
  if (!ok) return 'cancelled';
  const now = Date.now();
  try {
    const task = parseManusCreate(await serverManus('create', { fn: 'marketResearch', research: manusFacts(p) }));
    writeStrategy(pid, (s) => ({ ...s, manus: { taskId: task.taskId, taskUrl: task.taskUrl, state: 'working', requestedAt: now, checkedAt: now } }));
    return 'started';
  } catch (e) {
    const err = e as ManusError;
    if (err?.code === 'MANUS_CREATE_UNKNOWN') {
      // it may have started: say so, and keep nothing that would start it again by itself
      writeStrategy(pid, (s) => ({ ...s, manus: { taskId: 'unknown_start', taskUrl: 'https://manus.im/app', state: 'failed', message: 'The connection dropped while starting. Check your Manus tasks before you start again.', requestedAt: now, checkedAt: now } }));
      return 'failed';
    }
    toast({ kind: 'error', title: 'Manus couldn’t start the research', body: err?.message || 'Check your Manus key in Settings → AI.' });
    return 'refused';
  }
}

/** What a check found, written into the strategy (idempotent once done). */
export function applyManusCheck(s: StrategyState, p: Project, read: { status: string; done: boolean; waiting: boolean; error: string; creditUsage: number }, research: ManusResearch | null, now = Date.now()): StrategyState {
  const m = s.manus;
  if (!m || m.state === 'done') return s;
  const base: StrategyManus = { ...m, checkedAt: now };
  if (read.waiting && !read.done) return { ...s, manus: { ...base, state: 'needs_input', message: 'Manus is waiting for you.' } };
  if (!read.done) return { ...s, manus: { ...base, state: 'working' } };
  if (research?.state === 'done') {
    const next: StrategyState = { ...s, sources: s.sources.map((x) => ({ ...x })) };
    const found: StrategyFinding[] = [];
    for (const f of research.findings) {
      const d = domainOf(f.url);
      const n = addSource(next, { url: f.url, title: d, domain: d, quote: f.quote }, 'manus', now);
      if (n !== null) found.push({ topic: f.topic, text: f.text, basis: 'web', sources: [n] });
    }
    const findings = normalizeFindings(found, { ...normCtx(p, next), trustBasis: false, fallback: 'ai' }, 12).filter((x) => x.basis === 'web');
    return { ...next, manus: { ...base, state: 'done', doneAt: now, pagesRead: research.pagesRead, credits: read.creditUsage || undefined, findings, message: '' } };
  }
  const why = research?.reason || (read.status === 'error' ? read.error || 'Manus reported an error.' : 'Manus finished without a report.');
  return { ...s, manus: { ...base, state: 'failed', message: clip(why, 300) } };
}

/** Read the Manus task and update the project's research (free: reading a task uses no credits). */
export async function checkDeepResearch(pid: string): Promise<{ before: StrategyManus['state']; after: StrategyManus['state'] } | null> {
  const p = project(pid);
  const m = p ? readStrategy(p).manus : undefined;
  if (!p || !m || m.state === 'done' || m.state === 'failed') return null;
  const raw = await serverManus('output', { task_id: m.taskId, max_images: 0 });
  const read = parseManusState(raw);
  const research = readManusResearch((raw as { research?: unknown } | null)?.research);
  let after: StrategyManus['state'] = m.state;
  writeStrategy(pid, (s) => {
    const latest = project(pid) ?? p;
    const next = applyManusCheck(s, latest, read, research);
    after = next.manus?.state ?? after;
    return next;
  });
  return { before: m.state, after };
}

const DAYS3 = 3 * 86_400_000;

/** The projects whose deep research is still running, least recently checked first. */
export function runningDeepResearch(now = Date.now()): { projectId: string; checkedAt: number; requestedAt: number }[] {
  return useStore
    .getState()
    .projects.map((p) => ({ p, m: readStrategy(p).manus }))
    .filter((x) => x.m && (x.m.state === 'working' || x.m.state === 'needs_input'))
    .map((x) => ({ projectId: x.p.id, checkedAt: x.m!.checkedAt ?? 0, requestedAt: x.m!.requestedAt }))
    .filter((x) => x.requestedAt <= now)
    .sort((a, b) => a.checkedAt - b.checkedAt);
}

function announce(pid: string, state: StrategyManus['state']) {
  const p = project(pid);
  if (!p) return;
  const brand = p.brand.name || 'your project';
  const m = readStrategy(p).manus;
  if (state === 'done') {
    toast({ kind: 'ai', title: `Manus finished researching for ${brand}`, body: `Manus read ${m?.pagesRead ?? 0} pages.`, action: { label: 'See the findings', run: () => void openPage('strategy', 'research') } });
    useStore.getState().notify({ kind: 'ai', title: `Manus finished researching for ${brand}`, body: 'New findings in Strategy → Research.', route: 'strategy' });
  } else if (state === 'failed') {
    toast({ kind: 'error', title: `Deep research stopped for ${brand}`, body: m?.message || 'Open the task in Manus to see what happened.' });
    useStore.getState().notify({ kind: 'ai', title: `Deep research stopped for ${brand}`, body: m?.message || '', route: 'strategy' });
  }
}

/** One watcher tick: up to 3 running tasks, least recently checked first; gives up on a task after 3 days. */
export async function manusWatchTick(o: { hidden?: boolean; now?: number } = {}): Promise<number> {
  if (__ARTIFACT_BUILD__ || o.hidden) return 0;
  const now = o.now ?? Date.now();
  const due = runningDeepResearch(now).slice(0, 3);
  for (const r of due) {
    if (now - r.requestedAt > DAYS3) {
      writeStrategy(r.projectId, (s) => (s.manus && (s.manus.state === 'working' || s.manus.state === 'needs_input') ? { ...s, manus: { ...s.manus, state: 'failed', message: 'Stopped checking after 3 days: open the task in Manus.', checkedAt: now } } : s));
      announce(r.projectId, 'failed');
      continue;
    }
    try {
      const out = await checkDeepResearch(r.projectId);
      if (out && out.after !== out.before && (out.after === 'done' || out.after === 'failed')) announce(r.projectId, out.after);
    } catch {
      /* transient: the next tick tries again */
    }
  }
  return due.length;
}

/** Checks running deep research every 45 seconds while the app is open (first after 5 s); nothing in the claude.ai build. */
export function useStrategyManusWatcher(): void {
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await manusWatchTick({ hidden: typeof document !== 'undefined' && document.hidden });
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(tick, 5000);
    const t = setInterval(tick, 45_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
}

/** "Check now": read the task once, with a toast when it finished. */
export async function checkNow(pid: string): Promise<void> {
  try {
    const out = await checkDeepResearch(pid);
    if (out && out.after !== out.before && (out.after === 'done' || out.after === 'failed')) announce(pid, out.after);
    else if (out) toast({ kind: 'info', title: out.after === 'needs_input' ? 'Manus is waiting for you' : 'Manus is still reading pages' });
  } catch (e) {
    toast({ kind: 'error', title: 'Couldn’t check on Manus', body: (e as Error)?.message || 'Try again in a moment.' });
  }
}
