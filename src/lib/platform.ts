// ───────────────────────── Host runtime bridge ─────────────────────────
// When the app runs as a claude.ai Artifact, the viewer exposes capabilities through
// `window.claude.use(name)`. Everything here degrades gracefully: outside a viewer
// (local dev, self-hosting) every capability resolves to null and the app falls back
// to its built-in engine, browser downloads and local-only storage.

import { create } from 'zustand';

export interface SampleResult {
  text: string;
  truncated: boolean;
  modelTierApplied?: string;
}
export interface SampleError {
  code: string;
  message: string;
  text?: string;
}
export interface SampleOptions {
  onText?: (u: { text: string; delta: string }) => void;
  signal?: AbortSignal;
  images?: Blob | Blob[];
  modelTier?: 'quick' | 'default' | 'complex';
  cache?: boolean | { gcTime?: number; refresh?: boolean };
}
export type SampleFn = ((input: string, opts?: SampleOptions) => Promise<SampleResult>) & {
  json: <T = unknown>(input: string, opts?: SampleOptions) => Promise<T>;
  limits: () => Promise<{ maxPromptBytes: number; images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] } }>;
};

export interface DownloadsNs {
  save: (req: { filename: string; data: string | Blob | ArrayBuffer }) => Promise<{ status: 'saved' | 'delivered' }>;
}

// Minimal structural types for the db + user capabilities (see artifact runtime contract).
export interface DbDocSnap {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
export interface DbQuerySnap {
  docs: DbDocSnap[];
  size: number;
}
export interface DbDocRef {
  id: string;
  get(): Promise<DbDocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  onSnapshot(next: (s: DbDocSnap) => void, err?: (e: { code: string }) => void): () => void;
}
export interface DbCollectionRef {
  doc(id?: string): DbDocRef;
  get(): Promise<DbQuerySnap>;
  onSnapshot(next: (s: DbQuerySnap) => void, err?: (e: { code: string }) => void): () => void;
}
export interface DbNs {
  doc(path: string): DbDocRef;
  collection(path: string): DbCollectionRef;
}
export interface UserNs {
  id(): Promise<string | null>;
  isOwner(): Promise<boolean>;
  can(name: string): Promise<boolean | null>;
}
// The viewer's claude.ai connectors (`mcp` capability), e.g. Zapier.
export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  payload?: unknown;
}
export interface McpNs {
  callTool(server: string, tool: string, input?: unknown, options?: { cache?: false; signal?: AbortSignal }): Promise<McpCallResult>;
  listTools(server?: string): Promise<{ servers: { server: string; authStatus: string; tools: { name: string }[] }[]; fileArgs?: boolean }>;
}

declare global {
  interface Window {
    claude?: { use: (name: string) => Promise<unknown> };
  }
  // injected by vite.config.ts
  const __ARTIFACT_BUILD__: boolean;
}

const cache = new Map<string, Promise<unknown>>();

function use<T>(name: string): Promise<T | null> {
  if (cache.has(name)) return cache.get(name) as Promise<T | null>;
  let p: Promise<T | null>;
  const host = typeof window !== 'undefined' ? window.claude : undefined;
  if (!host || typeof host.use !== 'function') {
    p = Promise.resolve(null);
  } else {
    p = new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 12_000);
      Promise.resolve()
        .then(() => host.use(name))
        .then((ns) => {
          clearTimeout(timer);
          resolve((ns as T) ?? null);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(null);
        });
    });
  }
  cache.set(name, p);
  return p;
}

export const getSample = () => use<SampleFn>('sample');
export const getDownloads = () => use<DownloadsNs>('downloads');
export const getDb = () => use<DbNs>('db');
export const getUser = () => use<UserNs>('user');
export const getMcp = () => use<McpNs>('mcp');

// ───────────── Runtime status (reactive) ─────────────
export type ClaudeStatus = 'checking' | 'available' | 'unavailable' | 'declined' | 'limited';

/** One key on your server (server/ai-server.mjs), as /api/health reports it. */
export interface AIServerProvider {
  id: string;
  label: string;
  /** switched on and has a key */
  ready: boolean;
  /** model per kind (text, image, video, agent) */
  models: Record<string, string>;
  effort: Record<string, { id: string; label: string }>;
}

/** What your own server can do: which keys are ready and which ones power each function. */
export interface AIServerState {
  /** the server answered /api/health */
  reachable: boolean;
  /** at least one key is ready */
  ready: boolean;
  providers: AIServerProvider[];
  /** function id → the keys that power it, in priority order */
  routing: Record<string, string[]>;
}

export const NO_AI_SERVER: AIServerState = { reachable: false, ready: false, providers: [], routing: {} };

/** The Zapier connector as this page sees it (for Manus images and Facebook scheduling). */
export type ZapierStatus = 'checking' | 'ready' | 'needs_reauth' | 'missing' | 'unavailable';

interface RuntimeState {
  claude: ClaudeStatus;
  claudeImages: boolean;
  server: 'unknown' | 'ok' | 'down';
  ai: AIServerState;
  zapier: ZapierStatus;
  /** the viewer can pass files to connector tools without inlining them */
  zapierFileArgs: boolean;
  community: 'checking' | 'live' | 'local';
  userId: string | null;
  set: (patch: Partial<Omit<RuntimeState, 'set'>>) => void;
}

export const useRuntime = create<RuntimeState>((set) => ({
  claude: 'checking',
  claudeImages: false,
  server: 'unknown',
  ai: NO_AI_SERVER,
  zapier: 'checking',
  zapierFileArgs: false,
  community: 'checking',
  userId: null,
  set: (patch) => set(patch),
}));

let initialized = false;
export function initRuntime(): void {
  if (initialized) return;
  initialized = true;
  getSample().then(async (sample) => {
    if (!sample) {
      useRuntime.getState().set({ claude: 'unavailable' });
      return;
    }
    let images = false;
    try {
      const lim = await sample.limits();
      images = !!lim?.images;
    } catch {
      images = false;
    }
    useRuntime.getState().set({ claude: 'available', claudeImages: images });
  });
  getMcp().then(async (mcp) => {
    if (!mcp) {
      useRuntime.getState().set({ zapier: 'unavailable' });
      return;
    }
    try {
      // listing never asks the viewer anything; a connector not yet allowed lists as "unknown"
      const all = await mcp.listTools();
      const z = all.servers.find((x) => x.server === 'Zapier');
      useRuntime.getState().set({ zapier: !z ? 'missing' : z.authStatus === 'needs_reauth' ? 'needs_reauth' : 'ready', zapierFileArgs: all.fileArgs === true });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      useRuntime.getState().set({ zapier: code === 'needs_reauth' ? 'needs_reauth' : code === 'server_not_connected' ? 'missing' : 'unavailable' });
    }
  });
  getUser().then(async (user) => {
    if (!user) return;
    try {
      const id = await user.id();
      useRuntime.getState().set({ userId: id });
    } catch {
      /* no identity */
    }
  });
}

// ───────────── Files out ─────────────
export type SaveOutcome = 'saved' | 'declined' | 'unavailable' | 'busy' | 'error';

const MIME: Record<string, string> = {
  html: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
};

/** Offer a generated file to the viewer. Uses the host's download capability when framed. */
export async function saveFile(filename: string, data: string | Blob): Promise<SaveOutcome> {
  const downloads = await getDownloads();
  if (downloads) {
    try {
      await downloads.save({ filename, data });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'declined') return 'declined';
      if (code === 'rate_limited') return 'busy';
      if (code === 'unavailable' || code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') return 'unavailable';
      return 'error';
    }
  }
  if (typeof window !== 'undefined' && window.claude) {
    // Framed by a host without the downloads capability: plain links are inert there.
    return 'unavailable';
  }
  try {
    const ext = filename.split('.').pop() || 'txt';
    const blob = typeof data === 'string' ? new Blob([data], { type: MIME[ext] || 'text/plain' }) : data;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'saved';
  } catch {
    return 'error';
  }
}

/** Copy text. Call from inside a click handler. Falls back to a hidden textarea + execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
