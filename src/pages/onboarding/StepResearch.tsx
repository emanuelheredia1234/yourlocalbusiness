import { useMemo, useState } from 'react';
import { ArrowRight, Check, Lightbulb } from 'lucide-react';
import type { ProductFormat, ProductIdea, Project } from '@/lib/types';
import { cn, fmtMoney } from '@/lib/utils';
import { FORMAT_LIST, FORMATS, matchNiche, NICHE_SUGGESTIONS } from '@/ai/knowledge';
import { productIdeasTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useStore } from '@/store/useStore';
import { Icon } from '@/components/ui/Icon';
import { Badge, Field, Segmented } from '@/components/ui/primitives';
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
    <div className="flex flex-col gap-8">
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
          {FORMAT_LIST.map((f) => {
            const on = format === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFormat(f.id)}
                aria-pressed={on}
                className={cn('relative flex min-w-0 flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-[border-color,box-shadow,background-color] duration-120', on ? 'border-transparent bg-primary-soft/50 ring-[1.5px] ring-inset ring-primary' : 'border-line bg-surface hover:border-line-3 hover:shadow-sm')}
              >
                {on && (
                  <span className="absolute right-3 top-3 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-primary text-on-primary" aria-hidden="true">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-surface-3 text-ink-2">
                  <Icon name={f.icon} size={16} />
                </span>
                <span className="text-ui text-ink">{f.label}</span>
                <span className="text-small text-muted">{f.desc}</span>
                <span className="num font-mono text-caption text-ink-2">
                  ${f.price[0]}–${f.price[1]}
                  {f.model === 'monthly' ? '/mo' : ''}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="card flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-h3 text-ink">AI product ideas</h2>
            <p className="mt-0.5 text-small text-muted">Built from your niche, category and format: suggestions, not market research.</p>
          </div>
          <div className="flex items-center gap-2">
            <Segmented size="sm" options={[{ id: '3', label: '3 ideas' }, { id: '4', label: '4' }, { id: '5', label: '5' }]} value={count} onChange={setCount} />
            {ideas.length > 0 ? <RegenerateButton onClick={find} running={ai.running} label="New ideas" /> : <GenerateButton variant="ai" running={ai.running} onClick={find} disabled={!ready} runningLabel="Researching…">Suggest product ideas</GenerateButton>}
          </div>
        </div>
        {!ready && !ideas.length && <p className="text-small text-muted">Add a niche, a category and a format to start.</p>}
        <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
      </section>

      {ideas.length > 0 && (
        <section className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="Product ideas">
          {ideas.map((idea, i) => (
            <article key={idea.id} className={cn('card flex flex-col gap-4 p-5', project.idea?.id === idea.id && 'border-transparent ring-[1.5px] ring-inset ring-primary')} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge>{idea.angle}</Badge>
                  <Badge>{FORMATS[idea.format].short}</Badge>
                </div>
                <h3 className="text-h3 text-ink">{idea.title}</h3>
                <p className="mt-1 text-body text-ink-2">{idea.hook}</p>
              </div>
              <dl className="well grid grid-cols-2 gap-x-4 gap-y-3 p-3 text-small">
                <div>
                  <dt className="text-caption text-muted">Audience</dt>
                  <dd className="mt-0.5 text-ink">{idea.audience}</dd>
                </div>
                <div>
                  <dt className="text-caption text-muted">Pain solved</dt>
                  <dd className="mt-0.5 text-ink">{idea.pain}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-caption text-muted">Suggested price</dt>
                  <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
                    <span className="num font-mono text-ui text-ink">
                      {fmtMoney(idea.price)}
                      {idea.priceModel === 'monthly' ? '/mo' : ''}
                    </span>
                    <span className="text-caption text-muted">A starting point. You set the price in the Studio.</span>
                  </dd>
                </div>
              </dl>
              <ul className="flex flex-col gap-1 text-small text-ink-2">
                {idea.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check size={14} className="mt-[3px] shrink-0 text-primary" aria-hidden="true" /> {f}
                  </li>
                ))}
              </ul>
              {(idea.fit ?? []).length > 0 && (
                <div>
                  <p className="mb-1 flex items-center gap-1.5 text-caption font-medium text-muted">
                    <Lightbulb size={12} aria-hidden="true" /> Why this could fit you
                  </p>
                  <ul className="flex flex-col gap-0.5 text-small text-ink-2">
                    {idea.fit.map((s) => (
                      <li key={s} className="flex gap-1.5">
                        <Check size={14} className="mt-[3px] shrink-0 text-muted" aria-hidden="true" /> {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button type="button" className="btn btn-secondary mt-auto" onClick={() => select(idea)}>
                Select &amp; build this product <ArrowRight />
              </button>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
