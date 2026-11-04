import { useEffect, useId, useRef, useState } from 'react';
import { Globe, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { showSignIn } from '@/lib/cloud/auth';
import { PublishError, addDomain, checkDomain, isValidDomain, listPublished, normalizeDomain, removeDomain, usePublishAccess, type DomainInfo, type DomainRecord, type PublishedList } from '@/lib/publish';
import { CopyButton, Field, Spinner, confirmAction } from '@/components/ui/primitives';
import { toast } from '@/store/ui';

/** Where the app's owner links a domain to the published app in Replit. */
const REPLIT_LINK = 'Deployments → Settings → Link a domain';

/**
 * Settings → Domains: the owner's own domains, where their published pages can also show. Only where
 * publishing is on (never in the claude.ai build). `focus` scrolls it into view (from a page's
 * Publish panel).
 */
export function DomainsCard({ focus, onFocused }: { focus?: boolean; onFocused?: () => void }) {
  const { access } = usePublishAccess();
  if (access !== 'ready' && access !== 'signed-out') return null;
  return <Domains signedIn={access === 'ready'} focus={focus} onFocused={onFocused} />;
}

function Domains({ signedIn, focus, onFocused }: { signedIn: boolean; focus?: boolean; onFocused?: () => void }) {
  const ids = useId();
  const card = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [list, setList] = useState<PublishedList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // domains another account added first: their TXT record moves them here (kept until the page closes)
  const [claims, setClaims] = useState<DomainInfo[]>([]);
  const [checking, setChecking] = useState<Set<string>>(() => new Set());
  const [problems, setProblems] = useState<Record<string, string>>({});
  const checkedOnce = useRef(new Set<string>());

  const focused = useRef(onFocused);
  focused.current = onFocused;
  useEffect(() => {
    if (!focus) return;
    card.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    input.current?.focus({ preventScroll: true });
    focused.current?.();
  }, [focus]);

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

  const add = async () => {
    const domain = normalizeDomain(draft);
    if (!isValidDomain(domain)) return setAddError('Enter a domain like yourbrand.com.');
    if (list?.domains.some((d) => d.domain === domain)) return setAddError(`${domain} is already on your list.`);
    setAdding(true);
    setAddError(null);
    try {
      const info = await addDomain(domain);
      setDraft('');
      if (info.takenByOther) {
        keepClaim(info);
        setProblems((p) => ({ ...p, [info.domain]: '' }));
        toast({ kind: 'info', title: `Another account added ${info.domain} first`, body: 'If it’s yours, add the TXT record shown below to move it to your account.' });
        return;
      }
      keepDomain(info);
      toast({ kind: 'success', title: `${info.domain} added`, body: 'Follow the steps below to connect it.' });
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

  const rows = [...(list?.domains ?? []), ...claims];

  return (
    <section ref={card} id="settings-domains" className="panel scroll-mt-4 p-4 sm:p-5" aria-labelledby={`${ids}-title`}>
      <div className="mb-4 min-w-0">
        <h2 id={`${ids}-title`} className="section-title flex items-center gap-2">
          <Globe size={16} className="text-primary" aria-hidden="true" /> Domains
        </h2>
        <p className="mt-0.5 text-[13px] text-muted">Show your published pages on a domain you own, like yourbrand.com, as well as on this app’s address. Your domains work for all your projects.</p>
      </div>

      {!signedIn ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-[13px] text-ink-2">Sign in to add your own domains.</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={showSignIn}>
            Sign in
          </button>
        </div>
      ) : (
        <>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!adding && draft.trim()) void add();
            }}
          >
            <Field label="Add a domain" htmlFor={`${ids}-new`} className="min-w-[200px] flex-1" error={addError}>
              <input
                ref={input}
                id={`${ids}-new`}
                className="input"
                value={draft}
                placeholder="yourbrand.com"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                disabled={adding}
                aria-invalid={!!addError}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setAddError(null);
                }}
              />
            </Field>
            <button type="submit" className="btn btn-primary" disabled={adding || !draft.trim() || !list}>
              {adding ? <Spinner size={14} /> : <Plus size={15} />} Add domain
            </button>
          </form>

          {loadError && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-bad" role="alert">
              <span className="min-w-0 flex-1">{loadError}</span>
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => setLoads((n) => n + 1)}>
                Try again
              </button>
            </div>
          )}
          {!list && !loadError && (
            <p className="mt-3 flex items-center gap-2 text-[13px] text-muted">
              <Spinner size={14} /> Loading your domains…
            </p>
          )}

          {rows.length > 0 && (
            <ul className="mt-4 flex flex-col" aria-label="Your domains">
              {rows.map((d) => {
                const claim = !!d.takenByOther;
                const pages = claim ? [] : (list?.pages ?? []).filter((p) => p.domain === d.domain);
                const busy = checking.has(d.domain);
                const problem = problems[d.domain];
                return (
                  <li key={d.domain} className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all text-[14px] font-semibold text-ink">{d.domain}</span>
                      <span aria-live="polite">
                        {busy ? (
                          <span className="badge bg-surface-2 text-muted">
                            <Spinner size={10} /> Checking
                          </span>
                        ) : claim ? (
                          <span className="badge bg-warn-soft text-warn">Another account’s for now</span>
                        ) : d.verified ? (
                          <span className="badge bg-good-soft text-good">Verified</span>
                        ) : (
                          <span className="badge bg-warn-soft text-warn">Not verified yet</span>
                        )}
                      </span>
                      <span className="ml-auto flex gap-1.5">
                        <button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={() => void check(d.domain, claim)}>
                          <RefreshCw size={12} /> Check again
                        </button>
                        {claim ? (
                          <button type="button" className="btn btn-ghost btn-xs text-muted" aria-label={`Stop adding ${d.domain}`} onClick={() => setClaims((c) => c.filter((x) => x.domain !== d.domain))}>
                            <X size={12} /> Cancel
                          </button>
                        ) : (
                          <button type="button" className="btn btn-ghost btn-xs text-muted hover:text-bad" aria-label={`Remove ${d.domain}`} onClick={() => void remove(d.domain, pages.length)}>
                            <Trash2 size={12} /> Remove
                          </button>
                        )}
                      </span>
                    </div>
                    {!busy && !d.verified && problem && <p className="text-[12.5px] text-muted">{problem}</p>}
                    {claim ? (
                      <>
                        <p className="text-[12.5px] text-ink-2">Another account added this domain first. If it’s yours, add this TXT record at your domain registrar, then press “Check again”: the domain moves to your account.</p>
                        <TxtRecord record={d.record} />
                      </>
                    ) : d.verified ? (
                      <>
                        <p className="text-[12.5px] text-muted">
                          {pages.length ? `Shows: ${pages.map((p) => `${p.title || p.slug} (${p.home ? 'home page' : `/${p.slug}`})`).join(' · ')}` : 'No pages on it yet. Choose it when you publish a page.'}
                        </p>
                        <details className="text-[12.5px] text-muted">
                          <summary className="cursor-pointer select-none">Its TXT record (keep it at your registrar)</summary>
                          <div className="mt-2 flex flex-col gap-2">
                            <TxtRecord record={d.record} />
                            <p>The app looks at this record every few hours. If it’s removed, the domain stops showing your pages. It also has to stay linked to this app in Replit ({REPLIT_LINK}).</p>
                          </div>
                        </details>
                      </>
                    ) : (
                      <>
                        <ConnectSteps record={d.record} />
                        <p className="text-[12.5px] text-muted">
                          {pages.length ? `Will show: ${pages.map((p) => `${p.title || p.slug} (${p.home ? 'home page' : `/${p.slug}`})`).join(' · ')}` : 'No pages on it yet. Choose it when you publish a page.'}
                        </p>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-4 rounded-md bg-surface-2/60 px-3 py-2.5 text-[12.5px]">
            <p className="font-semibold text-ink-2">How to connect a domain</p>
            <ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-5 leading-relaxed text-ink-2">
              <li>Add it above. You get a TXT record for it.</li>
              <li>At your domain registrar, add that TXT record. It shows the domain is yours, and it has to stay there.</li>
              <li>
                The domain must also be linked to this app in Replit: {REPLIT_LINK}. Then add the records Replit shows at your registrar too (on Cloudflare: DNS only, not proxied). Only the app’s owner can link it; if that’s someone else, send them the domain.
              </li>
              <li>Come back here and press “Check again” next to the domain. New records can take from a few minutes to a few hours to show up.</li>
            </ol>
          </div>
        </>
      )}
    </section>
  );
}

/** What to do for a domain that isn't verified yet: its TXT record, and linking it in Replit. */
export function ConnectSteps({ record }: { record: DomainRecord }) {
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 text-[12.5px] leading-relaxed text-ink-2">
      <li>
        At your domain registrar, add this TXT record:
        <TxtRecord record={record} className="mt-1.5" />
      </li>
      <li>Link the domain to this app in Replit: {REPLIT_LINK}. Only the app’s owner can do this; if that’s someone else, send them the domain.</li>
      <li>Press “Check again”.</li>
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
    <div className={`flex flex-col gap-1.5 rounded-md border border-line bg-surface px-3 py-2 ${className}`}>
      <p className="text-xs text-muted">
        Type: <span className="font-mono text-ink-2">TXT</span>
      </p>
      {rows.map(([label, text]) => (
        <div key={label} className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="w-11 shrink-0 text-xs text-muted">{label}</span>
          <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-ink">{text}</code>
          <CopyButton text={text} size="xs" label={`Copy ${label.toLowerCase()}`} />
        </div>
      ))}
      <p className="text-xs text-muted">Some registrars add your domain to the end of the name by themselves. If yours does, type the name without it.</p>
    </div>
  );
}
