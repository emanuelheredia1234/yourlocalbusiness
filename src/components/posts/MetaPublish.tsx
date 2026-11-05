import { useEffect, useState } from 'react';
import type { Post } from '@/lib/types';
import { authHeaders } from '@/lib/cloud/auth';
import { postText } from '@/ai/manusPost';
import { useStore } from '@/store/useStore';
import { Modal, confirmAction } from '../ui/primitives';

const API = '/api/integrations/meta';
type MetaAccount = { id: string; name: string; kind: 'facebook_page' | 'instagram' };
type Job = { id: string; postId: string; status: string; publishedAt?: number; error?: string };

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers = new Headers(await authHeaders(path));
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Meta could not complete the request.');
  return result as T;
}

function localDateTime(iso: string) {
  const date = iso ? new Date(iso) : new Date(Date.now() + 60 * 60_000);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function MetaPublishButton({ post }: { post: Post }) {
  const updatePost = useStore((state) => state.updatePost);
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<MetaAccount[]>([]);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'now' | 'schedule'>(post.status === 'scheduled' ? 'schedule' : 'now');
  const [scheduleAt, setScheduleAt] = useState(localDateTime(post.scheduledAt));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const platform = post.platform === 'facebook' ? 'facebook_page' : 'instagram';
    async function loadAccounts() {
      setLoading(true);
      try {
        const result = await request<{ accounts: MetaAccount[] }>(`${API}/status`);
        if (!alive) return;
        const matching = (result.accounts || []).filter((account) => account.kind === platform);
        setAccounts(matching);
        setSelected((current) => matching.some((account) => account.id === current) ? current : matching[0]?.id || '');
        setError('');
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load connected social accounts.');
      } finally {
        if (alive) setLoading(false);
      }
    }
    void loadAccounts();
    return () => { alive = false; };
  }, [open, post.platform]);

  useEffect(() => {
    if (!open || post.status === 'published') return;
    let alive = true;
    const poll = async () => {
      try {
        const result = await request<{ jobs: Job[] }>(`${API}/jobs`);
        if (!alive) return;
        const job = (result.jobs || []).find((item) => item.postId === post.id);
        if (job?.status === 'published') {
          updatePost(post.id, { status: 'published', publishedAt: job.publishedAt ? new Date(job.publishedAt).toISOString() : new Date().toISOString(), publishedBy: 'meta' });
          setNotice('The scheduled post has been published.');
        } else if (job?.status === 'failed' || job?.status === 'uncertain') {
          setError(job.error || (job.status === 'uncertain' ? 'The result is uncertain. Check the social account before retrying.' : 'Meta could not publish the scheduled post.'));
        }
      } catch {
        // Keep the scheduled job in the app; the server remains responsible for publishing it.
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [open, post.id, post.status, updatePost]);

  if (post.platform !== 'facebook' && post.platform !== 'instagram') return null;

  async function submit() {
    const account = accounts.find((item) => item.id === selected);
    if (!account) {
      setError('Connect a matching Meta account in Settings → Social accounts first.');
      return;
    }
    const when = mode === 'schedule' ? new Date(scheduleAt) : null;
    if (mode === 'schedule' && (!when || !Number.isFinite(when.getTime()) || when.getTime() <= Date.now() + 30_000)) {
      setError('Choose a future time, at least 30 seconds from now.');
      return;
    }
    const text = postText(post).trim();
    if (!text) {
      setError('Add post text before publishing.');
      return;
    }
    const confirmed = await confirmAction({
      title: mode === 'schedule' ? 'Schedule this post with Meta?' : 'Publish this post with Meta?',
      body: `${post.platform === 'facebook' ? 'Facebook Page' : 'Instagram'}: ${account.name}\n\n${mode === 'schedule' && when ? `Publish at ${when.toLocaleString()}.\n\n` : 'Publish immediately.\n\n'}${text}`,
      confirmLabel: mode === 'schedule' ? 'Schedule post' : 'Publish now',
    });
    if (!confirmed) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ status: string }>(`${API}/publish`, 'POST', {
        postId: post.id,
        accountId: account.id,
        platform: post.platform === 'facebook' ? 'facebook_page' : 'instagram',
        caption: text,
        mediaId: post.media?.id || '',
        mediaKind: post.format,
        ...(when ? { scheduledAt: when.toISOString() } : {}),
      });
      if (result.status === 'published') {
        updatePost(post.id, { status: 'published', publishedAt: new Date().toISOString(), publishedBy: 'meta' });
        setNotice('Published to Meta.');
      } else {
        const scheduledIso = when?.toISOString() || new Date(Date.now() + 60_000).toISOString();
        updatePost(post.id, { status: 'scheduled', scheduledAt: scheduledIso });
        setNotice(`Scheduled for ${when?.toLocaleString() || 'the selected time'}. The app server will publish it when due.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Meta could not publish the post.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setOpen(true); setError(''); setNotice(''); }}>
        Publish directly
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        title={mode === 'schedule' ? 'Schedule with Meta' : 'Publish with Meta'}
        subtitle="Review the account, timing, and post text before confirming."
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={loading || busy || !selected} onClick={() => void submit()}>
              {busy ? 'Sending…' : mode === 'schedule' ? 'Review & schedule' : 'Review & publish'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700">{error}</p>}
          {notice && <p role="status" className="rounded-lg bg-primary/10 px-3 py-2 text-sm">{notice}</p>}
          <label className="field">
            <span className="field-label">Meta account</span>
            <select className="input" value={selected} disabled={loading || busy} onChange={(event) => setSelected(event.target.value)}>
              {accounts.length === 0 && <option value="">No connected account</option>}
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          </label>
          {loading && <p className="text-sm text-muted">Loading connected accounts…</p>}
          {!loading && accounts.length === 0 && <p className="text-sm text-muted">Connect a Facebook Page or Instagram professional account in Settings → Social accounts.</p>}
          <div className="flex gap-2" role="group" aria-label="Publish timing">
            <button type="button" className={`btn btn-sm ${mode === 'now' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('now')}>Publish now</button>
            <button type="button" className={`btn btn-sm ${mode === 'schedule' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('schedule')}>Schedule</button>
          </div>
          {mode === 'schedule' && (
            <label className="field">
              <span className="field-label">Publish time</span>
              <input className="input" type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} min={localDateTime(new Date(Date.now() + 60_000).toISOString())} />
              <span className="text-xs text-muted">Scheduled posts run through this app’s server. Keep the deployment running.</span>
            </label>
          )}
          <div className="rounded-lg border border-line bg-surface-2 p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Post preview</p>
            <p className="whitespace-pre-wrap break-words text-sm">{postText(post) || 'No post text yet.'}</p>
            {post.media && <p className="mt-2 text-xs text-muted">Attached {post.format}: {post.media.name}</p>}
          </div>
          <p className="text-xs text-muted">Instagram requires a publicly fetchable image or video at publish time. This app creates a short-lived signed media URL; it does not make your media bucket public.</p>
        </div>
      </Modal>
    </>
  );
}
