import { useEffect, useId, useRef, useState } from 'react';
import { CalendarClock, Check, Download, Inbox, Mail, Phone, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import type { Project } from '@/lib/types';
import { cn, fmtDateTime, fmtRelative, slugify } from '@/lib/utils';
import { showSignIn } from '@/lib/cloud/auth';
import { usePublishAccess } from '@/lib/publish';
import { LEADS_PAGE_SIZE, MAX_EMAIL, deleteLead, leadEmail, leadTime, leadsCsv, listLeads, seoPageIdOf, type Lead } from '@/lib/leads';
import { addLeadToSubscribers, leadProject, markLeadsSeen, useLeads } from '@/store/leads';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { Empty, Segmented, Spinner, confirmAction } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';
import { safeEmail, safePhone } from '@/lib/listingActions';

type Scope = 'page' | 'all';

/** the most a CSV export takes, newest first */
const EXPORT_MAX = 5000;
/** a message longer than this shows its first lines, with Show all */
const LONG_LINES = 6;
const LONG_CHARS = 360;

/**
 * Email → Leads: what people sent with the form on the owner's published pages (a lead form page, a
 * booking request, a question). The server keeps them; the app shows them, newest first, and can add one
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
    <section className="panel flex flex-wrap items-center gap-3 p-4" aria-label="Leads">
      <Inbox size={18} className="shrink-0 text-muted" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[13px] text-ink-2">{children}</p>
      {action}
    </section>
  );
}

/** What the watcher already has for this view: shown at once, until the list arrives. */
function seed(recent: Lead[] | null, pageId: string | undefined): Lead[] | null {
  if (!recent) return null;
  return pageId ? recent.filter((l) => l.pageId === pageId) : recent;
}

const mailHref = (email: string) => `mailto:${email.replace(/[%?#&=]/g, (c) => encodeURIComponent(c))}`;

function LeadList({ project }: { project: Project }) {
  const ids = useId();
  const projects = useStore((s) => s.projects);
  const recent = useLeads((s) => s.recent);
  const [scope, setScope] = useState<Scope>('page');
  const pageId = scope === 'page' ? seoPageIdOf(project.id) : undefined;
  const [leads, setLeads] = useState<Lead[] | null>(() => seed(recent, pageId));
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
    listLeads({ pageId, limit: LEADS_PAGE_SIZE, signal: ctrl.signal }).then(
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
  }, [pageId, loads]);

  // seen: what this page's list shows counts as seen (the bell's count and the badge go)
  useEffect(() => {
    if (scope !== 'page' || !leads?.length) return;
    markLeadsSeen(project.id, Math.max(...leads.map(leadTime)));
  }, [leads, scope, project.id]);

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
    setLeads(seed(useLeads.getState().recent, s === 'page' ? seoPageIdOf(project.id) : undefined));
    setMore(false);
  };

  const loadMore = async () => {
    const last = leads?.[leads.length - 1];
    if (!last) return;
    const v = view.current;
    setLoading(true);
    setError('');
    try {
      const next = await listLeads({ pageId, before: last.createdAt, limit: LEADS_PAGE_SIZE });
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

  const ownerOf = (lead: Lead) => projects.find((p) => seoPageIdOf(p.id) === lead.pageId) ?? null;
  const pageLabel = (lead: Lead) => {
    const owner = ownerOf(lead);
    return `/${lead.slug}${owner ? ` · ${owner.brand.name}` : ''}`;
  };
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

  const subscribe = (lead: Lead) => {
    const r = addLeadToSubscribers(lead);
    if (r.status === 'added') toast({ kind: 'success', title: 'Added to your subscribers', body: r.projectId === project.id ? 'Find them under Subscribers.' : `In ${r.brand}’s Email → Subscribers.` });
    else if (r.status === 'exists') toast({ kind: 'info', title: 'Already on your subscriber list' });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: Lead[] = [];
      let before: string | undefined;
      while (all.length < EXPORT_MAX) {
        const batch = await listLeads({ pageId, before, limit: 100 });
        all.push(...batch);
        if (batch.length < 100) break;
        before = batch[batch.length - 1].createdAt;
      }
      const list = all.slice(0, EXPORT_MAX);
      const name = scope === 'page' ? `${slugify(project.brand.name) || 'your'}-leads.csv` : 'leads-all-pages.csv';
      // a byte-order mark, so spreadsheets read names with accents right
      await download(name, String.fromCharCode(0xfeff) + leadsCsv(list, pageLabel));
      if (all.length >= EXPORT_MAX) toast({ kind: 'info', title: 'Exported the newest 5,000 leads.' });
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t export your leads', body: (e as Error)?.message });
    } finally {
      setExporting(false);
    }
  };

  const count = leads?.length ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-md border border-line bg-surface-2/60 px-3 py-2 text-[13px] text-ink-2">Messages people send with the form on your published page. Reply from your own email or phone: the app doesn’t send email.</p>
      <section className="panel overflow-hidden" aria-labelledby={`${ids}-title`}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <h2 id={`${ids}-title`} className="text-[13px] font-semibold">
            {leads ? `${count}${more ? '+' : ''} lead${count === 1 && !more ? '' : 's'}` : 'Leads'}
          </h2>
          <div role="group" aria-label="Which pages">
            <Segmented<Scope>
              size="sm"
              value={scope}
              onChange={changeScope}
              options={[
                { id: 'page', label: 'This page' },
                { id: 'all', label: 'All pages' },
              ]}
            />
          </div>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLoads((n) => n + 1)} disabled={loading}>
              <RefreshCw size={14} className={cn(loading && 'animate-spin')} aria-hidden="true" /> Refresh
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void exportCsv()} disabled={!count || exporting}>
              {exporting ? <Spinner size={14} /> : <Download size={14} aria-hidden="true" />} Export CSV
            </button>
          </div>
        </div>
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-line bg-bad-soft px-4 py-2 text-[13px] text-bad">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => setLoads((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {leads === null ? (
          error ? null : (
            <div className="flex h-32 items-center justify-center text-muted" role="status" aria-label="Loading your leads">
              <Spinner size={20} />
            </div>
          )
        ) : leads.length === 0 ? (
          <Empty
            className="m-4"
            icon={<Inbox size={20} />}
            title="No leads yet"
            body="When someone sends the form on your published page, it shows here. Lead form pages have a form, and so do booking pages without a booking link."
            action={
              scope === 'page' ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => useUI.getState().openSeoBuilder({ pageType: 'lead' })}>
                  Build a lead form page
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <p className="px-4 pt-3 text-xs text-muted">Add only people who asked to hear from you.</p>
            <ul ref={listRef} tabIndex={-1} aria-label="Leads" className="divide-y divide-line">
              {leads.map((lead) => (
                <LeadItem key={lead.id} lead={lead} project={project} projects={projects} from={ownerOf(lead)} who={who(lead)} busy={busy.has(lead.id)} onSubscribe={() => subscribe(lead)} onDelete={() => void remove(lead)} />
              ))}
            </ul>
            {more && (
              <div className="border-t border-line px-4 py-3 text-center">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadMore()} disabled={loading}>
                  {loading ? <Spinner size={14} /> : null} Load more
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

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
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={cn('min-w-0 break-words text-[13.5px] font-semibold', !lead.name && 'text-muted')}>{lead.name ? <bdi>{lead.name}</bdi> : 'No name given'}</span>
          {lead.createdAt && (
            <time dateTime={lead.createdAt} title={t ? fmtDateTime(t) : undefined} className="text-xs text-muted">
              {t ? fmtRelative(t) : lead.createdAt}
            </time>
          )}
        </p>
        {lead.time && (
          <p className="mt-1">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-info-soft px-2.5 py-0.5 text-xs font-medium text-info">
              <CalendarClock size={13} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 break-words">
                Preferred time: <bdi>{lead.time}</bdi>
              </span>
            </span>
          </p>
        )}
        {(lead.email || lead.phone) && (
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {lead.email && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Mail size={13} aria-hidden="true" className="shrink-0 text-muted" />
                {email ? (
                  <a href={mailHref(email)} className="min-w-0 break-all font-medium text-primary hover:underline">
                    <bdi>{lead.email}</bdi>
                  </a>
                ) : (
                  <bdi className="min-w-0 break-all">{lead.email}</bdi>
                )}
              </span>
            )}
            {lead.phone && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Phone size={13} aria-hidden="true" className="shrink-0 text-muted" />
                {phone ? (
                  <a href={`tel:${phone.tel}`} className="min-w-0 break-all font-medium text-primary hover:underline">
                    <bdi>{lead.phone}</bdi>
                  </a>
                ) : (
                  <bdi className="min-w-0 break-all">{lead.phone}</bdi>
                )}
              </span>
            )}
          </p>
        )}
        {lead.message && (
          <div className="mt-1.5">
            <p id={`${ids}-msg`} dir="auto" className={cn('whitespace-pre-line break-words text-[13px] text-ink-2', long && !open && 'line-clamp-6')}>
              {lead.message}
            </p>
            {long && (
              <button type="button" className="mt-0.5 text-xs font-semibold text-primary hover:underline" aria-expanded={open} aria-controls={`${ids}-msg`} onClick={() => setOpen((v) => !v)}>
                {open ? 'Show less' : 'Show all'}
              </button>
            )}
          </div>
        )}
        <p className="mt-1.5 break-words text-xs text-muted">
          From /{lead.slug} · {from ? from.brand.name : 'a page that isn’t in your projects'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {subscribed ? (
          <button type="button" className="btn btn-secondary btn-xs" disabled>
            <Check size={13} className="text-good" aria-hidden="true" /> Subscribed
          </button>
        ) : (
          <button type="button" className="btn btn-secondary btn-xs" onClick={onSubscribe} disabled={!canSubscribe} title={canSubscribe ? undefined : 'No email address to add'}>
            <UserPlus size={13} aria-hidden="true" /> Add to subscribers
          </button>
        )}
        <button type="button" data-delete={lead.id} className="btn btn-ghost btn-icon btn-xs text-muted hover:text-bad" aria-label={`Delete the lead from ${who}`} onClick={onDelete} disabled={busy}>
          {busy ? <Spinner size={13} /> : <Trash2 size={13} aria-hidden="true" />}
        </button>
      </div>
    </li>
  );
}
