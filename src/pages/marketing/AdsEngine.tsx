import { useMemo, useState } from 'react';
import { Check, Download, ExternalLink, PenLine, Plus, Trash2 } from 'lucide-react';
import type { AdCampaign, AdCreative, AdObjective, AdPlatform, Project, SearchAd, StyleId } from '@/lib/types';
import { cn, ensureUrl, fmtMoney, fmtRelative, parseDateStr, slugify, stripProtocol } from '@/lib/utils';
import { AD_CTAS as CTAS, adFinalUrl, adsCsv, adsText, applyAds } from '@/lib/ads';
import { IMAGE_STYLES, STYLE_LABEL, VIDEO_STYLES, isVideoStyle } from '@/ai/knowledge';
import { AD_OBJECTIVES, AD_PLATFORMS, newAdCampaign, suggestInterests } from '@/ai/local/ads';
import { buildFacts } from '@/ai/text';
import { adsTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { useActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, Checkbox, ChipInput, CopyButton, DateTimeButton, Empty, Field, InfoTip, LinesEditor, MoreMenu, OptionCards, PageHeader, Section, Tabs, confirmAction } from '@/components/ui/primitives';
import { PostFrame } from '@/components/frames/Frames';
import { download } from '@/components/ui/download';
import { PostVisual, orderStyles } from '@/components/visuals/PostVisual';
import { LogoMark } from '@/components/brand/Logo';

const pad = (n: number) => String(n).padStart(2, '0');
const dateStr = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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
    <div>
      <PageHeader
        className={campaigns.length > 1 ? 'mb-4' : undefined}
        title="Ads"
        description="Plan a campaign here, then run it in each platform’s ads manager."
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={create}>
            <Plus /> New campaign
          </button>
        }
      />
      {campaigns.length > 1 && active && (
        // the tab row keeps its name for screen readers ("Campaigns")
        <div role="group" aria-label="Campaigns" className="mb-5">
          <Tabs size="sm" value={active.id} onChange={setActiveId} tabs={campaigns.map((c) => ({ id: c.id, label: c.name || 'Untitled campaign' }))} />
        </div>
      )}
      {!active ? (
        <Empty
          variant="ai"
          title="Plan a local ad campaign"
          body="A budget, an audience and three ad versions to test."
          action={
            <GenerateButton variant="ai" size="lg" onClick={create}>
              Plan my campaign
            </GenerateButton>
          }
        />
      ) : (
        <CampaignEditor key={active.id} project={project} c={active} onDeleted={() => setActiveId(null)} />
      )}
    </div>
  );
}

function CampaignEditor({ project, c, onDeleted }: { project: Project; c: AdCampaign; onDeleted: () => void }) {
  const upsertAd = useStore((s) => s.upsertAd);
  const deleteAd = useStore((s) => s.deleteAd);
  const ai = useAI(adsTask);
  const facts = useMemo(() => buildFacts(project), [project]);
  const suggestions = useMemo(() => suggestInterests(facts), [facts]);
  const live = () => useStore.getState().ads.find((a) => a.id === c.id) ?? c;
  const set = (patch: Partial<AdCampaign>) => {
    upsertAd({ ...live(), ...patch });
  };
  const setCreative = (id: string, patch: Partial<AdCreative>) => set({ creatives: live().creatives.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const finalUrl = adFinalUrl(c, project);
  const hasCreatives = c.creatives.length > 0;
  const unpicked = suggestions.filter((s) => !c.interests.includes(s)).slice(0, 8);

  const generate = async () => {
    if (c.creatives.length && !(await confirmAction({ title: 'Regenerate creatives and audiences?', body: 'Your edited ad copy will be replaced.', confirmLabel: 'Regenerate' }))) return;
    const r = await ai.run({ campaign: live() });
    if (r) applyAds(c.id, r);
  };
  const remove = async () => {
    if (await confirmAction({ title: `Delete “${c.name}”?`, body: 'The campaign and its creatives will be removed.', confirmLabel: 'Delete', danger: true })) {
      deleteAd(c.id);
      onDeleted();
    }
  };

  return (
    <div className="grid grid-cols-1 items-start gap-x-8 gap-y-10 lg:grid-cols-12">
      <div className="min-w-0 lg:col-span-8">
        <section aria-label="Campaign settings">
          <div className="mb-5 flex items-center gap-2">
            <input className="input input-inline -ml-3 h-10 min-w-0 flex-1 text-h2" value={c.name} onChange={(e) => set({ name: e.target.value })} aria-label="Campaign name" />
            <MoreMenu label="More campaign actions" items={[{ label: 'Delete campaign', icon: <Trash2 />, onSelect: () => void remove(), danger: true }]} />
          </div>
          <div className="flex flex-col gap-6">
            <div>
              <p className="label">Objective</p>
              <OptionCards<AdObjective> aria-label="Objective" columns={4} value={c.objective} onChange={(objective) => set({ objective })} options={AD_OBJECTIVES.map((o) => ({ value: o.id, title: o.label, description: o.desc }))} />
            </div>
            <div>
              <p className="label">Platforms</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="group" aria-label="Platforms">
                {AD_PLATFORMS.map((p) => {
                  const on = c.platforms.includes(p.id);
                  return (
                    <div key={p.id} className={cn('rounded-lg border p-3.5 transition-[border-color,box-shadow,background-color] duration-120', on ? 'border-transparent bg-primary-soft/50 ring-[1.5px] ring-inset ring-primary' : 'border-line hover:border-line-3')}>
                      <Checkbox id={`ad-pl-${p.id}`} checked={on} onChange={(v) => set({ platforms: v ? [...c.platforms.filter((x) => x !== p.id), p.id as AdPlatform] : c.platforms.filter((x) => x !== p.id) })} label={p.label} description={p.desc} />
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <Field label="Daily budget" htmlFor="ad-budget" right={<span className="num font-mono text-small text-ink">{fmtMoney(c.dailyBudget)}</span>}>
                <input id="ad-budget" type="range" min={5} max={500} step={5} value={c.dailyBudget} onChange={(e) => set({ dailyBudget: Number(e.target.value) })} className="h-6 w-full cursor-pointer" />
              </Field>
              <Field label="Duration" htmlFor="ad-days" right={<span className="num font-mono text-small text-ink">{c.durationDays} days</span>}>
                <input id="ad-days" type="range" min={3} max={60} value={c.durationDays} onChange={(e) => set({ durationDays: Number(e.target.value) })} className="h-6 w-full cursor-pointer" />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_110px_150px_auto]">
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
              <Field label="Starts">
                <DateTimeButton mode="date" aria-label="Start date" value={parseDateStr(c.startDate).getTime()} onChange={(ms) => set({ startDate: dateStr(ms) })} />
              </Field>
            </div>
            <Field label="Interests" hint="Leave it empty and the AI picks interests for your niche.">
              <ChipInput values={c.interests} onChange={(v) => set({ interests: v })} placeholder="Add an interest" max={15} />
              {unpicked.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {unpicked.map((s) => (
                    <button key={s} type="button" className="chip" onClick={() => set({ interests: [...c.interests, s] })}>
                      <Plus /> {s}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            <div className="flex flex-col gap-3 border-t border-line pt-5">
              <div className="flex flex-wrap items-center gap-3">
                <GenerateButton variant={hasCreatives ? 'ai-outline' : 'ai'} running={ai.running} runningLabel="Writing…" onClick={generate} disabled={!c.platforms.length}>
                  {hasCreatives ? 'Regenerate audiences & creatives' : 'Generate audiences & creatives'}
                </GenerateButton>
                {!c.platforms.length && <p className="text-caption text-muted">Pick at least one platform.</p>}
              </div>
              <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} />
              {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
            </div>
          </div>
        </section>

        {hasCreatives && (
          <Section title="Ad versions" description="Three angles to test against each other. Untick a version to leave it out of the campaign." className="mt-12" id="ad-creatives">
            <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 xl:grid-cols-3" aria-label="Ad creatives" role="group">
              {c.creatives.map((cr) => (
                <CreativeCard key={cr.id} project={project} site={finalUrl} cr={cr} selected={c.selectedCreativeIds.includes(cr.id)} onSelect={(v) => set({ selectedCreativeIds: v ? [...c.selectedCreativeIds, cr.id] : c.selectedCreativeIds.filter((x) => x !== cr.id) })} onChange={(p) => setCreative(cr.id, p)} />
              ))}
            </div>
          </Section>
        )}

        {c.search && <SearchAds project={project} site={finalUrl} search={c.search} onChange={(search) => set({ search })} />}

        {c.audiences.length > 0 && (
          <Section title="Audiences" className="mt-12">
            <ul className="card divide-y divide-line" aria-label="Audiences">
              {c.audiences.map((a) => (
                <li key={a.id} className="px-5 py-3.5">
                  <p className="text-ui text-ink">{a.name}</p>
                  <p className="mt-0.5 text-small text-muted">{a.description}</p>
                  {a.interests.length > 0 && <p className="mt-1 text-small text-ink-2">{a.interests.join(' · ')}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:col-span-4">
        <ExportPanel c={c} finalUrl={finalUrl} onFinalUrl={(v) => set({ finalUrl: v })} onExported={() => set({ exportedAt: Date.now() })} />
      </aside>
    </div>
  );
}

const AD_MANAGERS: Record<AdPlatform, { label: string; url: string }> = {
  meta: { label: 'Meta Ads Manager', url: 'https://adsmanager.facebook.com/' },
  tiktok: { label: 'TikTok Ads Manager', url: 'https://ads.tiktok.com/' },
  google: { label: 'Google Ads', url: 'https://ads.google.com/' },
  linkedin: { label: 'LinkedIn Campaign Manager', url: 'https://www.linkedin.com/campaignmanager/' },
};

/** A URL as an ad shows it: "sparkle.co/offer". */
const displayUrl = (url: string) => stripProtocol(url).replace(/\/+$/, '');

/** Budget (your own numbers), and taking the plan to each platform's ads manager. */
function ExportPanel({ c, finalUrl, onFinalUrl, onExported }: { c: AdCampaign; finalUrl: string; onFinalUrl: (v: string) => void; onExported: () => void }) {
  const hasCreatives = c.creatives.length > 0 && c.selectedCreativeIds.length > 0;
  const ready = hasCreatives && !!finalUrl;
  return (
    <>
      <section className="card p-5" aria-label="Budget">
        <p className="flex items-center gap-1 text-small text-muted">
          Budget
          <InfoTip label="About the budget">The amount you set. Reach, clicks and costs depend on each platform’s auction: its ads manager estimates them when you set the campaign up.</InfoTip>
        </p>
        <p className="num mt-1 text-phone-kpi text-ink sm:text-kpi">{fmtMoney(c.dailyBudget * c.durationDays)}</p>
        <p className="num mt-1 font-mono text-small text-muted">
          {fmtMoney(c.dailyBudget)} a day × {c.durationDays} days
        </p>
      </section>
      <section className="card flex flex-col gap-4 p-5" aria-label="Run it">
        <h2 className="flex items-center gap-1 text-h3 text-ink">
          Run it on the platforms
          <InfoTip label="How ads run">This app doesn’t run or pay for ads. Copy the plan into each platform’s ads manager, where you set the budget and launch it.</InfoTip>
        </h2>
        <Field label="Final URL" htmlFor="ad-final" hint="The page people land on when they click your ad.">
          <input id="ad-final" className="input font-mono" placeholder="https://yourbusiness.com/offer" value={c.finalUrl ?? finalUrl} onChange={(e) => onFinalUrl(e.target.value)} onBlur={(e) => onFinalUrl(ensureUrl(e.target.value))} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            label="Copy the plan"
            text={() => {
              onExported();
              return adsText(c, finalUrl);
            }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!ready}
            onClick={() => {
              onExported();
              void download(`${slugify(c.name)}-ads.csv`, adsCsv(c, finalUrl));
            }}
          >
            <Download /> Ads CSV
          </button>
        </div>
        {!hasCreatives ? <p className="-mt-2 text-caption text-muted">Generate creatives first.</p> : !finalUrl && <p className="-mt-2 text-caption text-warn">Add the page your ads link to before you export them.</p>}
        <ul className="-mx-2 flex flex-col">
          {(c.platforms.length ? c.platforms : (['meta'] as AdPlatform[])).map((p) => (
            <li key={p}>
              <a href={AD_MANAGERS[p].url} target="_blank" rel="noopener noreferrer" className="flex h-9 items-center justify-between gap-2 rounded px-2 text-ui text-ink transition-colors duration-120 hover:bg-surface-2">
                Open {AD_MANAGERS[p].label}
                <ExternalLink size={14} className="shrink-0 text-muted" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
        {c.exportedAt && <p className="text-caption text-muted">Last copied or exported {fmtRelative(c.exportedAt)}.</p>}
      </section>
    </>
  );
}

/** One ad version as it shows in a feed, picked with the option-card ring; Edit opens its words below it. */
function CreativeCard({ project, site: finalUrl, cr, selected, onSelect, onChange }: { project: Project; site: string; cr: AdCreative; selected: boolean; onSelect: (v: boolean) => void; onChange: (p: Partial<AdCreative>) => void }) {
  const [editing, setEditing] = useState(false);
  // the final URL's domain, as Meta shows it; a clear placeholder until you add one
  const site = displayUrl(finalUrl).split('/')[0] || '[Final URL]';
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Checkbox id={`cr-${cr.id}`} checked={selected} onChange={onSelect} label={<span className="text-ui">Version {cr.variant}</span>} />
        <span className="min-w-0 truncate text-small text-muted" title={cr.angle}>
          {cr.angle}
        </span>
      </div>
      <PostFrame
        className={cn('transition-[box-shadow,opacity] duration-120', selected ? 'ring-[1.5px] ring-primary' : 'opacity-70')}
        handle={project.brand.name}
        avatar={<LogoMark colors={project.brand.colors} logo={project.brand.logo} name={project.brand.name} size={24} />}
        meta="Sponsored"
        footer={
          <span className="flex items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-caption text-muted">{site}</span>
              <span className="block truncate text-small font-medium text-ink">{cr.headline}</span>
            </span>
            <span className="shrink-0 rounded bg-surface-3 px-2.5 py-1 text-caption font-medium text-ink">{cr.cta}</span>
          </span>
        }
      >
        {/* Meta shows an ad's text above its picture */}
        <div className="px-3 pb-2.5">
          <p className="clamp-3 whitespace-pre-line text-small text-ink-2">{cr.primaryText}</p>
        </div>
        <PostVisual style={cr.style} headline={cr.visualHeadline} brand={project.brand} watermark aspect={cr.format === 'video' ? '4/5' : '1/1'} className="rounded-none" />
      </PostFrame>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-caption text-muted">
          {STYLE_LABEL[cr.style]} · {cr.format === 'video' ? 'Video' : 'Image'} ad
        </span>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
          {editing ? <Check /> : <PenLine />} {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      {editing && (
        <div className="well grid gap-3 p-3">
          <Field label="Primary text" right={<span className="num font-mono">{cr.primaryText.length}/125</span>}>
            <AutoTextarea value={cr.primaryText} onChange={(v) => onChange({ primaryText: v })} minRows={2} />
          </Field>
          <Field label="Headline" right={<span className="num font-mono">{cr.headline.length}/40</span>}>
            <input className="input" value={cr.headline} onChange={(e) => onChange({ headline: e.target.value })} />
          </Field>
          <Field label="Description" right={<span className="num font-mono">{cr.description.length}/30</span>}>
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
                  {orderStyles(IMAGE_STYLES).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Video">
                  {orderStyles(VIDEO_STYLES).map((s) => (
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
    </div>
  );
}

// The search ad as Google shows it: Google's own colours in both themes (it's the business's ad, not the app).
const G = { ink: '#202124', url: '#4d5156', title: '#1a0dab', chip: '#f1f3f4' } as const;

function SearchAds({ project, site, search, onChange }: { project: Project; site: string; search: SearchAd; onChange: (s: SearchAd) => void }) {
  const domain = displayUrl(site).split('/')[0] || '[Final URL]';
  return (
    <Section title="Google search ad" className="mt-12" id="ad-search">
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2" aria-label="Google search ads" role="group">
        <div className="card overflow-hidden" style={{ background: '#ffffff', fontFamily: 'Arial, sans-serif' }}>
          <div className="p-5" style={{ color: G.ink }}>
            <p className="text-caption font-semibold">Sponsored</p>
            <p className="mt-1.5 flex items-center gap-2 text-caption">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full" style={{ background: G.chip }}>
                <LogoMark colors={project.brand.colors} logo={project.brand.logo} name={project.brand.name} size={18} />
              </span>
              <span className="min-w-0">
                <span className="block truncate">{project.brand.name}</span>
                <span className="block truncate" style={{ color: G.url }}>
                  {domain}/{search.path.join('/')}
                </span>
              </span>
            </p>
            <p className="mt-2 text-h3" style={{ color: G.title, fontWeight: 400 }}>
              {search.headlines.slice(0, 3).join(' | ')}
            </p>
            <p className="mt-1 text-small" style={{ color: G.url }}>
              {search.descriptions.join(' ')}
            </p>
            {search.sitelinks.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                {search.sitelinks.map((s) => (
                  <p key={s.title} className="text-small">
                    <span style={{ color: G.title }}>{s.title}</span>
                    <span className="block text-caption" style={{ color: G.url }}>
                      {s.desc}
                    </span>
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <Field label="Headlines" right="Up to 30 characters, one per line">
            <LinesEditor values={search.headlines} onChange={(v) => onChange({ ...search, headlines: v })} minRows={4} />
            {search.headlines.some((h) => h.length > 30) && <p className="mt-1.5 text-caption text-warn">Some headlines are over 30 characters.</p>}
          </Field>
          <Field label="Descriptions" right="Up to 90 characters">
            <LinesEditor values={search.descriptions} onChange={(v) => onChange({ ...search, descriptions: v })} minRows={2} />
          </Field>
          <Field label="Keywords" right="With match types">
            <LinesEditor values={search.keywords} onChange={(v) => onChange({ ...search, keywords: v })} minRows={3} className="font-mono" />
          </Field>
        </div>
      </div>
    </Section>
  );
}
