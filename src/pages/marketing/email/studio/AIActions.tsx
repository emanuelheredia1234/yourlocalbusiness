// "Design this email" and "Make it bolder" (P5 §A5): AI tasks metered as the email function (without AI: the
// template for the email's purpose, or fixed bolder settings). Each replaces the blocks behind a confirm when the
// owner edited them, with Undo; nothing is retried by itself.

import { useState } from 'react';
import type { EmailStep, Project } from '@/lib/types';
import type { EmailDoc } from '../../../../../shared/email/blocks.mjs';
import type { EmailDesignInput } from '@/ai/emailDesign';
import { emailBolderTask, emailDesignTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { docOf, plainOf, replaceDoc, themeOf } from '@/lib/emailDoc';
import { offerPrice, type Offer } from '@/lib/offers';
import { pageLink } from '@/lib/pageLink';
import { useOffers } from '@/store/offers';
import { getActiveProject } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { confirmAction } from '@/components/ui/primitives';

/** What "Design this email" knows: the email's words, its purpose and place, the theme, and what it may link to. */
export function designInput(step: EmailStep, p: Project, index: number, offers: Offer[] = useOffers.getState().byProject[p.id] ?? []): EmailDesignInput {
  const plain = step.doc ? plainOf(step.doc, p) : step;
  return {
    stepId: step.id,
    purpose: step.purpose,
    index,
    total: p.marketing.emails.length,
    subject: step.subject,
    preview: step.preview,
    body: plain.body,
    ctaLabel: plain.ctaLabel,
    ctaUrl: plain.ctaUrl,
    theme: step.doc?.theme ?? themeOf(p),
    offers: offers.map((o) => ({ id: o.id, title: o.title, price: offerPrice(o) })),
    hasMagnet: !!p.marketing.leadMagnet?.delivery?.link,
    hasPage: !!pageLink(p),
  };
}

const stepOf = (projectId: string, stepId: string) => getActiveProject()?.id === projectId ? getActiveProject()!.marketing.emails.find((e) => e.id === stepId) : undefined;

export function EmailAIActions({ project, step, index }: { project: Project; step: EmailStep; index: number }) {
  const design = useAI(emailDesignTask);
  const bolder = useAI(emailBolderTask);
  const busy = design.running || bolder.running;
  // the result bar is the last action that ran (not whichever has a result)
  const [lastRan, setLastRan] = useState<'design' | 'bolder' | null>(null);

  const runDesign = async () => {
    if (step.doc && !(await confirmAction({ title: 'Design this email again?', body: 'The AI’s design replaces this email’s blocks (your words stay its words). Undo puts them back. Uses AI credits.', confirmLabel: 'Design it' }))) return;
    setLastRan('design');
    const doc = await design.run(designInput(step, project, index));
    if (doc && stepOf(project.id, step.id)) {
      replaceDoc(project.id, step.id, doc);
      toast({ kind: 'success', title: 'Email designed', body: 'Undo puts the earlier blocks back.' });
    }
  };
  const runBolder = async () => {
    const now = stepOf(project.id, step.id) ?? step;
    setLastRan('bolder');
    const doc: EmailDoc | null = await bolder.run({ doc: docOf(now, project), brandColors: project.brand.colors as unknown as Record<string, string> });
    if (doc && stepOf(project.id, step.id)) {
      replaceDoc(project.id, step.id, doc);
      toast({ kind: 'success', title: 'Made it bolder', body: 'Undo puts the earlier look back.' });
    }
  };
  const ran = lastRan === 'bolder' ? bolder : lastRan === 'design' ? design : null;
  const last = ran?.result ?? null;
  const ai = bolder.running ? bolder : design;
  return (
    <>
      <GenerateButton size="sm" running={design.running} disabled={busy} runningLabel="Designing…" onClick={() => void runDesign()}>
        Design this email
      </GenerateButton>
      <GenerateButton size="sm" running={bolder.running} disabled={busy} runningLabel="Working…" onClick={() => void runBolder()}>
        Make it bolder
      </GenerateButton>
      {busy && (
        <div className="basis-full">
          <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
        </div>
      )}
      {!busy && last && (
        <div className="basis-full">
          <AIResultBar provider={last.provider} skills={last.skills} ms={last.ms} note={last.note} logId={ran?.logId ?? null} />
        </div>
      )}
    </>
  );
}
