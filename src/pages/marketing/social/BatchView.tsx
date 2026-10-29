import { useMemo, useState } from 'react';
import { CalendarCheck, CalendarClock, CheckSquare, Layers, Square, Trash2 } from 'lucide-react';
import type { Post, Project } from '@/lib/types';
import { cn, fmtDate, isoToDateStr } from '@/lib/utils';
import { contentBatchTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { navigate } from '@/lib/router';
import { getActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { Empty, Segmented, confirmAction } from '@/components/ui/primitives';
import { PostCard, schedulePostsFlow } from '@/components/posts/PostCard';

export function BatchView({ project, posts, covered }: { project: Project; posts: Post[]; covered: Set<string> }) {
  const plan = project.marketing.plan;
  const addPosts = useStore((s) => s.addPosts);
  const deletePosts = useStore((s) => s.deletePosts);
  const updateMarketing = useStore((s) => s.updateMarketing);
  const ai = useAI(contentBatchTask);
  const [filter, setFilter] = useState<'draft' | 'scheduled' | 'all'>('draft');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const offset = useMemo(() => {
    if (!plan) return 0;
    const i = plan.days.findIndex((d) => d.slots.some((s) => !covered.has(s.id)));
    return i === -1 ? plan.days.length : i;
  }, [plan, covered]);
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
    const p = getActiveProject()!;
    if (!p.marketing.plan) return;
    const r = await ai.run({ plan: { ...p.marketing.plan, days: p.marketing.plan.days.slice(offset) }, config: p.marketing.campaign, days: 7 });
    if (r && r.length) {
      addPosts(r);
      updateMarketing({ batchId: r[0].batchId });
      setFilter('draft');
      setSelected(new Set());
    }
  };

  const toggle = (id: string, v: boolean) => setSelected((s) => {
    const n = new Set(s);
    if (v) n.add(id);
    else n.delete(id);
    return n;
  });
  const selectable = shown.filter((p) => p.status === 'draft');
  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.id));
  const selDrafts = [...selected].filter((id) => drafts.some((d) => d.id === id));

  if (!plan) {
    return <Empty icon={<Layers size={20} />} title="Create the 30-day plan first" body="The 7-day batch turns the first week of your plan into ready-to-publish posts." />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-title">Ready-to-publish posts</h2>
          <p className="text-[13px] text-muted">
            {complete ? 'Every slot in your 30-day plan has a post.' : `Next batch covers ${fmtDate(plan.days[offset].date)} – ${fmtDate(plan.days[Math.min(plan.days.length - 1, offset + 6)].date)}.`} Each post has a visual mockup, caption (hook, body, CTA), hashtags, platform and time.
          </p>
        </div>
        <GenerateButton running={ai.running} onClick={generate} disabled={complete}>
          {posts.length ? 'Generate next 7 days' : 'Generate 7-day batch'}
        </GenerateButton>
      </div>
      <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
      {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}

      {posts.length > 0 && (
        <div className="panel sticky top-0 z-20 flex flex-wrap items-center gap-2 px-3 py-2">
          <Segmented
            size="sm"
            value={filter}
            onChange={(f) => {
              setFilter(f);
              setSelected(new Set());
            }}
            options={[
              { id: 'draft', label: `Drafts (${drafts.length})` },
              { id: 'scheduled', label: `Scheduled (${posts.filter((p) => p.status === 'scheduled').length})` },
              { id: 'all', label: 'All upcoming' },
            ]}
          />
          {selectable.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((p) => p.id)))}>
              {allSelected ? <CheckSquare size={14} /> : <Square size={14} />} {allSelected ? 'Clear' : 'Select all'}
            </button>
          )}
          <div className="ml-auto flex flex-wrap gap-1.5">
            {selDrafts.length > 0 && (
              <>
                <button
                  className="btn btn-ghost btn-sm text-muted hover:text-bad"
                  onClick={async () => {
                    if (await confirmAction({ title: `Delete ${selDrafts.length} draft${selDrafts.length > 1 ? 's' : ''}?`, confirmLabel: 'Delete', danger: true })) {
                      deletePosts(selDrafts);
                      setSelected(new Set());
                    }
                  }}
                >
                  <Trash2 size={14} /> Delete
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    if (await schedulePostsFlow(selDrafts)) setSelected(new Set());
                  }}
                >
                  <CalendarClock size={14} /> Schedule selected ({selDrafts.length})
                </button>
              </>
            )}
            {drafts.length > 0 && (
              <button className="btn btn-primary btn-sm" onClick={() => schedulePostsFlow(drafts.map((d) => d.id))}>
                <CalendarCheck size={14} /> Schedule whole batch ({drafts.length})
              </button>
            )}
            {posts.some((p) => p.status === 'scheduled') && (
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('calendar')}>
                Open queue →
              </button>
            )}
          </div>
        </div>
      )}

      {!posts.length && !ai.running ? (
        <Empty icon={<Layers size={20} />} title="No posts generated yet" body="Generate the first seven days of your plan: every post comes with a visual mockup, caption and hashtags you can edit inline." action={<GenerateButton running={ai.running} onClick={generate}>Generate 7-day batch</GenerateButton>} />
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted">{filter === 'draft' ? 'No drafts left. Everything in this batch is scheduled.' : 'Nothing here yet.'}</p>
      ) : (
        byDay.map(([date, list]) => (
          <section key={date} aria-label={fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' })}>
            <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
              {fmtDate(date, { weekday: 'long', month: 'short', day: 'numeric' })}
              <span className="text-xs font-normal text-muted">
                {list.length} post{list.length > 1 ? 's' : ''}
              </span>
            </h3>
            <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3')}>
              {list.map((p) => (
                <PostCard key={p.id} post={p} brand={project.brand} selectable={p.status === 'draft'} selected={selected.has(p.id)} onSelect={(v) => toggle(p.id, v)} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
