// Email outreach: emails the owner sends themselves (the app never sends email), with [brackets] to fill
// in, and the direction for the email funnel. "Fill in my page link" changes only what's copied.
import { useState } from 'react';
import { Mail } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { LEAD_MAGNET_LABEL, PURPOSE_LABEL } from '@/lib/strategy';
import { pageLink } from '@/lib/pageLink';
import { openPage } from '@/ai/assistant/nav';
import { CopyButton, Empty, Section, Toggle } from '@/components/ui/primitives';
import { BasisTip, Cite, SectionFooter, SourcesList, StaleNote, citedBy } from './parts';

const PLACEHOLDER = '[link to your page]';

export function OutreachTab({ project, s }: { project: Project; s: StrategyState }) {
  const o = s.outreach;
  const link = pageLink(project);
  const [fill, setFill] = useState(!!link);
  if (!o) return <Empty icon={<Mail />} title="Not written yet" body="It’s step 5 of 6." />;
  const out = (text: string) => (fill && link ? text.split(PLACEHOLDER).join(link.url) : text);
  const e = o.email;
  return (
    <div>
      <StaleNote project={project} s={s} step="outreach" />

      <Section
        title={
          <span className="inline-flex items-center gap-1">
            Your email funnel
            <BasisTip items={[e]} />
          </span>
        }
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openPage('marketing-email', 'magnet')}>
            Open Email
          </button>
        }
      >
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(120px,auto)_1fr]">
          {e.idea && (
            <>
              <dt className="text-small text-muted sm:text-body">Lead magnet</dt>
              <dd className="-mt-2 text-body text-ink sm:mt-0">
                {LEAD_MAGNET_LABEL[e.leadMagnetType]}: {e.idea}
              </dd>
            </>
          )}
          {e.welcomeAngle && (
            <>
              <dt className="text-small text-muted sm:text-body">Welcome emails</dt>
              <dd className="-mt-2 text-body text-ink sm:mt-0">{e.welcomeAngle}</dd>
            </>
          )}
        </dl>
        {e.why && (
          <p className="mt-3 max-w-[72ch] text-small text-ink-2">
            {e.why}
            <Cite item={e} all={s.sources} />
          </p>
        )}
      </Section>

      {o.templates.length > 0 && (
        <Section title="Emails to send" description="Emails you send yourself, from your own email. The app never sends email. Fill in the [brackets] before you send.">
          <div className="mb-4">
            <Toggle checked={fill && !!link} disabled={!link} onChange={setFill} label="Fill in my page link" description={link ? `Copies put ${link.url} where the email says ${PLACEHOLDER}. The emails here stay as written.` : 'No page yet: publish your page first, then copies can carry its link.'} />
          </div>
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            {o.templates.map((t) => (
              <article key={t.id} className="card flex min-w-0 flex-col gap-3 p-5">
                <div>
                  <p className="text-ui text-ink">To: {t.who || 'someone who can send you clients'}</p>
                  <p className="text-small text-muted">{PURPOSE_LABEL[t.purpose]}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-body">
                    <span className="text-muted">Subject: </span>
                    <span className="font-medium text-ink">{t.subject}</span>
                  </p>
                  <CopyButton text={t.subject} size="xs" />
                </div>
                <pre className="well whitespace-pre-wrap break-words px-3 py-2.5 font-sans text-body text-ink">{out(t.body)}</pre>
                <div>
                  <CopyButton text={() => out(t.body)} label="Copy email" size="xs" />
                </div>
                {t.followUp && (
                  <div className="flex flex-col gap-1.5 border-t border-line pt-3">
                    <p className="text-small font-medium text-ink-2">If there’s no reply after a few days</p>
                    <p className="whitespace-pre-wrap text-small text-ink-2">{out(t.followUp)}</p>
                    <div>
                      <CopyButton text={() => out(t.followUp)} size="xs" />
                    </div>
                  </div>
                )}
                {t.why && <p className="text-small text-muted">{t.why}</p>}
              </article>
            ))}
          </div>
        </Section>
      )}
      <SourcesList ns={citedBy([e])} all={s.sources} />
      <SectionFooter project={project} s={s} step="outreach" />
    </div>
  );
}
