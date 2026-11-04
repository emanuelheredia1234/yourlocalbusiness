// Email outreach: emails the owner sends themselves (the app never sends email), with [brackets] to fill
// in, and the direction for the email funnel. "Fill in my page link" changes only what's copied.
import { useState } from 'react';
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { LEAD_MAGNET_LABEL, PURPOSE_LABEL } from '@/lib/strategy';
import { pageLink } from '@/lib/pageLink';
import { openPage } from '@/ai/assistant/nav';
import { CopyButton, Toggle } from '@/components/ui/primitives';
import { Backing, SectionFooter, SourcesList, StaleBanners, citedBy } from './parts';

const PLACEHOLDER = '[link to your page]';

export function OutreachTab({ project, s }: { project: Project; s: StrategyState }) {
  const o = s.outreach;
  const link = pageLink(project);
  const [fill, setFill] = useState(!!link);
  if (!o) return <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">Not written yet. It’s step 5 of 6.</p>;
  const out = (text: string) => (fill && link ? text.split(PLACEHOLDER).join(link.url) : text);
  const e = o.email;
  return (
    <div className="flex flex-col gap-5">
      <StaleBanners project={project} s={s} step="outreach" />
      <p className="rounded-md bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">Emails you send yourself, from your own email. The app never sends email. Fill in the [brackets] before you send.</p>

      <section className="panel flex flex-col gap-2 p-4 sm:p-5" aria-label="Your email funnel">
        <h2 className="section-title">Your email funnel</h2>
        {e.idea && (
          <p className="text-[13.5px] text-ink">
            Lead magnet: {LEAD_MAGNET_LABEL[e.leadMagnetType]} — {e.idea}
          </p>
        )}
        {e.welcomeAngle && <p className="text-[13.5px] text-ink">Welcome emails: {e.welcomeAngle}</p>}
        {e.why && <p className="text-[13px] text-ink-2">{e.why}</p>}
        <Backing item={e} all={s.sources} />
        <div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openPage('marketing-email', 'magnet')}>
            Open Email funnel
          </button>
        </div>
      </section>

      {o.templates.length > 0 && (
        <section className="flex flex-col gap-3" aria-label="Emails to send">
          <Toggle checked={fill && !!link} disabled={!link} onChange={setFill} label="Fill in my page link" description={link ? `Copies put ${link.url} where the email says ${PLACEHOLDER}. The emails here stay as written.` : 'No page yet: publish your page first, then copies can carry its link.'} />
          {o.templates.map((t) => (
            <article key={t.id} className="panel flex flex-col gap-2.5 p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-semibold text-ink">To: {t.who || 'someone who can send you clients'}</span>
                <span className="badge bg-surface-2 text-ink-2">{PURPOSE_LABEL[t.purpose]}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-[13.5px]">
                  <span className="text-muted">Subject: </span>
                  <span className="font-semibold text-ink">{t.subject}</span>
                </p>
                <CopyButton text={t.subject} size="xs" />
              </div>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 p-3 font-sans text-[13px] leading-relaxed text-ink">{out(t.body)}</pre>
              <div>
                <CopyButton text={() => out(t.body)} label="Copy email" size="xs" />
              </div>
              {t.followUp && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-semibold text-muted">If there’s no reply after a few days:</p>
                  <p className="whitespace-pre-wrap text-[13px] text-ink-2">{out(t.followUp)}</p>
                  <div>
                    <CopyButton text={() => out(t.followUp)} size="xs" />
                  </div>
                </div>
              )}
              {t.why && <p className="text-xs text-muted">{t.why}</p>}
            </article>
          ))}
        </section>
      )}
      <SourcesList ns={citedBy([e])} all={s.sources} title="Sources this section cites" />
      <SectionFooter project={project} s={s} step="outreach" />
    </div>
  );
}
