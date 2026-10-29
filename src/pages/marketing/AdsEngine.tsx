import { useMemo, useState } from 'react';
import { Check, Globe, MoreHorizontal, Pause, Play, Plus, Rocket, Search, Square, Target, ThumbsUp, Trash2, Users } from 'lucide-react';
import type { AdCampaign, AdCreative, AdObjective, AdPlatform, Project, SearchAd, StyleId } from '@/lib/types';
import { cn, fmtCompact, fmtMoney, fmtPct, stripProtocol } from '@/lib/utils';
import { IMAGE_STYLES, STYLE_LABEL, VIDEO_STYLES, isVideoStyle } from '@/ai/knowledge';
import { AD_OBJECTIVES, AD_PLATFORMS, newAdCampaign, projectAds, suggestInterests } from '@/ai/local/ads';
import { buildFacts } from '@/ai/text';
import { adsTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { adDaily } from '@/lib/metrics';
import { useNow } from '@/lib/hooks';
import { useActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, ChipInput, Empty, Field, LinesEditor, confirmAction } from '@/components/ui/primitives';
import { StatTile } from '@/components/charts/Charts';
import { PostVisual } from '@/components/visuals/PostVisual';
import { LogoMark } from '@/components/brand/Logo';
import { MarketingHeader } from './MarketingNav';

const CTAS = ['Learn More', 'Shop Now', 'Book Now', 'Sign Up', 'Download', 'Get Quote', 'Contact Us', 'Get Offer'];

export default function AdsEngine() {
  const project = useActiveProject()!;
  const ads = useStore((s) => s.ads);
  const upsertAd = useStore((s) => s.upsertAd);
  const campaigns = useMemo(() => ads.filter((a) => a.projectId === project.id).sort((a, b) => b.createdAt - a.createdAt), [ads, project.id]);
  const [activeId, setActiveId] = useState<string | null>(campaigns[0]?.id ?? null);
  const active = campaigns.find((c) => c.id === activeId) ?? campaigns[0] ?? null;

  const create = () => {
    const c = newAdCampaign(project);
    upsertAd(c);
    setActiveId(c.id);
  };

  return (
    <div className="flex flex-col gap-5">
      <MarketingHeader
        eyebrow="Marketing Hub · Paid ads"
        title="Paid ads engine"
        desc="Plan campaigns for Meta, TikTok, Google Search and LinkedIn: audiences, three A/B creatives, search ads and budget projections based on industry benchmarks."
        actions={
          <button className="btn btn-primary" onClick={create}>
            <Plus size={16} /> New campaign
          </button>
        }
      />
      {campaigns.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Campaigns">
          {campaigns.map((c) => (
            <button key={c.id} role="tab" aria-selected={active?.id === c.id} className={cn('chip', active?.id === c.id && 'chip-active')} onClick={() => setActiveId(c.id)}>
              <StatusDot status={c.status} /> {c.name}
            </button>
          ))}
        </div>
      )}
      {!active ? (
        <Empty icon={<Target size={20} />} title="No ad campaigns yet" body={`Create a campaign and the AI drafts audiences, creatives and search ads for ${project.brand.name}, with projected reach, clicks and cost.`} action={<button className="btn btn-primary" onClick={create}><Plus size={15} /> Create campaign</button>} className="min-h-[320px]" />
      ) : (
        <CampaignEditor key={active.id} project={project} c={active} onDeleted={() => setActiveId(null)} />
      )}
    </div>
  );
}

function StatusDot({ status }: { status: AdCampaign['status'] }) {
  return <span className={cn('h-2 w-2 rounded-full', status === 'active' ? 'bg-good' : status === 'paused' ? 'bg-warn' : status === 'completed' ? 'bg-muted' : 'bg-line-2')} aria-hidden="true" />;
}

function CampaignEditor({ project, c, onDeleted }: { project: Project; c: AdCampaign; onDeleted: () => void }) {
  const upsertAd = useStore((s) => s.upsertAd);
  const deleteAd = useStore((s) => s.deleteAd);
  const ai = useAI(adsTask);
  const facts = useMemo(() => buildFacts(project), [project]);
  const suggestions = useMemo(() => suggestInterests(facts), [facts]);
  const live = () => useStore.getState().ads.find((a) => a.id === c.id) ?? c;
  const set = (patch: Partial<AdCampaign>) => {
    const next = { ...live(), ...patch };
    if ('platforms' in patch || 'dailyBudget' in patch || 'durationDays' in patch || 'objective' in patch) next.projections = projectAds(next, facts);
    upsertAd(next);
  };
  const setCreative = (id: string, patch: Partial<AdCreative>) => set({ creatives: live().creatives.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const locked = c.status === 'active' || c.status === 'completed';

  const generate = async () => {
    if (c.creatives.length && !(await confirmAction({ title: 'Regenerate creatives and audiences?', body: 'Your edited ad copy will be replaced.', confirmLabel: 'Regenerate' }))) return;
    const r = await ai.run({ campaign: live() });
    if (r) set({ audiences: r.audiences, interests: c.interests.length ? c.interests : r.interests, creatives: r.creatives, search: r.search, projections: r.projections, selectedCreativeIds: r.creatives.map((x) => x.id) });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="panel flex min-w-0 flex-col gap-4 p-4 sm:p-5" aria-label="Campaign settings">
          <div className="flex flex-wrap items-center gap-2">
            <input className="min-w-[200px] flex-1 rounded bg-transparent px-1 py-1 font-display text-[18px] font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2" value={c.name} onChange={(e) => set({ name: e.target.value })} aria-label="Campaign name" />
            <span className={cn('badge', c.status === 'active' ? 'bg-good-soft text-good' : c.status === 'paused' ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted')}>
              <StatusDot status={c.status} /> {c.status === 'draft' ? 'Draft' : c.status === 'active' ? 'Live (simulated)' : c.status === 'paused' ? 'Paused' : 'Completed'}
            </span>
          </div>
          {locked && <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">Budget and targeting are locked while the campaign runs. Pause it to make changes.</p>}
          <fieldset disabled={locked} className="flex flex-col gap-4 disabled:opacity-70">
            <Field label="Objective">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4" role="radiogroup" aria-label="Objective">
                {AD_OBJECTIVES.map((o) => (
                  <button key={o.id} role="radio" aria-checked={c.objective === o.id} className={cn('rounded-md border p-2.5 text-left', c.objective === o.id ? 'border-primary bg-primary-soft' : 'border-line hover:bg-surface-2')} onClick={() => set({ objective: o.id as AdObjective })}>
                    <span className="block text-[13px] font-semibold">{o.label}</span>
                    <span className="block text-[11px] leading-snug text-muted">{o.desc}</span>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Platforms">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {AD_PLATFORMS.map((p) => {
                  const on = c.platforms.includes(p.id);
                  return (
                    <label key={p.id} className={cn('flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5', on ? 'border-primary bg-primary-soft/60' : 'border-line hover:bg-surface-2')}>
                      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--primary))]" checked={on} onChange={() => set({ platforms: on ? c.platforms.filter((x) => x !== p.id) : [...c.platforms, p.id as AdPlatform] })} />
                      <span>
                        <span className="block text-[13px] font-semibold">{p.label}</span>
                        <span className="block text-[11.5px] text-muted">{p.desc}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label={`Daily budget · ${fmtMoney(c.dailyBudget)}`} htmlFor="ad-budget">
                <input id="ad-budget" type="range" min={5} max={500} step={5} value={c.dailyBudget} onChange={(e) => set({ dailyBudget: Number(e.target.value) })} className="w-full accent-[rgb(var(--primary))]" />
              </Field>
              <Field label={`Duration · ${c.durationDays} days`} htmlFor="ad-days">
                <input id="ad-days" type="range" min={3} max={60} value={c.durationDays} onChange={(e) => set({ durationDays: Number(e.target.value) })} className="w-full accent-[rgb(var(--primary))]" />
              </Field>
              <Field label="Start date" htmlFor="ad-start">
                <input id="ad-start" type="date" className="input" value={c.startDate} onChange={(e) => e.target.value && set({ startDate: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_120px_160px]">
              <Field label="Locations" htmlFor="ad-loc">
                <input id="ad-loc" className="input" value={c.locations} onChange={(e) => set({ locations: e.target.value })} />
              </Field>
              <Field label="Radius (mi)" htmlFor="ad-rad">
                <input id="ad-rad" type="number" min={0} max={100} className="input num" value={c.radiusMi} onChange={(e) => set({ radiusMi: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
              </Field>
              <Field label="Ages">
                <div className="flex items-center gap-1.5">
                  <input type="number" min={13} max={65} className="input num" value={c.ageMin} onChange={(e) => set({ ageMin: Math.max(13, Math.min(c.ageMax, Number(e.target.value) || 18)) })} aria-label="Minimum age" />
                  <span className="text-muted">–</span>
                  <input type="number" min={13} max={65} className="input num" value={c.ageMax} onChange={(e) => set({ ageMax: Math.max(c.ageMin, Math.min(65, Number(e.target.value) || 65)) })} aria-label="Maximum age" />
                </div>
              </Field>
            </div>
            <Field label="Interests" hint="Leave empty and the AI picks interests for your niche.">
              <ChipInput values={c.interests} onChange={(v) => set({ interests: v })} placeholder="Add an interest" max={15} />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {suggestions
                  .filter((s) => !c.interests.includes(s))
                  .slice(0, 8)
                  .map((s) => (
                    <button key={s} type="button" className="chip text-[11.5px]" onClick={() => set({ interests: [...c.interests, s] })}>
                      + {s}
                    </button>
                  ))}
              </div>
            </Field>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <GenerateButton running={ai.running} onClick={generate} disabled={!c.platforms.length || locked}>
              {c.creatives.length ? 'Regenerate audiences & creatives' : 'Generate audiences & creatives'}
            </GenerateButton>
            <button
              className="btn btn-ghost btn-sm ml-auto text-muted hover:text-bad"
              onClick={async () => {
                if (await confirmAction({ title: `Delete “${c.name}”?`, body: 'The campaign and its creatives will be removed.', confirmLabel: 'Delete', danger: true })) {
                  deleteAd(c.id);
                  onDeleted();
                }
              }}
            >
              <Trash2 size={14} /> Delete campaign
            </button>
          </div>
          <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
          {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
        </section>

        <Projections c={c} onStatus={(status) => set(status === 'active' && !c.launchedAt ? { status, launchedAt: Date.now() } : { status })} />
      </div>

      {c.creatives.length > 0 && (
        <section aria-label="Ad creatives">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="section-title">A/B creatives</h2>
              <p className="text-[13px] text-muted">Three angles to test against each other. Untick a variant to leave it out of the campaign.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {c.creatives.map((cr) => (
              <CreativeCard key={cr.id} project={project} cr={cr} selected={c.selectedCreativeIds.includes(cr.id)} locked={locked} onSelect={(v) => set({ selectedCreativeIds: v ? [...c.selectedCreativeIds, cr.id] : c.selectedCreativeIds.filter((x) => x !== cr.id) })} onChange={(p) => setCreative(cr.id, p)} />
            ))}
          </div>
        </section>
      )}

      {c.search && <SearchAds project={project} search={c.search} onChange={(search) => set({ search })} />}

      {c.audiences.length > 0 && (
        <section aria-label="Audiences">
          <h2 className="section-title mb-3 flex items-center gap-2">
            <Users size={17} className="text-primary" /> Audiences
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {c.audiences.map((a) => (
              <div key={a.id} className="panel flex flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[14px] font-semibold">{a.name}</p>
                  <span className="badge shrink-0 bg-surface-2 text-ink-2">{a.size}</span>
                </div>
                <p className="text-[12.5px] text-muted">{a.description}</p>
                <div className="mt-auto flex flex-wrap gap-1">
                  {a.interests.map((i) => (
                    <span key={i} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                      {i}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Projections({ c, onStatus }: { c: AdCampaign; onStatus: (s: AdCampaign['status']) => void }) {
  const now = useNow(10_000);
  const p = c.projections;
  const delivered = useMemo(() => adDaily(c, now), [c, now]);
  const sum = (k: 'spend' | 'impressions' | 'clicks' | 'conversions') => delivered.reduce((n, d) => n + d[k], 0);
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <section className="panel p-4" aria-label="Projected results">
        <h2 className="mb-1 text-[14px] font-semibold">Projected results</h2>
        <p className="mb-3 text-xs text-muted">
          {fmtMoney(c.dailyBudget)}/day × {c.durationDays} days. Estimates from typical benchmark ranges; real results vary.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Mini label="Total spend" value={fmtMoney(p.spend)} />
          <Mini label="Impressions" value={fmtCompact(p.impressions)} />
          <Mini label="Clicks" value={fmtCompact(p.clicks)} sub={`CTR ${fmtPct(p.ctr)}`} />
          <Mini label="Cost per click" value={fmtMoney(p.cpc, { cents: true })} />
          <Mini label="Conversions" value={fmtCompact(p.conversions)} sub={`CVR ${fmtPct(p.cvr)}`} />
          <Mini label="Cost per result" value={fmtMoney(p.cpa, { cents: true })} />
          <Mini label="Reach" value={fmtCompact(p.reach)} />
          <Mini label="ROAS" value={`${p.roas.toFixed(1)}×`} />
        </div>
      </section>
      <section className="panel flex flex-col gap-3 p-4" aria-label="Launch">
        <h2 className="text-[14px] font-semibold">Launch</h2>
        {c.status === 'draft' && (
          <>
            <button className="btn btn-primary" disabled={!c.creatives.length || !c.selectedCreativeIds.length} onClick={() => {
              onStatus('active');
              useStore.getState().notify({ kind: 'info', title: `Ad campaign live (simulated): ${c.name}`, route: 'marketing-ads' });
              toast({ kind: 'success', title: 'Campaign launched (simulation)', body: 'Delivery is simulated from your projections and shows up in Analytics.' });
            }}>
              <Rocket size={15} /> Launch campaign
            </button>
            <p className="text-xs text-muted">{c.creatives.length ? 'This is a simulated launch: no ad accounts are charged. Delivery is modeled from the projections above.' : 'Generate creatives first.'}</p>
          </>
        )}
        {c.status === 'active' && (
          <div className="flex gap-2">
            <button className="btn btn-secondary flex-1" onClick={() => onStatus('paused')}>
              <Pause size={15} /> Pause
            </button>
            <button className="btn btn-ghost" onClick={() => onStatus('completed')}>
              <Square size={13} /> End
            </button>
          </div>
        )}
        {c.status === 'paused' && (
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" onClick={() => onStatus('active')}>
              <Play size={15} /> Resume
            </button>
            <button className="btn btn-ghost" onClick={() => onStatus('completed')}>
              <Square size={13} /> End
            </button>
          </div>
        )}
        {c.launchedAt && (
          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Spent so far" value={fmtMoney(sum('spend'))} hint="Simulated delivery" />
            <StatTile label="Clicks so far" value={fmtCompact(sum('clicks'))} trend={delivered.map((d) => d.clicks)} />
            <StatTile label="Impressions" value={fmtCompact(sum('impressions'))} trend={delivered.map((d) => d.impressions)} />
            <StatTile label="Conversions" value={fmtCompact(sum('conversions'))} />
          </div>
        )}
      </section>
    </aside>
  );
}

function Mini({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <p className="text-[11px] font-medium text-muted">{label}</p>
      <p className="num text-[16px] font-bold">{value}</p>
      {sub && <p className="num text-[10.5px] text-muted">{sub}</p>}
    </div>
  );
}

function CreativeCard({ project, cr, selected, locked, onSelect, onChange }: { project: Project; cr: AdCreative; selected: boolean; locked: boolean; onSelect: (v: boolean) => void; onChange: (p: Partial<AdCreative>) => void }) {
  const [editing, setEditing] = useState(false);
  const site = stripProtocol(project.brand.websiteUrl || `${project.brand.slug}.com`).toUpperCase();
  return (
    <article className={cn('panel flex min-w-0 flex-col overflow-hidden', selected ? 'ring-2 ring-primary' : 'opacity-80')}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <label className="flex items-center gap-2 text-[13px] font-semibold">
          <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" checked={selected} disabled={locked} onChange={(e) => onSelect(e.target.checked)} />
          Variant {cr.variant}
        </label>
        <span className="text-xs text-muted">{cr.angle}</span>
      </div>
      <div className="bg-white text-[#1c1e21]">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <LogoMark colors={project.brand.colors} logo={project.brand.logo} name={project.brand.name} size={32} />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-semibold">{project.brand.name}</p>
            <p className="flex items-center gap-1 text-[11px] text-[#65676b]">
              Sponsored · <Globe size={10} />
            </p>
          </div>
          <MoreHorizontal size={16} className="text-[#65676b]" />
        </div>
        <p className="whitespace-pre-line px-3 pb-2.5 text-[13px] leading-snug">{cr.primaryText}</p>
        <PostVisual style={cr.style} headline={cr.visualHeadline} brand={project.brand} watermark aspect={cr.format === 'video' ? '4/5' : '1/1'} className="rounded-none" />
        <div className="flex items-center gap-3 bg-[#f0f2f5] px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[10.5px] uppercase text-[#65676b]">{site}</p>
            <p className="truncate text-[14px] font-semibold">{cr.headline}</p>
            <p className="truncate text-[12px] text-[#65676b]">{cr.description}</p>
          </div>
          <span className="shrink-0 rounded-md bg-[#e4e6eb] px-3 py-1.5 text-[13px] font-semibold">{cr.cta}</span>
        </div>
        <div className="flex items-center gap-4 border-t border-[#e4e6eb] px-3 py-1.5 text-[12px] text-[#65676b]">
          <span className="flex items-center gap-1">
            <ThumbsUp size={12} /> Like
          </span>
          <span>Comment</span>
          <span>Share</span>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-3">
        <button className="btn btn-secondary btn-sm self-start" onClick={() => setEditing((e) => !e)} disabled={locked}>
          {editing ? <Check size={14} /> : null} {editing ? 'Done' : 'Edit creative'}
        </button>
        {editing && (
          <div className="grid gap-2.5">
            <Field label="Primary text" right={`${cr.primaryText.length}/125`}>
              <AutoTextarea value={cr.primaryText} onChange={(v) => onChange({ primaryText: v })} minRows={2} className="text-[13px]" />
            </Field>
            <Field label="Headline" right={`${cr.headline.length}/40`}>
              <input className="input" value={cr.headline} onChange={(e) => onChange({ headline: e.target.value })} />
            </Field>
            <Field label="Description" right={`${cr.description.length}/30`}>
              <input className="input" value={cr.description} onChange={(e) => onChange({ description: e.target.value })} />
            </Field>
            <Field label="On-visual text">
              <input className="input" value={cr.visualHeadline} onChange={(e) => onChange({ visualHeadline: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Button">
                <select className="select" value={cr.cta} onChange={(e) => onChange({ cta: e.target.value })}>
                  {[...new Set([cr.cta, ...CTAS])].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
              <Field label="Visual style">
                <select className="select" value={cr.style} onChange={(e) => onChange({ style: e.target.value as StyleId, format: isVideoStyle(e.target.value as StyleId) ? 'video' : 'image' })}>
                  <optgroup label="Image">
                    {IMAGE_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Video">
                    {VIDEO_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </Field>
            </div>
          </div>
        )}
        {!editing && <p className="text-[11.5px] text-muted">{STYLE_LABEL[cr.style]} · {cr.format === 'video' ? 'Video' : 'Image'} ad</p>}
      </div>
    </article>
  );
}

function SearchAds({ project, search, onChange }: { project: Project; search: SearchAd; onChange: (s: SearchAd) => void }) {
  const domain = stripProtocol(project.brand.websiteUrl || `${project.brand.slug}.com`).replace(/\/$/, '');
  return (
    <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" aria-label="Google search ads">
      <div className="panel flex flex-col gap-3 p-4">
        <h2 className="section-title flex items-center gap-2">
          <Search size={17} className="text-primary" /> Google search ad
        </h2>
        <div className="rounded-md border border-line bg-white p-4 text-left" style={{ fontFamily: 'Arial, sans-serif' }}>
          <p className="text-[12px] font-bold text-[#202124]">Sponsored</p>
          <p className="mt-1 flex items-center gap-2 text-[12px] text-[#202124]">
            <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-[#f1f3f4]">
              <LogoMark colors={project.brand.colors} logo={project.brand.logo} name={project.brand.name} size={18} />
            </span>
            <span>
              {project.brand.name}
              <span className="block text-[11px] text-[#4d5156]">
                {domain}/{search.path.join('/')}
              </span>
            </span>
          </p>
          <p className="mt-1.5 text-[19px] leading-snug text-[#1a0dab]">{search.headlines.slice(0, 3).join(' | ')}</p>
          <p className="mt-1 text-[13.5px] leading-snug text-[#4d5156]">{search.descriptions.join(' ')}</p>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {search.sitelinks.map((s) => (
              <p key={s.title} className="text-[13px] leading-tight">
                <span className="text-[#1a0dab]">{s.title}</span>
                <span className="block text-[12px] text-[#4d5156]">{s.desc}</span>
              </p>
            ))}
          </div>
        </div>
      </div>
      <div className="panel grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Field label="Headlines (≤30 characters, one per line)" className="sm:col-span-2">
          <LinesEditor values={search.headlines} onChange={(v) => onChange({ ...search, headlines: v })} minRows={4} />
          {search.headlines.some((h) => h.length > 30) && <p className="mt-1 text-xs text-warn">Some headlines are over 30 characters.</p>}
        </Field>
        <Field label="Descriptions (≤90 characters)" className="sm:col-span-2">
          <LinesEditor values={search.descriptions} onChange={(v) => onChange({ ...search, descriptions: v })} minRows={2} />
        </Field>
        <Field label="Keywords (match types)" className="sm:col-span-2">
          <LinesEditor values={search.keywords} onChange={(v) => onChange({ ...search, keywords: v })} minRows={3} className="font-mono" />
        </Field>
      </div>
    </section>
  );
}
