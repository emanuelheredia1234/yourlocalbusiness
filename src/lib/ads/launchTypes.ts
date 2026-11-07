// The shapes /api/ads/* answers with (server/ads/contracts.mjs is the server's copy, as JSDoc). Every amount is in
// whole units of the ad account's own currency; nothing here is ever converted between currencies. Messages are the
// server's own plain words; platform text (names from Ads Manager, review reasons) is data, shown as plain text.

export type AdsPlatform = 'meta' | 'google';
export type LaunchChoice = 'PAUSED' | 'ACTIVE';
export type CampaignState = 'launching' | 'in_review' | 'active' | 'paused' | 'rejected' | 'with_issues' | 'completed' | 'ended' | 'failed' | 'unknown';
export type AdJobState = 'queued' | 'sending' | 'done' | 'failed' | 'unknown';
export type ChangeAction = 'pause' | 'resume' | 'end' | 'budget' | 'end_date' | 'creative';
export type AdJobKind = 'launch' | ChangeAction;
export type Learning = 'LEARNING' | 'SUCCESS' | 'FAIL' | 'WAIVING';

export const ADS_LAUNCH_PLATFORMS: readonly AdsPlatform[] = ['meta', 'google'];
export const PLATFORM_LABEL: Record<AdsPlatform, string> = { meta: 'Meta', google: 'Google' };
export const PLATFORM_LONG: Record<AdsPlatform, string> = { meta: 'Meta (Facebook and Instagram)', google: 'Google Search' };
export const MANAGER_LABEL: Record<AdsPlatform, string> = { meta: 'Meta Ads Manager', google: 'Google Ads' };
/** the connected-account row each platform goes through (Settings → Connected accounts) */
export const CONNECTION_OF = { meta: 'meta_ads', google: 'google_ads' } as const;

/** A plain note from the server: a blocker, a warning or something left out. */
export interface PlainNote {
  code: string;
  message: string;
  fixUrl?: string;
}

export interface SetupCheck {
  id: string;
  state: 'ok' | 'warn' | 'missing' | 'unknown';
  code?: string;
  message: string;
  fixUrl?: string;
}

/** An ad account inside the business's connection (never a Zernio id). */
export interface AdAccountOption {
  ref: string;
  platform: AdsPlatform;
  name: string;
  idTail: string;
  currency: string;
  timezone: string;
  usable: boolean;
  reason?: string;
  message?: string;
  minDailyBudget?: number;
}

export interface AccountsResponse {
  accounts: AdAccountOption[];
  chosen?: AdAccountOption;
  choiceStale?: boolean;
  connection: { label: string } | null;
  setup: SetupCheck[];
  canLaunch: boolean;
}

export interface TargetOption {
  ref: string;
  name: string;
  kind: 'city' | 'region' | 'zip' | 'country' | 'interest' | 'other';
  path: string[];
}

export interface LaunchPreviewRequest {
  projectId: string;
  planId: string;
  platform: AdsPlatform;
  status: LaunchChoice;
  /** YYYY-MM-DD; left out = as soon as approved */
  startDate?: string;
  startTime?: 'asap' | string;
  /** whole units of the account currency, for this platform only */
  dailyBudget: number;
  durationDays: number;
  locations: string[];
  radiusMi?: number;
  interests?: string[];
  creativeIds?: string[];
  languages?: string[];
  claimsConfirmed?: string[];
  specialCategory: 'none' | 'yes';
}

export interface ClaimFlag {
  phrase: string;
  field: string;
  confirmed: boolean;
}

export interface AdPreview {
  variant: string;
  creativeId?: string;
  headline?: string;
  body?: string;
  description?: string;
  callToAction?: string;
  linkUrl: string;
  hasImage?: boolean;
  headlines?: string[];
  descriptions?: string[];
  keywords?: string[];
}

export interface LaunchReview {
  platform: AdsPlatform;
  account: { name: string; idTail: string; currency: string; timezone: string };
  status: LaunchChoice;
  daily: number;
  days: number;
  plannedTotal: number;
  start: string | null;
  startTime?: string | null;
  asap?: boolean | null;
  end: string | null;
  tz: string;
  goal: string;
  goalNote?: string;
  targeting: string[];
  leftOut: PlainNote[];
  ads: AdPreview[];
  claims: ClaimFlag[];
  warnings: PlainNote[];
  blockers: PlainNote[];
  committedDailyAfter: number;
  limitDaily: number | null;
  /** Meta: the spending limit the launch sets on the campaign (= the planned total) */
  spendCap?: number;
  linkUrl: string;
  setup: SetupCheck[];
}

export interface ChangePreviewRequest {
  action: ChangeAction;
  dailyBudget?: number;
  endDate?: string;
  creativeId?: string;
  adIndex?: number;
  claimsConfirmed?: string[];
}

export interface ChangeReview {
  action: ChangeAction;
  platform: AdsPlatform;
  confirmKind: 'spend' | 'short';
  account: { name: string; idTail: string; currency: string; timezone: string };
  current: { daily: number | null; configured: LaunchChoice | null; spendCap: number | null; end: string | null; asOf: string | null; live: boolean };
  proposed: {
    daily?: number;
    configured?: LaunchChoice;
    ended?: boolean;
    end?: string;
    remainingDays?: number;
    remainingTotal?: number | null;
    total?: number | null;
    ad?: { variant: string; headline: string; body: string; description?: string; callToAction?: string };
    headlines?: string[];
    descriptions?: string[];
  };
  dailyDelta?: number;
  totalDeltaEstimate?: number;
  spentSoFar?: number;
  newSpendCap?: number;
  learning?: Learning;
  claims?: ClaimFlag[];
  notes: PlainNote[];
  blockers: PlainNote[];
}

export interface AdJob {
  id: string;
  kind: AdJobKind;
  platform: AdsPlatform;
  state: AdJobState;
  code?: string;
  /** the server's words: for a refusal, why and what happened ("Nothing was created and no money was spent.") */
  message: string;
  /**
   * A refusal the server has no sentence for: Zernio's hint or Meta's own words (cut to 300). Third-party text:
   * shown as plain text, labelled as the platform's message, never as markup, a link or an instruction.
   */
  platformSays?: string;
  /** a refusal's fix link, on Meta's or Google's own site (shown only through safeFixUrl) */
  fixUrl?: string;
  actor?: 'customer' | 'owner' | 'platform';
  requestedAt: string;
  finishedAt?: string;
  checkedAt?: string;
  canCheckAt?: string;
  leftBehind?: string[];
}

export interface ReviewSummary {
  status: string | null;
  reasons: string[];
  account?: string;
  accountMessage?: string | null;
}

export interface LaunchedCampaign {
  id: string;
  planId: string;
  projectId: string;
  platform: AdsPlatform;
  name: string;
  tag: string | null;
  account: { name: string; idTail: string; currency: string; timezone: string };
  state: CampaignState;
  stateMessage: string;
  review: ReviewSummary;
  daily: number;
  start: string;
  end: string | null;
  launchedAs: LaunchChoice;
  configuredStatus: LaunchChoice | null;
  spendCap?: number;
  learning?: Learning;
  spendToDate?: number;
  results?: { impressions: number; clicks: number; ctr: number; conversions?: number };
  resultsAsOf?: string | null;
  platformCampaignId?: string;
  openInManagerUrl?: string;
  adsOff?: number;
  adSetOff?: boolean;
  /** some of the campaign's ads (not all) were refused: it still runs on the others */
  adsNotApproved?: { count: number; of: number };
  pendingJob?: AdJob;
  lastJob?: AdJob;
  lastReadAt?: string;
  planDeleted?: boolean;
}

export interface AdLimitsView {
  adsEnabled: boolean;
  currency: string;
  maxDaily: number;
  maxChange: number;
  maxCampaignTotal: number;
  launchesPerDay: number;
  changesPerDay: number;
  blocked?: boolean;
  committedDaily: number;
  liveCampaigns: number;
  launchOpen: boolean;
}

export interface CampaignsResponse {
  campaigns: LaunchedCampaign[];
  limits: AdLimitsView;
  notes?: PlainNote[];
}

export interface AuditEntry {
  id: number;
  at: string;
  campaignId: string | null;
  actor: 'customer' | 'owner' | 'platform';
  action: string;
  summary: string;
  outcome: 'sending' | 'done' | 'failed' | 'unknown' | 'refused' | 'info';
  /** a refused write's fix link, on Meta's or Google's own site (shown only through safeFixUrl) */
  fixUrl?: string;
}

export interface ReviewView {
  platform: AdsPlatform;
  ads: { index: number; status: 'approved' | 'rejected' | 'with_issues' | 'in_review' | 'unknown'; reasons: string[] }[];
  readAt: string;
}

/** A campaign whose switch is on, or may be on (delete account and disconnect warnings). */
export interface LiveAdRow {
  id: string;
  name: string;
  platform: AdsPlatform;
  daily: number;
  currency: string;
  idTail: string;
}

/** The owner's limits, as stored (null = inherits the defaults). */
export interface AdLimitsPatch {
  adsEnabled?: boolean | null;
  adsCurrency?: string | null;
  maxDaily?: number | null;
  maxChange?: number | null;
  maxCampaignTotal?: number | null;
  launchesPerDay?: number | null;
  changesPerDay?: number | null;
}

export interface AdLimitsCustomerRow {
  tag: string;
  own: AdLimitsPatch;
  effective: Omit<AdLimitsView, 'committedDaily' | 'liveCampaigns' | 'launchOpen'>;
  committedDaily: number;
  liveCampaigns: number;
  otherCurrencies: string[];
  lastChangeAt?: string;
  version: number;
}

export interface AdminLimitsResponse {
  /** Zernio's last team-level problem (owner only; customers only ever saw "isn't available right now") */
  zernioAlert?: { kind: string; at: string };
  defaults: AdLimitsPatch;
  defaultsVersion: number;
  ceilings: { maxDaily: number; maxChange: number };
  launchEnabled: boolean;
  customers: AdLimitsCustomerRow[];
}
