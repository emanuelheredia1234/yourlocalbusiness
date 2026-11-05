// The way in: sign in, create an account, reset a password, and wait while the account's workspace
// loads. The app itself only mounts once someone is signed in (or accounts are off).
//
// Wide screens: the form on the left, and on the right what the app makes (a post, a plan, a week, a live
// page), drawn with the app's own components. Phones: the form only.

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, CircleAlert, Eye, EyeOff, MailCheck, RefreshCw } from 'lucide-react';
import type { Brand, MediaRef } from '@/lib/types';
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
  takeWorkspaceHere,
  type Notice,
} from '@/lib/cloud/auth';
import { newProject } from '@/store/defaults';
import { Badge, Callout, Spinner } from '@/components/ui/primitives';
import { AppMark } from '@/components/layout/Shell';
import { Spark } from '@/components/ai/Spark';
import { PostFrame } from '@/components/frames/Frames';
import { PostVisual } from '@/components/visuals/PostVisual';
import { LogoMark } from '@/components/brand/Logo';
import demoPost from '@/assets/auth/demo-post.webp';

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
    case 'elsewhere':
      return <ElsewhereScreen />;
    case 'opening':
      return <Waiting text="Opening your workspace…" />;
    case 'leaving':
      return <Waiting text="Logging out…" />;
    default:
      return <Waiting text="Loading…" />;
  }
}

// ───────────── layout ─────────────

/** The two halves: the form (always) and, from 1024px, the product beside it. The document scrolls. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-full bg-surface lg:grid-cols-[560px_minmax(0,1fr)]">
      <div className="flex min-h-full flex-col px-6 pb-8 sm:px-10 lg:px-[72px] lg:py-10" style={{ paddingTop: 'max(24px, env(safe-area-inset-top, 0px))' }}>
        <div className="flex items-center gap-2.5">
          <AppMark size={28} />
          <span className="text-h3 text-ink">Yourlocalbusiness</span>
        </div>
        <main className="flex flex-1 items-start py-12 sm:items-center sm:py-14">
          <div className="w-full max-w-[400px] animate-rise-in">{children}</div>
        </main>
        <p className="text-caption text-muted">© {new Date().getFullYear()} Yourlocalbusiness</p>
      </div>
      <Showcase />
    </div>
  );
}

/** Loading, opening the workspace, logging out: the mark and one line, centred (no showcase: a signed-in reload passes through here). */
function Waiting({ text }: { text: string }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 bg-surface px-6 py-10">
      <div className="flex items-center gap-2.5">
        <AppMark size={28} />
        <span className="text-h3 text-ink">Yourlocalbusiness</span>
      </div>
      <p className="flex items-center gap-2 text-body text-muted" role="status">
        <Spinner size={16} /> {text}
      </p>
    </div>
  );
}

function Title({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-8">
      <h1 className="text-phone-display text-ink sm:text-display">{title}</h1>
      {sub && <p className="mt-2 text-body-lg text-muted">{sub}</p>}
    </div>
  );
}

function Banner({ notice }: { notice: Notice }) {
  return (
    <div className="mb-6" role={notice.kind === 'error' ? undefined : 'status'}>
      <Callout tone={notice.kind === 'error' ? 'bad' : 'info'}>{notice.text}</Callout>
    </div>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex gap-2 rounded-pop border border-bad-line bg-bad-soft px-3 py-2.5 text-small text-ink-2">
      <CircleAlert size={16} className="mt-0.5 shrink-0 text-bad" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function PasswordInput({ id, value, onChange, autoComplete, placeholder }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input id={id} className="input input-lg pr-12" type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} placeholder={placeholder} required />
      <button type="button" className="btn btn-ghost btn-icon btn-sm absolute right-1.5 top-1/2 -translate-y-1/2" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff /> : <Eye />}
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
        <span className="mb-6 flex h-[52px] w-[52px] items-center justify-center rounded-stage bg-primary-soft text-primary">
          <MailCheck size={24} aria-hidden="true" />
        </span>
        <h1 className="text-phone-display text-ink sm:text-display">Check your email</h1>
        <p className="mt-3 text-body-lg text-muted">
          {mode === 'sent-confirm' ? (
            <>
              We sent a link to <strong className="font-medium text-ink">{email.trim()}</strong>. Open it in this browser to finish creating your account.
            </>
          ) : (
            <>
              If there’s an account for <strong className="font-medium text-ink">{email.trim()}</strong>, a link to choose a new password is on its way. Open it in this browser.
            </>
          )}
        </p>
        {error && (
          <div className="mt-5">
            <ErrorLine>{error}</ErrorLine>
          </div>
        )}
        {info && (
          <p className="mt-5 text-small text-good" role="status">
            {info}
          </p>
        )}
        <div className="mt-8 flex flex-wrap items-center gap-2">
          {mode === 'sent-confirm' && (
            <button type="button" className="btn btn-secondary btn-lg" disabled={busy} onClick={() => void resend()}>
              {busy ? <Spinner size={16} /> : <RefreshCw />} Resend
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-lg" onClick={() => go('signin')}>
            <ArrowLeft /> Back to sign in
          </button>
        </div>
      </Frame>
    );
  }

  const titles: Record<'signin' | 'signup' | 'forgot', { title: string; sub: string; cta: string }> = {
    signin: { title: 'Welcome back', sub: 'Sign in to your marketing workspace.', cta: 'Sign in' },
    signup: { title: 'Create your free workspace', sub: 'Your projects, posts and files stay in your account, on any device.', cta: 'Create account' },
    forgot: { title: 'Reset your password', sub: 'We’ll email you a link to choose a new one.', cta: 'Send reset link' },
  };
  const t = titles[mode as 'signin' | 'signup' | 'forgot'];

  return (
    <Frame>
      <Title title={t.title} sub={t.sub} />
      {notice && <Banner notice={notice} />}
      <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)} noValidate>
        <div>
          <label className="label" htmlFor="auth-email">
            Email
          </label>
          <input id="auth-email" className="input input-lg" type="email" inputMode="email" autoComplete="email" placeholder="you@yourbusiness.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!email} />
        </div>
        {mode !== 'forgot' && (
          <div>
            <div className="flex items-end justify-between gap-2">
              <label className="label" htmlFor="auth-password">
                Password
              </label>
              {mode === 'signin' && (
                <button type="button" className="link mb-1.5 text-small" onClick={() => go('forgot')}>
                  Forgot password?
                </button>
              )}
            </div>
            <PasswordInput id="auth-password" value={password} onChange={setPassword} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
            {mode === 'signup' && <p className="hint">At least 8 characters.</p>}
          </div>
        )}
        {error && (
          <ErrorLine>
            {error}
            {needsConfirm && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => void resend()} disabled={busy}>
                  Send it again
                </button>
              </>
            )}
          </ErrorLine>
        )}
        {info && (
          <p className="text-small text-good" role="status">
            {info}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-xl mt-1 w-full" disabled={busy}>
          {busy && <Spinner size={18} />} {t.cta}
        </button>
        {mode === 'forgot' && (
          <button type="button" className="btn btn-ghost btn-lg" onClick={() => go('signin')}>
            <ArrowLeft /> Back to sign in
          </button>
        )}
      </form>
      {mode !== 'forgot' && (
        <p className="mt-6 text-center text-small text-muted">
          {mode === 'signin' ? (
            <>
              New here?{' '}
              <button type="button" className="link" onClick={() => go('signup')}>
                Create a free account
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button type="button" className="link" onClick={() => go('signin')}>
                Sign in
              </button>
            </>
          )}
        </p>
      )}
      {config && !config.signInRequired && (
        <p className="mt-8 border-t border-line pt-6 text-center text-small">
          <button type="button" className="link" onClick={continueAsGuest}>
            Continue without an account
          </button>
          <span className="mt-0.5 block text-caption text-muted">Your work stays in this browser only.</span>
        </p>
      )}
    </Frame>
  );
}

// ───────────── what the app makes (wide screens only) ─────────────

/** A demo salon's brand for the showcase: the app's own components draw it. */
function useDemoBrand(): Brand {
  return useMemo(() => {
    const b = newProject('business', 'existing').brand;
    return {
      ...b,
      name: 'Copper & Comb',
      slug: 'copper-and-comb',
      colors: { primary: '#B4693E', secondary: '#3A2A22', accent: '#E7C08F', ink: '#1E1612', paper: '#FBF5EE' },
      logo: { ...b.logo, mode: 'generated', icon: 'scissors', shape: 'circle', font: 'serif', monogram: false },
    };
  }, []);
}

const DEMO_PHOTO: MediaRef = { id: 'ylb-auth-demo-post', kind: 'image', name: 'demo-post.webp', mime: 'image/webp', size: 0, createdAt: 0, w: 720, h: 900, thumb: demoPost };

function Showcase() {
  const brand = useDemoBrand();
  return (
    <aside className="relative hidden overflow-hidden bg-bg lg:block" aria-label="What Yourlocalbusiness makes">
      {/* the aura, top right: the one AI moment on this page */}
      <div aria-hidden="true" className="pointer-events-none absolute -right-48 -top-56 h-[760px] w-[760px] rounded-full opacity-[0.22] dark:opacity-[0.38]" style={{ background: 'radial-gradient(closest-side, rgb(var(--ai-1)), rgb(var(--ai-2)) 45%, rgb(var(--ai-3)) 70%, transparent)' }} />
      <div className="relative flex min-h-full flex-col justify-center px-16 py-14 xl:px-20">
        <h2 className="max-w-[640px] text-display-2xl text-ink">
          Your business,
          <span className="block font-editorial font-normal italic tracking-[-0.02em]" style={{ fontSize: 64, lineHeight: '68px' }}>
            marketed by AI.
          </span>
        </h2>
        <p className="mt-5 max-w-[460px] text-body-lg text-muted">A strategy, a week of on-brand posts, and a booking page, from one short setup.</p>

        <div className="mt-12 flex items-start gap-4" aria-hidden="true">
          <PostFrame
            handle="copperandcomb"
            avatar={<LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={24} />}
            meta="Austin, Texas"
            className="w-[272px] shrink-0"
            caption="Fall refresh: copper balayage that still looks good at week ten. Book your consult, link in bio."
          >
            <PostVisual style="editorial" headline="Lived-in color that grows out softly" brand={brand} media={DEMO_PHOTO} aspect="4/5" className="!rounded-none" label="Example post photo" />
            <div data-media className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-4 pb-4 pt-16 text-white">
              <p data-media className="font-brand text-white" style={{ fontSize: 21, lineHeight: '24px', fontWeight: 700, letterSpacing: '-0.01em' }}>
                Lived-in color that grows out softly
              </p>
              <p data-media className="flex items-center gap-1.5 text-caption text-white/85">
                <LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={16} /> Copper &amp; Comb · Austin
              </p>
            </div>
          </PostFrame>

          <div className="flex w-[284px] shrink-0 flex-col gap-3 pt-6">
            <div className="rounded-lg border border-line bg-surface p-4 shadow-product">
              <p className="flex items-center gap-2 text-h4 text-ink">
                <Spark size={16} /> Strategy ready
              </p>
              <p className="mt-1.5 text-small text-muted">Start with Google Business and Instagram reels.</p>
            </div>
            <div className="rounded-lg border border-line bg-surface px-4 py-3 shadow-product">
              {[
                ['Thu', 'Before/after reel', 'bg-c1'],
                ['Fri', 'Google update', 'bg-c2'],
                ['Sat', 'Weekend openings', 'bg-c3'],
              ].map(([day, what, bar]) => (
                <p key={day} className="flex items-center gap-3 py-1.5 text-small text-ink">
                  <span className="w-7 font-mono text-caption text-muted">{day}</span>
                  <span className={cn('h-4 w-[3px] shrink-0 rounded-full', bar)} />
                  {what}
                </p>
              ))}
            </div>
            <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-4 py-3 shadow-product">
              <Badge tone="good" dot>
                Published
              </Badge>
              <span className="min-w-0 truncate font-mono text-caption text-muted">copperandcomb.com/book</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
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
      <Title title="Choose a new password" sub={email ? `For ${email}.` : 'For your account.'} />
      <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)} noValidate>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <div>
          <label className="label" htmlFor="np-1">
            New password
          </label>
          <PasswordInput id="np-1" value={password} onChange={setPassword} autoComplete="new-password" />
          <p className="hint">At least 8 characters.</p>
        </div>
        <div>
          <label className="label" htmlFor="np-2">
            Type it again
          </label>
          <PasswordInput id="np-2" value={again} onChange={setAgain} autoComplete="new-password" />
        </div>
        {error && <ErrorLine>{error}</ErrorLine>}
        <button type="submit" className="btn btn-primary btn-xl mt-1 w-full" disabled={busy}>
          {busy && <Spinner size={18} />} Save password and continue
        </button>
      </form>
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
    <Frame>
      <section>
        <Title
          title="Bring your work into your account?"
          sub={
            <>
              This browser has a workspace from before accounts: {count.projects} project{count.projects === 1 ? '' : 's'}
              {count.posts ? ` and ${count.posts} post${count.posts === 1 ? '' : 's'}` : ''}, with {count.projects + count.posts === 1 ? 'its' : 'their'} images and files. Add it to your account to keep it and open it on any device.
            </>
          }
        />
        <div className="flex flex-col gap-2">
          <button type="button" className="btn btn-primary btn-xl w-full" disabled={!!busy} onClick={() => void run(true)}>
            {busy === 'bring' && <Spinner size={18} />} Add it to my account
          </button>
          <button type="button" className="btn btn-secondary btn-xl w-full" disabled={!!busy} onClick={() => void run(false)}>
            {busy === 'fresh' && <Spinner size={18} />} Start fresh
          </button>
        </div>
        <p className="mt-4 text-small text-muted">Start fresh leaves that workspace where it is in this browser.</p>
      </section>
    </Frame>
  );
}

/** Another tab of this browser opened the same account (two tabs saving at once would undo each other). */
function ElsewhereScreen() {
  const [busy, setBusy] = useState(false);
  return (
    <Frame>
      <Title title="Your workspace is open in another tab" sub="To keep your changes from overwriting each other, it works in one tab at a time. Everything from this tab is saved." />
      <button
        type="button"
        className="btn btn-primary btn-xl w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await takeWorkspaceHere();
          setBusy(false);
        }}
      >
        {busy && <Spinner size={18} />} Use it here
      </button>
    </Frame>
  );
}

function FailedScreen() {
  const error = useAuth((s) => s.error);
  const [busy, setBusy] = useState(false);
  return (
    <Frame>
      <span className="mb-6 flex h-[52px] w-[52px] items-center justify-center rounded-stage bg-bad-soft text-bad">
        <CircleAlert size={24} aria-hidden="true" />
      </span>
      <Title title="Couldn’t open your workspace" sub="Check your connection and try again." />
      {error && <p className="-mt-4 mb-6 break-words font-mono text-caption text-faint">{error}</p>}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="btn btn-primary btn-xl w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await retryOpen();
            setBusy(false);
          }}
        >
          {busy ? <Spinner size={18} /> : <RefreshCw />} Try again
        </button>
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => void signOut({ force: true })}>
          Log out
        </button>
      </div>
    </Frame>
  );
}
