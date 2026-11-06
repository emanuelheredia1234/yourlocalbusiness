// The shared contracts of connected accounts, posting from the app, analytics and per-customer usage
// (the app's side; the server mirrors them as JSDoc in server/integrations/contracts.mjs). Everything here is
// what the browser may see: no connection ids, no tokens, no other customer's data.

/** The accounts a user can connect: social networks through Upload-Post (each business its own), ad accounts through Zernio (phase 2 ones show "Coming soon"). */
export type ConnectPlatform =
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'tiktok'
  | 'x'
  | 'youtube'
  | 'pinterest'
  | 'google_ads'
  | 'meta_ads'
  | 'linkedin_ads'
  | 'tiktok_ads'
  | 'pinterest_ads'
  | 'x_ads'
  | 'reddit_ads'
  | 'microsoft_ads';

export const CONNECT_PLATFORMS: readonly ConnectPlatform[] = ['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube', 'pinterest', 'google_ads', 'meta_ads', 'linkedin_ads', 'tiktok_ads', 'pinterest_ads', 'x_ads', 'reddit_ads', 'microsoft_ads'];
/** The social networks (Settings › Connected accounts › Social). */
export const SOCIAL_PLATFORMS: readonly ConnectPlatform[] = ['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube', 'pinterest'];
/** The ad accounts (read only: the app changes no ad). */
export const AD_PLATFORMS: readonly ConnectPlatform[] = ['google_ads', 'meta_ads', 'linkedin_ads', 'tiktok_ads', 'pinterest_ads', 'x_ads', 'reddit_ads', 'microsoft_ads'];
/** Shown as "Coming soon" for now (posts in the app have no Pinterest format yet; X Ads waits on the owner). */
export const PHASE2_PLATFORMS: readonly ConnectPlatform[] = ['pinterest', 'x_ads'];
export type AdPlatformId = 'google_ads' | 'meta_ads' | 'linkedin_ads' | 'tiktok_ads' | 'pinterest_ads' | 'x_ads' | 'reddit_ads' | 'microsoft_ads';

export type ConnectionState = 'not_connected' | 'pending' | 'connected' | 'limited' | 'needs_reconnect' | 'coming_soon';
export type LimitedReason = 'missing_permissions' | 'no_page_role' | 'app_not_approved' | 'insights_unavailable' | 'private_only';
export type TargetKind = 'fb_page' | 'ig_account' | 'li_person' | 'li_org' | 'yt_channel' | 'ads_account' | 'tt_account' | 'x_account' | 'pin_account';

export interface ConnectionStatus {
  platform: ConnectPlatform;
  state: ConnectionState;
  limitedReason?: LimitedReason;
  targetLabel?: string;
  targetKind?: TargetKind;
  targetsAvailable?: number;
  expiresSoon?: boolean;
  connectedAt?: string;
  lastError?: string;
}

/** A Page, account, channel or site the user can post as or read from. */
export interface Target {
  /** opaque server handle: HMAC of the real id, never the raw id */
  id: string;
  label: string;
  kind: ConnectionStatus['targetKind'];
}

export interface ConnectionsResponse {
  connections: ConnectionStatus[];
  available: ConnectPlatform[];
  setUp: boolean;
  /** who holds the logins: Upload-Post for social networks, Zernio for ad accounts (an older server sent 'zernio') */
  provider?: { social?: 'upload_post' | null; ads?: 'zernio' | null } | 'zernio' | null;
  /** social networks (Upload-Post) and ad accounts (Zernio) are each set up by their own key */
  setUpSocial?: boolean;
  setUpAds?: boolean;
  /** links stay in X posts (the owner bought Upload-Post's X Links add-on); otherwise they're taken out */
  xLinks?: boolean;
  /** the user's businesses with social accounts (each connects its own), of their limit; `projects`: which */
  slots?: SocialSlots;
  /** admins only: which Replit Secret to add (names, never values) */
  hint?: string;
}

/** How many of the user's businesses have social accounts (one Upload-Post profile each), of their limit. */
export interface SocialSlots {
  used: number;
  cap: number;
  /** the user's own project ids that hold a slot */
  projects: string[];
  /** of those, the ones the server found gone from the account (or still being deleted): "Free it" offers these */
  orphans?: string[];
}

/** A connect link to open, or (ad accounts on a network already connected) nothing to open. */
export interface ConnectLink {
  connectLink?: string;
  expiresAt?: string;
  alreadyConnected?: boolean;
}

/** Other integrations through Nango (future booking tools and CRMs; never social or ads). */
export interface NangoIntegration {
  key: string;
  label: string;
  category: 'booking' | 'crm' | 'calendar' | 'payments' | 'other';
  state: ConnectionState;
  connectedAt?: string;
  lastError?: string;
}

export interface NangoResponse {
  enabled: boolean;
  setUp: boolean;
  integrations: NangoIntegration[];
  hint?: string;
}

// ───────────── posting ─────────────

export type PublishState = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown';
export type PublishPlatform = 'instagram' | 'facebook' | 'tiktok' | 'linkedin' | 'x' | 'youtube';
export type LinkPlacementChoice = 'in_post' | 'first_comment' | 'bio' | 'none';

export interface PublishRequest {
  projectId: string;
  postId: string;
  platform: PublishPlatform;
  /** sent only after the confirm dialog */
  confirm: true;
  /** a uuid from the client: a double click makes one job */
  clientRequestId: string;
  content: {
    text: string;
    hashtags?: string[];
    link?: string;
    linkPlacement?: LinkPlacementChoice;
    firstComment?: string;
    mediaIds?: string[];
    /** YouTube, TikTok */
    title?: string;
  };
}

export interface PublishJob {
  id: string;
  postId: string;
  platform: string;
  state: PublishState;
  url?: string;
  errorCode?: string;
  errorMessage?: string;
  requestedAt: string;
  finishedAt?: string;
  checkedAt?: string;
  /**
   * SENT_TO_DRAFTS: sent, but not public yet (TikTok put it in the account's drafts). POSTED_AFTER_ALL: this try had
   * failed, then the network posted it after all. MAY_APPEAR_TWICE: an earlier try that failed was posted after
   * all, so the post may be there twice. noteMessage says it in plain words.
   */
  note?: 'SENT_TO_DRAFTS' | 'POSTED_AFTER_ALL' | 'MAY_APPEAR_TWICE';
  noteMessage?: string;
  /** a try posted after all that went to the account's TikTok drafts */
  drafts?: boolean;
  /** false: the network can't be read back, so "Check again" can't help (mark it posted yourself) */
  checkable?: boolean;
}

// ───────────── analytics ─────────────

export type AnalyticsSource = 'social' | 'ads' | 'seo' | 'email';
export const ANALYTICS_SOURCES: readonly AnalyticsSource[] = ['social', 'ads', 'seo', 'email'];
export type SourceStatus = 'ok' | 'partial' | 'error' | 'not_connected' | 'skipped' | 'pending';

export interface AnalyticsSnapshot<T = unknown> {
  projectId: string;
  source: AnalyticsSource;
  status: SourceStatus;
  errorCode?: string;
  fetchedAt?: string;
  costMicro: number;
  data: T;
}

export interface RefreshRun {
  id: string;
  projectId: string;
  state: 'running' | 'done' | 'done_with_errors';
  sources: Record<AnalyticsSource, 'queued' | 'running' | SourceStatus>;
  startedAt: string;
  finishedAt?: string;
}

export type SocialNetwork = 'instagram' | 'facebook' | 'tiktok' | 'linkedin' | 'x' | 'youtube';

export interface SocialNetworkStats {
  network: SocialNetwork;
  origin: 'own' | 'public';
  handle?: string;
  followers?: number;
  postsCount?: number;
  reach?: number;
  views?: number;
  engagement?: number;
  /** per day; `reach` only where the network counts reach (views or impressions elsewhere) */
  series?: { date: string; followers?: number; reach?: number; views?: number; impressions?: number; engagement?: number }[];
  topPosts?: { id: string; url?: string; text: string; at?: string; likes?: number; comments?: number; shares?: number; views?: number }[];
  note?: 'private' | 'not_found' | 'over_cost' | 'busy' | 'reconnect';
}

export interface SocialData {
  networks: SocialNetworkStats[];
}

export interface AdsData {
  own: {
    platform: AdPlatformId;
    currency: string;
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    series: { date: string; spend: number; clicks: number }[];
    campaigns: { id: string; name: string; spend: number; impressions: number; clicks: number; conversions: number }[];
  }[];
  competitors: {
    name: string;
    source: 'meta' | 'google';
    activeAds: number;
    ads: { id: string; text: string; url?: string; firstShown?: string }[];
    note?: 'no_ads' | 'not_found';
  }[];
}

export interface SeoData {
  page?: { url: string; host: 'app' | 'custom' };
  google?: { submittedAt?: string; verdict?: string; coverageState?: string; lastCrawlTime?: string };
  gsc?: { clicks: number; impressions: number; ctr: number; position: number; series: { date: string; clicks: number; impressions: number }[] };
  keywords: { keyword: string; rank: number | null; mapsPosition: number | null; volume?: number }[];
  authority?: { score?: number; referringDomains?: number; backlinks?: number; fetchedAt: string };
}

export interface EmailData {
  sent: number;
  openRate: number;
  clickRate: number;
  unsubscribeRate: number;
  revenue: number;
  currency?: string;
  series: { date: string; sent: number; opened: number; clicked: number }[];
  campaigns: { id: string; name: string; sent: number; openRate: number; clickRate: number; revenue: number }[];
  leads: number;
}

export interface AnalyticsCompetitor {
  name: string;
  pageId?: string;
  domain?: string;
}

/** PUT /api/analytics/settings (keywords ≤ 10, competitors ≤ 3). */
export interface AnalyticsSettingsInput {
  projectId: string;
  keywords?: string[];
  city?: string;
  competitors?: AnalyticsCompetitor[];
}

export interface AnalyticsSettings {
  keywords: string[];
  city?: string;
  competitors: AnalyticsCompetitor[];
}

// ───────────── SEO page on Google ─────────────

export type SeoStepName = 'verify_token' | 'verify' | 'site_add' | 'sitemap' | 'inspect';
export type StepOutcome = 'ok' | 'failed' | 'unknown';

export interface SeoPublishResult {
  host: 'app' | 'custom';
  steps: { step: SeoStepName; outcome: StepOutcome | 'skipped'; verdict?: string; coverageState?: string; lastCrawlTime?: string; alreadySubmittedAt?: string; detail?: string }[];
  /** custom domains: the DNS TXT record to add before Verify */
  dnsRecord?: { type: 'TXT'; name: string; value: string };
  /** custom domains: waiting for the app's owner to verify the domain in Search Console */
  ownerVerification?: { domain: string };
}

export interface SeoGoogleStatus {
  host: 'app' | 'custom' | null;
  published: boolean;
  /** custom domains: verified in the app owner's Search Console (same as `verified`) */
  connected?: boolean;
  verified?: boolean;
  submittedAt?: string;
  verdict?: string;
  coverageState?: string;
  lastCrawlTime?: string;
  steps?: { step: SeoStepName; outcome: StepOutcome; at: string }[];
}

// ───────────── usage and billing ─────────────

export interface CustomerUsage {
  today: { costMicro: number; calls: number };
  month: { costMicro: number; calls: number };
  caps: { dailyCapMicro: number; monthlyCapMicro: number; status: 'active' | 'blocked' };
  byFeature: { feature: string; costMicro: number; calls: number }[];
  recent: { at: string; feature: string; label: string; costMicro: number; estimated: boolean }[];
}

export interface CapSettings {
  dailyCapMicro?: number | null;
  monthlyCapMicro?: number | null;
  callsPerDay?: number | null;
  postsPerDay?: number | null;
  xPostsPerDay?: number | null;
  status?: 'active' | 'blocked';
  note?: string;
}

export interface CustomerUsageRow {
  customerTag: string;
  email?: string;
  costMicro: number;
  estimatedMicro: number;
  calls: number;
  todayMicro: number;
  caps: CapSettings;
  status: 'active' | 'blocked';
  lastActivityAt?: string;
  syncedToTreg?: boolean;
  /** social accounts (Upload-Post) plus ad accounts (Zernio) connected right now */
  connectedAccounts?: number;
  /** social accounts connected through Upload-Post right now, all their businesses together */
  socialAccounts?: number;
  /** Upload-Post profiles their businesses use (one per business with social accounts) */
  socialProfiles?: number;
  /** ad accounts connected through Zernio right now (Zernio bills per connected ad account) */
  adAccounts?: number;
  /** each vendor's share of the period: real costs, estimates (never toward a cap) and calls */
  vendors?: Partial<Record<UsageVendor, VendorUsage>>;
}

export type UsageVendor = 'treg' | 'uploadpost' | 'zernio';
export interface VendorUsage {
  costMicro: number;
  estimatedMicro: number;
  calls: number;
}

/** GET /api/billing/customers (the owner only). */
export interface CustomersResponse {
  customers: CustomerUsageRow[];
  defaults: CapSettings & { syncedToTreg?: boolean };
  /** treg's last team-level alert (kind only, never amounts) */
  alert?: { kind: string; at: string };
  /**
   * Upload-Post profiles in use out of the plan's limit (one per business that connected social accounts), and
   * how many businesses each customer may connect (UPLOAD_POST_MAX_PROFILES_PER_USER)
   */
  upProfiles?: { used: number; limit?: number; perCustomer?: number };
  /** the most serious of Upload-Post's current team-level alerts (n: how many, for the kinds that count; the customer it's about) */
  uploadPostAlert?: { kind: string; at: string; n?: number; customerTag?: string };
}

export interface ReconcileReport {
  days: number;
  treg: { attributedMicro: number; unattributedMicro: number; totalMicro: number; sumOk: boolean };
  rows: { customerTag: string; tregMicro: number; ledgerMicro: number; diffMicro: number }[];
  unattributedOk: boolean;
  mismatches: number;
  pending?: { customerTag: string; callId: string; at: string }[];
  checkedAt: string;
}

// ───────────── errors ─────────────

export type ApiErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'NOT_SET_UP'
  | 'CONNECTIONS_NOT_ENABLED'
  | 'CONNECTIONS_UNAVAILABLE'
  | 'BUSINESS_LIMIT'
  | 'NOT_CONNECTED'
  | 'NEEDS_RECONNECT'
  | 'ALREADY_PUBLISHING'
  | 'POST_CHANGED'
  | 'MEDIA_UNSUPPORTED'
  | 'PLATFORM_LIMIT'
  | 'REFRESH_TOO_SOON'
  | 'NOTHING_TO_UPDATE'
  | 'CUSTOMER_CAP'
  | 'CUSTOMER_BLOCKED'
  | 'INSPECTION_QUOTA'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'PLAN_REQUIRED'
  | 'PAYMENT_REQUIRED'
  | 'CREDITS_USED'
  | 'ALREADY_SUBSCRIBED'
  | 'CARD_DECLINED'
  | 'BILLING_PENDING'
  | 'OWNER_PLAN'
  | 'NOT_ALLOWED_ON_PLAN';

export interface ApiError {
  error: string;
  code: ApiErrorCode;
  nextAt?: string;
  period?: 'day' | 'month';
  /** admins only */
  hint?: string;
}
