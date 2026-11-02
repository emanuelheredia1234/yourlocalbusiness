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

let client: SupabaseClient | null = null;
let sync: Sync | null = null;
let media: MediaSync | null = null;

/** Prevent a session token from being sent to an unrelated server URL. */
export function isSameOriginAuthTarget(target: string, appOrigin: string): boolean {
  try {
    return new URL(target, appOrigin).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/** Headers that tell this app's server who's asking (empty when signed out or cross-origin). */
export async function authHeaders(target?: string): Promise<Record<string, string>> {
  if (!client || !target || typeof location === 'undefined' || !isSameOriginAuthTarget(target, location.origin)) return {};
  try {
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

// ───────────── start-up ─────────────

async function loadConfig(): Promise<AccountsConfig | null> {
  if (__ARTIFACT_BUILD__ || typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return null;
  const base = (useStore.getState().settings.ai.serverUrl || '').replace(/\/+$/, '');
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
export async function startAuth(): Promise<void> {
  if (started) return;
  started = true;
  safeStorage.removeItem(DISCARD_KEY);
  const config = await loadConfig();
  const st = useAuth.getState();
  if (!config) return st.set({ phase: 'off', config: null });
  st.set({ config });
  const lib = __ARTIFACT_BUILD__ ? null : await import('@supabase/supabase-js').catch(() => null);
  if (!lib) return st.set({ phase: 'off', config: null });
  const badLink = linkError();
  const cameWithCode = new URLSearchParams(location.search).has('code');
  // a password-reset link: Supabase marks its sign-in code as a recovery
  const recovering = cameWithCode && /\/recovery/.test(safeStorage.getItem('ylb-auth-code-verifier') ?? '');
  client = lib.createClient(config.url, config.publishableKey, {
    auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true, storageKey: 'ylb-auth' },
  });
  client.auth.onAuthStateChange((event, session) => {
    // Supabase asks not to call it again from inside this callback
    setTimeout(() => void onAuthEvent(event, session?.user ?? null, { badLink, cameWithCode, recovering }), 0);
  });
}

async function onAuthEvent(event: string, user: User | null, ctx: { badLink: string | null; cameWithCode: boolean; recovering: boolean }) {
  const st = useAuth.getState();
  switch (event) {
    case 'INITIAL_SESSION':
      if (user) {
        if (ctx.recovering) st.set({ phase: 'recovery', user: { id: user.id, email: user.email ?? '' } });
        else if (st.phase !== 'recovery') await openWorkspace(user);
        return;
      }
      if (st.phase !== 'loading') return;
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
      st.set({ phase: 'recovery', user: user ? { id: user.id, email: user.email ?? '' } : null });
      return;
    case 'SIGNED_IN':
      if (!user || st.phase === 'recovery' || ctx.recovering) return;
      await openWorkspace(user);
      return;
    case 'USER_UPDATED':
      if (user && st.user) st.set({ user: { id: user.id, email: user.email ?? st.user.email } });
      return;
    case 'SIGNED_OUT':
      // signed out in another tab, or the sign-in ended (password changed elsewhere)
      if (['opening', 'import', 'ready', 'failed', 'recovery'].includes(st.phase)) {
        sync?.stop();
        media?.stop();
        location.reload();
      }
      return;
  }
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
  return { ...fresh, skills: [], settings: { ...d, theme: now.theme, ai: { ...d.ai, serverUrl: now.ai.serverUrl, simulateLatency: now.ai.simulateLatency } } };
}

async function openWorkspace(user: User) {
  const st = useAuth.getState();
  if (!client) return;
  // sign-in events arrive in pairs (a new sign-in, then the page's first look): open once
  if (st.user?.id === user.id && ['opening', 'import', 'ready', 'leaving'].includes(st.phase)) return;
  st.set({ phase: 'opening', user: { id: user.id, email: user.email ?? '' }, error: null, notice: null });
  sync?.stop();
  media?.stop();
  try {
    media = createMediaSync(client, user.id);
    setMediaAccount(user.id, media);
    const key = stateKey(user.id);
    const hadCopy = safeStorage.getItem(key) !== null;
    useStore.persist.setOptions({ name: key });
    if (hadCopy) await useStore.persist.rehydrate();
    else useStore.setState(blankWorkspace());
    sync = createSync({ backend: supabaseBackend(client, user.id), userId: user.id });
    let fresh = false;
    try {
      fresh = (await sync.pull()).remoteEmpty && !hadCopy;
    } catch (e) {
      if (!hadCopy) throw e;
      // offline with a copy on this device: carry on and save when back
      useSyncStatus.getState().set({ problem: 'offline', message: 'Couldn’t reach your account, so you’re working from this device’s copy. Changes are saved when you’re back online.' });
    }
    if (fresh) {
      if (browserWorkspace() && !safeStorage.getItem(`ylb-import-asked:${user.id}`)) {
        st.set({ phase: 'import' });
        return;
      }
      useStore.setState({ skills: starterSkills() });
    }
    begin();
  } catch (e) {
    st.set({ phase: 'failed', error: (e as Error)?.message || 'Couldn’t load your workspace.' });
  }
}

function begin() {
  sync?.start();
  media?.start();
  useAuth.getState().set({ phase: 'ready' });
}

/** Retry after the workspace failed to load. */
export async function retryOpen() {
  const user = (await client?.auth.getUser())?.data.user;
  if (user) await openWorkspace(user);
  else useAuth.getState().set({ phase: 'signed-out' });
}

/** A new account on a browser with a workspace from before accounts: bring it in, or start fresh. */
export async function answerImport(bring: boolean) {
  const st = useAuth.getState();
  if (!st.user) return;
  safeStorage.setItem(`ylb-import-asked:${st.user.id}`, '1');
  if (!bring) {
    useStore.setState({ skills: starterSkills() });
    return begin();
  }
  st.set({ phase: 'opening' });
  const old = browserWorkspace();
  if (old) {
    const now = useStore.getState().settings;
    const d = defaultSettings();
    const keep: Partial<StoreState> = {};
    for (const k of ['projects', 'activeProjectId', 'posts', 'ads', 'skills', 'genLog', 'myListings', 'cart', 'orders', 'sales', 'notices'] as const) {
      if (old[k] !== undefined) (keep as Record<string, unknown>)[k] = old[k];
    }
    const os = old.settings;
    keep.settings = {
      ...now,
      ...(os ?? {}),
      ai: { ...now.ai, useBrain: os?.ai?.useBrain ?? now.ai.useBrain, serverUrl: os?.ai?.serverUrl ?? now.ai.serverUrl, simulateLatency: os?.ai?.simulateLatency ?? now.ai.simulateLatency },
      profile: { ...d.profile, ...(os?.profile ?? {}) },
      accounts: { ...d.accounts, ...(os?.accounts ?? {}) },
    };
    useStore.setState(keep);
    // its files move into the account's store (and up to the cloud)
    const files = await readBrowserMedia();
    for (const [id, blob] of files) await putBlob(id, blob);
    sync?.markAll();
    safeStorage.removeItem(LEGACY_KEY);
    await deleteMediaDatabase(null);
  } else useStore.setState({ skills: starterSkills() });
  begin();
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

/** After a reset link (or from Settings → Account). */
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
  if (st.config && !st.config.signInRequired) st.set({ phase: 'guest', notice: null });
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
  sync?.stop();
  media?.stop();
  useStore.persist.setOptions({ name: DISCARD_KEY });
  sync?.forget();
  media?.forget();
  safeStorage.removeItem(stateKey(userId));
  for (const k of DEVICE_KEYS) safeStorage.removeItem(k);
  setMediaAccount(null, null);
  await deleteMediaDatabase(userId);
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
  if (st.phase === 'ready' && !(await saveNow()) && !force) return 'unsaved';
  const userId = st.user.id;
  st.set({ phase: 'leaving' });
  await forgetDevice(userId);
  await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  reloadSignedOut();
  return 'done';
}

/** Delete the account, its saved workspace and its files (the server does this with the secret key). */
export async function deleteAccount(): Promise<{ error?: string }> {
  const st = useAuth.getState();
  if (!client || !st.user) return { error: 'You’re not signed in.' };
  const base = (useStore.getState().settings.ai.serverUrl || '').replace(/\/+$/, '');
  const target = `${base}/api/account`;
  // nothing may upload into the folder while the server empties it
  sync?.stop();
  media?.stop();
  const res = await fetch(target, { method: 'DELETE', headers: await authHeaders(target) }).catch(() => null);
  const body = res ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
  if (!res?.ok) {
    sync?.start();
    media?.start();
    return { error: body?.error || 'Couldn’t reach the server to delete your account. Try again.' };
  }
  const userId = st.user.id;
  st.set({ phase: 'leaving' });
  await forgetDevice(userId);
  await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  reloadSignedOut();
  return {};
}
