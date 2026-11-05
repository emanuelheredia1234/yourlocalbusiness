import { useState } from 'react';
import { useActiveProject } from '@/store/useStore';
import { PageHeader, Tabs } from '@/components/ui/primitives';
import { useTabRequest } from '@/store/ui';
import { useNewLeadCount } from '@/store/leads';
import { tabLabel, tabsOf } from '@/lib/pageTabs';
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
  // back from Omnisend's sign-in (?omnisend=…): Preview & export, where its card says how it went; new leads from the
  // page's form: the bell's notice opens Email, and lands here on Leads
  const [tab, setTab] = useState<Tab>(() =>
    !__ARTIFACT_BUILD__ && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('omnisend')
      ? 'preview'
      : !__ARTIFACT_BUILD__ && newLeads > 0
        ? 'leads'
        : !m.leadMagnet
          ? 'magnet'
          : m.emails.length < 5
            ? 'sequence'
            : 'preview',
  );
  // a tab asked for from elsewhere (the assistant)
  useTabRequest<Tab>('marketing-email', (tabsOf('marketing-email') as Tab[]).filter((t) => !__ARTIFACT_BUILD__ || t !== 'leads'), setTab);
  const label = (t: Tab) => tabLabel('marketing-email', t);

  return (
    <div>
      <PageHeader
        className="mb-4"
        title="Email"
        description={__ARTIFACT_BUILD__ ? 'This app doesn’t send email: set these up in your email tool, which sends them.' : 'This app doesn’t send email. Messages from your published page’s form show under Leads.'}
      />
      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'magnet', label: label('magnet') },
          { id: 'sequence', label: label('sequence'), count: m.emails.length || undefined },
          { id: 'preview', label: label('preview') },
          { id: 'subscribers', label: label('subscribers'), count: m.subscribers.length || undefined },
          ...(__ARTIFACT_BUILD__ ? [] : [{ id: 'leads' as const, label: label('leads'), count: newLeads || undefined }]),
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
