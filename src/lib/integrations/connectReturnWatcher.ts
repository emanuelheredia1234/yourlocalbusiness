// Handles the browser coming back from Zernio's connect page (src/lib/integrations/connectReturn.ts): once signed in,
// a success is checked with the server right away (the account Zernio named is a hint), an error stops the waiting on
// the server and says why in our words; either way the parameters leave the address bar and Settings › Connected
// accounts opens. Nothing here sends anything twice: each return is taken once.

import { useEffect } from 'react';
import { useAuth } from '@/lib/cloud/auth';
import { navigate } from '@/lib/router';
import { useAnalytics } from '@/store/analytics';
import { toast, useUI } from '@/store/ui';
import { PLATFORM_NAMES } from '@/pages/marketing/analytics/links';
import { connectErrorMessage, takeConnectReturn, type ConnectReturn } from './connectReturn';

/** Act on a connect return (exported for tests). */
export async function handleConnectReturn(ret: ConnectReturn): Promise<void> {
  const a = useAnalytics.getState();
  const name = ret.platform ? PLATFORM_NAMES[ret.platform] : 'The account';
  useUI.getState().setSettingsTab('accounts');
  void navigate('workspace-settings', { force: true });
  if (ret.kind === 'error') {
    if (ret.platform) await a.abandonPlatform(ret.platform, ret.reason);
    // the owner is told what to fix for the team-level reasons (known once the server has said who the owner is)
    await a.loadOwner().catch(() => undefined);
    toast({ kind: 'error', title: `${name} didn’t connect`, body: connectErrorMessage(ret.reason, name, useAnalytics.getState().owner === true) });
    return;
  }
  if (!ret.platform) {
    await a.refreshConnections();
    return;
  }
  const out = await a.checkPlatform(ret.platform, ret.accountId ? { accountId: ret.accountId } : {});
  await useAnalytics.getState().refreshConnections();
  const now = useAnalytics.getState().connections.find((c) => c.platform === ret.platform);
  if (now?.state === 'connected') toast({ kind: 'success', title: `${name} connected`, ...(now.targetLabel ? { body: now.targetLabel } : {}) });
  else if (!out.ok) toast({ kind: 'error', title: `Couldn’t check ${name}`, body: out.message });
  else toast({ kind: 'info', title: `Still waiting for ${name}`, body: 'It can take a minute. Press Check on its row.' });
}

/** Mounted once in the app: handles a connect return after sign-in. */
export function useConnectReturnWatcher(): void {
  const phase = useAuth((s) => s.phase);
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    if (phase !== 'ready' && phase !== 'off' && phase !== 'guest') return;
    const ret = takeConnectReturn();
    if (ret) void handleConnectReturn(ret);
  }, [phase]);
}
