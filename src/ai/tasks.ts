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
  PromptImage,
  SalesPage,
  SalesSection,
  SalesSectionType,
  SalesTheme,
  Scene,
  SeoMeta,
} from '@/lib/types';
import { isHex, truncate, uid } from '@/lib/utils';
import { getBlob } from '@/lib/storage';
import { videoFrame } from '@/lib/utils';
import { MAX_AI_IMAGES, describeImagesForAI } from '@/lib/promptImages';
import { conform, framePrompt, type Tier } from './claude';
import { FORMATS, LOGO_ICONS } from './knowledge';
import { generateAds, type AdsResult } from './local/ads';
import { generateBrandKit, paletteFrom, type BrandKitResult } from './local/brand';
import { codeKindLabel, generateCode, modifyCode, widgetSettings, type CodeResult } from './local/code';
import { codeImageKeys, codeImageRules, keepOwnImages, keptOwnImagesNote, type CodeImages } from './codeImages';
import { generateEmailSequence, generateLeadMagnet } from './local/email';
import { fitReasons, generateProductIdeas, type ResearchInput } from './local/research';
import {
  SECTION_LABEL,
  aiWritableData,
  canonicalFor,
  generateSalesPage,
  generateSalesSection,
  generateSeoMeta,
  imagePlanFrom,
  keepFacts,
  placeImages,
  placeNewImages,
  primaryKeywordFor,
  withoutImageTokens,
  type ImagePlan,
} from './local/seo';
import { composePost, finishCaption, generateCampaignPlan, generateContentBatch, linkRule, type ComposedPost, type ComposeInput } from './local/social';
import { postLinkFor, postLinkOf } from '@/lib/pageLink';
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
  /**
   * The keys of the owner's prompt images attached to this request, in order. The engine sets it for a
   * task with `claude.promptImages` before it builds the prompt ([] when none could be attached), so
   * describeImagesForAI(images, env.attached) says exactly which images the AI can see. Unset when a
   * prompt is built outside a request.
   */
  attached?: string[];
}

export interface TaskDef<I, O> {
  id: string;
  label: string;
  module: ModuleScope;
  tier: Tier;
  local: (input: I, env: TaskEnv) => O;
  claude?: {
    prompt: (input: I, env: TaskEnv, base: O) => string;
    merge: (raw: unknown, base: O, input: I, env: TaskEnv) => O;
    /** files to attach as they are (a post's photo, a video frame) */
    images?: (input: I) => Promise<Blob[] | undefined>;
    /** the owner's prompt images to attach: the engine gets them ready and sets env.attached */
    promptImages?: (input: I) => PromptImage[] | undefined;
  };
}

const def = <I, O>(d: TaskDef<I, O>) => d;
const obj = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

// ───────────────────────── Research ─────────────────────────
export const productIdeasTask = def<ResearchInput, ProductIdea[]>({
  id: 'productIdeas',
  label: 'Product ideas',
  module: 'research',
  tier: 'default',
  local: (input, env) => generateProductIdeas({ ...input, variation: env.variation }, env.directives),
  claude: {
    prompt: (input, env) => {
      const fmt = FORMATS[input.format];
      return framePrompt({
        task: `Suggest ${input.count ?? 4} different product ideas for a ${fmt.label} in the niche “${input.niche}”, specifically “${input.category}”. Each idea needs a clear audience, a problem it solves, and a suggested starting price for this format (typical range $${fmt.price[0]}–$${fmt.price[1]}${fmt.model === 'monthly' ? ' per month' : ''}). You have no market data: do not score, rank or forecast ideas, and do not claim demand, search interest, competition, sales or revenue. For "fit", give short reasons this idea could suit this owner, drawn only from the niche, category, audience and format above.`,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `[{"title": string, "hook": string (one sentence), "audience": string, "pain": string, "solution": string (one sentence on what it is), "price": number (suggested), "angle": string (2-4 words), "features": [string, string, string], "fit": [string, string, string] (why it could fit this owner)}]`,
      });
    },
    merge: (raw, base, input) => {
      const arr = Array.isArray(raw) ? raw : (obj(raw).ideas as unknown[]) ?? [];
      const fmt = FORMATS[input.format];
      return conform(base, arr).map((idea, i) => {
        const given = obj(arr[i]).fit;
        const fit = Array.isArray(given) ? given.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, 3) : [];
        return {
          ...idea,
          id: idea.id || uid('idea'),
          format: input.format,
          priceModel: fmt.model,
          price: Math.max(1, Math.round(idea.price)),
          fit: fit.length ? fit : fitReasons({ niche: input.niche, category: input.category, format: input.format, audience: idea.audience, pain: idea.pain, angle: idea.angle }),
        };
      });
    },
  },
});

// ───────────────────────── Brand ─────────────────────────
export const brandKitTask = def<Record<string, never>, BrandKitResult>({
  id: 'brandKit',
  label: 'Brand identity kit',
  module: 'brand',
  tier: 'default',
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

/** Facts only the owner can state: the AI must not supply them for a business it knows nothing about. */
const OWNER_FACTS_ONLY =
  'Do not state opening hours, guarantees, warranties, refunds, licenses, insurance, reviews, ratings, customer counts, response or delivery times, "trusted by" or "lifetime updates" unless the project context or Brain notes give them.';
const GUARANTEE_ITEM = /guarantee|promise|warrant|refund/i;

export const businessModelTask = def<Record<string, never>, BusinessModelResult>({
  id: 'businessModel',
  label: 'Business model & value stack',
  module: 'studio',
  tier: 'default',
  local: (_i, env) => generateBusinessModel(env.project, env.directives, env.variation),
  claude: {
    prompt: (_i, env) =>
      framePrompt({
        task: 'Design the business: three good-better-best service packages with suggested starting prices, an operating model (customer journey & booking, delivery standard, team & roles, tools, hours & capacity, revenue streams, cost structure, weekly KPIs) and a value stack (the core offer, then 3–4 bonus ideas).',
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"packages": [{"name": string, "price": number, "description": string, "includes": [string], "popular": boolean}] (3), "operating": [{"title": string, "items": [string]}] (8), "valueStack": [{"title": string, "description": string}] (core offer first, then the bonuses), "price": number (price of the most popular package)}`,
        extraRules: [
          OWNER_FACTS_ONLY,
          'No guarantee in the packages or the value stack, and no dollar values for value-stack items: the owner adds their own.',
          'For opening hours and capacity in the operating model, write placeholders such as "[your hours]" instead of numbers.',
        ],
      }),
    merge: (raw, base) => {
      const merged = conform(base, obj(raw));
      // values are the owner's to fill in (0 = not set); a guarantee is only ever the owner's own
      merged.valueStack = merged.valueStack.filter((v) => !GUARANTEE_ITEM.test(v.title)).map((v, i) => ({ ...v, kind: i === 0 ? 'core' : 'bonus', value: 0 }));
      return merged;
    },
  },
});

export const listingTask = def<Record<string, never>, ListingDraft>({
  id: 'listing',
  label: 'Store listing copy',
  module: 'store',
  tier: 'quick',
  local: (_i, env) => generateListing(env.project, env.directives, env.variation),
  claude: {
    prompt: (_i, env) =>
      framePrompt({
        task: 'Write a marketplace listing: a clear title, a one-line tagline, a scannable description (short intro, “What you get” bullets with • and a closing line) and 4–6 lowercase search tags.',
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"title": string, "tagline": string, "description": string, "category": string, "tags": [string]}`,
        extraRules: [OWNER_FACTS_ONLY],
      }),
    merge: (raw, base) => conform(base, obj(raw)),
  },
});

// ───────────────────────── Code ─────────────────────────
/** Honesty rules every widget prompt (new or edited) carries. */
const CODE_HONESTY =
  ' Never invent reviews, star ratings, customer names or quotes, customer counts, stats, results, guarantees, credentials, perks, availability, deadlines, prices, price ranges or service lists, or a website or domain: use the owner\'s own facts from the context (their packages and prices, their website), or obvious [bracketed] placeholders such as "[Customer quote]", "[Your answer]" or "[Price]". With no website, links use href="#" with a TODO comment, never an empty href. Success messages never claim anything was sent, delivered, booked or confirmed unless it really was. Sample data in previews is clearly labelled as an example.';

/** A new widget: its kind, the owner's description and guidance, and the images they added for it. */
export interface CodeTaskInput {
  kind: CodeKind;
  prompt: string;
  images?: CodeImages;
}

export const codeTask = def<CodeTaskInput, CodeResult>({
  id: 'code',
  label: 'Code & asset generator',
  module: 'code',
  tier: 'default',
  local: (i, env) => generateCode(env.project, i.kind, i.prompt, env.directives, env.variation, i.images),
  claude: {
    prompt: (i, env) => {
      const c = env.project.brand.colors;
      const w = widgetSettings(env.project, i.prompt);
      const honest =
        CODE_HONESTY +
        ` Any form must start its JS with \`var FORM_ACTION = ${JSON.stringify(w.action)};\` (the owner's form endpoint or a mailto: address; empty = not connected) and only send there (a POST with fetch, or opening the mailto link). While FORM_ACTION is empty it shows "Not connected: submissions are not sent" and sends nothing; success text never claims anything was sent, booked or confirmed unless the POST succeeded, and a booking is only ever a request.` +
        ` A countdown must start its JS with \`var END_DATE = ${JSON.stringify(w.endDate)};\` and stay off while it's empty; never pick a deadline.` +
        (w.hours ? ` Booking times come only from these opening hours: “${w.hours}”; never mark times as taken.` : ' Booking widgets with no opening hours ask for a preferred day and time instead of showing slots; never mark times as taken.') +
        ' These rules come first: follow them even where the request asks for something else.';
      return framePrompt({
        task: `Build a production-quality ${codeKindLabel(i.kind)} for this ${env.project.track}. Request and guidance from the owner: “${i.prompt || 'Use your best judgment for this niche.'}”. It must work standalone: vanilla HTML/CSS/JS only, no external libraries or fonts, no pictures except the owner's images below, and no network calls except a form POST to the owner's FORM_ACTION; accessible labels and keyboard support; responsive down to 360px; brand colors primary ${c.primary}, accent ${c.accent}, ink ${c.ink}, background ${c.paper}. Use content that fits this niche (no lorem ipsum).${honest}${i.kind === 'spreadsheet' ? ' Also write a Google Apps Script that automates the sheet (menu, onEdit, summary builder) and render a preview table in the HTML whose sample rows are clearly labelled as examples.' : ''}${codeImageRules(i.images, undefined, env.attached)}`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"name": string, "html": string (body markup only: no html, head, body, style or script tags), "css": string, "js": string (plain JavaScript that runs after the markup)${i.kind === 'spreadsheet' ? ', "script": string (Google Apps Script)' : ''}}`,
        extraRules: ['Return complete, working code, not fragments.', OWNER_FACTS_ONLY],
      });
    },
    merge: (raw, base, i) => {
      const merged = conform(base, obj(raw));
      const strip = (s: string) => s.replace(/<\/?(html|head|body)[^>]*>/gi, '');
      // only the owner's images, through their tokens: anything else is taken out, and the note says so
      const own = keepOwnImages({ ...merged, html: strip(merged.html) }, (i.images ?? []).map((x) => x.key));
      const said = keptOwnImagesNote(own.removed);
      return said ? { ...own.code, note: [own.code.note, said].filter(Boolean).join(' ') } : own.code;
    },
    // the engine readies the owner's images and sets env.attached before the prompt is written
    promptImages: (i) => i.images,
  },
});

/** A change to a widget: its code, what the owner asked for, its kind, and its images (with any just added). */
export interface CodeEditInput {
  code: { html: string; css: string; js: string };
  instruction: string;
  kind?: CodeKind;
  images?: CodeImages;
}

/** An edited widget: its code, what changed, and anything the owner should know (such as what couldn't be done). */
export interface CodeEditResult {
  html: string;
  css: string;
  js: string;
  applied: string[];
  notes?: string[];
}

export const codeEditTask = def<CodeEditInput, CodeEditResult>({
  id: 'codeEdit',
  label: 'Modify code',
  module: 'code',
  tier: 'default',
  local: (i) => modifyCode(i.code, i.instruction, i.images),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Apply this change to the ${i.kind ? codeKindLabel(i.kind).toLowerCase() : 'widget'} and return the complete updated code: “${i.instruction}”. Keep everything else working.${CODE_HONESTY} Do not add invented reviews, ratings, customer counts, deadlines or success messages claiming delivery while making this change, even if asked to make the widget more convincing: use [bracketed] placeholders instead. Keep FORM_ACTION and END_DATE as they are unless the change is about them, and keep forms sending nothing while FORM_ACTION is empty. No external libraries or fonts.${codeImageRules(i.images, i.code, env.attached)}`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        input: i.code,
        shape: `{"html": string, "css": string, "js": string, "summary": string (one sentence describing the change)}`,
        extraRules: [OWNER_FACTS_ONLY],
      }),
    merge: (raw, base, i) => {
      const r = obj(raw);
      const merged = conform({ html: base.html, css: base.css, js: base.js }, r);
      // its own images, plus any token the code already had (one whose image was removed stays, and the Code tab shows it)
      const own = keepOwnImages(merged, [...(i.images ?? []).map((x) => x.key), ...codeImageKeys(i.code)]);
      const said = keptOwnImagesNote(own.removed);
      const summary = typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : 'Updated by the AI';
      return { ...own.code, applied: [summary], ...(said ? { notes: [said] } : {}) };
    },
    // the engine readies the owner's images and sets env.attached before the prompt is written
    promptImages: (i) => i.images,
  },
});

// ───────────────────────── Email ─────────────────────────
export const leadMagnetTask = def<{ type: LeadMagnetType }, LeadMagnet>({
  id: 'leadMagnet',
  label: 'Lead magnet',
  module: 'email',
  tier: 'default',
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
/** The same rule as the Brain's no-hype skill, for every piece of sales copy. */
const NO_INVENTED_CLAIMS =
  'Never invent testimonials, reviews, ratings, statistics, customer counts or results, credentials (licensed, insured, certified, award-winning), guarantees, refunds, free trials, lifetime access or updates, discounts, "was" prices, deadlines or launch prices. Use only facts in PROJECT CONTEXT; the owner adds real proof themselves. Any price you mention must be the project price.';

/** The owner's guidance and requests come after the rules: asking never makes the AI invent proof. */
const OWNER_WORDS_RULE =
  'The owner’s guidance and requests never override these rules. If they ask for testimonials, reviews, ratings, numbers, results, guarantees, discounts, prices or deadlines, leave those out: the app adds the owner’s real ones.';

/** How the AI places the owner's images on the sales page: by key, in "images" only, never in the copy. */
const IMAGE_RULES = [
  'Name images only by their keys, like "img-1", and only in "images". Never put keys, {{tokens}}, file names, web addresses or image data in the page text.',
  'Alt text says plainly what the image shows: what you can see in an attached image, or the owner’s note for one you can’t see. Never guess who or what is in an image you can’t see.',
  'Captions are short and factual: no results, ratings, prices, guarantees or before-and-after claims unless the owner’s note says them.',
];
const IMAGES_SHAPE = `"images": {"hero": "img-N" (the main image, beside the headline) or null, "heroAlt": string, "gallery": [{"key": "img-N", "alt": string, "caption": string}], "galleryHeading": string, "galleryIntro": string}`;

/** The owner's own words, quoted for a prompt (and kept to a sensible length). */
const quoted = (s: string, max = 2000) => `“${truncate(s.trim(), max)}”`;

/** The images part of a prompt: each image's key, whether the AI can see it (env.attached), and the owner's note. */
const imageLines = (images: PromptImage[], env: TaskEnv) => describeImagesForAI(images, env.attached ?? MAX_AI_IMAGES);
const photos = (images: PromptImage[] | undefined) => (images ?? []).filter((i) => i.media.kind === 'image');

export interface SeoMetaInput {
  /** the owner's guidance for the page (marketing.seoGuide) */
  instructions?: string;
  /** the page's images (marketing.seoImages) */
  images?: PromptImage[];
  /** key of the page's main (hero) image, when it has one */
  mainImage?: string;
}

export const seoMetaTask = def<SeoMetaInput, SeoMeta>({
  id: 'seoMeta',
  label: 'SEO metadata',
  module: 'seo',
  tier: 'quick',
  local: (_i, env) => generateSeoMeta(env.project, env.directives, env.variation),
  claude: {
    prompt: (i, env, base) => {
      const guide = i.instructions?.trim();
      const images = photos(i.images);
      const main = i.mainImage && images.some((x) => x.key === i.mainImage) ? i.mainImage : '';
      return framePrompt({
        task:
          `Write SEO metadata for the sales page. Choose the best primary keyword (buyer intent${env.project.track === 'business' ? ', local' : ''}), 4–6 secondary keywords, a meta title of 50–60 characters containing the primary keyword, a meta description of 140–158 characters containing it, a short URL slug, OpenGraph title/description and image alt text. Current best guess for the primary keyword: “${base.primaryKeyword}”.` +
          (guide ? ` The owner’s guidance for this page: ${quoted(guide)}.` : '') +
          (images.length ? `\n\nThe page’s images (you can see the attached ones; go by the owner’s note for the others):\n${imageLines(images, env)}\nogImageAlt says what ${main ? `the page’s main image, ${main},` : 'the first image'} shows.` : ''),
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"metaTitle": string, "metaDescription": string, "slug": string, "primaryKeyword": string, "secondaryKeywords": [string], "ogTitle": string, "ogDescription": string, "ogImageAlt": string}`,
        extraRules: [NO_INVENTED_CLAIMS, ...(guide ? [OWNER_WORDS_RULE] : [])],
      });
    },
    merge: (raw, base, _i, env) => {
      const m = conform(base, obj(raw));
      const slug = m.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      return { ...m, slug, canonical: canonicalFor(env.project, slug) };
    },
    // the share image's alt text needs only that one image
    promptImages: (i) => {
      const images = photos(i.images);
      const main = images.find((x) => x.key === i.mainImage) ?? images[0];
      return main ? [main] : undefined;
    },
  },
});

// Testimonials, stats, prices and any guarantee are the owner's facts: the AI writes copy around them, never the facts.
const SALES_SHAPE = `{"hero": {"eyebrow": string, "headline": string, "subheadline": string, "ctaLabel": string, "bullets": [string, string, string]}, "problem": {"heading": string, "intro": string, "points": [{"title": string, "body": string}] (3), "agitation": string}, "solution": {"heading": string, "intro": string, "features": [{"title": string, "body": string}] (4-6)}, "proof": {"heading": string}, "pricing": {"heading": string, "planName": string, "includes": [string], "ctaLabel": string}, "faq": {"heading": string, "items": [{"q": string, "a": string}] (4-5)}, "guarantee": {"finalHeading": string, "finalCta": string}}`;

export interface SalesPageInput {
  primaryKeyword?: string;
  /** the owner's guidance for the page (marketing.seoGuide) */
  instructions?: string;
  /** the page's images (marketing.seoImages): all of them go on the new page */
  images?: PromptImage[];
}

export const salesPageTask = def<SalesPageInput, SalesPage>({
  id: 'salesPage',
  label: 'SEO sales page',
  module: 'seo',
  tier: 'default',
  local: (i, env) => {
    const page = generateSalesPage(env.project, env.directives, env.variation);
    const images = photos(i.images);
    return images.length ? placeNewImages(page, env.project, images, images.map((x) => x.key)) : page;
  },
  claude: {
    prompt: (i, env) => {
      const kw = i.primaryKeyword || primaryKeywordFor(buildFacts(env.project));
      const guide = i.instructions?.trim();
      const images = photos(i.images);
      return framePrompt({
        task:
          `Write a conversion-optimized, SEO-ready one-page sales page. Primary keyword: “${kw}” — use it in the hero headline and subheadline naturally and 2–4 more times on the page. Sections: hero with hook & CTA, problem/agitation, solution & features, a heading for the customer quotes the owner will add, pricing card copy, FAQ (4–5 questions) and a closing heading with CTA. The app fills in testimonials, stats, prices and any guarantee from the owner's own inputs: do not write them.` +
          (guide ? ` The owner’s guidance for this page: ${quoted(guide)}.` : '') +
          (images.length
            ? `\n\nThe owner’s images for the page (you can see the attached ones; go by the owner’s note for the others):\n${imageLines(images, env)}\nPut every image on the page in "images": the one that suits it best in the hero, beside the headline, and the others in the gallery, in the order that works best. Also write the gallery’s heading and a one-line intro.`
            : ''),
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: images.length ? `${SALES_SHAPE.slice(0, -1)}, ${IMAGES_SHAPE}}` : SALES_SHAPE,
        extraRules: [
          NO_INVENTED_CLAIMS,
          'Pricing "includes" lists only what PROJECT CONTEXT says the offer contains. FAQ answers must not promise refunds, guarantees, response times or payment terms.',
          ...(guide ? [OWNER_WORDS_RULE] : []),
          ...(images.length ? IMAGE_RULES : []),
        ],
      });
    },
    merge: (raw, base, i, env) => {
      const r = obj(raw);
      const copy: SalesPage = {
        ...base,
        sections: base.sections.map((s) => (r[s.type] ? keepFacts({ ...s, data: conform(s.data as never, r[s.type]) } as SalesSection, s) : s)),
      };
      // Every image goes on the page: where the AI put it, else where the built-in engine did (in base).
      const images = photos(i.images);
      const plan = images.length ? imagePlanFrom(r.images) : null;
      return withoutImageTokens(plan ? placeImages(copy, env.project, images, plan, images.map((x) => x.key)) : copy);
    },
    promptImages: (i) => i.images,
  },
});

export interface SalesSectionInput {
  type: SalesSectionType;
  /** the section as it is now: the AI works from the owner's own copy, and its facts are kept */
  current?: SalesSection;
  /** what the owner wants changed; without it, a fresh take */
  instruction?: string;
}

export const salesSectionTask = def<SalesSectionInput, SalesSection>({
  id: 'salesSection',
  label: 'Sales page section',
  module: 'seo',
  tier: 'quick',
  local: (i, env) => {
    // A change the owner asked for needs the AI: without it, the section stays as it is.
    if (i.current && i.instruction?.trim()) return i.current;
    const fresh = generateSalesSection(env.project, i.type, env.directives, env.variation);
    return i.current ? keepFacts({ ...fresh, id: i.current.id, visible: i.current.visible } as SalesSection, i.current) : fresh;
  },
  claude: {
    prompt: (i, env, base) => {
      const ask = i.instruction?.trim();
      return framePrompt({
        task: ask ? `Rewrite the “${SECTION_LABEL[i.type]}” section of the sales page as the owner asks: ${quoted(ask, 1000)}. Change only what the request is about.` : `Rewrite the “${i.type}” section of the sales page with a fresh angle.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        // a change the owner asked for isn't a "fresh take"
        variation: ask ? 0 : env.variation,
        input: { current: aiWritableData(i.current ?? base) },
        shape: `the same JSON object shape as INPUT.current`,
        extraRules: [NO_INVENTED_CLAIMS, ...(ask ? [OWNER_WORDS_RULE] : [])],
      });
    },
    merge: (raw, base) => withoutImageTokens(keepFacts({ ...base, data: conform(base.data as never, obj(raw)) } as SalesSection, base)),
  },
});

export interface SalesEditInput {
  /** the page as it is now: the base of the change (when the AI can't answer, nothing changes) */
  page: SalesPage;
  /** what the owner asked for */
  instruction: string;
  /** all of the page's images, including `newImages` */
  images?: PromptImage[];
  /** keys of the images added with this request: they go on the page */
  newImages?: string[];
  /** change only this section */
  sectionId?: string;
  /** the page's primary keyword, kept in the hero */
  primaryKeyword?: string;
}

/** The summary when the AI answered an edit but changed nothing. */
export const AI_NO_CHANGE = 'The AI made no changes.';

export interface SalesEditResult {
  page: SalesPage;
  /** what changed, in one sentence */
  summary: string;
  /** false when the AI didn't answer: the built-in engine can't follow a request, so nothing changed */
  edited: boolean;
}

const THEME_VALUES: { [K in keyof SalesTheme]: readonly SalesTheme[K][] } = { font: ['sans', 'serif', 'grotesk'], mode: ['light', 'dark'], radius: ['sharp', 'soft', 'round'] };

/** The page's look with the AI's changes, only where they're values the page has. */
function themeFrom(raw: unknown, cur: SalesTheme): SalesTheme {
  const r = obj(raw);
  const pick = <K extends keyof SalesTheme>(k: K): SalesTheme[K] => (THEME_VALUES[k] as readonly unknown[]).includes(r[k]) ? (r[k] as SalesTheme[K]) : cur[k];
  return { font: pick('font'), mode: pick('mode'), radius: pick('radius') };
}

/** The sections the AI changed, by id: {"<id>": {...}} or [{"id": "<id>", ...}]. */
function sectionChanges(raw: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const add = (id: unknown, v: unknown) => {
    const o = obj(v);
    if (typeof id === 'string' && id) out.set(id, obj(o.copy ?? o.data ?? o));
  };
  if (Array.isArray(raw)) for (const x of raw) add(obj(x).id, x);
  else for (const [id, v] of Object.entries(obj(raw))) add(id, v);
  return out;
}

/** A request about the page's images: only then are they sent along (they're always listed by their notes). */
const ABOUT_IMAGES = /\b(images?|photos?|pictures?|pics?|gallery|alt|captions?|visuals?|img-?\d+|hero image|main image)\b/i;

/** Images can be placed with this change: on the whole page, or in the hero or the gallery. */
const placesImages = (target?: SalesSection) => !target || target.type === 'hero' || target.type === 'gallery';

export const salesPageEditTask = def<SalesEditInput, SalesEditResult>({
  id: 'salesPageEdit',
  label: 'Edit sales page with AI',
  module: 'seo',
  tier: 'default',
  local: (i) => ({ page: i.page, summary: '', edited: false }),
  claude: {
    prompt: (i, env) => {
      const target = i.sectionId ? i.page.sections.find((s) => s.id === i.sectionId) : undefined;
      const images = placesImages(target) ? photos(i.images) : [];
      const fresh = (i.newImages ?? []).filter((k) => images.some((x) => x.key === k));
      const keyOf = new Map(images.map((x) => [x.media.id, x.key]));
      const hero = i.page.sections.find((s) => s.type === 'hero');
      const heroKey = hero?.type === 'hero' && hero.data.imageId ? keyOf.get(hero.data.imageId) : undefined;
      const galleryKeys = i.page.sections.flatMap((s) => (s.type === 'gallery' ? s.data.items.map((it) => keyOf.get(it.imageId)).filter((k): k is string => !!k) : []));
      const kw = i.primaryKeyword?.trim();
      const sections = (target ? [target] : i.page.sections).map((s) => ({ id: s.id, section: SECTION_LABEL[s.type], ...(s.visible ? {} : { hidden: true }), copy: aiWritableData(s) }));
      return framePrompt({
        task:
          `Make this change to the owner’s sales page: ${quoted(i.instruction, 1000)}. ` +
          (target ? `Change only the “${SECTION_LABEL[target.type]}” section.` : 'Change only what the request is about and keep everything else as it is.') +
          ` The sections, their order and which are hidden stay as they are${kw ? `, and the primary keyword “${kw}” stays in the hero headline and subheadline` : ''}.` +
          (images.length
            ? `\n\nThe page’s images (you can see the attached ones; go by the owner’s note for the others):\n${imageLines(images, env)}\nOn the page now: ${heroKey ? `${heroKey} in the hero` : 'no hero image'}; gallery: ${galleryKeys.length ? galleryKeys.join(', ') : 'none'}.${fresh.length ? ` Added with this request: ${fresh.join(', ')}. Put each of them on the page.` : ''}`
            : ''),
        project: env.project,
        brainPrompt: env.brainPrompt,
        input: { sections, ...(target ? {} : { theme: i.page.theme }) },
        shape: `{"sections": {"<section id>": {the copy fields you change, each in full (a list as the whole list), with the same keys as in INPUT}}${target ? '' : ', "theme": {"font": "sans"|"serif"|"grotesk", "mode": "light"|"dark", "radius": "sharp"|"soft"|"round"} (only when the owner asks for a different look)'}${images.length ? `, ${IMAGES_SHAPE} (only when the change is about the images, or images were added: "hero" and "gallery" then say where each image goes)` : ''}, "summary": string (one sentence: what you changed)}`,
        extraRules: [NO_INVENTED_CLAIMS, OWNER_WORDS_RULE, 'Use the section ids from INPUT exactly, and leave out the sections you don’t change.', ...(images.length ? IMAGE_RULES : [])],
      });
    },
    merge: (raw, base, i, env) => {
      const r = obj(raw);
      const target = i.sectionId ? base.page.sections.find((s) => s.id === i.sectionId) : undefined;
      const changes = sectionChanges(r.sections);
      let page: SalesPage = {
        ...base.page,
        // ids, order and visibility come from the page as it is; facts are put back
        sections: base.page.sections.map((s) => {
          const change = !target || s.id === target.id ? changes.get(s.id) : undefined;
          return change ? keepFacts({ ...s, data: conform(s.data as never, change) } as SalesSection, s) : s;
        }),
      };
      if (!target && r.theme) page = { ...page, theme: themeFrom(r.theme, page.theme) };
      const images = placesImages(target) ? photos(i.images) : [];
      const fresh = (i.newImages ?? []).filter((k) => images.some((x) => x.key === k));
      const plan = images.length ? imagePlanFrom(r.images) : null;
      if (plan || fresh.length) {
        // one section asked for: only its images move
        const allowed: ImagePlan = !plan || !target ? plan ?? {} : target.type === 'hero' ? { hero: plan.hero, heroAlt: plan.heroAlt } : { gallery: plan.gallery, galleryHeading: plan.galleryHeading, galleryIntro: plan.galleryIntro };
        page = placeImages(page, env.project, images, allowed, fresh);
      }
      page = withoutImageTokens(page);
      const changed = JSON.stringify(page) !== JSON.stringify(base.page);
      const said = typeof r.summary === 'string' ? truncate(r.summary.replace(/\s+/g, ' ').trim(), 300) : '';
      return { page, summary: said || (changed ? 'Updated by the AI.' : AI_NO_CHANGE), edited: true };
    },
    // Sent along only when they can be placed and the request is about them; they're always listed by their notes.
    promptImages: (i) => {
      const target = i.sectionId ? i.page.sections.find((s) => s.id === i.sectionId) : undefined;
      if (!placesImages(target)) return undefined;
      const fresh = new Set(i.newImages ?? []);
      return fresh.size || ABOUT_IMAGES.test(i.instruction) ? i.images : undefined;
    },
  },
});

// ───────────────────────── Social ─────────────────────────
export const campaignPlanTask = def<{ config: CampaignConfig }, CampaignPlan>({
  id: 'campaignPlan',
  label: '30-day campaign plan',
  module: 'social',
  tier: 'default',
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
        extraRules: ['Key messages and topics claim no customer results, testimonials, popularity, launch offers or deadlines the owner has not set. Customer stories are for the owner to add from real customers.'],
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
  local: (i, env) => generateContentBatch(env.project, i.plan, i.config, env.directives, env.variation, i.days ?? 7),
  claude: {
    prompt: (_i, env, base) =>
      framePrompt({
        task: `Write ready-to-publish social posts for each slot below (the next 7 days of the campaign). Each needs: an on-image headline (max 60 chars), a caption with a hook first line, a value body and a clear call to action (X under 260 characters, where a link counts as 23; follow the link rule for the slot’s platform in "links"; never make up a web address), platform-appropriate hashtags, a detailed visual prompt in the slot’s style, and for video slots a 4-scene storyboard (on-screen text, shot, seconds).`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        input: {
          links: Object.fromEntries([...new Set(base.map((p) => p.platform))].map((pl) => [pl, linkRule(postLinkFor(env.project, pl), pl)])),
          slots: base.map((p) => ({ slotId: p.planSlotId, when: p.scheduledAt.slice(0, 16), platform: p.platform, format: p.format, style: p.style, postType: p.postType, topic: p.headline })),
        },
        shape: `{"posts": [{"slotId": string, "headline": string, "caption": string, "hashtags": [string], "visualPrompt": string, "storyboard": [{"text": string, "shot": string, "duration": number}] (video slots only)}]}`,
      }),
    merge: (raw, base, _i, env) => {
      const r = obj(raw);
      const list = Array.isArray(r.posts) ? (r.posts as Record<string, unknown>[]) : [];
      const byId = new Map(list.filter((x) => x && typeof x.slotId === 'string').map((x) => [x.slotId as string, x]));
      return base.map((p) => {
        const x = byId.get(p.planSlotId ?? '');
        if (!x) return p;
        const merged = conform({ headline: p.headline, caption: p.caption, hashtags: p.hashtags, visualPrompt: p.visualPrompt }, x);
        const hashtags = merged.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`));
        const sb: Scene[] | undefined = p.storyboard && Array.isArray(x.storyboard) ? conform(p.storyboard, x.storyboard) : p.storyboard;
        // the app places the link again itself, where the post's placement says
        return { ...p, ...merged, hashtags, caption: finishCaption(env.project, merged.caption, p.platform, p.linkPlacement ? postLinkOf(env.project, p) : null, hashtags), storyboard: sb };
      });
    },
  },
});

export const postTask = def<ComposeInput & { media?: MediaRef }, ComposedPost>({
  id: 'post',
  label: 'Post caption & visual',
  module: 'social',
  tier: 'quick',
  local: (i, env) => composePost(env.project, i, env.directives, `${env.variation}|${Date.now() >> 16}`),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Write one ready-to-publish ${i.platform} post (${i.format}, post type: ${i.postType}). ${i.media ? `The user is posting their own ${i.media.kind}${i.mediaDescription ? ` described as “${i.mediaDescription}”` : ''}${i.media.kind === 'image' || i.media.kind === 'video' ? '; an image of it is attached, so describe what is actually shown' : ''}.` : `Topic: “${i.topic}”.`} Caption = hook first line, value body, clear CTA. Respect the platform (X under 260 characters, where a link counts as 23). ${linkRule(i.link ?? null, i.platform)} Never make up a web address.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        input: { topic: i.topic, platform: i.platform, postType: i.postType, format: i.format, style: i.style },
        shape: `{"headline": string (on-image text, max 60 chars), "caption": string, "hashtags": [string], "visualPrompt": string${i.format === 'video' ? ', "storyboard": [{"text": string, "shot": string, "duration": number}] (4)' : ''}}`,
      }),
    merge: (raw, base, i, env) => {
      const m = conform(base, obj(raw));
      const hashtags = m.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`));
      // the app places the link again itself (the page's or website's address, or "link in …", goes where this post's link goes)
      return { ...m, hashtags, caption: finishCaption(env.project, m.caption, i.platform, i.link ?? null, hashtags) };
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
  local: (i, env) => generateAds(env.project, i.campaign, env.directives, env.variation),
  claude: {
    prompt: (i, env) =>
      framePrompt({
        task: `Plan a paid ads campaign. Objective: ${i.campaign.objective}. Platforms: ${i.campaign.platforms.join(', ')}. Budget: $${i.campaign.dailyBudget}/day for ${i.campaign.durationDays} days. Location: ${i.campaign.locations}${i.campaign.radiusMi ? ` (+${i.campaign.radiusMi} mi)` : ''}, ages ${i.campaign.ageMin}–${i.campaign.ageMax}. Write targeting interests, three audience sets, three creative variants (A/B/C, each a different angle; primary text ≤125 chars, headline ≤40, description ≤30)${i.campaign.platforms.includes('google') ? ', and responsive search ads (headlines ≤30 chars, descriptions ≤90 chars, keywords with match types, 4 sitelinks)' : ''}.`,
        project: env.project,
        brainPrompt: env.brainPrompt,
        variation: env.variation,
        shape: `{"interests": [string], "audiences": [{"name": string, "description": string, "interests": [string]}] (3), "creatives": [{"variant": string, "angle": string, "primaryText": string, "headline": string, "description": string, "cta": string, "visualHeadline": string}] (3)${i.campaign.platforms.includes('google') ? ', "search": {"headlines": [string], "descriptions": [string], "keywords": [string], "sitelinks": [{"title": string, "desc": string}]}' : ''}}`,
        extraRules: [OWNER_FACTS_ONLY, 'No "free estimates", "instant access", social proof ("people are switching") or reviews sitelink unless the project context or Brain notes support it.'],
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
