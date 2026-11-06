// Step 2: who sees it. Each place in the plan becomes a search; the customer picks every match themselves (nothing
// is picked for them). Meta: radius around cities and interests (ticked from a lookup); Google: language. The
// "special category" question has no default answer.
import { useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import type { AdCampaign } from '@/lib/types';
import type { AdsPlatform, TargetOption } from '@/lib/ads/launchTypes';
import { AdsApiError, searchTargeting } from '@/lib/ads/launchApi';
import { Callout, Field, Segmented, Select, Spinner } from '@/components/ui/primitives';
import { placeSearches, type LaunchDraft } from './draft';

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'it', label: 'Italian' },
  { value: 'nl', label: 'Dutch' },
  { value: 'zh', label: 'Chinese' },
  { value: 'vi', label: 'Vietnamese' },
];

function Lookup({ projectId, platform, dimension, label, initial, picked, onPick }: { projectId: string; platform: AdsPlatform; dimension: 'geo' | 'interest'; label: string; initial: string[]; picked: TargetOption[]; onPick: (t: TargetOption) => void }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<TargetOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (q: string) => {
    const t = q.trim();
    setTerm(t);
    if (t.length < 2 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setResults((await searchTargeting(projectId, platform, dimension, t)).results);
    } catch (e) {
      setErr(e instanceof AdsApiError ? e.message : 'The lookup didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const pickedRefs = new Set(picked.map((p) => p.ref));
  return (
    <div className="flex flex-col gap-2">
      {initial.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-muted">From your plan:</span>
          {initial.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => void run(s)}>
              <Search /> {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(term);
        }}
      >
        <input className="input min-w-0 flex-1" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={dimension === 'geo' ? 'A city, region, ZIP or country' : 'An interest'} aria-label={label} />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || term.trim().length < 2}>
          {busy ? <Spinner size={14} /> : <Search />} Look up
        </button>
      </form>
      {err && <Callout tone="bad">{err}</Callout>}
      {results && (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label={`${label} matches`}>
          {results.length === 0 && <li className="px-3 py-2 text-small text-muted">No matches. Try another spelling or a larger place.</li>}
          {results.map((r) => (
            <li key={r.ref} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 text-small text-ink">
                {r.name}
                {r.path.length > 0 && <span className="block truncate text-caption text-muted">{r.path.join(' › ')}</span>}
              </span>
              <span className="text-caption text-muted">{r.kind}</span>
              <button type="button" className="btn btn-ghost btn-xs" disabled={pickedRefs.has(r.ref)} onClick={() => onPick(r)}>
                <Plus /> {pickedRefs.has(r.ref) ? 'Picked' : 'Pick'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Picked({ items, onRemove, empty }: { items: TargetOption[]; onRemove: (ref: string) => void; empty: string }) {
  if (!items.length) return <p className="text-caption text-muted">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t) => (
        <span key={t.ref} className="chip">
          {t.name}
          <button type="button" className="-mr-1 inline-flex" aria-label={`Remove ${t.name}`} onClick={() => onRemove(t.ref)}>
            <X />
          </button>
        </span>
      ))}
    </div>
  );
}

export function AudienceStep({ projectId, plan, draft, onChange }: { projectId: string; plan: AdCampaign; draft: LaunchDraft; onChange: (patch: Partial<LaunchDraft>) => void }) {
  const meta = draft.platform === 'meta';
  return (
    <div className="flex flex-col gap-5">
      <Field label="Places">
        <div className="flex flex-col gap-2">
          <Picked items={draft.locations} empty="No place picked yet." onRemove={(ref) => onChange({ locations: draft.locations.filter((l) => l.ref !== ref) })} />
          <Lookup projectId={projectId} platform={draft.platform} dimension="geo" label="Find a place" initial={placeSearches(plan.locations)} picked={draft.locations} onPick={(t) => onChange({ locations: [...draft.locations, t].slice(0, 25) })} />
        </div>
      </Field>
      {meta ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Radius around each city (miles)" htmlFor="lw-radius" hint="Meta’s smallest is 10 miles.">
              <input id="lw-radius" type="number" min={10} max={50} className="input num" value={draft.radiusMi} onChange={(e) => onChange({ radiusMi: Math.max(10, Math.min(50, Math.round(Number(e.target.value) || 10))) })} />
            </Field>
            <Field label="Ages" hint="From the plan.">
              <p className="num py-2 text-ui text-ink">
                {plan.ageMin}–{plan.ageMax}
              </p>
            </Field>
          </div>
          <Field label="Interests" hint="Optional. Interests from the plan that you don’t pick are left out.">
            <div className="flex flex-col gap-2">
              <Picked items={draft.interests} empty="No interest picked: Meta shows it to anyone in the places above." onRemove={(ref) => onChange({ interests: draft.interests.filter((l) => l.ref !== ref) })} />
              <Lookup projectId={projectId} platform="meta" dimension="interest" label="Find an interest" initial={plan.interests.slice(0, 8)} picked={draft.interests} onPick={(t) => onChange({ interests: [...draft.interests, t].slice(0, 25) })} />
            </div>
          </Field>
        </>
      ) : (
        <Field label="Language" htmlFor="lw-lang" hint="Google Search doesn’t target by age, radius or interests here.">
          <Select id="lw-lang" value={draft.languages[0] ?? 'en'} onChange={(v) => onChange({ languages: [v] })} options={LANGUAGES} />
        </Field>
      )}
      <div>
        <p className="label" id={`lw-special-${draft.platform}`}>
          Is this ad about housing, jobs, credit, financial products, politics or gambling?
        </p>
        <Segmented<'' | 'none' | 'yes'> aria-labelledby={`lw-special-${draft.platform}`} value={draft.specialCategory} onChange={(v) => onChange({ specialCategory: v })} options={[{ id: 'none', label: 'No' }, { id: 'yes', label: 'Yes' }]} />
        {draft.specialCategory === 'yes' && <Callout tone="warn" className="mt-2">Ads like this need special settings the app doesn’t support yet. Use {meta ? 'Meta Ads Manager' : 'Google Ads'} for this one.</Callout>}
      </div>
    </div>
  );
}
