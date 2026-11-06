// Projects the account refused to save because the plan has no free business slot (sync set them aside on this
// device). A quiet note per project: Add a business (then its slot is claimed and it saves), or Remove from this
// device (never deleted from the account).

import { useSyncStatus } from '@/lib/cloud/sync';
import { dropHeld, releaseHeld } from '@/lib/cloud/auth';
import { claimSlot } from '@/lib/cloud/slots';
import { useStore } from '@/store/useStore';
import { useBilling, useBillingOn } from '@/store/billing';
import { toast } from '@/store/ui';
import { Callout, confirmAction } from '@/components/ui/primitives';

/** Claim the slot for a held project and save it (after a business was added, or the plan has room now). */
export async function saveHeldProject(id: string): Promise<boolean> {
  const r = await claimSlot(id);
  if (!r.ok) return false;
  releaseHeld([id]);
  return true;
}

export function HeldProjectsNotice({ className }: { className?: string }) {
  const held = useSyncStatus((s) => s.held);
  const projects = useStore((s) => s.projects);
  const on = useBillingOn();
  const canBuy = useBilling((s) => s.account?.source === 'stripe' && !!s.plan?.active);
  if (!on || !held.length) return null;
  const items = held.map((id) => ({ id, name: projects.find((p) => p.id === id)?.brand.name || 'Untitled project' }));
  return (
    <div className={className} aria-label="Businesses not saved to your account">
      {items.map(({ id, name }) => (
        <Callout
          key={id}
          tone="warn"
          className="mb-2 last:mb-0"
          action={
            <>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={async () => {
                  // the plan may have room now (a business was deleted): claim first, buy only if that's refused
                  if (await saveHeldProject(id)) return toast({ kind: 'success', title: `${name} is saving to your account` });
                  if (canBuy) useBilling.getState().openAddBusiness(async () => void (await saveHeldProject(id)));
                  else toast({ kind: 'info', title: 'Choose a plan with room for another business in Settings › Plan.' });
                }}
              >
                Add a business
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={async () => {
                  if (await confirmAction({ title: `Remove ${name} from this device?`, body: 'Anything in it that isn’t in your account is lost. Export a backup first if you might need it.', confirmLabel: 'Remove from this device', danger: true })) dropHeld(id);
                }}
              >
                Remove from this device
              </button>
            </>
          }
        >
          <strong className="font-medium text-ink">{name}</strong> isn’t saved to your account: your plan has no free business slot.
        </Callout>
      ))}
    </div>
  );
}
