// Posting from the app: the confirm window's read-only preview per network, the request one confirm sends, and
// following a job (GET only: never a check, never a resend).
import { describe, expect, it, vi } from 'vitest';
import type { Post, Project } from '@/lib/types';
import type { PublishJob } from '@/lib/integrations/types';
import { newProject } from '@/store/defaults';
import { apiHolds, buildPublishRequest, canPostFrom, captionPreview, failureCopy, followJob, hasXLink, legacyManus, newClientRequestId, targetText } from './posting';

const PAGE = 'https://app.example/copper-kettle';
const project = (): Project => {
  const p = { ...newProject('business', 'existing'), id: 'p1' };
  p.marketing = { ...p.marketing, seoPublished: { slug: 'copper-kettle', url: PAGE, publishedAt: 1, hash: 'h' } };
  return p;
};
const post = (extra: Partial<Post> = {}): Post =>
  ({ id: 'post_1', projectId: 'p1', status: 'scheduled', platform: 'facebook', format: 'image', style: 'minimal', postType: 'tip', headline: 'Fresh bread', visualPrompt: '', caption: 'Fresh bread daily.', hashtags: ['#bread'], scheduledAt: '2026-11-10T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...extra }) as Post;
const image = { id: 'media_1', kind: 'image', name: 'a.png', mime: 'image/png', size: 1, createdAt: 1, thumb: '' } as Post['media'];

describe('whether the app can post on an account', () => {
  it('posts on connected accounts, and on limited ones that still post', () => {
    expect(canPostFrom(undefined)).toBe(false);
    expect(canPostFrom({ platform: 'facebook', state: 'not_connected' })).toBe(false);
    expect(canPostFrom({ platform: 'facebook', state: 'pending' })).toBe(false);
    expect(canPostFrom({ platform: 'facebook', state: 'needs_reconnect' })).toBe(false);
    expect(canPostFrom({ platform: 'facebook', state: 'connected' })).toBe(true);
    expect(canPostFrom({ platform: 'tiktok', state: 'limited', limitedReason: 'private_only' })).toBe(true);
    expect(canPostFrom({ platform: 'instagram', state: 'limited', limitedReason: 'insights_unavailable' })).toBe(true);
    expect(canPostFrom({ platform: 'facebook', state: 'limited', limitedReason: 'no_page_role' })).toBe(false);
    expect(canPostFrom({ platform: 'facebook', state: 'limited', limitedReason: 'missing_permissions' })).toBe(false);
  });

  it('names the account it posts on', () => {
    expect(targetText({ platform: 'facebook', state: 'connected', targetLabel: 'Joe’s Bakery', targetKind: 'fb_page' }, 'facebook')).toBe('Joe’s Bakery (Page)');
    expect(targetText({ platform: 'x', state: 'connected', targetLabel: '@joes', targetKind: 'x_account' }, 'x')).toBe('@joes');
    expect(targetText(undefined, 'x')).toBe('your X account');
  });
});

describe('what each network gets (read-only preview)', () => {
  it('Facebook: the caption, then the hashtags; the link comment goes on after posting', () => {
    const p = captionPreview(post({ linkPlacement: 'comment', firstComment: `Order here: ${PAGE}` }), project());
    expect(p.text).toBe('Fresh bread daily.\n\n#bread');
    expect(p.firstComment).toBe(`Order here: ${PAGE}`);
    expect(p.linkNote).toBe('The link goes in the first comment.');
    expect(p.blockers).toEqual([]);
  });

  it('Instagram: at most 30 hashtags, needs an image, the bio link is the owner’s', () => {
    const tags = Array.from({ length: 33 }, (_, i) => `#t${i}`);
    const p = captionPreview(post({ platform: 'instagram', hashtags: tags, linkPlacement: 'bio', media: image }), project());
    expect(p.droppedTags).toBe(3);
    expect(p.text.match(/#t\d+/g)).toHaveLength(30);
    expect(p.linkNote).toMatch(/stays in your Instagram bio/);
    expect(captionPreview(post({ platform: 'instagram' }), project()).blockers).toEqual(['Instagram needs an image or a video. Add one first.']);
  });

  it('X: hashtags only when they fit in 280 (a link counts 23, a line break 2), the comment is a reply, links cost more', () => {
    // 246 + 1 + 23 = 270; "\n\n#one" makes 278, " #two" would make 283
    const caption = `${'a'.repeat(246)} ${PAGE}`;
    const p = captionPreview(post({ platform: 'x', caption, hashtags: ['#one', '#two'] }), project());
    expect(p.droppedTags).toBe(1);
    expect(p.text).toBe(`${caption}\n\n#one`);
    expect(p.xLinkCost).toBe(true);
    expect(captionPreview(post({ platform: 'x', caption: 'No link here', hashtags: [] }), project()).xLinkCost).toBe(false);
  });

  it('X: a bare address such as mybiz.com is a link too, exactly as the server counts it (never an email, a hashtag or a price)', async () => {
    const server = (await import('../../server/connections/uploadpost.mjs' as string)) as { hasXLink: (t: string) => boolean };
    const cases = ['Order at mybiz.com', 'Visit MyBiz.COM/order', 'www.joesbakery', 'https://joes.example', 'joes-bakery.co.uk/menu', '(mybiz.com)', 'mybiz.de/menu', 'No link today', 'joe@mybiz.com', '#mybiz.com', '$3.50 a loaf', 'e.g. this', 'Open 9a.m.-5p.m.', 'file.txt', 'St.Louis', 'Great deals.Go now', 'see you at 5.Be there', 'Thanks.So happy', 'Hi.My name is Joe'];
    for (const t of cases) expect([t, hasXLink(t)]).toEqual([t, server.hasXLink(t)]);
    expect(cases.filter(hasXLink)).toEqual(cases.slice(0, 7));
    expect(captionPreview(post({ platform: 'x', caption: 'Order at joesbakery.com today', hashtags: [] }), project()).xLinkCost).toBe(true);
    expect(captionPreview(post({ platform: 'x', caption: 'Email joe@joesbakery.com', hashtags: [] }), project()).xLinkCost).toBe(false);
  });

  it('TikTok: no first comment through the app, and it needs media', () => {
    const p = captionPreview(post({ platform: 'tiktok', linkPlacement: 'comment', firstComment: 'Book here', media: image }), project());
    expect(p.firstComment).toBeUndefined();
    expect(p.commentYourself).toBe('Add your first comment in TikTok once it’s live.');
    expect(captionPreview(post({ platform: 'tiktok' }), project()).blockers).toHaveLength(1);
  });

  it('refuses a storyboard video', () => {
    expect(captionPreview(post({ format: 'video' }), project()).blockers).toEqual(['Make or add the video first: a storyboard can’t be posted.']);
  });
});

describe('the request one confirm sends', () => {
  it('carries the saved post, the link and where it goes, the file, and the confirm', () => {
    const r = buildPublishRequest(post({ platform: 'instagram', linkPlacement: 'comment', firstComment: 'Here', media: image }), project(), { clientRequestId: 'req-1', mediaIds: ['media_1-jpg'] });
    expect(r).toEqual({
      projectId: 'p1',
      postId: 'post_1',
      platform: 'instagram',
      confirm: true,
      clientRequestId: 'req-1',
      content: { text: 'Fresh bread daily.', hashtags: ['#bread'], link: PAGE, linkPlacement: 'first_comment', firstComment: 'Here', mediaIds: ['media_1-jpg'] },
    });
    const none = { ...project(), marketing: { ...project().marketing, seoPublished: undefined } };
    expect(buildPublishRequest(post(), none, { clientRequestId: 'req-2' }).content).toEqual({ text: 'Fresh bread daily.', hashtags: ['#bread'], linkPlacement: 'none' });
    expect(buildPublishRequest(post({ platform: 'tiktok', media: image }), project(), { clientRequestId: 'r' }).content.title).toBe('Fresh bread');
  });

  it('a new id for every confirm', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newClientRequestId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('following a job', () => {
  const job = (state: PublishJob['state'], extra: Partial<PublishJob> = {}): PublishJob => ({ id: 'job_1', postId: 'post_1', platform: 'facebook', state, requestedAt: '2026-11-05T10:00:00.000Z', ...extra });

  it('reads until it’s no longer sending, then stops: reads only', async () => {
    const answers = [job('queued'), job('sending'), job('sent', { url: 'https://facebook.com/1' })];
    const read = vi.fn(async () => ({ job: answers.shift()! }));
    const seen: string[] = [];
    const last = await followJob('job_1', { intervalMs: 1, maxMs: 1000, read, onUpdate: (j) => seen.push(j.state) });
    expect(last?.state).toBe('sent');
    expect(seen).toEqual(['queued', 'sending', 'sent']);
    expect(read).toHaveBeenCalledTimes(3);
    expect((read.mock.calls as unknown as string[][]).every(([id]) => id === 'job_1')).toBe(true);
  });

  it('gives up after its time, and skips a failed read', async () => {
    let n = 0;
    const read = vi.fn(async () => {
      if (n++ === 0) throw new Error('offline');
      return { job: job('sending') };
    });
    const last = await followJob('job_1', { intervalMs: 5, maxMs: 30, read });
    expect(last?.state).toBe('sending');
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(read.mock.calls.length).toBeLessThan(10);
  });

  it('stops when asked', async () => {
    const ac = new AbortController();
    const read = vi.fn(async () => {
      ac.abort();
      return { job: job('sending') };
    });
    await followJob('job_1', { intervalMs: 50, maxMs: 10_000, read, signal: ac.signal });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('a post’s state', () => {
  it('holds a post the app is sending or couldn’t confirm; an older Manus post is read-only', () => {
    const ext = (via: 'api' | 'manus', state: NonNullable<Post['external']>['state']) => ({ via, network: 'facebook' as const, taskId: 't', taskUrl: '', state, message: '', page: '', scheduledFor: '', requestedAt: 1, checkedAt: 1 });
    expect(apiHolds(post({ external: ext('api', 'working') }))).toBe(true);
    expect(apiHolds(post({ external: ext('api', 'unknown') }))).toBe(true);
    expect(apiHolds(post({ external: ext('api', 'failed') }))).toBe(false);
    expect(apiHolds(post({ external: ext('manus', 'working') }))).toBe(false);
    expect(legacyManus(post({ external: ext('manus', 'posted') }))).toBe(true);
    expect(failureCopy({ errorCode: 'MEDIA_UNSUPPORTED' }, 'facebook')).toBe('Facebook refused the image or video format.');
    expect(failureCopy({}, 'x')).toBe('X didn’t take the post.');
    expect(failureCopy({ errorCode: 'UNCONFIRMED' }, 'instagram')).toBe('It may have been posted - check before trying again.');
    expect(failureCopy({ errorCode: 'DUPLICATE' }, 'linkedin')).toContain('the same as a recent post on LinkedIn');
    expect(failureCopy({ errorCode: 'SERVICE_UNAVAILABLE' }, 'x')).not.toMatch(/upload-post|zernio|plan|balance/i);
  });
});
