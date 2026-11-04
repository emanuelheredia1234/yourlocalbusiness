// "Guide my other tabs": each write only on the owner's click, after a preview of exactly what's written
// (spec §3.5). The preview is a small window of its own (it shows lists and the exact text), the writes
// are the apply helpers in src/lib/strategyApply.ts, and each ends with a toast that says where it went.
import { create } from 'zustand';
import type { ReactNode } from 'react';
import { navigate } from '@/lib/router';
import { readStrategy } from '@/lib/strategy';
import {
  applyCampaign,
  applyLinks,
  applySeo,
  applySkill,
  campaignPatch,
  linksPreview,
  seoBlock,
  setSkillOn,
  strategySkill,
  undoCampaign,
  undoLinks,
  withSeoBlock,
  type SkillArea,
} from '@/lib/strategyApply';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { openPage } from '@/ai/assistant/nav';
import { confirmAction, Modal } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

// ───────────── the preview window ─────────────

interface PreviewAction {
  id: string;
  label: string;
  primary?: boolean;
}
interface PreviewReq {
  title: string;
  body: ReactNode;
  actions: PreviewAction[];
  resolve: (id: string | null) => void;
}
const usePreview = create<{ req: PreviewReq | null }>(() => ({ req: null }));

/** Show a preview; resolves with the action chosen, or null (Cancel, Escape, outside click). */
export function preview(o: Omit<PreviewReq, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    usePreview.getState().req?.resolve(null);
    usePreview.setState({ req: { ...o, resolve } });
  });
}

/** The preview window (rendered once by the Strategy page). */
export function PreviewHost() {
  const req = usePreview((s) => s.req);
  const close = (id: string | null) => {
    req?.resolve(id);
    usePreview.setState({ req: null });
  };
  return (
    <Modal
      open={!!req}
      onClose={() => close(null)}
      size="md"
      title={req?.title}
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={() => close(null)}>
            {req?.actions.length ? 'Cancel' : 'Close'}
          </button>
          {req?.actions.map((a, i) => (
            <button key={a.id} data-autofocus={i === req.actions.length - 1 ? true : undefined} className={cn('btn btn-sm', a.primary ? 'btn-primary' : 'btn-secondary')} onClick={() => close(a.id)}>
              {a.label}
            </button>
          ))}
        </>
      }
    >
      {req?.body}
    </Modal>
  );
}

/** Exactly the text that is written, as it will read. */
export function Exact({ text }: { text: string }) {
  return <pre className="scroll-thin max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 p-3 font-sans text-[12.5px] leading-relaxed text-ink-2">{text}</pre>;
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-2">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

const projectOf = (pid: string) => useStore.getState().projects.find((p) => p.id === pid) ?? null;
const AREA_NAME: Record<SkillArea, string> = { social: 'Social posts', email: 'Email funnel' };

// ───────────── the two Brain skills ─────────────

/** What the skill says, as the Brain will read it. */
function SkillPreview({ pid, area }: { pid: string; area: SkillArea }) {
  const p = projectOf(pid);
  if (!p) return null;
  const k = strategySkill(p, area, readStrategy(p));
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <p className="text-ink-2">
        <b className="font-semibold text-ink">{k.name}</b> · Applies to: {AREA_NAME[area]} · only for {p.brand.name || 'this project'}
      </p>
      <Exact text={`${k.instructions}\n\n${k.doc?.excerpt ?? ''}`} />
      <p className="text-xs text-muted">Notes are the strategy’s recommendations, not facts about your business: no findings, sources, prices or links. You can change it or turn it off in the Brain any time.</p>
    </div>
  );
}

/** Preview the skill, then add it (or update it from the newer strategy). */
export async function skillFlow(pid: string, area: SkillArea, mode: 'add' | 'update' | 'preview' = 'add'): Promise<void> {
  const p = projectOf(pid);
  if (!p) return;
  const k = strategySkill(p, area, readStrategy(p));
  if (!k.doc?.excerpt) {
    toast({ kind: 'info', title: 'Nothing to add yet', body: area === 'social' ? 'Write “Where to promote” and “Social content” first.' : 'Write “Email outreach” first.' });
    return;
  }
  const actions = mode === 'preview' ? [] : [{ id: 'go', label: mode === 'update' ? 'Update it' : 'Add it', primary: true }];
  const choice = await preview({ title: mode === 'preview' ? `What “${k.name}” tells your AI` : mode === 'update' ? 'Update this skill in your Brain?' : 'Add this skill to your Brain?', body: <SkillPreview pid={pid} area={area} />, actions });
  if (choice !== 'go') return;
  if (applySkill(pid, area)) toast({ kind: 'success', title: mode === 'update' ? `Updated in your Brain: ${k.name}` : `Added to your Brain: ${k.name}`, action: { label: 'Open the Brain', run: () => void openPage('brain', 'skills') } });
}

/** "Replace…": the owner changed the skill in the Brain; putting the strategy's notes back drops those edits. */
export async function replaceSkillFlow(pid: string, area: SkillArea): Promise<void> {
  const p = projectOf(pid);
  if (!p) return;
  const name = strategySkill(p, area, readStrategy(p)).name;
  const ok = await confirmAction({ title: 'Replace your changes?', body: `You changed “${name}” in your Brain. Replacing it puts back the strategy’s notes and drops your edits.`, confirmLabel: 'Replace', danger: true });
  if (ok && applySkill(pid, area)) toast({ kind: 'success', title: `Replaced in your Brain: ${name}` });
}

export function skillOnFlow(pid: string, area: SkillArea, on: boolean): void {
  setSkillOn(pid, area, on);
  toast({ kind: 'info', title: on ? 'Turned on in your Brain' : 'Turned off in your Brain', body: on ? 'Your AI uses it again for this project.' : 'Your AI no longer uses it. It stays in your Brain.' });
}

// ───────────── the SEO page's guidance ─────────────

/** Preview the block for the SEO page's "Guide the AI" box, then add it. */
export async function seoFlow(pid: string): Promise<void> {
  const p = projectOf(pid);
  if (!p) return;
  const s = readStrategy(p);
  const block = seoBlock(s, p);
  if (!block) {
    toast({ kind: 'info', title: 'Nothing to add yet', body: 'Write “Assets to create” first: it has the direction for your SEO page.' });
    return;
  }
  const r = withSeoBlock(p.marketing.seoGuide ?? '', block, s.applied.seo?.block);
  if (r.mode === 'full') {
    toast({ kind: 'error', title: 'The SEO guidance box is full. Shorten it first.', action: { label: 'Open SEO page', run: () => void navigate('marketing-seo') } });
    return;
  }
  let asNew = false;
  if (r.mode === 'edited') {
    const fresh = withSeoBlock(p.marketing.seoGuide ?? '', block);
    if (fresh.mode === 'full') {
      toast({ kind: 'error', title: 'The SEO guidance box is full. Shorten it first.' });
      return;
    }
    const choice = await preview({
      title: 'You changed the block Strategy added',
      body: (
        <div className="flex flex-col gap-3 text-[13px]">
          <p className="text-ink-2">Your edits stay as they are. You can add the strategy’s direction again as a new block below them:</p>
          <Exact text={fresh.block} />
        </div>
      ),
      actions: [{ id: 'new', label: 'Add as a new block', primary: true }],
    });
    if (choice !== 'new') return;
    asNew = true;
  } else {
    const choice = await preview({
      title: 'Add this to the SEO page’s guidance?',
      body: (
        <div className="flex flex-col gap-3 text-[13px]">
          <p className="text-ink-2">{r.mode === 'replace' ? 'It replaces the block Strategy added before. ' : ''}The SEO page’s AI reads it when it writes your page and its metadata. You can edit it there.</p>
          <Exact text={r.block} />
        </div>
      ),
      actions: [{ id: 'go', label: 'Add it', primary: true }],
    });
    if (choice !== 'go') return;
  }
  const done = applySeo(pid, asNew);
  if (done === 'append' || done === 'replace') toast({ kind: 'success', title: 'Added to the SEO page’s guidance', action: { label: 'Open SEO page', run: () => void navigate('marketing-seo') } });
  else if (done === 'full') toast({ kind: 'error', title: 'The SEO guidance box is full. Shorten it first.' });
}

// ───────────── campaign settings ─────────────

export async function campaignFlow(pid: string): Promise<void> {
  const p = projectOf(pid);
  const s = p ? readStrategy(p) : null;
  if (!p || !s?.content) return;
  const r = campaignPatch(p.marketing.campaign, s.content.campaign);
  if (!r.ok) {
    toast({ kind: 'error', title: 'These settings can’t make a plan', body: r.problem });
    return;
  }
  const choice = await preview({
    title: 'Change your campaign settings?',
    body: (
      <div className="flex flex-col gap-3">
        <Lines lines={r.lines} />
        <p className="text-xs text-muted">Your days, times, watermark and start date stay. Undo puts these back.</p>
      </div>
    ),
    actions: [{ id: 'go', label: 'Use these settings', primary: true }],
  });
  if (choice !== 'go') return;
  const out = applyCampaign(pid);
  if (out.ok) toast({ kind: 'success', title: 'Campaign settings updated. Regenerate your 30-day plan to use them.', action: { label: 'Open 30-day plan', run: () => void openPage('marketing-social', 'plan') } });
  else toast({ kind: 'error', title: 'These settings can’t make a plan', body: out.problem });
}

export function undoCampaignFlow(pid: string): void {
  if (undoCampaign(pid)) toast({ kind: 'info', title: 'Campaign settings put back' });
}

// ───────────── where links go ─────────────

export async function linksFlow(pid: string): Promise<void> {
  const p = projectOf(pid);
  const s = p ? readStrategy(p) : null;
  if (!p || !s?.promote) return;
  const lines = linksPreview(p, s.promote.links);
  if (!lines.length) {
    toast({ kind: 'info', title: 'Your link settings already match the strategy' });
    return;
  }
  const choice = await preview({
    title: 'Change where links go?',
    body: (
      <div className="flex flex-col gap-3">
        <Lines lines={lines} />
        <p className="text-xs text-muted">New posts use these. Each post can still choose its own, and posts you already made keep theirs.</p>
      </div>
    ),
    actions: [{ id: 'go', label: 'Use these link settings', primary: true }],
  });
  if (choice !== 'go') return;
  if (applyLinks(pid)) toast({ kind: 'success', title: 'Link settings saved. New posts use them; each post can still choose its own.' });
}

export function undoLinksFlow(pid: string): void {
  if (undoLinks(pid)) toast({ kind: 'info', title: 'Link settings put back' });
}
