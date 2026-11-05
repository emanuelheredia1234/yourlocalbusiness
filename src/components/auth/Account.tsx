// Who's signed in, with Log out: the account button in the top bar, a row at the bottom of the
// sidebar, a chip during setup, and Settings → Account.

import { useState, type FormEvent, type ReactNode } from 'react';
import { CircleAlert, Cloud, CloudOff, LogIn, LogOut, Monitor, Moon, Settings as SettingsIcon, Sun, Trash2 } from 'lucide-react';
import { cn, fmtRelative } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { deleteAccount, setNewPassword, showSignIn, signOut, useAuth } from '@/lib/cloud/auth';
import { useSyncStatus } from '@/lib/cloud/sync';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { Callout, SettingsRow, SettingsSection, Spinner, confirmAction } from '@/components/ui/primitives';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
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
    <span className="flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-ink-2" style={{ width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.42)) }} aria-hidden="true">
      {initialOf(email)}
    </span>
  );
}

function openAccountSettings() {
  useUI.getState().setSettingsTab('account');
  navigate('workspace-settings');
}

type Theme = 'system' | 'light' | 'dark';

/** Top bar: the signed-in person's menu (the one account entry): Settings, Theme, Log out. */
export function AccountButton() {
  const phase = useAuth((s) => s.phase);
  const email = useAuth((s) => s.user?.email ?? '');
  const sync = useSyncLine();
  const theme = useStore((s) => s.settings.theme);
  const update = useStore((s) => s.updateSettings);
  if (phase === 'guest') {
    return (
      <button type="button" className="btn btn-secondary btn-sm ml-1" onClick={showSignIn}>
        <LogIn /> Sign in
      </button>
    );
  }
  if (phase !== 'ready') return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ml-1 shrink-0 rounded-full transition-shadow duration-120 hover:ring-2 hover:ring-line-2" aria-label={`Account: ${email}`}>
          <Avatar email={email} size={28} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="w-[260px]">
        <div className="px-2 pb-2 pt-1.5">
          <p className="truncate text-small text-ink">{email}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-caption text-muted">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', sync.tone === 'warn' ? 'bg-warn-solid' : sync.tone === 'good' ? 'bg-good-solid' : 'bg-faint')} aria-hidden="true" />
            {sync.text}
          </p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openAccountSettings}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {theme === 'dark' ? <Moon /> : theme === 'light' ? <Sun /> : <Monitor />}
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => update((s) => ({ ...s, theme: v as Theme }))}>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logOut()}>
          <LogOut />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ───────────── Settings › Account ─────────────

/** A settings card for things that can't be undone: a red hairline and title (Account, Projects & data). */
export function DangerSection({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-bad-line bg-surface shadow-card">
      <div className="px-5 pb-1 pt-5">
        <h3 className="text-h3 text-bad">{title}</h3>
        {description && <p className="mt-0.5 text-small text-muted">{description}</p>}
      </div>
      <div className="px-5 pb-1">{children}</div>
    </section>
  );
}

export function AccountSettings() {
  const email = useAuth((s) => s.user?.email ?? '');
  const canDelete = useAuth((s) => !!s.config?.canDeleteAccount);
  const sync = useSyncLine();
  const problem = useSyncStatus((s) => s.message);
  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="Your account" description="Your projects, posts, skills, listings and files are saved to your account and open on any device.">
        <SettingsRow label="Signed in as">
          <span className="flex min-w-0 items-center gap-3">
            <Avatar email={email} size={32} />
            <span className="min-w-0">
              <span className="block truncate text-ui text-ink">{email}</span>
              <span className={cn('flex items-center gap-1.5 text-small', sync.tone === 'warn' ? 'text-warn' : 'text-muted')}>
                {sync.tone === 'warn' ? <CloudOff size={14} aria-hidden="true" /> : <Cloud size={14} aria-hidden="true" />} {sync.text}
              </span>
            </span>
          </span>
        </SettingsRow>
        {problem && (
          <div className="pb-4">
            <Callout tone="warn">{problem}</Callout>
          </div>
        )}
        <SettingsRow label="Log out of this device" description="Removes your work from this device. It stays in your account.">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void logOut()}>
            <LogOut /> Log out
          </button>
        </SettingsRow>
      </SettingsSection>
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
    <SettingsSection title="Change password" description="At least 8 characters.">
      <form onSubmit={(e) => void submit(e)} noValidate>
        <SettingsRow label="New password" htmlFor="cp-1">
          <input id="cp-1" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error || undefined} />
        </SettingsRow>
        <SettingsRow label="Type it again" htmlFor="cp-2">
          <input id="cp-2" className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={!!error || undefined} />
        </SettingsRow>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line py-4">
          {error && (
            <p role="alert" className="mr-auto flex items-center gap-1.5 text-caption text-bad">
              <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !password}>
            {busy && <Spinner size={14} />} Change password
          </button>
        </div>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
      </form>
    </SettingsSection>
  );
}

function DeleteAccount({ email }: { email: string }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const match = typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <DangerSection title="Delete account" description="Deletes your account, every project, post and listing in it, and all your files. This can’t be undone.">
      <SettingsRow label="Type your email to confirm" description="Export a backup first (Projects & data) if you might need anything." htmlFor="del-confirm">
        <input id="del-confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={email} />
      </SettingsRow>
      <div className="flex justify-end border-t border-line py-4">
        <button
          type="button"
          className="btn btn-danger-ghost btn-sm"
          disabled={!match || busy}
          onClick={async () => {
            if (!(await confirmAction({ title: 'Delete your account for good?', body: 'Your workspace and files are deleted from your account and this device.', confirmLabel: 'Delete my account', danger: true }))) return;
            setBusy(true);
            const r = await deleteAccount();
            setBusy(false);
            if (r.error) toast({ kind: 'error', title: 'Couldn’t delete your account', body: r.error });
          }}
        >
          {busy ? <Spinner size={14} /> : <Trash2 />} Delete my account
        </button>
      </div>
    </DangerSection>
  );
}
