import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';

type AccountConfig = {
  enabled?: boolean;
  url?: string;
  publishableKey?: string;
  signInRequired?: boolean;
  canDeleteAccount?: boolean;
};

export type AuthSnapshot = {
  status: 'loading' | 'ready' | 'error';
  enabled: boolean;
  signInRequired: boolean;
  canDeleteAccount: boolean;
  user: User | null;
  error: string;
};

const INITIAL: AuthSnapshot = {
  status: 'loading',
  enabled: false,
  signInRequired: false,
  canDeleteAccount: false,
  user: null,
  error: '',
};

type AuthRuntime = {
  snapshot: AuthSnapshot;
  client: SupabaseClient | null;
  initPromise: Promise<void> | null;
  authSubscription: { unsubscribe: () => void } | null;
  listeners: Set<() => void>;
};

const runtimeHost = globalThis as typeof globalThis & { __YLB_AUTH_RUNTIME__?: AuthRuntime };
const runtime = (runtimeHost.__YLB_AUTH_RUNTIME__ ??= {
  snapshot: INITIAL,
  client: null,
  initPromise: null,
  authSubscription: null,
  listeners: new Set<() => void>(),
});

function publish(next: AuthSnapshot) {
  runtime.snapshot = next;
  runtime.listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  runtime.listeners.add(listener);
  return () => runtime.listeners.delete(listener);
}

export function useAuthState() {
  return useSyncExternalStore(subscribe, () => runtime.snapshot, () => runtime.snapshot);
}

/** Load the public account configuration, then restore any existing Supabase session. */
export function initializeAuth(force = false): Promise<void> {
  if (runtime.initPromise && !force) return runtime.initPromise;
  if (force) {
    runtime.authSubscription?.unsubscribe();
    runtime.authSubscription = null;
    runtime.client = null;
    runtime.initPromise = null;
  }

  publish({ ...runtime.snapshot, status: 'loading', error: '' });
  runtime.initPromise = (async () => {
    if (__ARTIFACT_BUILD__) {
      publish({ ...INITIAL, status: 'ready' });
      return;
    }

    const response = await fetch('/api/config');
    if (!response.ok) throw new Error(`Could not load account settings (${response.status}).`);
    const payload = (await response.json()) as { accounts?: AccountConfig };
    const config = payload.accounts;
    if (!config?.enabled) {
      publish({ ...INITIAL, status: 'ready' });
      return;
    }
    if (!config.url || !config.publishableKey) {
      throw new Error('Supabase account settings are incomplete. Check the project URL and publishable key.');
    }

    runtime.client = createClient(config.url, config.publishableKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
    const { data, error } = await runtime.client.auth.getSession();
    if (error) throw error;

    publish({
      status: 'ready',
      enabled: true,
      signInRequired: config.signInRequired === true,
      canDeleteAccount: config.canDeleteAccount === true,
      user: data.session?.user ?? null,
      error: '',
    });

    const { data: authData } = runtime.client.auth.onAuthStateChange((_event, session) => {
      publish({
        ...runtime.snapshot,
        status: 'ready',
        user: session?.user ?? null,
        error: '',
      });
    });
    runtime.authSubscription = authData.subscription;
  })().catch((error: unknown) => {
    runtime.client = null;
    publish({
      status: 'error',
      enabled: false,
      signInRequired: false,
      canDeleteAccount: false,
      user: null,
      error: error instanceof Error ? error.message : 'Could not initialize Supabase sign-in.',
    });
    runtime.initPromise = null;
  });

  return runtime.initPromise;
}

function requireClient(): SupabaseClient {
  if (!runtime.client) throw new Error('Supabase sign-in is not configured.');
  return runtime.client;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await requireClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  publish({ ...runtime.snapshot, user: data.user ?? data.session?.user ?? null, status: 'ready', error: '' });
}

export async function signUp(email: string, password: string): Promise<{ confirmationRequired: boolean }> {
  const { data, error } = await requireClient().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
  if (data.session) publish({ ...runtime.snapshot, user: data.user ?? data.session.user, status: 'ready', error: '' });
  return { confirmationRequired: !data.session };
}

export async function signOut() {
  const { error } = await requireClient().auth.signOut();
  if (error) throw error;
  publish({ ...runtime.snapshot, user: null, status: 'ready', error: '' });
}

export async function getAccessToken(): Promise<string | null> {
  if (!runtime.client) return null;
  const { data, error } = await runtime.client.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}

/** Never forward a Supabase session to a custom or third-party server URL. */
export function isSameOriginRequest(input: RequestInfo | URL, origin = typeof window !== 'undefined' ? window.location.origin : ''): boolean {
  if (!origin) return false;
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(target, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** Attach the current Supabase session to requests handled by the AI server. */
export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = isSameOriginRequest(input) ? await getAccessToken() : null;
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
