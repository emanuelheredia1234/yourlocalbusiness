// The Studio's structure: a product's outline (sections, items, chapter drafts) and a business's model
// (packages, operating model, value stack). How an AI result is applied, and the Markdown exports, shared
// by Studio → Structure and the assistant so both do exactly the same.
//
// Each change names the project it is for (the active one by default): an AI answer that comes back
// after the owner switched projects still lands in the project it was asked for.

import type { OutlineSection, Project, ServicePriceModel, Studio } from '@/lib/types';
import { fmtMoney } from '@/lib/utils';
import { useStore } from '@/store/useStore';
import type { BusinessModelResult, OutlineResult } from './local/studio';

/** How a package is priced, as the Business model tab names it. */
export const PACKAGE_PRICE_MODELS: { id: ServicePriceModel; label: string }[] = [
  { id: 'per-session', label: 'per session' },
  { id: 'project', label: 'per project' },
  { id: 'monthly', label: 'per month' },
  { id: 'one-time', label: 'one-time' },
  { id: 'quote', label: 'quote' },
  { id: 'free', label: 'free' },
];

const activeId = () => useStore.getState().activeProjectId ?? '';

/** A project by id (null once it's gone). */
export const projectById = (id: string): Project | null => useStore.getState().projects.find((p) => p.id === id) ?? null;

/** Change one project's Studio (not necessarily the open one). */
export function updateStudioOf(projectId: string, patch: Partial<Studio> | ((s: Studio) => Partial<Studio>)): void {
  useStore.getState().updateProject(projectId, (p) => ({ ...p, studio: { ...p.studio, ...(typeof patch === 'function' ? patch(p.studio) : patch) } }));
}

// ───────────── applying AI results ─────────────

/** A new outline replaces the sections (and their drafts) and the outline's name. */
export function applyOutline(r: OutlineResult, projectId = activeId()): void {
  updateStudioOf(projectId, { outline: r.sections, outlineLabel: r.label });
}

/** Change one outline section. */
export function patchSection(projectId: string, sectionId: string, patch: Partial<OutlineSection> | ((s: OutlineSection) => Partial<OutlineSection>)): void {
  updateStudioOf(projectId, (s) => ({ outline: s.outline.map((x) => (x.id === sectionId ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x)) }));
}

/** A section's AI draft (Markdown) replaces its draft. */
export function applySectionDraft(sectionId: string, markdown: string, projectId = activeId()): void {
  patchSection(projectId, sectionId, { draft: markdown });
}

/** An outline item's AI talking points replace its details. */
export function applyItemDetail(sectionId: string, itemId: string, detail: string, projectId = activeId()): void {
  patchSection(projectId, sectionId, (s) => ({ items: s.items.map((it) => (it.id === itemId ? { ...it, detail } : it)) }));
}

/** A new business model replaces the packages, operating model and value stack, and the price follows its popular package. */
export function applyBusinessModel(r: BusinessModelResult, projectId = activeId()): void {
  updateStudioOf(projectId, { packages: r.packages, operating: r.operating, valueStack: r.valueStack, price: r.price });
}

// ───────────── Markdown exports ─────────────

/** The product outline as Markdown (sections, items with their details, and chapter drafts). */
export function outlineMarkdown(p: Project): string {
  const s = p.studio;
  const lines = [`# ${p.idea?.title ?? p.brand.name}`, '', `${s.outlineLabel}`, ''];
  s.outline.forEach((sec, i) => {
    lines.push(`## ${i + 1}. ${sec.title}`);
    if (sec.summary) lines.push('', sec.summary);
    lines.push('');
    sec.items.forEach((it) => lines.push(`- **${it.title}**${it.meta ? ` (${it.meta})` : ''}${it.detail ? `: ${it.detail}` : ''}`));
    if (sec.draft) lines.push('', sec.draft);
    lines.push('');
  });
  return lines.join('\n');
}

/** A package's price in words: "$120 per session", or "Get a quote" when it has none (never "$0"). */
export function packagePriceText(pk: { price: number; priceModel: ServicePriceModel }): string {
  if (pk.priceModel === 'quote') return 'Get a quote';
  if (pk.priceModel === 'free') return 'Free';
  return `${fmtMoney(pk.price)} ${PACKAGE_PRICE_MODELS.find((m) => m.id === pk.priceModel)?.label ?? ''}`.trim();
}

/** A business's packages, operating model and value stack as Markdown. */
export function businessMarkdown(p: Project): string {
  const s = p.studio;
  const out = [`# ${p.brand.name}: business model`, '', '## Service packages', ''];
  s.packages.forEach((pk) => out.push(`### ${pk.name}: ${packagePriceText(pk)}${pk.popular ? ' (most popular)' : ''}`, pk.description, ...pk.includes.map((i) => `- ${i}`), ''));
  out.push('## Operating model', '');
  s.operating.forEach((b) => out.push(`### ${b.title}`, ...b.items.map((i) => `- ${i}`), ''));
  out.push('## Value stack', '');
  s.valueStack.forEach((v) => out.push(`- **${v.title}**${v.value ? ` (${fmtMoney(v.value)} value)` : ''}: ${v.description}`));
  return out.join('\n');
}
