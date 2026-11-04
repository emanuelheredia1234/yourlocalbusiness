// What a post shows about its link (rendered once, as on the server: no effects run): the first comment to
// add, with Copy and what Manus did with it, or the link to keep in the bio; the editor's "Where the link
// goes"; and Campaign setup's "Where the link goes" card with the suggested defaults.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExternalPublish, Post, Project } from '@/lib/types';

// Rendered on the server, a zustand hook shows the store's first state: read the current one instead.
const live = <S>(store: { getState: () => S }) => Object.assign(<T>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore), useActiveProject: () => real.getActiveProject() };
});

const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { LinkFields, PostLinkNote } = await import('./PostLinkNote');
const { LinkPlacementCard } = await import('@/pages/marketing/social/LinkPlacementCard');

const PAGE = 'https://app.example/copper-kettle';

function project(o: { marketing?: Partial<Project['marketing']>; website?: string; published?: boolean } = {}): Project {
  const p = { ...newProject('business', 'existing'), id: 'p1', onboarded: true };
  p.brand = { ...p.brand, name: 'Copper Kettle', websiteUrl: o.website ?? '' };
  p.marketing = { ...p.marketing, ...(o.published === false ? {} : { seoPublished: { slug: 'copper-kettle', url: PAGE, publishedAt: 1, hash: 'h' } }), ...o.marketing };
  return p;
}

const post = (extra: Partial<Post> = {}): Post => ({
  id: 'post_1',
  projectId: 'p1',
  status: 'draft',
  platform: 'facebook',
  format: 'image',
  style: 'minimal',
  postType: 'sales',
  headline: 'Fresh bread',
  visualPrompt: '',
  caption: 'Fresh bread daily.\n\nOrder at the link in the first comment',
  hashtags: ['#bread'],
  scheduledAt: '2026-11-10T10:00:00.000Z',
  watermark: false,
  source: 'composer',
  createdAt: 1,
  updatedAt: 1,
  seed: 1,
  linkPlacement: 'comment',
  firstComment: `Book here: ${PAGE}`,
  ...extra,
});

const manus = (o: Partial<ExternalPublish> = {}): ExternalPublish => ({ via: 'manus', network: 'facebook', taskId: 't', taskUrl: 'https://manus.im/app/t', mode: 'now', state: 'working', message: '', page: 'Copper Kettle', scheduledFor: '', requestedAt: 1, checkedAt: 1, ...o });

const use = (proj: Project, posts: Post[] = []) => useStore.setState({ projects: [proj], activeProjectId: proj.id, posts, settings: defaultSettings() });
/** What a reader sees: the markup without its tags. */
const words = (html: string) => html.replace(/<[^>]+>/g, '');
const note = (p: Post, proj = project()) => {
  use(proj, [p]);
  return renderToStaticMarkup(createElement(PostLinkNote, { post: p }));
};

describe('the first comment on a post card', () => {
  it('shows the comment to add, with Copy, when you post it yourself', () => {
    const html = note(post());
    expect(html).toContain('aria-label="Add this as the first comment"');
    expect(html).toContain('Add this as the first comment</p>');
    expect(html).toContain(`Book here: ${PAGE}`);
    expect(html).toContain('Add this as the first comment when you post.');
    expect(html).toContain('Copy comment');
    expect(note(post({ status: 'published', publishedBy: 'manual' }))).toContain('If it isn’t there yet, add this as the first comment.');
  });

  it('follows what Manus did with it', () => {
    const asked = note(post({ external: manus({ comment: { state: 'asked' } }) }));
    expect(asked).toContain('First comment</p>');
    expect(asked).toContain('Manus adds it right after posting.');
    const added = note(post({ status: 'published', publishedBy: 'manus', external: manus({ state: 'posted', comment: { state: 'added' } }) }));
    expect(added).toContain('First comment</p>');
    expect(added).toContain('Manus added it.');
    expect(note(post({ external: manus({ state: 'posted', comment: { state: 'unknown' } }) }))).toContain('Check that it’s on Facebook. If not, add it yourself.');
    expect(note(post({ external: manus({ mode: 'schedule', state: 'scheduled' }) }))).toContain('Manus only schedules the post. Once it’s live, add this as the first comment.');
    // a failed try never got to the comment
    expect(note(post({ external: manus({ state: 'failed', comment: { state: 'asked' } }) }))).toContain('Add this as the first comment when you post.');
  });

  it('shows Manus’s reason as text, clipped, when it couldn’t add it', () => {
    const html = note(post({ status: 'published', external: manus({ state: 'posted', comment: { state: 'failed', detail: `Comments are off <script>alert(1)</script> ${'x'.repeat(200)}` } }) }));
    expect(html).toContain('Manus couldn’t add it (Comments are off &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('…). Add it yourself.');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Add this as the first comment</p>');
  });

  it('says “reply” on X', () => {
    const html = note(post({ platform: 'x' }));
    expect(html).toContain('Add this as the first reply');
    expect(html).toContain('Copy reply');
    expect(note(post({ platform: 'x', external: manus({ network: 'x', state: 'posted', comment: { state: 'added' } }) }))).toContain('First reply</p>');
  });

  it('leaves the text out in a compact list row, and shows nothing without a comment', () => {
    use(project(), [post()]);
    const compact = renderToStaticMarkup(createElement(PostLinkNote, { post: post(), compact: true }));
    expect(compact).toContain('Copy comment');
    expect(compact).not.toContain('Book here:');
    expect(note(post({ firstComment: '   ' }))).toBe('');
  });
});

describe('the bio reminder', () => {
  it('says to keep the link in that network’s bio, with Copy', () => {
    const html = note(post({ platform: 'instagram', linkPlacement: 'bio', firstComment: undefined }));
    expect(html).toContain('aria-label="Link in bio"');
    expect(words(html)).toContain(`Link in bio: keep ${PAGE} in your Instagram bio.`);
    expect(html).toContain('Copy link');
    // an older Instagram post (no placement) was written for the bio
    expect(note(post({ platform: 'instagram', linkPlacement: undefined, firstComment: undefined }))).toContain('in your Instagram bio.');
    // a domain's home page shows bare
    expect(words(note(post({ platform: 'tiktok', linkPlacement: 'bio' }), project({ marketing: { seoPublished: { slug: 'k', url: PAGE, domainUrl: 'https://copperkettle.com/', publishedAt: 1, hash: 'h' } } })))).toContain('keep copperkettle.com in your TikTok bio.');
    // nothing to keep in a bio without a link
    expect(note(post({ platform: 'instagram', linkPlacement: 'bio' }), project({ published: false }))).toBe('');
  });

  it('shows nothing when the link is in the post', () => {
    expect(note(post({ linkPlacement: 'post' }))).toBe('');
    // an older Facebook post: its link was in the post
    expect(note(post({ linkPlacement: undefined }))).toBe('');
  });
});

describe('the editor’s “Where the link goes”', () => {
  const fields = (p: Post, proj = project()) => {
    use(proj, [p]);
    return renderToStaticMarkup(createElement(LinkFields, { post: p, onChange: () => {} }));
  };

  it('offers the three places, with the first comment’s text when the link goes there', () => {
    const html = fields(post());
    expect(html).toContain('<label for="lp-post_1" class="label">Where the link goes</label>');
    expect(html).toMatch(/<option value="post">In the post<\/option><option value="comment" selected="">First comment<\/option><option value="bio">Bio<\/option>/);
    expect(words(html)).toContain('Links in Facebook posts and comments can be clicked. Your link: https://app.example/copper-kettle');
    expect(html).toContain('<label for="fc-post_1" class="label">First comment</label>');
    expect(html).toContain('When Manus posts it right away, it adds this too. Otherwise, add it yourself after posting.');
    expect(html).toContain(`>Book here: ${PAGE}</textarea>`);
    expect(fields(post({ linkPlacement: 'bio' }))).not.toContain('fc-post_1');
  });

  it('calls it the first reply on X, and waits for a link before it can change', () => {
    expect(fields(post({ platform: 'x' }))).toContain('<option value="comment" selected="">First reply</option>');
    const none = fields(post({ linkPlacement: undefined, firstComment: undefined }), project({ published: false }));
    expect(none).toMatch(/<select id="lp-post_1" class="select" disabled="">/);
    expect(none).toContain('No link yet: publish your page (Marketing → SEO page), or add your website in Settings → Brand.');
  });
});

describe('Campaign setup’s “Where the link goes” card', () => {
  const card = (proj: Project) => {
    use(proj);
    return renderToStaticMarkup(createElement(LinkPlacementCard, { project: proj }));
  };

  it('suggests the defaults, calls X’s comment a reply, and lists the campaign’s networks first', () => {
    const html = card(project());
    expect(html).toContain('Where the link goes</h2>');
    expect(html).toContain('New posts put your link in the post, in the first comment (a reply on X), or say it’s in your bio.');
    expect(html).toContain('<option value="bio" selected="">Bio (suggested)</option>');
    expect(html).toContain('<option value="post" selected="">In the post (suggested)</option>');
    expect(html).toContain('<option value="comment">First reply</option>');
    expect(html).toContain('aria-label="Where the link goes on Instagram"');
    expect(html).toContain('Keep your link in your bio there: the app never changes your profile.');
    // the default campaign posts on Instagram and Facebook; the others come after, marked
    expect(html.indexOf('on Instagram"')).toBeLessThan(html.indexOf('on TikTok"'));
    expect(html.indexOf('on Facebook"')).toBeLessThan(html.indexOf('on TikTok"'));
    expect(html.match(/\(not in this campaign\)/g)).toHaveLength(3);
    expect(words(html)).toContain('Your posts link to your page: https://app.example/copper-kettle.');
    expect(html).toContain('Copy link');
    expect(html).not.toContain('Use the suggestions');
  });

  it('offers the suggestions back once a choice differs', () => {
    const html = card(project({ marketing: { linkPlacement: { facebook: 'comment' } } }));
    expect(html).toContain('<option value="comment" selected="">First comment</option>');
    expect(html).toContain('Use the suggestions');
  });

  it('says where to get a link when there’s none, and when it’s only the website', () => {
    const none = card(project({ published: false }));
    expect(none).toContain('No link in your posts yet. Publish your SEO page, or add your website in Settings → Brand.');
    expect(none).toContain('Open the SEO page builder');
    const site = card(project({ published: false, website: 'copperkettle.co' }));
    expect(words(site)).toContain('Your posts link to your website: copperkettle.co. Publish your page to link to it instead.');
  });
});
