import { useState } from 'react';
import { Gift, Mail, Send, Users } from 'lucide-react';
import { useActiveProject } from '@/store/useStore';
import { Tabs } from '@/components/ui/primitives';
import { MarketingHeader } from './MarketingNav';
import { LeadMagnetPanel } from './email/LeadMagnetPanel';
import { SequencePanel } from './email/SequencePanel';
import { SimulatePanel } from './email/SimulatePanel';
import { Subscribers } from './email/Subscribers';

type Tab = 'magnet' | 'sequence' | 'simulate' | 'subscribers';

export default function EmailFunnel() {
  const project = useActiveProject()!;
  const m = project.marketing;
  const [tab, setTab] = useState<Tab>(() => (!m.leadMagnet ? 'magnet' : m.emails.length < 5 ? 'sequence' : 'simulate'));
  const [simSub, setSimSub] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <MarketingHeader eyebrow="Marketing Hub · Email" title="Email funnel" desc="Turn visitors into subscribers with a free lead magnet, then nurture them to a sale with five automated emails. Test the whole flow with a simulated subscriber." />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'magnet', label: 'Lead magnet & opt-in', icon: <Gift size={15} /> },
          { id: 'sequence', label: 'Email sequence', icon: <Mail size={15} />, count: m.emails.length || undefined },
          { id: 'simulate', label: 'Simulate & send', icon: <Send size={15} /> },
          { id: 'subscribers', label: 'Subscribers', icon: <Users size={15} />, count: m.subscribers.length || undefined },
        ]}
      />
      {tab === 'magnet' && (
        <LeadMagnetPanel
          project={project}
          onSimulate={(id) => {
            setSimSub(id);
            setTab(m.emails.length ? 'simulate' : 'sequence');
          }}
        />
      )}
      {tab === 'sequence' && <SequencePanel project={project} onSimulate={() => setTab('simulate')} />}
      {tab === 'simulate' && <SimulatePanel project={project} initialSubId={simSub} onWrite={() => setTab('sequence')} />}
      {tab === 'subscribers' && <Subscribers project={project} />}
    </div>
  );
}
