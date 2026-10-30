import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bell,
  Brain,
  CalendarDays,
  ChartColumn,
  ChevronsUpDown,
  LayoutDashboard,
  Megaphone,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  ShoppingCart,
  Sparkles,
  Store,
  Sun,
  WandSparkles,
  X,
} from 'lucide-react';
import { cn, fmtRelative } from '@/lib/utils';
import { navigate, useRoute, type Route } from '@/lib/router';
import { useRuntime } from '@/lib/platform';
import { useActiveProject, useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { FORMATS } from '@/ai/knowledge';
import { Popover, MenuItem } from '../ui/primitives';
import { LogoMark } from '../brand/Logo';

export function AppMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="rgb(var(--primary))" />
      <path d="M6 12.5 L8 7 H24 L26 12.5 Z" fill="rgb(var(--accent))" />
      <path d="M6 12.5 q2.5 3 5 0 q2.5 3 5 0 q2.5 3 5 0 q2.5 3 5 0" fill="none" stroke="rgb(var(--on-primary))" strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="9" y="17" width="6" height="9" rx="1" fill="rgb(var(--on-primary))" />
      <rect x="17.5" y="17" width="5.5" height="4.5" rx="1" fill="rgb(var(--on-primary))" opacity="0.75" />
    </svg>
  );
}

interface NavItem {
  route: Route;
  label: string;
  icon: ReactNode;
  match?: Route[];
}

function useNav(): { group: string; items: NavItem[] }[] {
  const project = useActiveProject();
  const studioLabel = project?.track === 'business' ? 'Business Studio' : 'Product Studio';
  return [
    {
      group: 'Workspace',
      items: [
        { route: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={18} /> },
        { route: 'studio', label: studioLabel, icon: <WandSparkles size={18} /> },
        { route: 'marketing', label: 'Marketing Hub', icon: <Megaphone size={18} />, match: ['marketing', 'marketing-seo', 'marketing-email', 'marketing-social', 'marketing-ads'] },
        { route: 'calendar', label: 'Content Calendar', icon: <CalendarDays size={18} /> },
        { route: 'analytics', label: 'Analytics', icon: <ChartColumn size={18} /> },
      ],
    },
    {
      group: 'Grow',
      items: [
        { route: 'store', label: 'Marketplace', icon: <Store size={18} /> },
        { route: 'brain', label: 'Brain', icon: <Brain size={18} /> },
      ],
    },
  ];
}

function ProjectSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const project = useActiveProject();
  const projects = useStore((s) => s.projects);
  const setActive = useStore((s) => s.setActiveProject);
  const create = useStore((s) => s.createProject);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!project) return null;
  return (
    <>
      <button ref={ref} onClick={() => setOpen(true)} className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:bg-surface-2">
        <LogoMark colors={project.brand.colors} logo={project.brand.logo} name={project.brand.name} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-ink">{project.brand.name || 'Untitled project'}</span>
          <span className="block truncate text-[11px] text-muted">
            {project.track === 'product' ? FORMATS[project.format ?? 'pdf'].label.replace(/s$/, '').replace(' / Guides', ' guide') : project.businessType || 'Business'}
            {project.location?.city ? ` · ${project.location.city}` : ''}
          </span>
        </span>
        <ChevronsUpDown size={15} className="shrink-0 text-muted" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} align="start" className="w-[260px]">
        <p className="eyebrow px-2.5 pb-1 pt-1.5">Projects</p>
        {projects.map((p) => (
          <MenuItem
            key={p.id}
            active={p.id === project.id}
            icon={<LogoMark colors={p.brand.colors} logo={p.brand.logo} name={p.brand.name} size={20} />}
            onClick={() => {
              setActive(p.id);
              setOpen(false);
              navigate(p.onboarded ? 'dashboard' : 'onboarding');
              onNavigate?.();
            }}
          >
            {p.brand.name || 'Untitled project'}
            {!p.onboarded && <span className="ml-1 text-[11px] text-muted">(setup)</span>}
          </MenuItem>
        ))}
        <div className="my-1 border-t border-line" />
        <MenuItem
          icon={<Plus size={15} />}
          onClick={() => {
            create();
            setOpen(false);
            navigate('onboarding');
            onNavigate?.();
          }}
        >
          New project
        </MenuItem>
      </Popover>
    </>
  );
}

function EngineStatus() {
  const claude = useRuntime((s) => s.claude);
  const server = useRuntime((s) => s.server);
  const ai = useRuntime((s) => s.ai);
  const useBrain = useStore((s) => s.settings.ai.useBrain);
  const skills = useStore((s) => s.skills.filter((k) => k.enabled).length);
  const keys = ai.providers.filter((p) => p.ready).length;
  const live = __ARTIFACT_BUILD__
    ? claude === 'available'
      ? 'Claude'
      : claude === 'checking'
        ? 'Connecting…'
        : 'Built-in engine'
    : server === 'down'
      ? 'Server offline'
      : !ai.reachable
        ? 'Connecting…'
        : keys
          ? `${keys} key${keys === 1 ? '' : 's'} on`
          : 'No keys yet';
  const good = __ARTIFACT_BUILD__ ? claude === 'available' : ai.reachable && keys > 0;
  return (
    <button onClick={() => navigate('workspace-settings')} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2">
      <span className="relative flex h-7 w-7 items-center justify-center rounded-md bg-ink text-accent">
        <Sparkles size={14} />
        <span className={cn('absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface', good ? 'bg-good' : 'bg-accent')} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-semibold text-ink">AI: {live}</span>
        <span className="block truncate text-[11px] text-muted">{useBrain ? `Brain on · ${skills} skill${skills === 1 ? '' : 's'}` : 'Brain off'}</span>
      </span>
    </button>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const route = useRoute();
  const nav = useNav();
  const go = (r: Route) => {
    navigate(r);
    onNavigate?.();
  };
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="awning h-2.5 shrink-0" />
      <div className="awning-scallop h-2 shrink-0" />
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-2">
        <AppMark />
        <span className="font-display text-[17px] font-bold tracking-[-0.02em]">Yourlocalbusiness</span>
      </div>
      <div className="px-3 pb-2">
        <ProjectSwitcher onNavigate={onNavigate} />
      </div>
      <nav className="scroll-thin flex-1 overflow-y-auto px-3 py-2" aria-label="Main">
        {nav.map((g) => (
          <div key={g.group} className="mb-4">
            <p className="eyebrow mb-1.5 px-2.5">{g.group}</p>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((it) => {
                const active = route === it.route || (it.match?.includes(route as Route) ?? false);
                return (
                  <li key={it.route}>
                    <button
                      onClick={() => go(it.route)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'relative flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-[13.5px] font-semibold transition-colors',
                        active ? 'bg-primary-soft text-primary' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      {it.icon}
                      {it.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-line px-3 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))' }}>
        <EngineStatus />
        <button
          onClick={() => go('workspace-settings')}
          aria-current={route === 'workspace-settings' ? 'page' : undefined}
          className={cn('mt-1 flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-[13.5px] font-semibold', route === 'workspace-settings' ? 'bg-primary-soft text-primary' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}
        >
          <Settings size={18} /> Settings & brand
        </button>
      </div>
    </div>
  );
}

const TITLES: Record<Route, string> = {
  onboarding: 'Setup',
  dashboard: 'Dashboard',
  studio: 'Studio',
  marketing: 'Marketing Hub',
  'marketing-seo': 'SEO Sales Page',
  'marketing-email': 'Email Funnel',
  'marketing-social': 'Social Campaign',
  'marketing-ads': 'Paid Ads',
  calendar: 'Content Calendar',
  analytics: 'Analytics',
  store: 'Marketplace',
  brain: 'Brain',
  'workspace-settings': 'Settings',
};

function NotificationsButton() {
  const notices = useStore((s) => s.notices);
  const markRead = useStore((s) => s.markNoticesRead);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const unread = notices.filter((n) => !n.read).length;
  return (
    <>
      <button
        ref={ref}
        className="btn btn-ghost btn-icon relative"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        onClick={() => {
          setOpen(true);
        }}
      >
        <Bell size={18} />
        {unread > 0 && <span className="num absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-bold text-white">{unread}</span>}
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
          markRead();
        }}
        anchor={ref}
        className="w-[330px]"
      >
        <div className="flex items-center justify-between px-2.5 py-1.5">
          <p className="text-[13px] font-semibold">Notifications</p>
          {unread > 0 && (
            <button className="text-xs font-semibold text-primary hover:underline" onClick={markRead}>
              Mark all read
            </button>
          )}
        </div>
        {notices.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[13px] text-muted">Nothing yet. Published posts, sales and new subscribers show up here.</p>
        ) : (
          <ul className="flex flex-col">
            {notices.slice(0, 12).map((n) => (
              <li key={n.id}>
                <button
                  className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-surface-2"
                  onClick={() => {
                    if (n.route) navigate(n.route as Route);
                    setOpen(false);
                    markRead();
                  }}
                >
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-line-2' : n.kind === 'sale' ? 'bg-good' : n.kind === 'lead' ? 'bg-info' : 'bg-accent')} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-ink">{n.title}</span>
                    {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{fmtRelative(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </>
  );
}

export function ThemeToggle() {
  const theme = useStore((s) => s.settings.theme);
  const update = useStore((s) => s.updateSettings);
  const dark = theme === 'dark' || (theme === 'system' && document.documentElement.getAttribute('data-theme') === 'dark') || (theme === 'system' && !document.documentElement.getAttribute('data-theme') && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return (
    <button className="btn btn-ghost btn-icon" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => update((s) => ({ ...s, theme: dark ? 'light' : 'dark' }))}>
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

export function Topbar() {
  const route = useRoute() ?? 'dashboard';
  const setNav = useUI((s) => s.setNavOpen);
  const openComposer = useUI((s) => s.openComposer);
  const setCmd = useUI((s) => s.setCommandOpen);
  const setCart = useUI((s) => s.setCartOpen);
  const cartCount = useStore((s) => s.cart.reduce((n, c) => n + c.qty, 0));
  const project = useActiveProject();
  return (
    <header className="sticky z-30 flex h-[60px] shrink-0 items-center gap-2 border-b border-line bg-surface/90 backdrop-blur gutter" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
      <button className="btn btn-ghost btn-icon -ml-2 lg:hidden" onClick={() => setNav(true)} aria-label="Open menu">
        <Menu size={20} />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-[17px] font-semibold tracking-[-0.01em]">{route === 'studio' ? (project?.track === 'business' ? 'Business Studio' : 'Product Studio') : TITLES[route]}</p>
      </div>
      <button className="hidden h-9 items-center gap-2 rounded-md border border-line-2 bg-surface-2 px-3 text-[13px] text-muted hover:text-ink md:flex" onClick={() => setCmd(true)}>
        <Search size={15} /> Search or jump to…
        <span className="kbd ml-4">⌘K</span>
      </button>
      <button className="btn btn-ghost btn-icon md:hidden" onClick={() => setCmd(true)} aria-label="Search">
        <Search size={18} />
      </button>
      <ThemeToggle />
      <NotificationsButton />
      <button className="btn btn-ghost btn-icon relative" onClick={() => setCart(true)} aria-label={`Cart, ${cartCount} items`}>
        <ShoppingCart size={18} />
        {cartCount > 0 && <span className="num absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-on-primary">{cartCount}</span>}
      </button>
      <button className="btn btn-primary ml-1 hidden sm:inline-flex" onClick={() => openComposer()}>
        <Plus size={16} /> Create post
      </button>
      <button className="btn btn-primary btn-icon sm:hidden" onClick={() => openComposer()} aria-label="Create post">
        <Plus size={18} />
      </button>
    </header>
  );
}

export function MobileNav() {
  const open = useUI((s) => s.navOpen);
  const setOpen = useUI((s) => s.setNavOpen);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, setOpen]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 animate-fade-in bg-[rgb(var(--shadow)/0.4)]" onClick={() => setOpen(false)} />
      <div className="absolute bottom-0 left-0 top-0 w-[284px] animate-rise-in border-r border-line shadow-pop" style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingLeft: 'env(safe-area-inset-left, 0px)' }}>
        <button className="btn btn-ghost btn-icon btn-sm absolute right-2 top-5 z-10" onClick={() => setOpen(false)} aria-label="Close menu">
          <X size={18} />
        </button>
        <Sidebar onNavigate={() => setOpen(false)} />
      </div>
    </div>
  );
}

// ───────────────────────── Command palette ─────────────────────────

export function CommandPalette() {
  const open = useUI((s) => s.commandOpen);
  const setOpen = useUI((s) => s.setCommandOpen);
  const openComposer = useUI((s) => s.openComposer);
  const create = useStore((s) => s.createProject);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUI.getState().commandOpen);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [setOpen]);
  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => input.current?.focus(), 20);
    }
  }, [open]);
  const items = useMemo(
    () => [
      { label: 'Create a new post', hint: 'Quick composer', run: () => openComposer() },
      { label: 'Go to Dashboard', run: () => navigate('dashboard') },
      { label: 'Open Studio', hint: 'Outline, code generator, publish', run: () => navigate('studio') },
      { label: 'Marketing Hub', run: () => navigate('marketing') },
      { label: 'SEO sales page builder', run: () => navigate('marketing-seo') },
      { label: 'Email funnel & lead magnet', run: () => navigate('marketing-email') },
      { label: 'Social campaign: 30-day plan + 7-day batch', run: () => navigate('marketing-social') },
      { label: 'Paid ads campaign', run: () => navigate('marketing-ads') },
      { label: 'Content calendar', hint: 'Scheduled & published posts', run: () => navigate('calendar') },
      { label: 'Analytics', run: () => navigate('analytics') },
      { label: 'Marketplace store', run: () => navigate('store') },
      { label: 'Brain: AI skills', run: () => navigate('brain') },
      { label: 'Brand setup', hint: 'Logo, colors, socials', run: () => navigate('workspace-settings') },
      {
        label: 'Start a new project',
        hint: 'Guided wizard',
        run: () => {
          create();
          navigate('onboarding');
        },
      },
    ],
    [openComposer, create],
  );
  const filtered = items.filter((i) => (i.label + ' ' + (i.hint ?? '')).toLowerCase().includes(q.toLowerCase()));
  if (!open) return null;
  const run = (i: number) => {
    const it = filtered[i];
    if (!it) return;
    setOpen(false);
    it.run();
  };
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center px-4 pt-[12vh]">
      <div className="absolute inset-0 animate-fade-in bg-[rgb(var(--shadow)/0.4)]" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-[560px] animate-rise-in overflow-hidden rounded-xl border border-line bg-surface shadow-pop" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search size={17} className="text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') run(idx);
              else if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Search pages and actions…"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
            aria-label="Search pages and actions"
          />
          <span className="kbd">Esc</span>
        </div>
        <ul className="scroll-thin max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.map((it, i) => (
            <li key={it.label}>
              <button onMouseEnter={() => setIdx(i)} onClick={() => run(i)} className={cn('flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-[13.5px]', i === idx ? 'bg-primary-soft text-primary' : 'text-ink-2')}>
                <span className="font-semibold">{it.label}</span>
                {it.hint && <span className="truncate text-xs text-muted">{it.hint}</span>}
              </button>
            </li>
          ))}
          {!filtered.length && <li className="px-3 py-6 text-center text-[13px] text-muted">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}
