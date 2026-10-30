// AI image creation for social posts and marketplace listings.
//
//   photo         → in the claude.ai artifact: Meta Muse Image through OpenRouter in the viewer's
//                   Zapier connector. Self-hosted: your server, with the keys that power Photos
//                   in Settings → AI (OpenAI, Google, xAI, Meta, OpenRouter, or a Manus task).
//   illustration  → the AI draws an SVG (Claude in claude.ai, or your server's keys); without
//                   either a built-in brand illustration is used and labelled as such.
//
// The artwork never carries text; headlines, prices and lists are typeset on top by the
// canvas compositor so they read exactly right.

import type { GeneratedInfo, ImageAspect, ImageKind, MediaRef, ProviderId, Project, StyleId } from '@/lib/types';
import { useRuntime } from '@/lib/platform';
import { deleteBlob, getBlob, putBlob } from '@/lib/storage';
import { hashStr, slugify, uid } from '@/lib/utils';
import { svgDataUrl } from '@/lib/svg';
import { canvasBlob, canvasThumb, composeListing, composePost, loadImage, type ListingLayout, type ListingText } from '@/lib/imageCanvas';
import { useStore } from '@/store/useStore';
import { FORMATS, IMAGE_STYLES, VIDEO_STYLES, matchBusinessType } from './knowledge';
import { heroScene, sceneForStyle, type ArtScene } from './local/art';
import { runTask } from './engine';
import { visualBrief, type VisualBrief } from './brain';
import { serverBase } from './claude';
import { primaryProvider, routeFor } from './functions';
import { compactMeta, isAIMeta, metaLine, type AIMeta } from './meta';
import { listingIllustrationTask, postIllustrationTask, type IllustrationInput } from './tasks';
import { generateMuseImage, museErrorMessage } from './openrouter';
import { videoErrorMessage } from './video';
import { base64ToBlob, continueManusTask, createManusTask, fetchManusImage, fmtElapsed, manusAttachPrompt, manusErrorMessage, manusImageLimit, manusImagePrompt, manusViaServer, pendingManus, waitForManus, type ManusTask } from './manus';
import { zapierErrorMessage } from '@/lib/zapier';

export class ImageGenError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly taskUrl?: string,
  ) {
    super(message);
  }
}

/**
 * Where photos come from here: Meta Muse Image (OpenRouter via Zapier) inside claude.ai; self-hosted,
 * the first key that powers Photos on your server ("manus" when that key is Manus).
 */
export function photoRoute(): 'muse' | 'server' | 'manus' | 'none' {
  if (__ARTIFACT_BUILD__) return 'muse';
  const route = routeFor('photos');
  if (!route.length) return 'none';
  return route[0] === 'manus' ? 'manus' : 'server';
}

export function photoLabel(): string {
  const route = photoRoute();
  if (route === 'muse') return 'Photo · Muse';
  const p = primaryProvider('photos');
  return p ? `Photo · ${p.label.split(' ')[0]}` : 'Photo';
}

/** One line on who makes photos here and what it costs, for under the controls. */
export function photoSourceNote(): string {
  const route = photoRoute();
  if (route === 'muse') return 'Meta Muse Image creates the photo through OpenRouter in your Zapier, in a few seconds. OpenRouter bills about a cent per image.';
  const p = primaryProvider('photos');
  if (!p) return '';
  if (route === 'manus') return `Manus makes the photo as a task (a few minutes, ${p.effort.image?.label ?? 'Standard'} agent), using your Manus credits.`;
  return `${p.label} makes the photo with ${p.models.image} at ${p.effort.image?.label ?? 'its default'} quality, billed to your key.`;
}

export function photoAvailability(): { ok: boolean; reason: string } {
  if (photoRoute() === 'muse') {
    switch (useRuntime.getState().zapier) {
      case 'needs_reauth':
        return { ok: false, reason: 'Photos are made by Meta Muse Image through OpenRouter in Zapier. Reconnect Zapier in claude.ai Settings → Connectors.' };
      case 'missing':
        return { ok: false, reason: 'Photos are made by Meta Muse Image through Zapier. Add the Zapier connector in claude.ai Settings → Connectors, with OpenRouter connected in Zapier.' };
      case 'unavailable':
        return { ok: false, reason: 'Photos are made by Meta Muse Image through your Zapier connector, which this view can’t reach. Open the app in claude.ai.' };
      default:
        return { ok: true, reason: '' };
    }
  }
  const rt = useRuntime.getState();
  if (!rt.ai.reachable) return { ok: false, reason: 'Start the Yourlocalbusiness server (npm run server) to generate photos.' };
  if (photoRoute() === 'none') return { ok: false, reason: 'No API key makes photos yet. In Settings → AI, tick Photos for an OpenAI, Google, xAI, Meta, OpenRouter or Manus key.' };
  return { ok: true, reason: '' };
}

// ───────────── prompts ─────────────

const NO_TEXT = 'No text, letters, words, numbers, logos or watermarks anywhere in the image.';
const BRAND_COLORS = /Brand colou?rs?\s*(#[0-9a-f]{3,8}(\s*(,|and)\s*)?)+[^.]*\.?/gi;

/** A shot prompt without the palette and no-text sentences (image sources add their own). */
function bareSubject(prompt: string): string {
  return prompt.replace(NO_TEXT, '').replace(BRAND_COLORS, '').replace(/\s+/g, ' ').trim();
}

/** The subject of a post's visual prompt, without the style boilerplate, on-image text and layout notes. */
export function postSubject(project: Project, visualPrompt: string, style?: StyleId): string {
  const def = style ? IMAGE_STYLES.find((s) => s.id === style) : undefined;
  let subject = visualPrompt;
  if (def && subject.toLowerCase().startsWith(def.prompt.toLowerCase())) subject = subject.slice(def.prompt.length);
  subject = subject
    .replace(/On-image text:\s*(“[^”]*”|"[^"]*"|[^.]*)\.?/gi, '')
    .replace(/,?\s*(small\s+)?watermark\s*(“[^”]*”|"[^"]*")?[^.,]*[.,]?/gi, '')
    .replace(BRAND_COLORS, '')
    .replace(/^[\s.,;:]*(Subject:\s*)?/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return subject || `${project.brand.name}: ${project.brand.tagline}`;
}

/** Turn a post's visual prompt into a clean image-model prompt. */
export function postPhotoPrompt(project: Project, visualPrompt: string, style: StyleId, overlay = true): string {
  const def = IMAGE_STYLES.find((s) => s.id === style);
  const c = project.brand.colors;
  return [
    postSubject(project, visualPrompt, style),
    def ? `Style: ${def.art ?? def.prompt}.` : '',
    `Color palette inspired by ${c.primary}, ${c.secondary} and ${c.accent}.`,
    overlay ? 'Leave calm, uncluttered space in the lower third for a headline overlay.' : '',
    'Social media composition, high detail, professional quality.',
    NO_TEXT,
  ]
    .filter(Boolean)
    .join(' ');
}

/** What a post's video should show: the scene plus the storyboard's shots, never on-screen words. */
export function postVideoPrompt(project: Project, visualPrompt: string, style: StyleId, storyboard?: { shot: string }[]): string {
  const def = VIDEO_STYLES.find((s) => s.id === style);
  let subject = visualPrompt;
  if (def && subject.toLowerCase().startsWith(def.prompt.toLowerCase())) subject = subject.slice(def.prompt.length);
  subject = postSubject(project, subject, style).replace(/\b(burned-in |bold )?captions?\b[^,.]*[,.]?/gi, '').replace(/\s+/g, ' ').trim();
  // shots that point at on-screen words would ask the model for text
  const shots = (storyboard ?? []).map((s) => s.shot).filter((s) => s && !/caption|text|title|logo|lettering/i.test(s)).join('; ');
  return [subject.replace(/\.*$/, '.'), shots ? `Shots: ${shots}.` : '', 'No on-screen text, captions, letters or logos.'].filter(Boolean).join(' ');
}

export const BIZ_SCENES: Record<string, { hero: string; work: string }> = {
  cleaning: { hero: 'a bright, spotless living room with sunlight, fresh flowers and neatly folded throws', work: 'a friendly professional cleaner wiping a kitchen counter in a sunlit home' },
  'home-repair': { hero: 'a neatly organized tool wall and workbench in a clean workshop', work: 'a skilled handyman fixing a kitchen cabinet in a modern home' },
  landscaping: { hero: 'a lush, freshly landscaped front yard with crisp lawn edges and flower beds at golden hour', work: 'a landscaper trimming hedges in a sunny backyard garden' },
  salon: { hero: 'a modern hair salon interior with styling chairs, mirrors, plants and warm lighting', work: 'a stylist blow-drying a smiling client’s hair in a bright salon' },
  barber: { hero: 'a classic barbershop interior with leather chairs, mirrors and warm lighting', work: 'a barber giving a sharp fade haircut to a client' },
  'fitness-studio': { hero: 'a bright boutique fitness studio with mats, kettlebells and natural light', work: 'a coach guiding an energetic small-group workout' },
  cafe: { hero: 'a cozy cafe counter with fresh pastries, latte art and morning light', work: 'a barista pouring latte art behind a cafe counter' },
  restaurant: { hero: 'an inviting restaurant dining room with set tables and warm ambient light', work: 'a chef plating a beautiful dish in an open kitchen' },
  photography: { hero: 'a photography studio with softboxes, a camera on a tripod and a seamless backdrop', work: 'a photographer capturing a candid portrait outdoors at golden hour' },
  consulting: { hero: 'a modern meeting room with a strategy session on a whiteboard and laptops', work: 'a consultant walking a small business owner through a growth plan' },
  bookkeeping: { hero: 'a tidy desk with a laptop showing financial charts, organized receipts and a calculator', work: 'a bookkeeper reviewing reports with a client at a desk' },
  tutoring: { hero: 'a calm study space with books, notebooks and a laptop', work: 'a tutor helping a student with homework at a bright table' },
  'pet-services': { hero: 'a happy, freshly groomed dog in a bright grooming studio', work: 'a groomer gently brushing a happy dog' },
  auto: { hero: 'a clean, well-lit auto repair garage with a car on a lift', work: 'a mechanic inspecting an engine while explaining it to a customer' },
  'event-planning': { hero: 'an elegantly styled event venue with string lights and decorated tables', work: 'an event planner arranging table centerpieces before a celebration' },
  retail: { hero: 'a beautifully merchandised boutique interior with shelves and warm light', work: 'a shop owner helping a customer at the counter' },
};

const FORMAT_MOCKUP: Record<string, { hero: string; life: string }> = {
  pdf: { hero: 'a printed guide and a tablet showing its cover, standing on a clean surface', life: 'reading the guide on a tablet with notes and coffee' },
  ebook: { hero: 'an ebook shown on an e-reader and tablet next to a printed copy', life: 'reading the ebook on a tablet, curled up in a cozy chair' },
  course: { hero: 'a laptop playing a video lesson with a printed worksheet and pen beside it', life: 'watching a lesson on a laptop and taking notes at a bright desk' },
  template: { hero: 'a laptop and tablet showing a polished, colorful template dashboard', life: 'organizing their week with the template on a laptop' },
  spreadsheet: { hero: 'a laptop showing a colorful spreadsheet dashboard with charts', life: 'reviewing numbers in a spreadsheet dashboard with a satisfied smile' },
  software: { hero: 'a laptop and a phone showing a clean, modern web app interface', life: 'using the app on a laptop in a bright, modern workspace' },
  design: { hero: 'a fanned set of design cards beside a tablet showing graphics', life: 'designing social graphics on a tablet at a creative desk' },
  audio: { hero: 'premium headphones next to a phone showing an audio player', life: 'relaxing with headphones on, listening on a phone' },
  membership: { hero: 'a phone and laptop showing a friendly community feed and member area', life: 'joining a lively online community call from a laptop' },
};

export type ListingShotId = 'hero' | 'lifestyle' | 'inside' | 'offer';

export interface ListingShot {
  id: ListingShotId;
  label: string;
  desc: string;
  aspect: ImageAspect;
  layout: ListingLayout;
  scene: ArtScene;
  textArea: IllustrationInput['textArea'];
  prompt: string;
}

/** The four standard marketplace images for this project, with prompts built from its context. */
export function listingShots(project: Project): ListingShot[] {
  const c = project.brand.colors;
  const palette = `Brand colors ${c.primary}, ${c.secondary} and ${c.accent}.`;
  const name = project.studio.listing.title.trim() || project.idea?.title || project.brand.name;
  const audience = project.idea?.audience || project.brand.audience || 'the ideal customer';
  if (project.track === 'business') {
    const bt = matchBusinessType(`${project.businessType} ${project.category} ${project.niche}`);
    const scene = BIZ_SCENES[bt.id] ?? { hero: `the welcoming space of a professional ${bt.label.toLowerCase()} business`, work: `a friendly ${bt.label.toLowerCase()} professional serving a happy customer` };
    const where = project.location?.city ? ` in ${project.location.city}` : '';
    return [
      { id: 'hero', label: 'Cover', desc: 'Your space or result, used as the listing cover', aspect: '3:2', layout: 'clean', scene: 'storefront', textArea: 'none', prompt: `${scene.hero}${where}, for “${project.brand.name}”. Inviting, premium real-estate-style photo, natural light, sharp focus. ${palette} ${NO_TEXT}` },
      { id: 'lifestyle', label: 'At work', desc: 'Your service in action', aspect: '3:2', layout: 'clean', scene: 'people', textArea: 'none', prompt: `${scene.work}${where}. Candid, warm, authentic documentary-style photo, natural light. ${palette} ${NO_TEXT}` },
      { id: 'inside', label: 'What you get', desc: 'Package highlights as a branded checklist', aspect: '1:1', layout: 'inside', scene: 'soft', textArea: 'center', prompt: `Soft, out-of-focus background suggesting ${scene.hero}, gentle bokeh, lots of calm space. ${palette} ${NO_TEXT}` },
      { id: 'offer', label: 'Offer card', desc: 'Price and call to action', aspect: '1:1', layout: 'offer', scene: 'storefront', textArea: 'center', prompt: `${scene.hero}, moody and slightly dark so white text reads clearly on top. ${palette} ${NO_TEXT}` },
    ];
  }
  const fmt = project.format ? FORMATS[project.format] : null;
  const mock = FORMAT_MOCKUP[project.format ?? ''] ?? { hero: 'a premium digital product shown on a laptop and tablet', life: 'using the product at a bright desk' };
  const what = `${fmt ? fmt.label.replace(/s$/, '').toLowerCase() : 'digital product'} “${name}”`;
  return [
    { id: 'hero', label: 'Cover mockup', desc: 'Product mockup, used as the listing cover', aspect: '3:2', layout: 'clean', scene: heroScene(project), textArea: 'none', prompt: `Product mockup of the ${what}: ${mock.hero}. Clean studio backdrop, soft shadows, premium e-commerce photography, centered. ${palette} ${NO_TEXT}` },
    { id: 'lifestyle', label: 'In use', desc: 'Your buyer using it', aspect: '3:2', layout: 'clean', scene: 'desk', textArea: 'none', prompt: `${audience} ${mock.life}. Candid lifestyle photo, natural window light, authentic and aspirational. ${palette} ${NO_TEXT}` },
    { id: 'inside', label: 'What’s inside', desc: 'What buyers get, as a branded checklist', aspect: '1:1', layout: 'inside', scene: 'soft', textArea: 'center', prompt: `Soft, abstract, out-of-focus background with gentle gradients and light, calm and minimal. ${palette} ${NO_TEXT}` },
    { id: 'offer', label: 'Offer card', desc: 'Price and call to action', aspect: '1:1', layout: 'offer', scene: heroScene(project), textArea: 'center', prompt: `${mock.hero}, dramatic moody lighting with dark tones so white text reads clearly on top. ${palette} ${NO_TEXT}` },
  ];
}

// ───────────── generation ─────────────

export interface ArtResult {
  image: HTMLImageElement;
  /** the raw artwork bytes (photo, or SVG for illustrations) */
  source: Blob;
  /** Manus task that made it */
  taskUrl?: string;
  kind: GeneratedInfo['kind'];
  /** who made the artwork, for labels */
  provider: string;
  engine: ProviderId;
  /** Brain skills that shaped a photo's art direction */
  brainSkills?: string[];
  note?: string;
  revisedPrompt?: string;
  ms: number;
  /** your server: which key, model and quality made it, and what it cost */
  meta?: AIMeta;
}

interface ArtRequest {
  project: Project;
  kind: ImageKind;
  /** prompt for the image model (photos) */
  photoPrompt: string;
  /** what Claude should draw (illustrations) */
  subject: string;
  aspect: ImageAspect;
  scene: ArtScene;
  textArea: IllustrationInput['textArea'];
  styleHint?: string;
  purpose: 'post' | 'listing';
  seed: number;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  /** Manus: the task as soon as it exists (to show a link) */
  onTask?: (task: ManusTask) => void;
  /** Manus: remember the running task under this key so a reload can pick it up */
  pendingKey?: string;
  /** Manus: continue waiting for a task started earlier instead of starting a new one */
  resume?: ManusTask;
}

async function requestManusPhoto(req: ArtRequest): Promise<ArtResult> {
  const t0 = performance.now();
  let task = req.resume;
  if (!task) {
    req.onStage?.('Starting a Manus task…');
    task = await createManusTask({
      fn: 'photos',
      // the clean subject: manusImagePrompt adds the style, palette, framing and no-text rules itself
      prompt: manusImagePrompt({ subject: req.subject, aspect: req.aspect, styleHint: req.styleHint, colors: req.project.brand.colors, purpose: req.purpose, textSpace: req.textArea }),
      title: `${req.purpose === 'post' ? 'Post' : 'Listing'} image · ${req.project.brand.name || 'Yourlocalbusiness'}`,
      hidden: true,
    });
  }
  req.onTask?.(task);
  if (req.pendingKey) pendingManus.set(req.pendingKey, task);
  let got;
  try {
    let final = await waitForManus(task, { signal: req.signal, onUpdate: (_s, ms) => req.onStage?.(`Manus is creating the image… ${fmtElapsed(ms)}`) });
    req.onStage?.('Bringing the image back from Manus…');
    got = await fetchManusImage(task.taskId, { signal: req.signal });
    if (!got.image && !task.followedUp) {
      // too large to come back, or never attached: ask once for a small JPEG
      req.onStage?.('Asking Manus for a smaller copy…');
      await continueManusTask(task.taskId, manusAttachPrompt({ imageCount: got.state.imageCount, aspect: req.aspect }));
      task = { ...task, followedUp: true };
      if (req.pendingKey) pendingManus.set(req.pendingKey, task);
      final = await waitForManus(task, { signal: req.signal, after: got.state, onUpdate: (_s, ms) => req.onStage?.(`Manus is making a smaller copy… ${fmtElapsed(ms)}`) });
      req.onStage?.('Bringing the image back from Manus…');
      got = await fetchManusImage(task.taskId, { signal: req.signal });
    }
    got = { ...got, state: { ...got.state, taskUrl: got.state.taskUrl || final.taskUrl } };
  } catch (e) {
    // stopped by you: forget it; anything else: keep it so you can pick it up again
    if ((e as { code?: string }).code === 'cancelled' && req.pendingKey) pendingManus.clear(req.pendingKey);
    if ((e as { code?: string }).code === 'MANUS_ERROR' && req.pendingKey) pendingManus.clear(req.pendingKey);
    throw e;
  }
  if (req.pendingKey) pendingManus.clear(req.pendingKey);
  const img = got.image;
  const taskUrl = got.state.taskUrl || task.taskUrl;
  if (!img) {
    const big = got.state.images.find((i) => i.sizeBytes > manusImageLimit());
    const why = big ? `${(big.sizeBytes / 1e6).toFixed(1)} MB, more than the ${manusImageLimit() / 1e6} MB that fits${manusViaServer() ? '' : ' through Zapier'}` : got.state.images.find((i) => i.note)?.note;
    throw new ImageGenError(
      got.state.imageCount ? `Manus made the image but it couldn’t be brought back${why ? ` (${why})` : ''}. Open the task to download it.` : 'Manus finished without an image file. Open the task to see what happened.',
      'MANUS_NO_IMAGE',
      taskUrl,
    );
  }
  const type = img.contentType && img.contentType.startsWith('image/') ? img.contentType : 'image/png';
  const blob = base64ToBlob(img.base64, type);
  let image: HTMLImageElement;
  try {
    image = await loadImage(`data:${type};base64,${img.base64}`);
  } catch {
    throw new ImageGenError('Manus returned a file this browser can’t open as an image.', 'MANUS_NO_IMAGE', taskUrl);
  }
  return { image, source: blob, kind: 'photo', provider: 'Manus', engine: 'server', taskUrl, ms: Math.round(performance.now() - t0) };
}

async function requestMusePhoto(req: ArtRequest): Promise<ArtResult> {
  const t0 = performance.now();
  req.onStage?.('Meta Muse is creating the photo…');
  const img = await generateMuseImage(req.photoPrompt, req.aspect);
  if (req.signal?.aborted) throw new ImageGenError('Stopped.', 'cancelled');
  const type = img.contentType.startsWith('image/') ? img.contentType : 'image/png';
  let image: HTMLImageElement;
  try {
    image = await loadImage(`data:${type};base64,${img.base64}`);
  } catch {
    throw new ImageGenError('Muse returned a file this browser can’t open as an image.', 'MUSE_NO_IMAGE');
  }
  return { image, source: base64ToBlob(img.base64, type), kind: 'photo', provider: 'Meta Muse', engine: 'server', ms: Math.round(performance.now() - t0) };
}

/**
 * The Brain's art direction for a photo or video. Illustrations don't need it: Claude draws
 * them with the full Brain prompt.
 */
export function artDirection(purpose: 'post' | 'listing'): VisualBrief {
  const s = useStore.getState();
  return visualBrief(s.skills, purpose === 'post' ? 'social' : 'studio', s.settings.ai.useBrain);
}

/** Add art direction to an image-model prompt, keeping the no-text rule last. */
export function withArtDirection(prompt: string, brief: VisualBrief): string {
  if (!brief.text) return prompt;
  const rest = prompt.replace(NO_TEXT, '').trim();
  return `${rest} Art direction: ${brief.text}${prompt.includes(NO_TEXT) ? ` ${NO_TEXT}` : ''}`;
}

/** Count a photo or video toward the skills that shaped it (Brain → usage). */
export function recordVisualSkills(brief: VisualBrief, o: { task: string; label: string; purpose: 'post' | 'listing'; ms: number }) {
  if (!brief.skills.length) return;
  const s = useStore.getState();
  s.recordGeneration({ task: o.task, label: o.label, module: o.purpose === 'post' ? 'social' : 'studio', provider: 'server', skillIds: brief.skills.map((k) => k.id), createdAt: Date.now(), ms: o.ms, projectId: s.activeProjectId ?? undefined });
}

async function requestPhoto(req: ArtRequest): Promise<ArtResult> {
  // a Manus photo started earlier (or one Manus is set to make) runs as a Manus task
  if (req.resume) return requestManusPhoto(req);
  const brief = artDirection(req.purpose);
  if (brief.text) req = { ...req, photoPrompt: withArtDirection(req.photoPrompt, brief) };
  const art = await requestPhotoFrom(req);
  recordVisualSkills(brief, { task: 'photo', label: req.purpose === 'post' ? 'Post photo' : 'Listing photo', purpose: req.purpose, ms: art.ms });
  return brief.skills.length ? { ...art, brainSkills: brief.skills.map((k) => k.name) } : art;
}

async function requestPhotoFrom(req: ArtRequest): Promise<ArtResult> {
  const route = photoRoute();
  if (route === 'muse') return requestMusePhoto(req);
  if (route === 'manus') return requestManusPhoto(req);
  const t0 = performance.now();
  req.onStage?.(`${primaryProvider('photos')?.label ?? 'The AI'} is creating the photo…`);
  const s = useStore.getState().settings;
  let res: Response;
  try {
    res = await fetch(`${serverBase(s.ai.serverUrl)}/api/ai/image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: req.photoPrompt, aspect: req.aspect }),
      signal: req.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ImageGenError('Stopped.', 'cancelled');
    throw new ImageGenError('Could not reach your server to generate the photo.', 'NETWORK');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    // the keys changed since the page last asked: Manus makes the photo now
    if (body?.code === 'USE_AGENT') return requestManusPhoto(req);
    throw new ImageGenError(body?.error || `Image generation failed (${res.status}).`, body?.code || 'UPSTREAM');
  }
  const blob = await res.blob();
  let meta: AIMeta | undefined;
  try {
    const raw = JSON.parse(decodeURIComponent(res.headers.get('x-ai-meta') || ''));
    if (isAIMeta(raw)) meta = raw;
  } catch {
    /* no meta */
  }
  const revised = res.headers.get('x-revised-prompt');
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const note = meta?.attempts?.length ? `${meta.attempts.map((a) => `${a.providerLabel} failed (${a.error})`).join(' ')} ${meta.providerLabel} made it instead.` : meta?.note || undefined;
    return { image, source: blob, kind: 'photo', provider: meta?.providerLabel ?? 'Image provider', engine: 'server', revisedPrompt: revised ? decodeURIComponent(revised) : undefined, ms: Math.round(performance.now() - t0), meta, note };
  } catch {
    throw new ImageGenError('The image provider returned an image this browser can’t open.', 'UPSTREAM');
  } finally {
    // the decoded image keeps its pixels; the URL is no longer needed
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** "OpenAI · gpt-image-2.5-flare · effort High · ≈$0.13" for a photo made on your server. */
export function artMetaLine(art: Pick<ArtResult, 'meta'>): string {
  return art.meta ? metaLine(art.meta) : '';
}

async function requestIllustration(req: ArtRequest): Promise<ArtResult> {
  const s = useStore.getState();
  const task = req.purpose === 'post' ? postIllustrationTask : listingIllustrationTask;
  const run = await runTask(task, { subject: req.subject, aspect: req.aspect, scene: req.scene, seed: req.seed, textArea: req.textArea, styleHint: req.styleHint }, { project: req.project, skills: s.skills, settings: s.settings, signal: req.signal, onStage: req.onStage });
  const drawn = run.data.drawnBy === 'claude';
  s.recordGeneration({ id: run.id, task: task.id, label: task.label, module: task.module, provider: drawn ? run.provider : 'local', skillIds: run.skills.map((k) => k.id), createdAt: Date.now(), ms: run.ms, projectId: req.project.id, ...(drawn && run.meta ? { meta: compactMeta(run.meta) } : {}) });
  const image = await loadImage(svgDataUrl(run.data.svg));
  return {
    image,
    source: new Blob([run.data.svg], { type: 'image/svg+xml' }),
    kind: drawn ? 'illustration' : 'design',
    provider: drawn ? (run.provider === 'server' ? run.meta?.providerLabel ?? 'AI' : 'Claude') : 'Built-in',
    engine: drawn ? run.provider : 'local',
    note: drawn ? run.note : run.note ?? 'No AI is connected here, so a built-in brand illustration was used.',
    ms: run.ms,
    meta: drawn ? run.meta : undefined,
  };
}

export async function generateArt(req: ArtRequest): Promise<ArtResult> {
  if (req.kind === 'photo') return requestPhoto(req);
  return requestIllustration(req);
}

async function saveGenerated(canvas: HTMLCanvasElement, art: Pick<ArtResult, 'kind' | 'provider' | 'source' | 'taskUrl'>, info: Omit<GeneratedInfo, 'kind' | 'provider' | 'createdAt'>, name: string): Promise<MediaRef> {
  const jpeg = art.kind === 'photo';
  const blob = await canvasBlob(canvas, jpeg ? 'image/jpeg' : 'image/png', 0.9);
  const id = uid('media');
  await putBlob(id, blob);
  let artId = info.artId;
  if (!artId && info.final) {
    artId = uid('art');
    await putBlob(artId, art.source);
  }
  return {
    id,
    kind: 'image',
    name: `${name}.${jpeg ? 'jpg' : 'png'}`,
    mime: blob.type,
    size: blob.size,
    createdAt: Date.now(),
    w: canvas.width,
    h: canvas.height,
    thumb: canvasThumb(canvas),
    generated: { ...info, artId, kind: art.kind, provider: art.provider, createdAt: Date.now(), ...(art.taskUrl ? { taskUrl: art.taskUrl } : {}) },
  };
}

/** Load stored artwork (photo bytes or SVG) back into an image. */
async function loadArt(artId: string): Promise<{ image: HTMLImageElement; source: Blob } | null> {
  const blob = await getBlob(artId);
  if (!blob) return null;
  if (blob.type === 'image/svg+xml') return { image: await loadImage(svgDataUrl(await blob.text())), source: blob };
  const url = URL.createObjectURL(blob);
  try {
    return { image: await loadImage(url), source: blob };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

const postFileName = (headline: string, project: Project, aspect: ImageAspect) => `${slugify(headline || project.brand.name, 40) || 'post'}-${aspect.replace(/[:.]/g, 'x')}`;

export interface PostImageOptions {
  project: Project;
  kind: ImageKind;
  /** the image description (editable visual prompt) */
  prompt: string;
  aspect: ImageAspect;
  style: StyleId;
  headline: string;
  overlay: boolean;
  watermark: boolean;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onTask?: (task: ManusTask) => void;
  pendingKey?: string;
  resume?: ManusTask;
}

export async function createPostImage(o: PostImageOptions): Promise<{ media: MediaRef; art: ArtResult }> {
  const seed = hashStr(`${o.prompt}|${Date.now()}`);
  const def = IMAGE_STYLES.find((s) => s.id === o.style);
  const art = await generateArt({
    project: o.project,
    kind: o.kind,
    photoPrompt: postPhotoPrompt(o.project, o.prompt, o.style, o.overlay),
    subject: postSubject(o.project, o.prompt, o.style),
    aspect: o.aspect,
    scene: sceneForStyle(o.style, o.project),
    textArea: o.overlay ? 'bottom' : 'none',
    styleHint: def?.art ?? def?.prompt,
    purpose: 'post',
    seed,
    signal: o.signal,
    onStage: o.onStage,
    onTask: o.onTask,
    pendingKey: o.pendingKey,
    resume: o.resume,
  });
  o.onStage?.('Adding your headline and logo…');
  const canvas = await composePost({ art: art.image, brand: o.project.brand, aspect: o.aspect, headline: o.headline, style: o.style, overlay: o.overlay, watermark: o.watermark });
  const media = await saveGenerated(canvas, art, { prompt: o.prompt, purpose: 'post', aspect: o.aspect, final: true, headline: o.headline, overlay: o.overlay, watermark: o.watermark }, postFileName(o.headline, o.project, o.aspect));
  return { media, art };
}

/** Re-typeset a post image (new headline, aspect, overlay or watermark) on the same artwork: no new generation. */
export async function retypesetPostImage(media: MediaRef, o: { project: Project; aspect: ImageAspect; style: StyleId; headline: string; overlay: boolean; watermark: boolean }): Promise<MediaRef | null> {
  const g = media.generated;
  if (!g?.artId) return null;
  const art = await loadArt(g.artId);
  if (!art) return null;
  const canvas = await composePost({ art: art.image, brand: o.project.brand, aspect: o.aspect, headline: o.headline, style: o.style, overlay: o.overlay, watermark: o.watermark });
  return saveGenerated(canvas, { kind: g.kind, provider: g.provider, source: art.source, taskUrl: g.taskUrl }, { prompt: g.prompt, purpose: 'post', aspect: o.aspect, final: true, artId: g.artId, headline: o.headline, overlay: o.overlay, watermark: o.watermark }, postFileName(o.headline, o.project, o.aspect));
}

/** Free a generated image's stored bytes once nothing in the workspace points at it any more. */
export async function releaseMedia(media: MediaRef | null | undefined): Promise<void> {
  if (!media?.generated) return;
  const s = useStore.getState();
  const refs = new Set<string>();
  for (const p of s.posts) {
    if (p.media) {
      refs.add(p.media.id);
      if (p.media.generated?.artId) refs.add(p.media.generated.artId);
    }
  }
  for (const pr of s.projects) {
    for (const m of pr.brand.images) {
      refs.add(m.id);
      if (m.generated?.artId) refs.add(m.generated.artId);
    }
  }
  if (!refs.has(media.id)) await deleteBlob(media.id);
  const artId = media.generated.artId;
  if (artId && !refs.has(artId)) await deleteBlob(artId);
}

export interface ListingImageOptions {
  project: Project;
  kind: ImageKind;
  shot: ListingShot;
  prompt: string;
  text: ListingText;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onTask?: (task: ManusTask) => void;
  pendingKey?: string;
  resume?: ManusTask;
}

export async function createListingImage(o: ListingImageOptions): Promise<{ media: MediaRef; art: ArtResult }> {
  const art = await generateArt({
    project: o.project,
    kind: o.kind,
    photoPrompt: o.prompt,
    subject: bareSubject(o.prompt),
    aspect: o.shot.aspect,
    scene: o.shot.scene,
    textArea: o.shot.textArea,
    purpose: 'listing',
    seed: hashStr(`${o.shot.id}|${o.prompt}|${Date.now()}`),
    signal: o.signal,
    onStage: o.onStage,
    onTask: o.onTask,
    pendingKey: o.pendingKey,
    resume: o.resume,
  });
  if (o.shot.layout !== 'clean') o.onStage?.('Typesetting the details…');
  const canvas = await composeListing({ art: art.image, brand: o.project.brand, aspect: o.shot.aspect, layout: o.shot.layout, text: o.text });
  const base = slugify(o.project.studio.listing.title || o.project.brand.name, 36) || 'listing';
  const media = await saveGenerated(canvas, art, { prompt: o.prompt, purpose: 'listing', shot: o.shot.id, aspect: o.shot.aspect, final: o.shot.layout !== 'clean' }, `${base}-${o.shot.id}`);
  return { media, art };
}

/** Friendly copy for an image error code. */
export function imageErrorMessage(e: unknown): { title: string; body: string; code: string; taskUrl?: string } {
  const code = (e as { code?: string })?.code ?? 'UPSTREAM';
  const msg = (e as Error)?.message ?? '';
  const taskUrl = (e as { taskUrl?: string })?.taskUrl;
  const manus = manusErrorMessage(code, msg) ?? museErrorMessage(code, msg) ?? videoErrorMessage(code, msg);
  if (manus) return { code, ...manus, taskUrl };
  if (/^[a-z_]+$/.test(code) && code !== 'cancelled') return { code, ...zapierErrorMessage(code, msg) };
  switch (code) {
    case 'NO_KEY':
      return { code, title: 'No image API key yet', body: 'Add your Meta (or other) API key in Settings → Image generation, or switch to Illustration.' };
    case 'AUTH':
      return { code, title: 'The image API key was rejected', body: 'Check or replace it in Settings → Image generation.' };
    case 'CONTENT_POLICY':
      return { code, title: 'The image provider blocked this description', body: 'Rephrase the image description and try again.' };
    case 'RATE_LIMIT':
      return { code, title: 'The image provider is busy or out of credit', body: 'Wait a minute, or check your account balance.' };
    case 'NETWORK':
      return { code, title: 'Your server isn’t reachable', body: 'Start it with npm run server, then try again.' };
    case 'TIMEOUT':
      return { code, title: 'The image took too long', body: 'Try again; simpler descriptions are faster.' };
    default:
      return { code, title: 'Couldn’t create the image', body: msg || 'Please try again.' };
  }
}

/** Default to photos when the server can make them. */
export function defaultImageKind(): ImageKind {
  return photoAvailability().ok ? 'photo' : 'illustration';
}
