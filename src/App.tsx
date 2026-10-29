import { lazy, Suspense, useEffect, useRef } from 'react';
import { navigate, useRoute } from '@/lib/router';
import { initRuntime } from '@/lib/platform';
import { pingServer } from '@/ai/claude';
import { startCommunitySync } from '@/lib/community';
import { PLATFORMS } from '@/ai/knowledge';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { CommandPalette, MobileNav, Sidebar, Topbar } from '@/components/layout/Shell';
import { PageErrorBoundary } from '@/components/layout/ErrorBoundary';
import { ConfirmHost, Spinner, Toaster } from '@/components/ui/primitives';
import { ConnectHost } from '@/components/posts/Connect';
import { PostEditorHost } from '@/components/posts/PostCard';
import { ManusFacebookHost, useManusScheduleWatcher } from '@/components/posts/ManusFacebook';
import { ComposerHost } from '@/pages/dashboard/QuickComposer';
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

function useAutoPublish() {
  useEffect(() => {
    const tick = () => {
      const due = useStore.getState().autoPublishDue();
      for (const p of due.slice(0, 3)) {
        useStore.getState().notify({ kind: 'post', title: `Published to ${PLATFORMS[p.platform].label}`, body: p.headline, route: 'calendar' });
      }
      if (due.length) toast({ kind: 'success', title: `${due.length} scheduled post${due.length > 1 ? 's' : ''} just went live`, body: 'Live engagement is tracking in Analytics.' });
    };
    tick();
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, []);
}

/** Optional demo activity: simulated buyers for the user’s own listings (Settings → Demo). */
function useSimulatedBuyers() {
  const enabled = useStore((s) => s.settings.marketActivity);
  useEffect(() => {
    if (!enabled) return;
    const names = ['Maya', 'Jordan', 'Priya', 'Luis', 'Hannah', 'Theo', 'Ava', 'Marcus', 'Elena', 'Sam'];
    const cities = ['Austin', 'Denver', 'Portland', 'Nashville', 'Chicago', 'Tampa', 'Raleigh', 'Boise'];
    const t = setInterval(() => {
      const s = useStore.getState();
      if (!s.myListings.length || Math.random() > 0.45) return;
      const l = s.myListings[Math.floor(Math.random() * s.myListings.length)];
      const buyer = `${names[Math.floor(Math.random() * names.length)]} from ${cities[Math.floor(Math.random() * cities.length)]}`;
      s.addSale({ listingId: l.id, projectId: l.projectId, title: l.title, amount: l.price, qty: 1, createdAt: Date.now(), buyer, source: 'simulated' });
      s.notify({ kind: 'sale', title: `Simulated sale: ${l.title}`, body: `${buyer} · $${l.price}`, route: 'analytics' });
      toast({ kind: 'success', title: 'Simulated sale (demo mode)', body: `${buyer} bought ${l.title}` });
    }, 50_000);
    return () => clearInterval(t);
  }, [enabled]);
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
  useThemeSync();
  useAutoPublish();
  useSimulatedBuyers();
  useManusScheduleWatcher();

  useEffect(() => {
    initRuntime();
  }, []);
  const serverUrl = useStore((s) => s.settings.ai.serverUrl);
  useEffect(() => {
    // Outside claude.ai, look for the optional Claude proxy server (same origin unless a URL is set).
    if (!__ARTIFACT_BUILD__ && /^https?:$/.test(location.protocol)) pingServer(serverUrl);
  }, [serverUrl]);
  useEffect(() => {
    if (hasListings) startCommunitySync();
  }, [hasListings]);

  const needsOnboarding = !project || !project.onboarded;
  useEffect(() => {
    if (needsOnboarding && route !== 'onboarding') navigate('onboarding');
    else if (!needsOnboarding && (route === 'onboarding' || route === null)) navigate('dashboard');
  }, [needsOnboarding, route]);

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
          <div className="mx-auto w-full max-w-[1320px] gutter pb-16 pt-6">
            <PageErrorBoundary key={route ?? 'dashboard'} onHome={() => navigate('dashboard')}>
              <Suspense fallback={<PageFallback />}>{page}</Suspense>
            </PageErrorBoundary>
          </div>
        </main>
      </div>
      <MobileNav />
      <CommandPalette />
      <ComposerHost />
      <PostEditorHost />
      <ManusFacebookHost />
      <StoreOverlays />
      <ConnectHost />
      <ConfirmHost />
      <Toaster />
    </div>
  );
}
