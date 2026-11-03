// Who's signed in, with Log out: the account button in the top bar, a row at the bottom of the
// sidebar, a chip during setup, and Settings → Account.

import { useRef, useState, type FormEvent } from 'react';
import { CircleUserRound, Cloud, CloudOff, LogIn, LogOut, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import { cn, fmtRelative } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { deleteAccount, setNewPassword, showSignIn, signOut, useAuth } from '@/lib/cloud/auth';
import { useSyncStatus } from '@/lib/cloud/sync';
import { toast, useUI } from '@/store/ui';
import { MenuItem, Popover, Spinner, confirmAction } from '@/components/ui/primitives';
import { confirmLeave } from '@/components/ui/leave';

/** Log out of this device, asking first if some changes couldn't be saved. */
export async function logOut() {
  if (!(await confirmLeave())) return;
  const r = await signOut();
  if (r !== 'unsaved') return;
  const go = await confirmAction({
    title: 'Some changes aren’t saved yet',
    body: 'A few changes haven’t reached your account (you may be offline). If you log out now, they’ll be lost on this device.',
    confirmLabel: 'Log out anyway',
    danger: true,
  });
  if (go) await signOut({ force: true });
}

const initialOf = (email: string) => (email.trim()[0] ?? '?').toUpperCase();

/** "All changes saved" / "Saving…" / "Offline: 3 changes waiting". */
export function useSyncLine(): { text: string; tone: 'good' | 'muted' | 'warn' } {
  const s = useSyncStatus();
  const waiting = s.pending + s.files;
  if (s.problem === 'offline') return { text: waiting ? `Offline: ${waiting} change${waiting === 1 ? '' : 's'} waiting` : 'Offline', tone: 'warn' };
  if (s.problem === 'error') return { text: 'Couldn’t save some changes', tone: 'warn' };
  if (s.saving || waiting) return { text: 'Saving…', tone: 'muted' };
  return { text: s.lastSavedAt ? `All changes saved · ${fmtRelative(s.lastSavedAt)}` : 'Saved to your account', tone: 'good' };
}

function Avatar({ email, size = 32 }: { email: string; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full bg-primary font-display font-bold text-on-primary" style={{ width: size, height: size, fontSize: size * 0.44 }} aria-hidden="true">
      {initialOf(email)}
    </span>
  );
}

function openAccountSettings() {
  useUI.getState().setSettingsTab('account');
  navigate('workspace-settings');
}

/** Top bar: the signed-in person, with Account settings and Log out. */
export function AccountButton() {
  const phase = useAuth((s) => s.phase);
  const email = useAuth((s) => s.user?.email ?? '');
  const sync = useSyncLine();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (phase === 'guest') {
    return (
      <button className="btn btn-secondary btn-sm ml-1" onClick={showSignIn}>
        <LogIn size={15} /> Sign in
      </button>
    );
  }
  if (phase !== 'ready') return null;
  return (
    <>
      <button ref={ref} className="ml-1 rounded-full ring-offset-2 ring-offset-surface hover:ring-2 hover:ring-line-2 focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setOpen(true)} aria-label={`Account: ${email}`} aria-haspopup="menu">
        <Avatar email={email} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} className="w-[270px]">
        <div className="flex items-center gap-2.5 px-2.5 pb-2 pt-1.5">
          <Avatar email={email} size={36} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-ink">{email}</p>
            <p className={cn('flex items-center gap-1 truncate text-[11.5px]', sync.tone === 'warn' ? 'text-warn' : sync.tone === 'good' ? 'text-good' : 'text-muted')}>
              {sync.tone === 'warn' ? <CloudOff size={12} /> : <Cloud size={12} />} {sync.text}
            </p>
          </div>
        </div>
        <div className="my-1 border-t border-line" />
        <MenuItem
          icon={<SettingsIcon size={15} />}
          onClick={() => {
            setOpen(false);
            openAccountSettings();
          }}
        >
          Account settings
        </MenuItem>
        <MenuItem
          icon={<LogOut size={15} />}
          onClick={() => {
            setOpen(false);
            void logOut();
          }}
        >
          Log out
        </MenuItem>
      </Popover>
    </>
  );
}

/** Bottom of the sidebar (and the mobile menu): who's signed in, and Log out. */
export function AccountRow({ onNavigate }: { onNavigate?: () => void }) {
  const phase = useAuth((s) => s.phase);
  const email = useAuth((s) => s.user?.email ?? '');
  const sync = useSyncLine();
  if (phase === 'guest') {
    return (
      <button className="mt-1 flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-[13.5px] font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink" onClick={showSignIn}>
        <LogIn size={18} /> Sign in to save your work
      </button>
    );
  }
  if (phase !== 'ready') return null;
  return (
    <div className="mt-1 flex items-center gap-1 rounded-md px-1.5 py-1">
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left hover:bg-surface-2"
        onClick={() => {
          openAccountSettings();
          onNavigate?.();
        }}
        title="Account settings"
      >
        <Avatar email={email} size={28} />
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] font-semibold text-ink">{email}</span>
          <span className={cn('block truncate text-[11px]', sync.tone === 'warn' ? 'text-warn' : 'text-muted')}>{sync.text}</span>
        </span>
      </button>
      <button className="btn btn-ghost btn-icon btn-sm shrink-0" onClick={() => void logOut()} aria-label="Log out" title="Log out">
        <LogOut size={16} />
      </button>
    </div>
  );
}

/** During setup (no sidebar yet). */
export function AccountChip() {
  const phase = useAuth((s) => s.phase);
  const email = useAuth((s) => s.user?.email ?? '');
  if (phase !== 'ready') return null;
  return (
    <div className="flex items-center gap-1.5">
      <span className="hidden max-w-[200px] truncate text-[12.5px] text-muted md:inline">{email}</span>
      <button className="btn btn-ghost btn-sm" onClick={() => void logOut()}>
        <LogOut size={15} /> Log out
      </button>
    </div>
  );
}

// ───────────── Settings → Account ─────────────

export function AccountSettings() {
  const email = useAuth((s) => s.user?.email ?? '');
  const canDelete = useAuth((s) => !!s.config?.canDeleteAccount);
  const sync = useSyncLine();
  const problem = useSyncStatus((s) => s.message);
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <section className="card p-5">
        <h3 className="section-title flex items-center gap-2">
          <CircleUserRound size={17} className="text-primary" /> Your account
        </h3>
        <div className="mt-4 flex items-center gap-3">
          <Avatar email={email} size={44} />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-ink">{email}</p>
            <p className={cn('flex items-center gap-1 text-[12.5px]', sync.tone === 'warn' ? 'text-warn' : sync.tone === 'good' ? 'text-good' : 'text-muted')}>
              {sync.tone === 'warn' ? <CloudOff size={13} /> : <Cloud size={13} />} {sync.text}
            </p>
          </div>
        </div>
        {problem && <p className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-ink-2">{problem}</p>}
        <p className="mt-4 text-[13px] leading-relaxed text-muted">Your projects, posts, skills, listings and files are saved to your account, so they open on any device you sign in on. Logging out removes them from this device (they stay in your account).</p>
        <button className="btn btn-secondary mt-4" onClick={() => void logOut()}>
          <LogOut size={15} /> Log out
        </button>
      </section>
      <ChangePassword email={email} />
      {canDelete && <DeleteAccount email={email} />}
    </div>
  );
}

function ChangePassword({ email }: { email: string }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError('Use at least 8 characters.');
    if (password !== again) return setError('The two passwords don’t match.');
    setBusy(true);
    const r = await setNewPassword(password);
    setBusy(false);
    if (r.error) return setError(r.error);
    setPassword('');
    setAgain('');
    toast({ kind: 'success', title: 'Password changed' });
  }
  return (
    <section className="card p-5">
      <h3 className="section-title">Change password</h3>
      <form className="mt-4 flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <div>
          <label className="label" htmlFor="cp-1">
            New password
          </label>
          <input id="cp-1" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cp-2">
            Type it again
          </label>
          <input id="cp-2" className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </div>
        {error && (
          <p role="alert" className="text-[13px] text-bad">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy || !password}>
            {busy && <Spinner size={14} />} Change password
          </button>
        </div>
      </form>
    </section>
  );
}

function DeleteAccount({ email }: { email: string }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const match = typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <section className="card border-bad/30 p-5">
      <h3 className="section-title text-bad">Delete account</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">Deletes your account, every project, post and listing in it, and all your files. This can’t be undone. Export a backup first (Projects &amp; data) if you might need anything.</p>
      <label className="label mt-4" htmlFor="del-confirm">
        Type your email to confirm
      </label>
      <input id="del-confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={email} />
      <button
        className="btn btn-danger mt-3"
        disabled={!match || busy}
        onClick={async () => {
          if (!(await confirmAction({ title: 'Delete your account for good?', body: 'Your workspace and files are deleted from your account and this device.', confirmLabel: 'Delete my account', danger: true }))) return;
          setBusy(true);
          const r = await deleteAccount();
          setBusy(false);
          if (r.error) toast({ kind: 'error', title: 'Couldn’t delete your account', body: r.error });
        }}
      >
        {busy ? <Spinner size={14} /> : <Trash2 size={15} />} Delete my account
      </button>
    </section>
  );
}
