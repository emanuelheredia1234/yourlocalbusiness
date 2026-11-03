import { useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, ExternalLink, Globe, RefreshCw } from 'lucide-react';
import type { Published } from '@/lib/types';
import { cn, fmtRelative } from '@/lib/utils';
import { copyText } from '@/lib/platform';
import { navigate } from '@/lib/router';
import { showSignIn } from '@/lib/cloud/auth';
import {
  PublishError,
  appOriginNow,
  buildHash,
  checkSlug,
  isValidSlug,
  listPublished,
  preparePublish,
  publishPage,
  publishTarget,
  publishedFromServer,
  slugFrom,
  typedSlug,
  unpublishPage,
  usePublishAccess,
  type PageKind,
  type PublishBuild,
  type PublishTarget,
  type PublishedList,
  type ServerPage,
} from '@/lib/publish';
import { CopyButton, Field, Spinner, confirmAction } from '@/components/ui/primitives';
import { toast, useUI } from '@/store/ui';

/** Open Settings at the Domains card. */
export function openDomainSettings() {
  useUI.getState().setSettingsTab('domains');
  navigate('workspace-settings');
}

type Availability = 'idle' | 'checking' | 'ok' | 'mine' | 'taken' | 'reserved' | 'format' | 'error';

/** What the name check says, and its tone (good · bad · plain). */
const AVAILABILITY: Record<Availability, { text: string; tone?: 'good' | 'bad' }> = {
  idle: { text: 'The name at the end of the address: letters, numbers and hyphens.' },
  checking: { text: 'Checking the name…' },
  ok: { text: 'This name is free.', tone: 'good' },
  mine: { text: 'This is the page’s address now.', tone: 'good' },
  taken: { text: 'That name is already taken. Try another one.', tone: 'bad' },
  reserved: { text: 'The app uses that name. Try another one.', tone: 'bad' },
  format: { text: 'Use 3 to 60 lower-case letters, numbers and hyphens.', tone: 'bad' },
  error: { text: 'Couldn’t check that name right now. You can still try to publish.', tone: 'bad' },
};

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return appOriginNow();
  }
};
const hostOf = (origin: string) => origin.replace(/^https?:\/\//, '');

/**
 * Publish a page (the sales page or an artifact) at a public address, with a name the owner chooses,
 * and optionally on one of their own domains. `build(target)` returns the page as it should go online
 * at that address (images as {{img-N}} tokens); the panel prepares the images, swaps the tokens for
 * their published addresses and sends it. `onChange` gets what to keep with the page (or undefined
 * once it's unpublished).
 */
export function PublishPanel({
  pageId,
  kind,
  title,
  defaultSlug,
  published,
  build,
  onChange,
  version,
  className,
}: {
  /** 'seo:<projectId>' or 'artifact:<assetId>' */
  pageId: string;
  kind: PageKind;
  title: string;
  defaultSlug: string;
  published?: Published;
  build: (target: PublishTarget) => PublishBuild | Promise<PublishBuild>;
  onChange: (published: Published | undefined) => void;
  /** changes when the page does (e.g. its updatedAt), so the panel looks again for changes not published yet */
  version?: string | number;
  className?: string;
}) {
  const { access, retry } = usePublishAccess();
  const ids = useId();
  const latest = useRef({ published, onChange, build });
  latest.current = { published, onChange, build };

  const [list, setList] = useState<PublishedList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<null | 'publish' | 'unpublish'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const initialSlug = () => published?.slug ?? (slugFrom(defaultSlug) || slugFrom(title));
  const [slug, setSlug] = useState(initialSlug);
  const [touched, setTouched] = useState(false);
  const [domain, setDomain] = useState(published?.domain ?? '');
  const [home, setHome] = useState(!!published?.home);
  const [avail, setAvail] = useState<Availability>('idle');
  const availCache = useRef(new Map<string, Availability>());

  const showForm = !published || editing;
  const finalSlug = slug.replace(/-+$/, '');

  // the page's name follows its default until the owner types one
  useEffect(() => {
    if (!published && !touched) setSlug(slugFrom(defaultSlug) || slugFrom(title));
  }, [defaultSlug, title, published, touched]);

  // what's published under this account, and whether it still matches what this device remembers
  useEffect(() => {
    if (access !== 'ready') return;
    const ctrl = new AbortController();
    setListError(null);
    listPublished(ctrl.signal).then(
      (l) => {
        setList(l);
        const { published: mine, onChange: save } = latest.current;
        const server = l.pages.find((p) => p.pageId === pageId);
        if (server) {
          const sameAddress = !!mine && mine.slug === server.slug && (mine.domain ?? '') === (server.domain ?? '') && !!mine.home === server.home;
          const same = sameAddress && mine.url === server.url && (mine.domainUrl ?? '') === (server.domainUrl ?? '');
          // moved on another device: what went online there is unknown here, so no "changes not published yet"
          if (!same) save(publishedFromServer(server, sameAddress ? mine.hash : '', mine?.publishedAt));
        } else if (mine) {
          save(undefined);
          setNotice('This page isn’t published anymore. It may have been unpublished on another device.');
        }
      },
      (e: Error) => {
        if (!ctrl.signal.aborted) setListError(e.message || 'Couldn’t load your published pages.');
      },
    );
    return () => ctrl.abort();
  }, [access, pageId, loads]);

  // is the name free?
  useEffect(() => {
    if (!showForm || access !== 'ready') return;
    if (!finalSlug) return setAvail('idle');
    if (!isValidSlug(finalSlug)) return setAvail('format');
    if (published && finalSlug === published.slug) return setAvail('mine');
    const known = availCache.current.get(finalSlug);
    if (known) return setAvail(known);
    setAvail('checking');
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      checkSlug(finalSlug, pageId, ctrl.signal).then(
        (r) => {
          const a: Availability = r.ok ? 'ok' : (r.reason ?? 'taken');
          availCache.current.set(finalSlug, a);
          setAvail(a);
        },
        () => {
          if (!ctrl.signal.aborted) setAvail('error');
        },
      );
    }, 450);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [finalSlug, showForm, access, pageId, published]);

  // changes not published yet: the page as it would go online now vs. what was published
  useEffect(() => {
    const p = published;
    if (!p?.hash || access !== 'ready') return setStale(false);
    let alive = true;
    const t = setTimeout(
      async () => {
        try {
          const b = await latest.current.build(publishTarget(originOf(p.url), p.slug, p.domain, p.home));
          if (alive) setStale(buildHash(b.html, b.images) !== p.hash);
        } catch {
          if (alive) setStale(false);
        }
      },
      version === undefined ? 0 : 600,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [published, version, access]);

  const appOrigin = list?.appOrigin ?? (published ? originOf(published.url) : appOriginNow());
  const domains = list?.domains ?? [];
  const otherHome = domain && home ? list?.pages.find((p) => p.domain === domain && p.home && p.pageId !== pageId) : undefined;
  const domainInfo = (d?: string) => (d ? domains.find((x) => x.domain === d) : undefined);

  const startEditing = () => {
    setSlug(published?.slug ?? initialSlug());
    setDomain(published?.domain ?? '');
    setHome(!!published?.home);
    setError(null);
    setEditing(true);
  };

  /** Keep the listing in step after a publish (names in use, each domain's home page). */
  const remember = (next: Published) => {
    setList((l) => {
      if (!l) return l;
      const page: ServerPage = { pageId, kind, slug: next.slug, title, ...(next.domain ? { domain: next.domain } : {}), home: !!next.home, updatedAt: Date.now(), url: next.url, ...(next.domainUrl ? { domainUrl: next.domainUrl } : {}) };
      const pages = l.pages.filter((p) => p.pageId !== pageId).map((p) => (next.home && p.domain === next.domain && p.home ? { ...p, home: false } : p));
      return { ...l, pages: [...pages, page] };
    });
  };

  const publish = async (to: { slug: string; domain: string; home: boolean }) => {
    const before = latest.current.published;
    setBusy('publish');
    setError(null);
    setNotice(null);
    try {
      const target = publishTarget(appOrigin, to.slug, to.domain || null, to.home);
      const ready = await preparePublish(await latest.current.build(target), to.slug);
      const next = await publishPage({ pageId, kind, slug: to.slug, title, html: ready.html, images: ready.images, domain: to.domain || null, home: to.home, hash: ready.hash });
      latest.current.onChange(next);
      remember(next);
      setStale(false);
      setEditing(false);
      setTouched(false);
      const link = next.domainUrl ?? next.url;
      toast({
        kind: 'success',
        title: !before ? 'Your page is live' : before.slug !== next.slug || before.domain !== next.domain || !!before.home !== !!next.home ? 'Address changed' : 'Page updated',
        body: !before || before.slug === next.slug ? link : `It’s now at ${link}. The old address no longer works.`,
        action: { label: 'Copy link', run: () => void copyText(link) },
      });
    } catch (e) {
      if (e instanceof PublishError && e.code === 'SLUG_TAKEN') {
        availCache.current.set(to.slug, 'taken');
        setAvail('taken');
        if (!editing && before) setEditing(true);
      }
      setError((e as Error)?.message || 'Couldn’t publish. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const unpublish = async () => {
    if (!(await confirmAction({ title: 'Unpublish this page?', body: 'Its address stops working right away, on your domain too. You can publish it again later.', confirmLabel: 'Unpublish', danger: true }))) return;
    const before = latest.current.published;
    setBusy('unpublish');
    setError(null);
    try {
      await unpublishPage(pageId);
      // ready to publish again at the same address
      if (before) {
        setSlug(before.slug);
        setDomain(before.domain ?? '');
        setHome(!!before.home);
        setTouched(true);
      }
      latest.current.onChange(undefined);
      setList((l) => l && { ...l, pages: l.pages.filter((p) => p.pageId !== pageId) });
      setEditing(false);
      setStale(false);
      toast({ kind: 'success', title: 'Page unpublished', body: 'Its address no longer works.' });
    } catch (e) {
      setError((e as Error)?.message || 'Couldn’t unpublish. Try again.');
    } finally {
      setBusy(null);
    }
  };

  // ───────────── not available here ─────────────

  if (access !== 'ready') {
    return (
      <section className={cn('flex flex-col gap-2', className)} aria-label="Publish">
        <PanelTitle published={published} />
        {access === 'checking' ? (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Spinner size={14} /> Checking whether you can publish…
          </p>
        ) : (
          <p className="text-[13px] text-muted">
            {access === 'unavailable'
              ? 'Publishing at a public address isn’t available in this version of the app.'
              : access === 'unreachable'
                ? 'Couldn’t reach the app’s server, so publishing isn’t available right now.'
                : access === 'off'
                  ? 'Publishing isn’t set up on this app’s server yet. The app’s owner turns it on with accounts and the SUPABASE_SECRET_KEY Secret.'
                  : published
                    ? 'Sign in to update or unpublish this page.'
                    : 'Sign in to publish this page at its own address.'}
          </p>
        )}
        {published && access !== 'checking' && <Links published={published} />}
        {access === 'unreachable' && (
          <button type="button" className="btn btn-secondary btn-sm self-start" onClick={retry}>
            <RefreshCw size={14} /> Try again
          </button>
        )}
        {access === 'signed-out' && (
          <button type="button" className="btn btn-primary btn-sm self-start" onClick={showSignIn}>
            Sign in
          </button>
        )}
      </section>
    );
  }

  // ───────────── published ─────────────

  const working = !!busy;
  const domainOff = published?.domain ? domainInfo(published.domain) : undefined;

  return (
    <section className={cn('flex flex-col gap-3', className)} aria-label="Publish">
      <PanelTitle published={published} />
      {notice && (
        <p className="rounded-md border border-line bg-surface-2/60 px-3 py-2 text-[12.5px] text-ink-2" role="status">
          {notice}
        </p>
      )}
      {listError && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-bad" role="alert">
          <span className="min-w-0 flex-1">{listError}</span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => setLoads((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {published && !editing && (
        <>
          <Links published={published} />
          {domainOff && !domainOff.verified && (
            <p className="text-[12.5px] text-warn">
              {published.domain} isn’t reaching this app yet, so that address won’t open until it does.{' '}
              <button type="button" className="link" onClick={openDomainSettings}>
                Check it in Settings → Domains
              </button>
            </p>
          )}
          {stale && (
            <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-warn" role="status">
              <CircleAlert size={14} /> Changes not published yet.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={working} onClick={() => void publish({ slug: published.slug, domain: published.domain ?? '', home: !!published.home })}>
              {busy === 'publish' && <Spinner size={14} />} Update
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={working} onClick={startEditing}>
              Change address
            </button>
            <button type="button" className="btn btn-ghost btn-sm text-muted hover:text-bad" disabled={working} onClick={() => void unpublish()}>
              {busy === 'unpublish' && <Spinner size={14} />} Unpublish
            </button>
          </div>
          <p className="text-xs text-muted">Published {fmtRelative(published.publishedAt)}. Update sends your latest changes.</p>
        </>
      )}

      {/* ───────────── choosing the address ───────────── */}
      {showForm && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!working && (avail === 'ok' || avail === 'mine')) void publish({ slug: finalSlug, domain, home: !!domain && home });
          }}
        >
          <Field
            label="Address"
            htmlFor={`${ids}-slug`}
            hint={
              <span id={`${ids}-slug-check`} className={cn(AVAILABILITY[avail].tone === 'good' && 'text-good', AVAILABILITY[avail].tone === 'bad' && 'text-bad')} aria-live="polite">
                {AVAILABILITY[avail].text}
              </span>
            }
          >
            <div className="flex h-9 min-w-0 items-center rounded-md border border-line-2 bg-surface focus-within:border-primary focus-within:shadow-focus">
              <span className="max-w-[55%] shrink-0 truncate pl-3 text-[13px] text-muted" title={`${appOrigin}/`}>
                {hostOf(appOrigin)}/
              </span>
              <input
                id={`${ids}-slug`}
                className="h-full min-w-0 flex-1 bg-transparent pr-3 text-sm text-ink outline-none placeholder:text-faint"
                value={slug}
                placeholder="your-page-name"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={60}
                disabled={working}
                aria-describedby={`${ids}-slug-check`}
                aria-invalid={['taken', 'reserved', 'format'].includes(avail)}
                onChange={(e) => {
                  setTouched(true);
                  setSlug(typedSlug(e.target.value));
                }}
                onBlur={() => setSlug((s) => s.replace(/-+$/, ''))}
              />
            </div>
          </Field>

          {domains.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Field label="Also show it on your domain" htmlFor={`${ids}-domain`} right={<DomainsLink />}>
                <select id={`${ids}-domain`} className="select" value={domain} disabled={working} onChange={(e) => setDomain(e.target.value)}>
                  <option value="">No, only this app’s address</option>
                  {domains.map((d) => (
                    <option key={d.domain} value={d.domain}>
                      {d.domain}
                      {d.verified ? '' : ' (not reaching this app yet)'}
                    </option>
                  ))}
                </select>
              </Field>
              {domain && (
                <label className="flex items-start gap-2 text-[13px] text-ink-2">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--primary))]" checked={home} disabled={working} onChange={(e) => setHome(e.target.checked)} />
                  <span>
                    Make it this domain’s home page (https://{domain}/)
                    {otherHome && <span className="block text-xs text-muted">This replaces “{otherHome.title || otherHome.slug}” as its home page.</span>}
                  </span>
                </label>
              )}
            </div>
          ) : (
            list && (
              <p className="text-xs text-muted">
                Have your own domain? <DomainsLink label="Add it in Settings → Domains" />
              </p>
            )
          )}

          {finalSlug && isValidSlug(finalSlug) && (
            <p className="break-all text-xs text-muted">
              It will be at <span className="font-medium text-ink-2">{publishTarget(appOrigin, finalSlug).url}</span>
              {domain && (
                <>
                  {' '}
                  and <span className="font-medium text-ink-2">{publishTarget(appOrigin, finalSlug, domain, home).domainUrl}</span>
                </>
              )}
              .{published && finalSlug !== published.slug && ' The old address stops working right away.'}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={working || (!list && !listError) || !(avail === 'ok' || avail === 'mine' || avail === 'error')}>
              {busy === 'publish' && <Spinner size={14} />}
              {published ? 'Save new address' : 'Publish'}
            </button>
            {published && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={working} onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
            {busy === 'publish' && <span className="text-xs text-muted">Getting your page and images ready…</span>}
          </div>
        </form>
      )}

      {error && (
        <p className="text-[12.5px] text-bad" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function PanelTitle({ published }: { published?: Published }) {
  return (
    <div className="flex items-center gap-2">
      <Globe size={15} className="text-primary" aria-hidden="true" />
      <h3 className="text-[14px] font-semibold text-ink">Public page</h3>
      {published ? <span className="badge bg-good-soft text-good">Published</span> : <span className="badge bg-surface-2 text-muted">Not published</span>}
    </div>
  );
}

/** The page's address(es), each with Copy and Open. */
function Links({ published }: { published: Published }) {
  const links = [published.url, ...(published.domainUrl ? [published.domainUrl] : [])];
  return (
    <ul className="flex flex-col gap-1.5">
      {links.map((url) => (
        <li key={url} className="flex min-w-0 flex-wrap items-center gap-2">
          <a href={url} target="_blank" rel="noopener noreferrer" className="link min-w-0 flex-1 break-all text-[13px]">
            {url}
          </a>
          <span className="flex shrink-0 gap-1.5">
            <CopyButton text={url} size="xs" label="Copy" />
            <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-xs" aria-label={`Open ${url} in a new tab`}>
              <ExternalLink size={12} /> Open
            </a>
          </span>
        </li>
      ))}
    </ul>
  );
}

function DomainsLink({ label = 'Add a domain in Settings → Domains' }: { label?: string }) {
  return (
    <button type="button" className="link text-xs" onClick={openDomainSettings}>
      {label}
    </button>
  );
}
