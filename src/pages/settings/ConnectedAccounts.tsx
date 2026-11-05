// Settings › Connected accounts: each network, ad account and Search Console, with its state and the one
// action that fits it. Connect asks the server for a link and opens it in a new tab (the link is never kept);
// the row then waits for the network. Nothing here posts or changes anything at the network.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight, BarChart3, Pin, RefreshCw, Search, Target, Unplug } from 'lucide-react';
import type { ConnectPlatform, ConnectionStatus, LimitedReason, Target as ConnectTarget } from '@/lib/integrations/types';
import { PHASE2_PLATFORMS } from '@/lib/integrations/types';
import { getTargets, setTarget } from '@/lib/integrations/api';
import { useAnalytics, PENDING_EXPIRES_MS } from '@/store/analytics';
import { toast } from '@/store/ui';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import { Badge, Callout, InfoTip, Modal, MoreMenu, OptionCards, SettingsRow, SettingsSection, Spinner, StatusDot, confirmAction, type MenuEntry } from '@/components/ui/primitives';
import { PLATFORM_NAMES } from '@/pages/marketing/analytics/links';

const SOCIAL: ConnectPlatform[] = ['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube', 'pinterest'];
const ADS: ConnectPlatform[] = ['google_ads', 'meta_ads', 'microsoft_ads', 'tiktok_ads'];
const SEARCH: ConnectPlatform[] = ['google_search_console'];

/** Where each network's own app settings are (Disconnect doesn't remove access there). */
const APP_SETTINGS: Partial<Record<ConnectPlatform, string>> = {
  facebook: 'Facebook',
  instagram: 'Facebook',
  meta_ads: 'Facebook',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  x: 'X',
  youtube: 'your Google account',
  google_ads: 'your Google account',
  google_search_console: 'your Google account',
};

const LIMITED_COPY: Record<LimitedReason, (name: string) => string> = {
  missing_permissions: () => 'Some permissions weren’t allowed',
  no_page_role: () => 'You need to be able to post on this Page',
  app_not_approved: (name) => `Waiting for ${name} to approve this app`,
  insights_unavailable: () => 'Stats appear once the account has 100 followers',
  private_only: () => 'Posts go out as private until TikTok approves this app',
};

const TARGET_KIND: Partial<Record<NonNullable<ConnectionStatus['targetKind']>, string>> = {
  fb_page: 'Page',
  ig_account: 'Instagram',
  li_person: 'Profile',
  li_org: 'Company page',
  yt_channel: 'Channel',
  ads_account: 'Ad account',
  gsc_site: 'Site',
};

export type RowAction = 'connect' | 'reconnect' | 'check' | 'menu' | 'none';
export interface RowView {
  tone: 'good' | 'warn' | 'faint';
  status: string;
  /** a plain line under the name (the reason, or what to do) */
  note?: string;
  action: RowAction;
  comingSoon?: boolean;
  /** Instagram connects through Facebook */
  connectAs?: ConnectPlatform;
}

/** What a row shows, from the server's status and what this browser knows (a connect window opened here). */
export function rowView(
  platform: ConnectPlatform,
  st: ConnectionStatus | undefined,
  o: { enabled: boolean; pendingAt?: number; expired?: boolean; facebook?: ConnectionStatus; now?: number },
): RowView {
  const name = PLATFORM_NAMES[platform];
  if (PHASE2_PLATFORMS.includes(platform) || st?.state === 'coming_soon') return { tone: 'faint', status: 'Coming soon', action: 'none', comingSoon: true };
  const state = st?.state ?? 'not_connected';
  const off = !o.enabled;
  const now = o.now ?? Date.now();
  const waiting = state === 'pending' || (state === 'not_connected' && o.pendingAt !== undefined && now - o.pendingAt <= PENDING_EXPIRES_MS);
  if (waiting && !off) return { tone: 'faint', status: `Waiting for ${platform === 'instagram' ? 'Facebook' : name}…`, note: 'Finish in the tab that opened, then come back.', action: 'check' };
  if (state === 'connected') {
    if (st?.expiresSoon) return { tone: 'warn', status: 'Expires soon', note: `Reconnect to keep posting to ${name}.`, action: off ? 'none' : 'reconnect' };
    return { tone: 'good', status: 'Connected', action: off ? 'none' : 'menu' };
  }
  if (state === 'needs_reconnect') return { tone: 'warn', status: 'Reconnect needed', note: `${name} asked to sign in again.`, action: off ? 'none' : 'reconnect' };
  if (state === 'limited') {
    const reason = st?.limitedReason;
    return {
      tone: 'warn',
      status: reason ? LIMITED_COPY[reason](name) : 'Limited',
      action: off ? 'none' : reason === 'missing_permissions' || reason === 'no_page_role' ? 'reconnect' : 'menu',
    };
  }
  // not connected
  const expiredNote = o.expired || (o.pendingAt !== undefined && now - o.pendingAt > PENDING_EXPIRES_MS) ? 'That didn’t finish. Try again.' : undefined;
  if (platform === 'instagram') {
    const fbOn = o.facebook?.state === 'connected' || o.facebook?.state === 'limited';
    return {
      tone: 'faint',
      status: 'Not connected',
      note: expiredNote ?? (fbOn ? 'The chosen Facebook Page has no Instagram professional account.' : 'Connect a Facebook Page that has an Instagram professional account.'),
      action: off || fbOn ? 'none' : 'connect',
      connectAs: 'facebook',
    };
  }
  return { tone: 'faint', status: 'Not connected', ...(expiredNote ? { note: expiredNote } : {}), action: off ? 'none' : 'connect' };
}

function PlatformIcon({ platform }: { platform: ConnectPlatform }) {
  if (platform === 'facebook' || platform === 'instagram' || platform === 'linkedin' || platform === 'tiktok' || platform === 'x' || platform === 'youtube')
    return <PlatformMark platform={platform} size={20} />;
  const icon = platform === 'pinterest' ? <Pin /> : platform === 'google_search_console' ? <Search /> : platform === 'google_ads' || platform === 'microsoft_ads' ? <Target /> : <BarChart3 />;
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-surface-3 text-ink-2 [&>svg]:size-3.5" aria-hidden="true">
      {icon}
    </span>
  );
}

export function ConnectedAccounts() {
  const connections = useAnalytics((s) => s.connections);
  const enabled = useAnalytics((s) => s.connectionsEnabled);
  const loaded = useAnalytics((s) => s.connectionsLoaded);
  const hint = useAnalytics((s) => s.connectionsHint);
  const error = useAnalytics((s) => s.connectionsError);
  const pending = useAnalytics((s) => s.pending);
  const expired = useAnalytics((s) => s.expired);
  const byPlatform = useMemo(() => {
    const m: Partial<Record<ConnectPlatform, ConnectionStatus>> = {};
    for (const c of connections) m[c.platform] = c;
    return m;
  }, [connections]);

  // fresh on open and whenever the tab comes back into view
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    const refresh = () => void useAnalytics.getState().refreshConnections();
    refresh();
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  // a network that just connected with more than one Page or account: ask which one to use
  const [choose, setChoose] = useState<ConnectPlatform | null>(null);
  const prev = useRef(byPlatform);
  useEffect(() => {
    const before = prev.current;
    prev.current = byPlatform;
    for (const c of connections) {
      const was = before[c.platform]?.state;
      if (c.state === 'connected' && was !== 'connected' && (c.targetsAvailable ?? 0) > 1 && !c.targetLabel) {
        setChoose(c.platform);
        break;
      }
    }
  }, [byPlatform, connections]);

  if (__ARTIFACT_BUILD__) {
    return (
      <Callout tone="info" title="Connected accounts and live analytics need the full app.">
        This version can’t connect accounts. Post yourself, then mark posts as posted.
      </Callout>
    );
  }

  const row = (p: ConnectPlatform) => <AccountRow key={p} platform={p} status={byPlatform[p]} view={rowView(p, byPlatform[p], { enabled, pendingAt: pending[p], expired: expired[p], facebook: byPlatform.facebook })} onChoose={() => setChoose(p)} />;

  return (
    <div className="flex flex-col gap-6">
      {hint && (
        <Callout tone="warn" title="Not set up yet">
          {hint}
        </Callout>
      )}
      {loaded && !enabled && <Callout tone="info">Connecting accounts is coming soon. You can still post yourself and mark posts as posted.</Callout>}
      {error && (
        <p role="alert" className="text-small text-bad">
          {error}
        </p>
      )}
      <SettingsSection
        title="Social"
        description="Post from the app and see your own stats."
        actions={
          <InfoTip label="How connecting works" title="How connecting works">
            Connect opens the network’s own sign-in in a new tab. You choose what to allow there; the app never sees your password. Disconnecting here stops the app using the account; to remove access completely, also remove the app in the network’s own settings.
          </InfoTip>
        }
      >
        {SOCIAL.map(row)}
      </SettingsSection>
      <SettingsSection title="Ads" description="See your own ad results. The app reads them only and never changes your ads.">
        {ADS.map(row)}
      </SettingsSection>
      <SettingsSection title="Google Search Console" description="For pages on your own domain. Pages on the app’s address need no connection.">
        {SEARCH.map(row)}
      </SettingsSection>
      {choose && <ChooseTarget platform={choose} onClose={() => setChoose(null)} />}
    </div>
  );
}

function AccountRow({ platform, status, view, onChoose }: { platform: ConnectPlatform; status?: ConnectionStatus; view: RowView; onChoose: () => void }) {
  const name = PLATFORM_NAMES[platform];
  const [busy, setBusy] = useState(false);
  const target = status?.targetLabel ? `${status.targetLabel}${status.targetKind && TARGET_KIND[status.targetKind] ? ` (${TARGET_KIND[status.targetKind]})` : ''}` : undefined;
  const act = async (fn: () => Promise<{ ok: boolean; message?: string }>, failTitle: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok && r.message) toast({ title: failTitle, body: r.message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const s = useAnalytics.getState;
  const connect = () => void act(() => s().connectPlatform(view.connectAs ?? platform), `Couldn’t start connecting ${name}`);
  const reconnect = () => void act(() => s().connectPlatform(platform, 'reconnect'), `Couldn’t start reconnecting ${name}`);
  const check = () => void act(() => s().checkPlatform(platform), `Couldn’t check ${name}`);
  const disconnect = async () => {
    const where = APP_SETTINGS[platform] ?? name;
    const ok = await confirmAction({
      title: `Disconnect ${name}?`,
      body: `Posting there goes back to manual. This doesn’t remove access inside ${where}; do that in ${where}’s settings.`,
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (ok) await act(() => s().disconnectPlatform(platform), `Couldn’t disconnect ${name}`);
  };

  const menu: MenuEntry[] = [
    ...((status?.targetsAvailable ?? 0) > 1 ? [{ label: platform === 'facebook' ? 'Choose page' : 'Choose account', icon: <ArrowLeftRight />, onSelect: onChoose }] : []),
    { label: 'Check connection', icon: <RefreshCw />, onSelect: check },
    'separator',
    { label: 'Disconnect', icon: <Unplug />, danger: true, onSelect: () => void disconnect() },
  ];

  let action: ReactNode = null;
  if (view.action === 'connect')
    action = (
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={connect}>
        {busy && <Spinner size={14} />}
        Connect
      </button>
    );
  else if (view.action === 'reconnect')
    action = (
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={reconnect}>
        {busy && <Spinner size={14} />}
        Reconnect
      </button>
    );
  else if (view.action === 'check')
    action = (
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={check}>
        {busy && <Spinner size={14} />}
        Check
      </button>
    );
  else if (view.action === 'menu') action = <MoreMenu label={`${name} actions`} items={menu} />;

  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 items-center gap-2.5">
          <PlatformIcon platform={platform} />
          <span className="truncate">{platform === 'facebook' ? 'Facebook Page' : name}</span>
        </span>
      }
      description={[target, view.note].filter(Boolean).join(' · ') || undefined}
    >
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-3" data-platform={platform} data-state={status?.state ?? 'not_connected'}>
        {view.comingSoon ? <Badge>Coming soon</Badge> : <StatusDot tone={view.tone}>{view.status}</StatusDot>}
        {action}
      </span>
    </SettingsRow>
  );
}

/** "Choose which Page to use": the targets fetched fresh from the server (ids are opaque handles). */
function ChooseTarget({ platform, onClose }: { platform: ConnectPlatform; onClose: () => void }) {
  const name = PLATFORM_NAMES[platform];
  const [targets, setTargets] = useState<ConnectTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    getTargets(platform)
      .then((r) => live && setTargets(Array.isArray(r.targets) ? r.targets : []))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Couldn’t load the list.'));
    return () => {
      live = false;
    };
  }, [platform]);
  const save = async () => {
    if (!picked || saving) return;
    setSaving(true);
    try {
      const { connection } = await setTarget(platform, picked);
      useAnalytics.setState((s) => ({ connections: [...s.connections.filter((c) => c.platform !== platform), connection] }));
      toast({ title: `${name}: ${connection.targetLabel ?? 'chosen'}`, kind: 'success' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t save that choice.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={platform === 'facebook' ? 'Choose which Page to use' : `Choose which ${name} account to use`}
      subtitle="Posts and stats use this one. You can change it later."
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!picked || saving} onClick={() => void save()}>
            {saving && <Spinner size={14} />}
            Use this one
          </button>
        </>
      }
    >
      {error && (
        <p role="alert" className="mb-3 text-small text-bad">
          {error}
        </p>
      )}
      {!targets && !error && (
        <p className="flex items-center gap-2 text-small text-muted">
          <Spinner size={14} /> Loading…
        </p>
      )}
      {targets && targets.length === 0 && <p className="text-small text-muted">Nothing to choose from on this account.</p>}
      {targets && targets.length > 0 && (
        <OptionCards
          aria-label={platform === 'facebook' ? 'Pages' : 'Accounts'}
          columns={1}
          value={picked}
          onChange={setPicked}
          options={targets.map((t) => ({ value: t.id, title: t.label, description: t.kind && TARGET_KIND[t.kind] ? TARGET_KIND[t.kind] : undefined }))}
        />
      )}
    </Modal>
  );
}
