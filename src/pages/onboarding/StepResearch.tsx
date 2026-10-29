import { useMemo, useState } from 'react';
import { ArrowRight, Check, Lightbulb, TrendingUp } from 'lucide-react';
import type { ProductFormat, ProductIdea, Project } from '@/lib/types';
import { cn, fmtMoney } from '@/lib/utils';
import { FORMAT_LIST, FORMATS, matchNiche, NICHE_SUGGESTIONS } from '@/ai/knowledge';
import { productIdeasTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useStore } from '@/store/useStore';
import { Icon } from '@/components/ui/Icon';
import { Field, ProgressRing, Segmented } from '@/components/ui/primitives';
import { AIResultBar, AIThinking, GenerateButton, RegenerateButton } from '@/components/ai/AI';

export function StepResearch({ project, onNext }: { project: Project; onNext: () => void }) {
  const update = useStore((s) => s.updateProject);
  const [niche, setNiche] = useState(project.niche);
  const [category, setCategory] = useState(project.category);
  const [format, setFormat] = useState<ProductFormat | null>(project.format);
  const [count, setCount] = useState<'3' | '4' | '5'>('4');
  const ai = useAI(productIdeasTask);
  const ideas = project.ideas;
  const prof = useMemo(() => matchNiche(niche, ''), [niche]);
  const categorySuggestions = prof?.categories ?? [];
  const ready = niche.trim().length > 1 && category.trim().length > 1 && !!format;

  const find = async () => {
    if (!ready || !format) return;
    update(project.id, (p) => ({ ...p, niche: niche.trim(), category: category.trim(), format }));
    const res = await ai.run({ niche: niche.trim(), category: category.trim(), format, count: Number(count) }, { project: { ...project, niche, category, format } });
    if (res) update(project.id, (p) => ({ ...p, ideas: res }));
  };

  const select = (idea: ProductIdea) => {
    update(project.id, (p) => ({
      ...p,
      niche: niche.trim(),
      category: category.trim(),
      format: idea.format,
      idea,
      summary: idea.solution,
      studio: { ...p.studio, price: idea.price, priceModel: idea.priceModel, outlineLabel: FORMATS[idea.format].outlineLabel },
      brand: { ...p.brand, audience: p.brand.audience || idea.audience },
    }));
    onNext();
  };

  return (
    <div className="flex flex-col gap-7">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="1. Your niche" htmlFor="niche" hint="The market you want to serve.">
          <input id="niche" className="input" placeholder="e.g. Personal Finance" value={niche} onChange={(e) => setNiche(e.target.value)} />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {NICHE_SUGGESTIONS.slice(0, 8).map((n) => (
              <button key={n} type="button" className={cn('chip', niche === n && 'chip-active')} onClick={() => setNiche(n)}>
                {n}
              </button>
            ))}
          </div>
        </Field>
        <Field label="2. A specific category" htmlFor="category" hint="The narrower the better: specific products sell.">
          <input id="category" className="input" placeholder="e.g. Freelancer Tax Tracking" value={category} onChange={(e) => setCategory(e.target.value)} />
          {categorySuggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {categorySuggestions.map((c) => (
                <button key={c} type="button" className={cn('chip', category === c && 'chip-active')} onClick={() => setCategory(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </Field>
      </section>

      <section>
        <p className="label">3. What type of digital product do you want to sell?</p>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {FORMAT_LIST.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFormat(f.id)}
              aria-pressed={format === f.id}
              className={cn('group flex min-w-0 flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-all', format === f.id ? 'border-primary bg-primary-soft ring-1 ring-primary' : 'border-line bg-surface hover:border-line-2 hover:bg-surface-2')}
            >
              <span className="flex w-full items-center justify-between">
                <span className={cn('flex h-8 w-8 items-center justify-center rounded-md', format === f.id ? 'bg-primary text-on-primary' : 'bg-surface-2 text-ink-2')}>
                  <Icon name={f.icon} size={16} />
                </span>
                {format === f.id && <Check size={16} className="text-primary" />}
              </span>
              <span className="text-[13.5px] font-semibold text-ink">{f.label}</span>
              <span className="text-xs leading-snug text-muted">{f.desc}</span>
              <span className="num text-[11px] font-semibold text-ink-2">
                ${f.price[0]}–${f.price[1]}
                {f.model === 'monthly' ? '/mo' : ''}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-display text-[16px] font-semibold">AI Winning Product Finder</p>
            <p className="text-xs text-muted">Scores demand, competition, price and scalability for your exact niche and format.</p>
          </div>
          <div className="flex items-center gap-2">
            <Segmented size="sm" options={[{ id: '3', label: '3 ideas' }, { id: '4', label: '4' }, { id: '5', label: '5' }]} value={count} onChange={setCount} />
            {ideas.length > 0 ? <RegenerateButton onClick={find} running={ai.running} label="New ideas" /> : <GenerateButton running={ai.running} onClick={find} disabled={!ready}>Find winning products</GenerateButton>}
          </div>
        </div>
        {!ready && !ideas.length && <p className="text-xs text-muted">Add a niche, a category and a format to start.</p>}
        <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
      </section>

      {ideas.length > 0 && (
        <section className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="Winning product ideas">
          {ideas.map((idea, i) => (
            <article key={idea.id} className={cn('panel flex flex-col gap-3 p-4', project.idea?.id === idea.id && 'ring-2 ring-primary')} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="flex items-start gap-3">
                <ProgressRing value={idea.score / 100} size={52} stroke={5} label={String(idea.score)} color={idea.score >= 75 ? 'rgb(var(--good))' : idea.score >= 60 ? 'rgb(var(--primary))' : 'rgb(var(--warn))'} />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <span className="badge bg-accent-soft text-on-accent">{idea.angle}</span>
                    <span className="badge bg-surface-2 text-ink-2">{FORMATS[idea.format].short}</span>
                  </div>
                  <h3 className="font-display text-[17px] font-semibold leading-snug">{idea.title}</h3>
                  <p className="mt-1 text-[13px] text-ink-2">{idea.hook}</p>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-[12.5px]">
                <div className="rounded-md bg-surface-2 p-2.5">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Audience</dt>
                  <dd className="mt-0.5 font-medium text-ink">{idea.audience}</dd>
                </div>
                <div className="rounded-md bg-surface-2 p-2.5">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Pain solved</dt>
                  <dd className="mt-0.5 font-medium text-ink">{idea.pain}</dd>
                </div>
                <div className="rounded-md bg-surface-2 p-2.5">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Suggested price</dt>
                  <dd className="num mt-0.5 text-[15px] font-bold text-ink">
                    {fmtMoney(idea.price)}
                    {idea.priceModel === 'monthly' ? '/mo' : ''}
                  </dd>
                </div>
                <div className="rounded-md bg-surface-2 p-2.5">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Revenue potential</dt>
                  <dd className="num mt-0.5 font-bold text-ink">
                    {fmtMoney(idea.revenueLow, { compact: true })}–{fmtMoney(idea.revenueHigh, { compact: true })}
                    <span className="font-normal text-muted">/mo</span>
                  </dd>
                </div>
              </dl>
              <ul className="flex flex-col gap-1 text-[12.5px] text-ink-2">
                {idea.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check size={14} className="mt-0.5 shrink-0 text-primary" /> {f}
                  </li>
                ))}
              </ul>
              <div className="rounded-md border border-dashed border-line-2 p-2.5">
                <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  <TrendingUp size={12} /> Why it can win
                </p>
                <ul className="flex flex-col gap-0.5 text-xs text-ink-2">
                  {idea.signals.map((s) => (
                    <li key={s} className="flex gap-1.5">
                      <Lightbulb size={12} className="mt-0.5 shrink-0 text-accent" /> {s}
                    </li>
                  ))}
                </ul>
              </div>
              <button className="btn btn-primary mt-auto" onClick={() => select(idea)}>
                Select &amp; build this product <ArrowRight size={16} />
              </button>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
