// The way in: sign in, create an account, reset a password, and wait while the account's workspace
// loads. The app itself only mounts once someone is signed in (or accounts are off).

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, CircleAlert, Eye, EyeOff, Info, MailCheck, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { safeStorage } from '@/lib/storage';
import {
  answerImport,
  continueAsGuest,
  resendConfirmation,
  retryOpen,
  sendPasswordReset,
  setNewPassword,
  signIn,
  signOut,
  signUp,
  startAuth,
  useAuth,
  type Notice,
} from '@/lib/cloud/auth';
import { Spinner } from '@/components/ui/primitives';
import { AppMark } from '@/components/layout/Shell';

export function AuthGate({ children }: { children: ReactNode }) {
  const phase = useAuth((s) => s.phase);
  useEffect(() => {
    void startAuth();
  }, []);
  switch (phase) {
    case 'off':
    case 'ready':
    case 'guest':
      return <>{children}</>;
    case 'signed-out':
      return <SignInScreen />;
    case 'recovery':
      return <NewPasswordScreen />;
    case 'import':
      return <ImportScreen />;
    case 'failed':
      return <FailedScreen />;
    case 'opening':
      return <Waiting text="Opening your workspace…" />;
    case 'leaving':
      return <Waiting text="Logging out…" />;
    default:
      return <Waiting text="Loading…" />;
  }
}

// ───────────── layout ─────────────

function Frame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full flex-col bg-bg">
      <div className="awning h-2.5 shrink-0" />
      <div className="awning-scallop h-2 shrink-0" />
      <main className="flex flex-1 items-start justify-center gutter py-10 sm:items-center">
        <div className={cn('w-full animate-rise-in', wide ? 'max-w-[520px]' : 'max-w-[420px]')}>
          <div className="mb-6 flex items-center justify-center gap-2.5">
            <AppMark size={34} />
            <span className="font-display text-[20px] font-bold tracking-[-0.02em]">Yourlocalbusiness</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <Frame>
      <p className="flex items-center justify-center gap-2 text-[14px] text-muted" role="status">
        <Spinner size={16} /> {text}
      </p>
    </Frame>
  );
}

function Banner({ notice }: { notice: Notice }) {
  return (
    <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mb-4 flex gap-2 rounded-md border px-3 py-2.5 text-[13px] leading-relaxed', notice.kind === 'error' ? 'border-bad/30 bg-bad-soft text-bad' : 'border-line-2 bg-surface-2 text-ink-2')}>
      {notice.kind === 'error' ? <CircleAlert size={16} className="mt-0.5 shrink-0" /> : <Info size={16} className="mt-0.5 shrink-0 text-primary" />}
      <span>{notice.text}</span>
    </p>
  );
}

function PasswordInput({ id, value, onChange, autoComplete, placeholder }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input id={id} className="input pr-10" type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} placeholder={placeholder} required />
      <button type="button" className="absolute right-1 top-1/2 flex h-7 w-8 -translate-y-1/2 items-center justify-center rounded text-muted hover:text-ink" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const LAST_EMAIL = 'ylb-last-email';

// ───────────── sign in / create account / forgot password ─────────────

type Mode = 'signin' | 'signup' | 'forgot' | 'sent-confirm' | 'sent-reset';

function SignInScreen() {
  const notice = useAuth((s) => s.notice);
  const config = useAuth((s) => s.config);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState(() => safeStorage.getItem(LAST_EMAIL) ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const go = (m: Mode) => {
    setMode(m);
    setError(null);
    setInfo(null);
    setNeedsConfirm(false);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);
    if (!validEmail(email)) return setError('Enter a valid email address.');
    if (mode !== 'forgot' && mode === 'signup' && password.length < 8) return setError('Use at least 8 characters for your password.');
    setBusy(true);
    try {
      safeStorage.setItem(LAST_EMAIL, email.trim());
      if (mode === 'signin') {
        const r = await signIn(email, password);
        if (r.error) {
          setError(r.error);
          setNeedsConfirm(r.code === 'email_not_confirmed');
        }
      } else if (mode === 'signup') {
        const r = await signUp(email, password);
        if (r.error) setError(r.error);
        else if (r.confirm) go('sent-confirm');
      } else if (mode === 'forgot') {
        const r = await sendPasswordReset(email);
        if (r.error) setError(r.error);
        else go('sent-reset');
      }
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    const r = await resendConfirmation(email);
    setBusy(false);
    if (r.error) setError(r.error);
    else {
      setError(null);
      setInfo('Sent. Check your inbox (and spam folder).');
    }
  }

  if (mode === 'sent-confirm' || mode === 'sent-reset') {
    return (
      <Frame>
        <section className="panel p-6">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-primary">
            <MailCheck size={20} />
          </span>
          <h1 className="text-center font-display text-[20px] font-bold tracking-[-0.01em]">Check your email</h1>
          <p className="mt-2 text-center text-[13.5px] leading-relaxed text-muted">
            {mode === 'sent-confirm' ? (
              <>
                We sent a link to <strong className="text-ink">{email.trim()}</strong>. Open it in this browser to finish creating your account.
              </>
            ) : (
              <>
                If there’s an account for <strong className="text-ink">{email.trim()}</strong>, a link to choose a new password is on its way. Open it in this browser.
              </>
            )}
          </p>
          {error && <p className="mt-3 text-center text-[13px] text-bad">{error}</p>}
          {info && <p className="mt-3 text-center text-[13px] text-good">{info}</p>}
          <div className="mt-5 flex flex-col gap-2">
            {mode === 'sent-confirm' && (
              <button className="btn btn-secondary" disabled={busy} onClick={() => void resend()}>
                {busy ? <Spinner size={14} /> : <RefreshCw size={14} />} Send the email again
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => go('signin')}>
              <ArrowLeft size={15} /> Back to sign in
            </button>
          </div>
        </section>
      </Frame>
    );
  }

  const titles: Record<'signin' | 'signup' | 'forgot', { title: string; sub: string; cta: string }> = {
    signin: { title: 'Welcome back', sub: 'Sign in to your workspace.', cta: 'Sign in' },
    signup: { title: 'Create your account', sub: 'Your projects, posts and files are saved to your account, so you can pick up on any device.', cta: 'Create account' },
    forgot: { title: 'Reset your password', sub: 'We’ll email you a link to choose a new one.', cta: 'Send reset link' },
  };
  const t = titles[mode as 'signin' | 'signup' | 'forgot'];

  return (
    <Frame>
      {notice && <Banner notice={notice} />}
      <section className="panel p-6">
        {mode !== 'forgot' && (
          <div className="mb-5 grid grid-cols-2 rounded-md bg-surface-2 p-1" role="tablist" aria-label="Sign in or create an account">
            {(['signin', 'signup'] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} className={cn('h-8 rounded text-[13px] font-semibold transition-colors', mode === m ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink')} onClick={() => go(m)}>
                {m === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>
        )}
        <h1 className="font-display text-[21px] font-bold tracking-[-0.01em]">{t.title}</h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{t.sub}</p>
        <form className="mt-5 flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <div>
            <label className="label" htmlFor="auth-email">
              Email
            </label>
            <input id="auth-email" className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!email} />
          </div>
          {mode !== 'forgot' && (
            <div>
              <div className="flex items-baseline justify-between">
                <label className="label" htmlFor="auth-password">
                  Password
                </label>
                {mode === 'signin' && (
                  <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => go('forgot')}>
                    Forgot password?
                  </button>
                )}
              </div>
              <PasswordInput id="auth-password" value={password} onChange={setPassword} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
              {mode === 'signup' && <p className="hint">At least 8 characters.</p>}
            </div>
          )}
          {error && (
            <p role="alert" className="flex gap-2 rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">
              <CircleAlert size={15} className="mt-0.5 shrink-0" />
              <span>
                {error}
                {needsConfirm && (
                  <>
                    {' '}
                    <button type="button" className="font-semibold underline" onClick={() => void resend()} disabled={busy}>
                      Send it again
                    </button>
                  </>
                )}
              </span>
            </p>
          )}
          {info && <p className="text-[13px] text-good">{info}</p>}
          <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy}>
            {busy && <Spinner size={15} />} {t.cta}
          </button>
          {mode === 'forgot' && (
            <button type="button" className="btn btn-ghost" onClick={() => go('signin')}>
              <ArrowLeft size={15} /> Back to sign in
            </button>
          )}
        </form>
      </section>
      {config && !config.signInRequired && (
        <p className="mt-4 text-center text-[13px]">
          <button className="font-semibold text-primary hover:underline" onClick={continueAsGuest}>
            Continue without an account
          </button>
          <span className="block text-xs text-muted">Your work stays in this browser only.</span>
        </p>
      )}
    </Frame>
  );
}

// ───────────── after a password-reset link ─────────────

function NewPasswordScreen() {
  const email = useAuth((s) => s.user?.email ?? '');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError('Use at least 8 characters.');
    if (password !== again) return setError('The two passwords don’t match.');
    setBusy(true);
    const r = await setNewPassword(password);
    setBusy(false);
    if (r.error) setError(r.error);
  }
  return (
    <Frame>
      <section className="panel p-6">
        <h1 className="font-display text-[21px] font-bold tracking-[-0.01em]">Choose a new password</h1>
        <p className="mt-1 text-[13.5px] text-muted">{email ? `For ${email}.` : 'For your account.'}</p>
        <form className="mt-5 flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <input type="email" autoComplete="username" value={email} readOnly hidden />
          <div>
            <label className="label" htmlFor="np-1">
              New password
            </label>
            <PasswordInput id="np-1" value={password} onChange={setPassword} autoComplete="new-password" />
          </div>
          <div>
            <label className="label" htmlFor="np-2">
              Type it again
            </label>
            <PasswordInput id="np-2" value={again} onChange={setAgain} autoComplete="new-password" />
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy}>
            {busy && <Spinner size={15} />} Save password and continue
          </button>
        </form>
      </section>
    </Frame>
  );
}

// ───────────── a new account on a browser that has a workspace from before ─────────────

function ImportScreen() {
  const [busy, setBusy] = useState<null | 'bring' | 'fresh'>(null);
  const count = (() => {
    try {
      const s = JSON.parse(safeStorage.getItem('yourlocalbusiness-state') || 'null')?.state;
      return { projects: s?.projects?.length ?? 0, posts: s?.posts?.length ?? 0 };
    } catch {
      return { projects: 0, posts: 0 };
    }
  })();
  const run = async (bring: boolean) => {
    setBusy(bring ? 'bring' : 'fresh');
    await answerImport(bring);
  };
  return (
    <Frame wide>
      <section className="panel p-6">
        <h1 className="font-display text-[21px] font-bold tracking-[-0.01em]">Bring your work into your account?</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          This browser has a workspace from before accounts: {count.projects} project{count.projects === 1 ? '' : 's'}
          {count.posts ? ` and ${count.posts} post${count.posts === 1 ? '' : 's'}` : ''}, with {count.projects + count.posts === 1 ? 'its' : 'their'} images and files. Add it to your account to keep it and open it on any device.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button className="btn btn-primary flex-1" disabled={!!busy} onClick={() => void run(true)}>
            {busy === 'bring' && <Spinner size={14} />} Add it to my account
          </button>
          <button className="btn btn-secondary flex-1" disabled={!!busy} onClick={() => void run(false)}>
            {busy === 'fresh' && <Spinner size={14} />} Start fresh
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">Start fresh leaves that workspace where it is in this browser.</p>
      </section>
    </Frame>
  );
}

function FailedScreen() {
  const error = useAuth((s) => s.error);
  const [busy, setBusy] = useState(false);
  return (
    <Frame>
      <section className="panel p-6 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-bad-soft text-bad">
          <CircleAlert size={20} />
        </span>
        <h1 className="font-display text-[20px] font-bold">Couldn’t open your workspace</h1>
        <p className="mt-2 text-[13.5px] text-muted">Check your connection and try again.</p>
        {error && <p className="mt-2 break-words text-xs text-faint">{error}</p>}
        <div className="mt-5 flex flex-col gap-2">
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await retryOpen();
              setBusy(false);
            }}
          >
            {busy ? <Spinner size={14} /> : <RefreshCw size={14} />} Try again
          </button>
          <button className="btn btn-ghost" onClick={() => void signOut({ force: true })}>
            Log out
          </button>
        </div>
      </section>
    </Frame>
  );
}
