import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronRight, CircleUserRound, Database, Download, FolderOpen, Globe, KeyRound, Link2, Monitor, Moon, Palette, Pencil, Plus, SlidersHorizontal, Sun, Trash2, Upload } from 'lucide-react';
import type { AppSettings, Brand, Project } from '@/lib/types';
import { cn, ensureUrl, fmtRelative, readFileAsText, slugify } from '@/lib/utils';
import { useRuntime } from '@/lib/platform';
import { pushMyListings } from '@/lib/community';
import { saveBrand, brandCopyFrom } from '@/lib/brandSave';
import { EXPORT_KEYS, backupFileName, backupJson } from '@/lib/backup';
import { deleteProjectEverywhere } from '@/lib/projectActions';
import { usePublishAccess } from '@/lib/publish';
import { PLATFORMS, POST_PLATFORMS, FORMATS } from '@/ai/knowledge';
import { brandKitTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useActiveProject, useStore, type StoreState } from '@/store/useStore';
import { defaultSettings } from '@/store/defaults';
import { cleanWorkspace } from '@/store/cleanup';
import { toast, useUI } from '@/store/ui';
import { useAuth } from '@/lib/cloud/auth';
import { AccountSettings } from '@/components/auth/Account';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, Badge, Callout, ChipInput, InfoTip, MoreMenu, PageHeader, Segmented, SettingsRow, SettingsSection, Toggle, confirmAction } from '@/components/ui/primitives';
import { BrandImagesEditor, LogoDesigner, SocialLinksEditor } from '@/components/brand/BrandEditors';
import { MetaConnections } from './MetaConnections';
import { LogoMark } from '@/components/brand/Logo';
import { manusSetupHint, useManusReady } from '@/components/posts/ManusPost';
import { download } from '@/components/ui/download';
import { AIProviders, ArtifactAI } from './AIProviders';
import { DomainsCard } from './Domains';

type Tab = 'brand' | 'domains' | 'ai' | 'accounts' | 'projects' | 'prefs' | 'account';

/** The sections, in the order of the sub-navigation (ids never change: the palette and the assistant open them). */
const SECTIONS: { id: Tab; label: string; hint: string; icon: ReactNode }[] = [
  { id: 'brand', label: 'Brand', hint: 'Name, logo, colours and photos', icon: <Palette /> },
  { id: 'domains', label: 'Domains', hint: 'Your own web addresses', icon: <Globe /> },
  { id: 'ai', label: 'AI keys', hint: 'What powers the AI', icon: <KeyRound /> },
  { id: 'accounts', label: 'Social accounts', hint: 'Profiles and posting with Manus', icon: <Link2 /> },
  { id: 'projects', label: 'Projects & data', hint: 'Projects, backups and reset', icon: <Database /> },
  { id: 'prefs', label: 'Preferences', hint: 'Your name, theme and Marketplace', icon: <SlidersHorizontal /> },
  { id: 'account', label: 'Account', hint: 'Sign-in, password and deletion', icon: <CircleUserRound /> },
];
const TAB_IDS = SECTIONS.map((s) => s.id) as string[];

export default function Settings() {
  const project = useActiveProject()!;
  const signedIn = useAuth((s) => s.phase === 'ready');
  const { access } = usePublishAccess();
  const wanted = useUI((s) => s.settingsTab);
  const [tab, setTab] = useState<Tab>(() => (wanted && TAB_IDS.includes(wanted) && (wanted !== 'account' || signedIn) ? (wanted as Tab) : 'brand'));
  // phones: the list of sections, or one open section (a request from elsewhere opens it directly)
  const [open, setOpen] = useState(() => !!wanted && TAB_IDS.includes(wanted));
  // "domains" from a page's Publish panel: the Domains section, with its Add domain button in view
  const [focusDomains, setFocusDomains] = useState(wanted === 'domains');
  // the account menu, the palette and the assistant ask for a section
  useEffect(() => {
    if (!wanted) return;
    if (TAB_IDS.includes(wanted) && (wanted !== 'account' || signedIn)) {
      setTab(wanted as Tab);
      setOpen(true);
      if (wanted === 'domains') setFocusDomains(true);
    }
    useUI.getState().setSettingsTab(null);
  }, [wanted, signedIn]);

  // Domains only where publishing is on; Account only when signed in
  const domainsOn = access === 'ready' || access === 'signed-out';
  const items = SECTIONS.filter((s) => (s.id !== 'domains' || domainsOn || (tab === 'domains' && access === 'checking')) && (s.id !== 'account' || signedIn));
  const shown: Tab = items.some((s) => s.id === tab) ? tab : 'brand';
  const current = SECTIONS.find((s) => s.id === shown)!;

  const choose = (id: Tab) => {
    setTab(id);
    setOpen(true);
    document.getElementById('main-scroll')?.scrollTo({ top: 0 });
  };
  // phones: the list and the open section take each other's place, so the focus goes along (to the way back,
  // then back to the section's row) instead of dropping to the page
  const backBar = useRef<HTMLDivElement>(null);
  const phoneList = useRef<HTMLDivElement>(null);
  const openFromList = (id: Tab) => {
    choose(id);
    requestAnimationFrame(() => backBar.current?.querySelector<HTMLElement>('button')?.focus());
  };
  const backToList = () => {
    setOpen(false);
    requestAnimationFrame(() => phoneList.current?.querySelector<HTMLElement>(`[data-section="${shown}"]`)?.focus());
  };
  // a vertical tab list: up and down move between sections (the focus goes with the selection); in the
  // phones' list they only move the focus, and Enter opens a section
  const onKey = (e: KeyboardEvent<HTMLDivElement>, select: boolean) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    // (React clears currentTarget once the handler returns: keep the list for the next frame)
    const list = e.currentTarget;
    const at = list.querySelector<HTMLElement>('[data-section]:focus')?.dataset.section;
    const i = items.findIndex((s) => s.id === (select ? shown : at ?? shown));
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    if (select) choose(items[j].id);
    requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-section="${items[j].id}"]`)?.focus());
  };

  return (
    <div>
      {/* wide screens, and the list of sections on phones */}
      <PageHeader title="Settings" className={cn(open && 'max-lg:hidden')} />
      {/* phones: one section, with the way back to the list */}
      <div ref={backBar} className={cn('lg:hidden', !open && 'hidden')}>
        <PageHeader title={current.label} back={{ label: 'Settings', onClick: backToList }} />
      </div>

      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
        <div role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={(e) => onKey(e, true)} className="hidden flex-col gap-0.5 self-start lg:sticky lg:top-0 lg:flex">
          {items.map((s) => {
            const on = s.id === shown;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`settings-tab-${s.id}`}
                data-section={s.id}
                aria-selected={on}
                aria-controls="settings-panel"
                aria-current={on ? 'page' : undefined}
                tabIndex={on ? 0 : -1}
                className="nav-item"
                onClick={() => choose(s.id)}
              >
                {s.icon}
                {s.label}
              </button>
            );
          })}
        </div>

        {/* phones: every section as a row */}
        <div ref={phoneList} role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={(e) => onKey(e, false)} className={cn('card flex flex-col divide-y divide-line overflow-hidden lg:hidden', open && 'hidden')}>
          {items.map((s) => (
            <button key={s.id} type="button" role="tab" data-section={s.id} aria-selected={s.id === shown} aria-controls="settings-panel" onClick={() => openFromList(s.id)} className="flex min-h-14 items-center gap-3 px-4 py-2.5 text-left transition-colors duration-120 hover:bg-surface-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2 [&>svg]:size-4">{s.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-ui text-ink">{s.label}</span>
                <span className="block truncate text-small text-muted">{s.hint}</span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden="true" />
            </button>
          ))}
        </div>

        <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${shown}`} className={cn('min-w-0', !open && 'max-lg:hidden')}>
          {/* (per project: switching projects starts the section afresh, so nothing says "Saved" for an edit nobody made) */}
          {shown === 'brand' && <BrandSettings key={project.id} project={project} />}
          {shown === 'domains' && (
            <div className="max-w-[880px]">
              <DomainsCard focus={focusDomains} onFocused={() => setFocusDomains(false)} />
            </div>
          )}
          {shown === 'ai' && <AISettings />}
          {shown === 'accounts' && <Accounts key={project.id} />}
          {shown === 'projects' && <ProjectsData />}
          {shown === 'prefs' && <Preferences />}
          {shown === 'account' && signedIn && (
            <div className="max-w-[880px]">
              <AccountSettings />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── "Saved" ─────────────────────────

/**
 * Changes save as you type: a short "Saved" shows a moment after the last one, then fades. `value` is
 * what's being edited (compared by its JSON); the first value seen doesn't count as a change.
 */
function useSaved(value: unknown): boolean {
  const key = JSON.stringify(value ?? null);
  const first = useRef(key);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (key === first.current) return;
    first.current = key;
    const show = setTimeout(() => setShown(true), 500);
    const hide = setTimeout(() => setShown(false), 1700);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [key]);
  return shown;
}

function Saved({ shown }: { shown: boolean }) {
  return (
    <span aria-live="polite" className={cn('inline-flex items-center gap-1 text-caption text-good transition-opacity duration-240 ease-out', shown ? 'opacity-100' : 'opacity-0')}>
      {shown && (
        <>
          <Check size={12} aria-hidden="true" /> Saved
        </>
      )}
    </span>
  );
}

// ───────────────────────── Brand ─────────────────────────

/** Long text edited in place: a borderless field that shows its edge on hover and focus. */
const INLINE = 'input-inline -mx-3 -mt-1.5 w-[calc(100%+24px)] !max-w-none';

function BrandSettings({ project }: { project: Project }) {
  const brand = project.brand;
  const ai = useAI(brandKitTask);
  const [palettes, setPalettes] = useState<Brand['colors'][] | undefined>(undefined);
  // the active project's brand, and its shared Marketplace listing when it's listed
  const set = (patch: Partial<Brand>) => saveBrand(patch);
  const identitySaved = useSaved([brand.name, brand.websiteUrl, brand.tagline, brand.pitch, brand.valueProp, brand.audience, brand.mission, brand.personality, brand.slug]);
  const lookSaved = useSaved([brand.logo, brand.colors, brand.banner]);

  const refreshCopy = async () => {
    const r = await ai.run({});
    if (!r) return;
    setPalettes(r.paletteOptions);
    set(brandCopyFrom(r));
    toast({ kind: 'ai', title: 'Brand copy refreshed', body: 'Your name, logo and colors were kept.' });
  };

  return (
    <div className="flex max-w-[880px] flex-col gap-6">
      <SettingsSection title="Identity" description="Your name and the words that describe you. Changes save as you type." actions={<Saved shown={identitySaved} />}>
        <SettingsRow label="Brand name" htmlFor="b-name" description={brand.nameOptions.length > 1 ? 'Or one of your brand kit’s ideas.' : undefined}>
          <div className="flex w-full flex-col gap-2 md:max-w-[420px]">
            <input id="b-name" className="input" value={brand.name} onChange={(e) => set({ name: e.target.value })} />
            {brand.nameOptions.length > 1 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Other name ideas">
                {brand.nameOptions.map((n) => (
                  <button key={n.name} type="button" className={cn('chip', brand.name === n.name && 'chip-active')} aria-pressed={brand.name === n.name} title={n.rationale} onClick={() => set({ name: n.name, slug: slugify(n.name) })}>
                    {brand.name === n.name && <Check aria-hidden="true" />}
                    {n.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </SettingsRow>
        <SettingsRow label="Website" htmlFor="b-url">
          <input id="b-url" className="input" value={brand.websiteUrl} onChange={(e) => set({ websiteUrl: e.target.value })} onBlur={(e) => e.target.value && set({ websiteUrl: ensureUrl(e.target.value) })} placeholder="https://yourbrand.com" />
        </SettingsRow>
        <SettingsRow label="Tagline" htmlFor="b-tag">
          <input id="b-tag" className="input" value={brand.tagline} onChange={(e) => set({ tagline: e.target.value })} />
        </SettingsRow>
        <SettingsRow label="Elevator pitch" htmlFor="b-pitch" stack>
          <AutoTextarea id="b-pitch" rows={2} value={brand.pitch} onChange={(v) => set({ pitch: v })} minRows={2} className={INLINE} placeholder="What you do, for whom, and why it’s different" />
        </SettingsRow>
        <SettingsRow label="Value proposition" htmlFor="b-vp" stack>
          <AutoTextarea id="b-vp" rows={1} value={brand.valueProp} onChange={(v) => set({ valueProp: v })} minRows={1} className={INLINE} placeholder="The one result people get from you" />
        </SettingsRow>
        <SettingsRow label="Target audience" htmlFor="b-aud" stack>
          <AutoTextarea id="b-aud" rows={1} value={brand.audience} onChange={(v) => set({ audience: v })} minRows={1} className={INLINE} placeholder="Who you serve, as specifically as you can" />
        </SettingsRow>
        <SettingsRow label="Mission" htmlFor="b-mission" stack>
          <AutoTextarea id="b-mission" rows={1} value={brand.mission} onChange={(v) => set({ mission: v })} minRows={1} className={INLINE} placeholder="Why you do it, in one sentence" />
        </SettingsRow>
        <SettingsRow label="Personality" description="Up to 8 words for how you sound.">
          <div className="w-full md:max-w-[420px]">
            <ChipInput values={brand.personality} onChange={(v) => set({ personality: v })} placeholder="e.g. warm, expert, playful" max={8} />
          </div>
        </SettingsRow>
        <SettingsRow label="File name" description="Used in the names of files you download." htmlFor="b-slug">
          <input id="b-slug" className="input font-mono" value={brand.slug} onChange={(e) => set({ slug: slugify(e.target.value) })} />
        </SettingsRow>
        <SettingsRow label="Refresh the copy" description="Rewrites the words that describe you. Keeps your name, logo and colours.">
          <GenerateButton running={ai.running} onClick={refreshCopy} size="sm" runningLabel="Writing…">
            Refresh brand copy with AI
          </GenerateButton>
        </SettingsRow>
        {(ai.running || (ai.result && !ai.running)) && (
          <div className="pb-4">
            <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} compact />
            {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Logo, colours & banner" description="Upload your logo or design one from an icon, a shape and a font." actions={<Saved shown={lookSaved} />}>
        <div className="pb-4 pt-2">
          <LogoDesigner brand={brand} onChange={set} paletteOptions={palettes} withBanner />
        </div>
      </SettingsSection>

      <SettingsSection title="Brand images" description="Photos and product shots for posts, listings and covers.">
        <div className="pb-4 pt-2">
          <BrandImagesEditor brand={brand} onChange={(images) => set({ images })} />
        </div>
      </SettingsSection>
    </div>
  );
}

// ───────────────────────── AI ─────────────────────────

function AISettings() {
  return __ARTIFACT_BUILD__ ? <ArtifactAI /> : <AIProviders />;
}

// ───────────────────────── Social accounts ─────────────────────────

function Accounts() {
  const project = useActiveProject()!;
  const updateBrand = useStore((s) => s.updateBrand);
  const ready = useManusReady();
  const saved = useSaved(project.brand.socials);
  const networks = POST_PLATFORMS.map((p) => PLATFORMS[p].label.replace(' (Twitter)', '')).join(', ');
  return (
    <div className="flex max-w-[880px] flex-col gap-6">
      {!__ARTIFACT_BUILD__ && <MetaConnections />}
      {ready ? (
        <Callout tone="good" title="Manus is ready to post for you.">
          It posts on {networks}, right away or scheduled, using your Manus credits.
        </Callout>
      ) : (
        <Callout
          tone="warn"
          title="Manus isn’t set up yet."
          action={
            !__ARTIFACT_BUILD__ && (
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => useUI.getState().setSettingsTab('ai')}>
                Open AI keys
              </button>
            )
          }
        >
          {manusSetupHint()}
        </Callout>
      )}
      <SettingsSection
        title="Your profiles"
        description={`For ${project.brand.name || 'this project'}. Shown in post previews; they tell Manus which account to post as.`}
        actions={
          <span className="flex items-center gap-1">
            <Saved shown={saved} />
            <InfoTip title="How posting works" label="How posting works">
              These links only identify your profiles; they don’t authorize posting. Connect a Facebook Page or Instagram professional account above for direct publishing. Manus can also open its own browser to post to supported networks. Otherwise, copy the post text and download its image from the ⋯ menu, post it yourself, then choose Mark as posted.
            </InfoTip>
          </span>
        }
      >
        <SocialLinksEditor socials={project.brand.socials} onChange={(socials) => updateBrand({ socials })} projectId={project.id} voiceSetup="none" />
      </SettingsSection>
    </div>
  );
}

// ───────────────────────── Projects & data ─────────────────────────

function ProjectsData() {
  const signedIn = useAuth((s) => s.phase === 'ready');
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);
  const setActive = useStore((s) => s.setActiveProject);
  const createProject = useStore((s) => s.createProject);
  const replaceState = useStore((s) => s.replaceState);
  const resetAll = useStore((s) => s.resetAll);
  const fileRef = useRef<HTMLInputElement>(null);

  const exportJson = () => download(backupFileName(), backupJson());

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await readFileAsText(file)) as { app?: string; data?: Partial<StoreState> };
      const data = parsed?.data;
      if (parsed?.app !== 'yourlocalbusiness' || !data || !Array.isArray(data.projects)) throw new Error('bad');
      if (!(await confirmAction({ title: 'Replace your workspace with this backup?', body: `${data.projects.length} project${data.projects.length === 1 ? '' : 's'} will be loaded. Your current data on this device is replaced. Images and videos aren’t part of backups.`, confirmLabel: 'Import backup', danger: true }))) return;
      const d = defaultSettings();
      const patch: Partial<StoreState> = {};
      for (const k of EXPORT_KEYS) if (k in data) (patch as Record<string, unknown>)[k] = (data as Record<string, unknown>)[k];
      // the AI server address is this device's choice: a backup (possibly from someone else) never changes it
      const serverUrl = useStore.getState().settings.ai.serverUrl;
      patch.settings = { ...d, ...(data.settings ?? {}), ai: { ...d.ai, ...(data.settings?.ai ?? {}), serverUrl }, profile: { ...d.profile, ...(data.settings?.profile ?? {}) } };
      if (!patch.activeProjectId || !data.projects.some((p) => p.id === patch.activeProjectId)) patch.activeProjectId = data.projects[0]?.id ?? null;
      replaceState(patch);
      // an older backup may hold things that version made up
      cleanWorkspace();
      toast({ kind: 'success', title: 'Backup imported' });
    } catch {
      toast({ kind: 'error', title: 'That file isn’t a Yourlocalbusiness backup' });
    }
  };

  const remove = async (p: Project) => {
    if (await confirmAction({ title: `Delete ${p.brand.name || 'this project'}?`, body: 'Its posts, campaigns and Marketplace listing are removed too. This can’t be undone.', confirmLabel: 'Delete project', danger: true })) deleteProjectEverywhere(p.id);
  };
  // the name lives in Brand: open it there, ready to type
  const rename = () => {
    useUI.getState().setSettingsTab('brand');
    setTimeout(() => document.getElementById('b-name')?.focus(), 80);
  };

  const newProjectButtons = (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => createProject('business', 'new')}>
        <Plus /> New business
      </button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => createProject('product', 'new')}>
        <Plus /> New product
      </button>
    </>
  );

  return (
    <div className="flex max-w-[880px] flex-col gap-6">
      <SettingsSection
        title="Projects"
        description="Each project has its own brand, studio, marketing and analytics."
        // phones: the two buttons go under the list (beside the title they'd squeeze it to a word per line)
        actions={<span className="hidden items-center gap-2 sm:flex">{newProjectButtons}</span>}
      >
        <ul className="-mx-5 mt-3 flex flex-col border-t border-line" aria-label="Your projects">
          {projects.map((p) => {
            const active = p.id === activeId;
            const name = p.brand.name || 'Untitled project';
            const meta = `${p.track === 'business' ? 'Business' : p.format ? FORMATS[p.format].label : 'Digital product'} · updated ${fmtRelative(p.updatedAt)}`;
            return (
              <li key={p.id} className="flex min-h-14 items-center gap-3 border-b border-line px-5 py-2.5 last:border-b-0">
                <LogoMark colors={p.brand.colors} logo={p.brand.logo} name={p.brand.name || 'P'} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-ui text-ink" title={name}>
                      {name}
                    </span>
                    {active && <Badge tone="primary">Open now</Badge>}
                    {!p.onboarded && <Badge>Setup</Badge>}
                  </span>
                  <span className="block truncate text-small text-muted" title={meta}>
                    {meta}
                  </span>
                </span>
                {!active && (
                  <button type="button" className="btn btn-secondary btn-xs" onClick={() => setActive(p.id)}>
                    <FolderOpen /> Open
                  </button>
                )}
                <MoreMenu
                  label={`More actions for ${name}`}
                  items={[
                    ...(active ? [{ label: 'Rename', icon: <Pencil />, onSelect: rename }] : []),
                    { label: 'Delete project', icon: <Trash2 />, danger: true, onSelect: () => void remove(p) },
                  ]}
                />
              </li>
            );
          })}
        </ul>
        <div className="-mx-5 flex flex-wrap gap-2 border-t border-line px-5 py-4 sm:hidden">{newProjectButtons}</div>
      </SettingsSection>

      <SettingsSection title="Backup & restore" description={signedIn ? 'Your workspace is saved to your account. A backup is your own copy.' : 'Everything lives in this browser. A backup moves it or keeps it safe.'}>
        <SettingsRow label="Export a backup" description="A .json file of every project. Uploaded images and videos aren’t included.">
          <button type="button" className="btn btn-secondary btn-sm" onClick={exportJson}>
            <Download /> Export backup (.json)
          </button>
        </SettingsRow>
        <SettingsRow label="Import a backup" description="Replaces the workspace on this device with the file’s projects.">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
            <Upload /> Import backup
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
        </SettingsRow>
      </SettingsSection>

      <SettingsSection tone="danger" title="Danger zone">
        <SettingsRow label="Reset workspace" description={signedIn ? 'Deletes every project, post, skill, listing and file from your account and every device.' : 'Deletes every project, post, skill, listing and order on this device.'}>
          <button
            type="button"
            className="btn btn-danger-ghost btn-sm"
            onClick={async () => {
              if (
                await confirmAction(
                  signedIn
                    ? { title: 'Erase your whole workspace?', body: 'All projects, posts, skills, listings, orders and files are deleted from your account and every device. Export a backup first if you might need them.', confirmLabel: 'Erase everything', danger: true }
                    : { title: 'Erase everything on this device?', body: 'All projects, posts, skills, listings and orders are deleted. Export a backup first if you might need them.', confirmLabel: 'Erase everything', danger: true },
                )
              ) {
                resetAll();
                pushMyListings();
              }
            }}
          >
            <Trash2 /> Reset workspace
          </button>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

// ───────────────────────── Preferences ─────────────────────────

function Preferences() {
  const signedIn = useAuth((s) => s.phase === 'ready');
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const community = useRuntime((s) => s.community);
  const set = (patch: Partial<AppSettings>) => updateSettings((s) => ({ ...s, ...patch }));
  const profileSaved = useSaved(settings.profile);
  const lookSaved = useSaved(settings.theme);
  return (
    <div className="flex max-w-[880px] flex-col gap-6">
      <SettingsSection title="Profile" description="Pre-fills opt-in tests and email sign-offs." actions={<Saved shown={profileSaved} />}>
        <SettingsRow label="Your name" htmlFor="pf-name">
          <input id="pf-name" className="input" autoComplete="name" value={settings.profile.name} onChange={(e) => set({ profile: { ...settings.profile, name: e.target.value } })} />
        </SettingsRow>
        <SettingsRow label="Email" htmlFor="pf-email">
          <input id="pf-email" type="email" className="input" autoComplete="email" value={settings.profile.email} onChange={(e) => set({ profile: { ...settings.profile, email: e.target.value } })} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Appearance" actions={<Saved shown={lookSaved} />}>
        <SettingsRow label="Theme" description="System follows your device’s light or dark setting.">
          <Segmented<AppSettings['theme']>
            value={settings.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { id: 'system', label: 'System', icon: <Monitor /> },
              { id: 'light', label: 'Light', icon: <Sun /> },
              { id: 'dark', label: 'Dark', icon: <Moon /> },
            ]}
          />
        </SettingsRow>
      </SettingsSection>

      {community === 'live' && (
        <SettingsSection title="Marketplace" description="Listings you publish are visible to everyone who uses this app. People buy through your own links.">
          <SettingsRow label="Show my listings to other people" description="Turn off to keep your listings visible only to you." htmlFor="pref-share">
            <Toggle
              id="pref-share"
              checked={settings.shareToCommunity}
              onChange={(v) => {
                set({ shareToCommunity: v });
                setTimeout(() => pushMyListings(), 0);
              }}
            />
          </SettingsRow>
        </SettingsSection>
      )}

      <SettingsSection title="About">
        <SettingsRow label="Where your work is kept" description={signedIn ? 'Yourlocalbusiness saves your workspace to your account.' : 'Yourlocalbusiness keeps your data in this browser.'}>
          <span className="text-small text-muted">{signedIn ? 'Your account' : 'This browser'}</span>
        </SettingsRow>
        <SettingsRow label="Where the AI runs" description={__ARTIFACT_BUILD__ ? 'Through your claude.ai account.' : 'On your server’s keys when they’re set up, otherwise on the built-in engine.'}>
          <span className="text-small text-muted">{__ARTIFACT_BUILD__ ? 'claude.ai' : 'Your server'}</span>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
