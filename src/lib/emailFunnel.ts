// The email funnel apart from its page: applying an AI lead magnet or sequence, the sequence as text and
// as a CSV for an email provider, and the subscriber list (import with duplicates skipped, CSV in and
// out). Shared by Marketing → Email and the assistant, so both do exactly the same. The app never sends
// email: the owner's email provider does.
//
// Each change names the project it is for: an AI answer that comes back after the owner switched
// projects still lands in the project it was asked for.

import type { EmailStep, LeadMagnet, Project, Subscriber } from './types';
import { emailValid, uid } from './utils';
import { csvCell as safeCell, MAX_EMAIL } from './leads';
import { useStore } from '@/store/useStore';

type Marketing = Project['marketing'];

const activeId = () => useStore.getState().activeProjectId ?? '';

/** Change one project's marketing (not necessarily the open one). */
export function updateMarketingOf(projectId: string, patch: Partial<Marketing> | ((m: Marketing) => Partial<Marketing>)): void {
  useStore.getState().updateProject(projectId, (p) => ({ ...p, marketing: { ...p.marketing, ...(typeof patch === 'function' ? patch(p.marketing) : patch) } }));
}

/** A new lead magnet (and its opt-in copy) replaces the current one. */
/** A new lead magnet replaces the old one's words; its published download (and its permanent link) stays, to update. */
export function applyLeadMagnet(lm: LeadMagnet, projectId = activeId()): void {
  updateMarketingOf(projectId, (m) => {
    const delivery = lm.delivery ?? m.leadMagnet?.delivery;
    return { leadMagnet: delivery ? { ...lm, delivery } : lm };
  });
}

/** A new sequence replaces all five emails. */
export function applyEmailSequence(emails: EmailStep[], projectId = activeId()): void {
  updateMarketingOf(projectId, { emails });
}

// ───────────── the sequence as text and CSV ─────────────

export function delayLabel(e: EmailStep, i: number): string {
  const v = e.delay.value;
  if (!v) return i === 0 ? 'Immediately after sign-up' : 'Right after the previous email';
  const unit = v === 1 ? e.delay.unit.replace(/s$/, '') : e.delay.unit;
  return `${v} ${unit} after ${i === 0 ? 'sign-up' : `email ${i}`}`;
}

/**
 * {{buy:<id>}} in a text as the business's buy link. links: buy:<id> → its full link (emailTokens' entries, or
 * buyLinksOf); an id that isn't one of them stays as typed (hasUnknownBuyLink finds it).
 */
export function renderBuyLinks(text: string, links: Record<string, string>): string {
  return text.replace(/\{\{\s*(buy:[A-Za-z0-9_-]{22})\s*\}\}/g, (m, k: string) => links[k] ?? m);
}

/** The sequence as plain text (Copy all, Export), its buy links filled in (links: see renderBuyLinks). */
export function sequenceText(p: Project, links: Record<string, string> = {}): string {
  return p.marketing.emails
    .map((e, i) => [`EMAIL ${i + 1}: ${e.purpose}`, `Send: ${delayLabel(e, i)}`, `Subject: ${e.subject}`, `Preview: ${e.preview}`, '', renderBuyLinks(e.body, links), '', `[${e.ctaLabel}] → ${renderBuyLinks(e.ctaUrl ?? '', links)}`].join('\n'))
    .join('\n\n────────────────────────\n\n');
}

const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

/** The sequence as a CSV: one row per email, ready to copy into an email provider (its buy links filled in). */
export function sequenceCsv(p: Project, links: Record<string, string> = {}): string {
  return ['step,send,subject,preview,body,button,button_link', ...p.marketing.emails.map((e, i) => [i + 1, delayLabel(e, i), e.subject, e.preview ?? '', renderBuyLinks(e.body, links), e.ctaLabel ?? '', renderBuyLinks(e.ctaUrl ?? '', links)].map(csvCell).join(','))].join('\n');
}

// ───────────── subscribers ─────────────

/** An email a subscriber list takes: an email address, at most 254 characters. */
export const subscriberEmailOk = (email: string) => email.trim().length <= MAX_EMAIL && emailValid(email);

/**
 * Add subscribers the owner brought in (an import, or names they gave), skipping emails already on the list
 * and ones that aren't email addresses. Returns how many were added.
 */
export function importSubscribers(rows: { name?: string; email: string }[], projectId = activeId(), source: Subscriber['source'] = 'import'): number {
  const project = useStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return 0;
  const have = new Set(project.marketing.subscribers.map((x) => x.email.trim().toLowerCase()));
  const now = Date.now();
  const added: Subscriber[] = [];
  for (const r of rows) {
    const email = r.email.trim().toLowerCase();
    if (!email || !subscriberEmailOk(email) || have.has(email)) continue;
    have.add(email);
    added.push({ id: uid('sub'), name: (r.name ?? '').trim() || email.split('@')[0], email, joinedAt: now, source });
  }
  if (added.length) updateMarketingOf(projectId, (m) => ({ subscribers: [...added, ...m.subscribers] }));
  return added.length;
}

/** Split one CSV line (quotes and doubled quotes supported). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Name and email from a CSV export (any provider's): finds the email column, and a name column if there is one. */
export function parseSubscriberCsv(text: string): { name: string; email: string }[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = cells(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = head.some((h) => /e-?mail/.test(h));
  const emailCol = hasHeader ? head.findIndex((h) => /e-?mail/.test(h)) : -1;
  const nameCol = hasHeader ? head.findIndex((h) => /^(first[ _]?name|name|full[ _]?name)$/.test(h)) : -1;
  const out: { name: string; email: string }[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const c = cells(line);
    const email = emailCol >= 0 ? c[emailCol] : c.find((x) => emailValid(x));
    if (!email || !emailValid(email)) continue;
    out.push({ name: nameCol >= 0 ? c[nameCol] ?? '' : '', email });
  }
  return out;
}

/**
 * The subscriber list as a CSV (name,email,source,joined). Names can come from an imported file or a
 * visitor's form, so a cell that starts like a formula gets a ' first (spreadsheets don't run it).
 */
export function subscribersCsv(subs: Subscriber[]): string {
  return ['name,email,source,joined', ...subs.map((s) => [s.name, s.email, s.source, new Date(s.joinedAt).toISOString()].map(safeCell).join(','))].join('\n');
}
