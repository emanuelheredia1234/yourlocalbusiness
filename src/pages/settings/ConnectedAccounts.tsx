// Settings › Connected accounts: each social network and ad account, with its state and the one action that fits
// it. Accounts connect through Zernio's secure, branded sign-in (the server asks for the link; it opens in a new
// tab and is never kept); the row then waits for the network. Each business picks which account it uses.
// Other integrations (Nango: future booking tools and CRMs) show only when the owner has set them up.
// Nothing here posts or changes anything at the network.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight, BarChart3, CalendarClock, Pin, Plug, RefreshCw, Target, Unplug } from 'lucide-react';
import type { ConnectPlatform, ConnectionStatus, LimitedReason, NangoIntegration, NangoResponse, Target as ConnectTarget } from '@/lib/integrations/types';
import { AD_PLATFORMS, PHASE2_PLATFORMS, SOCIAL_PLATFORMS } from '@/lib/integrations/types';
import { connectNango, disconnectNango, getNangoIntegrations, getTargets, setTarget } from '@/lib/integrations/api';
import { useAnalytics, PENDING_EXPIRES_MS } from '@/store/analytics';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import { Badge, Callout, InfoTip, Modal, MoreMenu, OptionCards, SettingsRow, SettingsSection, Spinner, StatusDot, confirmAction, type MenuEntry } from '@/components/ui/primitives';
import { PLATFORM_NAMES } from '@/pages/marketing/analytics/links';

const SOCIAL: readonly ConnectPlatform[] = SOCIAL_PLATFORMS;
const ADS: readonly ConnectPlatform[] = AD_PLATFORMS;

/** Where each network's own app settings are (Disconnect doesn't remove access there). */
const APP_SETTINGS: Partial<Record<ConnectPlatform, string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  meta_ads: 'Facebook',
  linkedin: 'LinkedIn',
  linkedin_ads: 'LinkedIn',
  tiktok: 'TikTok',
  tiktok_ads: 'TikTok',
  x: 'X',
  x_ads: 'X',
  youtube: 'your Google account',
  google_ads: 'your Google account',
  pinterest_ads: 'Pinterest',
  reddit_ads: 'Reddit',
  microsoft_ads: 'your Microsoft account',
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
  tt_account: 'Account',
  x_account: 'Account',
};

export type RowAction = 'connect' | 'reconnect' | 'check' | 'menu' | 'none';
export interface RowView {
  tone: 'good' | 'warn' | 'faint';
  status: string;
  /** a plain line under the name (the reason, or what to do) */
  note?: string;
  action: RowAction;
  comingSoon?: boolean;
}

/** What a row shows, from the server's status and what this browser knows (a connect window opened here). */
export function rowView(
  platform: ConnectPlatform,
  st: ConnectionStatus | undefined,
  o: { enabled: boolean; pendingAt?: number; expired?: boolean; now?: number },
): RowView {
  const name = PLATFORM_NAMES[platform];
  if (PHASE2_PLATFORMS.includes(platform) || st?.state === 'coming_soon') return { tone: 'faint', status: 'Coming soon', action: 'none', comingSoon: true };
  const state = st?.state ?? 'not_connected';
  const off = !o.enabled;
  const now = o.now ?? Date.now();
  const waiting = state === 'pending' || (state === 'not_connected' && o.pendingAt !== undefined && now - o.pendingAt <= PENDING_EXPIRES_MS);
  if (waiting && !off) return { tone: 'faint', status: `Waiting for ${name}…`, note: 'Finish in the tab that opened, then come back.', action: 'check' };
  if (state === 'connected') {
    if (st?.expiresSoon) return { tone: 'warn', status: 'Expires soon', note: `Reconnect to keep posting to ${name}.`, action: off ? 'none' : 'reconnect' };
    return { tone: 'good', status: 'Connected', action: off ? 'none' : 'menu' };
  }
  if (state === 'needs_reconnect') return { tone: 'warn', status: 'Reconnect needed', note: `${name} asked to sign in again.`, action: off ? 'none' : 'reconnect' };
  if (state === 'limited') {
    const reason = st?.limitedReason;
    return {
      tone: 'warn',
      status: 'Limited',
      ...(reason ? { note: LIMITED_COPY[reason](name) } : {}),
      action: off ? 'none' : reason === 'missing_permissions' || reason === 'no_page_role' ? 'reconnect' : 'menu',
    };
  }
  // not connected
  const expiredNote = o.expired || (o.pendingAt !== undefined && now - o.pendingAt > PENDING_EXPIRES_MS) ? 'That didn’t finish. Try again.' : undefined;
  if (platform === 'x_ads' && !expiredNote) return { tone: 'faint', status: 'Not connected', note: 'Connect X first, then X Ads.', action: off ? 'none' : 'connect' };
  return { tone: 'faint', status: 'Not connected', ...(expiredNote ? { note: expiredNote } : {}), action: off ? 'none' : 'connect' };
}

function PlatformIcon({ platform }: { platform: ConnectPlatform }) {
  if (platform === 'facebook' || platform === 'instagram' || platform === 'linkedin' || platform === 'tiktok' || platform === 'x' || platform === 'youtube')
    return <PlatformMark platform={platform} size={20} />;
  const icon = platform === 'pinterest' || platform === 'pinterest_ads' ? <Pin /> : platform === 'google_ads' || platform === 'microsoft_ads' || platform === 'reddit_ads' ? <Target /> : <BarChart3 />;
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

  const row = (p: ConnectPlatform) => <AccountRow key={p} platform={p} status={byPlatform[p]} view={rowView(p, byPlatform[p], { enabled, pendingAt: pending[p], expired: expired[p] })} onChoose={() => setChoose(p)} />;

  return (
    <div className="flex flex-col gap-6">
      {hint && (
        <Callout tone="warn" title="Owner setup">
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
            Connect opens a secure sign-in in a new tab, then the network’s own sign-in. You choose what to allow there; the app never sees your password. Each business uses the account you choose for it. Disconnecting here stops the app using the account; to remove access completely, also remove the app in the network’s own settings.
          </InfoTip>
        }
      >
        {SOCIAL.map(row)}
      </SettingsSection>
      <SettingsSection title="Ads" description="See your own ad results. The app reads them only and never changes your ads.">
        {ADS.map(row)}
      </SettingsSection>
      <OtherIntegrations />
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
  const connect = () => void act(() => s().connectPlatform(platform), `Couldn’t start connecting ${name}`);
  const reconnect = () => void act(() => s().connectPlatform(platform, 'reconnect'), `Couldn’t start reconnecting ${name}`);
  const check = () => void act(() => s().checkPlatform(platform), `Couldn’t check ${name}`);
  const disconnect = async () => {
    const where = APP_SETTINGS[platform] ?? name;
    const ok = await confirmAction({
      title: `Disconnect ${name}?`,
      body: `Every business that uses this account stops using it, and posting there goes back to manual. This doesn’t remove access inside ${where}; do that in ${where}’s settings.`,
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (ok) await act(() => s().disconnectPlatform(platform), `Couldn’t disconnect ${name}`);
  };

  const menu: MenuEntry[] = [
    ...((status?.targetsAvailable ?? 0) > 1 ? [{ label: platform === 'facebook' ? 'Choose Page for this business' : 'Choose account for this business', icon: <ArrowLeftRight />, onSelect: onChoose }] : []),
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
      const { connection } = await setTarget(platform, picked, useStore.getState().activeProjectId ?? undefined);
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
      subtitle="This business’s posts and stats use this one. You can change it later."
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

/**
 * Other integrations through Nango (future booking tools and CRMs). Nothing shows until the owner turns Nango on
 * and lists an integration; the owner alone sees the setup hint.
 */
function OtherIntegrations() {
  const [data, setData] = useState<NangoResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    getNangoIntegrations()
      .then(setData)
      .catch(() => setData(null));
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    void load();
  }, []);
  if (!data?.enabled) return null;
  const list = Array.isArray(data.integrations) ? data.integrations : [];
  if (!list.length && !data.hint) return null;
  const run = async (key: string, fn: () => Promise<unknown>, failTitle: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      toast({ title: failTitle, body: e instanceof Error ? e.message : 'Try again shortly.', kind: 'error' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsSection title="Other integrations" description="Booking tools and CRMs the app can work with.">
      {data.hint && (
        <Callout tone="warn" title="Owner setup">
          {data.hint}
        </Callout>
      )}
      {list.map((i: NangoIntegration) => {
        const connected = i.state === 'connected';
        return (
          <SettingsRow
            key={i.key}
            label={
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-surface-3 text-ink-2 [&>svg]:size-3.5" aria-hidden="true">
                  {i.category === 'booking' || i.category === 'calendar' ? <CalendarClock /> : <Plug />}
                </span>
                <span className="truncate">{i.label}</span>
              </span>
            }
          >
            <span className="flex min-w-0 flex-wrap items-center justify-end gap-3" data-integration={i.key} data-state={i.state}>
              <StatusDot tone={connected ? 'good' : i.state === 'needs_reconnect' ? 'warn' : 'faint'}>{connected ? 'Connected' : i.state === 'pending' ? 'Waiting…' : i.state === 'needs_reconnect' ? 'Reconnect needed' : 'Not connected'}</StatusDot>
              {connected ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy === i.key}
                  onClick={() =>
                    void confirmAction({ title: `Disconnect ${i.label}?`, body: 'The app stops using this account. To remove access completely, also remove the app in its own settings.', confirmLabel: 'Disconnect', danger: true }).then((ok) => {
                      if (ok) void run(i.key, () => disconnectNango(i.key), `Couldn’t disconnect ${i.label}`);
                    })
                  }
                >
                  {busy === i.key && <Spinner size={14} />}
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy === i.key}
                  onClick={() =>
                    void run(
                      i.key,
                      async () => {
                        const { connectLink } = await connectNango(i.key);
                        if (typeof window !== 'undefined') window.open(connectLink, '_blank', 'noopener');
                      },
                      `Couldn’t start connecting ${i.label}`,
                    )
                  }
                >
                  {busy === i.key && <Spinner size={14} />}
                  Connect
                </button>
              )}
            </span>
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
