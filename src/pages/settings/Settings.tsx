import { useRef, useState } from 'react';
import { Bot, Database, Download, FolderOpen, Link2, Moon, Palette, Plus, Sun, Trash2, Unplug, Upload, User, Users } from 'lucide-react';
import type { AppSettings, Brand, Project } from '@/lib/types';
import { cn, ensureUrl, fmtCompact, fmtRelative, readFileAsText, slugify } from '@/lib/utils';
import { useRuntime } from '@/lib/platform';
import { pushMyListings } from '@/lib/community';
import { PLATFORMS, SOCIAL_PLATFORMS, FORMATS } from '@/ai/knowledge';
import { brandKitTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useActiveProject, useStore, type StoreState } from '@/store/useStore';
import { defaultSettings } from '@/store/defaults';
import { toast } from '@/store/ui';
import { clearSampleData, hasSampleData, loadSampleData } from '@/store/sample';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, ChipInput, Field, Segmented, Tabs, Toggle, confirmAction } from '@/components/ui/primitives';
import { BannerDesigner, BrandImagesEditor, LogoDesigner, SocialLinksEditor } from '@/components/brand/BrandEditors';
import { BrandBanner, BrandLogo } from '@/components/brand/Logo';
import { PlatformChip } from '@/components/posts/PlatformIcon';
import { openConnect } from '@/components/posts/Connect';
import { download } from '@/components/ui/download';
import { AIProviders, ArtifactAI } from './AIProviders';

type Tab = 'brand' | 'ai' | 'accounts' | 'projects' | 'prefs';

export default function Settings() {
  const project = useActiveProject()!;
  const [tab, setTab] = useState<Tab>('brand');
  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="eyebrow mb-1">Settings</p>
        <h1 className="page-title">Workspace settings</h1>
        <p className="mt-1 text-[13.5px] text-muted">Your brand kit, AI keys, connected accounts, projects and data. Brand changes flow into every module automatically.</p>
      </header>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'brand', label: 'Brand', icon: <Palette size={15} /> },
          { id: 'ai', label: 'AI', icon: <Bot size={15} /> },
          { id: 'accounts', label: 'Accounts', icon: <Link2 size={15} /> },
          { id: 'projects', label: 'Projects & data', icon: <Database size={15} /> },
          { id: 'prefs', label: 'Preferences', icon: <User size={15} /> },
        ]}
      />
      {tab === 'brand' && <BrandSettings project={project} />}
      {tab === 'ai' && <AISettings />}
      {tab === 'accounts' && <Accounts />}
      {tab === 'projects' && <ProjectsData />}
      {tab === 'prefs' && <Preferences />}
    </div>
  );
}

function Card({ title, desc, children, action }: { title: string; desc?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="panel p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-title">{title}</h2>
          {desc && <p className="mt-0.5 text-[13px] text-muted">{desc}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// ───────────────────────── Brand ─────────────────────────

function BrandSettings({ project }: { project: Project }) {
  const updateBrand = useStore((s) => s.updateBrand);
  const brand = project.brand;
  const ai = useAI(brandKitTask);
  const [palettes, setPalettes] = useState<Brand['colors'][] | undefined>(undefined);
  const set = (patch: Partial<Brand>) => {
    updateBrand(patch);
    if (useStore.getState().myListings.some((l) => l.projectId === project.id)) pushMyListings();
  };

  const refreshCopy = async () => {
    const r = await ai.run({});
    if (!r) return;
    setPalettes(r.paletteOptions);
    set({ tagline: r.tagline, pitch: r.pitch, valueProp: r.valueProp, audience: r.audience, personality: r.personality, mission: r.mission, nameOptions: r.nameOptions, domainIdeas: r.domainIdeas });
    toast({ kind: 'ai', title: 'Brand copy refreshed', body: 'Your name, logo and colors were kept.' });
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card title="Identity" desc="Name, website and the words that describe you.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Brand name" htmlFor="b-name">
              <input id="b-name" className="input" value={brand.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Website" htmlFor="b-url">
              <input id="b-url" className="input" value={brand.websiteUrl} onChange={(e) => set({ websiteUrl: e.target.value })} onBlur={(e) => e.target.value && set({ websiteUrl: ensureUrl(e.target.value) })} placeholder="https://yourbrand.com" />
            </Field>
            <Field label="Tagline" htmlFor="b-tag" className="sm:col-span-2">
              <input id="b-tag" className="input" value={brand.tagline} onChange={(e) => set({ tagline: e.target.value })} />
            </Field>
            <Field label="Elevator pitch" htmlFor="b-pitch" className="sm:col-span-2">
              <AutoTextarea id="b-pitch" value={brand.pitch} onChange={(v) => set({ pitch: v })} minRows={2} className="text-[13.5px]" />
            </Field>
            <Field label="Value proposition" htmlFor="b-vp" className="sm:col-span-2">
              <AutoTextarea id="b-vp" value={brand.valueProp} onChange={(v) => set({ valueProp: v })} minRows={2} className="text-[13.5px]" />
            </Field>
            <Field label="Target audience" htmlFor="b-aud" className="sm:col-span-2">
              <AutoTextarea id="b-aud" value={brand.audience} onChange={(v) => set({ audience: v })} minRows={2} className="text-[13.5px]" />
            </Field>
            <Field label="Mission" htmlFor="b-mission" className="sm:col-span-2">
              <AutoTextarea id="b-mission" value={brand.mission} onChange={(v) => set({ mission: v })} minRows={1} className="text-[13.5px]" />
            </Field>
            <Field label="Personality" className="sm:col-span-2">
              <ChipInput values={brand.personality} onChange={(v) => set({ personality: v })} placeholder="e.g. warm, expert, playful" max={8} />
            </Field>
            <Field label="URL slug" htmlFor="b-slug" hint="Used for page URLs and handles.">
              <input id="b-slug" className="input" value={brand.slug} onChange={(e) => set({ slug: slugify(e.target.value) })} />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <GenerateButton running={ai.running} onClick={refreshCopy} size="sm" variant="secondary">
              Refresh brand copy with AI
            </GenerateButton>
            <span className="text-xs text-muted">Rewrites tagline, pitch, value prop, audience and mission. Keeps name, logo and colors.</span>
          </div>
          <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} compact className="mt-3" />
          {ai.result && !ai.running && <AIResultBar className="mt-3" provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
          {brand.nameOptions.length > 1 && (
            <div className="mt-4">
              <p className="label">Other name ideas</p>
              <div className="flex flex-wrap gap-1.5">
                {brand.nameOptions.map((n) => (
                  <button key={n.name} className={cn('chip', brand.name === n.name && 'chip-active')} title={n.rationale} onClick={() => set({ name: n.name, slug: slugify(n.name) })}>
                    {n.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card title="Logo & colors" desc="Upload your own logo or design one from an icon, shape and font.">
          <LogoDesigner brand={brand} onChange={set} paletteOptions={palettes} />
        </Card>
        <Card title="Cover banner">
          <BannerDesigner brand={brand} onChange={set} />
        </Card>
        <Card title="Brand images" desc="Photos and product shots used in posts, listings and covers.">
          <BrandImagesEditor brand={brand} onChange={(images) => set({ images })} />
        </Card>
        <Card title="Social profiles">
          <SocialLinksEditor socials={brand.socials} onChange={(socials) => set({ socials })} />
        </Card>
      </div>
      <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4 xl:self-start">
        <section className="panel overflow-hidden" aria-label="Brand preview">
          <BrandBanner brand={brand} rounded={false} className="aspect-[3/1] w-full" />
          <div className="flex flex-col gap-2 p-4" style={{ background: brand.colors.paper, color: brand.colors.ink }}>
            <BrandLogo brand={brand} size={40} layout="horizontal" />
            {brand.tagline && <p className="text-[13px] opacity-80">{brand.tagline}</p>}
            <div className="mt-1 flex gap-1.5">
              {(['primary', 'secondary', 'accent', 'ink', 'paper'] as const).map((k) => (
                <span key={k} className="h-7 flex-1 rounded ring-1 ring-black/10" style={{ background: brand.colors[k] }} title={`${k}: ${brand.colors[k]}`} />
              ))}
            </div>
          </div>
        </section>
        <p className="text-xs text-muted">Changes save automatically and update your Studio, sales page, emails, posts and Marketplace listing.</p>
      </aside>
    </div>
  );
}

// ───────────────────────── AI ─────────────────────────

function AISettings() {
  return __ARTIFACT_BUILD__ ? <ArtifactAI /> : <AIProviders />;
}

// ───────────────────────── Accounts ─────────────────────────

function Accounts() {
  const accounts = useStore((s) => s.settings.accounts);
  const disconnect = useStore((s) => s.disconnectAccount);
  return (
    <Card title="Connected accounts" desc="Connections here are a demo: they store a handle and follower count to model reach. No real login happens and nothing is posted to the networks.">
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {SOCIAL_PLATFORMS.map((p) => {
          const a = accounts[p];
          return (
            <li key={p} className="flex items-center gap-3 rounded-md border border-line px-3 py-3">
              <PlatformChip platform={p} showLabel={false} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold">{PLATFORMS[p].label}</span>
                <span className="block truncate text-xs text-muted">{a?.connected ? `${PLATFORMS[p].handlePrefix}${a.handle} · ${fmtCompact(a.followers)} followers${a.connectedAt ? ` · connected ${fmtRelative(a.connectedAt)}` : ''}` : 'Not connected'}</span>
              </span>
              {a?.connected ? (
                <button className="btn btn-ghost btn-sm text-muted hover:text-bad" onClick={() => disconnect(p)}>
                  <Unplug size={14} /> Disconnect
                </button>
              ) : (
                <button className="btn btn-secondary btn-sm" onClick={() => openConnect([p])}>
                  <Link2 size={14} /> Connect
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ───────────────────────── Projects & data ─────────────────────────

const EXPORT_KEYS = ['projects', 'activeProjectId', 'posts', 'ads', 'skills', 'genLog', 'myListings', 'cart', 'orders', 'sales', 'notices', 'settings'] as const;

function ProjectsData() {
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);
  const setActive = useStore((s) => s.setActiveProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const createProject = useStore((s) => s.createProject);
  const replaceState = useStore((s) => s.replaceState);
  const resetAll = useStore((s) => s.resetAll);
  const active = projects.find((p) => p.id === activeId) ?? null;
  const fileRef = useRef<HTMLInputElement>(null);
  const [sample, setSample] = useState(hasSampleData());

  const exportJson = () => {
    const s = useStore.getState();
    const data = Object.fromEntries(EXPORT_KEYS.map((k) => [k, s[k]]));
    download(`yourlocalbusiness-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'yourlocalbusiness', version: 1, exportedAt: new Date().toISOString(), data }, null, 2));
  };

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await readFileAsText(file)) as { app?: string; data?: Partial<StoreState> };
      const data = parsed?.data;
      if (parsed?.app !== 'yourlocalbusiness' || !data || !Array.isArray(data.projects)) throw new Error('bad');
      if (!(await confirmAction({ title: 'Replace your workspace with this backup?', body: `${data.projects.length} project${data.projects.length === 1 ? '' : 's'} will be loaded. Your current data on this device is replaced. Images and videos aren’t part of backups.`, confirmLabel: 'Import backup', danger: true }))) return;
      const d = defaultSettings();
      const patch: Partial<StoreState> = {};
      for (const k of EXPORT_KEYS) if (k in data) (patch as Record<string, unknown>)[k] = (data as Record<string, unknown>)[k];
      patch.settings = { ...d, ...(data.settings ?? {}), ai: { ...d.ai, ...(data.settings?.ai ?? {}) }, profile: { ...d.profile, ...(data.settings?.profile ?? {}) }, accounts: { ...d.accounts, ...(data.settings?.accounts ?? {}) } };
      if (!patch.activeProjectId || !data.projects.some((p) => p.id === patch.activeProjectId)) patch.activeProjectId = data.projects[0]?.id ?? null;
      replaceState(patch);
      toast({ kind: 'success', title: 'Backup imported' });
    } catch {
      toast({ kind: 'error', title: 'That file isn’t a Yourlocalbusiness backup' });
    }
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <Card
        title="Projects"
        desc="Each project has its own brand, studio, marketing and analytics."
        action={
          <div className="flex gap-2">
            <button className="btn btn-secondary btn-sm" onClick={() => createProject('business', 'new')}>
              <Plus size={14} /> New business
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => createProject('product', 'new')}>
              <Plus size={14} /> New product
            </button>
          </div>
        }
      >
        <ul className="flex flex-col gap-2">
          {projects.map((p) => (
            <li key={p.id} className={cn('flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5', p.id === activeId ? 'border-primary bg-primary-soft/50' : 'border-line')}>
              <BrandLogo brand={p.brand} size={30} layout="mark" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{p.brand.name || 'Untitled project'}</span>
                <span className="block text-xs text-muted">
                  {p.track === 'business' ? 'Business' : p.format ? FORMATS[p.format].label : 'Digital product'} · updated {fmtRelative(p.updatedAt)}
                  {!p.onboarded && ' · setup unfinished'}
                </span>
              </span>
              {p.id === activeId ? (
                <span className="badge bg-primary text-on-primary">Active</span>
              ) : (
                <button className="btn btn-secondary btn-xs" onClick={() => setActive(p.id)}>
                  <FolderOpen size={12} /> Open
                </button>
              )}
              <button
                className="btn btn-ghost btn-icon btn-xs text-muted hover:text-bad"
                aria-label={`Delete ${p.brand.name || 'project'}`}
                onClick={async () => {
                  if (await confirmAction({ title: `Delete ${p.brand.name || 'this project'}?`, body: 'Its posts, campaigns and Marketplace listing are removed too. This can’t be undone.', confirmLabel: 'Delete project', danger: true })) {
                    deleteProject(p.id);
                    pushMyListings();
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <div className="flex min-w-0 flex-col gap-5">
        <Card title="Sample data" desc="Clearly labelled demo posts, subscribers and sales so you can explore Analytics before real data exists.">
          <div className="flex flex-wrap gap-2">
            {sample ? (
              <button
                className="btn btn-secondary"
                onClick={() => {
                  clearSampleData();
                  setSample(false);
                  toast({ kind: 'info', title: 'Sample data cleared' });
                }}
              >
                <Trash2 size={15} /> Clear sample data
              </button>
            ) : (
              <button
                className="btn btn-secondary"
                disabled={!active}
                onClick={() => {
                  if (!active) return;
                  loadSampleData(active);
                  setSample(true);
                  toast({ kind: 'info', title: 'Sample data loaded', body: 'It’s labelled “Sample” everywhere.' });
                }}
              >
                <Database size={15} /> Load sample data for {active?.brand.name || 'this project'}
              </button>
            )}
          </div>
        </Card>
        <Card title="Backup & restore" desc="Everything lives in this browser. Export a backup to move it or keep it safe (uploaded images and videos aren’t included).">
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-secondary" onClick={exportJson}>
              <Download size={15} /> Export backup (.json)
            </button>
            <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> Import backup
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) importJson(f);
              }}
            />
          </div>
        </Card>
        <Card title="Danger zone">
          <button
            className="btn btn-danger"
            onClick={async () => {
              if (await confirmAction({ title: 'Erase everything on this device?', body: 'All projects, posts, skills, listings and orders are deleted. Export a backup first if you might need them.', confirmLabel: 'Erase everything', danger: true })) {
                resetAll();
                pushMyListings();
              }
            }}
          >
            <Trash2 size={15} /> Reset workspace
          </button>
        </Card>
      </div>
    </div>
  );
}

// ───────────────────────── Preferences ─────────────────────────

function Preferences() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const community = useRuntime((s) => s.community);
  const set = (patch: Partial<AppSettings>) => updateSettings((s) => ({ ...s, ...patch }));
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <Card title="Profile" desc="Used to pre-fill checkout, opt-in tests and email sign-offs.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Your name" htmlFor="pf-name">
            <input id="pf-name" className="input" autoComplete="name" value={settings.profile.name} onChange={(e) => set({ profile: { ...settings.profile, name: e.target.value } })} />
          </Field>
          <Field label="Email" htmlFor="pf-email">
            <input id="pf-email" type="email" className="input" autoComplete="email" value={settings.profile.email} onChange={(e) => set({ profile: { ...settings.profile, email: e.target.value } })} />
          </Field>
        </div>
      </Card>
      <Card title="Appearance">
        <Segmented<AppSettings['theme']>
          value={settings.theme}
          onChange={(theme) => set({ theme })}
          options={[
            { id: 'system', label: 'System' },
            { id: 'light', label: 'Light', icon: <Sun size={14} /> },
            { id: 'dark', label: 'Dark', icon: <Moon size={14} /> },
          ]}
        />
      </Card>
      <Card title="Marketplace" desc={community === 'live' ? 'This app is shared: listings sync between everyone who opens it.' : 'Listings stay on this device unless the app is opened as a shared page.'}>
        <div className="flex flex-col gap-4">
          <Toggle
            checked={settings.shareToCommunity}
            onChange={(v) => {
              set({ shareToCommunity: v });
              setTimeout(() => pushMyListings(), 0);
            }}
            label="Share my listings with other viewers"
            description="Other people who open this app can browse and buy what you publish."
          />
          <Toggle checked={settings.showSampleListings} onChange={(v) => set({ showSampleListings: v })} label="Show sample listings" description="Example products and local businesses, labelled “Sample”, so the store never looks empty." />
          <Toggle checked={settings.marketActivity} onChange={(v) => set({ marketActivity: v })} label="Demo mode: simulated buyers" description="Every minute or so, a simulated buyer may purchase one of your listings. These sales are labelled “Simulated”." />
        </div>
      </Card>
      <Card title="About">
        <p className="flex items-center gap-2 text-[13px] text-ink-2">
          <Users size={15} className="text-primary" /> Yourlocalbusiness keeps your data in this browser. AI runs on Claude when available, otherwise on the built-in engine.
        </p>
      </Card>
    </div>
  );
}
