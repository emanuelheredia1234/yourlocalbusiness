import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarClock, Check, Download, Inbox, Mail, Phone, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import type { Project } from '@/lib/types';
import { cn, fmtDateTime, fmtRelative, slugify } from '@/lib/utils';
import { showSignIn } from '@/lib/cloud/auth';
import { usePublishAccess } from '@/lib/publish';
import { LEADS_EXPORT_MAX, LEADS_PAGE_SIZE, LEAD_KIND_LABELS, MAX_EMAIL, allLeads, deleteLead, leadDetails, leadEmail, leadOfProject, leadSourceLine, leadTime, leadsCsv, listLeads, type Lead } from '@/lib/leads';
import type { LeadSource } from '@/lib/leadFields';
import { artifactPageId } from '@/lib/codeAssets';
import { addLeadToSubscribers, leadOwner, leadProject, markLeadsSeen, useLeads } from '@/store/leads';
import { useStore } from '@/store/useStore';
import { useExperiments, useProjectExperiments } from '@/store/experiments';
import { toast, useUI } from '@/store/ui';
import { Badge, Callout, Empty, InfoTip, Segmented, Spinner, Tooltip, confirmAction } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';
import { safeEmail, safePhone } from '@/lib/listingActions';

type Scope = 'project' | 'all';
type SourceFilter = 'all' | LeadSource;

/** The source filter, while the app is open (memory only: never saved, as leads are people's details). */
let rememberedSource: SourceFilter = 'all';

/** a message longer than this shows its first lines, with Show all */
const LONG_LINES = 6;
const LONG_CHARS = 360;

/**
 * Email → Leads: what people sent with the owner's published forms (an SEO page's form, an asset's widget: a
 * lead form, a booking request, a quiz or calculator result; or the lead magnet's sign-up). The server keeps them;
 * the app shows them, newest first, for this business or all of them and by where they came from, and can add one
 * to the subscriber list, delete it, or export a CSV. Visitors wrote every word of a lead: it's shown as text.
 */
export function Leads({ project }: { project: Project }) {
  const { access, retry } = usePublishAccess();
  if (access === 'checking')
    return (
      <div className="flex h-40 items-center justify-center text-muted" role="status" aria-label="Checking the app’s server">
        <Spinner size={20} />
      </div>
    );
  if (access === 'unavailable') return <AccessNote>Leads need the app’s own server. In claude.ai, page forms can’t send.</AccessNote>;
  if (access === 'unreachable')
    return (
      <AccessNote
        action={
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
            Try again
          </button>
        }
      >
        Couldn’t reach the app’s server.
      </AccessNote>
    );
  if (access === 'off') return <AccessNote>Leads need publishing, which isn’t set up on this app’s server yet.</AccessNote>;
  if (access === 'signed-out')
    return (
      <AccessNote
        action={
          <button type="button" className="btn btn-primary btn-sm" onClick={showSignIn}>
            Sign in
          </button>
        }
      >
        Sign in to see leads from your pages.
      </AccessNote>
    );
  return <LeadList key={project.id} project={project} />;
}

function AccessNote({ children, action }: { children: string; action?: JSX.Element }) {
  return (
    <section className="card flex flex-wrap items-center gap-3 p-4" aria-label="Leads">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2" aria-hidden="true">
        <Inbox size={16} />
      </span>
      <p className="min-w-0 flex-1 text-small text-ink-2">{children}</p>
      {action}
    </section>
  );
}

/** What the watcher already has for this view: shown at once, until the list arrives. */
function seed(recent: Lead[] | null, projectId: string | undefined, source: SourceFilter): Lead[] | null {
  if (!recent) return null;
  return recent.filter((l) => (!projectId || leadOfProject(l, projectId)) && (source === 'all' || l.source === source));
}

const mailHref = (email: string) => `mailto:${email.replace(/[%?#&=]/g, (c) => encodeURIComponent(c))}`;

function LeadList({ project }: { project: Project }) {
  const ids = useId();
  const projects = useStore((s) => s.projects);
  const recent = useLeads((s) => s.recent);
  const [scope, setScope] = useState<Scope>('project');
  const [source, setSourceState] = useState<SourceFilter>(rememberedSource);
  // A/B tests (P4b): leads from a page test carry the version their visitor saw; filter by it (the loaded leads)
  const [version, setVersion] = useState('all');
  const projectId = scope === 'project' ? project.id : undefined;
  const filter = { projectId, ...(source === 'all' ? {} : { source }) };
  const [leads, setLeads] = useState<Lead[] | null>(() => seed(recent, projectId, source));
  // a version's test by its name (never an id fragment): the page tests the app has loaded, else "Page test"
  useProjectExperiments(project.id);
  const testsById = useExperiments((st) => st.byProject);
  const testName = (id: string) => {
    for (const entry of Object.values(testsById)) {
      const e = entry?.experiments.find((x) => x.id === id);
      if (e) return e.name ? `${e.name} test` : 'Page test';
    }
    return 'Page test';
  };
  const versions = useMemo(() => (__ARTIFACT_BUILD__ ? [] : [...new Set((leads ?? []).filter((l) => l.variantKey).map((l) => `${l.experimentId}:${l.variantKey}`))].sort()), [leads]);
  // the last page was full: there may be more
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loads, setLoads] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const focusNext = useRef<string | null>(null);
  // an answer for an earlier view (another scope) is dropped
  const view = useRef(0);

  // the newest leads, again on Refresh and when the scope changes; the bell's count looks again too
  useEffect(() => {
    const v = ++view.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError('');
    listLeads({ ...filter, limit: LEADS_PAGE_SIZE, signal: ctrl.signal }).then(
      (list) => {
        if (v !== view.current) return;
        setLeads(list);
        setMore(list.length === LEADS_PAGE_SIZE);
        setLoading(false);
      },
      (e: Error) => {
        if (ctrl.signal.aborted || v !== view.current) return;
        setError(e?.message || 'Couldn’t load your leads. Try again.');
        setLoading(false);
      },
    );
    void useLeads.getState().refresh();
    return () => ctrl.abort();
  }, [projectId, source, loads]);

  // seen: what this business's whole list shows counts as seen (the bell's count and the badge go)
  useEffect(() => {
    if (scope !== 'project' || source !== 'all' || !leads?.length) return;
    markLeadsSeen(project.id, Math.max(...leads.map(leadTime)));
  }, [leads, scope, source, project.id]);

  // after a delete: the next lead's Delete button, or the list
  useEffect(() => {
    if (focusNext.current === null) return;
    const id = focusNext.current;
    focusNext.current = null;
    const next = id ? [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-delete]') ?? [])].find((b) => b.dataset.delete === id) : null;
    (next ?? listRef.current)?.focus();
  }, [leads]);

  const changeScope = (s: Scope) => {
    if (s === scope) return;
    setScope(s);
    setLeads(seed(useLeads.getState().recent, s === 'project' ? project.id : undefined, source));
    setMore(false);
  };
  const changeSource = (s: SourceFilter) => {
    if (s === source) return;
    rememberedSource = s;
    setSourceState(s);
    setLeads(seed(useLeads.getState().recent, projectId, s));
    setMore(false);
  };

  const loadMore = async () => {
    const last = leads?.[leads.length - 1];
    if (!last) return;
    const v = view.current;
    setLoading(true);
    setError('');
    try {
      const next = await listLeads({ ...filter, before: last.createdAt, limit: LEADS_PAGE_SIZE });
      if (v !== view.current) return;
      setLeads((cur) => {
        const have = new Set((cur ?? []).map((l) => l.id));
        return [...(cur ?? []), ...next.filter((l) => !have.has(l.id))];
      });
      setMore(next.length === LEADS_PAGE_SIZE);
    } catch (e) {
      if (v === view.current) setError((e as Error)?.message || 'Couldn’t load more. Try again.');
    } finally {
      if (v === view.current) setLoading(false);
    }
  };

  const ownerOf = (lead: Lead) => leadOwner(lead, projects);
  const csvLabel = { project: (lead: Lead) => ownerOf(lead)?.brand.name ?? '', page: (lead: Lead) => (lead.slug ? `/${lead.slug}` : lead.pageId) };
  const who = (lead: Lead) => lead.name || lead.email || lead.phone || 'someone';

  const remove = async (lead: Lead) => {
    const ok = await confirmAction({ title: 'Delete this lead?', body: 'It’s deleted from your account for good. A copy you exported or added to your subscribers stays.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    setBusy((s) => new Set(s).add(lead.id));
    try {
      // once: nothing tries it again by itself
      await deleteLead(lead.id);
      const list = leads ?? [];
      const at = list.findIndex((l) => l.id === lead.id);
      focusNext.current = list[at + 1]?.id ?? '';
      setLeads((cur) => (cur ?? []).filter((l) => l.id !== lead.id));
      useLeads.getState().drop(lead.id);
      toast({ kind: 'info', title: 'Lead deleted' });
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t delete it', body: (e as Error)?.message });
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(lead.id);
        return next;
      });
    }
  };

  const subscribe = async (lead: Lead) => {
    if (!(await consentedOrAsked(lead))) return;
    const r = addLeadToSubscribers(lead);
    if (r.status === 'added') toast({ kind: 'success', title: 'Added to your subscribers', body: r.projectId === project.id ? 'Find them under Subscribers.' : `In ${r.brand}’s Email → Subscribers.` });
    else if (r.status === 'exists') toast({ kind: 'info', title: 'Already on your subscriber list' });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { leads: list, capped } = await allLeads({ ...filter, max: LEADS_EXPORT_MAX });
      const name = `${scope === 'project' ? slugify(project.brand.name) || 'your' : 'all'}-leads${source === 'all' ? '' : `-${SOURCE_FILE[source]}`}.csv`;
      // a byte-order mark, so spreadsheets read names with accents right
      await download(name, String.fromCharCode(0xfeff) + leadsCsv(list, csvLabel));
      if (capped) toast({ kind: 'info', title: 'Exported the newest 5,000 leads.' });
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t export your leads', body: (e as Error)?.message });
    } finally {
      setExporting(false);
    }
  };

  const count = leads?.length ?? 0;
  return (
    <section aria-labelledby={`${ids}-title`}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <h2 id={`${ids}-title`} className="text-h3 text-ink">
            {leads ? `${count}${more ? '+' : ''} lead${count === 1 && !more ? '' : 's'}` : 'Leads'}
          </h2>
          <InfoTip label="About replying">What people send with your published forms: your page’s form, your assets (forms, bookings, quiz and calculator results) and your lead magnet’s sign-up. Reply from your own email or phone: the app doesn’t send email.</InfoTip>
        </div>
        {/* what the ⓘ says, read out with the list for everyone using a screen reader */}
        <p className="sr-only">Reply from your own email or phone: the app doesn’t send email.</p>
        <div role="group" aria-label="Which businesses">
          <Segmented<Scope>
            size="sm"
            value={scope}
            onChange={changeScope}
            options={[
              { id: 'project', label: 'This business' },
              { id: 'all', label: 'All businesses' },
            ]}
          />
        </div>
        <div role="group" aria-label="Where they came from">
          <Segmented<SourceFilter>
            size="sm"
            value={source}
            onChange={changeSource}
            options={[
              { id: 'all', label: 'All' },
              { id: 'page', label: 'Pages' },
              { id: 'asset', label: 'Assets' },
              { id: 'magnet', label: 'Lead magnet' },
            ]}
          />
        </div>
        {versions.length > 0 && (
          <select className="select w-auto" aria-label="Which page version" value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="all">Every version</option>
            {versions.map((v) => (
              <option key={v} value={v}>
                {testName(v.split(':')[0])} · version {v.slice(-1).toUpperCase()}
              </option>
            ))}
            <option value="none">Not in a test</option>
          </select>
        )}
        <div className="ml-auto flex flex-wrap gap-1.5">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLoads((n) => n + 1)} disabled={loading}>
            <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden="true" /> Refresh
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void exportCsv()} disabled={!count || exporting}>
            {exporting ? <Spinner size={16} /> : <Download aria-hidden="true" />} Export CSV
          </button>
        </div>
      </div>
      {error && (
        <Callout
          tone="bad"
          className="mb-3"
          action={
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => setLoads((n) => n + 1)}>
              Try again
            </button>
          }
        >
          <span className="break-words">{error}</span>
        </Callout>
      )}
      {leads === null ? (
        error ? null : (
          <div className="card flex h-32 items-center justify-center text-muted" role="status" aria-label="Loading your leads">
            <Spinner size={20} />
          </div>
        )
      ) : leads.length === 0 ? (
        <div className="card">
          <Empty
            icon={<Inbox />}
            title="No leads yet"
            body={
              source === 'asset'
                ? 'When someone sends a published asset’s form (a lead form, a booking request, or a quiz or calculator result), it shows here.'
                : source === 'magnet'
                  ? 'When someone signs up for your published lead magnet’s download, it shows here. Publish it under Email › Lead magnet.'
                  : 'When someone sends a form you published, it shows here: your page’s form, a published asset’s form or result, or your lead magnet’s sign-up.'
            }
            action={
              scope === 'project' && source !== 'asset' && source !== 'magnet' ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void useUI.getState().openSeoBuilder({ pageType: 'lead' })}>
                  Build a lead form page
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div aria-hidden="true" className={cn(ROW_GRID, 'hidden border-b border-line bg-surface-2 px-4 py-2 text-caption font-medium text-muted')}>
            <span>Name</span>
            <span>Contact</span>
            <span>Message</span>
            <span>From</span>
            <span>Received</span>
            <span />
          </div>
          <ul ref={listRef} tabIndex={-1} aria-label="Leads" className="divide-y divide-line outline-none">
            {leads.filter((l) => version === 'all' || (version === 'none' ? !l.variantKey : `${l.experimentId}:${l.variantKey}` === version)).map((lead) => (
              <LeadItem key={lead.id} lead={lead} project={project} projects={projects} from={ownerOf(lead)} who={who(lead)} busy={busy.has(lead.id)} onSubscribe={() => void subscribe(lead)} onDelete={() => void remove(lead)} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            <p className="text-caption text-muted">Add only people who asked to hear from you.</p>
            {more && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadMore()} disabled={loading}>
                {loading ? <Spinner size={16} /> : null} Load more
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Whether to add a lead to the subscribers: yes when they ticked the box to get emails, else only when the owner says so. */
export async function consentedOrAsked(lead: Pick<Lead, 'consent'>): Promise<boolean> {
  if (lead.consent) return true;
  return confirmAction({ title: 'Add them to your subscribers?', body: 'They didn’t tick the box to get emails. Add them only if they agreed another way.', confirmLabel: 'Add anyway' });
}

/** A CSV's name for each source. */
const SOURCE_FILE: Record<LeadSource, string> = { page: 'pages', asset: 'assets', magnet: 'lead-magnet' };

/** Where a lead came from, named the way the owner knows it: an asset by its name, the lead magnet by its title. */
function sourceLine(lead: Lead, from: Project | null): string {
  const asset = lead.source === 'asset' ? from?.studio.codeAssets.find((a) => artifactPageId(a.id) === lead.pageId)?.name : undefined;
  const lm = from?.marketing.leadMagnet;
  const magnet = lead.source === 'magnet' && lm && (lead.payload.magnet === lm.delivery?.fileId || lead.pageId === `magnet:${lm.delivery?.fileId}`) ? lm.title : undefined;
  return leadSourceLine(lead, { asset, magnet });
}

/** The list's columns on wide screens (it reads as a table; each lead is still one list item). */
// (the actions column has a fixed width: each row is its own grid, so an auto column would size differently per row and the headings would drift)
const ROW_GRID = 'xl:grid xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,2fr)_minmax(0,1fr)_76px_176px] xl:items-start xl:gap-4';

function LeadItem({ lead, project, projects, from, who, busy, onSubscribe, onDelete }: { lead: Lead; project: Project; projects: Project[]; from: Project | null; who: string; busy: boolean; onSubscribe: () => void; onDelete: () => void }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const t = leadTime(lead);
  // links only for a real email or phone number (no longer than the server takes)
  const email = lead.email.length <= MAX_EMAIL ? safeEmail(lead.email) : null;
  const phone = lead.phone.length <= 40 ? safePhone(lead.phone) : null;
  const canSubscribe = !!leadEmail(lead);
  const target = leadProject(lead, projects) ?? project;
  const subscribed = canSubscribe && target.marketing.subscribers.some((s) => s.email.trim().toLowerCase() === leadEmail(lead));
  const long = lead.message.split('\n').length > LONG_LINES || lead.message.length > LONG_CHARS;
  const details = leadDetails(lead);
  const when = lead.createdAt ? (
    <time dateTime={lead.createdAt} title={t ? fmtDateTime(t) : undefined} className="num font-mono text-caption text-muted">
      {t ? fmtRelative(t) : lead.createdAt}
    </time>
  ) : null;
  return (
    <li className={cn(ROW_GRID, 'flex flex-col gap-2 px-4 py-3.5')}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1 xl:block">
        <p className={cn('min-w-0 break-words text-ui', lead.name ? 'text-ink' : 'text-muted')}>{lead.name ? <bdi>{lead.name}</bdi> : 'No name given'}</p>
        <span className="xl:hidden">{when}</span>
        {lead.time && (
          <p className="mt-1 flex w-full items-start gap-1.5 text-small text-ink-2">
            <CalendarClock size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-muted" />
            <span className="min-w-0 break-words">
              Preferred time: <bdi>{lead.time}</bdi>
            </span>
          </p>
        )}
      </div>
      <div className="min-w-0">
        {(lead.email || lead.phone) && (
          <p className="flex flex-col gap-1 text-small">
            {lead.email && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Mail size={14} aria-hidden="true" className="shrink-0 text-muted" />
                {email ? (
                  <a href={mailHref(email)} className="link min-w-0 break-all">
                    <bdi>{lead.email}</bdi>
                  </a>
                ) : (
                  <bdi className="min-w-0 break-all">{lead.email}</bdi>
                )}
              </span>
            )}
            {lead.phone && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Phone size={14} aria-hidden="true" className="shrink-0 text-muted" />
                {phone ? (
                  <a href={`tel:${phone.tel}`} className="link min-w-0 break-all">
                    <bdi>{lead.phone}</bdi>
                  </a>
                ) : (
                  <bdi className="min-w-0 break-all">{lead.phone}</bdi>
                )}
              </span>
            )}
          </p>
        )}
      </div>
      <div className="min-w-0">
        {(lead.kind !== 'form' || lead.consent) && (
          <p className="mb-1 flex flex-wrap gap-1">
            {lead.kind !== 'form' && <Badge>{LEAD_KIND_LABELS[lead.kind]}</Badge>}
            {lead.consent && (
              <Badge tone="good" dot>
                Agreed to emails
              </Badge>
            )}
          </p>
        )}
        {details.length > 0 && (
          <dl className="mb-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-small">
            {details.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted">{d.label}</dt>
                <dd dir="auto" className="min-w-0 whitespace-pre-line break-words text-ink-2">
                  {d.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {lead.message && (
          <>
            <p id={`${ids}-msg`} dir="auto" className={cn('whitespace-pre-line break-words text-small text-ink-2', long && !open && 'line-clamp-6')}>
              {lead.message}
            </p>
            {long && (
              <button type="button" className="link mt-0.5 text-caption" aria-expanded={open} aria-controls={`${ids}-msg`} onClick={() => setOpen((v) => !v)}>
                {open ? 'Show less' : 'Show all'}
              </button>
            )}
          </>
        )}
      </div>
      <p className="min-w-0 break-words text-small text-muted">
        {sourceLine(lead, from)} · {from ? from.brand.name : 'not in your projects'}
        {lead.variantKey && !__ARTIFACT_BUILD__ && (
          <Badge tone="primary" className="ml-1.5 align-middle">
            Version {lead.variantKey.toUpperCase()}
          </Badge>
        )}
      </p>
      <div className="hidden xl:block">{when}</div>
      <div className="flex shrink-0 items-center gap-1 xl:justify-end">
        {subscribed ? (
          <button type="button" className="btn btn-secondary btn-xs" disabled>
            <Check className="text-good" aria-hidden="true" /> Subscribed
          </button>
        ) : (
          <button type="button" className="btn btn-secondary btn-xs" onClick={onSubscribe} disabled={!canSubscribe} title={canSubscribe ? undefined : 'No email address to add'}>
            <UserPlus aria-hidden="true" /> Add to subscribers
          </button>
        )}
        <Tooltip content="Delete">
          <button type="button" data-delete={lead.id} className="btn btn-danger-ghost btn-icon btn-xs" aria-label={`Delete the lead from ${who}`} onClick={onDelete} disabled={busy}>
            {busy ? <Spinner size={14} /> : <Trash2 aria-hidden="true" />}
          </button>
        </Tooltip>
      </div>
    </li>
  );
}
