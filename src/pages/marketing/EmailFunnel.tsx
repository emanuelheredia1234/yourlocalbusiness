import { useState } from 'react';
import { Eye, Gift, Inbox, Mail, Users } from 'lucide-react';
import { useActiveProject } from '@/store/useStore';
import { Tabs } from '@/components/ui/primitives';
import { useTabRequest } from '@/store/ui';
import { useNewLeadCount } from '@/store/leads';
import { tabsOf } from '@/lib/pageTabs';
import { MarketingHeader } from './MarketingNav';
import { LeadMagnetPanel } from './email/LeadMagnetPanel';
import { SequencePanel } from './email/SequencePanel';
import { PreviewPanel } from './email/PreviewPanel';
import { Subscribers } from './email/Subscribers';
import { Leads } from './email/Leads';

type Tab = 'magnet' | 'sequence' | 'preview' | 'subscribers' | 'leads';

export default function EmailFunnel() {
  const project = useActiveProject()!;
  const m = project.marketing;
  const newLeads = useNewLeadCount(project);
  // new leads from the page's form: the bell's notice opens Email, and lands here on Leads
  const [tab, setTab] = useState<Tab>(() => (!__ARTIFACT_BUILD__ && newLeads > 0 ? 'leads' : !m.leadMagnet ? 'magnet' : m.emails.length < 5 ? 'sequence' : 'preview'));
  // a tab asked for from elsewhere (the assistant)
  useTabRequest<Tab>('marketing-email', (tabsOf('marketing-email') as Tab[]).filter((t) => !__ARTIFACT_BUILD__ || t !== 'leads'), setTab);

  return (
    <div className="flex flex-col gap-5">
      <MarketingHeader eyebrow="Marketing Hub · Email" title="Email funnel" desc={`Write a free lead magnet, its opt-in page and a 5-email welcome sequence, then set them up in your email provider (Kit, Mailchimp, MailerLite…), which collects sign-ups and sends the emails. This app doesn’t send email.${__ARTIFACT_BUILD__ ? '' : ' Messages from your published page’s form show under Leads.'}`} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'magnet', label: 'Lead magnet & opt-in', icon: <Gift size={15} /> },
          { id: 'sequence', label: 'Email sequence', icon: <Mail size={15} />, count: m.emails.length || undefined },
          { id: 'preview', label: 'Preview & export', icon: <Eye size={15} /> },
          { id: 'subscribers', label: 'Subscribers', icon: <Users size={15} />, count: m.subscribers.length || undefined },
          ...(__ARTIFACT_BUILD__ ? [] : [{ id: 'leads' as const, label: 'Leads', icon: <Inbox size={15} />, count: newLeads || undefined }]),
        ]}
      />
      {tab === 'magnet' && <LeadMagnetPanel project={project} />}
      {tab === 'sequence' && <SequencePanel project={project} onPreview={() => setTab('preview')} />}
      {tab === 'preview' && <PreviewPanel project={project} onWrite={() => setTab('sequence')} />}
      {tab === 'subscribers' && <Subscribers project={project} />}
      {!__ARTIFACT_BUILD__ && tab === 'leads' && <Leads project={project} />}
    </div>
  );
}
