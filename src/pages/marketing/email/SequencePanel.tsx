import { useState } from 'react';
import { ChevronDown, Copy, Download, Eye, PenLine } from 'lucide-react';
import type { EmailStep, Project } from '@/lib/types';
import { cn, slugify } from '@/lib/utils';
import { delayToMs, renderTokens } from '@/ai/local/email';
import { emailSequenceTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { applyEmailSequence, delayLabel, sequenceText } from '@/lib/emailFunnel';
import { copyText } from '@/lib/platform';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, Empty, Field, MoreMenu, Section, Segmented, confirmAction } from '@/components/ui/primitives';
import { BrowserFrame } from '@/components/frames/Frames';
import { download } from '@/components/ui/download';
import { EmailView, PanelHead, emailTokens } from './shared';
import { useProjectOffers } from '@/store/offers';
import { offerPrice } from '@/lib/offers';
import { buyToken } from '@/lib/buyLinks';

/** "Day 3" (or "Day 0 · 2h"): when an email goes out, counted from sign-up. */
function dayMarker(emails: EmailStep[], i: number): string {
  const ms = emails.slice(0, i + 1).reduce((n, e) => n + delayToMs(e.delay), 0);
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.round((ms % 86_400_000) / 3_600_000);
  return days === 0 && hours > 0 ? `Day 0 · ${hours}h` : `Day ${days}`;
}

export function SequencePanel({ project, onPreview }: { project: Project; onPreview: () => void }) {
  const updateMarketing = useStore((s) => s.updateMarketing);
  const emails = project.marketing.emails;
  const ai = useAI(emailSequenceTask);
  const [open, setOpen] = useState<string | null>(emails[0]?.id ?? null);
  const [preview, setPreview] = useState<Record<string, boolean>>({});
  const patch = (id: string, p: Partial<EmailStep>) => updateMarketing({ emails: getActiveProject()!.marketing.emails.map((e) => (e.id === id ? { ...e, ...p } : e)) });
  const totalDays = emails.reduce((n, e) => n + delayToMs(e.delay), 0) / 86_400_000;
  const tokens = emailTokens(project);
  // the business's offers, for "Use a buy link" (the button then opens the offer's permanent buy link)
  const { on: offersOn, offers } = useProjectOffers(project.id);
  const buyIdOf = (url: string) => /^\s*\{\{\s*buy:([A-Za-z0-9_-]{22})\s*\}\}\s*$/.exec(url)?.[1] ?? '';
  const buyHint = (url: string) => {
    const id = buyIdOf(url);
    if (!id) return undefined;
    const o = offers.find((x) => x.id === id);
    return o ? `Opens the buy link of “${o.title}”${o.environment === 'sandbox' ? ' (Test mode)' : ''}.` : 'This buy link isn’t one of this business’s offers.';
  };
  const magnet = project.marketing.leadMagnet;

  const generate = async () => {
    if (emails.length && !(await confirmAction({ title: 'Rewrite all five emails?', body: 'Your edited subject lines, bodies and delays will be replaced.', confirmLabel: 'Rewrite sequence' }))) return;
    const r = await ai.run({ leadMagnet: getActiveProject()!.marketing.leadMagnet });
    if (r) {
      applyEmailSequence(r, project.id);
      setOpen(r[0]?.id ?? null);
    }
  };
  const copyAll = async () => {
    if (await copyText(sequenceText(getActiveProject()!))) toast({ kind: 'success', title: 'All five emails copied' });
    else toast({ kind: 'error', title: 'Copy was blocked', body: 'Use Export instead.' });
  };
  const copyOne = async (e: EmailStep) => {
    if (await copyText(`Subject: ${e.subject}\n\n${e.body}`)) toast({ kind: 'success', title: 'Email copied' });
    else toast({ kind: 'error', title: 'Copy was blocked', body: 'Select the text and copy it yourself.' });
  };
  const span = totalDays < 1 ? `${Math.round(totalDays * 24)} hours` : `${Math.round(totalDays * 10) / 10} days`;

  if (!emails.length) {
    return (
      <div className="flex flex-col gap-4">
        {ai.running ? (
          <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
        ) : (
          <Empty
            variant="ai"
            title="Write your welcome emails"
            body={magnet ? `Five emails for everyone who claims “${magnet.title}”: delivery, a quick win, myths, objections, then your offer.` : 'Five emails: delivery, a quick win, myths, objections, then your offer. Write the lead magnet first so email 1 can deliver it.'}
            action={
              <GenerateButton variant="ai" size="lg" running={ai.running} runningLabel="Writing…" onClick={generate}>
                Write the 5 emails
              </GenerateButton>
            }
          />
        )}
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
      </div>
    );
  }

  return (
    // the panel sits right under the tabs (a Section's own top margin is for a section after another)
    <Section className="mt-0">
      <PanelHead
        title="Welcome sequence"
        description={`${magnet ? `For everyone who claims “${magnet.title}” · ` : ''}Runs over ${span}`}
        actions={
          <>
            <GenerateButton size="sm" running={ai.running} runningLabel="Writing…" onClick={generate}>
              Rewrite sequence
            </GenerateButton>
            <button type="button" className="btn btn-primary btn-sm" onClick={onPreview}>
              <Eye /> Preview & export
            </button>
            <MoreMenu
              items={[
                { label: 'Copy all', icon: <Copy />, onSelect: () => void copyAll() },
                { label: 'Export .txt', icon: <Download />, onSelect: () => void download(`${slugify(project.brand.name)}-email-sequence.txt`, sequenceText(project)) },
              ]}
            />
          </>
        }
      />
      <div className="flex flex-col gap-4">
        <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
        <ol className="relative flex flex-col gap-3 before:absolute before:bottom-5 before:left-[39px] before:top-5 before:w-px before:bg-line max-sm:before:hidden">
          {emails.map((e, i) => {
            const isOpen = open === e.id;
            const pv = preview[e.id];
            return (
              <li key={e.id} className="relative flex flex-col gap-2 sm:flex-row sm:gap-4">
                <div className="flex shrink-0 items-center gap-2 sm:w-[80px] sm:flex-col sm:items-center sm:gap-1 sm:pt-3">
                  <span className="num relative z-[1] rounded-full bg-surface px-1.5 font-mono text-caption text-muted">{dayMarker(emails, i)}</span>
                </div>
                <div className="card min-w-0 flex-1 overflow-hidden">
                  <div className="flex items-start gap-2 px-4 py-3">
                    <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-left" onClick={() => setOpen(isOpen ? null : e.id)} aria-expanded={isOpen}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-h4 text-ink">{renderTokens(e.subject, tokens)}</span>
                        <span className="clamp-2 mt-0.5 block text-small text-muted">{e.preview || e.purpose}</span>
                        <span className="mt-1 block text-caption text-muted">
                          Email {i + 1} · {e.purpose} · {delayLabel(e, i)}
                        </span>
                      </span>
                      <ChevronDown size={16} className={cn('mt-0.5 shrink-0 text-muted transition-transform duration-180', isOpen && 'rotate-180')} aria-hidden="true" />
                    </button>
                    <MoreMenu size="xs" label={`More actions for email ${i + 1}`} items={[{ label: 'Copy email', icon: <Copy />, onSelect: () => void copyOne(e) }]} />
                  </div>
                  {isOpen && (
                    <div className="border-t border-line p-4">
                      <Segmented
                        size="sm"
                        className="mb-4"
                        value={pv ? 'preview' : 'edit'}
                        onChange={(v) => setPreview((x) => ({ ...x, [e.id]: v === 'preview' }))}
                        options={[
                          { id: 'edit', label: 'Edit', icon: <PenLine /> },
                          { id: 'preview', label: 'Preview', icon: <Eye /> },
                        ]}
                      />
                      {pv ? (
                        <BrowserFrame>
                          <EmailView project={project} email={e} tokens={tokens} />
                        </BrowserFrame>
                      ) : (
                        <div className="grid gap-4">
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
                            <Field label="Subject line" htmlFor={`sub-${e.id}`} right={<span className={cn('num font-mono', e.subject.length > 50 && 'text-warn')}>{e.subject.length}/50</span>}>
                              <input id={`sub-${e.id}`} className="input" value={e.subject} onChange={(ev) => patch(e.id, { subject: ev.target.value })} />
                            </Field>
                            <Field label={i === 0 ? 'Send after sign-up' : `Send after email ${i}`}>
                              <div className="flex gap-1.5">
                                <input type="number" min={0} max={90} className="input num w-20" value={e.delay.value} onChange={(ev) => patch(e.id, { delay: { ...e.delay, value: Math.max(0, Math.min(90, Number(ev.target.value) || 0)) } })} aria-label="Delay amount" />
                                <select className="select w-[110px]" value={e.delay.unit} onChange={(ev) => patch(e.id, { delay: { ...e.delay, unit: ev.target.value as EmailStep['delay']['unit'] } })} aria-label="Delay unit">
                                  <option value="minutes">minutes</option>
                                  <option value="hours">hours</option>
                                  <option value="days">days</option>
                                </select>
                              </div>
                            </Field>
                          </div>
                          <Field label="Preview text" htmlFor={`pre-${e.id}`} right={<span className={cn('num font-mono', e.preview.length > 90 && 'text-warn')}>{e.preview.length}/90</span>} hint="Shown next to the subject in most inboxes.">
                            <input id={`pre-${e.id}`} className="input" value={e.preview} onChange={(ev) => patch(e.id, { preview: ev.target.value })} />
                          </Field>
                          <Field label="Body" htmlFor={`body-${e.id}`} hint="Merge tags: {{first_name}}, {{lead_magnet_link}}, {{product_link}}, {{sender_name}}">
                            <AutoTextarea id={`body-${e.id}`} value={e.body} onChange={(v) => patch(e.id, { body: v })} minRows={8} />
                          </Field>
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <Field label="Button label" htmlFor={`cta-${e.id}`}>
                              <input id={`cta-${e.id}`} className="input" value={e.ctaLabel} onChange={(ev) => patch(e.id, { ctaLabel: ev.target.value })} />
                            </Field>
                            <Field label="Button link" htmlFor={`url-${e.id}`} hint={buyHint(e.ctaUrl)}>
                              <input id={`url-${e.id}`} className="input font-mono" value={e.ctaUrl} onChange={(ev) => patch(e.id, { ctaUrl: ev.target.value })} />
                              {offersOn && offers.length > 0 && (
                                <select aria-label="Use a buy link" className="select mt-2" value={buyIdOf(e.ctaUrl)} onChange={(ev) => ev.target.value && patch(e.id, { ctaUrl: buyToken(ev.target.value) })}>
                                  <option value="">Use a buy link…</option>
                                  {offers.map((o) => (
                                    <option key={o.id} value={o.id}>
                                      {o.title}
                                      {offerPrice(o) ? ` · ${offerPrice(o)}` : ''}
                                      {o.environment === 'sandbox' ? ' · Test mode' : ''}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </Field>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </Section>
  );
}
