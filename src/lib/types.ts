import type { EbookExtras } from '@/ai/local/ebook';
import type { WorkbookSpec } from '@/ai/workbook';
// ───────────────────────── Domain model: the Project Context Store ─────────────────────────

export type Track = 'product' | 'business';
export type Origin = 'existing' | 'new';
export type ProductFormat =
  | 'pdf'
  | 'course'
  | 'template'
  | 'spreadsheet'
  | 'software'
  | 'design'
  | 'audio'
  | 'membership'
  | 'ebook';
export type PriceModel = 'one-time' | 'monthly' | 'yearly';
export type ServicePriceModel = PriceModel | 'per-session' | 'project' | 'quote' | 'free';

export type SocialPlatform = 'instagram' | 'facebook' | 'tiktok' | 'linkedin' | 'x' | 'youtube';
export type PostPlatform = 'instagram' | 'facebook' | 'tiktok' | 'linkedin' | 'x';
export type PostFormat = 'image' | 'video';
export type PostType = 'educational' | 'tip' | 'question' | 'sales' | 'bts';
export type ImageStyleId = 'minimal' | 'neon' | 'editorial' | 'isometric' | 'handcrafted';
export type VideoStyleId = 'ugc' | 'kinetic' | 'split' | 'cinematic' | 'talking';
export type StyleId = ImageStyleId | VideoStyleId;
export type PostStatus = 'draft' | 'scheduled' | 'published';

export type LogoShape = 'circle' | 'rounded' | 'hex' | 'shield' | 'blob' | 'none';
export type LogoLayout = 'horizontal' | 'stacked' | 'mark' | 'wordmark';
export type LogoFont = 'grotesk' | 'serif' | 'rounded' | 'mono' | 'script' | 'poster';
export type BannerStyle = 'waves' | 'grid' | 'blobs' | 'split' | 'photo';

export interface BrandColors {
  primary: string;
  secondary: string;
  accent: string;
  ink: string;
  paper: string;
}

export interface LogoConfig {
  mode: 'generated' | 'upload';
  icon: string;
  shape: LogoShape;
  layout: LogoLayout;
  font: LogoFont;
  monogram: boolean;
  uploadDataUrl?: string;
}

export interface BannerConfig {
  style: BannerStyle;
  showTagline: boolean;
  imageId?: string;
}

export interface MediaRef {
  id: string;
  kind: 'image' | 'video';
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  w?: number;
  h?: number;
  /** small data URL preview (≤ ~20KB) so lists render without touching IndexedDB */
  thumb?: string;
  /** set when the app created this image with AI */
  generated?: GeneratedInfo;
}

/** photo = an image provider on your server (Meta Muse Image, OpenAI…); illustration = drawn by Claude; design = offline brand art */
export type ImageKind = 'photo' | 'illustration';
export type ImageAspect = '1:1' | '4:5' | '9:16' | '1.91:1' | '3:2' | '21:8';

export interface GeneratedInfo {
  kind: ImageKind | 'design';
  /** who made the artwork, e.g. "Meta Muse Image", "Claude", "Built-in" */
  provider: string;
  prompt: string;
  purpose: 'post' | 'listing';
  /** listing shot id (hero, lifestyle, inside, offer) */
  shot?: string;
  aspect: ImageAspect;
  /** text, logo and watermark are already part of the image: show it as-is */
  final: boolean;
  createdAt: number;
  /** the raw artwork (no text) kept in the media store, so text can be re-typeset without a new generation */
  artId?: string;
  /** Manus task that made the artwork */
  taskUrl?: string;
  /** post images: the headline that was typeset */
  headline?: string;
  overlay?: boolean;
  watermark?: boolean;
}

export type Socials = Partial<Record<SocialPlatform, string>>;

export interface NameOption {
  name: string;
  rationale: string;
  domain: string;
}

export interface Brand {
  name: string;
  nameOptions: NameOption[];
  tagline: string;
  pitch: string;
  valueProp: string;
  audience: string;
  personality: string[];
  mission: string;
  websiteUrl: string;
  slug: string;
  domainIdeas: string[];
  colors: BrandColors;
  logo: LogoConfig;
  banner: BannerConfig;
  images: MediaRef[];
  socials: Socials;
}

export interface ProductIdea {
  id: string;
  title: string;
  hook: string;
  audience: string;
  pain: string;
  solution: string;
  format: ProductFormat;
  price: number;
  priceModel: PriceModel;
  score: number;
  revenueLow: number;
  revenueHigh: number;
  angle: string;
  features: string[];
  signals: string[];
}

// ───────────── Studio ─────────────
export interface OutlineItem {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
}

export interface OutlineSection {
  id: string;
  title: string;
  summary?: string;
  items: OutlineItem[];
  draft?: string;
}

export interface ServicePackage {
  id: string;
  name: string;
  price: number;
  priceModel: ServicePriceModel;
  description: string;
  includes: string[];
  popular?: boolean;
}

export interface OperatingBlock {
  id: string;
  title: string;
  items: string[];
}

export interface ValueStackItem {
  id: string;
  title: string;
  value: number;
  description: string;
  kind: 'core' | 'bonus' | 'guarantee';
}

export type CodeKind =
  | 'calculator'
  | 'leadform'
  | 'pricing'
  | 'hero'
  | 'countdown'
  | 'quiz'
  | 'checklist'
  | 'testimonials'
  | 'booking'
  | 'spreadsheet'
  | 'faq'
  | 'roi';

export interface CodeAsset {
  id: string;
  name: string;
  kind: CodeKind;
  prompt: string;
  html: string;
  css: string;
  js: string;
  /** For spreadsheet assets: the Apps Script / formulas that power the preview */
  script?: string;
  createdAt: number;
  updatedAt: number;
}

export type BookingType = 'book' | 'inquire' | 'buy';

export interface ListingDraft {
  title: string;
  tagline: string;
  description: string;
  category: string;
  tags: string[];
  bookingType: BookingType;
  hours: string;
  coverImageId?: string;
  /** brand images shown in the listing's gallery (max 4) */
  galleryIds?: string[];
  /** AI product demo video (HeyGen) */
  demoVideo?: MediaRef;
}

/** A finished product file made in the Studio (PDF guide/ebook or .xlsx workbook); bytes live in IndexedDB under `id`. */
export interface ProductFile {
  id: string;
  kind: 'pdf' | 'xlsx';
  name: string;
  size: number;
  createdAt: number;
  /** PDF pages */
  pages?: number;
  /** workbook tabs */
  sheets?: string[];
  /** who wrote the content */
  engine: ProviderId;
}

export interface Studio {
  outline: OutlineSection[];
  outlineLabel: string;
  packages: ServicePackage[];
  operating: OperatingBlock[];
  valueStack: ValueStackItem[];
  price: number;
  compareAt: number;
  priceModel: PriceModel;
  codeAssets: CodeAsset[];
  listing: ListingDraft;
  publishedListingId?: string;
  publishedAt?: number;
  /** finished files, newest first */
  productFiles?: ProductFile[];
  /** the AI's last copy for the PDF (welcome, workbook pages…), reused when only the layout changes */
  ebookExtras?: { data: EbookExtras; at: number; engine: ProviderId };
  /** the AI's last workbook design, reused when only colors or layout change */
  workbook?: { spec: WorkbookSpec; at: number; engine: ProviderId };
}

// ───────────── Marketing ─────────────
export type Channel = 'seo' | 'email' | 'social' | 'ads';
export type LeadMagnetType = 'checklist' | 'guide' | 'cheatsheet' | 'template' | 'swipe' | 'workbook';

export interface LeadMagnet {
  id: string;
  type: LeadMagnetType;
  title: string;
  subtitle: string;
  intro: string;
  sections: { heading: string; items: string[] }[];
  cta: string;
  optInHeadline: string;
  optInBullets: string[];
  buttonLabel: string;
  createdAt: number;
}

export interface EmailStep {
  id: string;
  index: number;
  purpose: string;
  subject: string;
  preview: string;
  body: string;
  delay: { value: number; unit: 'minutes' | 'hours' | 'days' };
  ctaLabel: string;
  ctaUrl: string;
}

export interface Subscriber {
  id: string;
  name: string;
  email: string;
  joinedAt: number;
  source: 'test' | 'optin' | 'sample';
  step: number;
  opened: number[];
  clicked: number[];
  converted?: boolean;
}

export interface SeoMeta {
  metaTitle: string;
  metaDescription: string;
  slug: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  ogTitle: string;
  ogDescription: string;
  ogImageAlt: string;
  canonical: string;
}

export interface HeroData {
  eyebrow: string;
  headline: string;
  subheadline: string;
  ctaLabel: string;
  ctaSubtext: string;
  bullets: string[];
}
export interface ProblemData {
  heading: string;
  intro: string;
  points: { title: string; body: string }[];
  agitation: string;
}
export interface SolutionData {
  heading: string;
  intro: string;
  features: { title: string; body: string; icon: string }[];
}
export interface ProofData {
  heading: string;
  stats: { value: string; label: string }[];
  testimonials: { quote: string; name: string; role: string; rating: number }[];
}
export interface PricingData {
  heading: string;
  planName: string;
  price: number;
  compareAt: number;
  priceNote: string;
  includes: string[];
  ctaLabel: string;
  badge: string;
}
export interface FaqData {
  heading: string;
  items: { q: string; a: string }[];
}
export interface GuaranteeData {
  heading: string;
  body: string;
  days: number;
  finalHeading: string;
  finalCta: string;
}

export type SalesSection =
  | { id: string; type: 'hero'; visible: boolean; data: HeroData }
  | { id: string; type: 'problem'; visible: boolean; data: ProblemData }
  | { id: string; type: 'solution'; visible: boolean; data: SolutionData }
  | { id: string; type: 'proof'; visible: boolean; data: ProofData }
  | { id: string; type: 'pricing'; visible: boolean; data: PricingData }
  | { id: string; type: 'faq'; visible: boolean; data: FaqData }
  | { id: string; type: 'guarantee'; visible: boolean; data: GuaranteeData };
export type SalesSectionType = SalesSection['type'];

export interface SalesTheme {
  font: 'sans' | 'serif' | 'grotesk';
  mode: 'light' | 'dark';
  radius: 'sharp' | 'soft' | 'round';
}

export interface SalesPage {
  sections: SalesSection[];
  theme: SalesTheme;
  updatedAt: number;
}

export interface CampaignConfig {
  /** index 0 = Monday … 6 = Sunday */
  days: boolean[];
  postsPerDay: number;
  videosPerDay: number;
  watermark: boolean;
  imageStyles: ImageStyleId[];
  videoStyles: VideoStyleId[];
  platforms: PostPlatform[];
  /** weight 0 = excluded, 1 = some, 2 = more, 3 = most */
  postTypes: Record<PostType, number>;
  startDate: string;
  times: string[];
  goal: 'awareness' | 'leads' | 'sales';
}

export interface PlanSlot {
  id: string;
  time: string;
  platform: PostPlatform;
  format: PostFormat;
  style: StyleId;
  postType: PostType;
  topic: string;
}

export interface PlanDay {
  date: string;
  dayIndex: number;
  week: number;
  phase: string;
  posting: boolean;
  slots: PlanSlot[];
}

export interface PlanWeek {
  week: number;
  theme: string;
  goal: string;
  kpi: string;
  keyMessage: string;
}

export interface CampaignPlan {
  id: string;
  createdAt: number;
  startDate: string;
  strategy: string;
  days: PlanDay[];
  weeks: PlanWeek[];
  summary: {
    total: number;
    videos: number;
    images: number;
    byType: Record<PostType, number>;
    byPlatform: Partial<Record<PostPlatform, number>>;
    estReach: number;
  };
}

export interface Scene {
  id: string;
  text: string;
  shot: string;
  duration: number;
}

export interface Post {
  id: string;
  projectId: string;
  status: PostStatus;
  platform: PostPlatform;
  format: PostFormat;
  style: StyleId;
  postType: PostType;
  headline: string;
  visualPrompt: string;
  caption: string;
  hashtags: string[];
  scheduledAt: string;
  publishedAt?: string;
  media?: MediaRef;
  storyboard?: Scene[];
  watermark: boolean;
  /** a real post scheduled outside the app (Facebook, by Manus) */
  external?: ExternalPublish;
  source: 'batch' | 'composer' | 'sample' | 'ads';
  planSlotId?: string;
  batchId?: string;
  skills?: string[];
  createdAt: number;
  updatedAt: number;
  seed: number;
}

export interface ExternalPublish {
  via: 'manus';
  network: 'facebook';
  taskId: string;
  taskUrl: string;
  /** working: Manus is on it · needs_input: Manus paused for you · finished: done without a clear result line */
  state: 'working' | 'needs_input' | 'scheduled' | 'failed' | 'finished';
  message: string;
  page: string;
  scheduledFor: string;
  requestedAt: number;
  checkedAt: number;
}

// ───────────── Paid ads ─────────────
export type AdObjective = 'awareness' | 'traffic' | 'leads' | 'sales';
export type AdPlatform = 'meta' | 'tiktok' | 'google' | 'linkedin';

export interface AdCreative {
  id: string;
  variant: string;
  angle: string;
  primaryText: string;
  headline: string;
  description: string;
  cta: string;
  style: StyleId;
  format: PostFormat;
  visualHeadline: string;
}

export interface SearchAd {
  headlines: string[];
  descriptions: string[];
  path: string[];
  keywords: string[];
  sitelinks: { title: string; desc: string }[];
}

export interface AdProjection {
  spend: number;
  impressions: number;
  reach: number;
  ctr: number;
  cpc: number;
  clicks: number;
  cvr: number;
  conversions: number;
  cpa: number;
  roas: number;
}

export interface AudienceSet {
  id: string;
  name: string;
  description: string;
  size: string;
  interests: string[];
}

export interface AdCampaign {
  id: string;
  projectId: string;
  name: string;
  objective: AdObjective;
  platforms: AdPlatform[];
  dailyBudget: number;
  durationDays: number;
  startDate: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  locations: string;
  radiusMi: number;
  ageMin: number;
  ageMax: number;
  interests: string[];
  audiences: AudienceSet[];
  creatives: AdCreative[];
  selectedCreativeIds: string[];
  search: SearchAd | null;
  projections: AdProjection;
  createdAt: number;
  launchedAt?: number;
  seed: number;
}

// ───────────── Marketplace ─────────────
export type ListingKind = 'product' | 'business';

export interface CoverSpec {
  colors: [string, string, string];
  icon: string;
  pattern: 'dots' | 'waves' | 'grid' | 'rays' | 'blobs';
  imageDataUrl?: string;
}

export interface MiniLogo {
  icon: string;
  color: string;
  shape: LogoShape;
  dataUrl?: string;
}

export interface Listing {
  id: string;
  kind: ListingKind;
  title: string;
  tagline: string;
  description: string;
  price: number;
  priceModel: ServicePriceModel;
  compareAt?: number;
  seller: { name: string; logo?: MiniLogo; verified?: boolean; ownerId?: string };
  format?: ProductFormat;
  niche?: string;
  category: string;
  tags: string[];
  location?: { city: string; region: string; lat?: number; lng?: number; online?: boolean };
  website?: string;
  bookingType?: BookingType;
  hours?: string;
  services?: { name: string; price: number; duration?: string }[];
  includes?: string[];
  cover: CoverSpec;
  /** extra listing images as small data URLs (max 4) */
  gallery?: string[];
  rating: number;
  reviews: number;
  sales: number;
  createdAt: number;
  origin: 'sample' | 'mine' | 'community';
  projectId?: string;
}

export interface CartItem {
  id: string;
  listingId: string;
  title: string;
  price: number;
  qty: number;
  kind: ListingKind;
  option?: string;
  bookingAt?: string;
  sellerName: string;
  sellerOwnerId?: string;
  cover: CoverSpec;
  origin: Listing['origin'];
}

export interface Order {
  id: string;
  number: string;
  createdAt: number;
  items: CartItem[];
  subtotal: number;
  fees: number;
  total: number;
  email: string;
  name: string;
  paymentMethod: string;
  last4?: string;
}

export interface SaleRecord {
  id: string;
  listingId: string;
  projectId?: string;
  title: string;
  amount: number;
  qty: number;
  createdAt: number;
  buyer: string;
  source: 'checkout' | 'community' | 'simulated' | 'sample';
}

// ───────────── Brain ─────────────
export type SkillCategory =
  | 'voice'
  | 'audience'
  | 'copywriting'
  | 'offer'
  | 'seo'
  | 'social'
  | 'email'
  | 'visual'
  | 'rules'
  | 'knowledge'
  | 'learned';

export type ModuleScope =
  | 'all'
  | 'research'
  | 'brand'
  | 'studio'
  | 'code'
  | 'email'
  | 'seo'
  | 'social'
  | 'ads'
  | 'store';

export type Tone =
  | 'friendly'
  | 'professional'
  | 'bold'
  | 'playful'
  | 'luxury'
  | 'empathetic'
  | 'witty'
  | 'authoritative';

export type Framework = 'AIDA' | 'PAS' | 'BAB' | 'FAB' | '4U' | 'StoryBrand';
export type HookStyle = 'question' | 'stat' | 'contrarian' | 'story' | 'pov';

export interface Directives {
  tone?: Tone;
  emoji?: 'none' | 'light' | 'heavy';
  framework?: Framework;
  length?: 'short' | 'medium' | 'long';
  readingLevel?: 'simple' | 'standard' | 'expert';
  cta?: string;
  hashtags?: string[];
  banned?: string[];
  mustInclude?: string[];
  signOff?: string;
  audience?: string;
  person?: 'i' | 'we' | 'you';
  facts?: string[];
  hookStyle?: HookStyle;
}

export interface Skill {
  id: string;
  name: string;
  category: SkillCategory;
  description: string;
  instructions: string;
  scope: ModuleScope[];
  priority: 1 | 2 | 3;
  enabled: boolean;
  directives: Directives;
  source: 'custom' | 'library' | 'feedback' | 'document';
  libraryId?: string;
  doc?: { name: string; size: number; keywords: string[]; excerpt: string };
  stats: { applied: number; lastApplied?: number; up: number; down: number };
  createdAt: number;
  updatedAt: number;
}

/** Who answered: Claude in claude.ai, your server's AI keys, or the built-in engine. */
export type ProviderId = 'local' | 'claude' | 'server';

/** Which key, model and effort served a generation on your server, and what it used. */
export interface GenMeta {
  provider: string;
  providerLabel: string;
  /** text | image | video | agent: what the effort meant (reasoning, quality, agent profile) */
  kind?: string;
  model: string;
  effort: string;
  effortLabel: string;
  input?: number;
  output?: number;
  reasoning?: number | null;
  costUsd?: number | null;
  costEstimated?: boolean;
  credits?: number | null;
}

export interface GenerationLog {
  id: string;
  task: string;
  label: string;
  module: ModuleScope;
  provider: ProviderId;
  skillIds: string[];
  createdAt: number;
  ms: number;
  rating?: 1 | -1;
  projectId?: string;
  meta?: GenMeta;
}

// ───────────── Settings & app ─────────────
export interface AccountConnection {
  connected: boolean;
  handle: string;
  followers: number;
  connectedAt?: number;
}

export interface AppSettings {
  ai: {
    /** your AI server's address; blank when the app and server run together */
    serverUrl: string;
    /** the Brain: skills and art direction for every key that's on */
    useBrain: boolean;
    simulateLatency: boolean;
  };
  theme: 'system' | 'light' | 'dark';
  profile: { name: string; email: string };
  accounts: Record<SocialPlatform, AccountConnection>;
  marketActivity: boolean;
  showSampleListings: boolean;
  shareToCommunity: boolean;
}

export interface Notice {
  id: string;
  title: string;
  body?: string;
  kind: 'sale' | 'post' | 'ai' | 'info' | 'lead';
  createdAt: number;
  read: boolean;
  route?: string;
}

export interface Project {
  id: string;
  createdAt: number;
  updatedAt: number;
  track: Track;
  origin: Origin;
  onboarded: boolean;
  wizardStep: string;
  niche: string;
  category: string;
  format: ProductFormat | null;
  businessType: string;
  location: { city: string; region: string; lat?: number; lng?: number } | null;
  summary: string;
  ideas: ProductIdea[];
  idea: ProductIdea | null;
  brand: Brand;
  studio: Studio;
  marketing: {
    leadMagnet: LeadMagnet | null;
    emails: EmailStep[];
    subscribers: Subscriber[];
    seo: SeoMeta | null;
    salesPage: SalesPage | null;
    campaign: CampaignConfig;
    plan: CampaignPlan | null;
    batchId?: string;
    lastChannel?: Channel;
  };
}
