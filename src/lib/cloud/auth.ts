// Accounts: sign-up, sign-in, password reset and sign-out with Supabase Auth, and opening each
// user's own workspace (their saved data and files) on this device.
//
// The server says whether accounts are on (GET /api/config). Without Supabase settings the app
// works as before, keeping everything in this browser.

import { create } from 'zustand';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { deleteMediaDatabase, readBrowserMedia, putBlob, safeStorage, setMediaAccount } from '@/lib/storage';
import { initial, starterSkills, useStore, type StoreState } from '@/store/useStore';
import { defaultSettings } from '@/store/defaults';
import { cleanWorkspace } from '@/store/cleanup';
import { stopTurn } from '@/store/assistant';
import { createSync, supabaseBackend, useSyncStatus, type Sync } from './sync';
import { createMediaSync, type MediaSync } from './media';

export interface AccountsConfig {
  enabled: boolean;
  url: string;
  publishableKey: string;
  signInRequired: boolean;
  canDeleteAccount: boolean;
}

export type AuthPhase =
  | 'loading' // finding out whether accounts are on
  | 'off' // no accounts: everything stays in this browser
  | 'signed-out'
  | 'recovery' // came from a password reset link: choose a new password
  | 'opening' // loading the account's workspace
  | 'import' // a new account, and this browser has a workspace from before accounts
  | 'ready'
  | 'guest' // accounts are on but optional, and this person carried on without one
  | 'failed' // couldn't load the workspace
  | 'elsewhere' // this account is open in another tab of this browser
  | 'leaving'; // signing out

export interface Notice {
  kind: 'info' | 'error';
  text: string;
}

interface AuthState {
  phase: AuthPhase;
  config: AccountsConfig | null;
  user: { id: string; email: string } | null;
  notice: Notice | null;
  error: string | null;
  set: (p: Partial<AuthState>) => void;
}

export const useAuth = create<AuthState>((set) => ({ phase: 'loading', config: null, user: null, notice: null, error: null, set: (p) => set(p) }));

const CONFIG_KEY = 'ylb-accounts-config';
const LEGACY_KEY = 'yourlocalbusiness-state';
const DISCARD_KEY = 'ylb-signed-out';
/** this device's copy of an account's workspace */
const stateKey = (userId: string) => `${LEGACY_KEY}:${userId}`;
/** per-device keys that point at a user's posts and jobs */
const DEVICE_KEYS = ['ylb-manus-pending', 'ylb-video-pending', 'ylb-fb-page', 'ylb-admin-token'];
/** per-device keys by prefix (the accounts Manus last posted as, per project and network; the assistant's chats, per account) */
const DEVICE_PREFIXES = ['ylb-post-account:', 'ylb-assistant:'];

/** Remove this device's keys that point at an account's posts and jobs, and its assistant chats (at Log out). */
export function clearDeviceKeys(): void {
  for (const k of DEVICE_KEYS) safeStorage.removeItem(k);
  try {
    for (const k of Object.keys(localStorage)) if (DEVICE_PREFIXES.some((p) => k.startsWith(p))) safeStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
}

let client: SupabaseClient | null = null;
let sync: Sync | null = null;

/** The signed-in account's Supabase client, for the shared Marketplace (null when signed out). */
export function marketAccess(): { client: SupabaseClient; userId: string } | null {
  const st = useAuth.getState();
  return client && st.phase === 'ready' && st.user ? { client, userId: st.user.id } : null;
}
let media: MediaSync | null = null;

/** Prevent a session token from being sent to an unrelated server URL. */
export function isSameOriginAuthTarget(target: string, appOrigin: string): boolean {
  try {
    return new URL(target, appOrigin).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/** http(s) origin of an absolute address, or null (relative, protocol-relative, malformed or other schemes). */
function httpOrigin(url: string): string | null {
  try {
    if (!/^https?:\/\//i.test(url)) return null;
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Where the sign-in token may go: the app's own server, or a separate server this account chose on
 * this device (Settings › AI keys › Test connection). Never just what's in the server address field: a
 * half-typed host or an address from an imported backup must not receive it.
 */
export function tokenAllowed(target: string, appOrigin: string, trustedOrigin: string | null): boolean {
  if (isSameOriginAuthTarget(target, appOrigin)) return true;
  return !!trustedOrigin && httpOrigin(target) === trustedOrigin;
}

const trustedServerKey = (userId: string) => `ylb-trusted-server:${userId}`;

/** The signed-in person chose this server: their sign-in may be sent there (until they log out). */
export function trustServer(url: string): boolean {
  const userId = useAuth.getState().user?.id;
  const origin = httpOrigin(url);
  if (!userId || !origin) return false;
  safeStorage.setItem(trustedServerKey(userId), origin);
  return true;
}

function mayCarryToken(target: string): boolean {
  if (typeof location === 'undefined') return false;
  const userId = useAuth.getState().user?.id;
  return tokenAllowed(target, location.origin, userId ? safeStorage.getItem(trustedServerKey(userId)) : null);
}

/**
 * Headers that tell your server who's asking: the request's full address is required, so the token
 * only ever goes to your own server (empty when signed out, accounts are off, or it's elsewhere).
 */
export async function authHeaders(target: string): Promise<Record<string, string>> {
  if (!client || !target || !mayCarryToken(target)) return {};
  try {
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * A short-lived private link to one of the signed-in person's own stored files (their media folder),
 * for the server to fetch it directly; null when signed out or the file isn't in the account.
 */
export async function signedFileUrl(id: string, seconds = 600): Promise<string | null> {
  const userId = useAuth.getState().user?.id;
  if (!client || !userId || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  // a file saved moments ago may still be on its way up (only this file is waited for)
  if (media && !(await media.settleFile(id, 120_000))) return null;
  const { data, error } = await client.storage.from('media').createSignedUrl(`${userId}/${id}`, seconds);
  return error || !data?.signedUrl ? null : data.signedUrl;
}

// ───────────── start-up ─────────────

async function loadConfig(): Promise<AccountsConfig | null> {
  if (__ARTIFACT_BUILD__ || typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return null;
  const base = serverBaseNow();
  try {
    const res = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const c = ((await res.json().catch(() => null)) as { accounts?: AccountsConfig } | null)?.accounts;
      if (c && typeof c === 'object') {
        safeStorage.setItem(CONFIG_KEY, JSON.stringify(c));
        return c.enabled && c.url && c.publishableKey ? c : null;
      }
    }
    if (res.status === 404) {
      safeStorage.removeItem(CONFIG_KEY);
      return null;
    }
  } catch {
    /* server unreachable: use what it said last time */
  }
  try {
    const c = JSON.parse(safeStorage.getItem(CONFIG_KEY) || 'null') as AccountsConfig | null;
    return c?.enabled && c.url && c.publishableKey ? c : null;
  } catch {
    return null;
  }
}

/** Error Supabase put in the address after a link that didn't work (expired, already used). */
function linkError(): string | null {
  const read = (s: string) => new URLSearchParams(s.replace(/^[?#]/, ''));
  const q = read(location.search);
  const h = /(^#|&)error(_code|_description)?=/.test(location.hash) ? read(location.hash) : null;
  const code = q.get('error_code') ?? h?.get('error_code');
  const desc = q.get('error_description') ?? h?.get('error_description') ?? code ?? q.get('error') ?? h?.get('error');
  if (!desc) return null;
  // tidy the address
  history.replaceState(null, '', location.pathname);
  return /expired|invalid/i.test(`${desc} ${code ?? ''}`) ? 'That link has expired or was already used. Sign in, or ask for a new link.' : desc;
}

let started = false;
const SERVER_URL_KEY = 'ylb-server-url';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The AI server's address as this device knows it (kept apart from any workspace). */
export function serverBaseNow(): string {
  return (useStore.getState().settings.ai.serverUrl || safeStorage.getItem(SERVER_URL_KEY) || '').replace(/\/+$/, '');
}

/** The session supabase-js kept on this device (to open the device's copy while offline). */
function storedUser(): User | null {
  try {
    const raw = JSON.parse(safeStorage.getItem('ylb-auth') || 'null') as { user?: User } | null;
    return raw?.user?.id ? raw.user : null;
  } catch {
    return null;
  }
}

export async function startAuth(): Promise<void> {
  if (started) return;
  started = true;
  safeStorage.removeItem(DISCARD_KEY);
  // remember a separate AI server address for this device, whichever workspace is open
  useStore.subscribe((s, prev) => {
    if (s.settings.ai.serverUrl !== prev.settings.ai.serverUrl && useAuth.getState().phase === 'ready') {
      if (s.settings.ai.serverUrl) safeStorage.setItem(SERVER_URL_KEY, s.settings.ai.serverUrl);
      else safeStorage.removeItem(SERVER_URL_KEY);
    }
  });
  const config = await loadConfig();
  const st = useAuth.getState();
  if (!config) return workLocally();
  st.set({ config });
  const lib = __ARTIFACT_BUILD__ ? null : await import('@supabase/supabase-js').catch(() => null);
  if (!lib) return workLocally();
  const badLink = linkError();
  const cameWithCode = new URLSearchParams(location.search).has('code');
  client = lib.createClient(config.url, config.publishableKey, {
    auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true, storageKey: 'ylb-auth' },
  });
  listenToOtherTabs();
  client.auth.onAuthStateChange((event, session) => {
    // Supabase asks not to call it again from inside this callback
    setTimeout(() => void onAuthEvent(event, session?.user ?? null, { badLink, cameWithCode }), 0);
  });
}

async function onAuthEvent(event: string, user: User | null, ctx: { badLink: string | null; cameWithCode: boolean }) {
  const st = useAuth.getState();
  switch (event) {
    case 'INITIAL_SESSION':
      if (user) {
        // a password-reset link announces itself separately: give it a moment
        if (ctx.cameWithCode) await sleep(500);
        if (useAuth.getState().phase !== 'recovery') await openWorkspace(user);
        return;
      }
      if (st.phase !== 'loading') return;
      // offline, with a sign-in kept on this device: open this device's copy and save when back
      if (typeof navigator !== 'undefined' && navigator.onLine === false && storedUser()) {
        await openWorkspace(storedUser()!);
        return;
      }
      st.set({
        phase: 'signed-out',
        notice: ctx.badLink
          ? { kind: 'error', text: ctx.badLink }
          : ctx.cameWithCode
            ? { kind: 'info', text: 'If you just confirmed your email, you’re all set: sign in below. (Links work in the browser you signed up in.)' }
            : null,
      });
      return;
    case 'PASSWORD_RECOVERY':
      // only the tab that opened the reset link asks for a new password; other tabs carry on
      if (ctx.cameWithCode) {
        st.set({ phase: 'recovery', user: user ? { id: user.id, email: user.email ?? '' } : null });
        sync?.dispose();
        void media?.stop();
      } else if (user) await openWorkspace(user);
      return;
    case 'SIGNED_IN':
    case 'TOKEN_REFRESHED':
      if (!user || st.phase === 'recovery') return;
      // TOKEN_REFRESHED: back online after starting offline with an expired sign-in
      if (event === 'TOKEN_REFRESHED' && !['signed-out', 'loading'].includes(st.phase)) return;
      await openWorkspace(user);
      return;
    case 'USER_UPDATED':
      if (user && st.user) st.set({ user: { id: user.id, email: user.email ?? st.user.email } });
      return;
    case 'SIGNED_OUT':
      // signed out in another tab, or the sign-in ended (password changed elsewhere)
      if (['opening', 'import', 'ready', 'failed', 'recovery', 'elsewhere'].includes(st.phase)) {
        void stopRunningWork();
        sync?.dispose();
        media?.dispose();
        location.reload();
      }
      return;
  }
}

// ───────────── one tab per account ─────────────
// Each tab keeps its own copy in memory, so two tabs saving the same account would undo each other.
// The tab that opens the workspace takes over; the others step aside until asked to take it back.

const TAB = Math.random().toString(36).slice(2);
let channel: BroadcastChannel | null = null;
const releases = new Set<() => void>();
let lastUser: User | null = null;

function listenToOtherTabs() {
  if (typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel('ylb-workspace');
  channel.onmessage = (e) => {
    const m = e.data as { type: string; userId: string; tab: string };
    if (!m || m.tab === TAB) return;
    const st = useAuth.getState();
    if (m.type === 'claim' && st.user?.id === m.userId && ['opening', 'import', 'ready'].includes(st.phase)) {
      stepAside();
      channel?.postMessage({ type: 'released', userId: m.userId, tab: TAB });
    } else if (m.type === 'released') for (const r of [...releases]) r();
  };
}

/**
 * Paid work this tab runs outside the pages (a Strategy run, the assistant's turn) stops when the tab lets
 * the workspace go: its results could no longer be saved, and the tab that has it may start the same work.
 */
async function stopRunningWork(): Promise<void> {
  stopTurn();
  // loaded when needed: the Strategy runner imports the AI client, which imports this file
  await import('@/ai/strategyJob').then((m) => m.stopAllStrategies()).catch(() => undefined);
}

/** Another tab took over: stop saving from here (what's waiting is in storage; that tab saves it), and stop what's running. */
function stepAside() {
  void stopRunningWork();
  sync?.dispose();
  media?.dispose();
  sync = null;
  media = null;
  useStore.persist.setOptions({ name: DISCARD_KEY });
  setMediaAccount(null, null);
  useAuth.getState().set({ phase: 'elsewhere' });
}

/** Ask other tabs with this account open to step aside; wait briefly for them. */
async function claimWorkspace(userId: string) {
  if (!channel) return;
  const answered = new Promise<void>((resolve) => {
    const done = () => {
      releases.delete(done);
      resolve();
    };
    releases.add(done);
    setTimeout(done, 700);
  });
  channel.postMessage({ type: 'claim', userId, tab: TAB });
  await answered;
}

/** "Use it here" after another tab took over. */
export async function takeWorkspaceHere() {
  const user = lastUser ?? (await client?.auth.getSession())?.data.session?.user ?? null;
  if (user) await openWorkspace(user, { force: true });
  else useAuth.getState().set({ phase: 'signed-out' });
}

// ───────────── the account's workspace on this device ─────────────

/** What a browser saved before accounts were turned on, if anything worth keeping. */
function browserWorkspace(): Partial<StoreState> | null {
  try {
    const raw = JSON.parse(safeStorage.getItem(LEGACY_KEY) || 'null') as { state?: Partial<StoreState> } | null;
    const s = raw?.state;
    return s && Array.isArray(s.projects) && s.projects.length ? s : null;
  } catch {
    return null;
  }
}

/** Starting point on a device that hasn't opened this account before (keeps this device's look). */
function blankWorkspace(): Partial<StoreState> {
  const now = useStore.getState().settings;
  const d = defaultSettings();
  const { version: _v, ...fresh } = initial();
  return { ...fresh, skills: [], settings: { ...d, theme: now.theme, ai: { ...d.ai, serverUrl: serverBaseNow() } } };
}

/** Set once this device has fully opened the account (its copy is then trustworthy). */
const openedKey = (userId: string) => `ylb-opened:${userId}`;

async function openWorkspace(user: User, { force = false } = {}) {
  const st = useAuth.getState();
  if (!client) return;
  // sign-in events arrive in pairs (a new sign-in, then the page's first look): open once
  if (!force && st.user?.id === user.id && ['opening', 'import', 'ready', 'leaving', 'elsewhere'].includes(st.phase)) return;
  lastUser = user;
  st.set({ phase: 'opening', user: { id: user.id, email: user.email ?? '' }, error: null, notice: null });
  sync?.dispose();
  media?.dispose();
  try {
    await claimWorkspace(user.id);
    media = createMediaSync(client, user.id);
    setMediaAccount(user.id, media);
    const key = stateKey(user.id);
    const opened = safeStorage.getItem(openedKey(user.id)) === '1' && safeStorage.getItem(key) !== null;
    useStore.persist.setOptions({ name: key });
    if (opened) await useStore.persist.rehydrate();
    else useStore.setState(blankWorkspace());
    // a device that never finished opening the account starts clean (no stray save marks)
    sync = createSync({ backend: supabaseBackend(client, user.id), userId: user.id, fresh: !opened });
    let remoteEmpty = false;
    let offline = false;
    try {
      remoteEmpty = (await sync.pull()).remoteEmpty;
    } catch (e) {
      if (!opened) throw e;
      offline = true;
    }
    if (remoteEmpty && browserWorkspace() && !safeStorage.getItem(`ylb-import-asked:${user.id}`)) {
      st.set({ phase: 'import' });
      return;
    }
    begin({ seed: remoteEmpty && !opened });
    // offline with a copy on this device: carry on and save when back
    if (offline) useSyncStatus.getState().set({ problem: 'offline', message: 'Couldn’t reach your account, so you’re working from this device’s copy. Changes are saved when you’re back online.' });
  } catch (e) {
    st.set({ phase: 'failed', error: (e as Error)?.message || 'Couldn’t load your workspace.' });
  }
}

/** No accounts: everything stays in this browser (anything an older version made up is removed first). */
function workLocally() {
  cleanWorkspace();
  useAuth.getState().set({ phase: 'off', config: null });
}

/** Start saving; a brand-new account gets the starter skills (saved like any change). */
function begin({ seed = false } = {}) {
  const st = useAuth.getState();
  sync?.start();
  media?.start();
  if (seed) useStore.setState({ skills: starterSkills() });
  // after start, so what it removes is removed from the account too
  cleanWorkspace();
  if (st.user) {
    safeStorage.setItem(openedKey(st.user.id), '1');
    const url = useStore.getState().settings.ai.serverUrl;
    if (url) safeStorage.setItem(SERVER_URL_KEY, url);
  }
  st.set({ phase: 'ready' });
}

/** Retry after the workspace failed to load. */
export async function retryOpen() {
  const st = useAuth.getState();
  const user = (await client?.auth.getSession().catch(() => null))?.data.session?.user ?? lastUser ?? storedUser();
  if (user) await openWorkspace(user, { force: true });
  else st.set({ phase: 'signed-out' });
}

/** A new account on a browser with a workspace from before accounts: bring it in, or start fresh. */
export async function answerImport(bring: boolean) {
  const st = useAuth.getState();
  if (!st.user) return;
  safeStorage.setItem(`ylb-import-asked:${st.user.id}`, '1');
  if (!bring) {
    return begin({ seed: true });
  }
  st.set({ phase: 'opening' });
  const old = browserWorkspace();
  if (old) {
    const now = useStore.getState().settings;
    const d = defaultSettings();
    const keep: Partial<StoreState> = {};
    for (const k of ['projects', 'activeProjectId', 'posts', 'ads', 'skills', 'genLog', 'myListings', 'notices'] as const) {
      if (old[k] !== undefined) (keep as Record<string, unknown>)[k] = old[k];
    }
    const os = old.settings;
    keep.settings = {
      ...now,
      ...(os ?? {}),
      ai: { ...now.ai, useBrain: os?.ai?.useBrain ?? now.ai.useBrain, serverUrl: os?.ai?.serverUrl ?? now.ai.serverUrl },
      profile: { ...d.profile, ...(os?.profile ?? {}) },
    };
    useStore.setState(keep);
    // its files move into the account's store (and up to the cloud)
    const files = await readBrowserMedia();
    for (const [id, blob] of files) await putBlob(id, blob);
    sync?.markAll();
    safeStorage.removeItem(LEGACY_KEY);
    await deleteMediaDatabase(null);
    begin();
    return;
  }
  begin({ seed: true });
}

// ───────────── forms ─────────────

const redirectTo = () => `${location.origin}${location.pathname}`;

/** Friendly words for Supabase Auth errors. */
export function authMessage(e: { code?: string; message?: string; status?: number } | null | undefined): string {
  if (!e) return '';
  switch (e.code) {
    case 'invalid_credentials':
      return 'That email and password don’t match. Check them, or reset your password.';
    case 'email_not_confirmed':
      return 'Confirm your email first: open the link we sent you. Didn’t get it? Send it again below.';
    case 'user_already_exists':
    case 'email_exists':
      return 'There’s already an account with that email. Sign in instead.';
    case 'weak_password':
      return 'Choose a stronger password: at least 8 characters, mixing letters and numbers.';
    case 'same_password':
      return 'Your new password must be different from the old one.';
    case 'over_email_send_rate_limit':
      return 'Too many emails sent just now. Wait a minute, then try again.';
    case 'over_request_rate_limit':
      return 'Too many tries. Wait a minute, then try again.';
    case 'signup_disabled':
      return 'New sign-ups are turned off for this app.';
    case 'email_address_not_authorized':
      return 'This app can’t send emails to that address yet. The app’s owner needs to set up email sending in Supabase (Authentication → Emails → SMTP).';
    case 'email_address_invalid':
    case 'validation_failed':
      return 'Enter a valid email address.';
  }
  if (!e.status || /fetch|network/i.test(e.message ?? '')) return 'Couldn’t reach the sign-in service. Check your connection and try again.';
  return e.message || 'Something went wrong. Please try again.';
}

export async function signIn(email: string, password: string): Promise<{ error?: string; code?: string }> {
  if (!client) return { error: 'Accounts aren’t available right now.' };
  const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  return error ? { error: authMessage(error), code: error.code } : {};
}

export async function signUp(email: string, password: string): Promise<{ error?: string; confirm?: boolean }> {
  if (!client) return { error: 'Accounts aren’t available right now.' };
  const { data, error } = await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirectTo() } });
  if (error) return { error: authMessage(error) };
  // with "Confirm email" on there's no session yet: they open the link first
  return { confirm: !data.session };
}

export async function resendConfirmation(email: string): Promise<{ error?: string }> {
  if (!client) return { error: 'Accounts aren’t available right now.' };
  const { error } = await client.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: redirectTo() } });
  return error ? { error: authMessage(error) } : {};
}

export async function sendPasswordReset(email: string): Promise<{ error?: string }> {
  if (!client) return { error: 'Accounts aren’t available right now.' };
  const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectTo() });
  return error ? { error: authMessage(error) } : {};
}

/** After a reset link (or from Settings › Account). */
export async function setNewPassword(password: string): Promise<{ error?: string }> {
  if (!client) return { error: 'Accounts aren’t available right now.' };
  const { data, error } = await client.auth.updateUser({ password });
  if (error) return { error: authMessage(error) };
  const st = useAuth.getState();
  if (st.phase === 'recovery' && data.user) await openWorkspace(data.user);
  return {};
}

/** Carry on without an account (only when the owner made sign-in optional). */
export function continueAsGuest() {
  const st = useAuth.getState();
  if (!st.config || st.config.signInRequired) return;
  cleanWorkspace();
  st.set({ phase: 'guest', notice: null });
}

/** From the guest app: show the sign-in screen. */
export function showSignIn() {
  useAuth.getState().set({ phase: 'signed-out', notice: null });
}

// ───────────── leaving ─────────────

/** Save what's waiting; true when the account has everything. */
export async function saveNow(timeoutMs = 10_000): Promise<boolean> {
  if (!sync) return true;
  const data = await Promise.race([sync.flush(), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
  const files = media ? await media.settle(timeoutMs) : true;
  return data && files;
}

/** Forget this account on this device: its copy of the workspace, its files and its pending jobs. */
async function forgetDevice(userId: string) {
  sync?.forget();
  await media?.stop();
  media?.forget();
  useStore.persist.setOptions({ name: DISCARD_KEY });
  safeStorage.removeItem(stateKey(userId));
  safeStorage.removeItem(openedKey(userId));
  safeStorage.removeItem(trustedServerKey(userId));
  // a tab that stepped aside may have left save marks in storage: they belong to this account too
  safeStorage.removeItem(`ylb-sync:${userId}`);
  safeStorage.removeItem(`ylb-media-sync:${userId}`);
  clearDeviceKeys();
  await deleteMediaDatabase(userId);
  setMediaAccount(null, null);
}

/** supabase-js may keep its session when signing out fails (offline, expired): remove it ourselves. */
function dropSession() {
  try {
    for (const k of Object.keys(localStorage)) if (k === 'ylb-auth' || k.startsWith('ylb-auth-')) localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
  safeStorage.removeItem('ylb-auth');
}

function reloadSignedOut() {
  history.replaceState(null, '', location.pathname);
  location.reload();
}

/**
 * Sign out on this device. Saves first; if something couldn't be saved (offline), returns
 * 'unsaved' so the caller can ask before losing it (then call again with force).
 */
export async function signOut({ force = false } = {}): Promise<'unsaved' | 'done'> {
  const st = useAuth.getState();
  if (!client || !st.user) return 'done';
  // the owner chose to leave (confirmLeave asked first when something was running): nothing new starts while it saves
  await stopRunningWork();
  if (!force && st.phase === 'ready' && !(await saveNow())) return 'unsaved';
  const userId = st.user.id;
  st.set({ phase: 'leaving' });
  await forgetDevice(userId);
  await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  dropSession();
  reloadSignedOut();
  return 'done';
}

/**
 * Delete the account, its saved workspace and its files (the server does this with the secret key). With ad
 * campaigns still switched on, the server refuses (409 ADS_LIVE, with the list) unless `ackLiveAds`: the customer
 * ticked that they'll manage them in Ads Manager (they keep spending after the account is gone).
 */
export async function deleteAccount(opts: { ackLiveAds?: boolean } = {}): Promise<{ error?: string; code?: string; live?: { id: string; name: string; platform: 'meta' | 'google'; daily: number; currency: string; idTail: string }[] }> {
  const st = useAuth.getState();
  if (!client || !st.user) return { error: 'You’re not signed in.' };
  const target = `${serverBaseNow()}/api/account${opts.ackLiveAds ? '?ackLiveAds=1' : ''}`;
  // nothing may upload into the folder while the server empties it, nor spend on the account's keys
  await stopRunningWork();
  sync?.stop();
  await media?.stop();
  const res = await fetch(target, { method: 'DELETE', headers: await authHeaders(target) }).catch(() => null);
  const body = res ? ((await res.json().catch(() => null)) as { error?: string; code?: string; live?: unknown } | null) : null;
  if (!res?.ok) {
    sync?.start();
    media?.start();
    return { error: body?.error || 'Couldn’t reach the server to delete your account. Try again.', ...(body?.code ? { code: body.code } : {}), ...(Array.isArray(body?.live) ? { live: body.live as never } : {}) };
  }
  const userId = st.user.id;
  st.set({ phase: 'leaving' });
  await forgetDevice(userId);
  await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  dropSession();
  reloadSignedOut();
  return {};
}
