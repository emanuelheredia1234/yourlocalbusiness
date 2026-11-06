// Settings › Owner (the app's owner only): one place to reach the owner's pages. Each row opens Customer usage
// (route admin-billing) at its section: the billing overview, Plans (turning plans on) and Ad limits. The server
// checks owner rights on every one of those reads and writes; this list only saves the owner from hunting for them.
import { ArrowRight, BarChart3, CreditCard, Megaphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { SettingsSection } from '@/components/ui/primitives';
import { openOwnerSection, type OwnerSection as Section } from '@/pages/admin/ownerLinks';

const ROWS: { section: Section; title: string; body: string; icon: ReactNode }[] = [
  { section: 'overview', title: 'Billing overview', body: 'Every customer’s usage and costs, caps, and a CSV to bill from.', icon: <BarChart3 /> },
  { section: 'plans', title: 'Plans', body: 'Turn plans on, the free trial, free plans and each customer’s plan.', icon: <CreditCard /> },
  { section: 'ad-limits', title: 'Ad limits', body: 'What customers may launch and spend on ads from the app.', icon: <Megaphone /> },
];

export function OwnerSection() {
  return (
    <div className="flex max-w-[880px] flex-col gap-6">
      <SettingsSection title="Owner" description="Only you see this. Each opens Customer usage at that section.">
        <ul className="flex flex-col divide-y divide-line pb-2">
          {ROWS.map((r) => (
            <li key={r.section}>
              <button type="button" data-owner-section={r.section} className="flex min-h-14 w-full items-center gap-3 py-3 text-left transition-colors duration-120 hover:bg-surface-2" onClick={() => void openOwnerSection(r.section)}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2 [&>svg]:size-4">{r.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-ui text-ink">{r.title}</span>
                  <span className="block text-small text-muted">{r.body}</span>
                </span>
                <ArrowRight size={16} className="shrink-0 text-muted" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </SettingsSection>
    </div>
  );
}
