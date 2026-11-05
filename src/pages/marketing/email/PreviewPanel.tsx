import { Download, ExternalLink, Mail } from 'lucide-react';
import type { Project } from '@/lib/types';
import { slugify } from '@/lib/utils';
import { renderTokens } from '@/ai/local/email';
import { delayLabel, sequenceCsv } from '@/lib/emailFunnel';
import { CopyButton, Empty, InfoTip, Section } from '@/components/ui/primitives';
import { BrowserFrame } from '@/components/frames/Frames';
import { download } from '@/components/ui/download';
import { EmailView, emailTokens } from './shared';

const PROVIDERS = [
  { name: 'Kit (ConvertKit)', url: 'https://kit.com' },
  { name: 'Mailchimp', url: 'https://mailchimp.com' },
  { name: 'MailerLite', url: 'https://www.mailerlite.com' },
  { name: 'Brevo', url: 'https://www.brevo.com' },
];

/** See each email the way subscribers will, then take the sequence to your email provider. */
export function PreviewPanel({ project, onWrite }: { project: Project; onWrite: () => void }) {
  const emails = project.marketing.emails;
  const tokens = emailTokens(project);
  if (!emails.length) {
    return (
      <div className="card">
        <Empty
          icon={<Mail />}
          title="No emails yet"
          body="Write the five welcome emails first, then preview and export them here."
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={onWrite}>
              Write the sequence
            </button>
          }
        />
      </div>
    );
  }
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-1">
          Preview & export
          <InfoTip title="Email tools that send it">
            <span className="block">This app doesn’t send email. Set the sequence up as an automation in your email tool, which sends it to everyone who signs up.</span>
            <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {PROVIDERS.map((p) => (
                <a key={p.name} href={p.url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
                  {p.name} <ExternalLink size={12} aria-hidden="true" />
                </a>
              ))}
            </span>
          </InfoTip>
        </span>
      }
      description="Set it up as an automation in your email tool. Values in [brackets] are filled in by it."
      actions={
        <button type="button" className="btn btn-primary btn-sm" onClick={() => download(`${slugify(project.brand.name)}-email-sequence.csv`, sequenceCsv(project))}>
          <Download /> Export CSV
        </button>
      }
    >
      <ol className="flex flex-col gap-6">
        {emails.map((e, i) => (
          <li key={e.id} className="grid grid-cols-1 gap-3 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-6">
            <div className="flex flex-row flex-wrap items-center gap-x-3 gap-y-2 lg:flex-col lg:items-start">
              <div>
                <p className="text-h4 text-ink">Email {i + 1}</p>
                <p className="num font-mono text-caption text-muted">{delayLabel(e, i)}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <CopyButton size="xs" label="Copy subject" text={() => renderTokens(e.subject, tokens)} />
                <CopyButton size="xs" label="Copy body" text={() => e.body} />
              </div>
            </div>
            <BrowserFrame className="max-w-[720px]">
              <EmailView project={project} email={e} tokens={tokens} />
            </BrowserFrame>
          </li>
        ))}
      </ol>
    </Section>
  );
}
