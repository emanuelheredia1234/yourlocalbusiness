// The command palette (⌘/Ctrl+K): ask the assistant, go back to a recent page, create something, go to a page
// or a Settings section. ⌘/Ctrl+J toggles the assistant from anywhere. Page names match the sidebar (Appendix A).
// "Ask AI: …" hands the words to the assistant's box (useAssistant's draft); the owner sends them there.

import { useEffect, useState, type ReactNode } from 'react';
import { Brain, CalendarDays, ChartColumn, Compass, Globe, Layers, LayoutDashboard, Mail, Megaphone, PencilRuler, Settings2, Store, Target } from 'lucide-react';
import { navigate, useRoute, type Route } from '@/lib/router';
import { useActiveProject } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { useAssistant } from '@/store/assistant';
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/shadcn/command';
import { Kbd } from '../ui/primitives';
import { AiTile } from '../ai/Spark';
import { createActions, studioName, useModKey } from './Shell';

const PAGES: { route: Route; label: string; icon: ReactNode; hint?: string }[] = [
  { route: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard /> },
  { route: 'strategy', label: 'Strategy', icon: <Compass />, hint: 'Research, where to promote, your plan' },
  { route: 'studio', label: 'Studio', icon: <PencilRuler /> },
  { route: 'calendar', label: 'Content calendar', icon: <CalendarDays />, hint: 'Planned and posted posts' },
  { route: 'analytics', label: 'Analytics', icon: <ChartColumn /> },
  { route: 'marketing', label: 'Marketing', icon: <Layers /> },
  { route: 'marketing-seo', label: 'SEO page', icon: <Globe /> },
  { route: 'marketing-email', label: 'Email', icon: <Mail />, hint: 'Lead magnet, emails, leads' },
  { route: 'marketing-social', label: 'Social', icon: <Megaphone />, hint: 'Campaign, 30-day plan, 7-day batch' },
  { route: 'marketing-ads', label: 'Ads', icon: <Target /> },
  { route: 'store', label: 'Marketplace', icon: <Store /> },
  { route: 'brain', label: 'Brain', icon: <Brain />, hint: 'Skills the AI follows' },
];

/** The pages visited in this tab, newest first (in memory only: a reload starts over). */
const visited: Route[] = [];

/** The last 3 pages visited before this one. */
function useRecentPages(): Route[] {
  const route = useRoute();
  const [list, setList] = useState<Route[]>([]);
  useEffect(() => {
    if (!route || route === 'onboarding') return;
    const i = visited.indexOf(route);
    if (i !== -1) visited.splice(i, 1);
    visited.unshift(route);
    visited.length = Math.min(visited.length, 4);
    setList([...visited]);
  }, [route]);
  return list.filter((r) => r !== route).slice(0, 3);
}

const SETTINGS: { id: string; label: string }[] = [
  { id: 'brand', label: 'Brand' },
  { id: 'domains', label: 'Domains' },
  { id: 'ai', label: 'AI keys' },
  { id: 'accounts', label: 'Social accounts' },
  { id: 'projects', label: 'Projects & data' },
  { id: 'prefs', label: 'Preferences' },
];

function Tile({ children }: { children: ReactNode }) {
  return <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-3 text-ink-2 [&>svg]:size-3.5">{children}</span>;
}

function Row({ icon, label, hint, value, keywords, onSelect, forceMount }: { icon: ReactNode; label: ReactNode; hint?: string; value: string; keywords?: string[]; onSelect: () => void; forceMount?: boolean }) {
  return (
    <CommandItem value={value} keywords={keywords} onSelect={onSelect} forceMount={forceMount}>
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {hint && <span className="ml-auto truncate pl-3 text-small text-muted">{hint}</span>}
    </CommandItem>
  );
}

export function CommandPalette() {
  const open = useUI((s) => s.commandOpen);
  const setOpen = useUI((s) => s.setCommandOpen);
  const project = useActiveProject();
  const mod = useModKey();
  const [q, setQ] = useState('');
  const recent = useRecentPages();

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        setOpen(!useUI.getState().commandOpen);
      } else if (k === 'j') {
        e.preventDefault();
        const a = useAssistant.getState();
        a.setOpen(!a.open);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [setOpen]);
  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  const run = (fn: () => unknown) => {
    setOpen(false);
    void fn();
  };
  const query = q.trim();
  const page = (route: Route) => {
    if (route === 'workspace-settings') return { label: 'Settings', icon: <Settings2 />, hint: undefined };
    const p = PAGES.find((x) => x.route === route);
    return { label: route === 'studio' ? studioName(project?.track) : p?.label ?? route, icon: p?.icon ?? <LayoutDashboard />, hint: p?.hint };
  };
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Search pages and actions" commandProps={{ loop: true }}>
      <CommandInput value={q} onValueChange={setQ} placeholder="Search pages and actions, or ask AI…" aria-label="Search pages and actions" trailing={<Kbd>Esc</Kbd>} />
      <CommandList>
        {/* no "No matches" line: while typing, "Ask AI" is always offered */}
        {query && (
          <CommandGroup heading="Ask AI" forceMount>
            <Row
              forceMount
              value={`ask ai ${query}`}
              icon={<AiTile size={24} />}
              label={
                <>
                  Ask AI: <span className="text-ink">“{query}”</span>
                </>
              }
              onSelect={() => run(() => useAssistant.getState().openWith(query))}
            />
          </CommandGroup>
        )}
        {/* where the owner just was (typing searches every page instead) */}
        {!query && recent.length > 0 && (
          <CommandGroup heading="Recent">
            {recent.map((r) => {
              const p = page(r);
              return <Row key={r} value={`recent ${p.label}`} icon={<Tile>{p.icon}</Tile>} label={p.label} onSelect={() => run(() => navigate(r))} />;
            })}
          </CommandGroup>
        )}
        <CommandGroup heading="Create">
          {createActions().map((a) => (
            <Row key={a.id} value={`create ${a.label}`} keywords={['new', 'make']} icon={<Tile>{a.icon}</Tile>} label={a.label} onSelect={() => run(a.run)} />
          ))}
        </CommandGroup>
        <CommandGroup heading="Go to">
          {PAGES.map((p) => {
            const label = p.route === 'studio' ? studioName(project?.track) : p.label;
            return <Row key={p.route} value={`go ${label}`} keywords={p.hint ? [p.hint] : undefined} icon={<Tile>{p.icon}</Tile>} label={label} hint={p.hint} onSelect={() => run(() => navigate(p.route))} />;
          })}
        </CommandGroup>
        <CommandGroup heading="Settings">
          {SETTINGS.map((s) => (
            <Row
              key={s.id}
              value={`settings ${s.label}`}
              icon={
                <Tile>
                  <Settings2 />
                </Tile>
              }
              label={`Settings: ${s.label}`}
              onSelect={() =>
                run(() => {
                  useUI.getState().setSettingsTab(s.id);
                  return navigate('workspace-settings');
                })
              }
            />
          ))}
        </CommandGroup>
      </CommandList>
      <div className="hidden h-9 shrink-0 items-center gap-1.5 border-t border-line bg-surface-2 px-4 text-caption text-muted sm:flex" aria-hidden="true">
        ↑↓ Navigate · ↵ Open · {mod}J Ask AI
      </div>
    </CommandDialog>
  );
}
