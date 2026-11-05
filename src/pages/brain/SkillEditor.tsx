import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import type { Directives, Framework, HookStyle, ModuleScope, Skill, SkillCategory, Tone } from '@/lib/types';
import { CATEGORY_META, FRAMEWORKS, HOOK_STYLES, SCOPE_META, TONES, describeDirectives, newSkill, parseDirectives, templatePlaceholders } from '@/ai/brain';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, AutoTextarea, Checkbox, ChipInput, Field, InfoTip, Modal, Popover, Segmented, Select, Tooltip } from '@/components/ui/primitives';

const TEMPLATES: { label: string; category: SkillCategory; name: string; text: string }[] = [
  { label: 'Brand voice', category: 'voice', name: 'Our brand voice', text: 'Tone: warm, confident and plain-spoken.\nWrite like a helpful neighbor, not a corporation.\nUse "we" and speak directly to "you".\nNo emojis in emails; light emojis on social.\nNever use: synergy, leverage, game-changer.' },
  { label: 'Ideal customer', category: 'audience', name: 'Ideal customer profile', text: 'Audience: busy working parents aged 30–45.\nThey feel guilty about not having enough time and are skeptical of quick fixes.\nThey say things like “I just need something that works” and “I don’t have time to learn a whole system”.\nThey want: calm evenings, fewer decisions, visible progress.' },
  { label: 'Words to avoid', category: 'rules', name: 'Compliance rules', text: 'Never promise specific income or health results.\nAvoid: guaranteed, cure, overnight, get rich, miracle.\nAlways include a clear way to contact us.' },
  {
    label: 'Proof points',
    category: 'knowledge',
    name: 'Proof points',
    text: 'Facts you can use:\n- Founded in [Year founded].\n- [Number of customers] customers served.\n- [Average rating and where it comes from].\n- [Licences or certifications].',
  },
];

const SCOPES = Object.keys(SCOPE_META) as ModuleScope[];

/** "Applies to": a button with what's picked, opening checkbox rows ("Everywhere" stands alone). */
function ScopePicker({ scope, onToggle }: { scope: ModuleScope[]; onToggle: (s: ModuleScope) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const all = scope.includes('all');
  const text = all ? 'Everywhere' : scope.length === 1 ? SCOPE_META[scope[0]] : `${scope.length} places`;
  return (
    <>
      <button ref={anchor} id="sk-scope" type="button" className="select flex items-center text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
        <span className="min-w-0 flex-1 truncate">{text}</span>
        {!all && <span className="num ml-2 shrink-0 font-mono text-caption text-muted">{scope.length}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="start" className="w-[var(--radix-popover-trigger-width,280px)] min-w-[260px] p-2">
        <div className="flex flex-col gap-1" role="group" aria-label="Applies to">
          {SCOPES.map((s) => (
            <div key={s} className="rounded px-2 py-1.5 hover:bg-surface-2">
              <Checkbox id={`sk-scope-${s}`} checked={scope.includes(s)} onChange={() => onToggle(s)} label={SCOPE_META[s]} />
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

export function SkillEditor({ open, onClose, skill }: { open: boolean; onClose: () => void; skill: Skill | null }) {
  const addSkill = useStore((s) => s.addSkill);
  const updateSkill = useStore((s) => s.updateSkill);
  const [draft, setDraft] = useState<Skill>(() => skill ?? newSkill({ name: '' }));
  useEffect(() => {
    if (open) setDraft(skill ?? newSkill({ name: '' }));
  }, [open, skill]);
  const parsed = useMemo(() => parseDirectives(draft.instructions), [draft.instructions]);
  const detected = describeDirectives({ ...parsed, ...draft.directives });
  // Facts go into every generation, so a skill can't be saved with a Proof points placeholder still in it.
  // Only the template's own placeholders count: real documents contain brackets too ("[sic]", "[1]").
  const unfilled = templatePlaceholders(draft.instructions);
  const setD = (patch: Partial<Directives>) => setDraft((d) => ({ ...d, directives: { ...d.directives, ...patch } }));
  const toggleScope = (s: ModuleScope) =>
    setDraft((d) => {
      if (s === 'all') return { ...d, scope: ['all'] };
      const without = d.scope.filter((x) => x !== 'all' && x !== s);
      const next = d.scope.includes(s) ? without : [...without, s];
      return { ...d, scope: next.length ? next : ['all'] };
    });

  // what's still missing before it can be saved (the button says so in its tooltip)
  const missing = !draft.name.trim() ? 'Give the skill a name first.' : !draft.instructions.trim() && !detected.length ? 'Write what the AI should do first.' : unfilled.length ? `Replace ${unfilled.join(', ')} first.` : '';

  const save = () => {
    if (missing) return;
    const name = draft.name.trim();
    if (skill) {
      updateSkill(skill.id, { ...draft, name });
      toast({ kind: 'ai', title: 'Skill updated', body: 'Every future generation uses the new version.' });
    } else {
      addSkill({ ...draft, name });
      toast({ kind: 'ai', title: `“${name}” added to the Brain`, body: 'It applies from your next generation.' });
    }
    onClose();
  };

  const submit = (
    <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!!missing}>
      {skill ? 'Save skill' : 'Add to Brain'}
    </button>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={skill ? 'Edit skill' : 'New skill'}
      subtitle="Plain-language instructions the AI follows every time it writes."
      icon={<Brain size={20} />}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          {missing ? (
            <Tooltip content={missing}>
              <span tabIndex={0} className="inline-flex rounded-md">
                {submit}
              </span>
            </Tooltip>
          ) : (
            submit
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!skill && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-small text-muted">Start from</span>
            {TEMPLATES.map((t) => (
              <button type="button" key={t.label} className="chip" onClick={() => setDraft((d) => ({ ...d, name: d.name || t.name, category: t.category, instructions: t.text }))}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
          <Field label="Name" htmlFor="sk-name">
            <input id="sk-name" className="input" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="e.g. Our brand voice" data-autofocus={!skill || undefined} />
          </Field>
          <Field label="Category" htmlFor="sk-cat">
            <Select<SkillCategory> id="sk-cat" value={draft.category} onChange={(v) => setDraft((d) => ({ ...d, category: v }))} options={(Object.keys(CATEGORY_META) as SkillCategory[]).map((c) => ({ value: c, label: CATEGORY_META[c].label }))} />
          </Field>
        </div>
        <Field
          label="Instructions"
          htmlFor="sk-ins"
          right={
            <InfoTip title="How the Brain reads this" label="How the Brain reads this">
              One idea per line works best. The Brain picks out rules like tone, emoji use, words to avoid and your call to action, and the AI reads the full text every time it writes.
            </InfoTip>
          }
          error={unfilled.length ? `Replace ${unfilled.join(', ')} with your real details, or delete the line${unfilled.length > 1 ? 's' : ''}. The AI uses these facts as true.` : undefined}
          hint={detected.length ? `Picked up: ${detected.slice(0, 4).join(' · ')}${detected.length > 4 ? ` · +${detected.length - 4} more` : ''}` : undefined}
        >
          <AutoTextarea id="sk-ins" value={draft.instructions} onChange={(v) => setDraft((d) => ({ ...d, instructions: v }))} minRows={6} placeholder={'Tone: friendly and direct.\nNever use: “synergy”, “hustle”.\nEnd posts with: Book your free consult.'} />
        </Field>
        <Field label="Applies to" htmlFor="sk-scope">
          <ScopePicker scope={draft.scope} onToggle={toggleScope} />
        </Field>
        <Accordion type="single" collapsible className="border-t border-line">
          <AccordionItem value="advanced" className="border-b-0">
            <AccordionTrigger className="text-ui">Advanced</AccordionTrigger>
            <AccordionContent>
              <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2">
                <Field label="Short description" htmlFor="sk-desc" className="sm:col-span-2">
                  <input id="sk-desc" className="input" value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="What this skill teaches the AI" />
                </Field>
                <Field label="Priority" hint="When two skills disagree, the higher priority wins." className="sm:col-span-2">
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
                <Field label="Tone" htmlFor="sk-tone">
                  <select id="sk-tone" className="select" value={draft.directives.tone ?? ''} onChange={(e) => setD({ tone: (e.target.value || undefined) as Tone | undefined })}>
                    <option value="">Auto-detect</option>
                    {TONES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} · {t.desc}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Copy framework" htmlFor="sk-framework">
                  <select id="sk-framework" className="select" value={draft.directives.framework ?? ''} onChange={(e) => setD({ framework: (e.target.value || undefined) as Framework | undefined })}>
                    <option value="">None</option>
                    {FRAMEWORKS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label} · {f.desc}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Emoji" htmlFor="sk-emoji">
                  <select id="sk-emoji" className="select" value={draft.directives.emoji ?? ''} onChange={(e) => setD({ emoji: (e.target.value || undefined) as Directives['emoji'] })}>
                    <option value="">Auto</option>
                    <option value="none">None</option>
                    <option value="light">Light</option>
                    <option value="heavy">Plenty</option>
                  </select>
                </Field>
                <Field label="Hook style" htmlFor="sk-hook">
                  <select id="sk-hook" className="select" value={draft.directives.hookStyle ?? ''} onChange={(e) => setD({ hookStyle: (e.target.value || undefined) as HookStyle | undefined })}>
                    <option value="">Auto</option>
                    {HOOK_STYLES.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Length" htmlFor="sk-length">
                  <select id="sk-length" className="select" value={draft.directives.length ?? ''} onChange={(e) => setD({ length: (e.target.value || undefined) as Directives['length'] })}>
                    <option value="">Auto</option>
                    <option value="short">Short</option>
                    <option value="medium">Medium</option>
                    <option value="long">Long</option>
                  </select>
                </Field>
                <Field label="Point of view" htmlFor="sk-person">
                  <select id="sk-person" className="select" value={draft.directives.person ?? ''} onChange={(e) => setD({ person: (e.target.value || undefined) as Directives['person'] })}>
                    <option value="">Auto</option>
                    <option value="we">“We” (team)</option>
                    <option value="i">“I” (founder)</option>
                    <option value="you">“You” focused</option>
                  </select>
                </Field>
                <Field label="Preferred call to action" htmlFor="sk-cta" className="sm:col-span-2">
                  <input id="sk-cta" className="input" value={draft.directives.cta ?? ''} onChange={(e) => setD({ cta: e.target.value || undefined })} placeholder="e.g. Book your free consult" />
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
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </Modal>
  );
}
