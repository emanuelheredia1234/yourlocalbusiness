import { useEffect, useMemo, useState } from 'react';
import { Brain, Wand2 } from 'lucide-react';
import type { Directives, Framework, HookStyle, ModuleScope, Skill, SkillCategory, Tone } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CATEGORY_META, FRAMEWORKS, HOOK_STYLES, SCOPE_META, TONES, describeDirectives, newSkill, parseDirectives } from '@/ai/brain';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AutoTextarea, ChipInput, Field, Modal, Segmented } from '@/components/ui/primitives';

const TEMPLATES: { label: string; category: SkillCategory; name: string; text: string }[] = [
  { label: 'Brand voice', category: 'voice', name: 'Our brand voice', text: 'Tone: warm, confident and plain-spoken.\nWrite like a helpful neighbor, not a corporation.\nUse "we" and speak directly to "you".\nNo emojis in emails; light emojis on social.\nNever use: synergy, leverage, game-changer.' },
  { label: 'Ideal customer', category: 'audience', name: 'Ideal customer profile', text: 'Audience: busy working parents aged 30–45.\nThey feel guilty about not having enough time and are skeptical of quick fixes.\nThey say things like “I just need something that works” and “I don’t have time to learn a whole system”.\nThey want: calm evenings, fewer decisions, visible progress.' },
  { label: 'Words to avoid', category: 'rules', name: 'Compliance rules', text: 'Never promise specific income or health results.\nAvoid: guaranteed, cure, overnight, get rich, miracle.\nAlways include a clear way to contact us.' },
  { label: 'Proof points', category: 'knowledge', name: 'Proof points', text: 'Facts you can use:\n- Family-owned since 2014.\n- Over 1,200 customers served.\n- 4.9-star average from 300+ reviews.\n- Licensed and insured.' },
];

export function SkillEditor({ open, onClose, skill }: { open: boolean; onClose: () => void; skill: Skill | null }) {
  const addSkill = useStore((s) => s.addSkill);
  const updateSkill = useStore((s) => s.updateSkill);
  const [draft, setDraft] = useState<Skill>(() => skill ?? newSkill({ name: '' }));
  useEffect(() => {
    if (open) setDraft(skill ?? newSkill({ name: '' }));
  }, [open, skill]);
  const parsed = useMemo(() => parseDirectives(draft.instructions), [draft.instructions]);
  const detected = describeDirectives({ ...parsed, ...draft.directives });
  const setD = (patch: Partial<Directives>) => setDraft((d) => ({ ...d, directives: { ...d.directives, ...patch } }));
  const toggleScope = (s: ModuleScope) =>
    setDraft((d) => {
      if (s === 'all') return { ...d, scope: ['all'] };
      const without = d.scope.filter((x) => x !== 'all' && x !== s);
      const next = d.scope.includes(s) ? without : [...without, s];
      return { ...d, scope: next.length ? next : ['all'] };
    });

  const save = () => {
    const name = draft.name.trim() || `${CATEGORY_META[draft.category].label} skill`;
    if (skill) {
      updateSkill(skill.id, { ...draft, name });
      toast({ kind: 'ai', title: 'Skill updated', body: 'Every future generation uses the new version.' });
    } else {
      addSkill({ ...draft, name });
      toast({ kind: 'ai', title: `“${name}” added to the Brain`, body: 'It applies from your next generation.' });
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={skill ? 'Edit skill' : 'New skill'}
      subtitle="Write instructions in plain language. The Brain detects rules like tone, emoji use, banned words and CTAs, and Claude reads the full text."
      icon={<Brain size={18} className="text-primary" />}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!draft.instructions.trim() && !detected.length}>
            {skill ? 'Save skill' : 'Add to Brain'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-4">
          {!skill && (
            <div className="flex flex-wrap gap-1.5">
              <span className="mr-1 self-center text-xs text-muted">Start from:</span>
              {TEMPLATES.map((t) => (
                <button key={t.label} className="chip" onClick={() => setDraft((d) => ({ ...d, name: d.name || t.name, category: t.category, instructions: t.text }))}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_200px]">
            <Field label="Skill name" htmlFor="sk-name">
              <input id="sk-name" className="input" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="e.g. Our brand voice" />
            </Field>
            <Field label="Category" htmlFor="sk-cat">
              <select id="sk-cat" className="select" value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as SkillCategory }))}>
                {(Object.keys(CATEGORY_META) as SkillCategory[]).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_META[c].label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Short description" htmlFor="sk-desc">
            <input id="sk-desc" className="input" value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="What this skill teaches the AI" />
          </Field>
          <Field label="Instructions" htmlFor="sk-ins" hint="One idea per line works best. Mention words to avoid, the CTA you prefer, emoji rules, tone, facts to use…">
            <AutoTextarea id="sk-ins" value={draft.instructions} onChange={(v) => setDraft((d) => ({ ...d, instructions: v }))} minRows={7} className="text-[13.5px]" placeholder={'Tone: friendly and direct.\nNever use: “synergy”, “hustle”.\nEnd posts with: Book your free consult.'} />
          </Field>
          <details className="rounded-md border border-line">
            <summary className="cursor-pointer px-3 py-2 text-[13px] font-semibold">Fine-tune with structured controls</summary>
            <div className="grid grid-cols-1 gap-3 border-t border-line p-3 sm:grid-cols-2">
              <Field label="Tone">
                <select className="select" value={draft.directives.tone ?? ''} onChange={(e) => setD({ tone: (e.target.value || undefined) as Tone | undefined })}>
                  <option value="">Auto-detect</option>
                  {TONES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} · {t.desc}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Copy framework">
                <select className="select" value={draft.directives.framework ?? ''} onChange={(e) => setD({ framework: (e.target.value || undefined) as Framework | undefined })}>
                  <option value="">None</option>
                  {FRAMEWORKS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label} · {f.desc}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Emoji">
                <select className="select" value={draft.directives.emoji ?? ''} onChange={(e) => setD({ emoji: (e.target.value || undefined) as Directives['emoji'] })}>
                  <option value="">Auto</option>
                  <option value="none">None</option>
                  <option value="light">Light</option>
                  <option value="heavy">Plenty</option>
                </select>
              </Field>
              <Field label="Hook style">
                <select className="select" value={draft.directives.hookStyle ?? ''} onChange={(e) => setD({ hookStyle: (e.target.value || undefined) as HookStyle | undefined })}>
                  <option value="">Auto</option>
                  {HOOK_STYLES.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Length">
                <select className="select" value={draft.directives.length ?? ''} onChange={(e) => setD({ length: (e.target.value || undefined) as Directives['length'] })}>
                  <option value="">Auto</option>
                  <option value="short">Short</option>
                  <option value="medium">Medium</option>
                  <option value="long">Long</option>
                </select>
              </Field>
              <Field label="Point of view">
                <select className="select" value={draft.directives.person ?? ''} onChange={(e) => setD({ person: (e.target.value || undefined) as Directives['person'] })}>
                  <option value="">Auto</option>
                  <option value="we">“We” (team)</option>
                  <option value="i">“I” (founder)</option>
                  <option value="you">“You” focused</option>
                </select>
              </Field>
              <Field label="Preferred call to action" className="sm:col-span-2">
                <input className="input" value={draft.directives.cta ?? ''} onChange={(e) => setD({ cta: e.target.value || undefined })} placeholder="e.g. Book your free consult" />
              </Field>
              <Field label="Words to avoid" className="sm:col-span-2">
                <ChipInput values={draft.directives.banned ?? []} onChange={(v) => setD({ banned: v })} placeholder="Add a word and press Enter" />
              </Field>
              <Field label="Always mention" className="sm:col-span-2">
                <ChipInput values={draft.directives.mustInclude ?? []} onChange={(v) => setD({ mustInclude: v })} placeholder="e.g. free shipping" />
              </Field>
              <Field label="Hashtags to use" className="sm:col-span-2">
                <ChipInput values={draft.directives.hashtags ?? []} onChange={(v) => setD({ hashtags: v })} prefix="#" placeholder="#yourtag" />
              </Field>
            </div>
          </details>
        </div>

        <aside className="flex flex-col gap-4">
          <div className="rounded-lg border border-line bg-surface-2/50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
              <Wand2 size={14} className="text-primary" /> Detected rules
            </p>
            {detected.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {detected.map((d) => (
                  <li key={d} className="rounded bg-surface px-2 py-1 text-[11.5px] font-medium text-ink-2 ring-1 ring-line">
                    {d}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">Nothing structured yet. The full text is still sent to Claude as guidance.</p>
            )}
          </div>
          <Field label="Applies to">
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(SCOPE_META) as ModuleScope[]).map((s) => (
                <button key={s} className={cn('chip text-[12px]', draft.scope.includes(s) && 'chip-active')} onClick={() => toggleScope(s)} aria-pressed={draft.scope.includes(s)}>
                  {SCOPE_META[s]}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Priority" hint="When two skills conflict, the higher priority wins.">
            <Segmented
              size="sm"
              value={String(draft.priority)}
              onChange={(v) => setDraft((d) => ({ ...d, priority: Number(v) as 1 | 2 | 3 }))}
              options={[
                { id: '1', label: 'Low' },
                { id: '2', label: 'Normal' },
                { id: '3', label: 'High' },
              ]}
            />
          </Field>
        </aside>
      </div>
    </Modal>
  );
}
