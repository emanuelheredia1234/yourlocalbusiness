import { useMemo, useState } from 'react';
import { Activity, BookOpen, Brain as BrainIcon, Check, Copy, FileUp, FlaskConical, Library, Pencil, Plus, Sparkles, ThumbsDown, ThumbsUp, Trash2, Upload } from 'lucide-react';
import type { Skill, SkillCategory } from '@/lib/types';
import { cn, fmtBytes, fmtRelative, readFileAsText, uid } from '@/lib/utils';
import { CATEGORY_META, SCOPE_META, SKILL_LIBRARY, brainStrength, describeDirectives, effectiveDirectives, extractFacts, extractKeywords, newSkill, skillFromLibrary } from '@/ai/brain';
import { providerLabel } from '@/ai/engine';
import { skillTestTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIThinking, GenerateButton, ProviderBadge } from '@/components/ai/AI';
import { AutoTextarea, Empty, Field, ProgressRing, Segmented, Tabs, Toggle, confirmAction } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { SkillEditor } from './SkillEditor';

type Tab = 'skills' | 'library' | 'docs' | 'playground' | 'log';

export default function Brain() {
  const skills = useStore((s) => s.skills);
  const genLog = useStore((s) => s.genLog);
  const useBrain = useStore((s) => s.settings.ai.useBrain);
  const updateSettings = useStore((s) => s.updateSettings);
  const [tab, setTab] = useState<Tab>('skills');
  const [editing, setEditing] = useState<Skill | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const strength = useMemo(() => brainStrength(skills), [skills]);
  const active = skills.filter((s) => s.enabled);
  const ups = skills.reduce((n, s) => n + s.stats.up, 0);
  const downs = skills.reduce((n, s) => n + s.stats.down, 0);
  const withSkills = genLog.filter((g) => g.skillIds.length).length;

  const openEditor = (s: Skill | null) => {
    setEditing(s);
    setEditorOpen(true);
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1">Brain</p>
          <h1 className="page-title">The Brain</h1>
          <p className="mt-1 max-w-[700px] text-[13.5px] text-muted">Skills the AI reads before every generation: your voice, your customer, your rules and your facts. Add them once and every caption, email, page and ad gets sharper.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle checked={useBrain} onChange={(v) => updateSettings((s) => ({ ...s, ai: { ...s.ai, useBrain: v } }))} label={useBrain ? 'Brain on' : 'Brain off'} />
          <button className="btn btn-primary" onClick={() => openEditor(null)}>
            <Plus size={16} /> New skill
          </button>
        </div>
      </header>

      {!useBrain && <p className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">The Brain is off: generations ignore every skill until you turn it back on.</p>}

      <section className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]" aria-label="Brain strength">
        <div className="panel flex flex-wrap items-start gap-4 p-4">
          <ProgressRing value={strength.score / 100} size={72} stroke={7} label={<span className="text-[18px]">{strength.score}</span>} />
          <div className="min-w-[200px] flex-1">
            <p className="text-[15px] font-semibold">Brain strength</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {(['voice', 'audience', 'copywriting', 'offer', 'rules', 'knowledge'] as SkillCategory[]).map((c) => (
                <span key={c} className={cn('badge', strength.covered.includes(c) ? 'bg-good-soft text-good' : 'bg-surface-2 text-muted')}>
                  {strength.covered.includes(c) ? <Check size={10} /> : null}
                  {CATEGORY_META[c].label}
                </span>
              ))}
            </div>
            {strength.tips.length > 0 && <p className="mt-2 text-[12.5px] text-ink-2">Next: {strength.tips[0]}</p>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Tile label="Active skills" value={`${active.length}/${skills.length}`} />
          <Tile label="Generations shaped" value={String(withSkills)} />
          <Tile label="Thumbs up" value={String(ups)} icon={<ThumbsUp size={12} className="text-good" />} />
          <Tile label="Thumbs down" value={String(downs)} icon={<ThumbsDown size={12} className="text-bad" />} />
        </div>
      </section>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'skills', label: 'Skills', icon: <BrainIcon size={15} />, count: skills.length },
          { id: 'library', label: 'Skill library', icon: <Library size={15} /> },
          { id: 'docs', label: 'Knowledge docs', icon: <BookOpen size={15} />, count: skills.filter((s) => s.source === 'document').length || undefined },
          { id: 'playground', label: 'Playground', icon: <FlaskConical size={15} /> },
          { id: 'log', label: 'Activity', icon: <Activity size={15} /> },
        ]}
      />

      {tab === 'skills' && <SkillList onEdit={openEditor} />}
      {tab === 'library' && <LibraryGrid />}
      {tab === 'docs' && <KnowledgeDocs />}
      {tab === 'playground' && <Playground />}
      {tab === 'log' && <ActivityLog />}

      <SkillEditor open={editorOpen} onClose={() => setEditorOpen(false)} skill={editing} />
    </div>
  );
}

function Tile({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="panel px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {icon}
        {label}
      </p>
      <p className="num text-[20px] font-bold">{value}</p>
    </div>
  );
}

const SOURCE_LABEL: Record<Skill['source'], string> = { custom: 'Custom', library: 'Library', feedback: 'Learned', document: 'Document' };

function SkillList({ onEdit }: { onEdit: (s: Skill) => void }) {
  const skills = useStore((s) => s.skills);
  const updateSkill = useStore((s) => s.updateSkill);
  const deleteSkill = useStore((s) => s.deleteSkill);
  const addSkill = useStore((s) => s.addSkill);
  const [filter, setFilter] = useState<SkillCategory | 'all'>('all');
  const cats = [...new Set(skills.map((s) => s.category))];
  const shown = (filter === 'all' ? skills : skills.filter((s) => s.category === filter)).slice().sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.priority - a.priority || b.updatedAt - a.updatedAt);

  if (!skills.length) return <Empty icon={<BrainIcon size={20} />} title="Your Brain is empty" body="Add a skill or install one from the library. Even one brand-voice skill makes a visible difference." />;

  return (
    <div className="flex flex-col gap-3">
      {cats.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button className={cn('chip', filter === 'all' && 'chip-active')} onClick={() => setFilter('all')}>
            All ({skills.length})
          </button>
          {cats.map((c) => (
            <button key={c} className={cn('chip', filter === c && 'chip-active')} onClick={() => setFilter(c)}>
              {CATEGORY_META[c].label} ({skills.filter((s) => s.category === c).length})
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {shown.map((s) => {
          const rules = describeDirectives(effectiveDirectives(s));
          return (
            <article key={s.id} className={cn('panel flex flex-col gap-3 p-4', !s.enabled && 'opacity-60')}>
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
                  <Icon name={CATEGORY_META[s.category].icon} size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14.5px] font-semibold">{s.name}</p>
                  <p className="text-xs text-muted">
                    {CATEGORY_META[s.category].label} · {SOURCE_LABEL[s.source]} · {s.priority === 3 ? 'High' : s.priority === 1 ? 'Low' : 'Normal'} priority
                  </p>
                </div>
                <Toggle checked={s.enabled} onChange={(v) => updateSkill(s.id, { enabled: v })} label={<span className="sr-only">{s.enabled ? 'Disable' : 'Enable'} {s.name}</span>} />
              </div>
              {s.description && <p className="text-[13px] text-ink-2">{s.description}</p>}
              {s.doc && (
                <p className="flex items-center gap-1.5 text-xs text-muted">
                  <BookOpen size={12} /> {s.doc.name} · {fmtBytes(s.doc.size)} · {s.doc.keywords.slice(0, 4).join(', ')}
                </p>
              )}
              {rules.length > 0 && (
                <ul className="flex flex-wrap gap-1">
                  {rules.slice(0, 8).map((r) => (
                    <li key={r} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">
                      {r}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11.5px] text-muted">Applies to: {s.scope.map((x) => SCOPE_META[x]).join(', ')}</p>
              <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <span className="num text-xs text-muted">
                  Used {s.stats.applied}× {s.stats.lastApplied ? `· last ${fmtRelative(s.stats.lastApplied)}` : ''}
                </span>
                <span className="num flex items-center gap-2 text-xs text-muted">
                  <span className="flex items-center gap-0.5">
                    <ThumbsUp size={11} /> {s.stats.up}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <ThumbsDown size={11} /> {s.stats.down}
                  </span>
                </span>
                <span className="ml-auto flex gap-1">
                  <button className="btn btn-ghost btn-xs" onClick={() => onEdit(s)}>
                    <Pencil size={12} /> Edit
                  </button>
                  <button className="btn btn-ghost btn-icon btn-xs" aria-label={`Duplicate ${s.name}`} onClick={() => addSkill({ ...s, id: uid('skill'), name: `${s.name} (copy)`, source: s.source === 'feedback' ? 'custom' : s.source, stats: { applied: 0, up: 0, down: 0 }, createdAt: Date.now(), updatedAt: Date.now() })}>
                    <Copy size={12} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon btn-xs text-muted hover:text-bad"
                    aria-label={`Delete ${s.name}`}
                    onClick={async () => {
                      if (await confirmAction({ title: `Delete “${s.name}”?`, body: 'Future generations will stop using it.', confirmLabel: 'Delete', danger: true })) deleteSkill(s.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function LibraryGrid() {
  const skills = useStore((s) => s.skills);
  const addSkill = useStore((s) => s.addSkill);
  const installed = new Set(skills.map((s) => s.libraryId).filter(Boolean));
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {SKILL_LIBRARY.map((l) => {
        const has = installed.has(l.libraryId);
        return (
          <article key={l.libraryId} className="panel flex flex-col gap-2.5 p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-surface-2 text-primary">
                <Icon name={CATEGORY_META[l.category].icon} size={15} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold">{l.name}</p>
                <p className="text-[11.5px] text-muted">
                  {CATEGORY_META[l.category].label} · {l.scope.map((x) => SCOPE_META[x]).join(', ')}
                </p>
              </div>
            </div>
            <p className="text-[13px] text-ink-2">{l.description}</p>
            <p className="clamp-3 whitespace-pre-line rounded bg-surface-2 px-2.5 py-2 text-[12px] text-muted">{l.instructions}</p>
            <button
              className={cn('btn btn-sm mt-auto', has ? 'btn-secondary' : 'btn-primary')}
              disabled={has}
              onClick={() => {
                addSkill(skillFromLibrary(l));
                toast({ kind: 'ai', title: `“${l.name}” added`, body: 'Active from your next generation.' });
              }}
            >
              {has ? (
                <>
                  <Check size={14} /> In your Brain
                </>
              ) : (
                <>
                  <Plus size={14} /> Add to Brain
                </>
              )}
            </button>
          </article>
        );
      })}
    </div>
  );
}

const MAX_DOC = 2_000_000;

function KnowledgeDocs() {
  const skills = useStore((s) => s.skills);
  const addSkill = useStore((s) => s.addSkill);
  const docs = skills.filter((s) => s.source === 'document');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const ingest = (docName: string, body: string, size: number) => {
    const clean = body.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
    if (clean.length < 40) {
      toast({ kind: 'error', title: 'That document is too short', body: 'Paste at least a few sentences.' });
      return;
    }
    const keywords = extractKeywords(clean, 12);
    const facts = extractFacts(clean, 8);
    const excerpt = clean.slice(0, 1500);
    addSkill(
      newSkill({
        name: docName || 'Knowledge document',
        category: 'knowledge',
        description: `Reference document with ${facts.length} proof point${facts.length === 1 ? '' : 's'} and ${keywords.length} key terms.`,
        instructions: [`Use this document as the source of truth. Prefer its facts over generic claims.`, facts.length ? `Proof points:\n${facts.map((f) => `- ${f}`).join('\n')}` : '', `Key terms: ${keywords.join(', ')}`, `Excerpt:\n${excerpt}`].filter(Boolean).join('\n\n'),
        scope: ['all'],
        priority: 2,
        source: 'document',
        directives: { facts },
        doc: { name: docName || 'Pasted text', size, keywords, excerpt: excerpt.slice(0, 280) },
      }),
    );
    toast({ kind: 'ai', title: 'Document added to the Brain', body: `${facts.length} proof points · ${keywords.length} key terms` });
    setName('');
    setText('');
  };

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-label="Add a document">
        <h2 className="section-title">Teach the Brain your facts</h2>
        <p className="text-[13px] text-muted">Upload FAQs, product notes, reviews, service menus or policies (.txt, .md, .csv, .json), or paste text. The Brain extracts proof points and key terms and uses them in every output.</p>
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-2 px-4 py-6 text-center hover:border-primary hover:bg-primary-soft/40">
          <FileUp size={22} className="text-primary" />
          <span className="text-[13px] font-semibold">{busy ? 'Reading…' : 'Choose a text file'}</span>
          <span className="text-xs text-muted">Up to 2 MB</span>
          <input
            type="file"
            accept=".txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json"
            className="sr-only"
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
        </label>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="h-px flex-1 bg-line" /> or paste text <span className="h-px flex-1 bg-line" />
        </div>
        <Field label="Document name" htmlFor="doc-name">
          <input id="doc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer reviews, Service FAQ" />
        </Field>
        <Field label="Text" htmlFor="doc-text" right={`${text.length.toLocaleString()} chars`}>
          <AutoTextarea id="doc-text" value={text} onChange={setText} minRows={6} className="text-[13px]" placeholder="Paste reviews, FAQs, product details…" />
        </Field>
        <button className="btn btn-primary self-start" disabled={text.trim().length < 40} onClick={() => ingest(name.trim(), text, new Blob([text]).size)}>
          <Upload size={15} /> Add to Brain
        </button>
      </section>
      <section className="flex flex-col gap-3" aria-label="Documents">
        {docs.length === 0 ? (
          <Empty icon={<BookOpen size={20} />} title="No documents yet" body="Real facts (years in business, numbers, guarantees, customer words) make every output more specific and believable." />
        ) : (
          docs.map((d) => (
            <article key={d.id} className="panel flex flex-col gap-2 p-4">
              <p className="flex items-center gap-2 text-[14px] font-semibold">
                <BookOpen size={15} className="text-primary" /> {d.name}
                <span className="ml-auto text-xs font-normal text-muted">{d.doc ? fmtBytes(d.doc.size) : ''}</span>
              </p>
              {d.directives.facts?.length ? (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-ink-2">
                  {d.directives.facts.slice(0, 4).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">No numeric proof points found; key terms and the excerpt are still used.</p>
              )}
              <div className="flex flex-wrap gap-1">
                {d.doc?.keywords.slice(0, 10).map((k) => (
                  <span key={k} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                    {k}
                  </span>
                ))}
              </div>
            </article>
          ))
        )}
      </section>
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
  const enabled = skills.filter((s) => s.enabled);
  const target = skills.find((s) => s.id === compare);
  const baseline = compare === '__none' ? [] : enabled.filter((s) => s.id !== compare);
  const withSet = target && !target.enabled ? [...enabled, { ...target, enabled: true }] : enabled;

  const run = async () => {
    const variation = Math.floor(Math.random() * 1000);
    await Promise.all([withAI.run({ sample }, { skills: withSet, variation, silent: true }), withoutAI.run({ sample }, { skills: baseline, variation, silent: true })]);
  };

  const a = withAI.result?.data.text.trim();
  const b = withoutAI.result?.data.text.trim();
  const same = !withAI.running && !withoutAI.running && !!a && a === b;

  if (!project) return null;
  return (
    <div className="flex flex-col gap-4">
      <section className="panel flex flex-wrap items-end gap-3 p-4">
        <Field label="Write a sample">
          <Segmented
            size="sm"
            value={sample}
            onChange={setSample}
            options={[
              { id: 'caption', label: 'Social caption' },
              { id: 'email', label: 'Sales email' },
              { id: 'ad', label: 'Ad copy' },
              { id: 'headline', label: 'SEO title' },
            ]}
          />
        </Field>
        <Field label="Compare against" htmlFor="pg-compare" className="min-w-[220px] flex-1">
          <select id="pg-compare" className="select" value={compare} onChange={(e) => setCompare(e.target.value)}>
            <option value="__none">No skills at all (Brain off)</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                Without “{s.name}”
              </option>
            ))}
          </select>
        </Field>
        <GenerateButton running={withAI.running || withoutAI.running} onClick={run} icon={<FlaskConical size={15} className="text-accent" />}>
          Run comparison
        </GenerateButton>
      </section>
      {same && (
        <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
          Same result: {compare === '__none' ? 'your active skills' : `“${target?.name ?? 'this skill'}”`} didn’t change this sample. Rules such as words to avoid only show when the AI would have used those words. Voice, hook, emoji and call-to-action skills from the Skill library make the clearest difference.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Output title={`With your Brain (${withSet.length} skill${withSet.length === 1 ? '' : 's'})`} ai={withAI} highlight compareTo={withoutAI.result?.data.text} />
        <Output title={compare === '__none' ? 'Without any skills' : `Without “${target?.name ?? ''}”`} ai={withoutAI} />
      </div>
      <p className="text-xs text-muted">Highlighted words are what your skills changed. Playground runs aren’t saved to your project or the activity log.</p>
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

function Output({ title, ai, highlight, compareTo }: { title: string; ai: ReturnType<typeof useAI<{ sample: Sample }, { text: string }>>; highlight?: boolean; compareTo?: string }) {
  const text = ai.result?.data.text ?? '';
  const parts = compareTo && text && compareTo.trim() !== text.trim() ? diffTokens(text, compareTo) : null;
  return (
    <section className={cn('panel flex min-h-[220px] flex-col p-4', highlight && 'ring-2 ring-primary/40')}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
          {highlight ? <Sparkles size={14} className="text-accent" /> : null}
          {title}
        </h3>
        {ai.result && <ProviderBadge provider={ai.result.provider} />}
      </div>
      <AIThinking running={ai.running} stage={ai.stage} compact />
      {ai.result && !ai.running ? (
        <p className="whitespace-pre-line text-[13.5px] leading-relaxed text-ink-2">
          {parts
            ? parts.map((t, k) =>
                t.added ? (
                  <mark key={k} className="rounded-sm bg-accent/30 px-0.5 text-ink">
                    {t.text}
                  </mark>
                ) : (
                  <span key={k}>{t.text}</span>
                ),
              )
            : text}
        </p>
      ) : (
        !ai.running && <p className="m-auto text-[13px] text-muted">Run a comparison to see the difference.</p>
      )}
    </section>
  );
}

function ActivityLog() {
  const genLog = useStore((s) => s.genLog);
  const skills = useStore((s) => s.skills);
  const names = new Map(skills.map((s) => [s.id, s.name]));
  if (!genLog.length) return <Empty icon={<Activity size={20} />} title="No generations yet" body="Every AI generation is logged here with the skills that shaped it." />;
  return (
    <section className="panel overflow-hidden">
      <ul className="divide-y divide-line">
        {genLog.slice(0, 80).map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
            <span className="min-w-[160px] flex-1">
              <span className="block font-semibold">{g.label}</span>
              <span className="block text-xs text-muted">
                {SCOPE_META[g.module] ?? g.module} · {fmtRelative(g.createdAt)} · {(g.ms / 1000).toFixed(1)}s
              </span>
            </span>
            <span className="max-w-[340px] truncate text-xs text-muted" title={g.skillIds.map((id) => names.get(id) ?? 'Deleted skill').join(', ')}>
              {g.skillIds.length ? `${g.skillIds.length} skill${g.skillIds.length > 1 ? 's' : ''}: ${g.skillIds.map((id) => names.get(id) ?? 'deleted').join(', ')}` : 'No skills'}
            </span>
            <span className={cn('badge', g.provider === 'local' ? 'bg-surface-2 text-ink-2' : 'bg-ink text-surface')}>{providerLabel(g.provider)}</span>
            {g.rating === 1 && <ThumbsUp size={13} className="text-good" />}
            {g.rating === -1 && <ThumbsDown size={13} className="text-bad" />}
          </li>
        ))}
      </ul>
    </section>
  );
}
