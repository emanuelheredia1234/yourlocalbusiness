import { lazy, Suspense, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/hooks';
import { navigate, useRoute } from '@/lib/router';
import { initRuntime } from '@/lib/platform';
import { pingServer } from '@/ai/claude';
import { startCommunitySync } from '@/lib/community';
import { useActiveProject, useStore } from '@/store/useStore';
import { useLeadsWatcher } from '@/store/leads';
import { MobileNav, PageSkeleton, Sidebar, Topbar } from '@/components/layout/Shell';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { PageErrorBoundary } from '@/components/layout/ErrorBoundary';
import { ConfirmHost, Toaster } from '@/components/ui/primitives';
import { installLeaveGuard } from '@/components/ui/leave';
import { PostEditorHost } from '@/components/posts/PostCard';
import { PublishConfirmHost } from '@/components/posts/PublishConfirm';
import { PostItYourselfHost } from '@/components/posts/PostItYourselfModal';
import { PublishJobWatcher } from '@/components/posts/PublishJobWatcher';
import { MarkPostedHost } from '@/components/posts/PostActions';
import { ManusGroupsHost, useGroupShareWatcher } from '@/components/posts/ManusGroups';
import { ListingWindowHost } from '@/components/studio/ListingWindowHost';
import { useVoiceReadWatcher } from '@/components/brand/SocialVoice';
import { useStrategyManusWatcher } from '@/ai/strategyManus';
import { useAgentBuildWatcher } from '@/ai/agents/builds';
import { AgentBuildHost } from '@/components/agents/AgentBuildWindow';
import { HtmlPreviewHost } from '@/components/agents/HtmlPreview';
import { Assistant } from '@/components/assistant/Assistant';
import { useAssistant } from '@/store/assistant';
import { StoreOverlays } from '@/pages/store/StoreOverlays';
import { Onboarding } from '@/pages/onboarding/Onboarding';
import { Dashboard } from '@/pages/dashboard/Dashboard';

const Studio = lazy(() => import('@/pages/studio/Studio'));
const MarketingHub = lazy(() => import('@/pages/marketing/MarketingHub'));
const SeoPage = lazy(() => import('@/pages/marketing/SeoSalesPage'));
const EmailPage = lazy(() => import('@/pages/marketing/EmailFunnel'));
const SocialPage = lazy(() => import('@/pages/marketing/SocialEngine'));
const AdsPage = lazy(() => import('@/pages/marketing/AdsEngine'));
const CalendarPage = lazy(() => import('@/pages/calendar/ContentCalendar'));
const AnalyticsPage = lazy(() => import('@/pages/analytics/Analytics'));
const StorePage = lazy(() => import('@/pages/store/Marketplace'));
const BrainPage = lazy(() => import('@/pages/brain/Brain'));
const AdminBillingPage = lazy(() => import('@/pages/admin/Billing'));
const SettingsPage = lazy(() => import('@/pages/settings/Settings'));
const StrategyPage = lazy(() => import('@/pages/strategy/Strategy'));

/**
 * Keeps <html data-theme> in step with Settings › Theme. The boot script in index.html sets it before
 * the first paint (and marks it data-theme-source="app"); a theme the host set (claude.ai) wins for
 * "System". The choice is saved under ylb-theme so the next load paints right away.
 */
function useThemeSync() {
  const theme = useStore((s) => s.settings.theme);
  const hostTheme = useRef<string | null>(
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme-source') !== 'app' ? document.documentElement.getAttribute('data-theme') : null,
  );
  useEffect(() => {
    const root = document.documentElement;
    try {
      localStorage.setItem('ylb-theme', theme);
    } catch {
      /* storage blocked: the boot script falls back to System */
    }
    if (theme === 'light' || theme === 'dark') {
      root.setAttribute('data-theme', theme);
      root.setAttribute('data-theme-source', 'app');
      return;
    }
    if (hostTheme.current) {
      root.setAttribute('data-theme', hostTheme.current);
      return;
    }
    const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const apply = () => root.setAttribute('data-theme', mq?.matches ? 'dark' : 'light');
    apply();
    root.setAttribute('data-theme-source', 'app');
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [theme]);
}

/** The pages that use the wide container. */
const WIDE: string[] = ['calendar', 'marketing-seo', 'studio'];

export default function App() {
  const route = useRoute();
  const project = useActiveProject();
  const hasListings = useStore((s) => s.myListings.length > 0);
  const assistantOpen = useAssistant((s) => s.open);
  const wide = useMediaQuery('(min-width: 1440px)');
  // the assistant docks beside the stage at 1440px and wider
  const docked = assistantOpen && wide;
  useThemeSync();
  useLeadsWatcher();
  useGroupShareWatcher();
  useVoiceReadWatcher();
  useStrategyManusWatcher();
  useAgentBuildWatcher();

  useEffect(() => {
    initRuntime();
  }, []);
  const serverUrl = useStore((s) => s.settings.ai.serverUrl);
  useEffect(() => {
    // Outside claude.ai, ask your AI server which keys are ready (same origin unless a URL is set),
    // again whenever you come back to the tab: keys may have changed meanwhile.
    if (__ARTIFACT_BUILD__ || !/^https?:$/.test(location.protocol)) return;
    void pingServer(serverUrl);
    const again = () => document.visibilityState === 'visible' && void pingServer(serverUrl);
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, [serverUrl]);
  useEffect(() => {
    if (hasListings) startCommunitySync();
  }, [hasListings]);

  const needsOnboarding = !project || !project.onboarded;
  useEffect(() => {
    if (needsOnboarding && route !== 'onboarding') void navigate('onboarding', { force: true });
    else if (!needsOnboarding && (route === 'onboarding' || route === null)) void navigate('dashboard', { force: true });
  }, [needsOnboarding, route]);
  // "Leave this page?" while something is generating
  useEffect(() => installLeaveGuard(), []);

  if (needsOnboarding) {
    return (
      <>
        <Onboarding />
        <Toaster />
        <ConfirmHost />
      </>
    );
  }

  let page: JSX.Element;
  switch (route) {
    case 'strategy':
      page = <StrategyPage />;
      break;
    case 'studio':
      page = <Studio />;
      break;
    case 'marketing':
      page = <MarketingHub />;
      break;
    case 'marketing-seo':
      page = <SeoPage />;
      break;
    case 'marketing-email':
      page = <EmailPage />;
      break;
    case 'marketing-social':
      page = <SocialPage />;
      break;
    case 'marketing-ads':
      page = <AdsPage />;
      break;
    case 'calendar':
      page = <CalendarPage />;
      break;
    case 'analytics':
      page = <AnalyticsPage />;
      break;
    case 'store':
      page = <StorePage />;
      break;
    case 'brain':
      page = <BrainPage />;
      break;
    case 'workspace-settings':
      page = <SettingsPage />;
      break;
    case 'admin-billing':
      page = <AdminBillingPage />;
      break;
    default:
      page = <Dashboard />;
  }

  return (
    // the shell clips itself (html and body are not clipped: the sign-in pages and the published-page preview scroll the document)
    <div className="flex h-full overflow-hidden bg-bg">
      <aside className="hidden w-[232px] shrink-0 lg:flex xl:w-[248px]" style={{ paddingLeft: 'env(safe-area-inset-left, 0px)' }}>
        <Sidebar />
      </aside>
      {/* the stage: a rounded white panel inset 8px on wide screens, full-bleed below 1024; its right margin makes room for the docked assistant */}
      <div className={cn('flex min-w-0 flex-1 flex-col overflow-hidden bg-surface transition-[margin] duration-320 ease-out', 'lg:my-2 lg:rounded-stage lg:border lg:border-line lg:shadow-xs', docked ? 'lg:mr-[416px]' : 'lg:mr-2')}>
        <Topbar />
        {/* relative: absolutely positioned bits inside (sr-only labels) stay in this scroll area instead of stretching the page behind the shell; overscroll-contain: scrolling never moves the page itself */}
        <main id="main-scroll" className="scroll-thin relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className={cn('mx-auto w-full gutter pb-24 pt-6 md:pb-12', route && WIDE.includes(route) ? 'max-w-[1600px]' : 'max-w-[1200px]')}>
            <PageErrorBoundary key={route ?? 'dashboard'} onHome={() => void navigate('dashboard', { force: true })}>
              <Suspense fallback={<PageSkeleton />}>{page}</Suspense>
            </PageErrorBoundary>
          </div>
        </main>
      </div>
      <MobileNav />
      <CommandPalette />
      <PostEditorHost />
      <PublishConfirmHost />
      <PostItYourselfHost />
      <PublishJobWatcher />
      <AgentBuildHost />
      <HtmlPreviewHost />
      <ManusGroupsHost />
      <MarkPostedHost />
      <ListingWindowHost />
      <StoreOverlays />
      <Assistant />
      <ConfirmHost />
      <Toaster placement={assistantOpen ? 'beside-panel' : 'above-launcher'} />
    </div>
  );
}
