import type {
  AdCampaign,
  CampaignConfig,
  CampaignPlan,
  CodeKind,
  Directives,
  EmailStep,
  LeadMagnet,
  LeadMagnetType,
  ImageAspect,
  ListingDraft,
  MediaRef,
  ModuleScope,
  OutlineItem,
  OutlineSection,
  Post,
  ProductIdea,
  Project,
  SalesPage,
  SalesSection,
  SalesSectionType,
  Scene,
  SeoMeta,
} from '@/lib/types';
import { clamp, isHex, uid } from '@/lib/utils';
import { getBlob } from '@/lib/storage';
import { videoFrame } from '@/lib/utils';
import { conform, framePrompt, type Tier } from './claude';
import { FORMATS, LOGO_ICONS } from './knowledge';
import { generateAds, type AdsResult } from './local/ads';
import { generateBrandKit, paletteFrom, type BrandKitResult } from './local/brand';
import { codeKindLabel, generateCode, modifyCode, type CodeResult } from './local/code';
import { generateEmailSequence, generateLeadMagnet } from './local/email';
import { generateProductIdeas, type ResearchInput } from './local/research';
import { generateSalesPage, generateSalesSection, generateSeoMeta, primaryKeywordFor } from './local/seo';
import { composePost, generateCampaignPlan, generateContentBatch, type ComposedPost, type ComposeInput } from './local/social';
import { draftSection, expandItem, generateBusinessModel, generateListing, generateOutline, type BusinessModelResult, type OutlineResult } from './local/studio';
import { buildFacts } from './text';
import { ART_SIZE, proceduralSvg, type ArtScene } from './local/art';
import { sanitizeSvg } from '@/lib/svg';
import { normalizeWorkbook, type WorkbookSpec } from './workbook';
import { localWorkbook } from './local/workbook';
import { localEbookExtras, type EbookExtras } from './local/ebook';

export interface TaskEnv {
  project: Project;
  directives: Directives;
  brainPrompt: string;
  variation: number;
}

export interface TaskDef<I, O> {
  id: string;
  label: string;
  module: ModuleScope;
  tier: Tier;
  stages: string[];
  local: (input: I, env: TaskEnv) => O;
  claude?: {
    prompt: (input: I, env: TaskEnv, base: O) => string;
    merge: (raw: unknown, base: O, input: I, env: TaskEnv) => O;
    images?: (input: I) => Promise<Blob[] | undefined>;
  };
}

const def = <I, O>(d: TaskDef<I, O>) => d;
const obj = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

// ───────────────────────── Research ─────────────────────────
export const productIdeasTask = def<ResearchInput, ProductIdea[]>({
  id: 'productIdeas',
  label: 'Winning product research',
  module: 'research',
  tier: 'default',
  stages: ['Scanning demand signals in the niche…', 'Mapping audience pains and buying triggers…', 'Matching concepts to the format…', 'Scoring revenue potential…'],
  local: (input, env) => generateProductIdeas({ ...input, variation: env.variation }, env.directives),
  claude: {
    prompt: (input, env) => {
      const fmt = FORMATS[input.format];
      return framePrompt({
        task: `Research and propose ${input.count ?? 4} high-converting “winning product” concepts for a ${fmt.label} in the niche “${input.niche}”, specifically “${input.category}”. Each concept needs a sharp audience, a painful problem it solves, a realistic price for this format (typical range $${fmt.price[0]}–$${fmt.price[1]}${fmt.model === 'monthly' ? ' per month' : ''}), and a revenue potential score from 0–100 weighing demand, competition, price and scalability. Order them from strongest to weakest.`,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `[{"title": string, "hook": string (one sentence), "audience": string, "pain": string, "solution": string (one sentence on what it is), "price": number, "score": number, "revenueLow": number (est. monthly USD), "revenueHigh": number, "angle": string (2-4 words), "features": [string, string, string], "signals": [string, string, string] (why it can win)}]`,
      });
    },
    merge: (raw, base, input) => {
      const arr = Array.isArray(raw) ? raw : (obj(raw).ideas as unknown[]) ?? [];
      const fmt = FORMATS[input.format];
      return conform(base, arr).map((idea) => ({
        ...idea,
        id: idea.id || uid('idea'),
        format: input.format,
        priceModel: fmt.model,
        price: Math.max(1, Math.round(idea.price)),
        score: Math.round(clamp(idea.score, 1, 99)),
        revenueLow: Math.max(0, Math.min(idea.revenueLow, idea.revenueHigh)),
        revenueHigh: Math.max(idea.revenueLow, idea.revenueHigh),
      }));
    },
  },
});

// ───────────────────────── Brand ─────────────────────────
export const brandKitTask = def<Record<string, never>, BrandKitResult>({
  id: 'brandKit',
  label: 'Brand identity kit',
  module: 'brand',
  tier: 'default',
  stages: ['Studying the audience and category…', 'Brainstorming names and checking domains…', 'Choosing palette, icon and type…', 'Writing the pitch and value proposition…'],
  local: (_i, env) => generateBrandKit(env.project, env.directives, env.variation),
  claude: {
    prompt: (_i, env, base) =>
      framePrompt({
        task: `Create a complete brand identity kit for this ${env.project.track === 'product' ? 'digital product' : 'business'}: three distinct, ownable name options (short, easy to say, .com-friendly), a tagline, a 2-sentence elevator pitch, a one-sentence value proposition, a target audience summary, three personality adjectives, a mission line, the best logo icon from the allowed list, and a color palette that suits the niche.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"nameOptions": [{"name": string, "rationale": string, "domain": string}] (exactly 3), "tagline": string, "pitch": string, "valueProp": string, "audience": string, "personality": [string, string, string], "mission": string, "icon": one of ${JSON.stringify(base.iconOptions.concat(LOGO_ICONS.slice(0, 20).map((i) => i.name)).filter((v, i, a) => a.indexOf(v) === i))}, "palette": {"primary": "#RRGGBB", "secondary": "#RRGGBB" (dark shade), "accent": "#RRGGBB"}}`,
      }),
    merge: (raw, base) => {
      const r = obj(raw);
      const merged = conform(
        { nameOptions: base.nameOptions, tagline: base.tagline, pitch: base.pitch, valueProp: base.valueProp, audience: base.audience, personality: base.personality, mission: base.mission },
        r,
      );
      const icon = typeof r.icon === 'string' && LOGO_ICONS.some((i) => i.name === r.icon) ? r.icon : base.icon;
      const pal = obj(r.palette);
      const ok = isHex(String(pal.primary ?? '')) && isHex(String(pal.secondary ?? '')) && isHex(String(pal.accent ?? ''));
      const colors = ok ? paletteFrom([String(pal.primary), String(pal.secondary), String(pal.accent)]) : base.colors;
      return {
        ...base,
        ...merged,
        nameOptions: merged.nameOptions.slice(0, 3),
        icon,
        iconOptions: [icon, ...base.iconOptions.filter((x) => x !== icon)],
        colors,
        paletteOptions: ok ? [colors, ...base.paletteOptions] : base.paletteOptions,
      };
    },
  },
});

// ───────────────────────── Studio ─────────────────────────
export const outlineTask = def<Record<string, never>, OutlineResult>({
  id: 'outline',
  label: 'Product structure & outline',
  module: 'studio',
  tier: 'default',
  stages: ['Mapping the transformation from start to finish…', 'Sequencing modules and quick wins…', 'Adding worksheets and deliverables…'],
  local: (_i, env) => generateOutline(env.project, env.directives, env.variation),
  claude: {
    prompt: (_i, env, base) =>
      framePrompt({
        task: `Draft the ${base.label.toLowerCase()} for this ${FORMATS[env.project.format ?? 'pdf'].label.toLowerCase()}. Sequence it so the buyer gets a quick win early and finishes with the promised outcome. 5–8 sections with 3–5 items each. For each item give a short meta (e.g. "Video · 8 min", "6 pages", "Notion", "Must-have") and a one-sentence detail.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"label": string, "sections": [{"title": string, "summary": string, "items": [{"title": string, "meta": string, "detail": string}]}]}`,
      }),
    merge: (raw, base) => conform(base, obj(raw)),
  },
});

export const sectionDraftTask = def<{ section: OutlineSection }, { markdown: string }>({
  id: 'sectionDraft',
  label: 'Section draft',
  module: 'studio',
  tier: 'default',
  stages: ['Outlining the key points…', 'Writing the draft…', 'Adding action steps…'],
  local: (i, env) => ({ markdown: draftSection(env.project, i.section, env.directives, env.variation) }),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Write the full first draft of this section of the product in Markdown (headings, short paragraphs, bullet lists, action steps). 350–700 words. Practical, specific and in the brand voice.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        input: { section: i.section.title, summary: i.section.summary, items: i.section.items.map((x) => x.title) },
        variation: env.variation,
        shape: `{"markdown": string}`,
      }),
    merge: (raw, base) => conform(base, obj(raw)),
  },
});

export const expandItemTask = def<{ item: OutlineItem; section: OutlineSection }, { detail: string }>({
  id: 'expandItem',
  label: 'Expand outline item',
  module: 'studio',
  tier: 'quick',
  stages: ['Adding talking points…'],
  local: (i, env) => ({ detail: expandItem(env.project, i.item, env.directives, env.variation) }),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: 'Expand this outline item into 2–3 sentences: talking points, a concrete example and the deliverable the buyer gets.',
        project: env.project,
        brainPrompt: env.brainPrompt,
        input: { section: i.section.title, item: i.item.title },
        variation: env.variation,
        shape: `{"detail": string}`,
      }),
    merge: (raw, base) => conform(base, obj(raw)),
  },
});

export const ebookExtrasTask = def<Record<string, never>, EbookExtras>({
  id: 'ebookExtras',
  label: 'Product file: welcome, workbook pages & next steps',
  module: 'studio',
  tier: 'default',
  stages: ['Writing the welcome page…', 'Writing a workbook page for each chapter…', 'Writing the next steps…'],
  local: (_i, env) => localEbookExtras(env.project),
  claude: {
    prompt: (_i, env) =>
      framePrompt({
        task: `The chapters of this ${FORMATS[env.project.format ?? 'pdf'].short.toLowerCase()} are written. Write everything around them for the finished file: the title page (title and one-sentence subtitle), a warm welcome page, how to use it, one workbook page per chapter (questions the reader answers in writing about their own situation, plus an action checklist), the closing words and next steps, and a short disclaimer.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        input: { chapters: env.project.studio.outline.map((s) => ({ title: s.title, summary: s.summary, items: s.items.map((i) => i.title) })) },
        variation: env.variation,
        shape: `{"title": string, "subtitle": string, "welcome": string, "howToUse": [string], "conclusion": string, "nextSteps": [string], "disclaimer": string, "worksheets": [{"title": string, "intro": string, "prompts": [string], "checklist": [string]}]}`,
        extraRules: [
          'welcome: Markdown, 120–200 words, speaking to the buyer. conclusion: Markdown, 100–170 words.',
          'worksheets: exactly one per chapter, in the same order. Each has 2–4 prompts (open questions) and 3–5 checklist actions that start with a verb.',
          'howToUse: 3–4 short tips. nextSteps: 3–5 concrete actions. title at most 70 characters.',
          'disclaimer: one or two sentences that fit this niche (for example: not financial, medical or legal advice). Never promise results.',
        ],
      }),
    merge: (raw, base) => {
      const m = conform(base, obj(raw));
      // exactly one workbook page per chapter, in order
      return { ...m, worksheets: base.worksheets.map((b, i) => (m.worksheets[i]?.prompts?.length ? m.worksheets[i] : b)) };
    },
  },
});

export const workbookTask = def<Record<string, never>, WorkbookSpec>({
  id: 'workbook',
  label: 'Spreadsheet product (.xlsx)',
  module: 'studio',
  tier: 'default',
  stages: ['Planning the tabs from your outline…', 'Designing columns, dropdowns and formulas…', 'Writing example rows and the dashboard…'],
  local: (_i, env) => localWorkbook(env.project),
  claude: {
    prompt: (_i, env) =>
      framePrompt({
        task: `Design the actual spreadsheet the buyer gets: a ready-to-use Excel / Google Sheets workbook for this ${FORMATS[env.project.format ?? 'spreadsheet'].short.toLowerCase()}. Turn the outline into data tabs (one per outline section that holds data; skip "Start here", "Dashboard", summary and overview sections: the app builds the Start here tab and the dashboard from your metrics). Fill each tab with realistic example rows the buyer will overwrite.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        input: { outline: env.project.studio.outline.map((s) => ({ title: s.title, summary: s.summary, items: s.items.map((i) => i.title) })) },
        variation: env.variation,
        shape: `{"title": string, "subtitle": string, "instructions": [string], "sheets": [{"name": string, "purpose": string, "totals": boolean, "columns": [{"name": string, "type": "text"|"longtext"|"number"|"currency"|"percent"|"date"|"choice"|"yesno"|"formula", "options": [string], "formula": string, "format": "number"|"currency"|"percent"|"date"|"text"}], "rows": [{"<column name>": string | number}]}], "metrics": [{"label": string, "op": "sum"|"average"|"count"|"countif"|"sumif"|"min"|"max", "sheet": string, "column": string, "whereColumn": string, "equals": string, "format": "number"|"currency"|"percent"}], "breakdowns": [{"title": string, "sheet": string, "byColumn": string, "valueColumn": string, "op": "sum"|"count"}]}`,
        extraRules: [
          '2–6 sheets, 4–10 columns each, 5–8 example rows each. Sheet names at most 28 characters and unique.',
          'choice columns need 2–12 short options (no commas). yesno columns hold "Yes" or "No". Dates as YYYY-MM-DD in 2026. Percent values as decimals like 0.25.',
          'formula columns calculate per row from other columns on the same sheet. Write the expression with column names in square brackets, e.g. "[Amount]*[Tax rate]" or "IF([Status]=\"Done\",1,0)". Only these functions: IF, IFERROR, AND, OR, NOT, ROUND, MIN, MAX, ABS, SUM, AVERAGE, TODAY, DATEDIF, NETWORKDAYS, EOMONTH, YEAR, MONTH, DAY, TEXT, LEN. Never cell addresses like A2 and never other sheets.',
          'rows: one object per row keyed by column name; leave formula columns out of rows.',
          'metrics (3–8) are the dashboard: op over one column of one sheet; countif counts rows where whereColumn (or column) equals a value; sumif adds column where whereColumn equals a value.',
          'breakdowns (0–2) total a number column (op "sum") or count rows (op "count") for each option of a choice column.',
          'instructions: 3–5 short steps for the buyer. Example rows are clearly sample data, never real people or companies.',
        ],
      }),
    merge: (raw, base) => normalizeWorkbook(raw, base),
  },
});

export const businessModelTask = def<Record<string, never>, BusinessModelResult>({
  id: 'businessModel',
  label: 'Business model & value stack',
  module: 'studio',
  tier: 'default',
  stages: ['Pricing three service tiers…', 'Designing the operating model…', 'Stacking bonuses and the guarantee…'],
  local: (_i, env) => generateBusinessModel(env.project, env.directives, env.variation),
  claude: {
    prompt: (_i, env) =>
      framePrompt({
        task: 'Design the business: three good-better-best service packages with realistic local prices, an operating model (customer journey & booking, delivery standard, team & roles, tools, hours & capacity, revenue streams, cost structure, weekly KPIs) and a value stack (core offer, 3–4 bonuses with perceived values, and a guarantee).',
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"packages": [{"name": string, "price": number, "description": string, "includes": [string], "popular": boolean}] (3), "operating": [{"title": string, "items": [string]}] (8), "valueStack": [{"title": string, "value": number, "description": string}], "price": number (price of the most popular package)}`,
      }),
    merge: (raw, base) => {
      const merged = conform(base, obj(raw));
      merged.valueStack = merged.valueStack.map((v, i, arr) => ({ ...v, kind: i === 0 ? 'core' : i === arr.length - 1 && v.value === 0 ? 'guarantee' : v.kind }));
      return merged;
    },
  },
});

export const listingTask = def<Record<string, never>, ListingDraft>({
  id: 'listing',
  label: 'Store listing copy',
  module: 'store',
  tier: 'quick',
  stages: ['Writing the listing…'],
  local: (_i, env) => generateListing(env.project, env.directives, env.variation),
  claude: {
    prompt: (_i, env) =>
      framePrompt({
        task: 'Write a marketplace listing: a clear title, a one-line tagline, a scannable description (short intro, “What you get” bullets with • and a closing line) and 4–6 lowercase search tags.',
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"title": string, "tagline": string, "description": string, "category": string, "tags": [string]}`,
      }),
    merge: (raw, base) => conform(base, obj(raw)),
  },
});

// ───────────────────────── Code ─────────────────────────
export const codeTask = def<{ kind: CodeKind; prompt: string }, CodeResult>({
  id: 'code',
  label: 'Code & asset generator',
  module: 'code',
  tier: 'default',
  stages: ['Planning the component…', 'Writing HTML structure…', 'Styling with your brand colors…', 'Wiring up the interactivity…'],
  local: (i, env) => generateCode(env.project, i.kind, i.prompt, env.directives, env.variation),
  claude: {
    prompt: (i, env) => {
      const c = env.project.brand.colors;
      return framePrompt({
        task: `Build a production-quality ${codeKindLabel(i.kind)} for this ${env.project.track}. Request from the user: “${i.prompt || 'Use your best judgment for this niche.'}”. It must work standalone: vanilla HTML/CSS/JS only, no external libraries, fonts, images or network calls; accessible labels and keyboard support; responsive down to 360px; brand colors primary ${c.primary}, accent ${c.accent}, ink ${c.ink}, background ${c.paper}. Use realistic content for this niche (no lorem ipsum).${i.kind === 'spreadsheet' ? ' Also write a Google Apps Script that automates the sheet (menu, onEdit, summary builder) and render a realistic preview table in the HTML.' : ''}`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"name": string, "html": string (body markup only: no html, head, body, style or script tags), "css": string, "js": string (plain JavaScript that runs after the markup)${i.kind === 'spreadsheet' ? ', "script": string (Google Apps Script)' : ''}}`,
        extraRules: ['Return complete, working code, not fragments.'],
      });
    },
    merge: (raw, base) => {
      const merged = conform(base, obj(raw));
      const strip = (s: string) => s.replace(/<\/?(html|head|body)[^>]*>/gi, '');
      return { ...merged, html: strip(merged.html) };
    },
  },
});

export const codeEditTask = def<{ code: { html: string; css: string; js: string }; instruction: string }, { html: string; css: string; js: string; applied: string[] }>({
  id: 'codeEdit',
  label: 'Modify code',
  module: 'code',
  tier: 'default',
  stages: ['Reading your change request…', 'Editing the code…'],
  local: (i) => modifyCode(i.code, i.instruction),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Apply this change to the widget and return the complete updated code: “${i.instruction}”. Keep everything else working.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        input: i.code,
        shape: `{"html": string, "css": string, "js": string, "summary": string (one sentence describing the change)}`,
      }),
    merge: (raw, base) => {
      const r = obj(raw);
      const merged = conform({ html: base.html, css: base.css, js: base.js }, r);
      return { ...merged, applied: [typeof r.summary === 'string' ? r.summary : 'Updated by Claude'] };
    },
  },
});

// ───────────────────────── Email ─────────────────────────
export const leadMagnetTask = def<{ type: LeadMagnetType }, LeadMagnet>({
  id: 'leadMagnet',
  label: 'Lead magnet',
  module: 'email',
  tier: 'default',
  stages: ['Choosing the highest-value quick win…', 'Writing the freebie…', 'Crafting the opt-in…'],
  local: (i, env) => generateLeadMagnet(env.project, i.type, env.directives, env.variation),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Create a free lead magnet (${i.type}) that attracts the ideal buyer of this offer and naturally leads to the paid product. Include 3–7 sections with concrete items, an opt-in headline, three benefit bullets and a button label.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"title": string, "subtitle": string, "intro": string, "sections": [{"heading": string, "items": [string]}], "cta": string, "optInHeadline": string, "optInBullets": [string, string, string], "buttonLabel": string}`,
      }),
    merge: (raw, base) => conform(base, obj(raw)),
  },
});

export const emailSequenceTask = def<{ leadMagnet: LeadMagnet | null }, EmailStep[]>({
  id: 'emailSequence',
  label: '5-part email sequence',
  module: 'email',
  tier: 'default',
  stages: ['Mapping the nurture arc…', 'Writing subject lines that get opened…', 'Drafting all five emails…', 'Building the final pitch…'],
  local: (i, env) => generateEmailSequence(env.project, i.leadMagnet, env.directives, env.variation),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Write a 5-email automated nurture sequence sent to everyone who claims the free lead magnet “${i.leadMagnet?.title ?? 'free guide'}”. Email 1: instant delivery of the freebie + warm welcome. Email 2: high-value educational insight and a quick win. Email 3: common mistake / myth-busting with an illustrative example (clearly hypothetical, not a fake client result). Email 4: overcome the top objections + soft teaser of the paid offer. Email 5: direct pitch for the paid product/business with urgency and a clear CTA.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `[{"purpose": string, "subject": string (max 50 chars), "preview": string (max 90 chars), "body": string (plain text, paragraphs separated by \\n\\n), "ctaLabel": string}] (exactly 5)`,
        extraRules: ['Use these merge tags exactly where relevant: {{first_name}}, {{lead_magnet_link}} (email 1–2), {{product_link}} (emails 3–5). Sign off as the brand.'],
      }),
    merge: (raw, base) => {
      const arr = Array.isArray(raw) ? raw : (obj(raw).emails as unknown[]) ?? [];
      return conform(base, arr.slice(0, 5));
    },
  },
});

// ───────────────────────── SEO ─────────────────────────
export const seoMetaTask = def<Record<string, never>, SeoMeta>({
  id: 'seoMeta',
  label: 'SEO metadata',
  module: 'seo',
  tier: 'quick',
  stages: ['Researching keywords…', 'Writing meta tags…'],
  local: (_i, env) => generateSeoMeta(env.project, env.directives, env.variation),
  claude: {
    prompt: (_i, env, base) =>
      framePrompt({
        task: `Write SEO metadata for the sales page. Choose the best primary keyword (buyer intent${env.project.track === 'business' ? ', local' : ''}), 4–6 secondary keywords, a meta title of 50–60 characters containing the primary keyword, a meta description of 140–158 characters containing it, a short URL slug, OpenGraph title/description and image alt text. Current best guess for the primary keyword: “${base.primaryKeyword}”.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"metaTitle": string, "metaDescription": string, "slug": string, "primaryKeyword": string, "secondaryKeywords": [string], "ogTitle": string, "ogDescription": string, "ogImageAlt": string}`,
      }),
    merge: (raw, base) => {
      const m = conform(base, obj(raw));
      return { ...m, slug: m.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, ''), canonical: base.canonical.replace(base.slug, m.slug) };
    },
  },
});

const SALES_SHAPE = `{"hero": {"eyebrow": string, "headline": string, "subheadline": string, "ctaLabel": string, "ctaSubtext": string, "bullets": [string, string, string]}, "problem": {"heading": string, "intro": string, "points": [{"title": string, "body": string}] (3), "agitation": string}, "solution": {"heading": string, "intro": string, "features": [{"title": string, "body": string}] (4-6)}, "proof": {"heading": string, "stats": [{"value": string, "label": string}] (3), "testimonials": [{"quote": string, "name": string, "role": string, "rating": number}] (3)}, "pricing": {"heading": string, "planName": string, "price": number, "compareAt": number, "priceNote": string, "includes": [string], "ctaLabel": string, "badge": string}, "faq": {"heading": string, "items": [{"q": string, "a": string}] (5)}, "guarantee": {"heading": string, "body": string, "days": number, "finalHeading": string, "finalCta": string}}`;

export const salesPageTask = def<{ primaryKeyword?: string }, SalesPage>({
  id: 'salesPage',
  label: 'SEO sales page',
  module: 'seo',
  tier: 'default',
  stages: ['Writing a hook that matches search intent…', 'Agitating the problem…', 'Structuring features, proof and pricing…', 'Answering objections in the FAQ…'],
  local: (_i, env) => generateSalesPage(env.project, env.directives, env.variation),
  claude: {
    prompt: (i, env) => {
      const kw = i.primaryKeyword || primaryKeywordFor(buildFacts(env.project));
      return framePrompt({
        task: `Write a conversion-optimized, SEO-ready one-page sales page. Primary keyword: “${kw}” — use it in the hero headline and subheadline naturally and 2–4 more times on the page. Sections: hero with hook & CTA, problem/agitation, solution & features, social proof, pricing card, FAQ (5 questions) and final guarantee with CTA.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: SALES_SHAPE,
        extraRules: ['Stats must describe the offer itself (number of modules, delivery time, guarantee length), never invented results.', 'Testimonials are examples the owner will replace with real quotes: keep them modest and believable.'],
      });
    },
    merge: (raw, base) => {
      const r = obj(raw);
      return {
        ...base,
        sections: base.sections.map((s) => (r[s.type] ? ({ ...s, data: conform(s.data as never, r[s.type]) } as SalesSection) : s)),
      };
    },
  },
});

export const salesSectionTask = def<{ type: SalesSectionType }, SalesSection>({
  id: 'salesSection',
  label: 'Sales page section',
  module: 'seo',
  tier: 'quick',
  stages: ['Rewriting the section…'],
  local: (i, env) => generateSalesSection(env.project, i.type, env.directives, env.variation),
  claude: {
    prompt: (i, env, base) =>
      framePrompt({
        task: `Rewrite the “${i.type}” section of the sales page with a fresh angle.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        input: { current: base.data },
        shape: `the same JSON object shape as INPUT.current`,
      }),
    merge: (raw, base) => ({ ...base, data: conform(base.data as never, obj(raw)) }) as SalesSection,
  },
});

// ───────────────────────── Social ─────────────────────────
export const campaignPlanTask = def<{ config: CampaignConfig }, CampaignPlan>({
  id: 'campaignPlan',
  label: '30-day campaign plan',
  module: 'social',
  tier: 'default',
  stages: ['Mapping your posting cadence…', 'Balancing formats, styles and post types…', 'Sequencing awareness → authority → trust → conversion…', 'Writing weekly themes and KPIs…'],
  local: (i, env) => generateCampaignPlan(env.project, i.config, env.directives, env.variation),
  claude: {
    prompt: (i, env, base) =>
      framePrompt({
        task: `Improve this 30-day social media campaign plan. Keep every slot (date, platform, format, style, post type are fixed) but write a specific, scroll-stopping topic for each slot that fits its post type and the week’s phase. Also write the campaign strategy (3 sentences) and five weekly themes with goal, KPI and key message.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        input: {
          goal: i.config.goal,
          slots: base.days.flatMap((d) => d.slots.map((s) => ({ slotId: s.id, date: d.date, phase: d.phase, platform: s.platform, format: s.format, postType: s.postType, topic: s.topic }))).slice(0, 150),
        },
        shape: `{"strategy": string, "weeks": [{"week": number, "theme": string, "goal": string, "kpi": string, "keyMessage": string}] (5), "topics": [{"slotId": string, "topic": string}]}`,
      }),
    merge: (raw, base) => {
      const r = obj(raw);
      const topics = new Map<string, string>();
      if (Array.isArray(r.topics)) for (const t of r.topics) if (t && typeof t === 'object' && typeof (t as { slotId?: unknown }).slotId === 'string' && typeof (t as { topic?: unknown }).topic === 'string') topics.set((t as { slotId: string }).slotId, (t as { topic: string }).topic);
      return {
        ...base,
        strategy: typeof r.strategy === 'string' && r.strategy.trim() ? r.strategy : base.strategy,
        weeks: conform(base.weeks, r.weeks),
        days: base.days.map((d) => ({ ...d, slots: d.slots.map((s) => ({ ...s, topic: topics.get(s.id) ?? s.topic })) })),
      };
    },
  },
});

export const contentBatchTask = def<{ plan: CampaignPlan; config: CampaignConfig; days?: number }, Post[]>({
  id: 'contentBatch',
  label: '7-day content batch',
  module: 'social',
  tier: 'default',
  stages: ['Writing hooks for each slot…', 'Drafting captions and CTAs…', 'Choosing hashtags per platform…', 'Storyboarding the videos…', 'Rendering visual mockups…'],
  local: (i, env) => generateContentBatch(env.project, i.plan, i.config, env.directives, env.variation, i.days ?? 7),
  claude: {
    prompt: (_i, env, base) =>
      framePrompt({
        task: `Write ready-to-publish social posts for each slot below (the next 7 days of the campaign). Each needs: an on-image headline (max 60 chars), a caption with a hook first line, a value body and a clear call to action (respect each platform: X under 260 characters; Instagram/TikTok say “link in bio” instead of URLs), platform-appropriate hashtags, a detailed visual prompt in the slot’s style, and for video slots a 4-scene storyboard (on-screen text, shot, seconds).`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        input: {
          website: env.project.brand.websiteUrl,
          slots: base.map((p) => ({ slotId: p.planSlotId, when: p.scheduledAt.slice(0, 16), platform: p.platform, format: p.format, style: p.style, postType: p.postType, topic: p.headline })),
        },
        shape: `{"posts": [{"slotId": string, "headline": string, "caption": string, "hashtags": [string], "visualPrompt": string, "storyboard": [{"text": string, "shot": string, "duration": number}] (video slots only)}]}`,
      }),
    merge: (raw, base) => {
      const r = obj(raw);
      const list = Array.isArray(r.posts) ? (r.posts as Record<string, unknown>[]) : [];
      const byId = new Map(list.filter((x) => x && typeof x.slotId === 'string').map((x) => [x.slotId as string, x]));
      return base.map((p) => {
        const x = byId.get(p.planSlotId ?? '');
        if (!x) return p;
        const merged = conform({ headline: p.headline, caption: p.caption, hashtags: p.hashtags, visualPrompt: p.visualPrompt }, x);
        const sb: Scene[] | undefined = p.storyboard && Array.isArray(x.storyboard) ? conform(p.storyboard, x.storyboard) : p.storyboard;
        return { ...p, ...merged, hashtags: merged.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)), storyboard: sb };
      });
    },
  },
});

export const postTask = def<ComposeInput & { media?: MediaRef }, ComposedPost>({
  id: 'post',
  label: 'Post caption & visual',
  module: 'social',
  tier: 'quick',
  stages: ['Finding the hook…', 'Writing the caption…', 'Picking hashtags…'],
  local: (i, env) => composePost(env.project, i, env.directives, `${env.variation}|${Date.now() >> 16}`),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Write one ready-to-publish ${i.platform} post (${i.format}, post type: ${i.postType}). ${i.media ? `The user is posting their own ${i.media.kind}${i.mediaDescription ? ` described as “${i.mediaDescription}”` : ''}${i.media.kind === 'image' || i.media.kind === 'video' ? '; an image of it is attached, so describe what is actually shown' : ''}.` : `Topic: “${i.topic}”.`} Caption = hook first line, value body, clear CTA. Respect the platform (X under 260 characters; Instagram/TikTok say “link in bio”).`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        input: { topic: i.topic, platform: i.platform, postType: i.postType, format: i.format, style: i.style },
        shape: `{"headline": string (on-image text, max 60 chars), "caption": string, "hashtags": [string], "visualPrompt": string${i.format === 'video' ? ', "storyboard": [{"text": string, "shot": string, "duration": number}] (4)' : ''}}`,
      }),
    merge: (raw, base) => {
      const m = conform(base, obj(raw));
      return { ...m, hashtags: m.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)) };
    },
    images: async (i) => {
      if (!i.media) return undefined;
      const blob = await getBlob(i.media.id);
      if (!blob) return undefined;
      if (i.media.kind === 'image') return [blob];
      const frame = await videoFrame(blob, 1, 900);
      return frame.blob ? [frame.blob] : undefined;
    },
  },
});

// ───────────────────────── Images (Claude-drawn illustrations) ─────────────────────────
export interface IllustrationInput {
  /** what to depict (no text) */
  subject: string;
  aspect: ImageAspect;
  /** built-in scene used when Claude isn't available */
  scene: ArtScene;
  seed: number;
  /** where headline text will be overlaid, so the drawing leaves room */
  textArea: 'bottom' | 'none' | 'center';
  styleHint?: string;
}
export interface IllustrationOutput {
  svg: string;
  drawnBy: 'claude' | 'builtin';
}

const illustrationDef = (id: string, label: string, module: 'social' | 'studio') =>
  def<IllustrationInput, IllustrationOutput>({
    id,
    label,
    module,
    tier: 'default',
    stages: ['Sketching the composition…', 'Laying in brand colors…', 'Adding depth and light…'],
    local: (i, env) => ({ svg: proceduralSvg(env.project.brand.colors, { aspect: i.aspect, scene: i.scene, seed: i.seed }), drawnBy: 'builtin' }),
    claude: {
      prompt: (i, env) => {
        const [w, h] = ART_SIZE[i.aspect];
        const c = env.project.brand.colors;
        return framePrompt({
          task: `Draw one polished, professional vector illustration as a single SVG document. Subject: ${i.subject}. ${i.styleHint ? `Look: ${i.styleHint}. ` : ''}Use the brand palette (primary ${c.primary}, secondary ${c.secondary}, accent ${c.accent}, ink ${c.ink}, paper ${c.paper}) with tints and shades of it. Fill the whole canvas edge to edge with a background, build a clear focal subject with depth (overlapping layers, soft low-opacity shadows, gradients and highlights) and a modern editorial flat-illustration finish. ${i.textArea === 'bottom' ? 'Keep the bottom 35% calm and uncluttered (darker or simple) because a headline is overlaid there.' : i.textArea === 'center' ? 'Keep the center calm and uncluttered because a text panel is overlaid there; put interest toward the edges.' : 'Center the subject; no text is overlaid.'}`,
          project: env.project,
          brainPrompt: env.brainPrompt,
          variation: env.variation,
          shape: `{"svg": string (the complete <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">…</svg> markup)}`,
          extraRules: [
            `The root element must be <svg> with viewBox="0 0 ${w} ${h}" exactly.`,
            'Absolutely no text, letters, numbers, words, logos or watermarks anywhere in the drawing.',
            'Allowed elements only: svg, g, defs, path, rect, circle, ellipse, line, polyline, polygon, linearGradient, radialGradient, stop, clipPath, mask, filter (feGaussianBlur, feOffset, feBlend, feMerge, feDropShadow), use. Reference definitions only by #id.',
            'No <text>, <image>, <foreignObject>, <style>, <script>, CSS classes, animation or external links. Use presentation attributes (fill, stroke, opacity…), not style sheets.',
            'Keep it compact: at most about 220 elements and 24 KB of markup. Round coordinates to whole numbers.',
          ],
        });
      },
      merge: (raw, base) => {
        const r = obj(raw);
        const clean = sanitizeSvg(typeof r.svg === 'string' ? r.svg : typeof raw === 'string' ? raw : '');
        return clean ? { svg: clean.svg, drawnBy: 'claude' } : base;
      },
    },
  });

export const postIllustrationTask = illustrationDef('postImage', 'Post image', 'social');
export const listingIllustrationTask = illustrationDef('listingImage', 'Listing image', 'studio');

// ───────────────────────── Ads ─────────────────────────
export const adsTask = def<{ campaign: AdCampaign }, AdsResult>({
  id: 'ads',
  label: 'Paid ads campaign',
  module: 'ads',
  tier: 'default',
  stages: ['Defining audiences and interests…', 'Writing three creative angles…', 'Building search ads…', 'Projecting reach, CPC and ROAS…'],
  local: (i, env) => generateAds(env.project, i.campaign, env.directives, env.variation),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Plan a paid ads campaign. Objective: ${i.campaign.objective}. Platforms: ${i.campaign.platforms.join(', ')}. Budget: $${i.campaign.dailyBudget}/day for ${i.campaign.durationDays} days. Location: ${i.campaign.locations}${i.campaign.radiusMi ? ` (+${i.campaign.radiusMi} mi)` : ''}, ages ${i.campaign.ageMin}–${i.campaign.ageMax}. Write targeting interests, three audience sets, three creative variants (A/B/C, each a different angle; primary text ≤125 chars, headline ≤40, description ≤30)${i.campaign.platforms.includes('google') ? ', and responsive search ads (headlines ≤30 chars, descriptions ≤90 chars, keywords with match types, 4 sitelinks)' : ''}.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"interests": [string], "audiences": [{"name": string, "description": string, "size": string, "interests": [string]}] (3), "creatives": [{"variant": string, "angle": string, "primaryText": string, "headline": string, "description": string, "cta": string, "visualHeadline": string}] (3)${i.campaign.platforms.includes('google') ? ', "search": {"headlines": [string], "descriptions": [string], "keywords": [string], "sitelinks": [{"title": string, "desc": string}]}' : ''}}`,
      }),
    merge: (raw, base) => {
      const r = obj(raw);
      return {
        ...base,
        interests: conform(base.interests.length ? base.interests : ['x'], r.interests).filter(Boolean),
        audiences: conform(base.audiences, r.audiences),
        creatives: conform(base.creatives, r.creatives),
        search: base.search ? conform(base.search, r.search) : null,
      };
    },
  },
});

// ───────────────────────── Brain playground ─────────────────────────
export const skillTestTask = def<{ sample: 'caption' | 'email' | 'headline' | 'ad' }, { text: string }>({
  id: 'skillTest',
  label: 'Brain playground',
  module: 'all',
  tier: 'quick',
  stages: ['Applying Brain skills…', 'Writing a sample…'],
  local: (i, env) => {
    const p = env.project;
    if (i.sample === 'caption') {
      const c = composePost(p, { topic: buildFacts(p).quickWins[0], postType: 'tip', platform: 'instagram', format: 'image', style: 'minimal' }, env.directives, 'playground' + env.variation);
      return { text: `${c.caption}\n\n${c.hashtags.join(' ')}` };
    }
    if (i.sample === 'email') {
      const seq = generateEmailSequence(p, p.marketing.leadMagnet, env.directives, env.variation);
      return { text: `Subject: ${seq[4].subject}\n\n${seq[4].body}` };
    }
    if (i.sample === 'ad') {
      const c = composePost(p, { topic: `Introducing ${buildFacts(p).productShort}`, postType: 'sales', platform: 'facebook', format: 'image', style: 'minimal' }, env.directives, 'pg-ad' + env.variation);
      return { text: c.caption };
    }
    const meta = generateSeoMeta(p, env.directives, env.variation);
    return { text: `${meta.metaTitle}\n\n${meta.metaDescription}` };
  },
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Write one sample ${i.sample === 'caption' ? 'Instagram caption (with hashtags)' : i.sample === 'email' ? 'sales email (subject line + body)' : i.sample === 'ad' ? 'Facebook ad (primary text)' : 'pair of SEO meta title + description'} for this project so the owner can see how the Brain skills shape the output.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"text": string}`,
      }),
    merge: (raw, base) => conform(base, obj(raw)),
  },
});

export type AnyTask = TaskDef<never, unknown>;
