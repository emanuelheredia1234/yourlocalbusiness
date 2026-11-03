import { useEffect, useId, useRef, useState } from 'react';
import { Globe, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { showSignIn } from '@/lib/cloud/auth';
import { addDomain, checkDomain, isValidDomain, listPublished, normalizeDomain, removeDomain, usePublishAccess, type DomainInfo, type PublishedList } from '@/lib/publish';
import { Field, Spinner, confirmAction } from '@/components/ui/primitives';
import { toast } from '@/store/ui';

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

  const patchDomain = (domain: string, patch: Partial<DomainInfo>) => setList((l) => l && { ...l, domains: l.domains.map((d) => (d.domain === domain ? { ...d, ...patch } : d)) });

  const check = async (domain: string) => {
    checkedOnce.current.add(domain);
    setChecking((s) => new Set(s).add(domain));
    try {
      const r = await checkDomain(domain);
      patchDomain(domain, r.verified ? { verified: true, verifiedAt: Date.now() } : { verified: false });
      setProblems((p) => ({ ...p, [domain]: r.verified ? '' : r.error || 'It doesn’t reach this app yet.' }));
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
        // look again at the ones that weren't working, once: their records may have arrived since
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
      setList((l) => l && { ...l, domains: [...l.domains.filter((d) => d.domain !== info.domain), info] });
      setDraft('');
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

          {list && list.domains.length > 0 && (
            <ul className="mt-4 flex flex-col" aria-label="Your domains">
              {list.domains.map((d) => {
                const pages = list.pages.filter((p) => p.domain === d.domain);
                const busy = checking.has(d.domain);
                const problem = problems[d.domain];
                return (
                  <li key={d.domain} className="flex flex-col gap-1.5 border-t border-line py-3 first:border-t-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all text-[14px] font-semibold text-ink">{d.domain}</span>
                      <span aria-live="polite">
                        {busy ? (
                          <span className="badge bg-surface-2 text-muted">
                            <Spinner size={10} /> Checking
                          </span>
                        ) : d.verified ? (
                          <span className="badge bg-good-soft text-good">Working</span>
                        ) : (
                          <span className="badge bg-warn-soft text-warn">Not reaching this app yet</span>
                        )}
                      </span>
                      <span className="ml-auto flex gap-1.5">
                        <button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={() => void check(d.domain)}>
                          <RefreshCw size={12} /> Check again
                        </button>
                        <button type="button" className="btn btn-ghost btn-xs text-muted hover:text-bad" aria-label={`Remove ${d.domain}`} onClick={() => void remove(d.domain, pages.length)}>
                          <Trash2 size={12} /> Remove
                        </button>
                      </span>
                    </div>
                    {!busy && !d.verified && problem && <p className="text-[12.5px] text-muted">{problem}</p>}
                    <p className="text-[12.5px] text-muted">
                      {pages.length
                        ? `Shows: ${pages.map((p) => `${p.title || p.slug} (${p.home ? 'home page' : `/${p.slug}`})`).join(' · ')}`
                        : 'No pages on it yet. Choose it when you publish a page.'}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-4 rounded-md bg-surface-2/60 px-3 py-2.5 text-[12.5px]">
            <p className="font-semibold text-ink-2">How to connect a domain</p>
            <ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-5 leading-relaxed text-ink-2">
              <li>
                In Replit, open your app → Tools → Domains (or Deployments → Settings → Domains) → “Use a domain you already own”, and enter the domain. Only the app’s owner can do this; if that’s someone else, send them the domain.
              </li>
              <li>At your domain registrar, add the A and TXT records Replit shows (on Cloudflare: DNS only, not proxied). It can take from a few minutes to a few hours.</li>
              <li>Come back here and press “Check again” next to the domain.</li>
            </ol>
          </div>
        </>
      )}
    </section>
  );
}
