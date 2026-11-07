// One A/B test (P4b §A3, §A5, §A6): its versions (for posts: thumbnail, label, planned time, state, and Post now in
// order and after the 12-hour gap, with the reason when it can't go yet), its results, and Update results, Stop test
// and Use the winner (or "Pick one anyway" when it's too close to call or a tie). Posting goes through the same
// confirm window as any post: one press, one attempt, never sent twice by itself.

import { useState } from 'react';
import { FlaskConical, RefreshCw, Send, Square, Trash2, Trophy, Type } from 'lucide-react';
import type { Experiment, Post, VariantKey } from '@/lib/types';
import { fmtDateTime } from '@/lib/utils';
import { useStore } from '@/store/useStore';
import { useExperiments } from '@/store/experiments';
import { deleteExperiment, experimentErrorCopy, refreshExperiment, stopExperiment } from '@/lib/experiments/api';
import { CHANGED_LABEL, versionName } from '@/lib/experiments/math';
import { alsoChanged, postDiff, postNowGate } from '@/lib/experiments/variants';
import { applyWinner, rewriteUpcoming } from '@/lib/experiments/winner';
import { shareModeLabel } from '@/lib/trialReels';
import { networkLabel } from '@/ai/postShared';
import { Badge, Callout, Spinner, confirmAction } from '../ui/primitives';
import { MediaThumb } from '../media/MediaUpload';
import { usePublishConfirm } from '../posts/PublishConfirm';
import { ResultPanel } from './ResultPanel';

const STATE_LABEL: Record<Experiment['state'], string> = { draft: 'Draft', running: 'Running', finished: 'Finished', stopped: 'Stopped', cancelled: 'Cancelled' };
const STATE_TONE: Record<Experiment['state'], 'neutral' | 'good' | 'primary' | 'warn'> = { draft: 'neutral', running: 'primary', finished: 'good', stopped: 'warn', cancelled: 'neutral' };

/** When a version's post went out (for the 12-hour gap): its own time, else when the app sent it. */
export function postedAtOf(post: Post | undefined): number | null {
  if (!post) return null;
  if (post.publishedAt && Number.isFinite(Date.parse(post.publishedAt))) return Date.parse(post.publishedAt);
  if (post.external?.via === 'api' && post.external.requestedAt) return post.external.requestedAt;
  return null;
}

/** A version's post state in plain words. */
export function postStateLabel(post: Post | undefined, jobId: string | null): string {
  if (!post) return 'Removed';
  if (post.status === 'published') return 'Posted';
  const s = post.external?.via === 'api' ? post.external.state : null;
  if (s === 'working') return 'Posting…';
  if (s === 'unknown') return 'Check again';
  if (s === 'failed') return 'Failed';
  return jobId ? 'Sent' : 'Planned';
}

/** Whether the versions differ in more than the one thing (posts: any edit outside the chosen piece). */
export function moreThanOne(e: Experiment, posts: Post[]): boolean {
  if (e.kind !== 'post' || e.changed === 'time') return false;
  const byKey = (k: VariantKey) => posts.find((p) => p.id === e.variants.find((v) => v.key === k)?.postId);
  const a = byKey('a');
  if (!a) return false;
  return e.variants.some((v) => {
    const p = v.key === 'a' ? undefined : byKey(v.key);
    return !!p && alsoChanged(e.changed, postDiff(a, p)).length > 0;
  });
}

export function ExperimentCard({ experiment: e, now = Date.now() }: { experiment: Experiment; now?: number }) {
  const posts = useStore((s) => s.posts);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [upcoming, setUpcoming] = useState<Post[] | null>(null);
  const [rewritten, setRewritten] = useState<number | null>(null);
  const postOf = (id: string | null) => (id ? posts.find((p) => p.id === id) : undefined);
  const refreshAt = e.refreshAt ? Date.parse(e.refreshAt) : 0;
  const canRefresh = (e.state === 'running' || e.state === 'finished') && (!refreshAt || refreshAt <= now);
  const verdict = e.result.verdict;
  const anyway = verdict === 'too_close' || verdict === 'tie';
  const canPick = !e.winner && (e.state === 'running' || e.state === 'finished' || e.state === 'stopped') && (verdict === 'winner' || anyway);

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(experimentErrorCopy(err));
    } finally {
      setBusy('');
    }
  };
  const refresh = () => run('Updating…', async () => useExperiments.getState().upsert((await refreshExperiment(e.id)).experiment));
  const stop = () =>
    run('Stopping…', async () => {
      if (!(await confirmAction({ title: 'Stop this A/B test?', body: e.kind === 'page' ? 'Everyone sees version A again and visits stop counting. Nothing already posted or sent changes.' : 'Nothing already posted is touched. The versions not posted yet stay as normal posts.', confirmLabel: 'Stop test' }))) return;
      useExperiments.getState().upsert((await stopExperiment(e.id)).experiment);
    });
  const remove = () =>
    run('Deleting…', async () => {
      if (!(await confirmAction({ title: 'Delete this draft test?', body: 'Its versions stay as normal posts.', confirmLabel: 'Delete', danger: true }))) return;
      await deleteExperiment(e.id);
      useExperiments.getState().drop(e.projectId, e.id);
      const s = useStore.getState();
      for (const v of e.variants) if (v.postId) s.updatePost(v.postId, { experiment: undefined });
    });
  const pick = (key: VariantKey) =>
    run('Saving the winner…', async () => {
      if (anyway && !(await confirmAction({ title: `Use ${versionName(key)} anyway?`, body: 'The numbers didn’t call it, so this is your own pick. The test will say so.', confirmLabel: `Use ${versionName(key)}` }))) return;
      const out = await applyWinner(e, key, { override: verdict !== 'winner' });
      if (out.upcoming.length) setUpcoming(out.upcoming);
    });
  const rewrite = () =>
    run('Rewriting…', async () => {
      if (!upcoming?.length) return;
      if (!(await confirmAction({ title: `Rewrite ${upcoming.length} upcoming post${upcoming.length === 1 ? '' : 's'}?`, body: 'Each one is rewritten by the AI in the winning style. This uses AI credits, about one request per post.', confirmLabel: 'Rewrite them' }))) return;
      setRewritten(await rewriteUpcoming(upcoming.map((p) => p.id)));
      setUpcoming(null);
    });

  return (
    <article className="card flex flex-col gap-4 p-4" data-testid={`experiment-${e.id}`}>
      <header className="flex flex-wrap items-start gap-2">
        <FlaskConical size={18} className="mt-0.5 text-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-h4 text-ink">{e.name || 'A/B test'}</h3>
          <p className="text-small text-muted">
            {e.kind === 'post' ? `${networkLabel(e.network ?? 'instagram')} post` : e.kind === 'email' ? 'Email' : 'SEO page'} · testing {CHANGED_LABEL[e.changed].toLowerCase()}
            {e.mode === 'trial_reels' ? ' · Trial Reels' : e.mode === 'times' ? ' · different times' : e.mode === 'split' && e.kind === 'email' ? ' · two drafts' : ''}
          </p>
        </div>
        <Badge tone={STATE_TONE[e.state]}>{STATE_LABEL[e.state]}</Badge>
      </header>

      {e.kind === 'post' && (
        <ul className="flex flex-col gap-2">
          {e.variants.map((v) => {
            const post = postOf(v.postId);
            const gate = postNowGate(e, v.key, (id) => postedAtOf(postOf(id)), now);
            const posted = !!v.jobId || post?.status === 'published';
            return (
              <li key={v.key} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-3 py-2" data-testid={`variant-${v.key}`}>
                {post?.media ? (
                  <MediaThumb media={post.media} className="h-12 w-12 shrink-0" />
                ) : (
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                    <Type size={16} aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-small font-medium text-ink">
                    {versionName(v.key)}
                    {v.label ? ` · ${v.label}` : ''}
                  </p>
                  <p className="text-caption text-muted">
                    {v.plannedAt ? `Planned ${fmtDateTime(v.plannedAt)} · ` : ''}
                    {postStateLabel(post, v.jobId)}
                    {v.shareMode && v.shareMode !== 'CUSTOM' ? ` · ${shareModeLabel(v.shareMode)}` : ''}
                  </p>
                  {!posted && !gate.ok && gate.reason && <p className="text-caption text-muted">{gate.reason}</p>}
                </div>
                {!posted && post && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={!gate.ok} title={gate.ok ? undefined : gate.reason} onClick={() => usePublishConfirm.getState().open(post.id)}>
                    <Send /> Post now
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {e.state !== 'draft' && e.state !== 'cancelled' && <ResultPanel experiment={e} alsoChanged={moreThanOne(e, posts)} />}
      {e.state === 'draft' && e.kind === 'post' && <p className="text-small text-muted">Post version A to start the test. It counts as one of this month’s A/B tests then.</p>}

      {upcoming && upcoming.length > 0 && (
        <Callout tone="good" title="Winner saved, and your Brain learned it">
          Use it on what’s coming up too?{' '}
          <button type="button" className="btn btn-secondary btn-xs ml-1" disabled={!!busy} onClick={() => void rewrite()}>
            Rewrite {upcoming.length} upcoming post{upcoming.length === 1 ? '' : 's'} in this style
          </button>
        </Callout>
      )}
      {rewritten != null && <p className="text-small text-muted">{rewritten} upcoming post{rewritten === 1 ? '' : 's'} rewritten.</p>}
      {error && <Callout tone="bad">{error}</Callout>}

      <footer className="flex flex-wrap items-center gap-2">
        {(e.state === 'running' || e.state === 'finished') && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={!canRefresh || !!busy} onClick={() => void refresh()} title={canRefresh ? undefined : e.refreshAt ? `Again after ${fmtDateTime(e.refreshAt)}` : undefined}>
            <RefreshCw /> Update results
          </button>
        )}
        {canPick &&
          (verdict === 'winner' && e.result.winner ? (
            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void pick(e.result.winner!)}>
              <Trophy /> Use the winner
            </button>
          ) : (
            e.variants.map((v) => (
              <button key={v.key} type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void pick(v.key)}>
                Pick {v.key.toUpperCase()} anyway
              </button>
            ))
          ))}
        {e.state === 'running' && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void stop()}>
            <Square /> Stop test
          </button>
        )}
        {(e.state === 'draft' || e.state === 'cancelled') && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void remove()}>
            <Trash2 /> Delete
          </button>
        )}
        {e.winner && <span className="text-small text-muted">{versionName(e.winner)} is in use{e.result.pickedByYou ? ' (your pick)' : ''}.</span>}
        {busy && (
          <span className="flex items-center gap-1.5 text-small text-muted">
            <Spinner /> {busy}
          </span>
        )}
      </footer>
    </article>
  );
}
