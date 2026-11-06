import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CircleAlert, ExternalLink, FlaskConical, Power, PowerOff, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
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
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Badge, Callout, Drawer, Field, InfoTip, MoreMenu, Popover, SettingsRow, SettingsSection, Spinner, Toggle, Tooltip, confirmAction } from '@/components/ui/primitives';
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

/** A section other places find by its name (the QA scripts and screen readers): a named region around a SettingsSection. */
function Region({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div role="region" aria-label={name}>
      {children}
    </div>
  );
}

/** Settings › AI keys (self-hosted): one AI, powered by your API keys. */
export function AIProviders() {
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

  return (
    <div className="flex max-w-[880px] flex-col gap-6">
      <BrainSection />

      {status === 'loading' && (
        <p className="flex items-center gap-2 text-small text-muted">
          <Spinner size={14} /> Checking your server…
        </p>
      )}
      {status === 'offline' && (
        <Callout
          tone="warn"
          title="Your AI server isn’t running"
          action={
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => void load()}>
              <RefreshCw /> Refresh
            </button>
          }
        >
          Start it with <code className="rounded-xs bg-surface-3 px-1 font-mono text-caption">npm run server</code>, then press Refresh. Until then the built-in engine writes everything.
        </Callout>
      )}

      {status === 'ready' && role === 'user' && (
        <>
          <OwnKeys call={call} serverUrl={serverUrl} onChange={() => setUsageTick((n) => n + 1)} />
          <MyUsageCard call={call} refresh={usageTick} />
          <OwnerManaged />
        </>
      )}

      {status === 'ready' && catalog && state && (
        <>
          {!state.canManage && !accounts && <AdminAccess adminTokenSet={state.adminTokenSet} token={adminToken} onToken={setAdminToken} onCheck={() => void load()} />}
          <StorageNote state={state} />
          <Providers state={state} catalog={catalog} usage={usage} usageLocked={usageLocked} call={call} save={save} onReload={() => void load()} onUsage={() => void loadUsage()} />
          {/* Viktor (viktor.com) through the owner's own Slack app: the owner's, and self-hosted only */}
          {state.canManage && !__ARTIFACT_BUILD__ && <SlackCard call={call} serverUrl={serverUrl} />}
          {state.accounts && state.canManage && <DailyLimitsCard call={call} />}
        </>
      )}

      <ServerAddress />
    </div>
  );
}

/** One switch for the Brain (every key that's on follows it). */
function BrainSection({ short }: { short?: boolean }) {
  const useBrain = useStore((s) => s.settings.ai.useBrain);
  const updateSettings = useStore((s) => s.updateSettings);
  return (
    <Region name="Brain">
      <div className="card px-5">
        <SettingsRow label={useBrain ? 'Brain is on' : 'Brain is off'} description={short ? 'Writing follows your Brain skills; photos and videos get its art direction.' : 'Writing follows your Brain skills, and photos and videos get its art direction, for every key that’s on.'} htmlFor="ai-brain">
          <Toggle id="ai-brain" checked={useBrain} onChange={(v) => updateSettings((s) => ({ ...s, ai: { ...s.ai, useBrain: v } }))} />
        </SettingsRow>
      </div>
    </Region>
  );
}

/** claude.ai: Claude is the AI here; keys are for the self-hosted app. */
export function ArtifactAI() {
  return (
    <div className="flex max-w-[880px] flex-col gap-6">
      <Callout tone="info" title="AI in claude.ai">
        <span className="inline-flex flex-wrap items-center gap-x-1">
          Claude writes everything through your claude.ai account; photos and videos come through your Zapier connector, and Manus posts in Facebook groups for you.
          <InfoTip title="Your own keys" label="About AI keys">
            Photos come from Meta Muse Image and videos from HeyGen, both through OpenRouter in your Zapier connector. To use your own API keys (OpenRouter, Google, xAI, Anthropic, Meta, Manus and OpenAI), with what each key powers and its effort, run the self-hosted app and open Settings › AI keys there.
          </InfoTip>
        </span>
      </Callout>
      <BrainSection short />
    </div>
  );
}

/** Where the keys are kept, when that needs the owner's attention (at most one note). */
function StorageNote({ state }: { state: AIState }) {
  if (state.canManage && state.storage === 'disk' && (state.ephemeralDisk || state.accounts)) {
    return (
      <Callout tone="warn" title="Keys you add here can disappear">
        <span className="inline-flex flex-wrap items-center gap-x-1">
          They’re kept in this server’s files, which {state.ephemeralDisk ? 'this host wipes' : 'some hosts wipe'} when the app restarts or sleeps.
          <InfoTip title="Keep them in Supabase" label="How to keep your keys">
            {state.supabaseUrlSet ? 'Add the SUPABASE_SECRET_KEY secret (Supabase › Project Settings › API Keys, the sb_secret_… key)' : 'Add the SUPABASE_URL and SUPABASE_SECRET_KEY secrets (Supabase › Project Settings › API)'}, run the files in supabase/migrations in Supabase’s SQL Editor if you haven’t, and restart the app. Keys set as server secrets (like OPENAI_API_KEY) always stay.
          </InfoTip>
        </span>
      </Callout>
    );
  }
  if (state.canManage && state.storage === 'supabase' && state.storageProblem) {
    return (
      <Callout tone="warn" title="Your keys aren’t being kept in Supabase right now">
        {state.storageProblem.message} Until then they live in this server’s files{state.ephemeralDisk ? ', which this host wipes when the app restarts' : ''}.
      </Callout>
    );
  }
  if (state.imported) {
    return (
      <Callout tone="info" title="Your image keys moved here">
        Keys from the old “Image generation” settings now power Photos. Choose more functions to use them for writing too.
      </Callout>
    );
  }
  return null;
}

// ───────────── the owner's keys ─────────────

type Call = ReturnType<typeof useAIServer>['call'];
type Save = (id: string | null, body: Record<string, unknown>, success?: string) => Promise<boolean>;

/** The functions a key powers, by name, in the app's order. */
const poweredNames = (functions: string[]) => {
  const on = new Set(functions);
  return AI_FUNCTIONS.filter((f) => on.has(f.id)).map((f) => f.label);
};

function statusOf(st: ProviderState): { text: string; tone: 'good' | 'neutral' } {
  if (!st.configured) return { text: 'No key', tone: 'neutral' };
  if (!st.enabled) return { text: 'Off', tone: 'neutral' };
  return { text: 'On', tone: 'good' };
}

/** The keys as a table, in the order they're tried; Configure opens one in a side sheet. */
function Providers({ state, catalog, usage, usageLocked, call, save, onReload, onUsage }: { state: AIState; catalog: CatalogProvider[]; usage: { recent: UsageEntry[]; totals: UsageTotals } | null; usageLocked: boolean; call: Call; save: Save; onReload: () => void; onUsage: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const locked = !state.canManage;
  const move = (i: number, dir: -1 | 1) => {
    const order = [...state.order];
    const j = i + dir;
    [order[i], order[j]] = [order[j], order[i]];
    void save(null, { order });
  };
  const def = open ? catalog.find((c) => c.id === open) : undefined;
  const st = open ? state.providers.find((p) => p.id === open) : undefined;
  const at = open ? state.order.indexOf(open) : -1;
  // the side sheet gives the focus back to the row's Configure button when it closes
  return (
    <>
      <SettingsSection
        title="Your keys"
        description="One AI for the whole app: add a key, choose what it powers and its model. Keys stay on your server."
        actions={
          <>
            <InfoTip title="How keys take turns" label="How keys take turns">
              Keys are tried in this order. If one fails (an outage, a rate limit, no credit), the next key that powers the same function answers. Videos and agent tasks only move on when the first key certainly started nothing. Each key’s effort is sent in its provider’s own setting, so it changes the answer and what you pay.
            </InfoTip>
            <Tooltip content="Check your server again">
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onReload} aria-label="Refresh">
                <RefreshCw />
              </button>
            </Tooltip>
          </>
        }
      >
        <div className="-mx-5 mt-3 border-t border-line">
          <div className="hidden grid-cols-[20px_minmax(0,1.1fr)_72px_minmax(0,1.5fr)_128px] gap-4 border-b border-line px-5 py-2 text-caption text-muted md:grid" aria-hidden="true">
            <span>#</span>
            <span>Provider</span>
            <span>Status</span>
            <span>Used for</span>
            <span />
          </div>
          <ul aria-label="Your keys">
            {state.order.map((id, i) => {
              const d = catalog.find((c) => c.id === id);
              const p = state.providers.find((x) => x.id === id);
              if (!d || !p) return null;
              const names = poweredNames(p.functions);
              const s = statusOf(p);
              return (
                <li key={id} aria-label={`${d.label} key`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-line px-5 py-2.5 md:grid-cols-[20px_minmax(0,1.1fr)_72px_minmax(0,1.5fr)_128px]">
                  <span className="num font-mono text-caption text-muted max-md:hidden">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-ui text-ink">{d.label}</span>
                      <Badge tone={s.tone} className="md:hidden">
                        {s.text}
                      </Badge>
                    </span>
                    <span className="block truncate font-mono text-caption text-muted">{p.source === 'secrets' ? 'Server secret' : p.configured ? p.keyHint || 'Saved' : 'Not set'}</span>
                  </span>
                  <span className="max-md:hidden">
                    <Badge tone={s.tone}>{s.text}</Badge>
                  </span>
                  <span className="min-w-0 truncate text-small text-muted max-md:col-span-2 max-md:row-start-2" title={names.join(', ')}>
                    {names.length ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : 'Nothing yet'}
                  </span>
                  <span className="flex items-center justify-end gap-1 max-md:col-start-2 max-md:row-start-1">
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => setOpen(id)}
                    >
                      Configure
                    </button>
                    <MoreMenu
                      size="xs"
                      label={`More actions for ${d.label}`}
                      items={[
                        { label: p.enabled ? 'Turn off' : 'Turn on', icon: p.enabled ? <PowerOff /> : <Power />, disabled: locked, onSelect: () => void save(id, { enabled: !p.enabled }) },
                        'separator',
                        { label: 'Move up', icon: <ArrowUp />, disabled: locked || i === 0, onSelect: () => move(i, -1) },
                        { label: 'Move down', icon: <ArrowDown />, disabled: locked || i === state.order.length - 1, onSelect: () => move(i, 1) },
                      ]}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <RoutingAndUsage state={state} catalog={catalog} usage={usage} usageLocked={usageLocked} call={call} people={!!state.accounts && state.canManage} onRefreshUsage={onUsage} />
        {state.canManage && state.storage === 'supabase' && !state.storageProblem && (
          <p className="flex items-center gap-1.5 border-t border-line py-3 text-caption text-muted">
            <ShieldCheck size={14} className="shrink-0 text-good" aria-hidden="true" /> Keys and settings are saved in your Supabase project, encrypted, so they stay through restarts.
          </p>
        )}
      </SettingsSection>
      <Drawer open={!!(def && st)} onClose={() => setOpen(null)} title={def ? `${def.label} key` : ''} width={640}>
        {def && st && <KeyDetails def={def} st={st} rank={at + 1} canManage={state.canManage} call={call} save={(body, success) => save(def.id, body, success)} totals={usage?.totals.providers.find((t) => t.provider === def.id)} onUsage={onUsage} />}
      </Drawer>
    </>
  );
}

/** One key, in its side sheet: on or off, the key, what it powers, model and effort per kind, a test, its usage. */
function KeyDetails({ def, st, rank, canManage, call, save, totals, onUsage }: { def: CatalogProvider; st: ProviderState; rank: number; canManage: boolean; call: Call; save: (body: Record<string, unknown>, success?: string) => Promise<boolean>; totals?: UsageTotals['providers'][number]; onUsage: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const kinds = Object.keys(def.kinds) as AIKind[];
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
    <div className="flex flex-col gap-6">
      <p className="text-small text-muted">{def.note}</p>

      <div className="flex flex-col">
        <SettingsRow label="Use this key" description={`Tried ${rank === 1 ? 'first' : `${rank}${rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'}`} for the functions it powers.`} htmlFor={`ai-on-${def.id}`}>
          <Toggle checked={st.enabled} disabled={locked} onChange={(v) => void save({ enabled: v })} id={`ai-on-${def.id}`} />
        </SettingsRow>
        {st.source === 'secrets' ? (
          <SettingsRow label="Key" description="Set on the server, so it can’t be changed here.">
            <span className="flex items-center gap-1.5 text-small text-ink-2">
              <ShieldCheck size={14} className="shrink-0 text-good" aria-hidden="true" />
              <span className="font-mono">{st.envKey}</span> <span className="num font-mono text-muted">{st.keyHint}</span>
            </span>
          </SettingsRow>
        ) : (
          <SettingsRow
            label={st.configured ? `Saved key ${st.keyHint}` : 'API key'}
            htmlFor={`ai-key-${def.id}`}
            description={
              <a href={def.keyUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
                Get a key <ExternalLink size={12} aria-hidden="true" />
              </a>
            }
          >
            <form
              className="flex w-full flex-col gap-2 md:max-w-[420px]"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey();
              }}
            >
              <input id={`ai-key-${def.id}`} type="password" autoComplete="off" spellCheck={false} className="input" value={key} disabled={locked} onChange={(e) => setKey(e.target.value)} placeholder={st.configured ? 'Paste a new key to replace it' : `Paste your ${def.label} key`} />
              <span className="flex flex-wrap items-center justify-end gap-2">
                {st.source === 'app' && (
                  <button
                    type="button"
                    className="btn btn-danger-ghost btn-sm mr-auto"
                    disabled={locked}
                    onClick={async () => {
                      if (await confirmAction({ title: `Remove the ${def.label} key?`, body: 'Functions it powers move to your next key, or to the built-in engine.', confirmLabel: 'Remove key', danger: true })) void save({ removeKey: true }, 'Key removed');
                    }}
                  >
                    <Trash2 /> Remove
                  </button>
                )}
                <button type="submit" className="btn btn-primary btn-sm" disabled={locked || busy || !key.trim()}>
                  {busy && <Spinner size={14} />} Save key
                </button>
              </span>
            </form>
          </SettingsRow>
        )}
        <SettingsRow label="Powers" description="The functions this key answers.">
          <div className="w-full md:max-w-[420px]">
            <PowersDropdown def={def} st={st} disabled={locked} onChange={(functions) => void save({ functions })} />
          </div>
        </SettingsRow>
      </div>

      <div className="flex flex-col gap-3">
        <h4 className="text-h4 text-ink">Models and effort</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {kinds.map((kind) => (
            <KindSettings key={kind} def={def} st={st} kind={kind} disabled={locked} call={call} save={save} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" disabled={!st.configured || testing || locked} onClick={() => void testKey()}>
            {testing ? <Spinner size={14} /> : <ShieldCheck />} Test key
          </button>
          {def.kinds.text && <CompareEfforts def={def} st={st} disabled={!st.configured || locked} call={call} onDone={onUsage} />}
        </div>
        {test && (
          <p className={cn('flex items-center gap-1.5 text-small', test.ok ? 'text-good' : 'text-bad')} role="status">
            {!test.ok && <CircleAlert size={14} className="shrink-0" aria-hidden="true" />} {test.text}
          </p>
        )}
        {totals && totals.requests > 0 && (
          <p className="num text-small text-muted">
            Last 14 days: <span className="font-mono text-ink-2">{totals.requests}</span> request{totals.requests === 1 ? '' : 's'}
            {totals.failed ? ` (${totals.failed} failed)` : ''} · <span className="font-mono text-ink-2">{totals.costUsd ? fmtUsdSmall(totals.costUsd) : totals.credits ? `${totals.credits} credits` : '–'}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** The "Powers" list: every function, grouped, with the ones this key can't do switched off. */
function PowersDropdown({ def, st, disabled, onChange }: { def: CatalogProvider; st: ProviderState; disabled: boolean; onChange: (functions: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const supported = AI_FUNCTIONS.filter((f) => def.functions[f.id]?.ok).map((f) => f.id);
  const on = new Set(st.functions);
  const toggle = (id: string) => onChange(on.has(id) ? st.functions.filter((x) => x !== id) : [...st.functions, id]);
  const names = AI_FUNCTIONS.filter((f) => on.has(f.id)).map((f) => f.label);
  return (
    <>
      <button ref={anchor} type="button" className="select flex h-auto min-h-9 w-full items-center py-1.5 text-left" disabled={disabled} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="min-w-0 flex-1 truncate text-small">{names.length ? `${names.length} of ${supported.length}: ${names.join(', ')}` : <span className="text-muted">Nothing yet: choose what this key powers</span>}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="start" className="w-[min(440px,calc(100vw-24px))] p-2">
        <div className="mb-1 flex items-center gap-3 px-1.5 pb-1">
          <span className="text-small font-medium text-ink">What {def.label} powers</span>
          <button type="button" className="link ml-auto text-caption" onClick={() => onChange(supported)}>
            Everything it can
          </button>
          <button type="button" className="link text-caption" onClick={() => onChange([])}>
            None
          </button>
        </div>
        {AI_FUNCTION_GROUPS.map((g) => (
          <fieldset key={g.id} className="mb-1">
            <legend className="px-1.5 pb-0.5 pt-2 text-caption font-medium text-muted">{g.label}</legend>
            {AI_FUNCTIONS.filter((f) => f.group === g.id).map((f) => {
              const sup = def.functions[f.id];
              const id = `pw-${def.id}-${f.id}`;
              return (
                <label key={f.id} htmlFor={id} className={cn('flex items-start gap-2.5 rounded px-1.5 py-1.5', sup?.ok ? 'cursor-pointer hover:bg-surface-2' : 'cursor-not-allowed')}>
                  <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={on.has(f.id)} disabled={!sup?.ok} onChange={() => toggle(f.id)} />
                  <span className="min-w-0">
                    <span className={cn('block text-small font-medium', sup?.ok ? 'text-ink' : 'text-faint')}>{f.label}</span>
                    <span className="block text-caption text-muted">{sup?.ok ? f.desc : sup?.reason}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ))}
      </Popover>
    </>
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
    <section className="well flex flex-col gap-3 p-3" aria-label={`${def.label} ${KIND_TITLE[kind]}`}>
      <p className="flex flex-wrap items-baseline gap-x-2 text-small font-medium text-ink">
        {KIND_TITLE[kind]}
        {!inUse && <span className="text-caption font-normal text-muted">Not used: nothing it powers needs it</span>}
      </p>
      {showModelPicker && (
        <div>
          <label className="label" htmlFor={`m-${def.id}-${kind}`}>
            Model
          </label>
          {custom ? (
            <div className="flex gap-1.5">
              <input id={`m-${def.id}-${kind}`} className="input input-sm font-mono" value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="model id, e.g. gpt-6.1-sol" />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!customModel.trim() || disabled}
                onClick={async () => {
                  if (await save({ models: { [kind]: customModel.trim() } })) setCustom(false);
                }}
              >
                Use
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCustom(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <select id={`m-${def.id}-${kind}`} className="select input-sm min-w-0 flex-1" value={model} disabled={disabled} onChange={(e) => (e.target.value === '__custom' ? setCustom(true) : void save({ models: { [kind]: e.target.value } }))}>
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
              <Tooltip content="Load every model your key can use">
                <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Load every model your key can use" disabled={!st.configured || loading || disabled} onClick={() => void loadModels()}>
                  {loading ? <Spinner size={14} /> : <RefreshCw />}
                </button>
              </Tooltip>
            </div>
          )}
        </div>
      )}
      <div>
        <label className="label" htmlFor={`e-${def.id}-${kind}`}>
          {effortTitle(def.id, kind)}
        </label>
        {efforts.length ? (
          <select id={`e-${def.id}-${kind}`} className="select input-sm" value={effort} disabled={disabled} onChange={(e) => void save({ effort: { [kind]: e.target.value } })}>
            {efforts.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-small text-muted">Set by the model (it has no effort setting).</p>
        )}
        {chosen && (
          <p className="hint">
            {chosen.note} {info.field && <span className="whitespace-nowrap">Sent as <code className="font-mono">{info.field}</code>.</span>}
          </p>
        )}
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
      <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || running} onClick={() => void run()}>
        {running ? <Spinner size={14} /> : <FlaskConical />} Compare efforts
      </button>
      {result && (
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-small">
            <caption className="pb-1.5 text-left text-caption text-muted">
              {result.model}, effort sent as <code className="font-mono">{result.field}</code>
            </caption>
            <thead className="border-b border-line text-caption text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Effort</th>
                <th className="py-1.5 pr-3 font-medium">Time</th>
                <th className="py-1.5 pr-3 font-medium">Reasoning</th>
                <th className="py-1.5 pr-3 font-medium">Output tokens</th>
                <th className="py-1.5 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="num divide-y divide-line font-mono">
              {result.results.map((x) => (
                <tr key={x.effort}>
                  <td className="py-1.5 pr-3 font-sans font-medium text-ink">{x.effortLabel}</td>
                  {x.ok ? (
                    <>
                      <td className="py-1.5 pr-3">{((x.ms ?? 0) / 1000).toFixed(1)}s</td>
                      <td className="py-1.5 pr-3">{x.usage?.reasoning != null ? fmtTokens(x.usage.reasoning) : 'inside output'}</td>
                      <td className="py-1.5 pr-3">{x.usage ? fmtTokens(x.usage.output) : '–'}</td>
                      <td className="py-1.5">{x.cost ? `${x.cost.source === 'estimate' ? '≈' : ''}${fmtUsdSmall(x.cost.usd)}` : '–'}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="py-1.5 font-sans text-bad">
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

// ───────────── routing and usage (behind an accordion) ─────────────

function RoutingAndUsage({ state, catalog, usage, usageLocked, call, people, onRefreshUsage }: { state: AIState; catalog: CatalogProvider[]; usage: { recent: UsageEntry[]; totals: UsageTotals } | null; usageLocked: boolean; call: Call; people: boolean; onRefreshUsage: () => void }) {
  return (
    <Accordion type="multiple" className="-mx-5 border-t border-line px-5">
      <AccordionItem value="routing" className="last:border-b-0">
        <AccordionTrigger>Routing</AccordionTrigger>
        <AccordionContent>
          <RoutingSummary state={state} catalog={catalog} />
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="recent" className="last:border-b-0">
        <AccordionTrigger>Recent usage</AccordionTrigger>
        <AccordionContent>
          <UsageList usage={usage} locked={usageLocked} catalog={catalog} onRefresh={onRefreshUsage} />
        </AccordionContent>
      </AccordionItem>
      {people && (
        <AccordionItem value="people" className="last:border-b-0">
          <AccordionTrigger>Usage by person</AccordionTrigger>
          <AccordionContent>
            <PeopleUsage call={call} />
          </AccordionContent>
        </AccordionItem>
      )}
    </Accordion>
  );
}

/** "Strategy · xAI Grok → OpenAI": which key answers each function, then the ones after it. */
function RoutingSummary({ state, catalog }: { state: AIState; catalog: CatalogProvider[] }) {
  const name = (id: string) => catalog.find((c) => c.id === id)?.label ?? id;
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2" role="region" aria-label="What powers each function">
      {AI_FUNCTION_GROUPS.map((g) => (
        <div key={g.id}>
          <p className="mb-1 text-caption font-medium text-muted">{g.label}</p>
          <ul className="flex flex-col divide-y divide-line">
            {AI_FUNCTIONS.filter((f) => f.group === g.id).map((f) => {
              const route = state.routing[f.id] ?? [];
              return (
                <li key={f.id} className="flex items-baseline gap-3 py-1.5 text-small">
                  <span className="min-w-0 flex-1 text-ink-2">{f.label}</span>
                  {route.length ? (
                    <span className="text-right text-ink">
                      {name(route[0])}
                      {route.length > 1 && <span className="text-muted"> → {route.slice(1).map(name).join(' → ')}</span>}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-right text-warn">
                      <CircleAlert size={14} className="shrink-0" aria-hidden="true" /> {f.kind === 'text' ? 'Built-in engine' : 'Off: no key'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function UsageList({ usage, locked, catalog, onRefresh }: { usage: { recent: UsageEntry[]; totals: UsageTotals } | null; locked: boolean; catalog: CatalogProvider[]; onRefresh: () => void }) {
  const name = (id: string) => catalog.find((c) => c.id === id)?.label ?? id;
  const fnName = (id: string) => (id === 'test' ? 'Effort comparison' : AI_FUNCTIONS.find((f) => f.id === id)?.label ?? id);
  return (
    <section aria-label="Recent AI usage" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="text-small text-muted">Last 14 days. Costs are what the provider reported, or estimates from list prices.</p>
        <button type="button" className="btn btn-ghost btn-xs ml-auto" onClick={onRefresh}>
          <RefreshCw /> Refresh
        </button>
      </div>
      {!usage || !usage.recent.length ? (
        <p className="text-small text-muted">{locked ? 'Enter the admin token above to see usage: it can show details of your provider accounts.' : 'Nothing yet. Each request your keys answer shows up here with its effort, tokens and cost.'}</p>
      ) : (
        <>
          {usage.totals.providers.length > 0 && (
            <ul className="well flex flex-col gap-1 px-3 py-2.5 text-small">
              {usage.totals.providers.map((t) => (
                <li key={t.provider} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-ink-2">{name(t.provider)}</span>
                  <span className="num font-mono text-caption text-muted">
                    {t.requests} request{t.requests === 1 ? '' : 's'}
                    {t.reasoningTokens ? ` · ${fmtTokens(t.reasoningTokens)} reasoning` : ''}
                  </span>
                  <span className="num w-16 text-right font-mono text-caption text-ink">{t.costUsd ? fmtUsdSmall(t.costUsd) : t.credits ? `${t.credits} cr` : '–'}</span>
                </li>
              ))}
            </ul>
          )}
          <ul className="flex flex-col divide-y divide-line">
            {usage.recent.map((e) => (
              <li key={e.id} className="py-2 text-small">
                <p className="flex items-baseline gap-2">
                  <span className={cn('min-w-0 flex-1 truncate font-medium', e.ok ? 'text-ink' : 'text-bad')}>{fnName(e.fn)}</span>
                  <span className="num shrink-0 font-mono text-caption text-muted">{fmtRelative(e.at)}</span>
                </p>
                <p className="num truncate font-mono text-caption text-muted" title={e.error || undefined}>
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
    <Region name="Admin access">
      <SettingsSection
        title={adminTokenSet ? 'Enter your admin token to change AI settings' : 'AI settings are read-only from this browser'}
        description={adminTokenSet ? 'For safety, keys and settings can only be changed with the server’s admin token.' : 'For safety, keys and settings can only be changed from the machine running the server.'}
        actions={
          !adminTokenSet && (
            <InfoTip title="Change them from this browser" label="How to unlock">
              Set an ADMIN_TOKEN secret on the server (any long password), restart the app, and enter the same password here.
            </InfoTip>
          )
        }
      >
        <SettingsRow label="Admin token" htmlFor="ai-admin">
          <form
            className="flex w-full gap-2 md:max-w-[420px]"
            onSubmit={(e) => {
              e.preventDefault();
              if (!value.trim()) return;
              onToken(value.trim());
              onCheck();
            }}
          >
            <input id="ai-admin" type="password" autoComplete="off" className="input min-w-0 flex-1" value={value} onChange={(e) => setValue(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
              Unlock
            </button>
          </form>
        </SettingsRow>
      </SettingsSection>
    </Region>
  );
}

function ServerAddress() {
  const serverUrl = useStore((s) => s.settings.ai.serverUrl);
  const updateSettings = useStore((s) => s.updateSettings);
  const [testing, setTesting] = useState(false);
  return (
    <div className="card px-5">
      <Accordion type="single" collapsible>
        <AccordionItem value="server" className="border-b-0">
          <AccordionTrigger>Advanced: AI server address</AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Server URL" htmlFor="ai-url" hint="Leave it blank when the app and the server run together (the usual setup). For a separate server, press Test connection: that lets it know who’s signed in." className="min-w-[240px] flex-1">
                <input id="ai-url" className="input" value={serverUrl} onChange={(e) => updateSettings((s) => ({ ...s, ai: { ...s.ai, serverUrl: e.target.value.trim() } }))} placeholder="https://your-server.example.com" />
              </Field>
              <button
                type="button"
                className="btn btn-secondary mb-[22px]"
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
                {testing ? <Spinner size={14} /> : <RefreshCw />} Test connection
              </button>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
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
  const [open, setOpen] = useState<string | null>(null);
  const apply = (j: unknown) => setInfo(parseMyKeys(j));
  useEffect(() => {
    void call<MyKeys>('GET', '/api/ai/my-keys').then((r) => (r.ok ? apply(r.json) : setFailed(r.json?.error ?? 'Couldn’t load your keys.')));
  }, [call]);
  const changed = (j: MyKeys | null) => {
    apply(j);
    void pingServer(serverUrl);
    onChange();
  };
  const editing = open ? info?.providers.find((p) => p.id === open) : undefined;
  // the side sheet gives the focus back to the row's Add key / Replace button when it closes
  return (
    <Region name="Your own keys">
      <SettingsSection
        title="Your own keys"
        description="Optional: what your own keys can do runs in your account, on your credits, without the daily limit."
        actions={
          <InfoTip title="Your own keys" label="About your own keys">
            Writing, photos and videos one of your keys can do run in your own account and aren’t limited; everything else uses the app’s keys, within the daily limit. A Manus key is only for Manus tasks (agent photos, social posts, building pages and assets, and chat). Keys are checked with the provider, stored encrypted on the server and never shown again (only their last 4 characters).
          </InfoTip>
        }
      >
        {failed && !info && (
          <p role="alert" className="flex items-center gap-1.5 py-4 text-small text-bad">
            <CircleAlert size={14} className="shrink-0" aria-hidden="true" /> {failed}
          </p>
        )}
        {!info && !failed && (
          <p className="flex items-center gap-2 py-4 text-small text-muted">
            <Spinner size={14} /> Loading your keys…
          </p>
        )}
        {info && !info.available && (
          <div className="pb-2 pt-3">
            <Callout tone="warn">The app’s owner needs to add the SUPABASE_SECRET_KEY secret before you can save your own keys.</Callout>
          </div>
        )}
        {info && (
          <div className="-mx-5 mt-3 border-t border-line">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_112px_88px] gap-4 border-b border-line px-5 py-2 text-caption text-muted md:grid" aria-hidden="true">
              <span>Provider</span>
              <span>Used for</span>
              <span>Key</span>
              <span />
            </div>
            <ul aria-label="Your keys">
              {info.providers.map((p) => {
                const saved = info.byProvider[p.id] ?? null;
                return (
                  <li key={p.id} aria-label={`Your ${p.label} key`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 border-b border-line px-5 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_112px_88px]">
                    <span className="min-w-0 truncate text-ui text-ink">{p.label}</span>
                    <span className="min-w-0 truncate text-small text-muted max-md:col-start-1 max-md:row-start-2" title={ownKeyCapability(p).short}>
                      {ownKeyCapability(p).short}
                    </span>
                    <span className="min-w-0 max-md:col-start-1 max-md:row-start-3">
                      {saved ? (
                        <>
                          <span aria-hidden="true" className="num font-mono text-small text-ink-2">
                            •••• {saved.last4}
                          </span>
                          <span className="sr-only">Key ending in {saved.last4}</span>
                        </>
                      ) : (
                        <span className="text-small text-muted">Not set</span>
                      )}
                    </span>
                    <span className="flex justify-end max-md:col-start-2 max-md:row-span-3 max-md:row-start-1">
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        disabled={!info.available}
                        onClick={() => setOpen(p.id)}
                        aria-label={`${saved ? 'Replace' : 'Add'} your ${p.label} key`}
                      >
                        {saved ? 'Replace' : 'Add key'}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </SettingsSection>
      {info && editing && (
        <OwnKeyDrawer
          p={editing}
          saved={info.byProvider[editing.id] ?? null}
          call={call}
          onClose={() => setOpen(null)}
          onSaved={(j) => {
            changed(j);
            setOpen(null);
          }}
        />
      )}
    </Region>
  );
}

/** Add or replace one of your own keys (or remove it), in a side sheet. */
function OwnKeyDrawer({ p, saved, call, onClose, onSaved }: { p: OwnKeyProvider; saved: { last4: string } | null; call: Call; onClose: () => void; onSaved: (j: MyKeys | null) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `own-key-${p.id}`;
  const formId = `${inputId}-form`;
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
    <Drawer
      open
      onClose={onClose}
      title={`Your ${p.label} key`}
      footer={
        <>
          {saved && (
            <button type="button" className="btn btn-danger-ghost mr-auto" disabled={busy} aria-label={`Remove your ${p.label} key`} onClick={() => void remove()}>
              <Trash2 /> Remove
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={busy || !key.trim()}>
            {busy && <Spinner size={16} />} Save key
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) void save();
        }}
      >
        <p className="text-body text-muted">
          {ownKeyCapability(p).short}. {saved ? `Your key ending in ${saved.last4} is saved.` : 'Runs in your own account, on your credits.'}
        </p>
        <Field
          label={saved ? `Replace your ${p.label} key` : `Your ${p.label} API key`}
          htmlFor={inputId}
          right={
            <a href={p.id === 'manus' ? 'https://manus.im' : p.keyUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
              Get a key <ExternalLink size={12} aria-hidden="true" />
            </a>
          }
        >
          <input id={inputId} className="input" type="password" autoComplete="off" spellCheck={false} autoFocus placeholder={saved ? 'Paste a new key to replace it' : `Paste your ${p.label} key`} value={key} onChange={(e) => setKey(e.target.value)} aria-invalid={!!error || undefined} />
        </Field>
        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-small text-bad">
            <CircleAlert size={14} className="mt-[3px] shrink-0" aria-hidden="true" /> {error}
          </p>
        )}
        {p.id === 'manus' && <ManusExplainer />}
      </form>
    </Drawer>
  );
}

/** What Manus does with your own account, and how to get its key. */
function ManusExplainer() {
  return (
    <div className="well flex flex-col gap-2 px-3 py-3 text-small">
      <p className="font-medium text-ink">Manus: your photos, social posts, pages and chats, in your own account</p>
      <p className="text-muted">
        Manus is an AI agent with its own browser. With your own Manus account it can make product photos, post on your Facebook, Instagram, TikTok, LinkedIn and X accounts (right away or scheduled), build pages and assets for you, and chat with you in the assistant. Tasks use your Manus credits.
      </p>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-ink-2">
        <li>
          Create a Manus account at{' '}
          <a className="link" href="https://manus.im" target="_blank" rel="noreferrer">
            manus.im
          </a>{' '}
          (free to start; tasks use Manus credits).
        </li>
        <li>
          In Manus, open Settings › Developers (API keys), press Create API Key, name it (for example “Yourlocalbusiness”) and copy it. Manus shows it only once.{' '}
          <a className="link" href="https://open.manus.ai/docs/v2/authentication" target="_blank" rel="noreferrer">
            Manus’s guide
          </a>
        </li>
        <li>Paste it above and press Save key.</li>
        <li>For posting: in Manus, sign in to each network once in its browser (Manus asks the first time it posts there for you).</li>
      </ol>
    </div>
  );
}

function Meter({ label, used, limit, text }: { label: string; used: number; limit: number; text: string }) {
  const pct = limitPercent(used, limit);
  const full = limit > 0 && used >= limit;
  return (
    <div>
      <p className="flex items-baseline justify-between gap-2 text-small">
        <span className="text-ink-2">{label}</span>
        <span className={cn('num font-mono text-caption', full ? 'text-bad' : 'text-muted')}>{text}</span>
      </p>
      {limit > 0 && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className={cn('h-full rounded-full transition-[width] duration-240 ease-out', full ? 'bg-bad-solid' : pct >= 80 ? 'bg-warn-solid' : 'bg-primary')} style={{ width: `${pct}%` }} />
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
    <Region name="Your usage">
      <SettingsSection
        title="Your usage"
        description={lim ? (lim.unlimited ? 'You have no daily limit.' : `Today on the app’s keys. Resets ${resetLabel(lim.resetsAt)} (midnight UTC).`) : undefined}
        actions={
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => void load()}>
            <RefreshCw /> Refresh
          </button>
        }
      >
        {error && !u && (
          <p role="alert" className="flex items-center gap-1.5 py-4 text-small text-bad">
            <CircleAlert size={14} className="shrink-0" aria-hidden="true" /> {error}
          </p>
        )}
        {!u && !error && (
          <p className="flex items-center gap-2 py-4 text-small text-muted">
            <Spinner size={14} /> Loading…
          </p>
        )}
        {u && lim && (
          <div className="flex flex-col gap-4 pb-5 pt-3">
            {!lim.unlimited && (
              <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
                <Meter
                  label="Requests"
                  used={requestsInUse(lim)}
                  limit={lim.requestsPerDay}
                  text={`${requestsInUse(lim)}${lim.requestsPerDay > 0 ? ` of ${lim.requestsPerDay}` : ' · no limit'}${lim.running ? ` (${lim.running} running)` : ''}`}
                />
                <Meter label="Cost" used={lim.usedUsd} limit={lim.usdPerDay} text={lim.usdPerDay > 0 ? `${fmtUsdSmall(lim.usedUsd)} of ${fmtUsdSmall(lim.usdPerDay)}` : `${fmtUsdSmall(lim.usedUsd)} · no limit`} />
              </div>
            )}
            {!lim.unlimited && lim.reached && (
              <div role="status">
                <Callout tone="warn">You’ve reached today’s limit on the app’s keys. Add your own key above to keep going now, or wait until it resets.</Callout>
              </div>
            )}
            {u.today.ownRequests > 0 && (
              <p className="text-small text-muted">
                Plus <span className="num font-mono text-ink-2">{u.today.ownRequests}</span> request{u.today.ownRequests === 1 ? '' : 's'} on your own keys today
                {u.today.ownUsd > 0 ? ` (${fmtUsdSmall(u.today.ownUsd)}, billed to your accounts)` : ''}, not limited.
              </p>
            )}
            <table className="w-full text-left text-small">
              <caption className="pb-1.5 text-left text-caption text-muted">Last 7 days (UTC)</caption>
              <thead className="border-b border-line text-caption text-muted">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Day</th>
                  <th className="py-1.5 pr-3 text-right font-medium">App’s keys</th>
                  {own && <th className="py-1.5 text-right font-medium">Your keys</th>}
                </tr>
              </thead>
              <tbody className="num divide-y divide-line">
                {u.days.map((d) => (
                  <tr key={d.day}>
                    <td className="py-1.5 pr-3 text-ink-2">{dayName(d.day, u.day)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-caption text-ink-2">
                      {d.requests} · {fmtUsdSmall(d.usd)}
                    </td>
                    {own && (
                      <td className="py-1.5 text-right font-mono text-caption text-ink-2">
                        {d.ownRequests} · {fmtUsdSmall(d.ownUsd)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {countersNote(u.storage, u.storageProblem) && <p className="text-caption text-muted">{countersNote(u.storage, u.storageProblem)}</p>}
          </div>
        )}
      </SettingsSection>
    </Region>
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
  const note = countersNote(storage, problem, { owner: true });
  return (
    <Region name="Daily limits for other people">
      <SettingsSection title="Daily limits for other people" description="How much each signed-in person can use your keys per day (UTC). Their own keys don’t count; you’re never limited. 0 means no limit.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) void save();
          }}
        >
          <SettingsRow label="Each person, per day" description={note && !error && valid ? <span role={problem ? 'alert' : undefined} className={problem ? 'text-warn' : undefined}>{note}</span> : undefined}>
            <div className="flex w-full flex-wrap items-end gap-2 md:max-w-[420px] md:justify-end">
              <Field label="Requests per day" htmlFor="limit-requests" className="w-[120px]">
                <input id="limit-requests" className="input num font-mono" type="number" min={0} max={100000} step={1} inputMode="numeric" value={reqs} disabled={!limits} onChange={(e) => setReqs(e.target.value)} aria-invalid={!valid && !!limits ? true : undefined} />
              </Field>
              <Field label="Cost per day ($)" htmlFor="limit-usd" className="w-[120px]">
                <input id="limit-usd" className="input num font-mono" type="number" min={0} max={10000} step={0.01} inputMode="decimal" value={usd} disabled={!limits} onChange={(e) => setUsd(e.target.value)} aria-invalid={!valid && !!limits ? true : undefined} />
              </Field>
              <button type="submit" className="btn btn-secondary" disabled={busy || !dirty}>
                {busy && <Spinner size={14} />} Save limits
              </button>
            </div>
          </SettingsRow>
          {(!valid && limits) || error ? (
            <p role={error ? 'alert' : undefined} className="flex items-center gap-1.5 pb-4 text-caption text-bad">
              <CircleAlert size={14} className="shrink-0" aria-hidden="true" /> {error ?? 'Use numbers of 0 or more.'}
            </p>
          ) : null}
        </form>
      </SettingsSection>
    </Region>
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

function PeopleUsage({ call }: { call: Call }) {
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="text-small text-muted">Requests and cost on your keys. Requests on their own keys are separate; they pay for those.</p>
        <button type="button" className="btn btn-ghost btn-xs ml-auto" onClick={() => void load()}>
          <RefreshCw /> Refresh
        </button>
      </div>
      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-small text-bad">
          <CircleAlert size={14} className="shrink-0" aria-hidden="true" /> {error}
        </p>
      )}
      {data && !data.users.length && <p className="text-small text-muted">Nobody else has used the AI in the last 7 days.</p>}
      {data && data.users.length > 0 && (
        <div className="scroll-thin max-h-[360px] w-full overflow-auto">
          <table className="w-full min-w-[480px] text-left text-small">
            <thead className="sticky top-0 border-b border-line bg-surface text-caption text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Person</th>
                <th className="py-1.5 pr-3 text-right font-medium">Today</th>
                <th className="py-1.5 pr-3 text-right font-medium">Last 7 days</th>
                <th className="py-1.5 text-right font-medium">Own keys (7 days)</th>
              </tr>
            </thead>
            <tbody className="num divide-y divide-line">
              {data.users.map((u) => {
                const t = todayOf(u.userId);
                return (
                  <tr key={u.userId}>
                    <td className="max-w-[220px] truncate py-1.5 pr-3 text-ink" title={u.email || u.userId}>
                      {u.email || `${u.userId.slice(0, 8)}…`}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-caption">{t ? `${t.requests} · ${fmtUsdSmall(t.usd)}` : '0'}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-caption">
                      {u.requests} · {fmtUsdSmall(u.usd)}
                    </td>
                    <td className="py-1.5 text-right font-mono text-caption text-muted">{u.ownRequests ? `${u.ownRequests} · ${fmtUsdSmall(u.ownUsd)}` : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Signed in as someone other than the owner: what powers each function (from /api/health), behind a disclosure.
 * (Open, the disclosure's content is the region of that name: no second region around it.)
 */
function OwnerManaged() {
  const ai = useRuntime((s) => s.ai);
  const byId = new Map(ai.providers.map((p) => [p.id, p]));
  return (
    <div className="card px-5">
      <Accordion type="single" collapsible>
        <AccordionItem value="powers" className="border-b-0">
          <AccordionTrigger>What powers each function</AccordionTrigger>
          <AccordionContent>
            <p className="mb-3 text-small text-muted">Only the app’s owner can change keys, models and effort. Where nothing is set up, the built-in engine writes.</p>
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
              {AI_FUNCTION_GROUPS.map((g) => (
                <div key={g.id}>
                  <p className="mb-1 text-caption font-medium text-muted">{g.label}</p>
                  <ul className="flex flex-col divide-y divide-line">
                    {AI_FUNCTIONS.filter((f) => f.group === g.id).map((f) => {
                      const p = byId.get(ai.routing[f.id]?.[0] ?? '');
                      const model = p?.models[f.kind];
                      return (
                        <li key={f.id} className="flex items-baseline justify-between gap-3 py-1.5 text-small">
                          <span className="text-ink-2">{f.label}</span>
                          <span className={cn('min-w-0 truncate text-right', p ? 'text-ink' : 'text-muted')} title={p && model ? `${p.label} · ${model}` : undefined}>
                            {p ? p.label : 'Built-in engine'}
                            {p && model && <span className="text-muted"> · {model}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
