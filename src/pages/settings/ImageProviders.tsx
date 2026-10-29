import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, ImagePlus, KeyRound, Plug, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pingServer, serverBase } from '@/ai/claude';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Field, Spinner } from '@/components/ui/primitives';

interface ProviderRow {
  id: string;
  label: string;
  configured: boolean;
  source: '' | 'app' | 'env';
  keyHint: string;
  model: string;
  baseUrl: string;
  defaultModel: string;
  defaultBaseUrl: string;
  keyUrl: string;
  note: string;
  active: boolean;
}
interface ProvidersResponse {
  active: string;
  providers: ProviderRow[];
  canManage?: boolean;
}

/** Settings → AI engine → Image generation: keys for Meta Muse Image, OpenAI or any OpenAI-compatible host, kept on your server. */
export function ImageProviders() {
  const serverUrl = useStore((s) => s.settings.ai.serverUrl);
  const base = serverBase(serverUrl);
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [adminToken, setAdminToken] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/image/providers`);
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as ProvidersResponse);
      setStatus('ready');
    } catch {
      setStatus('offline');
    }
  }, [base]);

  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    void load();
  }, [load]);

  if (__ARTIFACT_BUILD__) {
    return (
      <Note icon={<ImagePlus size={16} />} title="Image generation">
        In this claude.ai app, <b>Photo</b> images are made by Manus through your Zapier connector (each image is a Manus task, a few minutes, using your Manus credits), and <b>Illustration</b> images are drawn by Claude with no setup. Facebook posts can also be scheduled for real by Manus from any Facebook post. The self-hosted version can use your own image API key (Meta Muse Image, OpenAI…) instead.
      </Note>
    );
  }

  const call = async (method: string, path: string, body?: unknown): Promise<{ ok: boolean; json: Record<string, unknown> | null; status: number }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(adminToken ? { 'x-admin-token': adminToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    if (!res) return { ok: false, json: { error: 'Could not reach your server.' }, status: 0 };
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, json, status: res.status };
  };

  const after = async (r: { ok: boolean; json: Record<string, unknown> | null }, success: string) => {
    if (!r.ok) {
      toast({ kind: 'error', title: 'Couldn’t save', body: String(r.json?.error ?? 'Please try again.') });
      return false;
    }
    if (r.json && Array.isArray(r.json.providers)) setData((d) => ({ ...(r.json as unknown as ProvidersResponse), canManage: d?.canManage }));
    else await load();
    await pingServer(serverUrl);
    toast({ kind: 'success', title: success });
    return true;
  };

  return (
    <section className="panel p-4 sm:p-5" aria-label="Image generation">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-title flex items-center gap-2">
            <ImagePlus size={17} className="text-primary" /> Image generation
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">Photo-realistic images for posts and listings. Keys stay on your server and are never sent back to the browser. Illustrations (drawn by Claude) need no key.</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {status === 'loading' && (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={14} /> Checking your server…
        </p>
      )}
      {status === 'offline' && (
        <Note icon={<Plug size={16} />} title="Your server isn’t running">
          Start it with <code className="rounded bg-surface-2 px-1">npm run server</code> (or <code className="rounded bg-surface-2 px-1">META_MODEL_API_KEY=… npm run server</code>), then press Refresh. During development, <code className="rounded bg-surface-2 px-1">npm run dev</code> forwards <code className="rounded bg-surface-2 px-1">/api</code> to it.
        </Note>
      )}
      {status === 'ready' && data && (
        <div className="flex flex-col gap-3">
          {data.canManage === false && (
            <div className="rounded-md border border-line bg-surface-2/60 p-3 text-[13px]">
              <p className="flex items-center gap-1.5 font-semibold">
                <ShieldCheck size={15} className="text-primary" /> Changing keys from another computer
              </p>
              <p className="mt-1 text-muted">For safety, keys can only be changed from the machine running the server. To manage them remotely, start the server with ADMIN_TOKEN set and enter it here.</p>
              <Field label="Admin token" htmlFor="img-admin" className="mt-2 max-w-sm">
                <input id="img-admin" type="password" autoComplete="off" className="input" value={adminToken} onChange={(e) => setAdminToken(e.target.value)} />
              </Field>
            </div>
          )}
          {data.providers.map((p) => (
            <ProviderCard
              key={p.id}
              p={p}
              onSave={async (patch) => after(await call('PUT', `/api/image/providers/${p.id}`, patch), `${p.label} saved`)}
              onRemove={async () => after(await call('DELETE', `/api/image/providers/${p.id}`), `${p.label} key removed`)}
              onActivate={async () => after(await call('POST', '/api/image/active', { id: p.id }), `Now using ${p.label}`)}
              onTest={async () => {
                const r = await call('POST', '/api/image/test', { id: p.id });
                const ok = r.ok && r.json?.ok === true;
                toast({ kind: ok ? (r.json?.modelListed === false ? 'info' : 'success') : 'error', title: ok ? `${p.label} is ready` : `${p.label} check failed`, body: String(r.json?.message ?? r.json?.error ?? '') });
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProviderCard({ p, onSave, onRemove, onActivate, onTest }: { p: ProviderRow; onSave: (patch: { apiKey?: string; model?: string; baseUrl?: string }) => Promise<boolean>; onRemove: () => Promise<boolean>; onActivate: () => Promise<boolean>; onTest: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(p.model === p.defaultModel ? '' : p.model);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl === p.defaultBaseUrl ? '' : p.baseUrl);
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'remove' | 'use'>('');
  const custom = p.id === 'custom';
  const dirty = !!key.trim() || model !== (p.model === p.defaultModel ? '' : p.model) || baseUrl !== (p.baseUrl === p.defaultBaseUrl ? '' : p.baseUrl);
  const wrap = (k: typeof busy, fn: () => Promise<unknown>) => async () => {
    setBusy(k);
    try {
      await fn();
    } finally {
      setBusy('');
    }
  };
  return (
    <article className={cn('rounded-lg border p-3', p.active ? 'border-primary bg-primary-soft/40' : 'border-line')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
            {p.label}
            {p.id === 'meta' && <span className="badge bg-surface-2 text-ink-2">Default</span>}
            {p.active && (
              <span className="badge bg-primary text-on-primary">
                <Check size={11} /> In use
              </span>
            )}
          </p>
          <p className="text-xs text-muted">
            {p.configured ? (
              <>
                <KeyRound size={11} className="mr-1 inline" />
                Key {p.keyHint} {p.source === 'env' ? '(from the server’s environment)' : '(added here)'} · model <span className="font-mono">{p.model}</span>
              </>
            ) : (
              'No key yet'
            )}
            {p.note ? ` · ${p.note}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {p.configured && !p.active && (
            <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={wrap('use', onActivate)}>
              {busy === 'use' ? <Spinner size={13} /> : <Check size={13} />} Use this one
            </button>
          )}
          {p.configured && (
            <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={wrap('test', onTest)}>
              {busy === 'test' ? <Spinner size={13} /> : <ShieldCheck size={13} />} Test
            </button>
          )}
          {p.source === 'app' && (
            <button className="btn btn-ghost btn-sm text-muted hover:text-bad" disabled={!!busy} onClick={wrap('remove', onRemove)} aria-label={`Remove ${p.label} key`}>
              {busy === 'remove' ? <Spinner size={13} /> : <Trash2 size={13} />}
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Field label={p.configured ? 'Replace API key' : 'API key'} htmlFor={`k-${p.id}`}>
          <input id={`k-${p.id}`} type="password" autoComplete="off" spellCheck={false} className="input font-mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.configured ? p.keyHint : 'Paste your key'} />
        </Field>
        <Field label="Model" htmlFor={`m-${p.id}`}>
          <input id={`m-${p.id}`} className="input font-mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder={p.defaultModel || 'model-name'} />
        </Field>
        {custom && (
          <Field label="Base URL" htmlFor={`b-${p.id}`} hint="The API root, e.g. https://api.example.com/v1 (it must serve POST /images/generations)." className="sm:col-span-2">
            <input id={`b-${p.id}`} className="input font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
          </Field>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary btn-sm"
          disabled={!dirty || !!busy}
          onClick={wrap('save', async () => {
            const ok = await onSave({ ...(key.trim() ? { apiKey: key.trim() } : {}), model: model.trim(), ...(custom ? { baseUrl: baseUrl.trim() } : {}) });
            if (ok) setKey('');
          })}
        >
          {busy === 'save' ? <Spinner size={13} /> : <KeyRound size={13} />} Save
        </button>
        {p.keyUrl && (
          <a className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" href={p.keyUrl} target="_blank" rel="noopener noreferrer">
            Get a key <ExternalLink size={11} />
          </a>
        )}
      </div>
    </article>
  );
}

function Note({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="panel flex gap-3 p-4 text-[13px]">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-primary">{icon}</span>
      <div className="min-w-0">
        <p className="font-semibold text-ink">{title}</p>
        <p className="mt-0.5 leading-relaxed text-muted">{children}</p>
      </div>
    </section>
  );
}
