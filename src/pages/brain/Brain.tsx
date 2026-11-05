import { useMemo, useRef, useState } from 'react';
import { Activity, Brain as BrainIcon, Check, Copy, FileUp, Pencil, Plus, ThumbsDown, ThumbsUp, Trash2, Upload } from 'lucide-react';
import type { GenerationLog, Skill, SkillCategory } from '@/lib/types';
import { cn, fmtBytes, fmtDateTime, fmtRelative, readFileAsText, uid } from '@/lib/utils';
import { copyText } from '@/lib/platform';
import { CATEGORY_META, SCOPE_META, SKILL_LIBRARY, describeDirectives, effectiveDirectives, skillFromLibrary, templatePlaceholders } from '@/ai/brain';
import { MAX_DOC, knowledgeDocSkill, playgroundSets } from '@/ai/brainSkills';
import { providerLabel } from '@/ai/engine';
import { metaDetails } from '@/ai/meta';
import { skillTestTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast, useTabRequest } from '@/store/ui';
import { tabsOf } from '@/lib/pageTabs';
import { AIResultBar, AIThinking, AiCard, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, Callout, Empty, Field, MoreMenu, PageHeader, Popover, Section, Segmented, Select, Tabs, Toggle, confirmAction } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { SkillEditor } from './SkillEditor';

type Tab = 'skills' | 'library' | 'docs' | 'playground' | 'log';

const DAY = 24 * 3600_000;
const PRIORITY: Record<Skill['priority'], string> = { 1: 'Low priority', 2: 'Normal priority', 3: 'High priority' };

/** The rules a skill adds, as short phrases ("Tone: friendly", "Avoid: …"). */
const rulesOf = (s: Skill) => describeDirectives(effectiveDirectives(s));

export default function Brain() {
  const skills = useStore((s) => s.skills);
  const genLog = useStore((s) => s.genLog);
  const useBrain = useStore((s) => s.settings.ai.useBrain);
  const updateSettings = useStore((s) => s.updateSettings);
  const [tab, setTab] = useState<Tab>('skills');
  // a tab asked for from elsewhere (the assistant)
  useTabRequest<Tab>('brain', tabsOf('brain') as Tab[], setTab);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const on = skills.filter((s) => s.enabled).length;
  const weekAgo = Date.now() - 7 * DAY;
  const usedThisWeek = genLog.filter((g) => g.createdAt >= weekAgo && g.skillIds.length > 0).length;
  const learned = skills.filter((s) => s.source === 'feedback').reduce((n, s) => n + rulesOf(s).length, 0);
  const summary = [`${on} skill${on === 1 ? '' : 's'} on`, `used ${usedThisWeek} time${usedThisWeek === 1 ? '' : 's'} this week`, learned ? `${learned} learned preference${learned === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');

  const openEditor = (s: Skill | null) => {
    setEditing(s);
    setEditorOpen(true);
  };

  return (
    <div>
      <PageHeader
        className="mb-4"
        title="Brain"
        description="What the AI reads before it writes: your voice, customers, rules and facts."
        meta={<span className="num max-sm:hidden">{summary}</span>}
        actions={
          <>
            <Toggle checked={useBrain} onChange={(v) => updateSettings((s) => ({ ...s, ai: { ...s.ai, useBrain: v } }))} label={useBrain ? 'Brain on' : 'Brain off'} />
            <button type="button" className="btn btn-primary ml-2" onClick={() => openEditor(null)}>
              <Plus /> New skill
            </button>
          </>
        }
      />

      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'skills', label: 'Skills', count: skills.length },
          { id: 'library', label: 'Library' },
          { id: 'docs', label: 'Knowledge', count: skills.filter((s) => s.source === 'document').length || undefined },
          { id: 'playground', label: 'Playground' },
          { id: 'log', label: 'Activity' },
        ]}
      />

      {!useBrain && (
        <Callout tone="warn" className="mb-5" action={<button type="button" className="btn btn-secondary btn-xs" onClick={() => updateSettings((s) => ({ ...s, ai: { ...s.ai, useBrain: true } }))}>Turn it on</button>}>
          The Brain is off: generations ignore every skill until you turn it back on.
        </Callout>
      )}

      {tab === 'skills' && <SkillList onEdit={openEditor} onNew={() => openEditor(null)} />}
      {tab === 'library' && <LibraryGrid />}
      {tab === 'docs' && <KnowledgeDocs />}
      {tab === 'playground' && <Playground />}
      {tab === 'log' && <ActivityLog />}

      <SkillEditor open={editorOpen} onClose={() => setEditorOpen(false)} skill={editing} />
    </div>
  );
}

/** A 32px neutral tile with the category's icon. */
function CategoryTile({ category }: { category: SkillCategory }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2">
      <Icon name={CATEGORY_META[category].icon} size={16} />
    </span>
  );
}

function SkillList({ onEdit, onNew }: { onEdit: (s: Skill) => void; onNew: () => void }) {
  const skills = useStore((s) => s.skills);
  const [filter, setFilter] = useState<SkillCategory | 'all'>('all');
  const cats = [...new Set(skills.map((s) => s.category))];
  const shown = (filter === 'all' ? skills : skills.filter((s) => s.category === filter)).slice().sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.priority - a.priority || b.updatedAt - a.updatedAt);

  if (!skills.length)
    return (
      <Empty
        variant="page"
        icon={<BrainIcon />}
        title="Teach the AI how you talk"
        body="Add your tone, your rules and your facts once; every caption and page will follow them."
        action={
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Plus /> Add a skill
          </button>
        }
      />
    );

  return (
    <div>
      {cats.length > 1 && (
        <div className="scroll-fade-x -mx-4 mb-4 flex gap-1.5 px-4 py-0.5 sm:mx-0 sm:flex-wrap sm:px-0">
          <button type="button" className={cn('chip', filter === 'all' && 'chip-active')} onClick={() => setFilter('all')} aria-pressed={filter === 'all'}>
            All <span className="num font-mono text-caption">{skills.length}</span>
          </button>
          {cats.map((c) => (
            <button type="button" key={c} className={cn('chip', filter === c && 'chip-active')} onClick={() => setFilter(c)} aria-pressed={filter === c}>
              {CATEGORY_META[c].label} <span className="num font-mono text-caption">{skills.filter((s) => s.category === c).length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {shown.map((s) => (
          <SkillCard key={s.id} skill={s} onEdit={() => onEdit(s)} />
        ))}
      </div>
    </div>
  );
}

function SkillCard({ skill: s, onEdit }: { skill: Skill; onEdit: () => void }) {
  const updateSkill = useStore((st) => st.updateSkill);
  const deleteSkill = useStore((st) => st.deleteSkill);
  const addSkill = useStore((st) => st.addSkill);
  const projects = useStore((st) => st.projects);
  const rules = rulesOf(s);
  const scopes = s.scope.includes('all') ? '' : s.scope.map((x) => SCOPE_META[x]).join(', ');
  const meta = [CATEGORY_META[s.category].label, PRIORITY[s.priority], s.projectId ? `Only ${projects.find((p) => p.id === s.projectId)?.brand.name || 'one project'}` : ''].filter(Boolean).join(' · ');
  const toggle = (v: boolean) => {
    const unfilled = v ? templatePlaceholders(s.instructions) : [];
    if (unfilled.length) {
      toast({ kind: 'error', title: 'Fill in this skill first', body: `Replace ${unfilled.join(', ')} with your real details, or delete those lines. The AI uses these facts as true.` });
      return;
    }
    updateSkill(s.id, { enabled: v });
  };
  const duplicate = () => addSkill({ ...s, id: uid('skill'), name: `${s.name} (copy)`, source: s.source === 'feedback' || s.source === 'social' ? 'custom' : s.source, stats: { applied: 0, up: 0, down: 0 }, createdAt: Date.now(), updatedAt: Date.now() });
  const remove = async () => {
    if (await confirmAction({ title: `Delete “${s.name}”?`, body: 'Future generations will stop using it.', confirmLabel: 'Delete', danger: true })) deleteSkill(s.id);
  };
  return (
    <article className={cn('card card-interactive flex min-w-0 flex-col gap-3 p-4 sm:p-5', !s.enabled && 'bg-surface-2')} onClick={onEdit}>
      <div className="flex items-start gap-3">
        <CategoryTile category={s.category} />
        <div className="min-w-0 flex-1">
          <h3 className={cn('text-h4', s.enabled ? 'text-ink' : 'text-muted')}>
            <button type="button" className="max-w-full truncate text-left" onClick={(e) => (e.stopPropagation(), onEdit())}>
              {s.name}
            </button>
          </h3>
          <p className="truncate text-small text-muted">{meta}</p>
        </div>
        <span onClick={(e) => e.stopPropagation()}>
          <Toggle checked={s.enabled} onChange={toggle} label={<span className="sr-only">{s.enabled ? 'Disable' : 'Enable'} {s.name}</span>} />
        </span>
      </div>
      {s.description && <p className="clamp-2 text-small text-ink-2">{s.description}</p>}
      {s.doc && (
        <p className="truncate text-caption text-muted">
          {s.doc.name} · {fmtBytes(s.doc.size)} · {s.doc.keywords.slice(0, 4).join(', ')}
        </p>
      )}
      {rules.length > 0 && (
        <ul className="well flex flex-col gap-1 px-3 py-2.5 text-small text-ink-2">
          {rules.slice(0, 4).map((r) => (
            <li key={r} className="clamp-2">
              {r}
            </li>
          ))}
          {rules.length > 4 && <li className="text-caption text-muted">+{rules.length - 4} more</li>}
        </ul>
      )}
      <div className="mt-auto flex items-center gap-2 border-t border-line pt-3">
        <span className="num min-w-0 flex-1 truncate font-mono text-caption text-muted">
          Used {s.stats.applied}×{s.stats.lastApplied ? ` · ${fmtRelative(s.stats.lastApplied)}` : ''}
          {scopes && ` · ${scopes}`}
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <MoreMenu
            label={`More for ${s.name}`}
            items={[
              { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
              { label: 'Duplicate', icon: <Copy />, onSelect: duplicate },
              'separator',
              { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void remove() },
            ]}
          />
        </span>
      </div>
    </article>
  );
}

function LibraryGrid() {
  const skills = useStore((s) => s.skills);
  const addSkill = useStore((s) => s.addSkill);
  const installed = new Set(skills.map((s) => s.libraryId).filter(Boolean));
  return (
    <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
      {SKILL_LIBRARY.map((l) => {
        const has = installed.has(l.libraryId);
        return (
          <article key={l.libraryId} className="card flex min-w-0 flex-col gap-3 p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <CategoryTile category={l.category} />
              <div className="min-w-0">
                <h3 className="truncate text-h4 text-ink">{l.name}</h3>
                <p className="truncate text-small text-muted">
                  {CATEGORY_META[l.category].label} · {l.scope.map((x) => SCOPE_META[x]).join(', ')}
                </p>
              </div>
            </div>
            <p className="clamp-2 text-small text-ink-2">{l.description}</p>
            <p className="well clamp-3 whitespace-pre-line px-3 py-2.5 text-caption text-muted">{l.instructions}</p>
            <div className="mt-auto flex items-center justify-end">
              {has ? (
                <span className="inline-flex h-8 items-center gap-1.5 text-small font-medium text-muted">
                  <Check size={16} aria-hidden="true" /> In your Brain
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    addSkill(skillFromLibrary(l));
                    toast({ kind: 'ai', title: `“${l.name}” added`, body: 'Active from your next generation.' });
                  }}
                >
                  <Plus /> Add to Brain
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function KnowledgeDocs() {
  const skills = useStore((s) => s.skills);
  const addSkill = useStore((s) => s.addSkill);
  const docs = skills.filter((s) => s.source === 'document');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const ingest = (docName: string, body: string, size: number) => {
    const skill = knowledgeDocSkill(docName, body, size);
    if (!skill) {
      toast({ kind: 'error', title: 'That document is too short', body: 'Paste at least a few sentences.' });
      return;
    }
    addSkill(skill);
    toast({ kind: 'ai', title: 'Document added to the Brain', body: `${skill.directives.facts?.length ?? 0} proof points · ${skill.doc?.keywords.length ?? 0} key terms` });
    setName('');
    setText('');
  };

  return (
    <div className="grid grid-cols-1 items-start gap-x-10 gap-y-8 lg:grid-cols-2">
      <Section title="Teach the Brain your facts" description="FAQs, service menus, policies or reviews. The Brain pulls out proof points and key terms.">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-secondary" onClick={() => file.current?.click()} disabled={busy}>
            <FileUp /> {busy ? 'Reading…' : 'Choose a text file'}
          </button>
          <span className="text-caption text-muted">.txt, .md, .csv or .json · up to 2 MB</span>
          <input
            ref={file}
            type="file"
            accept=".txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose a text file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > MAX_DOC) {
                toast({ kind: 'error', title: 'That file is over 2 MB', body: 'Split it or paste the most useful parts.' });
                return;
              }
              setBusy(true);
              try {
                const body = await readFileAsText(f);
                ingest(f.name.replace(/\.[a-z0-9]+$/i, ''), body, f.size);
              } catch {
                toast({ kind: 'error', title: 'Couldn’t read that file', body: 'Try a plain-text file, or paste the text below.' });
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
        <div className="my-5 flex items-center gap-3 text-caption text-muted">
          <span className="h-px flex-1 bg-line" /> or paste text <span className="h-px flex-1 bg-line" />
        </div>
        <div className="flex flex-col gap-4">
          <Field label="Document name" htmlFor="doc-name">
            <input id="doc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer reviews, Service FAQ" />
          </Field>
          <Field label="Text" htmlFor="doc-text" right={<span className="num font-mono">{text.length.toLocaleString()}</span>}>
            <AutoTextarea id="doc-text" value={text} onChange={setText} minRows={6} placeholder="Paste reviews, FAQs, product details…" />
          </Field>
          <div>
            <button type="button" className="btn btn-secondary" disabled={text.trim().length < 40} onClick={() => ingest(name.trim(), text, new Blob([text]).size)}>
              <Upload /> Add to Brain
            </button>
          </div>
        </div>
      </Section>
      <Section title="Documents" description={docs.length ? `${docs.length} in your Brain` : undefined}>
        {docs.length === 0 ? (
          <Empty className="card" title="No documents yet" body="Real facts (years in business, numbers, guarantees, customer words) make every output more specific." />
        ) : (
          <div className="flex flex-col gap-3">
            {docs.map((d) => (
              <article key={d.id} className="card flex flex-col gap-2 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="min-w-0 truncate text-h4 text-ink">{d.name}</h3>
                  <span className="num shrink-0 font-mono text-caption text-muted">{d.doc ? fmtBytes(d.doc.size) : ''}</span>
                </div>
                {d.directives.facts?.length ? (
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-small text-ink-2">
                    {d.directives.facts.slice(0, 4).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-small text-muted">No numbers to quote found; its key terms and excerpt are still used.</p>
                )}
                {!!d.doc?.keywords.length && <p className="text-caption text-muted">{d.doc.keywords.slice(0, 10).join(' · ')}</p>}
              </article>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

type Sample = 'caption' | 'email' | 'headline' | 'ad';

function Playground() {
  const project = useActiveProject();
  const skills = useStore((s) => s.skills);
  const [sample, setSample] = useState<Sample>('caption');
  const [compare, setCompare] = useState<string>('__none');
  const withAI = useAI(skillTestTask);
  const withoutAI = useAI(skillTestTask);
  const { withSet, baseline, target } = playgroundSets(skills, compare === '__none' ? null : compare);

  const run = async () => {
    const variation = Math.floor(Math.random() * 1000);
    await Promise.all([withAI.run({ sample }, { skills: withSet, variation, silent: true }), withoutAI.run({ sample }, { skills: baseline, variation, silent: true })]);
  };

  const a = withAI.result?.data.text.trim();
  const b = withoutAI.result?.data.text.trim();
  const running = withAI.running || withoutAI.running;
  const same = !running && !!a && a === b;

  if (!project) return null;
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <Field label="Write a sample">
          <Segmented
            size="sm"
            value={sample}
            onChange={setSample}
            options={[
              { id: 'caption', label: 'Caption' },
              { id: 'email', label: 'Email' },
              { id: 'ad', label: 'Ad' },
              { id: 'headline', label: 'SEO title' },
            ]}
          />
        </Field>
        <Field label="Compare against" htmlFor="pg-compare">
          <Select
            id="pg-compare"
            value={compare}
            onChange={setCompare}
            options={[{ value: '__none', label: 'No skills at all (Brain off)' }, ...skills.map((s) => ({ value: s.id, label: `Without “${s.name}”` }))]}
          />
        </Field>
        <GenerateButton variant="ai" running={running} onClick={run} runningLabel="Writing…" className="self-start">
          Run comparison
        </GenerateButton>
        <p className="text-caption text-muted">Highlighted words are what your skills changed. Playground runs aren’t saved to your project or the activity log.</p>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <AiCard>
          <Output title={`With your Brain · ${withSet.length} skill${withSet.length === 1 ? '' : 's'}`} ai={withAI} compareTo={withoutAI.result?.data.text} />
        </AiCard>
        <div className="card p-4 sm:p-5">
          <Output title={compare === '__none' ? 'Without any skills' : `Without “${target?.name ?? ''}”`} ai={withoutAI} />
        </div>
        {same && (
          <p className="text-small text-muted">
            Same result: {compare === '__none' ? 'your active skills' : `“${target?.name ?? 'this skill'}”`} didn’t change this sample. Rules such as words to avoid only show when the AI would have used those words; voice, hook, emoji and call-to-action skills from the Library make the clearest difference.
          </p>
        )}
      </div>
    </div>
  );
}

/** Word-level diff: which tokens of `a` are not in the longest common subsequence with `b`. */
function diffTokens(a: string, b: string): { text: string; added: boolean }[] {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  if (A.length * B.length > 400_000) return [{ text: a, added: false }];
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { text: string; added: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length) {
    if (j < B.length && A[i] === B[j]) {
      out.push({ text: A[i], added: false });
      i++;
      j++;
    } else if (j < B.length && dp[i][j + 1] >= dp[i + 1][j]) j++;
    else {
      out.push({ text: A[i], added: !/^\s+$/.test(A[i]) });
      i++;
    }
  }
  return out;
}

function Output({ title, ai, compareTo }: { title: string; ai: ReturnType<typeof useAI<{ sample: Sample }, { text: string }>>; compareTo?: string }) {
  const text = ai.result?.data.text ?? '';
  const parts = compareTo && text && compareTo.trim() !== text.trim() ? diffTokens(text, compareTo) : null;
  return (
    <section className="flex min-h-[180px] flex-col">
      <h3 className="mb-3 text-h4 text-ink">{title}</h3>
      <AIThinking running={ai.running} stage={ai.stage} compact />
      {ai.result && !ai.running ? (
        <>
          <p className="max-w-[72ch] whitespace-pre-line text-body text-ink-2">
            {parts
              ? parts.map((t, k) =>
                  t.added ? (
                    <mark key={k} className="rounded-xs bg-primary-soft px-0.5 text-ink">
                      {t.text}
                    </mark>
                  ) : (
                    <span key={k}>{t.text}</span>
                  ),
                )
              : text}
          </p>
          <AIResultBar
            className="mt-4"
            provider={ai.result.provider}
            skills={ai.result.skills}
            ms={ai.result.ms}
            note={ai.result.note}
            logId={null}
            onCopy={() => void copyText(text).then((ok) => toast(ok ? { kind: 'success', title: 'Copied' } : { kind: 'error', title: 'Copy was blocked', body: 'Select the text and copy it manually.' }))}
          />
        </>
      ) : (
        !ai.running && <p className="m-auto py-6 text-small text-muted">Run a comparison to see the difference.</p>
      )}
    </section>
  );
}

/** Who wrote it, how long it took and what it used: behind a Details link, not on the row. */
function ActivityDetails({ g }: { g: GenerationLog }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button" className="link text-small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Details
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="w-80 p-3">
        <p className="text-small font-semibold text-ink">{g.label}</p>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-small">
          <dt className="text-muted">Written by</dt>
          <dd className="min-w-0 text-ink-2">{g.meta ? `${g.meta.providerLabel} · ${g.meta.model}` : providerLabel(g.provider)}</dd>
          <dt className="text-muted">When</dt>
          <dd className="num font-mono text-ink-2">{fmtDateTime(g.createdAt)}</dd>
          {g.ms > 0 && (
            <>
              <dt className="text-muted">Time</dt>
              <dd className="num font-mono text-ink-2">{(g.ms / 1000).toFixed(1)}s</dd>
            </>
          )}
        </dl>
        {g.meta && <pre className="mt-2 whitespace-pre-wrap rounded-pop bg-surface-2 px-2.5 py-2 font-mono text-caption text-ink-2">{metaDetails(g.meta)}</pre>}
      </Popover>
    </>
  );
}

function ActivityLog() {
  const genLog = useStore((s) => s.genLog);
  const skills = useStore((s) => s.skills);
  const names = useMemo(() => new Map(skills.map((s) => [s.id, s.name])), [skills]);
  if (!genLog.length) return <Empty icon={<Activity />} title="No generations yet" body="Every AI generation is logged here with the skills that shaped it." />;
  return (
    <div className="card overflow-hidden">
      <table className="w-full table-fixed text-left text-small">
        <thead className="border-b border-line text-caption text-muted">
          <tr>
            <th className="w-[96px] px-4 py-2 font-medium">Time</th>
            <th className="px-2 py-2 font-medium">What</th>
            <th className="hidden px-2 py-2 font-medium md:table-cell">Skills used</th>
            <th className="hidden w-[120px] px-2 py-2 font-medium sm:table-cell">Result</th>
            <th className="w-[84px] px-4 py-2 font-medium">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {genLog.slice(0, 80).map((g) => {
            const used = g.skillIds.map((id) => names.get(id) ?? 'Deleted skill');
            return (
              <tr key={g.id} className="transition-colors duration-120 hover:bg-surface-2">
                <td className="num px-4 py-2.5 align-top font-mono text-caption text-muted" title={fmtDateTime(g.createdAt)}>
                  {fmtRelative(g.createdAt)}
                </td>
                <td className="min-w-0 px-2 py-2.5 align-top">
                  <span className="block truncate text-ui text-ink">{g.label}</span>
                  <span className="block truncate text-caption text-muted">{SCOPE_META[g.module] ?? g.module}</span>
                </td>
                <td className="hidden px-2 py-2.5 align-top text-small text-ink-2 md:table-cell">
                  <span className="clamp-2" title={used.join(', ')}>
                    {used.length ? used.join(', ') : <span className="text-muted">None</span>}
                  </span>
                </td>
                <td className="hidden px-2 py-2.5 align-top sm:table-cell">
                  {g.rating === 1 ? (
                    <span className="inline-flex items-center gap-1.5 text-small text-ink-2">
                      <ThumbsUp size={14} className="text-good" aria-hidden="true" /> Good
                    </span>
                  ) : g.rating === -1 ? (
                    <span className="inline-flex items-center gap-1.5 text-small text-ink-2">
                      <ThumbsDown size={14} className="text-bad" aria-hidden="true" /> Needs work
                    </span>
                  ) : (
                    <span className="text-faint">–</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right align-top">
                  <ActivityDetails g={g} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
