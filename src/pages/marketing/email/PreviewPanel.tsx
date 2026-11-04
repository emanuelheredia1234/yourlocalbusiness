import { Download, ExternalLink, Mail } from 'lucide-react';
import type { Project } from '@/lib/types';
import { slugify } from '@/lib/utils';
import { renderTokens } from '@/ai/local/email';
import { delayLabel, sequenceCsv } from '@/lib/emailFunnel';
import { CopyButton, Empty } from '@/components/ui/primitives';
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
    return <Empty icon={<Mail size={20} />} title="No emails yet" body="Write the 5-email sequence first, then preview and export it here." action={<button className="btn btn-primary btn-sm" onClick={onWrite}>Write the sequence</button>} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <section className="panel flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-[70ch]">
            <h2 className="section-title">Preview & export</h2>
            <p className="text-[13px] text-muted">This app doesn’t send email. Set the sequence up as an automation in your email provider, which sends it to everyone who signs up. Merge values in brackets are placeholders your provider fills in.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary btn-sm" onClick={() => download(`${slugify(project.brand.name)}-email-sequence.csv`, sequenceCsv(project))}>
              <Download size={14} /> Export CSV
            </button>
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
          Email providers:
          {PROVIDERS.map((p) => (
            <a key={p.name} href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              {p.name} <ExternalLink size={11} />
            </a>
          ))}
        </p>
      </section>
      <ol className="flex flex-col gap-4">
        {emails.map((e, i) => (
          <li key={e.id} className="grid grid-cols-1 gap-3 lg:grid-cols-[200px_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
              <p className="text-[13px] font-semibold">Email {i + 1}</p>
              <p className="text-xs text-muted">{delayLabel(e, i)}</p>
              <div className="flex flex-wrap gap-1.5">
                <CopyButton size="xs" label="Copy subject" text={() => renderTokens(e.subject, tokens)} />
                <CopyButton size="xs" label="Copy body" text={() => e.body} />
              </div>
            </div>
            <EmailView project={project} email={e} tokens={tokens} />
          </li>
        ))}
      </ol>
    </div>
  );
}
