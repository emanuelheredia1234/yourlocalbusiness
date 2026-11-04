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
/** The SEO page's type: lead form, booking, website, landing, showcase or checkout page (absent on a project: 'landing'). */
export type PageType = 'lead' | 'booking' | 'website' | 'landing' | 'showcase' | 'checkout';
/** Where a social post's link goes: in the post, in the first comment (a reply on X), or in the profile's bio. */
export type LinkPlacement = 'post' | 'comment' | 'bio';

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

/** An image the owner added to a prompt box. The page or artifact refers to it as {{img-1}}, {{img-2}}… */
export interface PromptImage {
  /** 'img-1', 'img-2', … (unique within its page/artifact, never reused) */
  key: string;
  media: MediaRef;
  /** what it shows, or where to use it (the owner's words; optional) */
  note?: string;
}

/** A page published at a public address. */
export interface Published {
  /** its name on the app's address: https://<app>/<slug> */
  slug: string;
  /** one of the owner's own domains it also shows on (https://<domain>/<slug>), and whether it's that domain's home page (https://<domain>/) */
  domain?: string;
  home?: boolean;
  url: string;
  domainUrl?: string;
  publishedAt: number;
  /** fingerprint of what was published (html + image keys), to show "changes not published yet" */
  hash: string;
}

export type Socials = Partial<Record<SocialPlatform, string>>;

/** Manus learning your brand voice from one of your social profiles (only when you turn it on for that profile). */
export interface SocialVoice {
  /** the switch: use what Manus learned from this profile (its Brain skill is on while this is on) */
  learn: boolean;
  /** the read Manus is doing, or did last */
  task?: VoiceRead;
  /** what the last finished read found, and the profile it read (as you had typed it) */
  report?: VoiceReport;
  profile?: string;
  postsRead?: number;
  analyzedAt?: number;
  /** the Brain skill made from it */
  skillId?: string;
  /** fingerprint of the skill as the app last wrote it: a different one means you edited the skill since */
  written?: string;
  /** the last read finished after you'd edited the skill, so the skill was left as you had it */
  keptEdits?: boolean;
}

export interface VoiceRead {
  taskId: string;
  taskUrl: string;
  /** working · needs_input: Manus paused for you · done: it reported the voice · failed · finished: stopped without a report */
  state: 'working' | 'needs_input' | 'done' | 'failed' | 'finished';
  message: string;
  /** the profile as it was when the read started */
  profile: string;
  /** you agreed to replace your edits to the skill with this read */
  replace?: boolean;
  requestedAt: number;
  checkedAt: number;
}

/** How a profile's posts sound and look, as Manus reported it (checked and trimmed by the app). */
export interface VoiceReport {
  tone?: Tone;
  adjectives: string[];
  person?: 'i' | 'we' | 'you';
  words: string[];
  openings: string;
  endings: string;
  emoji: { level?: 'none' | 'few' | 'many'; list: string[] };
  hashtags: { level?: 'none' | 'few' | 'many'; list: string[] };
  length: { level?: 'short' | 'medium' | 'long'; structure: string };
  topics: string[];
  visuals: string;
  /** new captions Manus wrote in that voice (style examples, not posts it copied) */
  examples: string[];
}

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
  /** only what the owner entered; '' when they have no website (never made up from the name) */
  websiteUrl: string;
  /** a website older versions made up from the name ("https://{slug}.com"), taken off by the cleanup:
   *  the Dashboard asks once whether it's really yours */
  guessedWebsite?: string;
  /** you said the website is yours, so the cleanup leaves it alone */
  websiteConfirmed?: boolean;
  slug: string;
  domainIdeas: string[];
  colors: BrandColors;
  logo: LogoConfig;
  banner: BannerConfig;
  images: MediaRef[];
  socials: Socials;
  /** per profile, when you let Manus learn your brand voice from its posts */
  voiceFrom?: Partial<Record<SocialPlatform, SocialVoice>>;
}

export interface ProductIdea {
  id: string;
  title: string;
  hook: string;
  audience: string;
  pain: string;
  solution: string;
  format: ProductFormat;
  /** a suggested starting price; the owner sets the real one */
  price: number;
  priceModel: PriceModel;
  angle: string;
  features: string[];
  /** "Why this could fit you": reasons from the owner's own niche, category and format, not market data */
  fit: string[];
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
  /** made by an older version that claimed sent forms, taken slots, a made-up deadline or reviews:
   *  the Code tab shows "Outdated: regenerate" (the code itself is never rewritten automatically).
   *  false = made by a current version, regenerated, or dismissed by the owner: never flagged again */
  outdated?: boolean;
  /** images added in the prompt boxes; the code uses them as {{img-N}} */
  images?: PromptImage[];
  /** where it's published, if it is */
  published?: Published;
  createdAt: number;
  updatedAt: number;
}

export type BookingType = 'book' | 'inquire' | 'buy';

/** The four marketplace listing images (src/ai/image.ts listingShots). */
export type ListingShotId = 'hero' | 'lifestyle' | 'inside' | 'offer';

export interface ListingDraft {
  title: string;
  tagline: string;
  description: string;
  category: string;
  tags: string[];
  bookingType: BookingType;
  hours: string;
  /** your own page where people buy or book (payment happens there, not in this app) */
  buyUrl?: string;
  contactEmail?: string;
  phone?: string;
  coverImageId?: string;
  /** brand images shown in the listing's gallery (max 3, what the shared Marketplace keeps) */
  galleryIds?: string[];
  /** listing image descriptions you edited (the suggested ones are used for the rest) */
  shotPrompts?: Partial<Record<ListingShotId, string>>;
  /** listing images that show a photo you uploaded instead of an AI image (brand image ids) */
  shotImageIds?: Partial<Record<ListingShotId, string>>;
  /** AI product demo video (HeyGen) */
  demoVideo?: MediaRef;
  /** template hours or a template guarantee that older versions filled in were removed: the Publish tab asks the
   *  owner to review the listing until they dismiss it */
  needsReview?: boolean;
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
  /** optin: signed up on your page · import: from a CSV you imported */
  source: 'optin' | 'import';
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
  /** media id of one of the page's prompt images (an owner fact: the AI never sets it) */
  imageId?: string;
  imageAlt?: string;
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
/** Proof is only ever real: counts from the actual outline, or what the owner typed. `needsReview` marks
 *  items written by AI before that rule: they stay off the exported page until the owner confirms them. */
export interface ProofStat {
  value: string;
  label: string;
  needsReview?: boolean;
}
export interface Testimonial {
  quote: string;
  name: string;
  role: string;
  /** 1–5 stars the customer gave; 0 = no rating */
  rating: number;
  needsReview?: boolean;
}
export interface ProofData {
  heading: string;
  stats: ProofStat[];
  testimonials: Testimonial[];
}
export interface PricingData {
  heading: string;
  planName: string;
  price: number;
  /** the owner's own earlier price; 0 = none */
  compareAt: number;
  /** a "was" price written before only the owner could set one: hidden until confirmed */
  compareAtNeedsReview?: boolean;
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
  /** 0 = no time limit shown */
  days: number;
  finalHeading: string;
  finalCta: string;
  /** the owner turned their guarantee on; otherwise only the closing heading and button show */
  offered?: boolean;
}
/** Photos the owner added (by media id: an owner fact). The AI may write the heading, intro, alt text and captions. */
export interface GalleryData {
  heading: string;
  intro: string;
  items: { imageId: string; alt: string; caption: string }[];
}
/** The page's form. Its fields are the app's own (name, email, phone optional, message, plus a preferred time
 *  when askTime): the AI writes only the heading, intro and button label. Published, it posts to /<slug>/lead. */
export interface LeadFormData {
  heading: string;
  intro: string;
  buttonLabel: string;
  /** ask for a preferred time (a booking request): the owner's setting, never the AI's */
  askTime: boolean;
}
/** One thing the business sells: every field is the owner's (their packages or product, or what they typed on the page). */
export interface OfferItem {
  id: string;
  name: string;
  description: string;
  /** 0: no price ("Ask for a quote" for a business, unless priceNote says otherwise) */
  price: number;
  /** what the price is for ("per visit"), or the whole price text when there's no number ("Free") */
  priceNote: string;
  /** "60 min", typed by the owner; '' for none */
  duration: string;
  /** one of the page's images (media id) */
  imageId?: string;
  imageAlt?: string;
  /** its button: book (the booking link, else the request form), buy (the payment link), inquire (the form), or none */
  cta: 'book' | 'buy' | 'inquire' | 'none';
  /** this item's own link (a payment link for just this package, say); else the page's booking or payment link */
  link?: string;
}
/** What the business sells: a booking page's services, a showcase, a website's Services. The AI writes only the heading and intro. */
export interface OffersData {
  heading: string;
  intro: string;
  items: OfferItem[];
}
export interface AboutData {
  heading: string;
  body: string;
}
/** How to reach the business: the owner's details (from the listing, editable on the page). Empty ones stay off the page. */
export interface ContactData {
  heading: string;
  intro: string;
  address: string;
  hours: string;
  phone: string;
  email: string;
}

export type SalesSection =
  | { id: string; type: 'hero'; visible: boolean; data: HeroData }
  | { id: string; type: 'problem'; visible: boolean; data: ProblemData }
  | { id: string; type: 'solution'; visible: boolean; data: SolutionData }
  | { id: string; type: 'proof'; visible: boolean; data: ProofData }
  | { id: string; type: 'pricing'; visible: boolean; data: PricingData }
  | { id: string; type: 'faq'; visible: boolean; data: FaqData }
  | { id: string; type: 'guarantee'; visible: boolean; data: GuaranteeData }
  /** not on a new page: added (after the solution) once the page has images for it */
  | { id: string; type: 'gallery'; visible: boolean; data: GalleryData }
  | { id: string; type: 'leadForm'; visible: boolean; data: LeadFormData }
  | { id: string; type: 'offers'; visible: boolean; data: OffersData }
  | { id: string; type: 'about'; visible: boolean; data: AboutData }
  | { id: string; type: 'contact'; visible: boolean; data: ContactData };
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
  /** made (or cleaned) by a version that never invents proof, prices or guarantees */
  claimsChecked?: boolean;
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
  /** when the post is planned on your calendar (nothing posts by itself at this time) */
  scheduledAt: string;
  /** when it went out: set only when Manus reported it posted, or you marked it posted */
  publishedAt?: string;
  /** who said it was posted: Manus (its own report) or you */
  publishedBy?: 'manus' | 'manual';
  /** where it was before you marked it posted (so "Mark as not posted" puts it back) */
  statusBeforePosted?: 'draft' | 'scheduled';
  /** the post's address on the network, when Manus reported one or you pasted it */
  postUrl?: string;
  media?: MediaRef;
  storyboard?: Scene[];
  watermark: boolean;
  /** the post handed to Manus, which posts it on the network in its own browser */
  external?: ExternalPublish;
  /** the post shared in Facebook groups by Manus (separate from posting it on the Page) */
  groupShare?: GroupShare;
  /** where this post's link goes; absent: the network's built-in default, which is what its caption was written for */
  linkPlacement?: LinkPlacement;
  /** the first comment's text, with the link, when the link goes in the first comment */
  firstComment?: string;
  source: 'batch' | 'composer' | 'ads';
  planSlotId?: string;
  batchId?: string;
  skills?: string[];
  createdAt: number;
  updatedAt: number;
  seed: number;
}

/** One Facebook group in a group share, as Manus reported it. */
export interface GroupResult {
  group: string;
  /** posted · pending: waiting for the group's admins · skipped: the group's rules or settings don't allow it · failed */
  state: 'posted' | 'pending' | 'skipped' | 'failed';
  detail: string;
  url?: string;
}

/** A post Manus shares in the Facebook groups you listed, one after another. */
export interface GroupShare {
  via: 'manus';
  taskId: string;
  taskUrl: string;
  /** working · needs_input: Manus paused for you · done: it reported every group · failed · finished: done without a clear report */
  state: 'working' | 'needs_input' | 'done' | 'failed' | 'finished';
  message: string;
  groups: string[];
  /** your profile, or the Page name to post as where the group allows it */
  postAs: string;
  results: GroupResult[];
  /** groups an earlier run already posted in (or that wait for approval): kept when the post was sent again to the rest */
  earlier?: GroupResult[];
  requestedAt: number;
  checkedAt: number;
}

export interface ExternalPublish {
  via: 'manus';
  network: PostPlatform;
  taskId: string;
  taskUrl: string;
  /** what Manus was asked to do: post right away, or schedule for scheduledFor (older posts: schedule) */
  mode?: 'now' | 'schedule';
  /** working: Manus is on it · needs_input: Manus paused for you · finished: done without a clear result line */
  state: 'working' | 'needs_input' | 'posted' | 'scheduled' | 'failed' | 'finished';
  message: string;
  /** the account Manus was asked to post as (a Page, profile or handle) */
  page: string;
  scheduledFor: string;
  /** the post's address, when Manus reported one */
  url?: string;
  /** the first comment (a reply on X) Manus was asked to add right after posting, and what its RESULT line said:
   *  asked (no report yet) · added · failed · unknown (it posted but didn't say) */
  comment?: { state: 'asked' | 'added' | 'failed' | 'unknown'; detail?: string };
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

export interface AudienceSet {
  id: string;
  name: string;
  description: string;
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
  /** always a plan: campaigns run in each platform's own ads manager, never from this app */
  status: 'draft';
  locations: string;
  radiusMi: number;
  ageMin: number;
  ageMax: number;
  interests: string[];
  audiences: AudienceSet[];
  creatives: AdCreative[];
  selectedCreativeIds: string[];
  search: SearchAd | null;
  createdAt: number;
  /** when you last exported it for an ads manager */
  exportedAt?: number;
  /** the page the ads send people to; you enter it (it starts as your website, if you added one) */
  finalUrl?: string;
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
  seller: { name: string; logo?: MiniLogo; ownerId?: string };
  format?: ProductFormat;
  niche?: string;
  category: string;
  tags: string[];
  location?: { city: string; region: string; lat?: number; lng?: number; online?: boolean };
  website?: string;
  /** the seller's own page to buy or book (a Stripe Payment Link, Gumroad, Etsy, Calendly…): payment happens there */
  buyUrl?: string;
  /** how to reach the seller */
  contactEmail?: string;
  phone?: string;
  bookingType?: BookingType;
  hours?: string;
  /** priceModel only when a package has no price to show: 'quote' (Get a quote) or 'free' */
  services?: { name: string; price: number; duration?: string; priceModel?: 'quote' | 'free' }[];
  includes?: string[];
  cover: CoverSpec;
  /** extra listing images as small data URLs (max 4) */
  gallery?: string[];
  createdAt: number;
  origin: 'mine' | 'community';
  projectId?: string;
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
  /** social: written by the app from what Manus read on one of your social profiles */
  source: 'custom' | 'library' | 'feedback' | 'document' | 'social';
  libraryId?: string;
  /** only for this project (e.g. the voice learned from its posts); no projectId: every project */
  projectId?: string;
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

export interface AppSettings {
  ai: {
    /** your AI server's address; blank when the app and server run together */
    serverUrl: string;
    /** the Brain: skills and art direction for every key that's on */
    useBrain: boolean;
  };
  theme: 'system' | 'light' | 'dark';
  profile: { name: string; email: string };
  /**
   * Left from older versions, which pretended to connect social accounts (a handle and an invented
   * follower count). The cleanup moves any handle into the brand's social handles and removes this.
   */
  accounts?: Partial<Record<SocialPlatform, { handle?: string } | undefined>>;
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
  /** the version of the one-time cleanup of claims older versions made up (see store/cleanup.ts) */
  legacyCleaned?: number;
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
    /** the owner's standing guidance for the AI when it writes or edits the sales page */
    seoGuide?: string;
    /** links the SEO page's buttons use, typed in the page builder (owner facts, never the AI's); else the listing's link counts */
    pageLinks?: { booking?: string; payment?: string };
    /** images added in the sales page's prompt boxes */
    seoImages?: PromptImage[];
    /** the highest image number (img-N) the sales page has used: a removed image's number is never given to a new one, since its published file may still be cached */
    seoImageMax?: number;
    /** where the sales page is published, if it is */
    seoPublished?: Published;
    /** the SEO page's type; absent means 'landing' (what every page was before) */
    pageType?: PageType;
    /** where each network's link goes on new posts; absent: the built-in default for that network */
    linkPlacement?: Partial<Record<PostPlatform, LinkPlacement>>;
    campaign: CampaignConfig;
    plan: CampaignPlan | null;
    batchId?: string;
    lastChannel?: Channel;
    /** Facebook groups you share posts in (names or links), remembered for next time */
    facebookGroups?: string[];
  };
}
