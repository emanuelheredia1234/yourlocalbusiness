import { useState, type FormEvent } from 'react';
import { signIn, signUp } from '@/lib/auth';

type Mode = 'sign-in' | 'sign-up';

export function SignInScreen() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (mode === 'sign-up') {
        const result = await signUp(email.trim(), password);
        if (result.confirmationRequired) {
          setMode('sign-in');
          setPassword('');
          setNotice('Check your email for a confirmation link, then sign in here.');
        }
      } else {
        await signIn(email.trim(), password);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const isSignUp = mode === 'sign-up';

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-4">
      <section className="panel w-full max-w-md p-6 sm:p-8">
        <div className="mb-7">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Yourlocalbusiness</p>
          <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight">{isSignUp ? 'Create your account' : 'Welcome back'}</h1>
          <p className="mt-2 text-sm text-muted">{isSignUp ? 'Create an account to continue to your workspace.' : 'Sign in to continue to your workspace.'}</p>
        </div>

        <form className="space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium" htmlFor="account-email">
            Email
            <input
              id="account-email"
              className="input mt-1.5 w-full"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="block text-sm font-medium" htmlFor="account-password">
            Password
            <input
              id="account-password"
              className="input mt-1.5 w-full"
              type="password"
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              minLength={8}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
          {notice && <p className="rounded-md bg-good/10 px-3 py-2 text-sm text-good" role="status">{notice}</p>}

          <button className="btn btn-primary w-full justify-center" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : isSignUp ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-muted">
          {isSignUp ? 'Already have an account?' : 'New to the workspace?'}{' '}
          <button
            className="font-semibold text-primary hover:underline"
            type="button"
            onClick={() => {
              setMode(isSignUp ? 'sign-in' : 'sign-up');
              setError('');
              setNotice('');
            }}
          >
            {isSignUp ? 'Sign in' : 'Create an account'}
          </button>
        </p>
        <p className="mt-5 text-center text-xs leading-5 text-muted">
          Email confirmation must be enabled in Supabase for the owner email to manage AI settings.
        </p>
      </section>
    </main>
  );
}
