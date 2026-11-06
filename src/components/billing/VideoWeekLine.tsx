// "2 of 3 videos used this week · resets Monday" for a business (the video panel and the campaign setup), with an
// upgrade link once the week is used up. Shown only with plans on the self-hosted app; the server decides.

import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import { videoWeekFull, videoWeekLine } from '@/lib/videoWeek';
import { useBillingOn } from '@/store/billing';
import { useProjectVideoWeek } from '@/store/videoWeek';

export function VideoWeekLine({ projectId, className }: { projectId: string | null | undefined; className?: string }) {
  const on = useBillingOn();
  const w = useProjectVideoWeek(on && !__ARTIFACT_BUILD__ ? projectId : null);
  const line = on ? videoWeekLine(w) : null;
  if (!line) return null;
  const full = videoWeekFull(w);
  return (
    <p className={cn('num text-small', full ? 'text-warn' : 'text-muted', className)}>
      {line}
      {full && (
        <>
          {' · '}
          <button type="button" className="link text-small" onClick={() => void navigate('plans', { force: true })}>
            Upgrade for more
          </button>
        </>
      )}
    </p>
  );
}
