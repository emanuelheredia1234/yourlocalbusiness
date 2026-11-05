// Talking to Manus and Viktor from the assistant chat (its To: switch). The owner's words go exactly as typed,
// in one Manus task or one Slack thread per project chat, and the replies come back into the chat as
// `external` messages: shown to the owner only. The assistant's model never sends anything here by itself (a
// message it drafts goes only after the owner's yes on its card) and never sees the replies (prompt.ts leaves
// them out).
//
// Sending is one-shot: nothing here sends a message twice. A send that may have been delivered is settled by a
// read (verify); sending it again is the owner's own click. Polling is driven by this tab: fast while the chat is
// open after a send (useAgentChatPolling), and every 45 seconds for chats still waiting (useAgentChatWatcher).

import { useEffect } from 'react';
import type { AgentFileRef, AgentHtml, AgentId, ChatRequest, ImageNote, ManusRead, ViktorMessage } from '@/lib/agentTypes';
import type { Project, PromptImage } from '@/lib/types';
import { webLink } from '@/lib/pageTypes';
import { isValidDomain } from '@/lib/publish';
import { imageKeyNumber } from '@/lib/promptImages';
import { beginBusy, endBusy } from '@/lib/busy';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import {
  addMessage,
  addUnread,
  agentChatOf,
  askCard,
  chatOf,
  flushChats,
  isSendingTo,
  setSendingTo,
  updateAgentChat,
  updateMessage,
  useAssistant,
  withoutThumb,
  type AgentChat,
  type ChatImage,
  type ChatMessage,
  type ManusThread,
  type ViktorThread,
} from '@/store/assistant';
import { AgentError, agentErrorText, manusFile, manusHtml, manusRead, manusSend, manusStart, manusVerify, newRef, sendImages, viktorFile, viktorHtml, viktorRead, viktorSend, viktorVerify } from './api';
import { agentCost, agentName, agentReady, agentWho } from './who';
import type { AgentHtmlSource } from './results';

/** The most characters of the owner's words in one chat message (the server refuses more). */
export const CHAT_LIMITS: Record<AgentId, number> = { manus: 6000, viktor: 3500 };
/** Images in one message. */
export const MAX_CHAT_IMAGES = 8;

/** While the chat is open: every 6 s for 2 minutes after a send, then every 15 s until 10 minutes. */
export const FAST_MS = 6_000;
export const SLOW_MS = 15_000;
export const FAST_FOR = 2 * 60_000;
export const PANEL_FOR = 10 * 60_000;
/** Otherwise the watcher: every 45 s (the first after 5 s), 3 chats a tick, not while the tab is hidden. */
export const WATCH_MS = 45_000;
export const WATCH_FIRST_MS = 5_000;
export const WATCH_MAX = 3;
/** A chat still waiting after this long stops being checked by itself. */
export const GIVE_UP_AFTER = 3 * 24 * 3_600_000;
/** Viktor may send several messages: its answer counts as complete this long after its newest one. */
export const VIKTOR_QUIET_MS = 90_000;
/** Manus says it's stopped this long after a message without the message showing in the task: stop waiting. */
export const MANUS_STILL_MS = 10 * 60_000;
/** A send that may have been delivered is checked this many times, this far apart (about a minute in all), before it counts as not delivered. */
export const VERIFY_TRIES = 3;
export const VERIFY_GAP = 30_000;
/** Reads failing this many times in a row get a notice in the chat. */
export const READ_FAILS_NOTICE = 3;

export type SendOutcome = 'sent' | 'unknown' | 'failed' | 'cancelled';

export interface AgentSend {
  /** the owner's words, sent as typed */
  text: string;
  images: PromptImage[];
  /** add the owner's website to this message */
  website: boolean;
  /** drafted by the assistant and confirmed by the owner on its card: no second card */
  drafted?: boolean;
  /** Send again: the owner confirmed this message once already */
  again?: boolean;
}

const projectOf = (projectId: string): Project | undefined => useStore.getState().projects.find((p) => p.id === projectId);
const threadOf = (a: AgentChat, via: AgentId): ManusThread | ViktorThread | undefined => (via === 'manus' ? a.manus : a.viktor);
const service = (via: AgentId) => (via === 'manus' ? 'Manus' : 'Slack');
const placeWord = (via: AgentId) => (via === 'manus' ? 'Manus task' : 'Slack thread');
const httpsOnly = (u: string | undefined) => (u && /^https:\/\/\S+$/i.test(u) ? u : undefined);

/** The owner's website as a reference for Manus or Viktor: https, a public host; '' when there's none (never a guessed one). */
export function chatWebsite(p: Project | null | undefined): string {
  const u = webLink(p?.brand.websiteUrl);
  if (!u || u.length > 300 || /[\s<>|"]/.test(u)) return '';
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !url.username && !url.password && isValidDomain(url.hostname) && !url.hostname.endsWith('.local') ? u : '';
  } catch {
    return '';
  }
}

/** The key for the next image attached in this chat: one above every number used in it (sent, or in the box). '' past img-99. */
export function nextChatImageKey(projectId: string, inBox: { key: string }[]): string {
  const top = Math.max(agentChatOf(projectId).imageMax, 0, ...inBox.map((i) => imageKeyNumber(i.key)));
  return top < 99 ? `img-${top + 1}` : '';
}

/** Every image the owner attached to messages to this agent in this project's chat, with its key: a page from the agent shows them as {{img-N}}. */
export function agentChatImages(projectId: string, via: AgentId): PromptImage[] {
  const out = new Map<string, PromptImage>();
  for (const m of chatOf(projectId)) {
    if (m.role !== 'user' || m.via !== via || m.delivery === 'failed') continue;
    for (const i of m.images ?? []) if (!out.has(i.key)) out.set(i.key, { key: i.key, media: i.media, ...(i.note ? { note: i.note } : {}) });
  }
  return [...out.values()];
}

const notesOf = (images: PromptImage[]): ImageNote[] => images.map((i) => ({ key: i.key, note: (i.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) }));
const chatImagesOf = (images: PromptImage[]): ChatImage[] => images.map((i) => ({ key: i.key, media: withoutThumb(i.media), ...(i.note?.trim() ? { note: i.note.trim() } : {}) }));

/** A first message to this agent that may have been delivered and isn't settled yet (a second one would start a second thread). */
function unsettledFirst(projectId: string, via: AgentId): ChatMessage | undefined {
  if (threadOf(agentChatOf(projectId), via)) return undefined;
  return chatOf(projectId).find((m) => m.role === 'user' && m.via === via && m.delivery === 'unknown' && !m.agentRef?.taskId && !m.agentRef?.threadId);
}

const stillThere = (projectId: string, msgId: string) => chatOf(projectId).some((m) => m.id === msgId);

function failMessage(projectId: string, msgId: string, note: string, undelivered = false) {
  updateMessage(projectId, msgId, { delivery: 'failed', deliveryNote: note, ...(undelivered ? { undelivered: true } : {}) });
}

/**
 * Text from Manus or Viktor as the chat keeps it: HTML comments taken out (whatever they hide never reaches the
 * app's own AI, should the text ever be used), and nothing else changed. It's shown as text, never as HTML.
 */
export function cleanExternalText(text: string): string {
  return String(text ?? '')
    .replace(/\x3C!--[\s\S]*?(?:--\x3E|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ───────────── sending ─────────────

/**
 * Send the owner's message to Manus or Viktor, as typed, once. The first message of a chat asks first on a card
 * (what goes, who answers, what it costs), unless the assistant drafted it and the owner already said yes on its
 * card. Images go first (a failure there sends nothing). Resolves how it went; a message that may have been
 * delivered is checked by a read, never sent again.
 */
export async function sendToAgent(projectId: string, via: AgentId, o: AgentSend): Promise<SendOutcome> {
  const name = agentName(via);
  const text = o.text.trim();
  if (!text || isSendingTo(projectId, via)) return 'cancelled';
  const ready = agentReady(via, 'chat');
  if (!ready.ready) {
    addMessage(projectId, { role: 'error', via, text: ready.text || `${name} isn’t set up yet: see Settings › AI keys.`, settings: ready.settings });
    return 'failed';
  }
  if (unsettledFirst(projectId, via)) {
    addMessage(projectId, { role: 'notice', via, text: `Your first message to ${name} may have been delivered: press Check on it first, so a second ${placeWord(via)} doesn’t start.` });
    return 'cancelled';
  }
  setSendingTo(projectId, via, true);
  try {
    const first = !threadOf(agentChatOf(projectId), via);
    if (first && !o.drafted && !o.again) {
      const { answer } = askCard(projectId, {
        title: `Start a chat with ${name}?`,
        what: `Your message goes to ${name} exactly as you typed it. ${name}’s replies come back here.`,
        who: agentWho(via, 'chat'),
        cost: agentCost(via),
        confirmLabel: `Send to ${name}`,
        quote: text,
      });
      if (!(await answer)) return 'cancelled';
    }
    const images = o.images.slice(0, MAX_CHAT_IMAGES);
    const website = o.website ? chatWebsite(projectOf(projectId)) : '';
    const ref = newRef();
    const thread = threadOf(agentChatOf(projectId), via);
    // the message remembers where it goes (a reply in this chat's task or thread, or a new one), for Check
    const agentRef = thread ? (via === 'manus' ? { taskId: (thread as ManusThread).taskId, ...(httpsOnly((thread as ManusThread).taskUrl) ? { url: (thread as ManusThread).taskUrl } : {}) } : { threadId: (thread as ViktorThread).threadId, ...(httpsOnly((thread as ViktorThread).permalink) ? { url: (thread as ViktorThread).permalink } : {}) }) : undefined;
    const msgId = addMessage(projectId, {
      role: 'user',
      via,
      text,
      delivery: 'sending',
      ref,
      ...(o.drafted ? { drafted: true } : {}),
      ...(images.length ? { images: chatImagesOf(images) } : {}),
      ...(website ? { website: true } : {}),
      ...(agentRef ? { agentRef } : {}),
    });
    // the images' numbers belong to this chat from now on
    const top = Math.max(0, ...images.map((i) => imageKeyNumber(i.key)));
    if (top) updateAgentChat(projectId, (c) => ({ ...c, imageMax: Math.max(c.imageMax, top) }));
    const busy = `agent-send:${projectId}:${via}`;
    beginBusy(busy, `Sending to ${name}`, 'app');
    try {
      return await deliver(projectId, via, msgId, { text, images, website, ref, first: !thread });
    } finally {
      endBusy(busy);
    }
  } finally {
    setSendingTo(projectId, via, false);
  }
}

async function deliver(projectId: string, via: AgentId, msgId: string, o: { text: string; images: PromptImage[]; website: string; ref: string; first: boolean }): Promise<SendOutcome> {
  let files: AgentFileRef[] = [];
  if (o.images.length) {
    try {
      files = await sendImages(via, o.images);
    } catch (e) {
      const n = e instanceof AgentError && typeof e.data.image === 'number' ? e.data.image : 0;
      failMessage(projectId, msgId, n ? `Not sent: image ${n} couldn’t be sent, so nothing was sent.` : `${agentErrorText(e, via).body} Nothing was sent.`);
      return 'failed';
    }
  }
  // New chat pressed while the images went: the message is gone, so nothing is sent
  if (!stillThere(projectId, msgId)) return 'cancelled';
  const chat: ChatRequest = { text: o.text, website: o.website, images: notesOf(o.images) };
  const now = Date.now();
  try {
    if (via === 'manus') {
      const t = agentChatOf(projectId).manus;
      if (t && !o.first) {
        await manusSend({ taskId: t.taskId, chat, files });
        if (stillThere(projectId, msgId)) {
          updateMessage(projectId, msgId, { delivery: 'sent', agentRef: { taskId: t.taskId, ...(httpsOnly(t.taskUrl) ? { url: t.taskUrl } : {}) } });
          updateAgentChat(projectId, (c) => (c.manus?.taskId === t.taskId ? { ...c, manus: { ...c.manus, pendingSince: now, awaiting: 'send', waiting: null } } : c));
        }
      } else {
        const brand = (projectOf(projectId)?.brand.name ?? '').replace(/\s+/g, ' ').trim();
        const started = await manusStart({ fn: 'agentchat', chat: { ...chat, ...(brand ? { brand } : {}) }, files, ref: o.ref });
        startedManus(projectId, msgId, started, now);
      }
    } else {
      const t = agentChatOf(projectId).viktor;
      const sent = await viktorSend({ kind: 'chat', ...(t && !o.first ? { threadId: t.threadId } : {}), chat, files, ref: o.ref });
      sentViktor(projectId, msgId, sent, now);
    }
    return 'sent';
  } catch (e) {
    return sendFailed(projectId, via, msgId, e);
  }
}

/** A new Manus task for this chat (unless New chat was pressed meanwhile). */
function startedManus(projectId: string, msgId: string, started: { taskId: string; taskUrl: string }, at: number) {
  if (!stillThere(projectId, msgId)) return;
  const url = httpsOnly(started.taskUrl) ?? '';
  updateMessage(projectId, msgId, { delivery: 'sent', deliveryNote: undefined, agentRef: { taskId: started.taskId, ...(url ? { url } : {}) } });
  updateAgentChat(projectId, (c) => ({
    ...c,
    manus: c.manus?.taskId === started.taskId ? { ...c.manus, pendingSince: at, awaiting: c.manus.awaiting ?? 'send' } : { taskId: started.taskId, taskUrl: url, startedAt: at, seen: [], pendingSince: at, awaiting: 'send' },
  }));
  // kept at once: a reload right now must not lose which task this chat has
  flushChats();
}

/** A message in this chat's thread with Viktor, or the first one of a new thread. */
function sentViktor(projectId: string, msgId: string, sent: { threadId: string; permalink: string; ts: string | null }, at: number) {
  if (!stillThere(projectId, msgId)) return;
  const permalink = httpsOnly(sent.permalink) ?? '';
  updateMessage(projectId, msgId, { delivery: 'sent', deliveryNote: undefined, agentRef: { threadId: sent.threadId, ...(sent.ts ? { ts: sent.ts } : {}), ...(permalink ? { url: permalink } : {}) } });
  updateAgentChat(projectId, (c) => ({
    ...c,
    viktor:
      c.viktor?.threadId === sent.threadId
        ? { ...c.viktor, permalink: permalink || c.viktor.permalink, pendingSince: at, lastViktorAt: undefined, seen: sent.ts ? { ...c.viktor.seen, [sent.ts]: '' } : c.viktor.seen }
        : { threadId: sent.threadId, permalink, startedAt: at, seen: sent.ts ? { [sent.ts]: '' } : {}, pendingSince: at },
  }));
  // kept at once: a reload right now must not lose which thread this chat has
  flushChats();
}

function sendFailed(projectId: string, via: AgentId, msgId: string, e: unknown): SendOutcome {
  if (e instanceof AgentError && e.code === 'SEND_UNKNOWN') {
    updateMessage(projectId, msgId, { delivery: 'unknown', deliveryNote: `May have been delivered: the connection dropped after your message left. The app is checking ${service(via)}.` });
    // a later Manus message: the chat keeps reading the task, which shows it once Manus has it
    if (via === 'manus') updateAgentChat(projectId, (c) => (c.manus && chatOf(projectId).find((m) => m.id === msgId)?.agentRef?.taskId === c.manus.taskId ? { ...c, manus: { ...c.manus, pendingSince: Date.now(), awaiting: 'send' } } : c));
    scheduleCheck(projectId, msgId, 0);
    return 'unknown';
  }
  if (e instanceof AgentError && (e.code === 'NOT_FOUND' || e.code === 'GONE')) {
    dropThread(projectId, via);
    failMessage(projectId, msgId, `Not sent: that ${placeWord(via)} is no longer available. Send it again to start a new one.`);
    return 'failed';
  }
  const t = agentErrorText(e, via);
  failMessage(projectId, msgId, t.body);
  if (t.settings) addMessage(projectId, { role: 'error', via, text: t.body, settings: true });
  return 'failed';
}

/** Forget this chat's task or thread (gone, or older than 30 days): the next message starts a new one. */
function dropThread(projectId: string, via: AgentId, id?: string) {
  let dropped = false;
  updateAgentChat(projectId, (c) => {
    const t = threadOf(c, via);
    if (!t || (id && (via === 'manus' ? (t as ManusThread).taskId : (t as ViktorThread).threadId) !== id)) return c;
    dropped = true;
    const next = { ...c };
    delete next[via];
    return next;
  });
  if (dropped) addMessage(projectId, { role: 'notice', via, text: `That ${placeWord(via)} is no longer available: your next message starts a new one.` });
}

// ───────────── messages that may have been delivered ─────────────

const verifyTries = new Map<string, number>();
const verifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** messages being checked right now */
const checking = new Set<string>();

/** Text compared the way the server cleans it (no <<< >>> runs, RESULT:/Ref: lines neutralised, spaces collapsed). */
const comparable = (s: string) =>
  String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<{3,}|>{3,}/g, '')
    .replace(/^(\s*)(RESULT|Ref)(\s*):/gim, '$1$2$3 -')
    .replace(/\s+/g, ' ')
    .trim();
const head = (s: string) => comparable(s).slice(0, 80);

function scheduleCheck(projectId: string, msgId: string, delay: number) {
  clearTimeout(verifyTimers.get(msgId));
  verifyTimers.set(
    msgId,
    setTimeout(() => {
      verifyTimers.delete(msgId);
      void checkDelivery(projectId, msgId).catch(() => {});
    }, delay),
  );
}

/**
 * A later message to this chat's Manus task, found among the owner's messages in the task: at least as many of
 * the task's messages start like it as this chat sent up to it (so a "yes" sent earlier doesn't count for a new
 * "yes"). The task's first message holds the owner's words inside the app's opening, so it counts by those.
 */
async function manusHasIt(projectId: string, m: ChatMessage, taskId: string): Promise<boolean> {
  const r = await manusRead(taskId);
  const mine = head(m.text);
  if (!mine) return false;
  const userEvents = (r.events ?? []).filter((e) => e.type === 'user');
  const inTask = userEvents.filter((e) => {
    const c = comparable(e.text);
    return c.startsWith(mine) || c.includes(`My message: MESSAGE ${mine}`);
  }).length;
  let sent = chatOf(projectId).filter((x) => x.role === 'user' && x.via === 'manus' && x.agentRef?.taskId === taskId && x.delivery !== 'failed' && x.at <= m.at);
  // only part of a long task was read: compare with as many of this chat's newest messages
  if (r.truncated) sent = sent.slice(-userEvents.length);
  const ours = sent.filter((x) => head(x.text) === mine).length;
  return ours > 0 && inTask >= ours;
}

/**
 * Settle a message that may have been delivered, by a read: Viktor's thread is searched for its Ref, a new Manus
 * task by the Ref in its title, a later Manus message among the task's messages. Found: it's sent (and a new
 * thread is this chat's). Not found after 3 checks about 30 s apart: "Not delivered", and Send again is the
 * owner's click.
 */
export async function checkDelivery(projectId: string, msgId: string): Promise<ChatMessage['delivery']> {
  const m = chatOf(projectId).find((x) => x.id === msgId);
  if (!m || m.role !== 'user' || !m.via) return undefined;
  if (m.delivery !== 'unknown' || checking.has(msgId)) return m.delivery;
  clearTimeout(verifyTimers.get(msgId));
  verifyTimers.delete(msgId);
  checking.add(msgId);
  try {
    return await settle(projectId, { ...m, via: m.via });
  } finally {
    checking.delete(msgId);
  }
}

/** True while a check of that message is running (its Check button waits). */
export const isChecking = (msgId: string) => checking.has(msgId);

async function settle(projectId: string, m: ChatMessage & { via: AgentId }): Promise<ChatMessage['delivery']> {
  const msgId = m.id;
  const via = m.via;
  let found = false;
  try {
    if (via === 'viktor') {
      const threadId = m.agentRef?.threadId;
      const hit = m.ref ? await viktorVerify({ ref: m.ref, sentAt: m.at, ...(threadId ? { threadId } : {}) }) : null;
      if (hit) {
        found = true;
        // a first message whose thread is now this chat's (unless another one started meanwhile)
        const now = agentChatOf(projectId).viktor;
        if (!threadId && now && now.threadId !== hit.threadId) updateMessage(projectId, msgId, { delivery: 'sent', deliveryNote: undefined, agentRef: { threadId: hit.threadId, ...(httpsOnly(hit.permalink) ? { url: hit.permalink } : {}) } });
        else sentViktor(projectId, msgId, hit, m.at);
      }
    } else if (!m.agentRef?.taskId) {
      const hit = m.ref ? await manusVerify(m.ref, m.at) : null;
      if (hit) {
        found = true;
        const now = agentChatOf(projectId).manus;
        if (now && now.taskId !== hit.taskId) updateMessage(projectId, msgId, { delivery: 'sent', deliveryNote: undefined, agentRef: { taskId: hit.taskId, ...(httpsOnly(hit.taskUrl) ? { url: hit.taskUrl } : {}) } });
        else startedManus(projectId, msgId, hit, m.at);
      }
    } else {
      found = await manusHasIt(projectId, m, m.agentRef.taskId);
      if (found) updateMessage(projectId, msgId, { delivery: 'sent', deliveryNote: undefined });
    }
  } catch (e) {
    if (e instanceof AgentError && (e.code === 'NOT_FOUND' || e.code === 'GONE') && m.agentRef?.taskId) {
      // the task is gone: the message can't have reached it
      verifyTries.delete(msgId);
      dropThread(projectId, 'manus', m.agentRef.taskId);
      failMessage(projectId, msgId, 'Not delivered: that Manus task is no longer available. You can send it again.', true);
      return 'failed';
    }
    // the check itself failed: try again later, it doesn't count
    if (stillThere(projectId, msgId)) scheduleCheck(projectId, msgId, VERIFY_GAP);
    return 'unknown';
  }
  if (found) {
    verifyTries.delete(msgId);
    return 'sent';
  }
  const tries = (verifyTries.get(msgId) ?? 0) + 1;
  verifyTries.set(msgId, tries);
  if (tries >= VERIFY_TRIES) {
    verifyTries.delete(msgId);
    failMessage(projectId, msgId, `Not delivered: it isn’t in ${via === 'manus' ? 'your Manus task' : 'Slack'}. You can send it again.`, true);
    return 'failed';
  }
  if (stillThere(projectId, msgId)) {
    updateMessage(projectId, msgId, { deliveryNote: `May have been delivered: not found in ${service(via)} yet. The app checks again in a moment.` });
    scheduleCheck(projectId, msgId, VERIFY_GAP);
  }
  return 'unknown';
}

/** After a reload: messages that may have been delivered are checked again by themselves (reads only). */
export function resumeDeliveryChecks(): number {
  let n = 0;
  for (const [projectId, list] of Object.entries(useAssistant.getState().threads)) {
    for (const m of list) {
      if (m.role !== 'user' || !m.via || m.delivery !== 'unknown' || verifyTimers.has(m.id)) continue;
      scheduleCheck(projectId, m.id, n++ * 2_000);
    }
  }
  return n;
}

/** Send a message that wasn't delivered again, as a new message (the owner's click). */
export function sendAgain(projectId: string, msgId: string): Promise<SendOutcome> {
  const m = chatOf(projectId).find((x) => x.id === msgId);
  if (!m || m.role !== 'user' || !m.via || m.delivery !== 'failed') return Promise.resolve('cancelled');
  const images: PromptImage[] = (m.images ?? []).map((i) => ({ key: i.key, media: i.media, ...(i.note ? { note: i.note } : {}) }));
  return sendToAgent(projectId, m.via, { text: m.text, images, website: !!m.website, drafted: m.drafted, again: true });
}

/** Answer Manus's question with one of its choices (the owner's click: no card). */
export function answerManus(projectId: string, option: string): Promise<SendOutcome> {
  return sendToAgent(projectId, 'manus', { text: option, images: [], website: false });
}

// ───────────── replies ─────────────

const polls = new Map<string, Promise<number>>();
const checked = new Map<string, number>();
const readFails = new Map<string, number>();
const pollKey = (projectId: string, via: AgentId) => `${projectId}:${via}`;

/** When this chat's task or thread was last read (this tab). */
export const lastChatCheck = (projectId: string, via: AgentId) => checked.get(pollKey(projectId, via)) ?? 0;

/** Forget the memory of reads and checks (tests). */
export function resetAgentChatMemory(): void {
  for (const t of verifyTimers.values()) clearTimeout(t);
  verifyTimers.clear();
  verifyTries.clear();
  checking.clear();
  polls.clear();
  checked.clear();
  readFails.clear();
  fileCache.clear();
}

/**
 * Read this chat's Manus task or Slack thread once and add what's new; returns how many new replies. One read
 * at a time per chat and agent; a failed read is tried again later (a notice after 3 in a row).
 */
export function pollAgentChat(projectId: string, via: AgentId): Promise<number> {
  const k = pollKey(projectId, via);
  const running = polls.get(k);
  if (running) return running;
  checked.set(k, Date.now());
  const p = (via === 'manus' ? pollManus(projectId) : pollViktor(projectId))
    .then(
      (n) => {
        readFails.delete(k);
        return n;
      },
      (e) => {
        const n = (readFails.get(k) ?? 0) + 1;
        readFails.set(k, n);
        if (n === READ_FAILS_NOTICE) addMessage(projectId, { role: 'notice', via, text: `Couldn’t check for replies from ${agentName(via)}: ${agentErrorText(e, via).body}` });
        return 0;
      },
    )
    .finally(() => polls.delete(k));
  polls.set(k, p);
  return p;
}

/** New replies while the chat isn't on screen: the unread dot, and a toast. */
function announce(projectId: string, via: AgentId, n: number) {
  if (n <= 0) return;
  const s = useAssistant.getState();
  const here = useStore.getState().activeProjectId === projectId;
  if (s.open && here) return;
  addUnread(projectId, n);
  const name = agentName(via);
  toast({
    kind: 'info',
    title: `${name} replied`,
    ...(here ? { action: { label: 'Open chat', run: () => useAssistant.getState().setOpen(true) } } : { body: `In the chat for ${projectOf(projectId)?.brand.name || 'another project'}.` }),
  });
}

const isReply = (m: Omit<ChatMessage, 'id' | 'at'>) => m.from === 'manus' || m.from === 'viktor';

async function pollManus(projectId: string): Promise<number> {
  const t0 = agentChatOf(projectId).manus;
  if (!t0) return 0;
  let r: ManusRead;
  try {
    r = await manusRead(t0.taskId, t0.lastEventId);
  } catch (e) {
    if (e instanceof AgentError && (e.code === 'NOT_FOUND' || e.code === 'GONE')) {
      dropThread(projectId, 'manus', t0.taskId);
      return 0;
    }
    throw e;
  }
  const t = agentChatOf(projectId).manus;
  // New chat, or another task, while reading
  if (!t || t.taskId !== t0.taskId) return 0;
  if (r.status === 'deleted') {
    dropThread(projectId, 'manus', t.taskId);
    return 0;
  }
  const now = Date.now();
  const url = httpsOnly(r.taskUrl) ?? t.taskUrl;
  const seen = new Set(t.seen);
  let awaiting = t.awaiting;
  let ownSeen = false;
  const added: Omit<ChatMessage, 'id' | 'at'>[] = [];
  // oldest first
  for (const e of [...(r.events ?? [])].reverse()) {
    if (!e?.id || seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.type === 'user') {
      // what the owner sent (from here or in Manus): Manus answers it next
      awaiting = 'reply';
      ownSeen = true;
      continue;
    }
    if (awaiting === 'reply') awaiting = undefined;
    const text = cleanExternalText(e.text);
    added.push({
      role: 'external',
      via: 'manus',
      from: 'manus',
      text: e.type === 'error' ? `Manus reported a problem${text ? `: ${text}` : '.'}` : text,
      ...(e.files?.length ? { files: e.files } : {}),
      ...(e.deliveryKind ? { deliveryKind: e.deliveryKind } : {}),
      ...(e.options?.length ? { options: e.options } : {}),
      agentRef: { eventId: e.id, taskId: t.taskId, ...(url ? { url } : {}) },
    });
  }

  const waiting = r.status === 'waiting' ? r.waiting : null;
  const since = t.pendingSince ?? now;
  // Manus is done answering once it has the latest message and answered it (or long after, if it never shows):
  // it waits for the owner, it hit an error, or it stopped (and isn't finishing in the background)
  const settled = !awaiting || now - since > MANUS_STILL_MS;
  const done = settled && (r.status === 'waiting' || r.status === 'error' || (r.status === 'stopped' && !r.background));
  const newWait = !!waiting && !waiting.answerHere && (!t.waiting || t.waiting.type !== waiting.type || t.waiting.text !== waiting.text);
  updateAgentChat(projectId, (c) =>
    c.manus?.taskId !== t.taskId
      ? c
      : {
          ...c,
          manus: {
            ...c.manus,
            seen: [...seen].slice(-200),
            ...(r.events?.[0]?.id ? { lastEventId: r.events[0].id } : {}),
            taskUrl: url,
            status: r.status,
            waiting,
            credits: r.credits,
            awaiting,
            pendingSince: done ? undefined : c.manus.pendingSince,
          },
        },
  );
  if (r.truncated && t.lastEventId) addMessage(projectId, { role: 'notice', via: 'manus', text: 'Some of Manus’s messages aren’t shown here: open the task in Manus to see them all.', agentRef: { taskId: t.taskId, ...(url ? { url } : {}) } });
  for (const m of added) addMessage(projectId, m);
  if (newWait && waiting) {
    // Manus's own words about what it waits for are shown as they are, in quotes (the owner reads them; the assistant never does)
    const what = cleanExternalText(waiting.text).replace(/\s+/g, ' ').slice(0, 300);
    addMessage(projectId, {
      role: 'notice',
      via: 'manus',
      text: `Manus is waiting for you to approve something in Manus${what ? `: “${what.replace(/[.\s]+$/, '')}”` : ''}. Sending a message here skips that step.`,
      agentRef: { taskId: t.taskId, ...(url ? { url } : {}) },
    });
  }
  // a later message that may have been delivered: the owner's messages in the task settle it
  if (ownSeen) {
    for (const m of chatOf(projectId)) if (m.role === 'user' && m.via === 'manus' && m.delivery === 'unknown' && m.agentRef?.taskId === t.taskId) scheduleCheck(projectId, m.id, 0);
  }
  const replies = added.filter(isReply).length;
  announce(projectId, 'manus', replies);
  return replies;
}

/** A Slack ts ("1700000000.000200") or an edit's, compared as numbers. */
const tsNum = (ts: string | null | undefined) => (ts ? Number(ts) || 0 : 0);

function viktorExternal(m: ViktorMessage, t: ViktorThread): Omit<ChatMessage, 'id' | 'at'> {
  const from = m.from === 'viktor' ? 'viktor' : m.from === 'you' ? 'you-in-slack' : 'other';
  const url = httpsOnly(t.permalink);
  return {
    role: 'external',
    via: 'viktor',
    from,
    // someone else's words never show (only that they wrote)
    text: from === 'other' ? 'Someone else wrote in this thread.' : cleanExternalText(m.text),
    ...(from !== 'other' && m.files?.length ? { files: m.files } : {}),
    ...(from !== 'other' && m.html ? { html: m.html } : {}),
    agentRef: { ts: m.ts, edited: m.edited, where: m.where, threadId: t.threadId, ...(url ? { url } : {}) },
  };
}

async function pollViktor(projectId: string): Promise<number> {
  const t0 = agentChatOf(projectId).viktor;
  if (!t0) return 0;
  const { threads, errors } = await viktorRead([t0.threadId]);
  const err = errors[t0.threadId];
  if (err) {
    if (err.code === 'NOT_FOUND' || err.code === 'GONE') {
      dropThread(projectId, 'viktor', t0.threadId);
      return 0;
    }
    throw new AgentError(err.message || 'The thread couldn’t be read.', err.code);
  }
  const read = threads.find((x) => x.threadId === t0.threadId);
  if (!read) return 0;
  if (read.state === 'gone') {
    dropThread(projectId, 'viktor', t0.threadId);
    return 0;
  }
  const t = agentChatOf(projectId).viktor;
  if (!t || t.threadId !== t0.threadId) return 0;
  const now = Date.now();
  const seen = { ...t.seen };
  const added: Omit<ChatMessage, 'id' | 'at'>[] = [];
  const chat = chatOf(projectId);
  const bubbleOf = (ts: string) => chat.find((x) => x.role === 'external' && x.via === 'viktor' && x.agentRef?.threadId === t.threadId && x.agentRef?.ts === ts);
  let viktorNews = false;
  const since = tsNum(read.sinceTs);
  // this chat's own messages end with their Ref (one the server couldn't confirm when it went is still ours)
  const ourRefs = chat.filter((u) => u.role === 'user' && u.via === 'viktor' && u.ref).map((u) => `Ref: ${u.ref}`);
  const ours = (m: ViktorMessage) => m.from === 'you' && (m.via === 'app' || ourRefs.some((r) => m.text.trimEnd().endsWith(r)));
  for (const m of read.messages ?? []) {
    if (!m?.ts) continue;
    if (ours(m)) {
      // ours, sent from this chat: it's already here, and it settles a send that may have been delivered
      seen[m.ts] ??= m.edited ?? '';
      for (const u of chat) {
        if (u.role !== 'user' || u.via !== 'viktor' || u.delivery !== 'unknown' || !u.ref || !m.text.trimEnd().endsWith(`Ref: ${u.ref}`)) continue;
        verifyTries.delete(u.id);
        clearTimeout(verifyTimers.get(u.id));
        verifyTimers.delete(u.id);
        updateMessage(projectId, u.id, { delivery: 'sent', deliveryNote: undefined, agentRef: { ...u.agentRef, threadId: t.threadId, ts: m.ts } });
      }
      continue;
    }
    const before = seen[m.ts];
    if (m.deleted) {
      const b = before !== undefined ? bubbleOf(m.ts) : undefined;
      if (b && !b.gone) updateMessage(projectId, b.id, { gone: true });
      continue;
    }
    const edited = m.edited ?? '';
    if (before === undefined) {
      seen[m.ts] = edited;
      added.push(viktorExternal(m, t));
      if (m.from === 'viktor' && tsNum(m.ts) > since) viktorNews = true;
    } else if (edited !== before) {
      seen[m.ts] = edited;
      const b = bubbleOf(m.ts);
      if (b) {
        const next = viktorExternal(m, t);
        updateMessage(projectId, b.id, { text: next.text, files: next.files, html: next.html, agentRef: next.agentRef, gone: false });
      }
      if (m.from === 'viktor' && tsNum(m.ts) > since) viktorNews = true;
    }
  }
  // Viktor answered our latest message, and has been quiet for 90 s since its newest one (it may send several)
  const answered = !!read.sinceTs && (read.messages ?? []).some((m) => m.from === 'viktor' && !m.deleted && tsNum(m.ts) > since);
  const lastViktorAt = viktorNews ? now : (t.lastViktorAt ?? (answered ? now : undefined));
  const done = answered && !!lastViktorAt && now - lastViktorAt >= VIKTOR_QUIET_MS;
  const permalink = httpsOnly(read.permalink);
  updateAgentChat(projectId, (c) =>
    c.viktor?.threadId !== t.threadId
      ? c
      : { ...c, viktor: { ...c.viktor, seen: Object.fromEntries(Object.entries(seen).slice(-300)), permalink: permalink || c.viktor.permalink, ...(lastViktorAt ? { lastViktorAt } : {}), pendingSince: done ? undefined : c.viktor.pendingSince } },
  );
  for (const m of added) addMessage(projectId, m);
  const replies = added.filter(isReply).length;
  announce(projectId, 'viktor', replies);
  return replies;
}

// ───────────── when to read ─────────────

/** The chats waiting for a reply, least recently read first. */
export function pendingAgentChats(): { projectId: string; via: AgentId; pendingSince: number; checkedAt: number }[] {
  const out: { projectId: string; via: AgentId; pendingSince: number; checkedAt: number }[] = [];
  for (const [projectId, a] of Object.entries(useAssistant.getState().agents)) {
    for (const via of ['manus', 'viktor'] as const) {
      const t = threadOf(a, via);
      if (t?.pendingSince) out.push({ projectId, via, pendingSince: t.pendingSince, checkedAt: lastChatCheck(projectId, via) });
    }
  }
  return out.sort((x, y) => x.checkedAt - y.checkedAt);
}

/** How often to read a waiting chat while it's open: 6 s, then 15 s, then the watcher's (null). */
export function chatCadence(pendingSince: number, now = Date.now()): number | null {
  const age = now - pendingSince;
  return age < FAST_FOR ? FAST_MS : age < PANEL_FOR ? SLOW_MS : null;
}

/** One watcher tick: up to 3 waiting chats, least recently read first; gives up on one after 3 days. */
export async function agentChatWatchTick(o: { hidden?: boolean; now?: number } = {}): Promise<number> {
  if (__ARTIFACT_BUILD__ || o.hidden) return 0;
  const now = o.now ?? Date.now();
  const due = pendingAgentChats().slice(0, WATCH_MAX);
  for (const d of due) {
    if (now - d.pendingSince > GIVE_UP_AFTER) {
      updateAgentChat(d.projectId, (c) => {
        const t = threadOf(c, d.via);
        return t ? { ...c, [d.via]: { ...t, pendingSince: undefined } } : c;
      });
      addMessage(d.projectId, { role: 'notice', via: d.via, text: `Stopped checking for ${agentName(d.via)}’s reply after 3 days: open it in ${service(d.via)}, or send another message.` });
      continue;
    }
    await pollAgentChat(d.projectId, d.via);
  }
  return due.length;
}

const hiddenNow = () => typeof document !== 'undefined' && document.hidden;

/**
 * Checks chats waiting for Manus or Viktor every 45 seconds while the app is open (first after 5 s), and once
 * settles messages that may have been delivered before a reload. Nothing in the claude.ai build.
 */
export function useAgentChatWatcher(): void {
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    let busy = false;
    let resumed = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        if (!resumed) {
          resumed = true;
          resumeDeliveryChecks();
        }
        await agentChatWatchTick({ hidden: hiddenNow() });
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

/** One tick of the open chat's fast checks: this project's waiting chats that are due. */
export async function chatPanelTick(projectId: string, now = Date.now()): Promise<void> {
  const a = agentChatOf(projectId);
  for (const via of ['manus', 'viktor'] as const) {
    const t = threadOf(a, via);
    if (!t?.pendingSince) continue;
    const every = chatCadence(t.pendingSince, now);
    if (every !== null && now - lastChatCheck(projectId, via) >= every) await pollAgentChat(projectId, via);
  }
}

/** While the chat is open: its waiting chats are read every 6 s for 2 minutes after a send, then every 15 s until 10 minutes. */
export function useAgentChatPolling(projectId: string | null | undefined): void {
  useEffect(() => {
    if (__ARTIFACT_BUILD__ || !projectId) return;
    const tick = () => {
      if (!hiddenNow()) void chatPanelTick(projectId);
    };
    tick();
    const t = setInterval(tick, 2_000);
    return () => clearInterval(t);
  }, [projectId]);
}

// ───────────── what Manus and Viktor sent: files and pages ─────────────

/** Replies' files, fetched from your server when shown or used, kept in memory (the 20 most recent). */
const fileCache = new Map<string, Promise<unknown>>();
const FILE_CACHE_MAX = 20;

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = fileCache.get(key) as Promise<T> | undefined;
  if (hit) {
    fileCache.delete(key);
    fileCache.set(key, hit);
    return hit;
  }
  const p = load();
  fileCache.set(key, p);
  p.catch(() => fileCache.delete(key));
  while (fileCache.size > FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value as string);
  return p;
}

/** Where a reply's file lives: its Manus task or Slack thread (null for a message without one). */
export function replySource(m: ChatMessage): { via: AgentId; id: string } | null {
  if (m.via === 'manus' && m.agentRef?.taskId) return { via: 'manus', id: m.agentRef.taskId };
  if (m.via === 'viktor' && m.agentRef?.threadId) return { via: 'viktor', id: m.agentRef.threadId };
  return null;
}

const unknownSource = () => Promise.reject(new AgentError('That message’s task or thread isn’t known any more.', 'NOT_FOUND'));

/** A file in a reply, as bytes (an image's type checked by your server). */
export function replyFile(m: ChatMessage, at: string): Promise<Blob> {
  const src = replySource(m);
  if (!src) return unknownSource();
  return cached(`file:${src.via}:${src.id}:${at}`, () => (src.via === 'manus' ? manusFile(src.id, at) : viktorFile(src.id, at)));
}

/** A page in a reply, as text (never shown as a page by your server). */
export function replyPage(m: ChatMessage, at: string): Promise<AgentHtml> {
  const src = replySource(m);
  if (!src) return unknownSource();
  return cached(`page:${src.via}:${src.id}:${at}`, () => (src.via === 'manus' ? manusHtml(src.id, at).then(({ at: _at, ...h }) => h) : viktorHtml(src.id, at)));
}

/** The owner's latest words to this agent before a reply: kept as the asset's prompt when its page is used. */
function ownerWordsBefore(projectId: string, via: AgentId, at: number): string {
  const list = chatOf(projectId);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role === 'user' && m.via === via && m.at <= at && m.delivery !== 'failed') return m.text.slice(0, 2000);
  }
  return '';
}

/**
 * A page in a reply, ready for the preview and the importer (src/ai/agents/results.ts): the page as the agent sent
 * it, every image the owner sent this agent in this chat (the page shows them as {{img-N}}), the task or thread,
 * and the owner's words before it.
 */
export async function replyPageSource(projectId: string, m: ChatMessage, at: string): Promise<AgentHtmlSource> {
  const via = m.via;
  if (!via || m.role !== 'external') throw new AgentError('That isn’t a reply from Manus or Viktor.', 'ERROR');
  const h = await replyPage(m, at);
  const url = httpsOnly(m.agentRef?.url);
  const request = ownerWordsBefore(projectId, via, m.at);
  return { via, html: h.html, images: agentChatImages(projectId, via), ...(url ? { url } : {}), ...(request ? { request } : {}) };
}

/** What this project's chat with each agent is doing, for the assistant (states only: never the agents' words). */
export function agentChatStatus(projectId: string): Record<AgentId, 'none' | 'waiting' | 'idle'> {
  const a = agentChatOf(projectId);
  const state = (t: ManusThread | ViktorThread | undefined) => (!t ? 'none' : t.pendingSince ? 'waiting' : 'idle');
  return { manus: state(a.manus), viktor: state(a.viktor) };
}
