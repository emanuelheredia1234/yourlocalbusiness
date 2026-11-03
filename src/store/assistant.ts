// The assistant's chat: messages per project, whether it's working, and what waits for the owner.
//
// Kept apart from the workspace store: chats stay on this device (the last 40 messages per project, in
// localStorage under a key per account, cleared at Log out: see DEVICE_PREFIXES in lib/cloud/auth.ts)
// and never go to the account or the cloud sync. Confirm cards and chat buttons hold their click
// handlers in memory only, so after a reload they show as expired.

import { create } from 'zustand';
import { safeStorage } from '@/lib/storage';
import { uid } from '@/lib/utils';
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

export type MessageRole = 'user' | 'assistant' | 'activity' | 'card' | 'error' | 'notice';
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
}

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
  setOpen: (v: boolean) => void;
}

export const useAssistant = create<AssistantState>((set) => ({
  open: false,
  key: null,
  threads: {},
  running: false,
  stage: '',
  runProjectId: null,
  setOpen: (v) => set({ open: v }),
}));

// in memory only: click handlers and the turn's Stop
const buttonHandlers = new Map<string, () => void | Promise<void>>();
/** card id → its answer (stopped: the turn ended without one) */
const cardAnswers = new Map<string, (yes: boolean, stopped?: boolean) => void>();
let controller: AbortController | null = null;

// ───────────── persistence ─────────────

function sanitize(raw: unknown): Record<string, ChatMessage[]> {
  const out: Record<string, ChatMessage[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [pid, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const msgs = list
      .filter((m): m is ChatMessage => !!m && typeof m === 'object' && typeof (m as ChatMessage).id === 'string' && typeof (m as ChatMessage).role === 'string' && typeof (m as ChatMessage).text === 'string')
      // a card nobody answered before the reload can't be answered now
      .map((m) => (m.card?.state === 'pending' ? { ...m, card: { ...m.card, state: 'expired' as const } } : m))
      .slice(-MAX_KEPT);
    if (msgs.length) out[pid] = msgs;
  }
  return out;
}

/** Read this account's chats on this device (again only when the account changed). */
export function loadChats(userId: string | null | undefined): void {
  const key = assistantStorageKey(userId);
  if (useAssistant.getState().key === key) return;
  let threads: Record<string, ChatMessage[]> = {};
  try {
    const raw = JSON.parse(safeStorage.getItem(key) || 'null') as { v?: number; threads?: unknown } | null;
    threads = sanitize(raw?.threads);
  } catch {
    threads = {};
  }
  useAssistant.setState({ key, threads });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Write the chats now (the newest MAX_THREADS projects, MAX_KEPT messages each). */
export function saveChats(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const { key, threads } = useAssistant.getState();
  if (!key) return;
  const recent = Object.entries(threads)
    .filter(([, list]) => list.length)
    .sort((a, b) => (b[1][b[1].length - 1]?.at ?? 0) - (a[1][a[1].length - 1]?.at ?? 0))
    .slice(0, MAX_THREADS);
  const kept = Object.fromEntries(recent.map(([pid, list]) => [pid, list.slice(-MAX_KEPT)]));
  try {
    if (recent.length) safeStorage.setItem(key, JSON.stringify({ v: 1, threads: kept }));
    else safeStorage.removeItem(key);
  } catch {
    /* storage full: the chat still works for this visit */
  }
}

function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveChats, 300);
}

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

/** Start a new chat for a project (its messages are forgotten). */
export function clearChat(projectId: string): void {
  for (const m of chatOf(projectId)) {
    for (const b of m.buttons ?? []) buttonHandlers.delete(b.id);
    if (m.card) cardAnswers.get(m.id)?.(false, true);
  }
  useAssistant.setState((s) => {
    const { [projectId]: _gone, ...threads } = s.threads;
    return { threads };
  });
  saveChats();
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
