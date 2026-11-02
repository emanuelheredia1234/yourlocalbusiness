import { useEffect, type ReactNode } from 'react';
import { initializeAuth, useAuthState } from '@/lib/auth';
import { Spinner } from '@/components/ui/primitives';
import { SignInScreen } from './SignInScreen';

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthState();

  useEffect(() => {
    void initializeAuth();
  }, []);

  if (auth.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface text-muted" aria-label="Loading account settings">
        <Spinner size={24} />
      </main>
    );
  }

  if (auth.status === 'error') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface p-4">
        <section className="panel w-full max-w-md p-6 sm:p-8">
          <h1 className="font-display text-xl font-semibold">Account setup needs attention</h1>
          <p className="mt-2 text-sm text-muted">{auth.error}</p>
          <button className="btn btn-primary mt-5 w-full justify-center" onClick={() => void initializeAuth(true)}>
            Try again
          </button>
        </section>
      </main>
    );
  }

  if (auth.enabled && auth.signInRequired && !auth.user) return <SignInScreen />;
  return children;
}
