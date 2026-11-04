// The Strategy tab's data, kept in project.strategy (src/lib/strategy.ts reads it through readStrategy).
// Types only: src/lib/types.ts imports StrategyState from here (a type-only cycle).
import type { CampaignConfig, CodeKind, GenMeta, LeadMagnetType, LinkPlacement, PageType, PostPlatform, PostType, ProviderId } from './types';

export type StrategyStep = 'research' | 'promote' | 'content' | 'assets' | 'outreach' | 'plan';
/** web: rests on sources found by a web search (or pages Manus read) · ai: the AI's general knowledge · builtin: the app's starter notes */
export type StrategyBasis = 'web' | 'ai' | 'builtin';
export type ResearchReason = '' | 'unsupported' | 'provider_refused' | 'not_used' | 'no_results' | 'search_failed' | 'claude_ai' | 'builtin';
export type FindingTopic = 'buyers' | 'social' | 'promote' | 'offers' | 'outreach' | 'seo' | 'other';
export type ChannelType = 'social' | 'search' | 'marketplace' | 'directory' | 'community' | 'partners' | 'email' | 'ads' | 'offline' | 'other';
export type StrategyNetwork = PostPlatform | 'youtube';
export type AssetKind = 'page' | 'lead_magnet' | 'emails' | 'code' | 'listing' | 'listing_images' | 'video' | 'product_file' | 'packages' | 'other';
export type ActionKind =
  | 'build_page'
  | 'publish_page'
  | 'link_settings'
  | 'campaign_setup'
  | 'plan_30'
  | 'batch_7'
  | 'write_post'
  | 'calendar'
  | 'lead_magnet'
  | 'welcome_emails'
  | 'outreach'
  | 'code_asset'
  | 'listing'
  | 'listing_images'
  | 'product_file'
  | 'packages'
  | 'socials'
  | 'website'
  | 'brain'
  | 'ads'
  | 'offline';
export type OutreachPurpose = 'partner' | 'referral' | 'past_customer' | 'collab' | 'press' | 'wholesale' | 'other';
export type MeasureWhere = 'app' | 'network' | 'booking' | 'payments' | 'email' | 'other';
export type SeoCta = 'book' | 'buy' | 'contact' | 'join' | 'download';
export type ApplyArea = 'social' | 'email' | 'seo' | 'campaign' | 'links';

/** How a statement is backed: basis, plus source numbers (into StrategyState.sources) when basis is 'web'. */
export interface Backed {
  basis: StrategyBasis;
  sources?: number[];
}

export interface StrategySource {
  /** stable within this strategy; never reused */
  n: number;
  /** as the provider sent it (never rewritten); http(s) */
  url: string;
  /** the domain when the provider gave none */
  title: string;
  domain: string;
  /** a provider's cited text only (Anthropic cited_text), or Manus's quote */
  quote?: string;
  /** as the provider said it */
  pageAge?: string;
  via: 'search' | 'manus';
  /** when it was found */
  at: number;
}

export interface StrategyInputs {
  goal: string;
  budget: string;
  timePerWeek: string;
  competitors: string[];
  tried: string;
  notes: string;
}

/** Who wrote a section, when, and from which details. */
export interface StepInfo {
  at: number;
  /** 'server' | 'claude' | 'local' */
  provider: ProviderId;
  /** server only (compactMeta + searches) */
  meta?: GenMeta;
  /** why the built-in engine answered, or that another key answered */
  note?: string;
  /** strategyFactsHash() when it was written */
  factsHash: string;
  /** research.at it was written from (steps after research) */
  researchAt?: number;
  /** names of the Brain skills applied (≤ 6) */
  skills?: string[];
}

export interface StrategyFinding extends Backed {
  topic: FindingTopic;
  text: string;
}

export interface StrategyResearch extends StepInfo {
  mode: 'web' | 'general' | 'builtin';
  reason: ResearchReason;
  searches: number;
  queries: string[];
  summary: string;
  findings: StrategyFinding[];
  /** built-in "check it yourself" */
  checks: string[];
}

export interface StrategyChannel extends Backed {
  name: string;
  channelType: ChannelType;
  platform?: StrategyNetwork;
  priority: 1 | 2 | 3;
  why: string;
  how: string[];
}
export interface StrategyPageRec extends Backed {
  pageType: PageType;
  why: string;
  secondType?: PageType;
  secondWhy?: string;
}
export interface StrategyLinkRec extends Backed {
  placement: LinkPlacement;
  why: string;
}

export interface StrategyPromote extends StepInfo {
  positioning: Backed & { line: string; who: string; why: string };
  channels: StrategyChannel[];
  page: StrategyPageRec;
  links: Partial<Record<PostPlatform, StrategyLinkRec>>;
}

export interface StrategyContent extends StepInfo {
  pillars: { name: string; why: string; ideas: string[] }[];
  formats: (Backed & { platform: StrategyNetwork; what: string; why: string })[];
  campaign: Backed & { goal: CampaignConfig['goal']; platforms: PostPlatform[]; postMix: Record<PostType, 0 | 1 | 2 | 3>; videoShare: 'none' | 'some' | 'most'; why: string };
  ideas: { headline: string; postType: PostType; platform?: PostPlatform; why: string }[];
}

export interface StrategyAsset extends Backed {
  id: string;
  kind: AssetKind;
  title: string;
  why: string;
  codeKind?: CodeKind;
  leadMagnetType?: LeadMagnetType;
  prompt?: string;
}
export interface StrategyAssets extends StepInfo {
  assets: StrategyAsset[];
  seo: Backed & { audience: string; angle: string; objections: string[]; keywords: string[]; cta: SeoCta; why: string };
}

export interface StrategyTemplate {
  id: string;
  who: string;
  purpose: OutreachPurpose;
  subject: string;
  body: string;
  followUp: string;
  why: string;
}
export interface StrategyOutreach extends StepInfo {
  email: Backed & { leadMagnetType: LeadMagnetType; idea: string; welcomeAngle: string; why: string };
  templates: StrategyTemplate[];
}

export interface StrategyAction extends Backed {
  /** 'a_' + hashStr(kind + '|' + lowercased title).toString(36): stable across re-plans */
  id: string;
  week: 1 | 2 | 3 | 4;
  title: string;
  detail: string;
  kind: ActionKind;
  pageType?: PageType;
  topic?: string;
  codeKind?: CodeKind;
  leadMagnetType?: LeadMagnetType;
  platform?: PostPlatform;
}
export interface StrategyPlan extends StepInfo {
  summary: string;
  weeks: { week: 1 | 2 | 3 | 4; focus: string; goal: string }[];
  actions: StrategyAction[];
  habits: string[];
  measure: { what: string; where: MeasureWhere; why: string }[];
  /** week 1 starts here (kept across re-plans; "Start again from week 1" resets it) */
  startAt: number;
}

export interface AppliedRecord {
  at: number;
  /** the section's `at` it was built from */
  from: number;
  /** skills: the fixed id + strategyFingerprint of what was written */
  skillId?: string;
  written?: string;
  /** seo: the exact block written */
  block?: string;
  /** campaign/links: the values replaced (one-step undo) */
  before?: unknown;
}

export interface StrategyManus {
  taskId: string;
  taskUrl: string;
  state: 'working' | 'needs_input' | 'done' | 'failed';
  message?: string;
  requestedAt: number;
  checkedAt?: number;
  doneAt?: number;
  credits?: number;
  pagesRead?: number;
  /** basis 'web', sources via 'manus' */
  findings?: StrategyFinding[];
}

export interface StrategyRun {
  startedAt: number;
  steps: StrategyStep[];
  done: StrategyStep[];
  finishedAt?: number;
  stoppedAt?: StrategyStep;
  note?: string;
}

export interface StrategyState {
  v: 1;
  /** the owner's words; AI never writes them */
  inputs: StrategyInputs;
  /** default true */
  useBrain: boolean;
  /** default 5 */
  maxSearches: 3 | 5 | 8;
  sources: StrategySource[];
  /** next n to give out (starts at 1) */
  nextSource: number;
  research?: StrategyResearch;
  promote?: StrategyPromote;
  content?: StrategyContent;
  assets?: StrategyAssets;
  outreach?: StrategyOutreach;
  plan?: StrategyPlan;
  /** action id → when the owner ticked it (owner fact) */
  ticks: Record<string, number>;
  applied: Partial<Record<ApplyArea, AppliedRecord>>;
  run?: StrategyRun;
  manus?: StrategyManus;
  updatedAt: number;
}

/** What a task writes for a section: the section without its StepInfo. */
export type ResearchOutFinding = { topic: FindingTopic; text: string; basis: StrategyBasis; sourceUrls: string[] };
export interface ResearchOut {
  summary: string;
  findings: ResearchOutFinding[];
  checks: string[];
}
export type PromoteOut = Omit<StrategyPromote, keyof StepInfo>;
export type ContentOut = Omit<StrategyContent, keyof StepInfo>;
export type AssetsOut = Omit<StrategyAssets, keyof StepInfo>;
export type OutreachOut = Omit<StrategyOutreach, keyof StepInfo>;
export type PlanOut = Omit<StrategyPlan, keyof StepInfo | 'startAt'>;

/** The owner's own numbers and words: claims and numbers in them are facts the owner gave. */
export interface OwnerFacts {
  nums: Set<string>;
  text: string;
}

/** What already exists in the project (never AI text): the steps skip what's done. */
export interface StrategyHas {
  website: boolean;
  socials: string[];
  salesPage: boolean;
  pageType: PageType | null;
  pagePublished: boolean;
  bookingLink: boolean;
  paymentLink: boolean;
  leadMagnet: LeadMagnetType | null;
  emails: number;
  subscribers: number;
  codeAssets: CodeKind[];
  listed: boolean;
  listingImages: boolean;
  productFiles: number;
  packages: number;
  posts: { drafts: number; planned: number; posted: number };
  campaignPlan: boolean;
  ads: number;
}

/** A step's INPUT (src/ai/strategyTasks.ts stepInput): the owner's words, what exists, and the ids the AI may use. */
export interface StepInputBase {
  /** only non-empty fields; the owner's words */
  owner: Partial<StrategyInputs>;
  has: StrategyHas;
  /** campaign.platforms, else ['instagram', 'facebook'] */
  networks: PostPlatform[];
  allowed: { pageTypes: PageType[]; placements: LinkPlacement[]; actionKinds: ActionKind[]; codeKinds: CodeKind[]; leadMagnetTypes: LeadMagnetType[] };
}
export interface ResearchInput extends StepInputBase {
  /** a key powering Strategy can search (strategyWho().mode === 'web') */
  web: boolean;
  maxSearches: 3 | 5 | 8;
  /** "Austin, Texas" (business track with a location only) */
  location: string | null;
  locationParts: { city: string; region: string } | null;
}
export interface LaterInput extends StepInputBase {
  /** search + Manus findings */
  research: { summary: string; findings: { topic: FindingTopic; text: string; sources: number[] }[] };
  /** no URLs (the model cites numbers) */
  sources: { n: number; title: string; domain: string }[];
  /** compact earlier sections */
  earlier?: Record<string, unknown>;
}
export type StepInput = ResearchInput | LaterInput;
