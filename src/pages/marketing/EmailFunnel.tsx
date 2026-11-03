import { useState } from 'react';
import { Eye, Gift, Mail, Users } from 'lucide-react';
import { useActiveProject } from '@/store/useStore';
import { Tabs } from '@/components/ui/primitives';
import { MarketingHeader } from './MarketingNav';
import { LeadMagnetPanel } from './email/LeadMagnetPanel';
import { SequencePanel } from './email/SequencePanel';
import { PreviewPanel } from './email/PreviewPanel';
import { Subscribers } from './email/Subscribers';

type Tab = 'magnet' | 'sequence' | 'preview' | 'subscribers';

export default function EmailFunnel() {
  const project = useActiveProject()!;
  const m = project.marketing;
  const [tab, setTab] = useState<Tab>(() => (!m.leadMagnet ? 'magnet' : m.emails.length < 5 ? 'sequence' : 'preview'));

  return (
    <div className="flex flex-col gap-5">
      <MarketingHeader eyebrow="Marketing Hub · Email" title="Email funnel" desc="Write a free lead magnet, its opt-in page and a 5-email welcome sequence, then set them up in your email provider (Kit, Mailchimp, MailerLite…), which collects sign-ups and sends the emails. This app doesn’t send email." />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'magnet', label: 'Lead magnet & opt-in', icon: <Gift size={15} /> },
          { id: 'sequence', label: 'Email sequence', icon: <Mail size={15} />, count: m.emails.length || undefined },
          { id: 'preview', label: 'Preview & export', icon: <Eye size={15} /> },
          { id: 'subscribers', label: 'Subscribers', icon: <Users size={15} />, count: m.subscribers.length || undefined },
        ]}
      />
      {tab === 'magnet' && <LeadMagnetPanel project={project} />}
      {tab === 'sequence' && <SequencePanel project={project} onPreview={() => setTab('preview')} />}
      {tab === 'preview' && <PreviewPanel project={project} onWrite={() => setTab('sequence')} />}
      {tab === 'subscribers' && <Subscribers project={project} />}
    </div>
  );
}
