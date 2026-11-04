import { lazy, Suspense, useEffect, useRef } from 'react';
import { navigate, useRoute } from '@/lib/router';
import { initRuntime } from '@/lib/platform';
import { pingServer } from '@/ai/claude';
import { startCommunitySync } from '@/lib/community';
import { useActiveProject, useStore } from '@/store/useStore';
import { useLeadsWatcher } from '@/store/leads';
import { CommandPalette, MobileNav, Sidebar, Topbar } from '@/components/layout/Shell';
import { PageErrorBoundary } from '@/components/layout/ErrorBoundary';
import { ConfirmHost, Spinner, Toaster } from '@/components/ui/primitives';
import { installLeaveGuard } from '@/components/ui/leave';
import { PostEditorHost } from '@/components/posts/PostCard';
import { ManusPostHost, useManusPostWatcher } from '@/components/posts/ManusPost';
import { MarkPostedHost } from '@/components/posts/PostActions';
import { ManusGroupsHost, useGroupShareWatcher } from '@/components/posts/ManusGroups';
import { useVoiceReadWatcher } from '@/components/brand/SocialVoice';
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
const SettingsPage = lazy(() => import('@/pages/settings/Settings'));

function useThemeSync() {
  const theme = useStore((s) => s.settings.theme);
  const hostTheme = useRef<string | null>(typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      if (hostTheme.current) root.setAttribute('data-theme', hostTheme.current);
      else root.removeAttribute('data-theme');
    } else root.setAttribute('data-theme', theme);
  }, [theme]);
}

function PageFallback() {
  return (
    <div className="flex h-64 items-center justify-center text-muted">
      <Spinner size={22} />
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const project = useActiveProject();
  const hasListings = useStore((s) => s.myListings.length > 0);
  const assistantOpen = useAssistant((s) => s.open);
  useThemeSync();
  useManusPostWatcher();
  useLeadsWatcher();
  useGroupShareWatcher();
  useVoiceReadWatcher();

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
    default:
      page = <Dashboard />;
  }

  return (
    <div className="flex h-full">
      <aside className="hidden w-[260px] shrink-0 border-r border-line lg:block" style={{ paddingLeft: 'env(safe-area-inset-left, 0px)' }}>
        <div className="sticky top-0 h-full">
          <Sidebar />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main id="main-scroll" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {/* room at the bottom for the assistant's chat button */}
          <div className="mx-auto w-full max-w-[1320px] gutter pb-28 pt-6">
            <PageErrorBoundary key={route ?? 'dashboard'} onHome={() => void navigate('dashboard', { force: true })}>
              <Suspense fallback={<PageFallback />}>{page}</Suspense>
            </PageErrorBoundary>
          </div>
        </main>
      </div>
      <MobileNav />
      <CommandPalette />
      <PostEditorHost />
      <ManusPostHost />
      <ManusGroupsHost />
      <MarkPostedHost />
      <StoreOverlays />
      <Assistant />
      <ConfirmHost />
      <Toaster placement={assistantOpen ? 'beside-panel' : 'above-launcher'} />
    </div>
  );
}
