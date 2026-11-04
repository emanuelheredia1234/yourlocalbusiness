// The assistant's chat: messages per project, whether it's working, and what waits for the owner.
//
// Kept apart from the workspace store: chats stay on this device (the last 40 messages per project, in
// localStorage under a key per account, cleared at Log out: see DEVICE_PREFIXES in lib/cloud/auth.ts)
// and never go to the account or the cloud sync. Confirm cards and chat buttons hold their click
// handlers in memory only, so after a reload they show as expired.
//
// The chat also talks to Manus and Viktor (src/ai/agents/chat.ts): per project, who the input sends to
// (To: Assistant · Manus · Viktor), this chat's one Manus task and one Slack thread, and what was already
// shown from them. Their replies are `external` messages: shown to the owner, never to the assistant's model.

import { create } from 'zustand';
import { safeStorage } from '@/lib/storage';
import { uid } from '@/lib/utils';
import type { MediaRef } from '@/lib/types';
import type { AgentFileMeta, AgentId, ManusRead } from '@/lib/agentTypes';
import type { ChatButton, ChatButtonIcon, ConfirmCardSpec } from '@/ai/assistant/registry';

export const ASSISTANT_KEY_PREFIX = 'ylb-assistant:';
/** messages kept per project */
export const MAX_KEPT = 40;
/** projects with a chat kept on this device */
const MAX_THREADS = 30;

/** Where this device keeps an account's chats ('local' without accounts). */
export function assistantStorageKey(userId: string | null | undefined): string {
  return `${ASSISTANT_KEY_PREFIX}${userId || 'local'}`;
}

/** external: a reply from Manus or Viktor (or from someone in the Slack thread): shown to the owner, never to the assistant's model */
export type MessageRole = 'user' | 'assistant' | 'activity' | 'card' | 'error' | 'notice' | 'external';
/** ok · failed · refused (not something the assistant does) · declined (the owner said no) · opened (a window waits for the owner) · cancelled (stopped) */
export type ActivityStatus = 'ok' | 'failed' | 'refused' | 'declined' | 'opened' | 'cancelled';

export interface ButtonRef {
  id: string;
  label: string;
  icon?: ChatButtonIcon;
}

export interface CardState extends ConfirmCardSpec {
  state: 'pending' | 'confirmed' | 'declined' | 'expired';
}

/** An image the owner attached to a message to Manus or Viktor: its key ({{img-N}} in a page) and its file (no thumbnail, to keep the chat small). */
export interface ChatImage {
  key: string;
  media: Omit<MediaRef, 'thumb'>;
  note?: string;
}

/** Where a message to or from Manus or Viktor is, in their service. */
export interface AgentRef {
  /** Manus: the event */
  eventId?: string;
  /** Slack: the message's ts */
  ts?: string;
  /** Slack: the edit's ts, when it was edited in Slack */
  edited?: string | null;
  where?: 'thread' | 'top';
  /** the Manus task or the Slack thread it belongs to (its files are fetched from there, by the server) */
  taskId?: string;
  threadId?: string;
  /** Open in Manus / Open in Slack */
  url?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** markdown-lite for the assistant; plain text otherwise */
  text: string;
  at: number;
  /** activity: the tool, how it went, and whether AI wrote it */
  tool?: string;
  status?: ActivityStatus;
  ai?: 'used' | 'builtin';
  buttons?: ButtonRef[];
  card?: CardState;
  /** error: offer Settings → AI */
  settings?: boolean;
  /** a message the owner sent to Manus or Viktor, a reply from one, or a notice about one */
  via?: AgentId;
  /** the owner's message to an agent: on its way, sent, may have been delivered, or not sent */
  delivery?: 'sending' | 'sent' | 'unknown' | 'failed';
  /** why it wasn't sent, or what to check */
  deliveryNote?: string;
  /** it may have been delivered, and checking found it wasn't: Send again is offered (the owner's click) */
  undelivered?: boolean;
  /** the Ref the message ends with (Viktor) or its task's title (Manus's first message): a read finds it after an uncertain send */
  ref?: string;
  /** drafted by the assistant, confirmed and sent by the owner */
  drafted?: boolean;
  /** what the owner attached */
  images?: ChatImage[];
  /** the owner added their website to this message */
  website?: boolean;
  agentRef?: AgentRef;
  /** the files in a reply (fetched from your server when shown or used; never an address) */
  files?: AgentFileMeta[];
  /** Viktor: a page in the reply (a code block or an attached .html file); complete = it has its </html> */
  html?: { at: string; source: 'code' | 'file'; bytes: number; complete: boolean } | null;
  /** Manus's display hint: opening and progress messages fold away once a result arrives */
  deliveryKind?: 'opening' | 'progress' | 'result';
  /** Manus's choices for a question */
  options?: string[];
  /** deleted in Slack */
  gone?: boolean;
  from?: 'viktor' | 'manus' | 'you-in-slack' | 'other';
}

/** Who the chat's input sends to. */
export type AgentTo = 'assistant' | AgentId;

/** This chat's Manus task. */
export interface ManusThread {
  taskId: string;
  taskUrl: string;
  startedAt: number;
  /** the last 200 event ids already shown (or skipped) */
  seen: string[];
  /** the newest event read: the next read asks only for newer ones */
  lastEventId?: string;
  /** a message went and Manus hasn't finished answering: the chat checks for replies */
  pendingSince?: number;
  /** since the latest message: waiting to see it in the task ('send'), then for Manus's answer ('reply') */
  awaiting?: 'send' | 'reply';
  status?: string;
  waiting?: ManusRead['waiting'];
  credits?: number;
  gone?: boolean;
}

/** This chat's thread with Viktor in Slack. */
export interface ViktorThread {
  threadId: string;
  permalink: string;
  startedAt: number;
  /** the ts of each message shown → its edit's ts ('' when not edited) */
  seen: Record<string, string>;
  pendingSince?: number;
  /** when Viktor's newest message came (Viktor may send several) */
  lastViktorAt?: number;
  gone?: boolean;
}

/** Talking to Manus and Viktor in one project's chat (on this device). */
export interface AgentChat {
  to: AgentTo;
  /** the highest image number (img-N) attached in this chat: a new image takes the next one */
  imageMax: number;
  manus?: ManusThread;
  viktor?: ViktorThread;
}

export const NO_AGENT_CHAT: AgentChat = { to: 'assistant', imageMax: 0 };

interface AssistantState {
  open: boolean;
  /** the storage key the threads were read from */
  key: string | null;
  threads: Record<string, ChatMessage[]>;
  running: boolean;
  /** what it's doing now ("Thinking…", "Waiting for you to confirm…") */
  stage: string;
  /** the project the running turn belongs to */
  runProjectId: string | null;
  /** per project: who the input sends to, and this chat's Manus task and Slack thread */
  agents: Record<string, AgentChat>;
  /** per project: replies from Manus or Viktor that came while its chat wasn't on screen */
  unread: Record<string, number>;
  /** `${projectId}:${agent}` while a message to that agent is on its way (one at a time) */
  sendingTo: Record<string, true>;
  setOpen: (v: boolean) => void;
  /** text handed to the chat's input from elsewhere ("Ask AI: …" in the command palette); the composer takes it once */
  draft: string | null;
  /** Open the chat with this text waiting in its input (nothing is sent: the owner presses Send). */
  openWith: (text: string) => void;
  /** The waiting draft, cleared (null when there is none). */
  takeDraft: () => string | null;
}

export const useAssistant = create<AssistantState>((set, get) => ({
  open: false,
  key: null,
  threads: {},
  running: false,
  stage: '',
  runProjectId: null,
  agents: {},
  unread: {},
  sendingTo: {},
  setOpen: (v) => set({ open: v }),
  draft: null,
  openWith: (text) => set({ open: true, draft: text }),
  takeDraft: () => {
    const d = get().draft;
    if (d !== null) set({ draft: null });
    return d;
  },
}));

// in memory only: click handlers and the turn's Stop
const buttonHandlers = new Map<string, () => void | Promise<void>>();
/** card id → its answer (stopped: the turn ended without one) */
const cardAnswers = new Map<string, (yes: boolean, stopped?: boolean) => void>();
let controller: AbortController | null = null;

// ───────────── persistence ─────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A file reference without its thumbnail (the chat keeps it small). */
export function withoutThumb(media: MediaRef | Omit<MediaRef, 'thumb'>): Omit<MediaRef, 'thumb'> {
  const { thumb: _t, ...rest } = media as MediaRef;
  return rest;
}

/** A stored message as the chat can show it now. */
function cleanMessage(m: ChatMessage): ChatMessage {
  let out = m;
  // a card nobody answered before the reload can't be answered now
  if (out.card?.state === 'pending') out = { ...out, card: { ...out.card, state: 'expired' as const } };
  // a message to Manus or Viktor still on its way when the page closed may or may not have gone
  if (out.delivery === 'sending') out = { ...out, delivery: 'unknown', deliveryNote: 'The app closed while sending, so it may have been delivered.' };
  if (Array.isArray(out.images)) out = { ...out, images: out.images.filter((i) => isObj(i) && typeof i.key === 'string' && isObj(i.media) && typeof i.media.id === 'string').map((i) => ({ ...i, media: withoutThumb(i.media) })) };
  else if (out.images !== undefined) out = { ...out, images: undefined };
  // what came with a reply, as the chat can show it (anything malformed is left out)
  if (out.files !== undefined) out = { ...out, files: Array.isArray(out.files) ? out.files.filter((f) => isObj(f) && typeof f.id === 'string' && typeof f.name === 'string' && (f.kind === 'image' || f.kind === 'html' || f.kind === 'other')) : undefined };
  if (out.html !== undefined && out.html !== null && !(isObj(out.html) && typeof out.html.at === 'string' && typeof out.html.complete === 'boolean')) out = { ...out, html: null };
  if (out.options !== undefined) out = { ...out, options: Array.isArray(out.options) ? out.options.filter((o): o is string => typeof o === 'string').slice(0, 10) : undefined };
  if (out.agentRef !== undefined && !isObj(out.agentRef)) out = { ...out, agentRef: undefined };
  return out;
}

function sanitize(raw: unknown): Record<string, ChatMessage[]> {
  const out: Record<string, ChatMessage[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [pid, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const msgs = list
      .filter((m): m is ChatMessage => !!m && typeof m === 'object' && typeof (m as ChatMessage).id === 'string' && typeof (m as ChatMessage).role === 'string' && typeof (m as ChatMessage).text === 'string')
      .map(cleanMessage)
      .slice(-MAX_KEPT);
    if (msgs.length) out[pid] = msgs;
  }
  return out;
}

const TASK_ID = /^[A-Za-z0-9_-]{6,64}$/;
const THREAD_ID = /^vk_[A-Za-z0-9_-]{22}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,8}$/;
const httpsUrl = (v: unknown) => (typeof v === 'string' && /^https:\/\/\S+$/i.test(v) ? v.slice(0, 500) : '');

function cleanManus(raw: unknown): ManusThread | undefined {
  if (!isObj(raw) || typeof raw.taskId !== 'string' || !TASK_ID.test(raw.taskId)) return undefined;
  const w = isObj(raw.waiting) ? { type: str(raw.waiting.type, 100) ?? '', text: str(raw.waiting.text, 600) ?? '', answerHere: raw.waiting.answerHere === true } : null;
  const pendingSince = num(raw.pendingSince);
  const credits = num(raw.credits);
  return {
    taskId: raw.taskId,
    taskUrl: httpsUrl(raw.taskUrl),
    startedAt: num(raw.startedAt) ?? 0,
    seen: Array.isArray(raw.seen) ? raw.seen.filter((x): x is string => typeof x === 'string').slice(-200) : [],
    ...(typeof raw.lastEventId === 'string' && raw.lastEventId ? { lastEventId: raw.lastEventId.slice(0, 128) } : {}),
    ...(pendingSince ? { pendingSince } : {}),
    ...(raw.awaiting === 'send' || raw.awaiting === 'reply' ? { awaiting: raw.awaiting } : {}),
    ...(typeof raw.status === 'string' ? { status: raw.status.slice(0, 40) } : {}),
    ...(w ? { waiting: w } : {}),
    ...(credits !== undefined ? { credits } : {}),
  };
}

function cleanViktor(raw: unknown): ViktorThread | undefined {
  if (!isObj(raw) || typeof raw.threadId !== 'string' || !THREAD_ID.test(raw.threadId)) return undefined;
  const seen: Record<string, string> = {};
  if (isObj(raw.seen)) for (const [ts, ed] of Object.entries(raw.seen).slice(-300)) if (SLACK_TS.test(ts)) seen[ts] = typeof ed === 'string' && SLACK_TS.test(ed) ? ed : '';
  const pendingSince = num(raw.pendingSince);
  const lastViktorAt = num(raw.lastViktorAt);
  return {
    threadId: raw.threadId,
    permalink: httpsUrl(raw.permalink),
    startedAt: num(raw.startedAt) ?? 0,
    seen,
    ...(pendingSince ? { pendingSince } : {}),
    ...(lastViktorAt ? { lastViktorAt } : {}),
  };
}

/** Each project's To: choice, Manus task and Slack thread, as stored (anything malformed is left out). */
export function sanitizeAgents(raw: unknown): Record<string, AgentChat> {
  const out: Record<string, AgentChat> = {};
  if (!isObj(raw)) return out;
  for (const [pid, a] of Object.entries(raw)) {
    if (!isObj(a)) continue;
    const to: AgentTo = a.to === 'manus' || a.to === 'viktor' ? a.to : 'assistant';
    const imageMax = Math.max(0, Math.min(99, Math.floor(num(a.imageMax) ?? 0)));
    const manus = cleanManus(a.manus);
    const viktor = cleanViktor(a.viktor);
    out[pid] = { to, imageMax, ...(manus ? { manus } : {}), ...(viktor ? { viktor } : {}) };
  }
  return out;
}

/** Read this account's chats on this device (again only when the account changed). */
export function loadChats(userId: string | null | undefined): void {
  const key = assistantStorageKey(userId);
  if (useAssistant.getState().key === key) return;
  let threads: Record<string, ChatMessage[]> = {};
  let agents: Record<string, AgentChat> = {};
  try {
    // v1: the messages; v2 also who each chat's input sends to, and its Manus task and Slack thread
    const raw = JSON.parse(safeStorage.getItem(key) || 'null') as { v?: number; threads?: unknown; agents?: unknown } | null;
    threads = sanitize(raw?.threads);
    agents = raw?.v === 2 ? sanitizeAgents(raw.agents) : {};
  } catch {
    threads = {};
    agents = {};
  }
  useAssistant.setState({ key, threads, agents, unread: {} });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

const worthKeeping = (a: AgentChat | undefined) => !!a && (a.to !== 'assistant' || !!a.manus || !!a.viktor);

/** Write the chats now (the newest MAX_THREADS projects, MAX_KEPT messages each, with their Manus task and Slack thread). */
export function saveChats(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const { key, threads, agents } = useAssistant.getState();
  if (!key) return;
  const recent = Object.entries(threads)
    .filter(([, list]) => list.length)
    .sort((a, b) => (b[1][b[1].length - 1]?.at ?? 0) - (a[1][a[1].length - 1]?.at ?? 0))
    .slice(0, MAX_THREADS);
  const kept = Object.fromEntries(recent.map(([pid, list]) => [pid, list.slice(-MAX_KEPT)]));
  // the kept chats' agent state first, then a To: choice in a project whose chat is still empty
  const keptAgents = Object.fromEntries(
    Object.entries(agents)
      .filter(([, a]) => worthKeeping(a))
      .sort(([a], [b]) => Number(b in kept) - Number(a in kept))
      .slice(0, MAX_THREADS),
  );
  try {
    if (recent.length || Object.keys(keptAgents).length) safeStorage.setItem(key, JSON.stringify({ v: 2, threads: kept, agents: keptAgents }));
    else safeStorage.removeItem(key);
  } catch {
    /* storage full: the chat still works for this visit */
  }
}

function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveChats, 300);
}

/** Write a save that's waiting now (the page is closing or reloading: a message just sent to Manus or Viktor must keep its thread). */
export function flushChats(): void {
  if (saveTimer) saveChats();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', flushChats);

// ───────────── messages ─────────────

export function chatOf(projectId: string | null | undefined): ChatMessage[] {
  return (projectId && useAssistant.getState().threads[projectId]) || [];
}

/** Add a message to a project's chat; returns its id. */
export function addMessage(projectId: string, msg: Omit<ChatMessage, 'id' | 'at'> & { id?: string }): string {
  const id = msg.id ?? uid('msg');
  const message: ChatMessage = { ...msg, id, at: Date.now() };
  const list = [...chatOf(projectId), message];
  useAssistant.setState((s) => ({ threads: { ...s.threads, [projectId]: [...(s.threads[projectId] ?? []), message].slice(-MAX_KEPT) } }));
  // a button or card scrolled out of the kept history can't be pressed any more
  for (const old of list.slice(0, Math.max(0, list.length - MAX_KEPT))) {
    for (const b of old.buttons ?? []) buttonHandlers.delete(b.id);
    if (old.card) cardAnswers.get(old.id)?.(false, true);
  }
  saveSoon();
  return id;
}

export function updateMessage(projectId: string, id: string, patch: Partial<ChatMessage>): void {
  useAssistant.setState((s) => {
    const list = s.threads[projectId];
    if (!list?.some((m) => m.id === id)) return s;
    return { threads: { ...s.threads, [projectId]: list.map((m) => (m.id === id ? { ...m, ...patch } : m)) } };
  });
  saveSoon();
}

/**
 * Start a new chat for a project: its messages are forgotten, and so are its Manus task and Slack thread
 * (the next message to either starts a new one). Who the input sends to stays.
 */
export function clearChat(projectId: string): void {
  for (const m of chatOf(projectId)) {
    for (const b of m.buttons ?? []) buttonHandlers.delete(b.id);
    if (m.card) cardAnswers.get(m.id)?.(false, true);
  }
  useAssistant.setState((s) => {
    const { [projectId]: _gone, ...threads } = s.threads;
    const { [projectId]: _read, ...unread } = s.unread;
    const before = s.agents[projectId];
    const agents = before ? { ...s.agents, [projectId]: { to: before.to, imageMax: 0 } } : s.agents;
    return { threads, agents, unread };
  });
  saveChats();
}

// ───────────── Manus and Viktor in the chat ─────────────

/** A project's To: choice, and its Manus task and Slack thread. */
export function agentChatOf(projectId: string | null | undefined): AgentChat {
  return (projectId && useAssistant.getState().agents[projectId]) || NO_AGENT_CHAT;
}

/** Change a project's agent chat (kept on this device with the chat); returns the new state. */
export function updateAgentChat(projectId: string, fn: (a: AgentChat) => AgentChat): AgentChat {
  let next = NO_AGENT_CHAT;
  useAssistant.setState((s) => {
    next = fn(s.agents[projectId] ?? NO_AGENT_CHAT);
    return { agents: { ...s.agents, [projectId]: next } };
  });
  saveSoon();
  return next;
}

/** Who the input sends to in this project's chat. */
export function setAgentTo(projectId: string, to: AgentTo): void {
  updateAgentChat(projectId, (a) => ({ ...a, to }));
}

/** Count replies that came while the project's chat wasn't on screen. */
export function addUnread(projectId: string, n: number): void {
  if (n <= 0) return;
  useAssistant.setState((s) => ({ unread: { ...s.unread, [projectId]: (s.unread[projectId] ?? 0) + n } }));
}

export function clearUnread(projectId: string): void {
  if (!useAssistant.getState().unread[projectId]) return;
  useAssistant.setState((s) => {
    const { [projectId]: _gone, ...unread } = s.unread;
    return { unread };
  });
}

const sendingKey = (projectId: string, via: AgentId) => `${projectId}:${via}`;

/** Whether a message to this agent is on its way from this project's chat. */
export const isSendingTo = (projectId: string, via: AgentId) => !!useAssistant.getState().sendingTo[sendingKey(projectId, via)];

export function setSendingTo(projectId: string, via: AgentId, on: boolean): void {
  const k = sendingKey(projectId, via);
  useAssistant.setState((s) => {
    if (on === !!s.sendingTo[k]) return s;
    if (on) return { sendingTo: { ...s.sendingTo, [k]: true as const } };
    const { [k]: _gone, ...rest } = s.sendingTo;
    return { sendingTo: rest };
  });
}

// ───────────── chat buttons ─────────────

/** Keep a tool's buttons' click handlers; the message stores only their labels. */
export function registerButtons(buttons: ChatButton[] | undefined): ButtonRef[] | undefined {
  if (!buttons?.length) return undefined;
  return buttons.slice(0, 6).map((b) => {
    const id = uid('btn');
    buttonHandlers.set(id, b.run);
    return { id, label: b.label, ...(b.icon ? { icon: b.icon } : {}) };
  });
}

/** Whether a button still works (not after a reload). */
export const buttonAlive = (id: string) => buttonHandlers.has(id);

export async function pressButton(id: string): Promise<void> {
  await buttonHandlers.get(id)?.();
}

// ───────────── confirm cards ─────────────

/** Show a confirm card in a project's chat and wait for the owner's answer (false on Stop or a new chat). */
export function askCard(projectId: string, spec: ConfirmCardSpec): { id: string; answer: Promise<boolean> } {
  const id = uid('card');
  const card = { ...spec, confirmLabel: spec.confirmLabel ?? 'Confirm' };
  const answer = new Promise<boolean>((resolve) => {
    cardAnswers.set(id, (yes, stopped = false) => {
      cardAnswers.delete(id);
      updateMessage(projectId, id, { card: { ...card, state: yes ? 'confirmed' : stopped ? 'expired' : 'declined' } });
      resolve(yes);
    });
  });
  addMessage(projectId, { id, role: 'card', text: spec.title, card: { ...card, state: 'pending' } });
  return { id, answer };
}

/** The owner's click on a card. */
export function answerCard(id: string, yes: boolean): void {
  cardAnswers.get(id)?.(yes);
}

export const cardWaiting = (id: string) => cardAnswers.has(id);

// ───────────── the running turn ─────────────

/** Mark a turn as running; returns its Stop signal. */
export function beginTurn(projectId: string): AbortSignal {
  controller?.abort();
  controller = new AbortController();
  useAssistant.setState({ running: true, stage: 'Thinking…', runProjectId: projectId });
  return controller.signal;
}

export function setStage(stage: string): void {
  if (useAssistant.getState().running) useAssistant.setState({ stage });
}

export function endTurn(signal: AbortSignal): void {
  // a newer turn may have started meanwhile
  if (controller && controller.signal !== signal) return;
  controller = null;
  useAssistant.setState({ running: false, stage: '', runProjectId: null });
}

/** Stop the running turn: what it's doing is cancelled, and a card waiting for the owner counts as no. */
export function stopTurn(): boolean {
  if (!controller) return false;
  controller.abort();
  for (const answer of [...cardAnswers.values()]) answer(false, true);
  return true;
}
