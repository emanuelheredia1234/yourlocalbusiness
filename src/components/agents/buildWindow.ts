// The "Build with Manus / Build with Viktor" window's state: which page it's open for, and what's filled in,
// kept in memory per project and target (never saved) so closing it by mistake loses nothing. openAgentBuild
// opens the page first (Studio → Code & assets, or Marketing → SEO page), then the window, prefilled from that
// page's own fields: the kind, the owner's words, their images and their website.

import { create } from 'zustand';
import type { AgentBuild, AgentId, BuildFactId, BuildTarget } from '@/lib/agentTypes';
import type { Project, PromptImage } from '@/lib/types';
import { NO_DRAFT, defaultKind, useCodeTabMemory } from '@/lib/codeAssets';
import { REQUEST_MAX, emailKindFor, openBuildPage } from '@/ai/agents/builds';
import { plainOf } from '@/lib/emailDoc';
import { pageTypeOf } from '@/lib/pageTypes';
import { getActiveProject } from '@/store/useStore';

export interface BuildWindowFields {
  via: AgentId;
  /** CodeKind (asset) or PageType (seo) */
  kind: string;
  /** the owner's website as a style reference ('' for none) */
  website: string;
  /** "What to build and the features you want" */
  request: string;
  images: PromptImage[];
  /** facts the owner unticked (all are ticked to start with) */
  unticked: BuildFactId[];
  /** Manus agent profile ('' = the Settings default) */
  profile: string;
}

export interface BuildWindowState {
  /** the window is open for this project's asset, SEO page, email (stepId: which one) or lead magnet */
  open: { projectId: string; target: BuildTarget; stepId?: string } | null;
  /** what's filled in, per `${projectId}:${target}` */
  fields: Record<string, BuildWindowFields>;
}

export const useAgentBuildWindow = create<BuildWindowState>(() => ({ open: null, fields: {} }));

export const windowKey = (projectId: string, target: BuildTarget, stepId?: string) => (stepId ? `${projectId}:${target}:${stepId}` : `${projectId}:${target}`);

/**
 * An email's words for the agent to design (the owner's request slot): its subject and plain text, cut at a
 * paragraph to fit what the agent takes, with a note when it's cut.
 */
export function emailRequestOf(subject: string, body: string, cap: number): string {
  const head = `Design this email. Subject: ${subject.trim()}\n\nThe email’s words:\n`;
  const note = '\n\n(The rest of the email is left out: keep it short.)';
  const full = `${head}${body.trim()}`;
  if (full.length <= cap) return full;
  const paras = body.trim().split(/\n\s*\n/);
  let text = head;
  for (const p of paras) {
    if (`${text}${p}\n\n`.length + note.length > cap) break;
    text += `${p}\n\n`;
  }
  return `${text.trimEnd()}${note}`.slice(0, cap);
}

/** The window's fields from the page itself: the kind, the owner's words and images there, and their website. */
export function prefillFields(p: Project, target: BuildTarget, via: AgentId, stepId?: string): BuildWindowFields {
  const website = (p.brand.websiteUrl ?? '').trim();
  if (target === 'email') {
    const emails = p.marketing.emails;
    const i = Math.max(0, emails.findIndex((e) => e.id === stepId));
    const step = emails[i];
    const body = step ? (step.doc ? plainOf(step.doc, p).body : step.body) : '';
    return { via, kind: emailKindFor(i, emails.length), website, request: step ? emailRequestOf(step.subject, body, REQUEST_MAX[via]) : '', images: [], unticked: [], profile: '' };
  }
  if (target === 'leadMagnet') return { via, kind: p.marketing.leadMagnet?.type ?? 'checklist', website, request: '', images: [], unticked: [], profile: '' };
  if (target === 'asset') {
    const draft = useCodeTabMemory.getState().drafts[p.id] ?? NO_DRAFT;
    return { via, kind: draft.kind ?? defaultKind(p), website, request: draft.prompt, images: draft.images, unticked: [], profile: '' };
  }
  const m = p.marketing;
  return { via, kind: pageTypeOf(p), website, request: m.seoGuide ?? '', images: m.seoImages ?? [], unticked: [], profile: '' };
}

/** The window's fields from an earlier build (Try again): what was sent then. */
export function fieldsFromBuild(b: AgentBuild, base: BuildWindowFields): BuildWindowFields {
  return { ...base, via: b.via, kind: b.kind, website: b.website, request: b.request, images: b.images, profile: b.profile ?? base.profile };
}

/** Change what's filled in for the open window. */
export function setWindowFields(patch: Partial<BuildWindowFields>): void {
  const s = useAgentBuildWindow.getState();
  if (!s.open) return;
  const key = windowKey(s.open.projectId, s.open.target, s.open.stepId);
  const cur = s.fields[key];
  if (!cur) return;
  useAgentBuildWindow.setState({ fields: { ...s.fields, [key]: { ...cur, ...patch } } });
}

/** Close the window; `forget` drops what was filled in (after a send, so the next build starts from the page again). */
export function closeAgentBuild(forget = false): void {
  const s = useAgentBuildWindow.getState();
  if (!s.open) return;
  if (!forget) return useAgentBuildWindow.setState({ open: null });
  const { [windowKey(s.open.projectId, s.open.target, s.open.stepId)]: _gone, ...fields } = s.fields;
  useAgentBuildWindow.setState({ open: null, fields });
}

/**
 * Open the page (Studio → Code & assets, or Marketing → SEO page, through the leave guard), then the build window on
 * that agent, prefilled from the page's own fields (or what was typed in it before, or `from`: a build to try again).
 * `kind` picks the kind (the SEO builder's chosen page type). False when the owner chose to stay where they were.
 */
export async function openAgentBuild(o: { target: BuildTarget; via: AgentId; kind?: string; from?: AgentBuild; stepId?: string }): Promise<boolean> {
  const ok = await openBuildPage(o.target);
  if (!ok) return false;
  const p = getActiveProject();
  if (!p) return false;
  const stepId = o.target === 'email' ? o.stepId ?? o.from?.stepId ?? p.marketing.emails[0]?.id : undefined;
  if (o.target === 'email' && !stepId) return false;
  const key = windowKey(p.id, o.target, stepId);
  const s = useAgentBuildWindow.getState();
  const fresh = prefillFields(p, o.target, o.via, stepId);
  let fields = s.fields[key] ?? fresh;
  if (o.from) fields = fieldsFromBuild(o.from, fresh);
  fields = { ...fields, via: o.via, ...(o.kind && !o.from ? { kind: o.kind } : {}) };
  useAgentBuildWindow.setState({ open: { projectId: p.id, target: o.target, ...(stepId ? { stepId } : {}) }, fields: { ...s.fields, [key]: fields } });
  return true;
}
