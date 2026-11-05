// "Post it yourself": everything to post it by hand on the network (the text to copy, the first comment, the
// image or video to download, a link to the network), then "Mark as posted" so your calendar shows what's out.
import { create } from 'zustand';
import { CheckCheck, Download, ExternalLink } from 'lucide-react';
import { networkLabel, NETWORKS, postText } from '@/ai/postShared';
import { firstCommentOf, linkText, pageLink, postPlacement } from '@/lib/pageLink';
import { navigate } from '@/lib/router';
import { useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { CopyButton, Modal } from '../ui/primitives';
import { downloadPostMedia, useMarkPosted } from './PostActions';
import { PlatformChip } from './PlatformIcon';

export const usePostItYourself = create<{ id: string | null; open: (id: string) => void; close: () => void }>((set) => ({
  id: null,
  open: (id) => set({ id }),
  close: () => set({ id: null }),
}));

/** Settings › Connected accounts. */
export function openConnectedAccounts() {
  useUI.getState().setSettingsTab('accounts');
  navigate('workspace-settings');
}

export function PostItYourselfHost() {
  const id = usePostItYourself((s) => s.id);
  const close = usePostItYourself((s) => s.close);
  const post = useStore((s) => s.posts.find((p) => p.id === id));
  const project = useStore((s) => s.projects.find((p) => p.id === post?.projectId));
  if (!id || !post) return null;
  const network = networkLabel(post.platform);
  const text = postText(post);
  const comment = firstCommentOf(post);
  const word = post.platform === 'x' ? 'reply' : 'comment';
  const bio = project && postPlacement(post) === 'bio' ? pageLink(project) : null;
  const mark = () => {
    close();
    useMarkPosted.getState().open(post.id);
  };
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={`Post it yourself on ${network}`}
      subtitle="Copy the text, add the file, post it, then mark it as posted here."
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
            Close
          </button>
          {post.status !== 'published' && (
            <button type="button" className="btn btn-primary btn-sm" onClick={mark}>
              <CheckCheck aria-hidden="true" /> Mark as posted
            </button>
          )}
        </>
      }
    >
      <ol className="flex flex-col gap-4">
        <li className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-small font-medium text-ink">1. Copy the text</p>
            <CopyButton text={text} label="Copy text" size="xs" />
          </div>
          <p className="max-h-48 overflow-y-auto whitespace-pre-line break-words rounded-md border border-line bg-surface-2 px-3 py-2.5 text-small text-ink-2">{text}</p>
        </li>
        {post.media && (
          <li className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-small font-medium text-ink">2. Add the {post.media.kind}</p>
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => void downloadPostMedia(post)}>
              <Download aria-hidden="true" /> Download the {post.media.kind}
            </button>
          </li>
        )}
        <li className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-small font-medium text-ink">
            {post.media ? '3.' : '2.'} Post it on <PlatformChip platform={post.platform} />
          </p>
          <a href={NETWORKS[post.platform].home} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-xs">
            Open {network} <ExternalLink aria-hidden="true" />
          </a>
        </li>
        {comment && (
          <li className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-small font-medium text-ink">Then add the first {word}</p>
              <CopyButton text={comment} label={`Copy ${word}`} size="xs" />
            </div>
            <p className="whitespace-pre-line break-words text-small text-ink-2">{comment}</p>
          </li>
        )}
        {bio && (
          <li className="flex flex-wrap items-center justify-between gap-2 text-small text-muted">
            <span className="min-w-0">
              Check that your {network} bio has <span className="[overflow-wrap:anywhere]">{linkText(bio.url)}</span>.
            </span>
            <CopyButton text={bio.url} label="Copy link" size="xs" />
          </li>
        )}
      </ol>
      {!__ARTIFACT_BUILD__ && (
        <p className="mt-5 border-t border-line pt-3 text-small text-muted">
          <button
            type="button"
            className="link"
            onClick={() => {
              close();
              openConnectedAccounts();
            }}
          >
            Connect {network} to post from here
          </button>
        </p>
      )}
    </Modal>
  );
}
