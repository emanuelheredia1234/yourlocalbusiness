import { useEffect, useId, useRef, useState } from 'react';
import { Globe, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { showSignIn } from '@/lib/cloud/auth';
import { PublishError, addDomain, checkDomain, isValidDomain, listPublished, normalizeDomain, removeDomain, usePublishAccess, type DomainInfo, type DomainRecord, type PublishedList } from '@/lib/publish';
import { cn } from '@/lib/utils';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Badge, Callout, CopyButton, Drawer, Empty, Field, MoreMenu, SettingsRow, SettingsSection, Spinner, confirmAction } from '@/components/ui/primitives';
import { toast } from '@/store/ui';
import { useFocusBack } from './sheetFocus';

/**
 * Settings › Domains: the owner's own domains, where their published pages can also show. Only where
 * publishing is on (never in the claude.ai build). `focus` (from a page's Publish panel: "Add a domain…",
 * or "Check it…" for one that isn't verified) brings the list and its Add domain button into view.
 */
export function DomainsCard({ focus, onFocused }: { focus?: boolean; onFocused?: () => void }) {
  const { access } = usePublishAccess();
  if (access !== 'ready' && access !== 'signed-out') return null;
  return <Domains signedIn={access === 'ready'} focus={focus} onFocused={onFocused} />;
}

const pagesText = (pages: { title?: string; slug: string; home?: boolean }[]) => pages.map((p) => `${p.title || p.slug} (${p.home ? 'home page' : `/${p.slug}`})`).join(' · ');

function Domains({ signedIn, focus, onFocused }: { signedIn: boolean; focus?: boolean; onFocused?: () => void }) {
  const ids = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  const [list, setList] = useState<PublishedList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // domains another account added first: their TXT record moves them here (kept until the page closes)
  const [claims, setClaims] = useState<DomainInfo[]>([]);
  const [checking, setChecking] = useState<Set<string>>(() => new Set());
  const [problems, setProblems] = useState<Record<string, string>>({});
  // verified domains whose TXT record is shown (it has to stay at the registrar)
  const [records, setRecords] = useState<Set<string>>(() => new Set());
  const checkedOnce = useRef(new Set<string>());

  const focused = useRef(onFocused);
  focused.current = onFocused;
  // the section, not the side sheet: "Check it" comes here to see a domain's row and its TXT record. The Add
  // domain button takes the focus: now when the list is in, else as soon as it arrives (it's disabled until
  // then), never later (a request that waited would pull the focus away when a check or an add changes the list)
  const focusAdd = useRef(false);
  useEffect(() => {
    if (!focus) return;
    addButton.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (list) addButton.current?.focus({ preventScroll: true });
    else focusAdd.current = true;
    focused.current?.();
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps -- the list as it is when the request arrives
  useEffect(() => {
    if (!focusAdd.current || !list) return;
    focusAdd.current = false;
    addButton.current?.focus({ preventScroll: true });
  }, [list]);
  // the Add domain side sheet gives the focus back to the button when it closes
  const openedFrom = useFocusBack(drawer);

  /** Put a domain in the list as the server describes it now (it may have just moved to this account). */
  const keepDomain = (info: DomainInfo) => {
    setList((l) => l && { ...l, domains: l.domains.some((d) => d.domain === info.domain) ? l.domains.map((d) => (d.domain === info.domain ? info : d)) : [...l.domains, info] });
    setClaims((c) => c.filter((d) => d.domain !== info.domain));
  };

  /** Keep a domain another account added first (or update it), with the TXT record that moves it here. */
  const keepClaim = (info: DomainInfo) => setClaims((c) => [...c.filter((d) => d.domain !== info.domain), info]);

  const check = async (domain: string, claim = false) => {
    checkedOnce.current.add(domain);
    setChecking((s) => new Set(s).add(domain));
    try {
      let r: Awaited<ReturnType<typeof checkDomain>>;
      try {
        r = await checkDomain(domain);
      } catch (e) {
        // the other account removed it meanwhile: it's free, so it's added here (its TXT record is the same)
        if (!(claim && e instanceof PublishError && e.code === 'NOT_FOUND')) throw e;
        const info = await addDomain(domain);
        if (info.takenByOther) keepClaim(info);
        else keepDomain(info);
        r = await checkDomain(domain);
      }
      if (r.verified && r.domain) {
        keepDomain(r.domain);
        if (claim) toast({ kind: 'success', title: `${domain} is in your account now`, body: 'Choose it when you publish a page.' });
      } else setList((l) => l && { ...l, domains: l.domains.map((d) => (d.domain === domain ? { ...d, verified: r.verified, verifiedAt: r.verified ? Date.now() : null } : d)) });
      setProblems((p) => ({ ...p, [domain]: r.verified ? '' : r.error || 'Its TXT record isn’t there yet.' }));
    } catch (e) {
      setProblems((p) => ({ ...p, [domain]: (e as Error)?.message || 'Couldn’t check it. Try again.' }));
    } finally {
      setChecking((s) => {
        const next = new Set(s);
        next.delete(domain);
        return next;
      });
    }
  };

  useEffect(() => {
    if (!signedIn) return;
    const ctrl = new AbortController();
    setLoadError(null);
    listPublished(ctrl.signal).then(
      (l) => {
        setList(l);
        // look again at the ones that weren't verified, once: their records may have arrived since
        for (const d of l.domains) if (!d.verified && !checkedOnce.current.has(d.domain)) void check(d.domain);
      },
      (e: Error) => {
        if (!ctrl.signal.aborted) setLoadError(e.message || 'Couldn’t load your domains.');
      },
    );
    return () => ctrl.abort();
  }, [signedIn, loads]);

  const closeDrawer = () => {
    setDrawer(false);
    setAddError(null);
  };

  const add = async () => {
    const domain = normalizeDomain(draft);
    if (!isValidDomain(domain)) return setAddError('Enter a domain like yourbrand.com.');
    if (list?.domains.some((d) => d.domain === domain)) return setAddError(`${domain} is already on your list.`);
    setAdding(true);
    setAddError(null);
    try {
      const info = await addDomain(domain);
      setDraft('');
      setDrawer(false);
      if (info.takenByOther) {
        keepClaim(info);
        setProblems((p) => ({ ...p, [info.domain]: '' }));
        toast({ kind: 'info', title: `Another account added ${info.domain} first`, body: 'If it’s yours, add the TXT record shown in the list to move it to your account.' });
        return;
      }
      keepDomain(info);
      toast({ kind: 'success', title: `${info.domain} added`, body: 'Add its TXT record at your registrar: it’s shown in the list.' });
      void check(info.domain);
    } catch (e) {
      setAddError((e as Error)?.message || 'Couldn’t add that domain. Try again.');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (domain: string, pageCount: number) => {
    const body =
      pageCount === 1
        ? 'The page on it stops showing there. It keeps its address on this app.'
        : pageCount > 1
          ? `The ${pageCount} pages on it stop showing there. They keep their addresses on this app.`
          : 'You can add it again later.';
    if (!(await confirmAction({ title: `Remove ${domain}?`, body, confirmLabel: 'Remove domain', danger: true }))) return;
    try {
      await removeDomain(domain);
      setList((l) => l && { ...l, domains: l.domains.filter((d) => d.domain !== domain), pages: l.pages.map((p) => (p.domain === domain ? { ...p, domain: undefined, domainUrl: undefined, home: false } : p)) });
      toast({ kind: 'success', title: `${domain} removed` });
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t remove the domain', body: (e as Error)?.message || 'Please try again.' });
    }
  };

  const toggleRecord = (domain: string) =>
    setRecords((s) => {
      const next = new Set(s);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });

  const rows = [...(list?.domains ?? []), ...claims];

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        id="settings-domains"
        title="Domains"
        description="Show your published pages on a domain you own, like yourbrand.com. Your domains work for all your projects."
        actions={
          signedIn && (
            <button
              ref={addButton}
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!list}
              onClick={(e) => {
                openedFrom(e.currentTarget);
                setDrawer(true);
              }}
            >
              <Plus /> Add domain
            </button>
          )
        }
      >
        {!signedIn ? (
          <SettingsRow label="Sign in to add your own domains." description="Then publish your pages on them.">
            <button type="button" className="btn btn-primary btn-sm" onClick={showSignIn}>
              Sign in
            </button>
          </SettingsRow>
        ) : (
          <>
            {loadError && (
              <div className="py-4">
                <Callout
                  tone="bad"
                  action={
                    <button type="button" className="btn btn-secondary btn-xs" onClick={() => setLoads((n) => n + 1)}>
                      Try again
                    </button>
                  }
                >
                  {loadError}
                </Callout>
              </div>
            )}
            {!list && !loadError && (
              <p className="flex items-center gap-2 py-4 text-small text-muted">
                <Spinner size={14} /> Loading your domains…
              </p>
            )}
            {list && !rows.length && <Empty icon={<Globe />} title="No domains yet" body="Add one to show your pages at yourbrand.com as well as on this app’s address." className="py-8" />}

            {rows.length > 0 && (
              <div className="-mx-5 mt-3 border-t border-line">
                <div className="hidden grid-cols-[minmax(0,1.3fr)_136px_minmax(0,1fr)_100px] gap-4 border-b border-line px-5 py-2 text-caption text-muted md:grid" aria-hidden="true">
                  <span>Domain</span>
                  <span>Status</span>
                  <span>Pages</span>
                  <span />
                </div>
                <ul className="flex flex-col" aria-label="Your domains">
                  {rows.map((d) => {
                    const claim = !!d.takenByOther;
                    const pages = claim ? [] : (list?.pages ?? []).filter((p) => p.domain === d.domain);
                    const busy = checking.has(d.domain);
                    const problem = problems[d.domain];
                    const showRecord = claim || !d.verified || records.has(d.domain);
                    return (
                      <li key={d.domain} className="border-b border-line px-5 py-3 last:border-b-0">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 md:grid-cols-[minmax(0,1.3fr)_136px_minmax(0,1fr)_100px]">
                          <span className="min-w-0 break-all font-mono text-small text-ink max-md:col-span-2">{d.domain}</span>
                          <span aria-live="polite" className="md:order-none max-md:col-start-1 max-md:row-start-2">
                            {busy ? (
                              <Badge>
                                <Spinner size={12} /> Checking
                              </Badge>
                            ) : claim ? (
                              <Badge tone="warn">Another account’s for now</Badge>
                            ) : d.verified ? (
                              <Badge tone="good">Verified</Badge>
                            ) : (
                              <Badge tone="warn">Waiting for DNS</Badge>
                            )}
                          </span>
                          <span className="min-w-0 truncate text-small text-muted max-md:hidden" title={pages.length ? pagesText(pages) : undefined}>
                            {claim ? '–' : pages.length ? pagesText(pages) : 'No pages yet'}
                          </span>
                          <span className="flex items-center justify-end gap-1 max-md:col-start-2 max-md:row-start-2">
                            {(claim || !d.verified) && (
                              <button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={() => void check(d.domain, claim)}>
                                <RefreshCw /> Check again
                              </button>
                            )}
                            <MoreMenu
                              size="xs"
                              label={`More actions for ${d.domain}`}
                              items={
                                claim
                                  ? [{ label: 'Stop adding it', icon: <X />, onSelect: () => setClaims((c) => c.filter((x) => x.domain !== d.domain)) }]
                                  : [
                                      ...(d.verified
                                        ? [
                                            { label: 'Check again', icon: <RefreshCw />, onSelect: () => void check(d.domain) },
                                            { label: records.has(d.domain) ? 'Hide its TXT record' : 'Show its TXT record', icon: <Globe />, onSelect: () => toggleRecord(d.domain) },
                                          ]
                                        : []),
                                      { label: 'Remove domain', icon: <Trash2 />, danger: true, onSelect: () => void remove(d.domain, pages.length) },
                                    ]
                              }
                            />
                          </span>
                        </div>
                        {!claim && pages.length > 0 && <p className="mt-1 truncate text-small text-muted md:hidden">{pagesText(pages)}</p>}
                        {showRecord && (
                          <div className="mt-3 flex flex-col gap-2">
                            {claim ? (
                              <>
                                <p className="text-small text-ink-2">Another account added this domain first. If it’s yours, add this TXT record at your registrar, then press “Check again”: the domain moves to your account.</p>
                                {!busy && problem && <p className="text-small text-muted">{problem}</p>}
                              </>
                            ) : d.verified ? (
                              <p className="text-small text-ink-2">Keep this record at your registrar: the app looks at it every few hours, and without it the domain stops showing your pages.</p>
                            ) : (
                              // what the last check found (it says what to do), else the plain step
                              <p className="text-small text-ink-2">{(!busy && problem) || 'Add this TXT record at your registrar, then press “Check again”. New records can take from a few minutes to a few hours to show up.'}</p>
                            )}
                            <TxtRecord record={d.record} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
        <Accordion type="single" collapsible className={cn('-mx-5 border-t border-line px-5', !signedIn && 'mt-1')}>
          <AccordionItem value="how" className="border-b-0">
            <AccordionTrigger>How to connect a domain</AccordionTrigger>
            <AccordionContent>
              <ConnectSteps />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </SettingsSection>

      <Drawer
        open={drawer}
        onClose={closeDrawer}
        title="Add a domain"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeDrawer}>
              Cancel
            </button>
            <button type="submit" form={`${ids}-form`} className="btn btn-primary" disabled={adding || !draft.trim() || !list}>
              {adding ? <Spinner size={16} /> : <Plus />} Add domain
            </button>
          </>
        }
      >
        <form
          id={`${ids}-form`}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!adding && draft.trim()) void add();
          }}
        >
          <p className="text-body text-muted">Your published pages can show on it as well as on this app’s address. Next you add a TXT record at your registrar to show it’s yours.</p>
          <Field label="Domain" htmlFor={`${ids}-new`} error={addError} hint={!addError ? 'Without https://, like yourbrand.com or www.yourbrand.com.' : undefined}>
            <input
              id={`${ids}-new`}
              className="input"
              value={draft}
              placeholder="yourbrand.com"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="url"
              autoFocus
              disabled={adding}
              aria-invalid={!!addError}
              onChange={(e) => {
                setDraft(e.target.value);
                setAddError(null);
              }}
            />
          </Field>
        </form>
      </Drawer>
    </div>
  );
}

/** The steps, written once: the TXT record proves the domain is yours; the domain also has to reach this app. */
export function ConnectSteps() {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-small text-ink-2">
      <li>Add the domain here. You get a TXT record for it.</li>
      <li>At your domain registrar, add that TXT record. It shows the domain is yours, and it has to stay there.</li>
      <li>Connect the domain to this app where the app is hosted. Only the app’s owner can do this; if that’s someone else, send them the domain.</li>
      <li>Come back and press “Check again” next to the domain. New records can take from a few minutes to a few hours to show up.</li>
    </ol>
  );
}

/** A TXT record, its name and value each with a Copy button. */
export function TxtRecord({ record, className = '' }: { record: DomainRecord; className?: string }) {
  const rows: [string, string][] = [
    ['Name', record.name],
    ['Value', record.value],
  ];
  return (
    <div className={cn('well flex flex-col gap-2 px-3 py-2.5', className)}>
      <div className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
        <span className="text-caption text-muted">Type</span>
        <span className="col-span-2 font-mono text-small text-ink">TXT</span>
        {rows.map(([label, text]) => (
          <div key={label} className="contents">
            <span className="text-caption text-muted">{label}</span>
            <code className="min-w-0 break-all font-mono text-small text-ink">{text}</code>
            <CopyButton text={text} size="xs" label={`Copy ${label.toLowerCase()}`} />
          </div>
        ))}
      </div>
      <p className="text-caption text-muted">Some registrars add your domain to the end of the name by themselves. If yours does, type the name without it.</p>
    </div>
  );
}
