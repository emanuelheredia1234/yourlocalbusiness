import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Brain, ChevronDown, CircleAlert, ExternalLink, FlaskConical, KeyRound, ListChecks, Plug, RefreshCw, Route, ShieldCheck, Trash2 } from 'lucide-react';
import { cn, fmtRelative } from '@/lib/utils';
import { safeStorage } from '@/lib/storage';
import { useRuntime } from '@/lib/platform';
import { authHeaders, trustServer, useAuth } from '@/lib/cloud/auth';
import { ADMIN_TOKEN_KEY, pingServer, serverBase } from '@/ai/claude';
import { AI_FUNCTIONS, AI_FUNCTION_GROUPS, type AIKind } from '@/ai/functions';
import { fmtTokens, fmtUsdSmall } from '@/ai/meta';
import { countersNote, limitPercent, ownKeyCapability, parseMyKeys, requestsInUse, resetLabel, type CountersProblem, type MyKeys, type OwnKeyProvider } from '@/ai/usageLimits';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Field, Popover, Spinner, Toggle, confirmAction } from '@/components/ui/primitives';
import { SlackCard } from './SlackCard';

// ───────────── what the server sends ─────────────

interface EffortOption {
  id: string;
  label: string;
  note: string;
}
interface KindInfo {
  field: string;
  defaultModel: string;
  models: { id: string; label: string; efforts: EffortOption[]; defaultEffort: string }[];
  efforts: EffortOption[];
  aspects: string[] | null;
  durations: number[] | null;
}
interface CatalogProvider {
  id: string;
  label: string;
  keyUrl: string;
  note: string;
  envKeys: string[];
  functions: Record<string, { ok: boolean; reason: string }>;
  kinds: Partial<Record<AIKind, KindInfo>>;
}
interface ProviderState {
  id: string;
  configured: boolean;
  source: '' | 'app' | 'secrets';
  envKey: string;
  keyHint: string;
  ready: boolean;
  enabled: boolean;
  functions: string[];
  models: Record<string, string>;
  effort: Record<string, string>;
}
interface AIState {
  order: string[];
  providers: ProviderState[];
  routing: Record<string, string[]>;
  canManage: boolean;
  adminTokenSet: boolean;
  imported: boolean;
  /** where keys typed here are kept: 'supabase' survives restarts, 'disk' only this server's files */
  storage?: 'supabase' | 'disk';
  /** the host wipes its files when the app restarts (Replit's published apps, Vercel) */
  ephemeralDisk?: boolean;
  accounts?: boolean;
  /** why Supabase isn't keeping the settings right now */
  storageProblem?: { code: string; message: string } | null;
  supabaseUrlSet?: boolean;
}
interface CompareResult {
  provider: string;
  model: string;
  field: string;
  results: { effort: string; effortLabel: string; ok: boolean; ms?: number; usage?: { input: number; output: number; reasoning: number | null }; cost?: { usd: number; source: string } | null; error?: string; answer?: string }[];
}
interface UsageEntry {
  id: string;
  at: number;
  ok: boolean;
  pending?: boolean;
  provider: string;
  fn: string;
  kind: string;
  model: string;
  effort: string;
  ms: number;
  usage?: { input: number; output: number; reasoning: number | null } | null;
  cost?: { usd: number; source: string } | null;
  credits?: number | null;
  error?: string;
}
interface UsageTotals {
  providers: { provider: string; requests: number; failed: number; costUsd: number; credits: number; inputTokens: number; outputTokens: number; reasoningTokens: number }[];
}

const KIND_TITLE: Record<AIKind, string> = { text: 'Writing', image: 'Photos', video: 'Videos', agent: 'Agent tasks' };
const ADMIN_KEY = ADMIN_TOKEN_KEY;

function effortTitle(providerId: string, kind: AIKind): string {
  if (providerId === 'manus') return 'Agent profile';
  return kind === 'text' ? 'Effort' : kind === 'video' ? 'Quality (resolution)' : 'Quality';
}

/** The page's copy of the settings with a change applied before the server confirms it. */
function optimistic(s: AIState, id: string | null, body: Record<string, unknown>): AIState {
  if (!id) return Array.isArray(body.order) ? { ...s, order: body.order as string[] } : s;
  return {
    ...s,
    providers: s.providers.map((p) =>
      p.id !== id
        ? p
        : {
            ...p,
            ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
            ...(Array.isArray(body.functions) ? { functions: body.functions as string[] } : {}),
            ...(body.effort && typeof body.effort === 'object' ? { effort: { ...p.effort, ...(body.effort as Record<string, string>) } } : {}),
            ...(body.models && typeof body.models === 'object' ? { models: { ...p.models, ...(body.models as Record<string, string>) } } : {}),
          },
    ),
  };
}

/** Functions a kind serves, for showing which settings are in use. */
const kindFunctions = (kind: AIKind) => AI_FUNCTIONS.filter((f) => f.kind === kind).map((f) => f.id);

// ───────────── server calls ─────────────

function useAIServer() {
  const serverUrl = useStore((s) => s.settings.ai.serverUrl);
  const base = serverBase(serverUrl);
  const [adminToken, setAdminTokenState] = useState(() => safeStorage.getItem(ADMIN_KEY) || '');
  // every request reads the newest token, so a check started before you unlocked can't use the old one
  const token = useRef(adminToken);
  const setAdminToken = (t: string) => {
    token.current = t;
    setAdminTokenState(t);
    if (t) safeStorage.setItem(ADMIN_KEY, t);
    else safeStorage.removeItem(ADMIN_KEY);
  };
  const call = useCallback(
    async <T,>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: (T & { error?: string; code?: string }) | null }> => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token.current ? { 'x-admin-token': token.current } : {}), ...(await authHeaders(`${base}${path}`)) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(() => null);
      if (!res) return { ok: false, status: 0, json: { error: 'Couldn’t reach your AI server.' } as T & { error: string } };
      const json = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
      return { ok: res.ok, status: res.status, json };
    },
    [base],
  );
  return { call, adminToken, setAdminToken, serverUrl };
}

// ───────────── page ─────────────

/** Settings → AI (self-hosted): one AI, powered by your API keys. */
export function AIProviders() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setAI = (patch: Partial<typeof settings.ai>) => updateSettings((s) => ({ ...s, ai: { ...s.ai, ...patch } }));
  const { call, adminToken, setAdminToken, serverUrl } = useAIServer();
  const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null);
  const [state, setState] = useState<AIState | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'offline'>('loading');
  // with accounts on, only the owner manages keys; everyone else sees what powers the app
  const [role, setRole] = useState<'admin' | 'user'>('admin');
  const accounts = useAuth((s) => s.phase === 'ready');
  const [usage, setUsage] = useState<{ recent: UsageEntry[]; totals: UsageTotals } | null>(null);
  const [usageLocked, setUsageLocked] = useState(false);
  const saves = useRef(0);
  const [usageTick, setUsageTick] = useState(0);

  const loadUsage = useCallback(async () => {
    const r = await call<{ recent: UsageEntry[]; totals: UsageTotals }>('GET', '/api/ai/usage?limit=25');
    setUsageLocked(r.status === 403);
    if (r.ok && r.json) setUsage({ recent: r.json.recent, totals: r.json.totals });
  }, [call]);

  const loads = useRef(0);
  const load = useCallback(async () => {
    const n = ++loads.current;
    const r = await call<{ catalog: CatalogProvider[]; state: AIState | null; role?: 'admin' | 'user' }>('GET', '/api/ai/providers');
    // only the newest check counts
    if (n !== loads.current) return;
    if (!r.ok || !r.json?.catalog) {
      setStatus('offline');
      return;
    }
    setCatalog(r.json.catalog);
    setState(r.json.state);
    setRole(r.json.role === 'user' && !r.json.state ? 'user' : 'admin');
    setStatus('ready');
    if (r.json.state) void loadUsage();
  }, [call, loadUsage]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Apply a settings change on the server, then refresh what the rest of the app routes on. */
  const save = async (id: string | null, body: Record<string, unknown>, success?: string): Promise<boolean> => {
    // show the change right away; the server's answer (or a reload on failure) settles it
    setState((s) => (s ? optimistic(s, id, body) : s));
    const n = ++saves.current;
    const r = await call<{ state: AIState }>('PUT', id ? `/api/ai/providers/${id}` : '/api/ai/settings', body);
    // the server applied it, but couldn't keep it in Supabase: it works now, and may not last
    const notKept = r.status === 502 && r.json?.code === 'NOT_SAVED' && !!r.json?.state;
    if ((!r.ok || !r.json?.state) && !notKept) {
      toast({ kind: 'error', title: 'Couldn’t save', body: r.json?.error ?? 'Please try again.' });
      void load();
      return false;
    }
    // quick clicks: only the newest answer counts, so an older one can't undo a newer change
    if (n === saves.current && r.json?.state) setState(r.json.state);
    void pingServer(serverUrl);
    if (notKept) toast({ kind: 'error', title: 'Working now, but not kept in Supabase', body: r.json?.error ?? '' });
    else if (success) toast({ kind: 'success', title: success });
    return true;
  };

  const brainCard = (
    <section className="panel p-4 sm:p-5" aria-label="Brain">
      <div className="flex flex-wrap items-start gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink text-accent">
          <Brain size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <Toggle
            checked={settings.ai.useBrain}
            onChange={(v) => setAI({ useBrain: v })}
            label={settings.ai.useBrain ? 'Brain is on' : 'Brain is off'}
            description="One switch for every key that’s on: writing follows your Brain skills, and photos and videos get the Brain’s art direction."
          />
        </div>
      </div>
    </section>
  );

  return (
    <div className="flex flex-col gap-5">
      <section className="panel p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="section-title flex items-center gap-2">
              <KeyRound size={17} className="text-primary" /> {role === 'user' ? 'Your AI' : 'AI, powered by your keys'}
            </h2>
            <p className="mt-0.5 max-w-3xl text-[13px] text-muted">
              {role === 'user'
                ? 'The app’s owner set up the AI for everyone. Here’s what powers each part of the app.'
                : 'One AI for the whole app. Add a key, tick what it powers, and pick its model and effort: the effort is sent in that provider’s own setting, so it changes the answer and what you pay. Keys stay on your server and are never shown again.'}
            </p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </section>

      {brainCard}

      {status === 'loading' && (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={14} /> Checking your server…
        </p>
      )}
      {status === 'offline' && (
        <Note icon={<Plug size={16} />} title="Your AI server isn’t running">
          Start it with <code className="rounded bg-surface-2 px-1">npm run server</code> (on Replit, press Run), then press Refresh. Until then the built-in engine writes everything.
        </Note>
      )}

      {status === 'ready' && role === 'user' && (
        <>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <OwnKeys call={call} serverUrl={serverUrl} onChange={() => setUsageTick((n) => n + 1)} />
            <MyUsageCard call={call} refresh={usageTick} />
          </div>
          <OwnerManaged />
        </>
      )}

      {status === 'ready' && catalog && state && (
        <>
          {!state.canManage && !accounts && <AdminAccess adminTokenSet={state.adminTokenSet} token={adminToken} onToken={setAdminToken} onCheck={() => void load()} />}
          {state.canManage && state.storage === 'disk' && (state.ephemeralDisk || state.accounts) && (
            <Note icon={<CircleAlert size={16} />} title="Keys you add here can disappear">
              They’re kept in this server’s files, which {state.ephemeralDisk ? 'this host wipes' : 'hosts like Replit’s published apps wipe'} when the app restarts or sleeps. To keep them in Supabase, encrypted:{' '}
              {state.supabaseUrlSet ? (
                <>
                  add the <code className="rounded bg-surface-2 px-1">SUPABASE_SECRET_KEY</code> Secret (Supabase → Project Settings → API Keys, the <code className="rounded bg-surface-2 px-1">sb_secret_…</code> key)
                </>
              ) : (
                <>
                  add the <code className="rounded bg-surface-2 px-1">SUPABASE_URL</code> and <code className="rounded bg-surface-2 px-1">SUPABASE_SECRET_KEY</code> Secrets (Supabase → Project Settings → API)
                </>
              )}
              , run the files in <code className="rounded bg-surface-2 px-1">supabase/migrations</code> in Supabase → SQL Editor if you haven’t, and republish. Keys added as Secrets (like <code className="rounded bg-surface-2 px-1">OPENAI_API_KEY</code>) always stay.
            </Note>
          )}
          {state.canManage && state.storage === 'supabase' && state.storageProblem && (
            <Note icon={<CircleAlert size={16} />} title="Your keys aren’t being kept in Supabase right now">
              {state.storageProblem.message} Until then they live in this server’s files{state.ephemeralDisk ? ', which this host wipes when the app restarts' : ''}.
            </Note>
          )}
          {state.canManage && state.storage === 'supabase' && !state.storageProblem && (
            <p className="flex items-center gap-1.5 text-[12.5px] text-muted">
              <ShieldCheck size={14} className="text-good" /> Keys and settings are saved in your Supabase project, encrypted, so they stay through restarts.
            </p>
          )}
          {state.imported && <Note icon={<ListChecks size={16} />} title="Your image keys moved here">Keys from the old “Image generation” settings now power Photos. Tick more functions to use them for writing too.</Note>}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-3">
              <p className="text-[12.5px] text-muted">Keys are tried in this order. If one fails (outage, rate limit, no credit), the next key that powers the same function answers. Videos and agent tasks only move on when the first key certainly started nothing.</p>
              {state.order.map((id, i) => {
                const def = catalog.find((c) => c.id === id);
                const st = state.providers.find((p) => p.id === id);
                if (!def || !st) return null;
                return (
                  <KeyCard
                    key={id}
                    def={def}
                    st={st}
                    rank={i + 1}
                    first={i === 0}
                    last={i === state.order.length - 1}
                    canManage={state.canManage}
                    call={call}
                    save={(body, success) => save(id, body, success)}
                    move={(dir) => {
                      const order = [...state.order];
                      const j = i + dir;
                      [order[i], order[j]] = [order[j], order[i]];
                      void save(null, { order });
                    }}
                    onUsage={() => void loadUsage()}
                  />
                );
              })}
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <RoutingSummary state={state} catalog={catalog} />
              <UsageCard usage={usage} locked={usageLocked} catalog={catalog} onRefresh={() => void loadUsage()} />
            </div>
          </div>
          {/* Viktor (viktor.com) through the owner's own Slack app: the owner's, and self-hosted only */}
          {state.canManage && !__ARTIFACT_BUILD__ && <SlackCard call={call} serverUrl={serverUrl} />}
          {state.accounts && state.canManage && (
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
              <DailyLimitsCard call={call} />
              <PeopleUsageCard call={call} />
            </div>
          )}
        </>
      )}

      <ServerAddress />
    </div>
  );
}

/** claude.ai: Claude is the AI here; keys are for the self-hosted app. */
export function ArtifactAI() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setAI = (patch: Partial<typeof settings.ai>) => updateSettings((s) => ({ ...s, ai: { ...s.ai, ...patch } }));
  return (
    <div className="flex flex-col gap-5">
      <Note icon={<KeyRound size={16} />} title="AI in claude.ai">
        Here, Claude writes everything through your claude.ai account, photos come from Meta Muse Image and videos from HeyGen (both through OpenRouter in your Zapier connector), and Manus posts on your social accounts. To use your own API keys (OpenRouter, Google, xAI, Anthropic, Meta, Manus and OpenAI), with what each key powers and its effort, run the self-hosted app (for example on Replit) and open Settings → AI there.
      </Note>
      <section className="panel flex flex-col gap-4 p-4 sm:p-5" aria-label="Brain">
        <Toggle checked={settings.ai.useBrain} onChange={(v) => setAI({ useBrain: v })} label={settings.ai.useBrain ? 'Brain is on' : 'Brain is off'} description="Writing follows your Brain skills, and photos and videos get the Brain’s art direction." />
      </section>
    </div>
  );
}

// ───────────── one key ─────────────

type Call = ReturnType<typeof useAIServer>['call'];

function KeyCard({ def, st, rank, first, last, canManage, call, save, move, onUsage }: { def: CatalogProvider; st: ProviderState; rank: number; first: boolean; last: boolean; canManage: boolean; call: Call; save: (body: Record<string, unknown>, success?: string) => Promise<boolean>; move: (dir: -1 | 1) => void; onUsage: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const kinds = Object.keys(def.kinds) as AIKind[];
  const statusChip = !st.configured ? { text: 'No key', cls: 'bg-surface-2 text-muted' } : !st.enabled ? { text: 'Off', cls: 'bg-surface-2 text-ink-2' } : { text: 'On', cls: 'bg-good-soft text-good' };
  const locked = !canManage;

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy(true);
    const ok = await save({ apiKey: key.trim() }, `${def.label} key saved`);
    setBusy(false);
    if (ok) {
      setKey('');
      setTest(null);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setTest(null);
    const r = await call<{ ok: boolean; message?: string; error?: string }>('POST', `/api/ai/providers/${def.id}/test`, {});
    setTesting(false);
    setTest({ ok: !!r.json?.ok, text: r.json?.message || r.json?.error || 'No answer from the server.' });
  };

  return (
    <article className={cn('panel flex flex-col gap-3 p-4', st.ready ? '' : 'opacity-[0.92]')} aria-label={`${def.label} key`}>
      <header className="flex flex-wrap items-center gap-2">
        <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[12px] font-bold text-ink-2" title="Priority">
          {rank}
        </span>
        <h3 className="text-[15px] font-semibold text-ink">{def.label}</h3>
        <span className={cn('badge', statusChip.cls)}>{statusChip.text}</span>
        <span className="ml-auto flex items-center gap-1">
          <button className="btn btn-ghost btn-xs" aria-label={`Move ${def.label} up`} disabled={first || locked} onClick={() => move(-1)}>
            <ArrowUp size={13} />
          </button>
          <button className="btn btn-ghost btn-xs" aria-label={`Move ${def.label} down`} disabled={last || locked} onClick={() => move(1)}>
            <ArrowDown size={13} />
          </button>
          <Toggle checked={st.enabled} disabled={locked} onChange={(v) => void save({ enabled: v })} id={`ai-on-${def.id}`} />
        </span>
      </header>
      <p className="-mt-1 text-[12.5px] text-muted">{def.note}</p>

      {/* key */}
      {st.source === 'secrets' ? (
        <p className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2/70 px-3 py-2 text-[12.5px]">
          <ShieldCheck size={14} className="text-good" /> Key from Replit Secrets (<code>{st.envKey}</code>) <span className="num text-muted">{st.keyHint}</span>
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={st.configured ? `Saved key ${st.keyHint}` : 'API key'} htmlFor={`ai-key-${def.id}`} className="min-w-[220px] flex-1">
            <input
              id={`ai-key-${def.id}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="input"
              value={key}
              disabled={locked}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
              placeholder={st.configured ? 'Paste a new key to replace it' : `Paste your ${def.label} key`}
            />
          </Field>
          <button className="btn btn-primary btn-sm" disabled={locked || busy || !key.trim()} onClick={() => void saveKey()}>
            {busy ? <Spinner size={14} /> : null} Save key
          </button>
          {st.source === 'app' && (
            <button
              className="btn btn-ghost btn-sm text-muted hover:text-bad"
              disabled={locked}
              onClick={async () => {
                if (await confirmAction({ title: `Remove the ${def.label} key?`, body: 'Functions it powers move to your next key, or to the built-in engine.', confirmLabel: 'Remove key', danger: true })) void save({ removeKey: true }, 'Key removed');
              }}
            >
              <Trash2 size={14} /> Remove
            </button>
          )}
          <a href={def.keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 pb-2 text-[12px] font-semibold text-primary hover:underline">
            Get a key <ExternalLink size={11} />
          </a>
        </div>
      )}
      {st.source !== 'secrets' && <p className="-mt-1 text-[11.5px] text-muted">On Replit, a Secret named {def.envKeys.map((k) => <code key={k}>{k}</code>).reduce<React.ReactNode[]>((a, c, i) => (i ? [...a, ' or ', c] : [c]), [])} keeps this key through restarts and publishing.</p>}

      {/* what it powers */}
      <PowersDropdown def={def} st={st} disabled={locked} onChange={(functions) => void save({ functions })} />

      {/* model + effort per kind */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {kinds.map((kind) => (
          <KindSettings key={kind} def={def} st={st} kind={kind} disabled={locked} call={call} save={save} />
        ))}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <button className="btn btn-secondary btn-sm" disabled={!st.configured || testing || locked} onClick={() => void testKey()}>
          {testing ? <Spinner size={14} /> : <ShieldCheck size={14} />} Test key
        </button>
        {def.kinds.text && <CompareEfforts def={def} st={st} disabled={!st.configured || locked} call={call} onDone={onUsage} />}
        {test && <span className={cn('text-[12.5px] font-medium', test.ok ? 'text-good' : 'text-bad')}>{test.text}</span>}
      </footer>
    </article>
  );
}

/** The "Powers" dropdown: every function, stacked, with the ones this key can't do greyed out. */
function PowersDropdown({ def, st, disabled, onChange }: { def: CatalogProvider; st: ProviderState; disabled: boolean; onChange: (functions: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const supported = AI_FUNCTIONS.filter((f) => def.functions[f.id]?.ok).map((f) => f.id);
  const on = new Set(st.functions);
  const toggle = (id: string) => onChange(on.has(id) ? st.functions.filter((x) => x !== id) : [...st.functions, id]);
  const names = AI_FUNCTIONS.filter((f) => on.has(f.id)).map((f) => f.label);
  return (
    <div>
      <p className="label mb-1">Powers</p>
      <button ref={anchor} type="button" className="input flex h-auto min-h-[38px] w-full items-center gap-2 py-1.5 text-left" disabled={disabled} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="min-w-0 flex-1 truncate text-[13px]">{names.length ? `${names.length} of ${supported.length}: ${names.join(', ')}` : <span className="text-muted">Nothing yet: choose what this key powers</span>}</span>
        <ChevronDown size={15} className="shrink-0 text-muted" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="start" className="w-[min(440px,calc(100vw-24px))] p-2">
        <div className="mb-1 flex items-center gap-2 px-1.5 pb-1">
          <span className="text-[12px] font-semibold text-ink-2">What {def.label} powers</span>
          <button type="button" className="ml-auto text-[12px] font-semibold text-primary hover:underline" onClick={() => onChange(supported)}>
            Everything it can
          </button>
          <button type="button" className="text-[12px] font-semibold text-primary hover:underline" onClick={() => onChange([])}>
            None
          </button>
        </div>
        {AI_FUNCTION_GROUPS.map((g) => (
          <fieldset key={g.id} className="mb-1">
            <legend className="eyebrow px-1.5 pb-0.5 pt-1.5">{g.label}</legend>
            {AI_FUNCTIONS.filter((f) => f.group === g.id).map((f) => {
              const sup = def.functions[f.id];
              const id = `pw-${def.id}-${f.id}`;
              return (
                <label key={f.id} htmlFor={id} className={cn('flex items-start gap-2.5 rounded-md px-1.5 py-1.5', sup?.ok ? 'cursor-pointer hover:bg-surface-2' : 'cursor-not-allowed opacity-55')}>
                  <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--primary))]" checked={on.has(f.id)} disabled={!sup?.ok} onChange={() => toggle(f.id)} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{f.label}</span>
                    <span className="block text-[11.5px] text-muted">{sup?.ok ? f.desc : sup?.reason}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ))}
      </Popover>
    </div>
  );
}

/** Model and effort for one kind of work (writing, photos, videos, agent tasks). */
function KindSettings({ def, st, kind, disabled, call, save }: { def: CatalogProvider; st: ProviderState; kind: AIKind; disabled: boolean; call: Call; save: (body: Record<string, unknown>, success?: string) => Promise<boolean> }) {
  const info = def.kinds[kind]!;
  const model = st.models[kind] ?? info.defaultModel;
  const [live, setLive] = useState<{ id: string; label: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customModel, setCustomModel] = useState('');
  const known = info.models.find((m) => m.id === model);
  const efforts = known ? known.efforts : info.efforts;
  const effort = st.effort[kind] ?? '';
  const chosen = efforts.find((e) => e.id === effort);
  const inUse = kindFunctions(kind).some((f) => st.functions.includes(f));
  const showModelPicker = def.id !== 'manus';

  const loadModels = async () => {
    setLoading(true);
    const r = await call<{ models: { id: string; label: string }[]; source: string; error?: string }>('GET', `/api/ai/providers/${def.id}/models?kind=${kind}`);
    setLoading(false);
    if (r.ok && r.json?.models) {
      setLive(r.json.models.filter((m) => !info.models.some((b) => b.id === m.id)));
      if (r.json.error) toast({ kind: 'error', title: 'Couldn’t load the model list', body: r.json.error });
    } else toast({ kind: 'error', title: 'Couldn’t load the model list', body: r.json?.error ?? 'Please try again.' });
  };

  return (
    <section className={cn('rounded-md border border-line p-3', !inUse && 'opacity-60')} aria-label={`${def.label} ${KIND_TITLE[kind]}`}>
      <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
        {KIND_TITLE[kind]}
        {!inUse && <span className="text-[11px] font-normal text-muted">· not used: no ticked function needs it</span>}
      </p>
      <div className="flex flex-col gap-2">
        {showModelPicker && (
          <div>
            <label className="label" htmlFor={`m-${def.id}-${kind}`}>
              Model
            </label>
            {custom ? (
              <div className="flex gap-1.5">
                <input id={`m-${def.id}-${kind}`} className="input h-9 text-[13px]" value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="model id, e.g. gpt-6.1-sol" />
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={!customModel.trim() || disabled}
                  onClick={async () => {
                    if (await save({ models: { [kind]: customModel.trim() } })) setCustom(false);
                  }}
                >
                  Use
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setCustom(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <select id={`m-${def.id}-${kind}`} className="input h-9 min-w-0 flex-1 text-[13px]" value={model} disabled={disabled} onChange={(e) => (e.target.value === '__custom' ? setCustom(true) : void save({ models: { [kind]: e.target.value } }))}>
                  <optgroup label="Recommended">
                    {info.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                  {!known && !live?.some((m) => m.id === model) && <option value={model}>{model}</option>}
                  {live && live.length > 0 && (
                    <optgroup label="From your account">
                      {live.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <option value="__custom">Another model id…</option>
                </select>
                <button className="btn btn-ghost btn-sm" title="Load every model your key can use" disabled={!st.configured || loading || disabled} onClick={() => void loadModels()}>
                  {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
                </button>
              </div>
            )}
          </div>
        )}
        <div>
          <label className="label" htmlFor={`e-${def.id}-${kind}`}>
            {effortTitle(def.id, kind)}
          </label>
          {efforts.length ? (
            <select id={`e-${def.id}-${kind}`} className="input h-9 text-[13px]" value={effort} disabled={disabled} onChange={(e) => void save({ effort: { [kind]: e.target.value } })}>
              {efforts.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="rounded-md bg-surface-2 px-2.5 py-2 text-[12.5px] text-muted">Set by the model (it has no effort setting).</p>
          )}
          {chosen && (
            <p className="mt-1 text-[11.5px] text-muted">
              {chosen.note} {info.field && <span className="whitespace-nowrap">Sent as <code>{info.field}</code>.</span>}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Run one short prompt at two efforts, side by side: proof that effort changes tokens and cost. */
function CompareEfforts({ def, st, disabled, call, onDone }: { def: CatalogProvider; st: ProviderState; disabled: boolean; call: Call; onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  const info = def.kinds.text!;
  const model = st.models.text ?? info.defaultModel;
  const efforts = (info.models.find((m) => m.id === model)?.efforts ?? info.efforts).map((e) => e.id);
  const current = st.effort.text;
  const pair = efforts.length < 2 ? [] : current && current !== efforts[0] ? [efforts[0], current] : [efforts[0], efforts[efforts.length - 1]];
  if (!pair.length) return null;
  const run = async () => {
    const ok = await confirmAction({
      title: `Compare ${pair.join(' and ')} on ${def.label}?`,
      body: `This sends the same short pricing puzzle to ${model} twice, once at each effort, billed to this key (usually well under a cent; more at high effort on large models). You’ll see the time, tokens and cost of each.`,
      confirmLabel: 'Run the comparison',
    });
    if (!ok) return;
    setRunning(true);
    const r = await call<CompareResult>('POST', `/api/ai/providers/${def.id}/test`, { compare: pair });
    setRunning(false);
    if (r.ok && r.json?.results) {
      setResult(r.json);
      onDone();
    } else toast({ kind: 'error', title: 'The comparison didn’t run', body: r.json?.error ?? 'Please try again.' });
  };
  return (
    <>
      <button className="btn btn-secondary btn-sm" disabled={disabled || running} onClick={() => void run()}>
        {running ? <Spinner size={14} /> : <FlaskConical size={14} />} Compare efforts
      </button>
      {result && (
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-[12.5px]">
            <caption className="pb-1 text-left text-[11.5px] text-muted">
              {result.model}, effort sent as <code>{result.field}</code>
            </caption>
            <thead className="text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3 font-semibold">Effort</th>
                <th className="py-1 pr-3 font-semibold">Time</th>
                <th className="py-1 pr-3 font-semibold">Reasoning</th>
                <th className="py-1 pr-3 font-semibold">Output tokens</th>
                <th className="py-1 font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody className="num">
              {result.results.map((x) => (
                <tr key={x.effort} className="border-t border-line">
                  <td className="py-1.5 pr-3 font-semibold text-ink">{x.effortLabel}</td>
                  {x.ok ? (
                    <>
                      <td className="py-1.5 pr-3">{((x.ms ?? 0) / 1000).toFixed(1)}s</td>
                      <td className="py-1.5 pr-3">{x.usage?.reasoning != null ? fmtTokens(x.usage.reasoning) : 'inside output'}</td>
                      <td className="py-1.5 pr-3">{x.usage ? fmtTokens(x.usage.output) : '–'}</td>
                      <td className="py-1.5">{x.cost ? `${x.cost.source === 'estimate' ? '≈' : ''}${fmtUsdSmall(x.cost.usd)}` : '–'}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="py-1.5 text-bad">
                      {x.error}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ───────────── side panels ─────────────

function RoutingSummary({ state, catalog }: { state: AIState; catalog: CatalogProvider[] }) {
  const name = (id: string) => catalog.find((c) => c.id === id)?.label ?? id;
  return (
    <section className="panel p-4" aria-label="What powers each function">
      <h3 className="section-title mb-2 flex items-center gap-2 text-[15px]">
        <Route size={16} className="text-primary" /> What powers each function
      </h3>
      {AI_FUNCTION_GROUPS.map((g) => (
        <div key={g.id} className="mb-2">
          <p className="eyebrow mb-1">{g.label}</p>
          <ul className="flex flex-col">
            {AI_FUNCTIONS.filter((f) => f.group === g.id).map((f) => {
              const route = state.routing[f.id] ?? [];
              return (
                <li key={f.id} className="flex items-baseline gap-2 border-t border-line py-1.5 text-[12.5px] first:border-t-0">
                  <span className="min-w-0 flex-1 text-ink-2">{f.label}</span>
                  {route.length ? (
                    <span className="text-right font-semibold text-ink">
                      {name(route[0])}
                      {route.length > 1 && <span className="font-normal text-muted"> then {route.slice(1).map(name).join(', ')}</span>}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-right text-warn">
                      <CircleAlert size={12} /> {f.kind === 'text' ? 'No key: built-in engine' : 'No key: off'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function UsageCard({ usage, locked, catalog, onRefresh }: { usage: { recent: UsageEntry[]; totals: UsageTotals } | null; locked: boolean; catalog: CatalogProvider[]; onRefresh: () => void }) {
  const name = (id: string) => catalog.find((c) => c.id === id)?.label ?? id;
  const fnName = (id: string) => (id === 'test' ? 'Effort comparison' : AI_FUNCTIONS.find((f) => f.id === id)?.label ?? id);
  return (
    <section className="panel p-4" aria-label="Recent AI usage">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="section-title text-[15px]">Recent usage</h3>
        <button className="btn btn-ghost btn-xs ml-auto" onClick={onRefresh}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {!usage || !usage.recent.length ? (
        <p className="text-[12.5px] text-muted">{locked ? 'Enter the admin token above to see usage: it can show details of your provider accounts.' : 'Nothing yet. Each request your keys answer shows up here with its effort, tokens and cost.'}</p>
      ) : (
        <>
          {usage.totals.providers.length > 0 && (
            <ul className="mb-3 flex flex-col gap-1 text-[12px]">
              {usage.totals.providers.map((t) => (
                <li key={t.provider} className="num flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 font-semibold text-ink-2">{name(t.provider)}</span>
                  <span className="text-muted">
                    {t.requests} request{t.requests === 1 ? '' : 's'}
                    {t.reasoningTokens ? ` · ${fmtTokens(t.reasoningTokens)} reasoning` : ''}
                  </span>
                  <span className="font-semibold text-ink">{t.costUsd ? fmtUsdSmall(t.costUsd) : t.credits ? `${t.credits} credits` : '–'}</span>
                </li>
              ))}
              <li className="text-[11px] text-muted">Last 14 days. Costs are what the provider reported, or estimates from list prices.</li>
            </ul>
          )}
          <ul className="flex flex-col">
            {usage.recent.map((e) => (
              <li key={e.id} className="border-t border-line py-1.5 text-[12px]">
                <p className="flex items-baseline gap-2">
                  <span className={cn('min-w-0 flex-1 truncate font-semibold', e.ok ? 'text-ink' : 'text-bad')}>{fnName(e.fn)}</span>
                  <span className="num shrink-0 text-muted">{fmtRelative(e.at)}</span>
                </p>
                <p className="num truncate text-muted" title={e.error || undefined}>
                  {[name(e.provider), e.model, e.effort ? `effort ${e.effort}` : '', e.usage?.reasoning ? `${fmtTokens(e.usage.reasoning)} reasoning` : e.usage?.output ? `${fmtTokens(e.usage.output)} out` : '', e.cost ? `${e.cost.source === 'estimate' ? '≈' : ''}${fmtUsdSmall(e.cost.usd)}` : e.credits ? `${e.credits} credits` : '', e.pending ? 'running' : '', !e.ok ? e.error ?? 'failed' : '']
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AdminAccess({ adminTokenSet, token, onToken, onCheck }: { adminTokenSet: boolean; token: string; onToken: (t: string) => void; onCheck: () => void }) {
  const [value, setValue] = useState(token);
  return (
    <section className="rounded-lg border border-warn/40 bg-warn-soft/50 p-4 text-[13px]" aria-label="Admin access">
      <p className="flex items-center gap-1.5 font-semibold text-ink">
        <ShieldCheck size={15} className="text-primary" /> {adminTokenSet ? 'Enter your admin token to change AI settings' : 'AI settings are read-only from this browser'}
      </p>
      <p className="mt-1 text-ink-2">
        {adminTokenSet
          ? 'For safety, keys and settings can only be changed with the server’s admin token.'
          : 'For safety, keys and settings can only be changed from the machine running the server. On Replit: open Tools → Secrets, add a Secret named ADMIN_TOKEN with any long password, restart the app (Stop, then Run), and enter the same password here.'}
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Field label="Admin token" htmlFor="ai-admin" className="min-w-[220px] max-w-sm flex-1">
          <input id="ai-admin" type="password" autoComplete="off" className="input" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <button
          className="btn btn-primary btn-sm"
          disabled={!value.trim()}
          onClick={() => {
            onToken(value.trim());
            onCheck();
          }}
        >
          Unlock
        </button>
      </div>
    </section>
  );
}

function ServerAddress() {
  const serverUrl = useStore((s) => s.settings.ai.serverUrl);
  const updateSettings = useStore((s) => s.updateSettings);
  const [testing, setTesting] = useState(false);
  return (
    <details className="panel p-4 text-[13px]">
      <summary className="cursor-pointer font-semibold text-ink">Advanced: AI server address</summary>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Server URL" htmlFor="ai-url" hint="Leave blank when the app and the server run together (the usual setup, including Replit). For a separate server, press Test connection: that lets it know who’s signed in." className="min-w-[240px] flex-1">
          <input id="ai-url" className="input" value={serverUrl} onChange={(e) => updateSettings((s) => ({ ...s, ai: { ...s.ai, serverUrl: e.target.value.trim() } }))} placeholder="https://your-server.example.com" />
        </Field>
        <button
          className="btn btn-secondary"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            // choosing this server: it may now receive your sign-in (only this account, on this device)
            if (serverUrl) trustServer(serverUrl);
            const ok = await pingServer(serverUrl);
            setTesting(false);
            toast(ok ? { kind: 'success', title: 'Server is reachable' } : { kind: 'error', title: 'Couldn’t reach the server', body: 'Check the URL and that the server is running.' });
          }}
        >
          {testing ? <Spinner size={14} /> : <RefreshCw size={14} />} Test connection
        </button>
      </div>
    </details>
  );
}

// ───────────── signed-in users: their own keys and usage ─────────────

interface DayRow {
  day: string;
  requests: number;
  usd: number;
  ownRequests: number;
  ownUsd: number;
}
type LimitStatus = { unlimited: true } | { unlimited: false; requestsPerDay: number; usdPerDay: number; usedRequests: number; usedUsd: number; running?: number; resetsAt?: string; reached: boolean };
interface MyUsage {
  day: string;
  today: Omit<DayRow, 'day'>;
  days: DayRow[];
  limits: LimitStatus;
  storage?: 'supabase' | 'memory';
  storageProblem?: CountersProblem | null;
}

/** A signed-in user's own API keys: work their keys can do runs in their own accounts, without the daily limit. */
function OwnKeys({ call, serverUrl, onChange }: { call: Call; serverUrl: string; onChange: () => void }) {
  const [info, setInfo] = useState<MyKeys | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const apply = (j: unknown) => setInfo(parseMyKeys(j));
  useEffect(() => {
    void call<MyKeys>('GET', '/api/ai/my-keys').then((r) => (r.ok ? apply(r.json) : setFailed(r.json?.error ?? 'Couldn’t load your keys.')));
  }, [call]);
  const changed = (j: MyKeys | null) => {
    apply(j);
    void pingServer(serverUrl);
    onChange();
  };
  return (
    <section className="panel p-4 sm:p-5" aria-label="Your own keys">
      <h3 className="flex items-center gap-2 text-[14px] font-semibold">
        <KeyRound size={15} className="text-primary" /> Your own keys
      </h3>
      <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
        Optional. Writing, photos and videos one of your keys can do run in <strong className="text-ink-2">your own account</strong>, on your credits, and aren’t limited. Everything else uses the app’s keys, within the daily limit. A Manus key is only for Manus tasks (agent photos, social posts, building pages and assets, and chat). Keys are checked with the provider, stored encrypted on the server and never shown again (only their last 4 characters).
      </p>
      {failed && !info && (
        <p role="alert" className="mt-3 text-[13px] text-bad">
          {failed}
        </p>
      )}
      {!info && !failed && (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={14} /> Loading your keys…
        </p>
      )}
      {info && !info.available && <p className="mt-3 text-[12.5px] text-warn">The app’s owner needs to add the SUPABASE_SECRET_KEY Secret before you can save your own keys.</p>}
      {info && (
        <ul className="mt-3 flex flex-col">
          {info.providers.map((p) => (
            <OwnKeyRow key={p.id} p={p} saved={info.byProvider[p.id] ?? null} available={info.available} call={call} onSaved={changed} />
          ))}
        </ul>
      )}
    </section>
  );
}

function OwnKeyRow({ p, saved, available, call, onSaved }: { p: OwnKeyProvider; saved: { last4: string } | null; available: boolean; call: Call; onSaved: (j: MyKeys | null) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `own-key-${p.id}`;
  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await call<MyKeys>('PUT', `/api/ai/my-keys/${p.id}`, { apiKey: key.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.json?.error ?? 'Couldn’t save the key.');
    setKey('');
    onSaved(r.json);
    toast({ kind: 'success', title: `Your ${p.label} key is saved`, body: ownKeyCapability(p).saved });
  };
  const remove = async () => {
    if (!(await confirmAction({ title: `Remove your ${p.label} key?`, body: p.id === 'manus' ? 'Manus photos and social posts stop until you add a key again.' : 'The app’s keys take over again, within the daily limit.', confirmLabel: 'Remove key', danger: true }))) return;
    setBusy(true);
    const r = await call<MyKeys>('DELETE', `/api/ai/my-keys/${p.id}`);
    setBusy(false);
    if (!r.ok) return toast({ kind: 'error', title: 'Couldn’t remove the key', body: r.json?.error ?? 'Please try again.' });
    onSaved(r.json);
    toast({ kind: 'success', title: `Your ${p.label} key was removed` });
  };
  return (
    <li className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0 first:pt-0" aria-label={`Your ${p.label} key`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold text-ink">{p.label}</span>
        <span className="text-[12px] text-muted">{ownKeyCapability(p).short}</span>
        {saved ? <span className="badge bg-good-soft text-good">Key ending in {saved.last4}</span> : <span className="badge bg-surface-2 text-muted">No key</span>}
        <a href={p.id === 'manus' ? 'https://manus.im' : p.keyUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline">
          Get a key <ExternalLink size={11} />
        </a>
      </div>
      {p.id === 'manus' && <ManusExplainer />}
      {available && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void save();
          }}
        >
          <Field label={saved ? `Replace your ${p.label} key` : `Your ${p.label} API key`} htmlFor={inputId} className="min-w-[220px] flex-1">
            <input id={inputId} className="input" type="password" autoComplete="off" spellCheck={false} placeholder={saved ? 'Paste a new key to replace it' : `Paste your ${p.label} key`} value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !key.trim()}>
            {busy && <Spinner size={14} />} {saved ? 'Replace key' : 'Save key'}
          </button>
          {saved && (
            <button type="button" className="btn btn-ghost btn-sm text-muted hover:text-bad" disabled={busy} aria-label={`Remove your ${p.label} key`} onClick={() => void remove()}>
              <Trash2 size={14} /> Remove
            </button>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="text-[12.5px] text-bad">
          {error}
        </p>
      )}
    </li>
  );
}

/** What Manus does with your own account, and how to get its key. */
function ManusExplainer() {
  return (
    <details className="rounded-md bg-surface-2/60 px-3 py-2 text-[12.5px]">
      <summary className="cursor-pointer font-semibold text-ink-2">Manus: your photos, social posts, pages and chats, in your own account</summary>
      <p className="mt-1.5 leading-relaxed text-muted">
        Manus is an AI agent with its own browser. With your own Manus account it can make product photos, post on <strong className="text-ink-2">your</strong> Facebook, Instagram, TikTok, LinkedIn and X accounts (right away or scheduled), build pages and assets for you, and chat with you in the assistant. Tasks run in your Manus account and use your Manus credits.
      </p>
      <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-ink-2">
        <li>
          Create a Manus account at{' '}
          <a className="font-semibold text-primary hover:underline" href="https://manus.im" target="_blank" rel="noreferrer">
            manus.im <ExternalLink size={11} className="inline" />
          </a>{' '}
          (free to start; tasks use Manus credits).
        </li>
        <li>
          In Manus, open <strong>Settings → Developers (API keys)</strong>, press <strong>Create API Key</strong>, name it (for example “Yourlocalbusiness”) and copy it. Manus shows it only once.{' '}
          <a className="text-primary hover:underline" href="https://open.manus.ai/docs/v2/authentication" target="_blank" rel="noreferrer">
            Manus’s guide <ExternalLink size={11} className="inline" />
          </a>
        </li>
        <li>Paste it below and press Save.</li>
        <li>For posting: in Manus, sign in to each network once in its browser (Manus asks the first time it posts there for you).</li>
      </ol>
    </details>
  );
}

function Meter({ label, used, limit, text }: { label: string; used: number; limit: number; text: string }) {
  const pct = limitPercent(used, limit);
  const full = limit > 0 && used >= limit;
  return (
    <div>
      <p className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="font-semibold text-ink-2">{label}</span>
        <span className={cn('num', full ? 'font-semibold text-bad' : 'text-muted')}>{text}</span>
      </p>
      {limit > 0 && (
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className={cn('h-full rounded-full', full ? 'bg-bad' : pct >= 80 ? 'bg-warn' : 'bg-primary')} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Today's use of the app's keys against the daily limit, and the last 7 days. */
function MyUsageCard({ call, refresh }: { call: Call; refresh: number }) {
  const [u, setU] = useState<MyUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await call<MyUsage>('GET', '/api/ai/my-usage');
    if (r.ok && r.json?.today) {
      setU(r.json);
      setError(null);
    } else setError(r.json?.error ?? 'Couldn’t load your usage.');
  }, [call]);
  useEffect(() => {
    void load();
  }, [load, refresh]);
  const lim = u?.limits;
  const own = (u?.days ?? []).some((d) => d.ownRequests > 0);
  return (
    <section className="panel p-4 sm:p-5" aria-label="Your usage">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold">
          <ListChecks size={15} className="text-primary" /> Your usage
        </h3>
        <button className="btn btn-ghost btn-xs ml-auto" onClick={() => void load()}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {error && !u && (
        <p role="alert" className="mt-2 text-[13px] text-bad">
          {error}
        </p>
      )}
      {!u && !error && (
        <p className="mt-2 flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={14} /> Loading…
        </p>
      )}
      {u && lim && (
        <>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {lim.unlimited
              ? 'You have no daily limit.'
              : `Today on the app’s keys. Resets ${resetLabel(lim.resetsAt)} (midnight UTC).`}
          </p>
          {!lim.unlimited && (
            <div className="mt-3 flex flex-col gap-3">
              <Meter
                label="Requests"
                used={requestsInUse(lim)}
                limit={lim.requestsPerDay}
                text={`${requestsInUse(lim)}${lim.requestsPerDay > 0 ? ` of ${lim.requestsPerDay}` : ' · no limit'}${lim.running ? ` (${lim.running} running)` : ''}`}
              />
              <Meter label="Cost" used={lim.usedUsd} limit={lim.usdPerDay} text={lim.usdPerDay > 0 ? `${fmtUsdSmall(lim.usedUsd)} of ${fmtUsdSmall(lim.usdPerDay)}` : `${fmtUsdSmall(lim.usedUsd)} · no limit`} />
              {lim.reached && (
                <p role="status" className="rounded-md bg-warn-soft/60 px-3 py-2 text-[12.5px] text-ink-2">
                  You’ve reached today’s limit on the app’s keys. Add your own key above to keep going now, or wait until it resets.
                </p>
              )}
            </div>
          )}
          {u.today.ownRequests > 0 && (
            <p className="mt-2 text-[12.5px] text-muted">
              Plus <span className="num font-semibold text-ink-2">{u.today.ownRequests}</span> request{u.today.ownRequests === 1 ? '' : 's'} on your own keys today
              {u.today.ownUsd > 0 ? ` (${fmtUsdSmall(u.today.ownUsd)}, billed to your accounts)` : ''}, not limited.
            </p>
          )}
          <table className="mt-3 w-full text-left text-[12.5px]">
            <caption className="pb-1 text-left text-[11.5px] text-muted">Last 7 days (UTC)</caption>
            <thead className="text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3 font-semibold">Day</th>
                <th className="py-1 pr-3 text-right font-semibold">App’s keys</th>
                {own && <th className="py-1 text-right font-semibold">Your keys</th>}
              </tr>
            </thead>
            <tbody className="num">
              {u.days.map((d) => (
                <tr key={d.day} className="border-t border-line">
                  <td className="py-1.5 pr-3 text-ink-2">{dayName(d.day, u.day)}</td>
                  <td className="py-1.5 pr-3 text-right">
                    {d.requests} · {fmtUsdSmall(d.usd)}
                  </td>
                  {own && (
                    <td className="py-1.5 text-right">
                      {d.ownRequests} · {fmtUsdSmall(d.ownUsd)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {countersNote(u.storage, u.storageProblem) && <p className="mt-2 text-[11.5px] text-muted">{countersNote(u.storage, u.storageProblem)}</p>}
        </>
      )}
    </section>
  );
}

/** "Today", "Yesterday" or "Mon, Nov 2" for a UTC day like 2026-11-02. */
function dayName(day: string, today: string): string {
  if (day === today) return 'Today';
  const t = Date.parse(`${today}T00:00:00Z`);
  const d = Date.parse(`${day}T00:00:00Z`);
  if (Number.isFinite(t) && t - d === 86_400_000) return 'Yesterday';
  return Number.isFinite(d) ? new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : day;
}

// ───────────── the owner: limits for everyone else, and who used what ─────────────

interface Limits {
  requestsPerDay: number;
  usdPerDay: number;
}

function DailyLimitsCard({ call }: { call: Call }) {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [storage, setStorage] = useState<string>('');
  const [problem, setProblem] = useState<CountersProblem | null>(null);
  const [reqs, setReqs] = useState('');
  const [usd, setUsd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const show = (l: Limits) => {
    setLimits(l);
    setReqs(String(l.requestsPerDay));
    setUsd(String(l.usdPerDay));
  };
  useEffect(() => {
    void call<{ limits: Limits; storage: string; storageProblem?: CountersProblem | null }>('GET', '/api/ai/limits').then((r) => {
      if (r.ok && r.json?.limits) {
        show(r.json.limits);
        setStorage(r.json.storage);
        setProblem(r.json.storageProblem ?? null);
      } else setError(r.json?.error ?? 'Couldn’t load the limits.');
    });
  }, [call]);
  const n = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const valid = Number.isFinite(n(reqs)) && n(reqs) >= 0 && Number.isFinite(n(usd)) && n(usd) >= 0;
  const dirty = !!limits && valid && (n(reqs) !== limits.requestsPerDay || n(usd) !== limits.usdPerDay);
  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await call<{ limits: Limits; storage: string; storageProblem?: CountersProblem | null }>('PUT', '/api/ai/limits', { requestsPerDay: Math.floor(n(reqs)), usdPerDay: n(usd) });
    setBusy(false);
    if (r.status === 502 && r.json?.code === 'NOT_SAVED' && r.json.limits) {
      show(r.json.limits);
      return toast({ kind: 'error', title: 'Working now, but not kept in Supabase', body: r.json.error ?? '' });
    }
    if (!r.ok || !r.json?.limits) return setError(r.json?.error ?? 'Couldn’t save the limits.');
    show(r.json.limits);
    if (r.json.storage) setStorage(r.json.storage);
    setProblem(r.json.storageProblem ?? null);
    toast({ kind: 'success', title: 'Daily limits saved' });
  };
  return (
    <section className="panel p-4 sm:p-5" aria-label="Daily limits for other people">
      <h3 className="flex items-center gap-2 text-[14px] font-semibold">
        <ShieldCheck size={15} className="text-primary" /> Daily limits for other people
      </h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        How much each signed-in person can use your keys per day (UTC). Requests on their own keys don’t count, and you’re never limited. 0 means no limit.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void save();
        }}
      >
        <Field label="Requests per day" htmlFor="limit-requests" className="w-[150px]">
          <input id="limit-requests" className="input num" type="number" min={0} max={100000} step={1} inputMode="numeric" value={reqs} disabled={!limits} onChange={(e) => setReqs(e.target.value)} />
        </Field>
        <Field label="Cost per day ($)" htmlFor="limit-usd" className="w-[150px]">
          <input id="limit-usd" className="input num" type="number" min={0} max={10000} step={0.01} inputMode="decimal" value={usd} disabled={!limits} onChange={(e) => setUsd(e.target.value)} />
        </Field>
        <button type="submit" className="btn btn-primary btn-sm mb-0.5" disabled={busy || !dirty}>
          {busy && <Spinner size={14} />} Save limits
        </button>
      </form>
      {!valid && limits && <p className="mt-1.5 text-[12px] text-bad">Use numbers of 0 or more.</p>}
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-bad">
          {error}
        </p>
      )}
      {countersNote(storage, problem, { owner: true }) && (
        <p role={problem ? 'alert' : undefined} className={cn('mt-2 text-[11.5px]', problem ? 'text-warn' : 'text-muted')}>
          {countersNote(storage, problem, { owner: true })}
        </p>
      )}
    </section>
  );
}

interface PersonRow {
  userId: string;
  email: string;
  day?: string;
  requests: number;
  usd: number;
  ownRequests: number;
  ownUsd: number;
}

function PeopleUsageCard({ call }: { call: Call }) {
  const [data, setData] = useState<{ rows: PersonRow[]; users: PersonRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await call<{ rows: PersonRow[]; users: PersonRow[] }>('GET', '/api/ai/usage/users?days=7');
    if (r.ok && r.json?.users) {
      setData({ rows: r.json.rows ?? [], users: r.json.users });
      setError(null);
    } else setError(r.json?.error ?? 'Couldn’t load usage by person.');
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);
  const today = new Date().toISOString().slice(0, 10);
  const todayOf = (id: string) => data?.rows.find((r) => r.userId === id && r.day === today);
  return (
    <section className="panel p-4 sm:p-5" aria-label="Usage by person">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold">
          <ListChecks size={15} className="text-primary" /> Usage by person
        </h3>
        <button className="btn btn-ghost btn-xs ml-auto" onClick={() => void load()}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      <p className="mt-0.5 text-[12.5px] text-muted">Requests and cost on your keys. Requests on their own keys are shown separately; they pay for those.</p>
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-bad">
          {error}
        </p>
      )}
      {data && !data.users.length && <p className="mt-3 text-[12.5px] text-muted">Nobody else has used the AI in the last 7 days.</p>}
      {data && data.users.length > 0 && (
        <div className="mt-3 w-full overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-[12.5px]">
            <thead className="text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3 font-semibold">Person</th>
                <th className="py-1 pr-3 text-right font-semibold">Today</th>
                <th className="py-1 pr-3 text-right font-semibold">Last 7 days</th>
                <th className="py-1 text-right font-semibold">Own keys (7 days)</th>
              </tr>
            </thead>
            <tbody className="num">
              {data.users.map((u) => {
                const t = todayOf(u.userId);
                return (
                  <tr key={u.userId} className="border-t border-line">
                    <td className="max-w-[220px] truncate py-1.5 pr-3 font-semibold text-ink" title={u.email || u.userId}>
                      {u.email || `${u.userId.slice(0, 8)}…`}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{t ? `${t.requests} · ${fmtUsdSmall(t.usd)}` : '0'}</td>
                    <td className="py-1.5 pr-3 text-right">
                      {u.requests} · {fmtUsdSmall(u.usd)}
                    </td>
                    <td className="py-1.5 text-right text-muted">{u.ownRequests ? `${u.ownRequests} · ${fmtUsdSmall(u.ownUsd)}` : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Signed in as someone other than the owner: what powers each function (from /api/health). */
function OwnerManaged() {
  const ai = useRuntime((s) => s.ai);
  const byId = new Map(ai.providers.map((p) => [p.id, p]));
  return (
    <section className="panel p-4 sm:p-5" aria-label="What powers each function">
      <h3 className="flex items-center gap-2 text-[14px] font-semibold">
        <Route size={15} className="text-primary" /> What powers each function
      </h3>
      <p className="mt-0.5 text-[12.5px] text-muted">Only the owner can change keys, models and effort. Where nothing is set up, the built-in engine writes instead.</p>
      <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
        {AI_FUNCTION_GROUPS.map((g) => (
          <div key={g.id}>
            <p className="eyebrow mb-1">{g.label}</p>
            <ul className="flex flex-col gap-1">
              {AI_FUNCTIONS.filter((f) => f.group === g.id).map((f) => {
                const p = byId.get(ai.routing[f.id]?.[0] ?? '');
                const model = p?.models[f.kind];
                return (
                  <li key={f.id} className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="text-ink-2">{f.label}</span>
                    <span className={cn('truncate text-right text-[12.5px]', p ? 'font-semibold text-ink' : 'text-muted')}>{p ? `${p.label}${model ? ` · ${model}` : ''}` : 'Built-in engine'}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
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
