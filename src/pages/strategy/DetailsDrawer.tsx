// "Your details": the owner's own words for the strategy (goal, budget, time, competitors, what they've
// tried, notes). All optional, never written by the AI. Saved on blur, on Save and when the drawer closes;
// Cancel puts back what they were when the drawer opened.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@/lib/types';
import type { StrategyInputs } from '@/lib/strategyTypes';
import { readStrategy } from '@/lib/strategy';
import { setStrategyInputs } from '@/lib/strategyWrite';
import { FORMATS, matchBusinessType } from '@/ai/knowledge';
import { AutoTextarea, ChipInput, Drawer, Field } from '@/components/ui/primitives';

export interface DetailsDraft {
  draft: StrategyInputs;
  set: (patch: Partial<StrategyInputs>) => void;
  /** write the fields that changed (all of them when none is named) */
  save: (field?: keyof StrategyInputs) => void;
}

/** The details being typed, kept for the page (so every place that shows them shows the same words). */
export function useDetailsDraft(projectId: string, stored: StrategyInputs): DetailsDraft {
  const [draft, setDraft] = useState<StrategyInputs>(stored);
  const latest = useRef(draft);
  latest.current = draft;
  const set = useCallback((patch: Partial<StrategyInputs>) => setDraft((d) => ({ ...d, ...patch })), []);
  const save = useCallback(
    (field?: keyof StrategyInputs) => {
      const d = latest.current;
      const keys = field ? [field] : (Object.keys(d) as (keyof StrategyInputs)[]);
      const patch: Partial<StrategyInputs> = {};
      for (const k of keys) if (JSON.stringify(d[k]) !== JSON.stringify(stored[k])) (patch as Record<string, unknown>)[k] = d[k];
      if (Object.keys(patch).length) setStrategyInputs(projectId, patch);
    },
    [projectId, stored],
  );
  return { draft, set, save };
}

/** "Bakery · Austin · for busy families" from the project's setup. */
export function projectLine(p: Project): string {
  const type = p.track === 'business' ? matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`).label : p.format ? FORMATS[p.format]?.label : 'Digital product';
  const audience = (p.brand.audience || p.idea?.audience || '').trim();
  return [type, p.location?.city, audience ? `for ${audience.length > 60 ? `${audience.slice(0, 59).trimEnd()}…` : audience}` : ''].filter(Boolean).join(' · ');
}

/** `idPrefix` keeps the ids apart when the form is shown in two places at once. */
export function DetailsForm({ project, d, idPrefix = 'strategy' }: { project: Project; d: DetailsDraft; idPrefix?: string }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  const text = (k: 'goal' | 'budget' | 'timePerWeek', label: string, placeholder: string, hint?: string, max = 200) => (
    <Field label={label} hint={hint} htmlFor={id(k)}>
      <input id={id(k)} className="input" value={d.draft[k]} placeholder={placeholder} maxLength={max} onChange={(e) => d.set({ [k]: e.target.value })} onBlur={() => d.save(k)} />
    </Field>
  );
  return (
    <div className="flex flex-col gap-4">
      {text('goal', 'What do you want in the next 30 days?', 'e.g. 10 new bookings, or my first 20 sales', 'Your words. The plan never promises numbers.', 200)}
      {text('budget', 'Budget for promotion', 'e.g. $0, or $100 a month for ads', 'Leave it empty if you don’t know. Paid ads are suggested only when you give a budget.', 120)}
      {text('timePerWeek', 'Time you can spend each week', 'e.g. 3 hours', undefined, 80)}
      <Field label="Who else sells this near you or online?" hint="Research may look at how they promote.">
        <ChipInput
          values={d.draft.competitors}
          max={10}
          placeholder="Name or website, then Enter"
          onChange={(v) => {
            d.set({ competitors: v });
            // a chip is a finished entry: keep it right away
            setStrategyInputs(project.id, { competitors: v });
          }}
        />
      </Field>
      <Field label="What have you tried already?" htmlFor={id('tried')}>
        <AutoTextarea id={id('tried')} value={d.draft.tried} minRows={2} maxLength={400} placeholder="e.g. Instagram posts, flyers, one Facebook ad" onChange={(v) => d.set({ tried: v })} onBlur={() => d.save('tried')} />
      </Field>
      <Field label="Anything else the plan should know?" htmlFor={id('notes')}>
        <AutoTextarea id={id('notes')} value={d.draft.notes} minRows={2} maxLength={600} onChange={(v) => d.set({ notes: v })} onBlur={() => d.save('notes')} />
      </Field>
      <p className="text-caption text-muted">From your project’s setup: {projectLine(project) || 'your setup'}.</p>
    </div>
  );
}

export function DetailsDrawer({ open, onClose, project, d }: { open: boolean; onClose: () => void; project: Project; d: DetailsDraft }) {
  // what the details were when the drawer opened: Cancel puts them back (fields save as you leave them)
  const opened = useRef<StrategyInputs | null>(null);
  useEffect(() => {
    opened.current = open ? readStrategy(project).inputs : null;
    // only when it opens or closes
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    d.save();
    onClose();
  };
  const cancel = () => {
    const was = opened.current;
    if (was) {
      d.set(was);
      if (JSON.stringify(readStrategy(project).inputs) !== JSON.stringify(was)) setStrategyInputs(project.id, was);
    }
    onClose();
  };
  return (
    <Drawer
      open={open}
      onClose={close}
      title="Your details"
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={close}>
            Save
          </button>
        </>
      }
    >
      <p className="mb-4 text-small text-muted">All optional. Your own words: the AI reads them and never writes them.</p>
      <DetailsForm project={project} d={d} />
    </Drawer>
  );
}
