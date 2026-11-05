// The owner's per-customer usage (route admin-billing, linked from Settings for the owner only). WP5 builds the
// page: reconcile against treg, caps per customer, and the CSV to bill from. The server answers its data to
// admins only, so this placeholder shows nothing private.
import { Receipt } from 'lucide-react';
import { Empty, PageHeader } from '@/components/ui/primitives';

export default function Billing() {
  return (
    <div>
      <PageHeader className="mb-4" title="Customer usage" description="What each customer’s analytics and connected accounts cost, to bill from." />
      {__ARTIFACT_BUILD__ ? (
        <Empty icon={<Receipt />} title="Customer usage needs the full app" body="It reads usage from your server, which this version doesn’t have." />
      ) : (
        <Empty icon={<Receipt />} title="Customer usage is coming soon" body="Usage per customer, caps and a CSV to bill from will show here." />
      )}
    </div>
  );
}
