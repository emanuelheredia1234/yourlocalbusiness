// "Test A/B · version B" on a post that is a version in an A/B test: opens the test's card (P4b §A3).
import { FlaskConical } from 'lucide-react';
import type { Post } from '@/lib/types';
import { openExperimentCard } from '@/store/experiments';

export function ExperimentBadge({ post }: { post: Pick<Post, 'experiment'> }) {
  const ref = post.experiment;
  if (!ref || __ARTIFACT_BUILD__) return null;
  return (
    <button type="button" className="btn btn-ghost btn-xs self-start" onClick={() => void openExperimentCard(ref.id)} data-testid="ab-badge">
      <FlaskConical /> Test A/B · version {ref.key.toUpperCase()}
    </button>
  );
}
