// The app frame: the sidebar on the canvas, the top bar inside the rounded stage, the phone menu, and
// the Create menu they share with the command palette. Page names follow the one-name-per-page table
// (design spec, Appendix A): the sidebar, the top bar crumb, the palette and the assistant use the same.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bell,
  Brain,
  CalendarDays,
  ChartColumn,
  ChevronsUpDown,
  Compass,
  Globe,
  Inbox,
  Layers,
  LayoutDashboard,
  Mail,
  Megaphone,
  Menu as MenuIcon,
  PencilRuler,
  Plus,
  Search,
  Send,
  Settings2,
  Store,
  Target,
  X,
  FileCode2,
  FolderPlus,
} from 'lucide-react';
import { cn, fmtRelative } from '@/lib/utils';
import { navigate, useRoute, type Route } from '@/lib/router';
import { useRuntime } from '@/lib/platform';
import { useActiveProject, useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { useAssistant } from '@/store/assistant';
import { useNewLeadCount } from '@/store/leads';
import { FORMATS } from '@/ai/knowledge';
import { Empty, Kbd, Menu, MenuItem, Popover, Tooltip, type MenuEntry } from '../ui/primitives';
import { Sheet, SheetContent, SheetTitle } from '../ui/shadcn/sheet';
import { confirmLeave } from '@/components/ui/leave';
import { startNewProject } from '@/lib/projectActions';
import { PlanLockBadge } from '@/components/billing/HeldProjects';
import { LogoMark } from '../brand/Logo';
import { Spark } from '../ai/Spark';
import { AccountButton } from '../auth/Account';

/** The app mark: a white storefront in an ink squircle with an aura spark (inverts in dark through the tokens). */
export function AppMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="9" fill="rgb(var(--ink))" />
      <path d="M7.5 12.5h17" stroke="rgb(var(--surface))" strokeWidth="3" strokeLinecap="round" />
      <path d="M9.5 16v8.5h13V16" fill="none" stroke="rgb(var(--surface))" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M14 24.5v-4.5h4v4.5" fill="none" stroke="rgb(var(--surface))" strokeWidth="2.4" strokeLinejoin="round" />
      <path fill="url(#ylb-aura)" d="M23.5 3.4c.442 1.87 1.53 2.958 3.4 3.4c-1.87.442-2.958 1.53-3.4 3.4c-.442-1.87-1.53-2.958-3.4-3.4c1.87-.442 2.958-1.53 3.4-3.4Z" />
    </svg>
  );
}

/** "Business Studio" or "Product Studio", by the project's track. */
export function studioName(track?: string | null): string {
  return track === 'business' ? 'Business Studio' : 'Product Studio';
}

/** The page names (Appendix A): what the sidebar, the top bar and the palette call each page. */
export const PAGE_NAMES: Record<Route, string> = {
  onboarding: 'Setup',
  dashboard: 'Dashboard',
  strategy: 'Strategy',
  studio: 'Studio',
  marketing: 'Marketing',
  'marketing-seo': 'SEO page',
  'marketing-email': 'Email',
  'marketing-social': 'Social',
  'marketing-ads': 'Ads',
  calendar: 'Content calendar',
  analytics: 'Analytics',
  store: 'Marketplace',
  brain: 'Brain',
  'workspace-settings': 'Settings',
  'admin-billing': 'Customer usage',
  plans: 'Plans',
};

const MARKETING_CHILDREN: Route[] = ['marketing-seo', 'marketing-email', 'marketing-social', 'marketing-ads'];

/** A page's name as the shell shows it ("Business Studio" for the studio). */
export function usePageName(route: Route): string {
  const project = useActiveProject();
  return route === 'studio' ? studioName(project?.track) : PAGE_NAMES[route];
}

/** What "Create" offers (the sidebar, the phone "+" and the command palette run the same actions). */
export function createActions(): { id: string; label: string; icon: ReactNode; run: () => void | Promise<unknown> }[] {
  const ui = useUI.getState();
  return [
    { id: 'post', label: 'Post', icon: <Megaphone />, run: () => ui.openComposer() },
    { id: 'email', label: 'Email', icon: <Mail />, run: () => navigate('marketing-email') },
    { id: 'seo', label: 'SEO page', icon: <Globe />, run: () => ui.openSeoBuilder() },
    { id: 'ad', label: 'Ad', icon: <Target />, run: () => navigate('marketing-ads') },
    {
      id: 'asset',
      label: 'Asset',
      icon: <FileCode2 />,
      run: async () => {
        if (await navigate('studio')) useUI.getState().requestTab('studio', 'code');
      },
    },
    { id: 'project', label: 'New project', icon: <FolderPlus />, run: () => startNewProject() },
  ];
}

function createMenuItems(after?: () => void): MenuEntry[] {
  const acts = createActions();
  const entry = (a: (typeof acts)[number]): MenuEntry => ({
    label: a.label,
    icon: a.icon,
    onSelect: () => {
      void a.run();
      after?.();
    },
  });
  return [...acts.slice(0, 5).map(entry), 'separator', entry(acts[5])];
}

interface NavItem {
  route: Route;
  label: string;
  icon: ReactNode;
  count?: number;
  /** read out after the count, e.g. "new leads" */
  countLabel?: string;
}

function useNav(): { group: string | null; items: NavItem[] }[] {
  const project = useActiveProject();
  const planned = useStore((s) => (project ? s.posts.filter((p) => p.projectId === project.id && p.status === 'scheduled').length : 0));
  const newLeads = useNewLeadCount(project);
  return [
    {
      group: null,
      items: [
        { route: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard /> },
        { route: 'strategy', label: 'Strategy', icon: <Compass /> },
        { route: 'studio', label: studioName(project?.track), icon: <PencilRuler /> },
        { route: 'calendar', label: 'Content calendar', icon: <CalendarDays />, count: planned, countLabel: planned === 1 ? 'planned post' : 'planned posts' },
        { route: 'analytics', label: 'Analytics', icon: <ChartColumn /> },
      ],
    },
    {
      group: 'Marketing',
      items: [
        { route: 'marketing', label: 'Overview', icon: <Layers /> },
        { route: 'marketing-seo', label: 'SEO page', icon: <Globe /> },
        { route: 'marketing-email', label: 'Email', icon: <Mail />, count: newLeads, countLabel: newLeads === 1 ? 'new lead' : 'new leads' },
        { route: 'marketing-social', label: 'Social', icon: <Megaphone /> },
        { route: 'marketing-ads', label: 'Ads', icon: <Target /> },
      ],
    },
    {
      group: 'Grow',
      items: [
        { route: 'store', label: 'Marketplace', icon: <Store /> },
        { route: 'brain', label: 'Brain', icon: <Brain /> },
      ],
    },
  ];
}

function projectLine(project: NonNullable<ReturnType<typeof useActiveProject>>): string {
  const kind = project.track === 'product' ? FORMATS[project.format ?? 'pdf'].label.replace(/s$/, '').replace(' / Guides', ' guide') : project.businessType || 'Business';
  return `${kind}${project.location?.city ? ` · ${project.location.city}` : ''}`;
}

function ProjectSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const project = useActiveProject();
  const projects = useStore((s) => s.projects);
  const setActive = useStore((s) => s.setActiveProject);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!project) return null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-120 hover:bg-ink/5"
      >
        <LogoMark colors={project.brand.colors} logo={project.brand.logo} name={project.brand.name} size={28} className="rounded" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-h4 text-ink">{project.brand.name || 'Untitled project'}</span>
          <span className="block truncate text-caption text-muted">{projectLine(project)}</span>
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-muted" aria-hidden="true" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} align="start" className="w-[280px]">
        <p className="px-2 pb-1 pt-1.5 text-caption text-muted">Projects</p>
        {projects.map((p) => (
          <MenuItem
            key={p.id}
            active={p.id === project.id}
            icon={<LogoMark colors={p.brand.colors} logo={p.brand.logo} name={p.brand.name} size={20} />}
            onClick={async () => {
              setOpen(false);
              if (p.id !== project.id && !(await confirmLeave())) return;
              setActive(p.id);
              void navigate(p.onboarded ? 'dashboard' : 'onboarding', { force: true });
              onNavigate?.();
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{p.brand.name || 'Untitled project'}</span>
              {!p.onboarded && <span className="badge shrink-0">Setup</span>}
              <PlanLockBadge projectId={p.id} />
            </span>
          </MenuItem>
        ))}
        <div className="-mx-1.5 my-1.5 h-px bg-line" />
        <MenuItem
          icon={<Plus />}
          onClick={async () => {
            setOpen(false);
            if (await startNewProject()) onNavigate?.();
          }}
        >
          New project
        </MenuItem>
      </Popover>
    </>
  );
}

/** "AI ready" / "Add an AI key" / "AI offline" / "Connecting…", and whether the Brain is on. */
function AIStatus({ onNavigate }: { onNavigate?: () => void }) {
  const claude = useRuntime((s) => s.claude);
  const server = useRuntime((s) => s.server);
  const ai = useRuntime((s) => s.ai);
  const useBrain = useStore((s) => s.settings.ai.useBrain);
  const keys = ai.providers.filter((p) => p.ready).length;
  const state: { label: string; dot: string; pulse?: boolean } = __ARTIFACT_BUILD__
    ? claude === 'available'
      ? { label: 'AI ready', dot: 'bg-good-solid' }
      : claude === 'checking'
        ? { label: 'Connecting…', dot: 'bg-faint', pulse: true }
        : { label: 'Built-in engine', dot: 'bg-faint' }
    : server === 'down'
      ? { label: 'AI offline', dot: 'bg-bad-solid' }
      : !ai.reachable
        ? { label: 'Connecting…', dot: 'bg-faint', pulse: true }
        : keys
          ? { label: 'AI ready', dot: 'bg-good-solid' }
          : { label: 'Add an AI key', dot: 'bg-warn-solid' };
  return (
    <button
      type="button"
      onClick={() => {
        useUI.getState().setSettingsTab('ai');
        void navigate('workspace-settings');
        onNavigate?.();
      }}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors duration-120 hover:bg-ink/5"
    >
      <span className="relative flex h-[7px] w-[7px] shrink-0" aria-hidden="true">
        <span className={cn('absolute -inset-[3px] rounded-full opacity-20', state.dot)} />
        <span className={cn('relative h-[7px] w-[7px] rounded-full', state.dot, state.pulse && 'animate-pulse-dot')} />
      </span>
      <span className="min-w-0 flex-1 truncate text-small font-medium text-ink-2">{state.label}</span>
      <span className="shrink-0 text-caption text-muted">{useBrain ? 'Brain on' : 'Brain off'}</span>
    </button>
  );
}

function NavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className="nav-item">
      {item.icon}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {!!item.count && (
        <span className="nav-count">
          {item.count}
          {item.countLabel && <span className="sr-only">{`, ${item.count} ${item.countLabel}`}</span>}
        </span>
      )}
    </button>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const route = useRoute();
  const nav = useNav();
  const go = (r: Route) => {
    void navigate(r);
    onNavigate?.();
  };
  return (
    <div className="flex h-full w-full flex-col px-3 pb-3">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-2">
        <AppMark size={24} />
        <span className="truncate text-h3 text-ink">Yourlocalbusiness</span>
      </div>
      <ProjectSwitcher onNavigate={onNavigate} />
      <Menu
        align="start"
        className="w-[220px]"
        items={createMenuItems(onNavigate)}
        trigger={
          <button type="button" className="btn btn-secondary btn-sm mt-2 w-full justify-start">
            <Plus />
            Create
          </button>
        }
      />
      <nav aria-label="Main" className="scroll-thin -mx-1 mt-3 flex-1 overflow-y-auto px-1">
        {nav.map((g) => (
          <div key={g.group ?? 'main'}>
            {g.group && <p className="mb-1 mt-[18px] px-2.5 text-caption font-medium text-muted">{g.group}</p>}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((it) => (
                <li key={it.route}>
                  <NavButton item={it} active={route === it.route} onClick={() => go(it.route)} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="flex shrink-0 flex-col gap-0.5 pt-2" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <AIStatus onNavigate={onNavigate} />
        <NavButton item={{ route: 'workspace-settings', label: 'Settings', icon: <Settings2 /> }} active={route === 'workspace-settings'} onClick={() => go('workspace-settings')} />
      </div>
    </div>
  );
}

const NOTICE_TILE: Record<string, { cls: string; icon: ReactNode }> = {
  lead: { cls: 'bg-primary-soft text-primary', icon: <Inbox size={14} /> },
  sale: { cls: 'bg-good-soft text-good', icon: <Store size={14} /> },
  post: { cls: 'bg-surface-3 text-ink-2', icon: <Send size={14} /> },
  ai: { cls: 'bg-surface-3 text-ink-2', icon: <Brain size={14} /> },
  info: { cls: 'bg-surface-3 text-ink-2', icon: <Bell size={14} /> },
};

function NotificationsButton() {
  const notices = useStore((s) => s.notices);
  const markRead = useStore((s) => s.markNoticesRead);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const unread = notices.filter((n) => !n.read).length;
  const close = () => {
    setOpen(false);
    markRead();
  };
  return (
    <>
      <button ref={ref} type="button" className="btn btn-ghost btn-icon btn-sm relative" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <Bell className="!size-[18px]" />
        {unread > 0 && <span aria-hidden="true" className="absolute right-[7px] top-[7px] h-2 w-2 rounded-full bg-primary ring-2 ring-surface" />}
      </button>
      <Popover open={open} onClose={close} anchor={ref} className="w-[360px] max-w-[calc(100vw-16px)] p-1.5">
        <div className="flex items-center justify-between px-2 py-1.5">
          <p className="text-h4 text-ink">Notifications</p>
          {unread > 0 && (
            <button type="button" className="link text-caption" onClick={markRead}>
              Mark all read
            </button>
          )}
        </div>
        {notices.length === 0 ? (
          <div className="px-2 pb-2 pt-1">
            <Empty variant="inline" title="Nothing yet." body="Published posts, sales and new subscribers show up here." />
          </div>
        ) : (
          <ul className="flex flex-col">
            {notices.slice(0, 12).map((n) => {
              const tile = NOTICE_TILE[n.kind] ?? NOTICE_TILE.info;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    className="flex min-h-14 w-full items-center gap-3 rounded px-2 py-2 text-left transition-colors duration-120 hover:bg-surface-3"
                    onClick={() => {
                      if (n.route) void navigate(n.route as Route);
                      close();
                    }}
                  >
                    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded', tile.cls)} aria-hidden="true">
                      {tile.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-ui text-ink">
                        {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
                        <span className="truncate">{n.title}</span>
                        {!n.read && <span className="sr-only">(unread)</span>}
                      </span>
                      {n.body && <span className="block truncate text-small text-muted">{n.body}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-caption text-muted">{fmtRelative(n.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Popover>
    </>
  );
}

/** ⌘ on Apple devices, Ctrl elsewhere. */
export function useModKey(): string {
  const [mod] = useState(() => (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl '));
  return mod;
}

/** Whether the page's scroll area has scrolled past the header (the top bar then shows its line and the page name). */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  const route = useRoute();
  useEffect(() => {
    const el = document.getElementById('main-scroll');
    if (!el) return;
    const on = () => setScrolled(el.scrollTop > 64);
    on();
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, [route]);
  return scrolled;
}

export function Topbar() {
  const route = useRoute() ?? 'dashboard';
  const setNav = useUI((s) => s.setNavOpen);
  const setCmd = useUI((s) => s.setCommandOpen);
  const name = usePageName(route);
  const scrolled = useScrolled();
  const mod = useModKey();
  const nested = MARKETING_CHILDREN.includes(route);
  const openAssistant = () => useAssistant.getState().setOpen(true);
  return (
    <header
      data-scrolled={scrolled ? '' : undefined}
      className={cn('flex shrink-0 items-center gap-2 border-b gutter transition-colors duration-180', scrolled ? 'border-line' : 'border-transparent')}
      style={{ height: 'calc(56px + env(safe-area-inset-top, 0px))', paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      <button type="button" className="btn btn-ghost btn-icon btn-sm -ml-1.5 lg:hidden" onClick={() => setNav(true)} aria-label="Open menu">
        <MenuIcon className="!size-5" />
      </button>
      {/* phone and tablet: the page name; desktop: the crumb (nested pages always, others once scrolled) */}
      <p className="min-w-0 flex-1 truncate text-h3 text-ink md:hidden">{name}</p>
      <div className="hidden min-w-0 flex-1 items-center text-ui md:flex">
        {nested ? (
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center">
            <button type="button" className="shrink-0 text-muted transition-colors duration-120 hover:text-ink" onClick={() => void navigate('marketing')}>
              Marketing
            </button>
            <span className="mx-2 text-faint" aria-hidden="true">
              /
            </span>
            <span className="truncate text-ink" aria-current="page">
              {name}
            </span>
          </nav>
        ) : (
          <span className={cn('truncate text-ink transition-opacity duration-180 ease-out', scrolled ? 'opacity-100' : 'opacity-0')} aria-hidden={!scrolled}>
            {name}
          </span>
        )}
      </div>
      {/* ≥ 1024: search pill and Ask AI with their shortcuts */}
      <button type="button" className="hidden h-8 w-[260px] items-center gap-2 rounded-md border border-line bg-surface-2 pl-2.5 pr-1.5 text-left text-small text-muted transition-colors duration-120 hover:border-line-2 hover:text-ink-2 lg:flex" onClick={() => setCmd(true)}>
        <Search size={16} className="shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate">Search or ask…</span>
        <span aria-hidden="true">
          <Kbd>{`${mod}K`}</Kbd>
        </span>
      </button>
      <button type="button" className="btn btn-ai-outline btn-sm hidden lg:inline-flex" onClick={openAssistant} aria-label="Ask AI">
        <Spark size={16} />
        Ask AI
        <span aria-hidden="true" className="ml-0.5">
          <Kbd>{`${mod}J`}</Kbd>
        </span>
      </button>
      {/* 768–1023: icon buttons */}
      <Tooltip content="Search" kbd={`${mod}K`}>
        <button type="button" className="btn btn-ghost btn-icon btn-sm hidden md:inline-flex lg:hidden" onClick={() => setCmd(true)} aria-label="Search">
          <Search />
        </button>
      </Tooltip>
      <Tooltip content="Ask AI" kbd={`${mod}J`}>
        <button type="button" className="btn btn-ai-outline btn-icon btn-sm hidden md:inline-flex lg:hidden" onClick={openAssistant} aria-label="Ask AI">
          <Spark size={16} />
        </button>
      </Tooltip>
      <NotificationsButton />
      {/* < 768: Create */}
      <Menu
        align="end"
        className="w-[220px]"
        items={createMenuItems()}
        trigger={
          <button type="button" className="btn btn-primary btn-sm btn-icon rounded-full md:hidden" aria-label="Create">
            <Plus />
          </button>
        }
      />
      <AccountButton />
    </header>
  );
}

/** The phone and tablet menu: a sheet from the left with Search, then the sidebar. */
export function MobileNav() {
  const open = useUI((s) => s.navOpen);
  const setOpen = useUI((s) => s.setNavOpen);
  const setCmd = useUI((s) => s.setCommandOpen);
  const mod = useModKey();
  if (!open) return null;
  return (
    <Sheet open onOpenChange={setOpen}>
      <SheetContent side="left" aria-describedby={undefined} className="z-nav lg:hidden" overlayClassName="z-nav lg:hidden" style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingLeft: 'env(safe-area-inset-left, 0px)' }}>
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <div className="flex items-center gap-2 px-3 pt-3">
          <button
            type="button"
            className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-small text-muted"
            onClick={() => {
              setOpen(false);
              setCmd(true);
            }}
          >
            <Search size={16} className="shrink-0" aria-hidden="true" />
            <span className="flex-1 truncate">Search</span>
            <span aria-hidden="true" className="[@media(pointer:coarse)]:hidden">
              <Kbd>{`${mod}K`}</Kbd>
            </span>
          </button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm shrink-0" onClick={() => setOpen(false)} aria-label="Close menu">
            <X />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <Sidebar onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A page-sized placeholder while a page's code loads: a header and two cards. */
export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton h-[30px] w-60 max-w-full" />
      <div className="skeleton mt-3 h-4 w-[360px] max-w-full" />
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="skeleton h-40 rounded-lg" />
        <div className="skeleton h-40 rounded-lg" />
      </div>
    </div>
  );
}
