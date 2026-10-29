import { useState } from 'react';
import { ChevronDown, Clock, Download, Eye, Mail, PenLine, Send } from 'lucide-react';
import type { EmailStep, Project } from '@/lib/types';
import { cn, slugify } from '@/lib/utils';
import { delayToMs, renderTokens } from '@/ai/local/email';
import { emailSequenceTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, CopyButton, Empty, Field, confirmAction } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';
import { EmailView, delayLabel, emailTokens } from './shared';

function sequenceText(p: Project): string {
  return p.marketing.emails
    .map((e, i) => [`EMAIL ${i + 1}: ${e.purpose}`, `Send: ${delayLabel(e, i)}`, `Subject: ${e.subject}`, `Preview: ${e.preview}`, '', e.body, '', `[${e.ctaLabel}] → ${e.ctaUrl}`].join('\n'))
    .join('\n\n────────────────────────\n\n');
}

export function SequencePanel({ project, onSimulate }: { project: Project; onSimulate: () => void }) {
  const updateMarketing = useStore((s) => s.updateMarketing);
  const emails = project.marketing.emails;
  const ai = useAI(emailSequenceTask);
  const [open, setOpen] = useState<string | null>(emails[0]?.id ?? null);
  const [preview, setPreview] = useState<Record<string, boolean>>({});
  const patch = (id: string, p: Partial<EmailStep>) => updateMarketing({ emails: getActiveProject()!.marketing.emails.map((e) => (e.id === id ? { ...e, ...p } : e)) });
  const totalDays = emails.reduce((n, e) => n + delayToMs(e.delay), 0) / 86_400_000;
  const tokens = emailTokens(project);

  const generate = async () => {
    if (emails.length && !(await confirmAction({ title: 'Rewrite all five emails?', body: 'Your edited subject lines, bodies and delays will be replaced.', confirmLabel: 'Rewrite sequence' }))) return;
    const r = await ai.run({ leadMagnet: getActiveProject()!.marketing.leadMagnet });
    if (r) {
      updateMarketing({ emails: r });
      setOpen(r[0]?.id ?? null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-title">5-email nurture sequence</h2>
          <p className="text-[13px] text-muted">
            {project.marketing.leadMagnet ? <>Sent automatically to everyone who claims “{project.marketing.leadMagnet.title}”.</> : 'Tip: create the lead magnet first so email 1 can deliver it.'} Delivery → quick win → myth-busting → objections → offer.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {emails.length > 0 && (
            <>
              <CopyButton text={() => sequenceText(getActiveProject()!)} label="Copy all" />
              <button className="btn btn-secondary btn-sm" onClick={() => download(`${slugify(project.brand.name)}-email-sequence.txt`, sequenceText(project))}>
                <Download size={14} /> Export
              </button>
              <button className="btn btn-primary btn-sm" onClick={onSimulate}>
                <Send size={14} /> Simulate subscriber
              </button>
            </>
          )}
          <GenerateButton running={ai.running} onClick={generate} size="sm">
            {emails.length ? 'Rewrite sequence' : 'Write the 5 emails'}
          </GenerateButton>
        </div>
      </div>
      <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
      {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}

      {!emails.length && !ai.running ? (
        <Empty icon={<Mail size={20} />} title="No emails yet" body="Generate the sequence: every subject, preview line, body, call to action and send delay is editable." action={<GenerateButton running={ai.running} onClick={generate}>Write the 5 emails</GenerateButton>} />
      ) : (
        <>
          {emails.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Clock size={13} /> The full sequence runs over <b className="num text-ink">{totalDays < 1 ? `${Math.round(totalDays * 24)} hours` : `${Math.round(totalDays * 10) / 10} days`}</b>.
            </p>
          )}
          <ol className="relative flex flex-col gap-3 before:absolute before:bottom-6 before:left-[19px] before:top-6 before:w-px before:bg-line">
            {emails.map((e, i) => {
              const isOpen = open === e.id;
              const pv = preview[e.id];
              return (
                <li key={e.id} className="relative pl-12">
                  <span className="num absolute left-0 top-3 flex h-10 w-10 items-center justify-center rounded-full border-2 border-surface bg-primary text-[14px] font-bold text-on-primary shadow-card">{i + 1}</span>
                  <div className="panel overflow-hidden">
                    <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left" onClick={() => setOpen(isOpen ? null : e.id)} aria-expanded={isOpen}>
                      <span className="badge bg-primary-soft text-primary">{e.purpose}</span>
                      <span className="flex items-center gap-1 text-xs text-muted">
                        <Clock size={12} /> {delayLabel(e, i)}
                      </span>
                      <span className="w-full min-w-0 truncate text-[14px] font-semibold sm:w-auto sm:flex-1">{renderTokens(e.subject, tokens)}</span>
                      <ChevronDown size={16} className={cn('ml-auto shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <div className="border-t border-line p-4">
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <div className="inline-flex rounded-md border border-line p-0.5">
                            <button className={cn('flex items-center gap-1 rounded px-2.5 py-1 text-xs font-semibold', !pv ? 'bg-ink text-surface' : 'text-muted')} onClick={() => setPreview((x) => ({ ...x, [e.id]: false }))}>
                              <PenLine size={12} /> Edit
                            </button>
                            <button className={cn('flex items-center gap-1 rounded px-2.5 py-1 text-xs font-semibold', pv ? 'bg-ink text-surface' : 'text-muted')} onClick={() => setPreview((x) => ({ ...x, [e.id]: true }))}>
                              <Eye size={12} /> Preview
                            </button>
                          </div>
                          <CopyButton text={() => `Subject: ${e.subject}\n\n${e.body}`} size="xs" />
                        </div>
                        {pv ? (
                          <EmailView project={project} email={e} tokens={tokens} />
                        ) : (
                          <div className="grid gap-3">
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
                              <Field label="Subject line" htmlFor={`sub-${e.id}`} right={<span className={e.subject.length > 50 ? 'text-warn' : ''}>{e.subject.length}/50</span>}>
                                <input id={`sub-${e.id}`} className="input font-semibold" value={e.subject} onChange={(ev) => patch(e.id, { subject: ev.target.value })} />
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
                            <Field label="Preview text" htmlFor={`pre-${e.id}`} right={<span className={e.preview.length > 90 ? 'text-warn' : ''}>{e.preview.length}/90</span>} hint="Shown next to the subject in most inboxes.">
                              <input id={`pre-${e.id}`} className="input" value={e.preview} onChange={(ev) => patch(e.id, { preview: ev.target.value })} />
                            </Field>
                            <Field label="Body" htmlFor={`body-${e.id}`} hint="Merge tags: {{first_name}}, {{lead_magnet_link}}, {{product_link}}, {{sender_name}}">
                              <AutoTextarea id={`body-${e.id}`} value={e.body} onChange={(v) => patch(e.id, { body: v })} minRows={8} className="text-[13.5px] leading-relaxed" />
                            </Field>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              <Field label="Button label" htmlFor={`cta-${e.id}`}>
                                <input id={`cta-${e.id}`} className="input" value={e.ctaLabel} onChange={(ev) => patch(e.id, { ctaLabel: ev.target.value })} />
                              </Field>
                              <Field label="Button link" htmlFor={`url-${e.id}`}>
                                <input id={`url-${e.id}`} className="input text-[13px]" value={e.ctaUrl} onChange={(ev) => patch(e.id, { ctaUrl: ev.target.value })} />
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
        </>
      )}
    </div>
  );
}
