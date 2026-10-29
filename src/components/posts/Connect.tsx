import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { CheckCircle2, Link2 } from 'lucide-react';
import type { SocialPlatform } from '@/lib/types';
import { PLATFORMS } from '@/ai/knowledge';
import { hashStr } from '@/lib/utils';
import { useStore, getActiveProject } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Modal, Spinner } from '../ui/primitives';
import { PlatformGlyph } from './PlatformIcon';

interface ConnectReq {
  platforms: SocialPlatform[];
  resolve: (ok: boolean) => void;
}
const useConnectStore = create<{ req: ConnectReq | null; set: (r: ConnectReq | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

/** Resolve true once every platform is connected (asking the user if needed). */
export function ensureConnected(platforms: SocialPlatform[]): Promise<boolean> {
  const accounts = useStore.getState().settings.accounts;
  const missing = [...new Set(platforms)].filter((p) => !accounts[p]?.connected);
  if (!missing.length) return Promise.resolve(true);
  return new Promise((resolve) => useConnectStore.getState().set({ platforms: missing, resolve }));
}

export function openConnect(platforms: SocialPlatform[]) {
  return new Promise<boolean>((resolve) => useConnectStore.getState().set({ platforms, resolve }));
}

export function ConnectHost() {
  const req = useConnectStore((s) => s.req);
  const setReq = useConnectStore((s) => s.set);
  const accounts = useStore((s) => s.settings.accounts);
  const connect = useStore((s) => s.connectAccount);
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!req) return;
    const p = getActiveProject();
    const init: Record<string, string> = {};
    for (const pl of req.platforms) {
      const fromBrand = p?.brand.socials[pl] ?? '';
      const fallback = (p?.brand.slug || p?.brand.name || 'yourbrand').replace(/[^a-z0-9]/gi, '').toLowerCase();
      init[pl] = fromBrand.replace(/^https?:\/\/[^/]+\//, '').replace(/^@/, '') || fallback;
    }
    setHandles(init);
  }, [req]);

  if (!req) return null;
  const allDone = req.platforms.every((p) => accounts[p]?.connected);
  const close = (ok: boolean) => {
    req.resolve(ok);
    setReq(null);
  };
  return (
    <Modal
      open
      onClose={() => close(allDone)}
      size="sm"
      title="Connect your accounts"
      subtitle="Posts are scheduled to these accounts. You can disconnect anytime in Settings."
      icon={<Link2 size={18} className="text-primary" />}
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={() => close(false)}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!allDone} onClick={() => close(true)}>
            Continue
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {req.platforms.map((p) => {
          const done = accounts[p]?.connected;
          return (
            <div key={p} className="flex items-center gap-3 rounded-lg border border-line p-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: PLATFORMS[p].color }}>
                <PlatformGlyph platform={p} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold">{PLATFORMS[p].label}</p>
                {done ? (
                  <p className="text-xs text-good">Connected as @{accounts[p].handle}</p>
                ) : (
                  <input
                    className="input input-sm mt-1"
                    value={handles[p] ?? ''}
                    onChange={(e) => setHandles((h) => ({ ...h, [p]: e.target.value }))}
                    placeholder="your handle"
                    aria-label={`${PLATFORMS[p].label} handle`}
                  />
                )}
              </div>
              {done ? (
                <CheckCircle2 size={20} className="text-good" />
              ) : (
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={busy === p || !(handles[p] ?? '').trim()}
                  onClick={async () => {
                    setBusy(p);
                    await new Promise((r) => setTimeout(r, 850));
                    const handle = (handles[p] ?? '').trim().replace(/^@/, '');
                    connect(p, handle, 600 + (hashStr(handle + p) % 4200));
                    setBusy(null);
                    toast({ kind: 'success', title: `${PLATFORMS[p].label} connected`, body: `@${handle}` });
                  }}
                >
                  {busy === p ? <Spinner size={14} /> : null}
                  Connect
                </button>
              )}
            </div>
          );
        })}
        <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
          This build simulates the OAuth handshake and publishing so you can run the full workflow. Connect real platform APIs on your server for production (see README).
        </p>
      </div>
    </Modal>
  );
}
