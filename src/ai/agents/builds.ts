// Builds by Manus or Viktor (Build with… in Code & assets and the SEO page): starting one, following it until a
// page comes back, the follow-ups the owner sends (an answer, a change, "send the page as one file"), Stop, and
// getting the page to preview or use. Builds are kept in the project (project.agentBuilds), so a reload or another
// device picks them up; checking on them is the app's job (the build cards while they're on screen, and a watcher
// every 45 s), never the server's.
//
// Every message to Manus or Viktor is a paid, one-shot write: it's sent once, on the owner's click, after a confirm
// that says who does the work and what it costs, and never sent again by itself. A send that may have arrived
// ("may have been delivered") is settled by reading (verify), never by sending again. Their replies are untrusted:
// kept as text only (`said`, cut to 600 characters), never sent to the assistant model.

import { useEffect } from 'react';
import type { AgentBuild, AgentHtml, AgentId, BuildFact, BuildRequest, BuildTarget, ImageNote, ManusRead, ViktorRead } from '@/lib/agentTypes';
import type { PromptImage } from '@/lib/types';
import { beginBusy, busyJobs, endBusy } from '@/lib/busy';
import { PAGE_TYPE_LABEL } from '@/lib/pageTypes';
import { uid } from '@/lib/utils';
import { codeKindLabel } from '@/ai/local/code';
import { LEAD_MAGNET_TYPES } from '@/ai/local/email';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { confirmAction } from '@/components/ui/primitives';
import { openPage } from '@/ai/assistant/nav';
import { AgentError, agentErrorText, manusHtml, manusRead, manusSend, manusStart, manusStop, manusVerify, newRef, sendImages, viktorHtml, viktorRead, viktorSend, viktorVerify } from './api';
import { agentCost, agentName, agentWho } from './who';
import { IN_FLIGHT, addBuild, buildsOf, findBuild, patchBuild, removeBuild } from './buildRecords';
import type { AgentHtmlSource } from './results';

// ───────────── timing ─────────────

/** A build's card checks every 6 s for 2 minutes after a request, then every 15 s until 10 minutes; after that, the watcher. */
export const FAST_MS = 6_000;
export const SLOW_MS = 15_000;
export const FAST_FOR = 2 * 60_000;
export const CARD_FOR = 10 * 60_000;
/** The watcher: every 45 s (the first 5 s after the app opens), at most 3 builds each time. */
export const WATCH_MS = 45_000;
export const WATCH_FIRST_MS = 5_000;
export const WATCH_MAX = 3;
/** A build still "sending" after this long wasn't sent by this tab any more (the app closed while sending). */
export const STALE_SENDING = 2 * 60_000;
/** Checking stops after 3 days. */
export const GIVE_UP_AFTER = 3 * 24 * 3_600_000;
/** An uncertain send is checked twice, about 30 s apart, before it counts as not delivered. */
export const VERIFY_TRIES = 2;
export const VERIFY_GAP = 30_000;
/** Viktor may still be writing a page that came in parts: it's only "part of the page" after this long. */
export const PARTIAL_GRACE = 2 * 60_000;
/** The agent's latest words kept on the card. */
export const SAID_MAX = 600;
/** The request caps, as the server's (server/agents/templates.mjs). */
export const REQUEST_MAX: Record<AgentId, number> = { manus: 4000, viktor: 1500 };

/** What this tab knows about each build, apart from what's saved: when it was last checked, uncertain sends checked. Never saved. */
const memory = new Map<string, { checkedAt: number; verifyTries: number; verifiedAt: number; checking: Promise<void> | null }>();
const mem = (id: string) => {
  let m = memory.get(id);
  if (!m) memory.set(id, (m = { checkedAt: 0, verifyTries: 0, verifiedAt: 0, checking: null }));
  return m;
};
/** When this tab last checked a build (0: not yet). */
export const lastChecked = (id: string) => memory.get(id)?.checkedAt ?? 0;
/** Forget what this tab knows (tests). */
export function resetBuildMemory(): void {
  memory.clear();
  pages.clear();
}

const busyId = (id: string) => `agent-build:${id}`;
/** This tab is sending something for the build right now. */
const sendingHere = (id: string) => busyJobs().some((j) => j.id === busyId(id));

// ───────────── words ─────────────

/** "booking page", "pricing table": what the build makes, for sentences. */
export function kindLabel(target: BuildTarget, kind: string): string {
  if (target === 'seo') return (PAGE_TYPE_LABEL as Record<string, string>)[kind]?.toLowerCase() ?? 'page';
  if (target === 'email') return (EMAIL_KIND_LABEL as Record<string, string>)[kind]?.toLowerCase() ?? 'email';
  if (target === 'leadMagnet') return LEAD_MAGNET_TYPES.find((t) => t.id === kind)?.label.toLowerCase() ?? 'lead magnet';
  return codeKindLabel(kind as never).toLowerCase();
}

/** The kinds of email Manus and Viktor design (shared/agent-targets.json), named as the server names them. */
export const EMAIL_KIND_LABEL = { welcome: 'Welcome email', nurture: 'Tip email', offer: 'Offer email', newsletter: 'Newsletter email' } as const;
export type EmailKind = keyof typeof EMAIL_KIND_LABEL;
/** The kind that suits an email of the sequence: the first welcomes, the last offers, the rest teach. */
export const emailKindFor = (index: number, total: number): EmailKind => (index <= 0 ? 'welcome' : index >= total - 1 ? 'offer' : 'nurture');
/** Where a build's page goes: Studio › Code & assets, Marketing › SEO page, or Email (its sequence or lead magnet). */
export function openBuildPage(target: BuildTarget): Promise<boolean> {
  if (target === 'asset') return openPage('studio', 'code');
  if (target === 'seo') return openPage('marketing-seo');
  return openPage('marketing-email', target === 'email' ? 'sequence' : 'magnet');
}

/** "a booking page", "an interactive calculator". */
export const kindNoun = (target: BuildTarget, kind: string) => {
  const k = kindLabel(target, kind);
  return `${/^[aeiou]/.test(k) ? 'an' : 'a'} ${k}`;
};

const sentence = (s: string) => {
  const t = s.trim().replace(/[.\s]+$/, '');
  return t ? `${t}.` : '';
};
const cut = (s: string, max: number) => {
  const t = s.replace(/\s+\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
/** Where the build is in the agent's own app. */
export const agentLink = (b: AgentBuild) => (b.via === 'manus' ? b.taskUrl : b.permalink) || '';
const serviceName = (via: AgentId) => (via === 'manus' ? 'Manus' : 'Slack');
const imagesToSave = (images: PromptImage[]) =>
  images.map((i) => {
    const { thumb: _thumb, ...media } = i.media;
    return { ...i, media };
  });
const notes = (images: PromptImage[]): ImageNote[] => images.map((i) => ({ key: i.key, note: (i.note ?? '').trim() }));

/** A toast and a bell notice when a build is done: built (Open goes to its page) or couldn't be built. */
function announce(projectId: string, b: AgentBuild): void {
  const name = agentName(b.via);
  const what = kindLabel(b.target, b.kind);
  const route = b.target === 'asset' ? 'studio' : b.target === 'seo' ? 'marketing-seo' : 'marketing-email';
  const open = () => void openBuildPage(b.target);
  const p = useStore.getState().projects.find((x) => x.id === projectId);
  const brand = p?.brand.name ? ` for ${p.brand.name}` : '';
  if (b.state === 'built') {
    toast({ kind: 'ai', title: `${name} built your ${what}`, body: 'Preview it, then use it or ask for changes.', action: { label: 'Open', run: open } });
    useStore.getState().notify({ kind: 'ai', title: `${name} built your ${what}${brand}`, body: 'Preview it, then use it or ask for changes.', route });
  } else if (b.state === 'failed') {
    toast({ kind: 'error', title: `${name} couldn’t build your ${what}`, body: b.message || undefined, action: { label: 'Open', run: open } });
    useStore.getState().notify({ kind: 'ai', title: `${name} couldn’t build your ${what}${brand}`, body: b.message || '', route });
  }
}

/** Save what a read found, and announce a build that just finished (built or failed). */
function settle(projectId: string, id: string, patch: Partial<AgentBuild>): AgentBuild | undefined {
  const before = findBuild(projectId, id);
  const after = patchBuild(projectId, id, patch);
  if (before && after && before.state !== after.state && (after.state === 'built' || after.state === 'failed')) announce(projectId, after);
  return after;
}

// ───────────── starting a build ─────────────

export interface BuildInput {
  projectId: string;
  via: AgentId;
  target: BuildTarget;
  /** CodeKind (asset) or PageType (seo) */
  kind: string;
  request: string;
  website: string;
  images: PromptImage[];
  facts: BuildFact[];
  /** Manus agent profile (absent: the Settings default) */
  profile?: string;
  /** the request's Ref (the build window makes it first, so the exact message it shows is the one sent) */
  ref?: string;
  /** an email build: which email it designs */
  stepId?: string;
}

/** The request the server writes its fixed template around. */
export const buildRequestOf = (o: BuildInput): BuildRequest => ({ target: o.target, kind: o.kind, facts: o.facts, website: o.website, request: o.request.trim(), images: notes(o.images) });

export type StartOutcome =
  | { outcome: 'sent'; build: AgentBuild }
  | { outcome: 'unknown'; build: AgentBuild }
  /** saved as failed (the card says why; Try again reopens the window) */
  | { outcome: 'failed'; build: AgentBuild; error: { title: string; body: string; settings: boolean } }
  /** refused before anything went out, with nothing saved: the window stays open (too long) */
  | { outcome: 'refused'; error: { title: string; body: string; settings: boolean } };

/**
 * Send a build request (after the owner's confirm in the window): the images first, then the request, once. An
 * uncertain send is checked by reading, by itself; it's never sent again without the owner.
 */
export async function startBuild(o: BuildInput): Promise<StartOutcome> {
  const now = Date.now();
  const build: AgentBuild = {
    id: uid('build'),
    via: o.via,
    target: o.target,
    kind: o.kind,
    request: o.request.trim(),
    website: o.website,
    images: imagesToSave(o.images),
    state: 'sending',
    requestedAt: now,
    lastSentAt: now,
    ref: o.ref ?? newRef(),
    rounds: 1,
    ...(o.stepId ? { stepId: o.stepId } : {}),
    ...(o.via === 'manus' && o.profile ? { profile: o.profile } : {}),
  };
  addBuild(o.projectId, build);
  const id = build.id;
  const name = agentName(o.via);
  beginBusy(busyId(id), `Sending to ${name}`, 'app');
  try {
    let files;
    try {
      files = await sendImages(o.via, o.images);
    } catch (e) {
      const error = agentErrorText(e, o.via);
      const why = e instanceof AgentError && e.code === 'NOT_SENT' ? sentence(e.message) : sentence(error.body);
      const b = patchBuild(o.projectId, id, { state: 'failed', message: `${why} Nothing was sent.` })!;
      return { outcome: 'failed', build: b, error };
    }
    const req = buildRequestOf(o);
    try {
      if (o.via === 'manus') {
        const r = await manusStart({ fn: 'build', build: req, files, ref: build.ref, ...(o.profile ? { profile: o.profile } : {}) });
        return { outcome: 'sent', build: patchBuild(o.projectId, id, { state: 'working', taskId: r.taskId, taskUrl: r.taskUrl, message: undefined })! };
      }
      const r = await viktorSend({ kind: 'build', build: req, files, ref: build.ref });
      return { outcome: 'sent', build: patchBuild(o.projectId, id, { state: 'working', threadId: r.threadId, permalink: r.permalink, message: undefined })! };
    } catch (e) {
      const error = agentErrorText(e, o.via);
      if (e instanceof AgentError && e.code === 'SEND_UNKNOWN') {
        const b = patchBuild(o.projectId, id, { state: 'unknown_start', message: `May have been delivered. Checking ${serviceName(o.via)}…` })!;
        mem(id).verifyTries = 0;
        void verifySend(o.projectId, id);
        return { outcome: 'unknown', build: b };
      }
      if (e instanceof AgentError && e.code === 'TOO_LONG') {
        removeBuild(o.projectId, id);
        return { outcome: 'refused', error };
      }
      const b = patchBuild(o.projectId, id, { state: 'failed', message: error.body })!;
      return { outcome: 'failed', build: b, error };
    }
  } finally {
    endBusy(busyId(id));
  }
}

// ───────────── an uncertain send ─────────────

/** Manus: whether our latest message is in the task (a message from us sent since the request went). */
const manusHasOurMessage = (r: ManusRead, sentAt: number) => r.events.some((e) => e.type === 'user' && e.at >= sentAt - 15_000);

/**
 * Settle a send that may have been delivered, by reading (never by sending again): found → working; not found
 * after two checks about 30 s apart → a first request failed ("Not delivered"), a follow-up waits for the owner.
 */
export async function verifySend(projectId: string, id: string, o: { now?: number } = {}): Promise<AgentBuild | undefined> {
  const b = findBuild(projectId, id);
  if (!b || b.state !== 'unknown_start') return b;
  const m = mem(id);
  const now = o.now ?? Date.now();
  if (m.verifyTries > 0 && now - m.verifiedAt < VERIFY_GAP - 2_000) return b;
  m.verifyTries++;
  m.verifiedAt = now;
  m.checkedAt = now;
  let found = false;
  let patch: Partial<AgentBuild> = {};
  try {
    if (b.via === 'manus') {
      if (b.rounds > 1 && b.taskId) found = manusHasOurMessage(await manusRead(b.taskId), b.lastSentAt);
      else {
        const r = await manusVerify(b.ref, b.lastSentAt);
        if (r) {
          found = true;
          patch = { taskId: r.taskId, taskUrl: r.taskUrl };
        }
      }
    } else {
      const r = await viktorVerify({ ref: b.ref, sentAt: b.lastSentAt, ...(b.rounds > 1 && b.threadId ? { threadId: b.threadId } : {}) });
      if (r) {
        found = true;
        patch = b.rounds > 1 ? {} : { threadId: r.threadId, permalink: r.permalink };
      }
    }
  } catch {
    // a read that failed tells nothing: try again later (it doesn't count as a check)
    m.verifyTries--;
    return findBuild(projectId, id);
  }
  if (found) return patchBuild(projectId, id, { ...patch, state: 'working', message: undefined });
  if (m.verifyTries < VERIFY_TRIES) {
    setTimeout(() => void verifySend(projectId, id), VERIFY_GAP);
    return findBuild(projectId, id);
  }
  if (b.rounds > 1) return patchBuild(projectId, id, { state: 'needs_you', message: 'Not delivered: you can send it again.' });
  return settle(projectId, id, { state: 'failed', message: 'Not delivered: you can send it again.' });
}

// ───────────── reading replies ─────────────

/** The newest words of the agent after our latest request (Manus events are newest first). */
function manusSaid(r: ManusRead): string {
  for (const e of r.events) {
    if (e.type === 'user') break;
    if (e.type === 'assistant' && e.text.trim()) return cut(e.text, SAID_MAX);
  }
  return '';
}

/** What a Manus read means for the build. */
export function fromManus(r: ManusRead): Partial<AgentBuild> {
  const credits = Number.isFinite(r.credits) && r.credits > 0 ? { credits: r.credits } : {};
  const build = r.build;
  if (!build) return { state: 'working', ...credits };
  switch (build.state) {
    case 'working':
      return { state: 'working', message: r.background ? 'Manus is still finishing in the background.' : undefined, ...credits };
    case 'built':
      return build.result ? { state: 'built', result: build.result, message: undefined, ...credits } : { state: 'working', ...credits };
    case 'needs_you': {
      const w = r.waiting;
      const message = w ? (w.answerHere ? `Manus asks: ${cut(w.text, 300)}` : `Manus is waiting for you to approve something in Manus: ${cut(w.text, 300)} Approve it in Manus.`) : sentence(build.reason) || 'Manus is waiting for you.';
      return { state: 'needs_you', message, said: manusSaid(r) || undefined, ...credits };
    }
    case 'no_file':
      return { state: 'needs_you', message: sentence(build.reason) || 'Manus finished without page.html.', said: manusSaid(r) || undefined, ...credits };
    case 'failed':
      return { state: 'failed', message: sentence(build.reason) || 'Manus couldn’t build it.', ...credits };
    default:
      return { state: 'working', ...credits };
  }
}

const tsMs = (ts: string | null | undefined) => (ts ? Math.round(Number(ts) * 1000) || 0 : 0);
const tsAfter = (a: string, b: string | null) => !b || Number(a) > Number(b);

/** What a read of the thread with Viktor means for the build. */
export function fromViktor(t: ViktorRead, now = Date.now()): Partial<AgentBuild> {
  const fromViktorAfter = t.messages.filter((m) => m.from === 'viktor' && !m.deleted && tsAfter(m.ts, t.sinceTs));
  const newest = fromViktorAfter[fromViktorAfter.length - 1];
  const said = newest?.text.trim() ? cut(newest.text, SAID_MAX) : undefined;
  switch (t.state) {
    case 'built':
      return t.latestHtml ? { state: 'built', result: { at: t.latestHtml.at, filename: t.latestHtml.filename, bytes: t.latestHtml.bytes, source: t.latestHtml.source }, message: undefined } : { state: 'working' };
    case 'replied':
      return { state: 'needs_you', message: 'Viktor replied without the page.', said };
    case 'partial': {
      const at = tsMs(newest?.edited || newest?.ts);
      if (at && now - at < PARTIAL_GRACE) return { state: 'working', message: undefined };
      return { state: 'needs_you', message: 'Viktor sent only part of the page.', said };
    }
    case 'link_only':
      return { state: 'needs_you', message: 'Viktor sent a link instead of the page.', said };
    case 'gone':
      return { state: 'failed', message: 'This request was deleted in Slack.' };
    case 'sent_unlocated':
    case 'waiting':
    default:
      return { state: 'working', message: undefined };
  }
}

/** A read that failed: a build Slack or Manus doesn't have any more fails; anything else is tried again later. */
function readFailed(projectId: string, b: AgentBuild, e: unknown): void {
  const code = e instanceof AgentError ? e.code : '';
  if (code === 'NOT_FOUND') settle(projectId, b.id, { state: 'failed', message: 'This build is older than 30 days, or wasn’t started by this app.' });
  else if (code === 'GONE') settle(projectId, b.id, { state: 'failed', message: `This request was deleted in ${serviceName(b.via)}.` });
}

/** A stopped build only becomes built when a page arrived meanwhile; otherwise it stays stopped. */
function applyRead(projectId: string, b: AgentBuild, patch: Partial<AgentBuild>): AgentBuild | undefined {
  if (b.state === 'stopped') return patch.state === 'built' ? settle(projectId, b.id, patch) : b;
  return settle(projectId, b.id, patch);
}

/** Check one Manus build once. */
async function checkManus(projectId: string, b: AgentBuild): Promise<void> {
  if (!b.taskId) return;
  try {
    const r = await manusRead(b.taskId);
    const now = findBuild(projectId, b.id);
    if (now) applyRead(projectId, now, fromManus(r));
  } catch (e) {
    readFailed(projectId, b, e);
  }
}

/** Check Viktor builds (any projects) with one read of up to 6 threads. */
async function checkViktor(items: { projectId: string; build: AgentBuild }[], now = Date.now()): Promise<void> {
  const withThread = items.filter((x) => x.build.threadId);
  for (let i = 0; i < withThread.length; i += 6) {
    const batch = withThread.slice(i, i + 6);
    let read: Awaited<ReturnType<typeof viktorRead>>;
    try {
      read = await viktorRead(batch.map((x) => x.build.threadId!));
    } catch {
      continue;
    }
    for (const x of batch) {
      const t = read.threads.find((th) => th.threadId === x.build.threadId);
      const b = findBuild(x.projectId, x.build.id);
      if (!b) continue;
      if (t) applyRead(x.projectId, b, fromViktor(t, now));
      else if (read.errors[x.build.threadId!]) readFailed(x.projectId, b, new AgentError(read.errors[x.build.threadId!].message, read.errors[x.build.threadId!].code));
    }
  }
}

/**
 * Check builds once (the cards, the watcher, Check now): an uncertain send is verified; a "sending" one this tab
 * isn't sending any more becomes uncertain ("the app closed while sending"); the others are read (Viktor's together).
 */
export async function checkBuilds(items: { projectId: string; id: string }[], o: { now?: number } = {}): Promise<void> {
  const now = o.now ?? Date.now();
  const viktor: { projectId: string; build: AgentBuild }[] = [];
  const jobs: Promise<unknown>[] = [];
  for (const it of items) {
    const b = findBuild(it.projectId, it.id);
    if (!b) continue;
    const m = mem(b.id);
    if (b.state === 'sending') {
      if (sendingHere(b.id) || now - b.lastSentAt < STALE_SENDING) continue;
      patchBuild(it.projectId, b.id, { state: 'unknown_start', message: `The app closed while sending. Checking ${serviceName(b.via)}…` });
      m.verifyTries = 0;
      jobs.push(verifySend(it.projectId, b.id, { now }));
      continue;
    }
    if (b.state === 'unknown_start') {
      jobs.push(verifySend(it.projectId, b.id, { now }));
      continue;
    }
    m.checkedAt = now;
    if (b.via === 'manus') jobs.push(checkManus(it.projectId, b));
    else viktor.push({ projectId: it.projectId, build: b });
  }
  if (viktor.length) jobs.push(checkViktor(viktor, now));
  await Promise.all(jobs);
}

/** "Check now" on a card: one check, saying what it found when nothing changed. */
export async function checkNow(projectId: string, id: string): Promise<void> {
  const before = findBuild(projectId, id);
  if (!before) return;
  if (before.state === 'unknown_start') mem(id).verifiedAt = 0;
  await checkBuilds([{ projectId, id }]);
  const after = findBuild(projectId, id);
  if (after && after.state === before.state && (after.state === 'working' || after.state === 'unknown_start')) {
    toast({ kind: 'info', title: after.state === 'working' ? `${agentName(after.via)} is still working` : `Still checking ${serviceName(after.via)}`, body: 'The app keeps checking by itself.' });
  }
}

/** How often a build's card checks it (null: it doesn't, the watcher does). */
export function cardCadence(b: AgentBuild, now = Date.now()): number | null {
  if (!IN_FLIGHT.has(b.state)) return null;
  const since = now - b.lastSentAt;
  if (since < FAST_FOR) return FAST_MS;
  if (since < CARD_FOR) return SLOW_MS;
  return null;
}

/** The builds the watcher looks at this tick: waiting ones, least recently checked first, at most 3. */
export function dueForWatch(now = Date.now()): { projectId: string; build: AgentBuild }[] {
  const out: { projectId: string; build: AgentBuild }[] = [];
  for (const p of useStore.getState().projects) {
    for (const b of p.agentBuilds ?? []) {
      if (!IN_FLIGHT.has(b.state)) continue;
      if (b.state === 'sending' && (sendingHere(b.id) || now - b.lastSentAt < STALE_SENDING)) continue;
      out.push({ projectId: p.id, build: b });
    }
  }
  return out.sort((a, b) => lastChecked(a.build.id) - lastChecked(b.build.id)).slice(0, WATCH_MAX);
}

/** One watcher tick: gives up on a build after 3 days, checks up to 3 others. Returns how many it looked at. */
export async function buildWatchTick(o: { hidden?: boolean; now?: number } = {}): Promise<number> {
  if (__ARTIFACT_BUILD__ || o.hidden) return 0;
  const now = o.now ?? Date.now();
  const due = dueForWatch(now);
  const check: { projectId: string; id: string }[] = [];
  for (const d of due) {
    if (now - d.build.requestedAt > GIVE_UP_AFTER && now - d.build.lastSentAt > GIVE_UP_AFTER) {
      mem(d.build.id).checkedAt = now;
      settle(d.projectId, d.build.id, { state: 'failed', message: `Stopped checking after 3 days: open it in ${serviceName(d.build.via)}.` });
      continue;
    }
    check.push({ projectId: d.projectId, id: d.build.id });
  }
  if (check.length) await checkBuilds(check, { now }).catch(() => undefined);
  return due.length;
}

/** Checks waiting builds every 45 seconds while the app is open and the tab shows (first after 5 s); nothing in the claude.ai build. */
export function useAgentBuildWatcher(): void {
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await buildWatchTick({ hidden: typeof document !== 'undefined' && document.hidden });
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(tick, WATCH_FIRST_MS);
    const t = setInterval(tick, WATCH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
}

/** While these builds' cards are on screen, check each at its card cadence (Viktor's together). */
export function useBuildPolling(projectId: string, builds: AgentBuild[]): void {
  const key = builds
    .filter((b) => IN_FLIGHT.has(b.state))
    .map((b) => `${b.id}:${b.state}:${b.lastSentAt}`)
    .join('|');
  useEffect(() => {
    if (__ARTIFACT_BUILD__ || !key) return;
    let busy = false;
    const tick = async () => {
      if (busy || (typeof document !== 'undefined' && document.hidden)) return;
      const now = Date.now();
      const due = buildsOf(projectId).filter((b) => {
        const every = cardCadence(b, now);
        return every !== null && now - lastChecked(b.id) >= every - 500;
      });
      if (!due.length) return;
      busy = true;
      try {
        await checkBuilds(
          due.map((b) => ({ projectId, id: b.id })),
          { now },
        );
      } catch {
        /* the next tick tries again */
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(tick, 1_500);
    const t = setInterval(tick, 3_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [projectId, key]);
}

// ───────────── follow-ups (paid, after a confirm) ─────────────

export type Followup = { kind: 'answer'; text: string } | { kind: 'edit'; text: string; images: PromptImage[] } | { kind: 'missing_file' };

/** The confirm before any paid follow-up: who does it and what it costs. */
export function followupConfirm(via: AgentId): { title: string; body: string; confirmLabel: string } {
  const name = agentName(via);
  return { title: `Send this to ${name}?`, body: `${agentWho(via, 'build')} ${agentCost(via)}`, confirmLabel: `Send (uses ${name} credits)` };
}

export type FollowupOutcome = { outcome: 'sent' | 'unknown' | 'cancelled' } | { outcome: 'failed' | 'refused'; error: { title: string; body: string; settings: boolean } };

/**
 * A follow-up in the build's task or thread, sent once after the owner confirms: an answer to the agent's
 * question, a change ("Ask for changes", with new images numbered after the build's), or the fixed request for
 * the page as one file. A failure that sent nothing leaves the build as it was.
 */
export async function sendFollowup(projectId: string, id: string, f: Followup, o: { confirm?: (c: { title: string; body: string; confirmLabel: string }) => Promise<boolean> } = {}): Promise<FollowupOutcome> {
  const b = findBuild(projectId, id);
  if (!b || (b.via === 'manus' ? !b.taskId : !b.threadId)) return { outcome: 'failed', error: { title: 'Not sent', body: 'This build has no task or thread to answer in.', settings: false } };
  if (!(await (o.confirm ?? confirmAction)(followupConfirm(b.via)))) return { outcome: 'cancelled' };
  if (sendingHere(id)) return { outcome: 'cancelled' };
  const ref = newRef();
  const newImages = f.kind === 'edit' ? f.images : [];
  beginBusy(busyId(id), `Sending to ${agentName(b.via)}`, 'app');
  try {
    let files;
    try {
      files = newImages.length ? await sendImages(b.via, newImages) : [];
    } catch (e) {
      return { outcome: 'failed', error: agentErrorText(e, b.via) };
    }
    const sentAt = Date.now();
    const round: Partial<AgentBuild> = { rounds: b.rounds + 1, lastSentAt: sentAt, ref, said: undefined, ...(newImages.length ? { images: [...b.images, ...imagesToSave(newImages)] } : {}) };
    try {
      if (b.via === 'manus') {
        const taskId = b.taskId!;
        if (f.kind === 'edit') await manusSend({ taskId, edit: { text: f.text.trim(), images: notes(newImages) }, files });
        else if (f.kind === 'answer') await manusSend({ taskId, answer: f.text.trim() });
        else await manusSend({ taskId, followup: 'missing_file' });
      } else {
        const threadId = b.threadId!;
        if (f.kind === 'edit') await viktorSend({ kind: 'edit', threadId, edit: { text: f.text.trim(), images: notes(newImages) }, files, ref });
        else if (f.kind === 'answer') await viktorSend({ kind: 'answer', threadId, text: f.text.trim(), ref });
        else await viktorSend({ kind: 'followup', threadId, followup: 'missing_file', ref });
      }
      patchBuild(projectId, id, { ...round, state: 'working', message: undefined });
      return { outcome: 'sent' };
    } catch (e) {
      if (e instanceof AgentError && e.code === 'SEND_UNKNOWN') {
        patchBuild(projectId, id, { ...round, state: 'unknown_start', message: `May have been delivered. Checking ${serviceName(b.via)}…` });
        mem(id).verifyTries = 0;
        void verifySend(projectId, id);
        return { outcome: 'unknown' };
      }
      return { outcome: e instanceof AgentError && e.code === 'TOO_LONG' ? 'refused' : 'failed', error: agentErrorText(e, b.via) };
    }
  } finally {
    endBusy(busyId(id));
  }
}

// ───────────── stop, dismiss ─────────────

/** Manus: Stop (after a confirm; free) stops the task. Viktor: Stop waiting only stops checking (nothing goes to Slack). */
export async function stopBuild(projectId: string, id: string, o: { confirm?: (c: { title: string; body: string; confirmLabel: string; danger?: boolean }) => Promise<boolean> } = {}): Promise<boolean> {
  const b = findBuild(projectId, id);
  if (!b) return false;
  if (b.via === 'manus') {
    const ok = await (o.confirm ?? confirmAction)({ title: 'Stop this Manus task?', body: 'Manus stops working on it. What it used so far still counts. You can check it again later, or send a change to start it again.', confirmLabel: 'Stop', danger: true });
    if (!ok) return false;
    if (b.taskId) {
      try {
        await manusStop(b.taskId);
      } catch (e) {
        toast({ kind: 'error', title: 'Couldn’t stop it', body: agentErrorText(e, 'manus').body });
        return false;
      }
    }
  }
  patchBuild(projectId, id, { state: 'stopped', message: undefined });
  return true;
}

/** Manus: "I checked: it didn't start" (after an uncertain start). */
export function markNotStarted(projectId: string, id: string): void {
  patchBuild(projectId, id, { state: 'failed', message: 'It didn’t start: you can send it again.' });
}

/** Dismiss: take the build off the list. Nothing goes to Manus or Slack. */
export function dismissBuild(projectId: string, id: string): void {
  removeBuild(projectId, id);
  memory.delete(id);
}

// ───────────── the page ─────────────

/** The newest pages fetched (by build and round), so Preview and Use this don't fetch twice. */
const pages = new Map<string, AgentHtml>();
const PAGE_CACHE = 6;

/** The build's latest page, as text (from the server; it never answers it as a page). */
export async function buildResultHtml(projectId: string, id: string): Promise<AgentHtml> {
  const b = findBuild(projectId, id);
  if (!b?.result) throw new AgentError('No page has come back yet.', 'NO_FILE');
  const key = `${b.id}|${b.result.at}`;
  const hit = pages.get(key);
  if (hit) {
    pages.delete(key);
    pages.set(key, hit);
    return hit;
  }
  const h: AgentHtml = b.via === 'manus' ? await manusHtml(b.taskId!, b.result.at) : await viktorHtml(b.threadId!, b.result.at);
  pages.set(key, h);
  while (pages.size > PAGE_CACHE) pages.delete(pages.keys().next().value!);
  return h;
}

/** The build's page as a source for the preview and the importer. */
export function buildSource(b: AgentBuild, h: AgentHtml): AgentHtmlSource {
  const url = agentLink(b);
  return { via: b.via, html: h.html, images: b.images, ...(url ? { url } : {}), buildId: b.id, kind: b.kind, request: b.request, ...(b.stepId ? { stepId: b.stepId } : {}) };
}

/** What to tell the owner when the page couldn't be had. */
export function pageErrorText(e: unknown, via: AgentId): string {
  if (e instanceof AgentError) {
    if (e.code === 'TOO_BIG') return 'The page is over 1.5 MB, too big to use. Ask for a smaller page.';
    if (e.code === 'NOT_HTML' || e.code === 'PARTIAL' || e.code === 'NO_FILE' || e.code === 'WEBDEV' || e.code === 'EXTERNAL_FILE') return `That reply isn’t a usable page: ${sentence(e.message.replace(/^[A-Z]/, (c) => c.toLowerCase()))}`;
  }
  return agentErrorText(e, via).body;
}

/** The project's builds for one target (the cards show these). */
export const targetBuilds = (projectId: string, target: BuildTarget) => buildsOf(projectId).filter((b) => b.target === target);
