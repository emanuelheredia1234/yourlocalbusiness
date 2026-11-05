import { useMemo, useState, type ReactNode } from 'react';
import { CalendarCheck, CalendarClock, CheckSquare, Square, Trash2 } from 'lucide-react';
import type { Post, Project } from '@/lib/types';
import { fmtDate, isoToDateStr } from '@/lib/utils';
import { contentBatchTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { navigate } from '@/lib/router';
import { getActiveProject, useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { Empty, Segmented, confirmAction } from '@/components/ui/primitives';
import { PostCard } from '@/components/posts/PostCard';
import { addToCalendarFlow } from '@/components/posts/PostActions';
import { applyWeekBatch, batchStart, weekBatchInput } from '@/ai/socialPlan';

export function BatchView({ project, posts, covered, planAction }: { project: Project; posts: Post[]; covered: Set<string>; /** the 30-day plan's button, offered here before there's a plan */ planAction?: ReactNode }) {
  const plan = project.marketing.plan;
  const deletePosts = useStore((s) => s.deletePosts);
  const ai = useAI(contentBatchTask);
  const [filter, setFilter] = useState<'draft' | 'scheduled' | 'all'>('draft');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const offset = useMemo(() => (plan ? batchStart(plan, covered) : 0), [plan, covered]);
  const complete = !!plan && offset >= plan.days.length;
  const shown = posts.filter((p) => (filter === 'all' ? p.status !== 'published' : p.status === filter));
  const drafts = posts.filter((p) => p.status === 'draft');
  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const p of shown) {
      const k = isoToDateStr(p.scheduledAt);
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  const generate = async () => {
    // the plan from its first day without posts (the batch's own posts say which slots have one)
    const input = weekBatchInput(getActiveProject()!, covered);
    if (!input) return;
    const r = await ai.run(input);
    if (r && r.length) {
      applyWeekBatch(r);
      setFilter('draft');
      setSelected(new Set());
    }
  };

  const toggle = (id: string, v: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (v) n.add(id);
      else n.delete(id);
      return n;
    });
  const selectable = shown.filter((p) => p.status === 'draft');
  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.id));
  const selDrafts = [...selected].filter((id) => drafts.some((d) => d.id === id));

  if (!plan) {
    return (
      <Empty
        variant="ai"
        title="Plan your month first"
        body="The 7-day batch turns the first week of your 30-day plan into posts that are ready to go out."
        action={
          <>
            {planAction}
            <button type="button" className={planAction ? 'btn btn-ghost' : 'btn btn-secondary'} onClick={() => useUI.getState().setSocialTab('setup')}>
              Review the setup
            </button>
          </>
        }
      />
    );
  }

  const range = complete ? 'Every slot in your 30-day plan has a post.' : `Next batch: ${fmtDate(plan.days[offset].date)} – ${fmtDate(plan.days[Math.min(plan.days.length - 1, offset + 6)].date)}`;
  const thinking = <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />;
  const resultBar = ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />;

  if (!posts.length) {
    return (
      <div className="flex flex-col gap-4">
        {ai.running ? (
          thinking
        ) : (
          <Empty
            variant="ai"
            title="Your week is wide open"
            body={`Generate seven days of posts from your plan, or make a single post. ${range}.`}
            action={
              <>
                <GenerateButton variant="ai" size="lg" running={ai.running} runningLabel="Writing…" onClick={generate} disabled={complete}>
                  Generate 7-day batch
                </GenerateButton>
                <button type="button" className="btn btn-ghost" onClick={() => useUI.getState().openComposer()}>
                  Make a single post
                </button>
              </>
            }
          />
        )}
        {resultBar}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h3 text-ink">Ready-to-post</h2>
          <p className="mt-0.5 text-small text-muted">{range}</p>
        </div>
        <GenerateButton size="sm" running={ai.running} runningLabel="Writing…" onClick={generate} disabled={complete}>
          Generate next 7 days
        </GenerateButton>
      </div>
      {thinking}
      {resultBar}

      <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-2 border-b border-line bg-surface px-1 py-2">
        <Segmented
          size="sm"
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setSelected(new Set());
          }}
          options={[
            { id: 'draft', label: `Drafts (${drafts.length})` },
            { id: 'scheduled', label: `Planned (${posts.filter((p) => p.status === 'scheduled').length})` },
            { id: 'all', label: 'All upcoming' },
          ]}
        />
        {selectable.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((p) => p.id)))}>
            {allSelected ? <CheckSquare /> : <Square />} {allSelected ? 'Clear' : 'Select all'}
          </button>
        )}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {selDrafts.length > 0 ? (
            <>
              <button
                type="button"
                className="btn btn-danger-ghost btn-sm"
                onClick={async () => {
                  if (await confirmAction({ title: `Delete ${selDrafts.length} draft${selDrafts.length > 1 ? 's' : ''}?`, confirmLabel: 'Delete', danger: true })) {
                    deletePosts(selDrafts);
                    setSelected(new Set());
                  }
                }}
              >
                <Trash2 /> Delete
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  if (addToCalendarFlow(selDrafts)) setSelected(new Set());
                }}
              >
                <CalendarClock /> Add selected to calendar ({selDrafts.length})
              </button>
            </>
          ) : (
            <>
              {posts.some((p) => p.status === 'scheduled') && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('calendar')}>
                  Open calendar
                </button>
              )}
              {drafts.length > 0 && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => addToCalendarFlow(drafts.map((d) => d.id))}>
                  <CalendarCheck /> Add whole batch to calendar ({drafts.length})
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty variant="inline" className="justify-center py-8" title={filter === 'draft' ? 'No drafts left. Everything in this batch is on your calendar.' : 'Nothing here yet.'} />
      ) : (
        // one grid, so a week of posts fills every column; each day's name sits above its first post
        <ol className="grid grid-cols-1 items-start gap-x-4 gap-y-6 sm:grid-cols-2 xl:grid-cols-3" aria-label="Posts by day">
          {byDay.flatMap(([date, list]) =>
            list.map((p, i) => (
              <li key={p.id} className="flex min-w-0 flex-col gap-2">
                {i === 0 ? (
                  <h3 className="flex h-6 items-baseline gap-2">
                    <span className="truncate text-h4 text-ink">{fmtDate(date, { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                    <span className="shrink-0 text-caption text-muted">
                      {list.length} post{list.length > 1 ? 's' : ''}
                    </span>
                  </h3>
                ) : (
                  <p className="h-6 max-sm:hidden">
                    <span className="sr-only">{fmtDate(date, { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                  </p>
                )}
                <PostCard post={p} brand={project.brand} selectable={p.status === 'draft'} selected={selected.has(p.id)} onSelect={(v) => toggle(p.id, v)} />
              </li>
            )),
          )}
        </ol>
      )}
    </div>
  );
}
