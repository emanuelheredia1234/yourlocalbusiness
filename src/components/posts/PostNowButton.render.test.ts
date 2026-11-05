// The posting button and status in every state (rendered once, as on the server: no effects run): Post on
// <network> when the account is connected, Posting…, Posted with View post, Try again only after a definite
// failure, Check again (never Try again) when the app couldn't confirm it went out, Post it yourself when not
// connected, an older Manus post read-only, and "Post to groups" still there for Facebook. Then the confirm and
// Post it yourself windows, and the places that used to say "Post with Manus".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExternalPublish, Post, Project } from '@/lib/types';
import type { ConnectionStatus } from '@/lib/integrations/types';

// Rendered on the server, a zustand hook shows the store's first state: read the current one instead.
const live = <S>(store: { getState: () => S }) => Object.assign(<T>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
// every small window store (the confirm, Post it yourself) reads live too
vi.mock('zustand', async (original) => {
  const real = await original<typeof import('zustand')>();
  const wrap = (store: ReturnType<typeof real.create>) => live(store as unknown as { getState: () => unknown });
  const create = ((init?: unknown) => (init === undefined ? (i: unknown) => wrap((real.create as unknown as (x: unknown) => never)(i)) : wrap((real.create as unknown as (x: unknown) => never)(init)))) as typeof real.create;
  return { ...real, create };
});
// the Modal as plain sections (Radix renders nothing on the server)
vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, subtitle, children, footer }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), createElement('p', null, subtitle), children, createElement('footer', null, footer)),
}));
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore), useActiveProject: () => real.getActiveProject() };
});
vi.mock('@/store/analytics', async (original) => {
  const real = await original<typeof import('@/store/analytics')>();
  const useAnalytics = live(real.useAnalytics);
  return { ...real, useAnalytics, useConnections: () => {
    const s = real.useAnalytics.getState();
    const byPlatform: Record<string, ConnectionStatus> = {};
    for (const c of s.connections) byPlatform[c.platform] = c;
    return { byPlatform, enabled: s.connectionsEnabled, refresh: s.refreshConnections };
  } };
});
vi.mock('@/lib/platform', async (original) => {
  const real = await original<typeof import('@/lib/platform')>();
  return { ...real, useRuntime: live(real.useRuntime) };
});

const { useStore } = await import('@/store/useStore');
const { useAnalytics } = await import('@/store/analytics');
const { useRuntime, NO_AI_SERVER } = await import('@/lib/platform');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { PostNowButton, PublishStatus } = await import('./PostNowButton');
const { PostToGroupsButton } = await import('./ManusGroups');
const { PublishConfirmHost, usePublishConfirm } = await import('./PublishConfirm');
const { PostItYourselfHost, usePostItYourself } = await import('./PostItYourselfModal');
const { PostCard } = await import('./PostCard');
const { TooltipProvider } = await import('@/components/ui/shadcn/tooltip');

const PAGE = 'https://app.example/copper-kettle';
function project(): Project {
  const p = { ...newProject('business', 'existing'), id: 'p1', onboarded: true };
  p.brand = { ...p.brand, name: 'Copper Kettle' };
  p.marketing = { ...p.marketing, seoPublished: { slug: 'copper-kettle', url: PAGE, publishedAt: 1, hash: 'h' } };
  return p;
}
const post = (extra: Partial<Post> = {}): Post => ({
  id: 'post_1',
  projectId: 'p1',
  status: 'scheduled',
  platform: 'facebook',
  format: 'image',
  style: 'minimal',
  postType: 'sales',
  headline: 'Fresh bread',
  visualPrompt: '',
  caption: 'Fresh bread daily.',
  hashtags: ['#bread'],
  scheduledAt: '2099-11-10T10:00:00.000Z',
  watermark: false,
  source: 'composer',
  createdAt: 1,
  updatedAt: 1,
  seed: 1,
  ...extra,
});
const api = (state: ExternalPublish['state'], extra: Partial<ExternalPublish> = {}): ExternalPublish => ({ via: 'api', jobId: 'job_1', network: 'facebook', taskId: 'job_1', taskUrl: '', mode: 'now', state, message: '', page: '', scheduledFor: '', requestedAt: 1, checkedAt: 1, ...extra });
const manus = (state: ExternalPublish['state']): ExternalPublish => ({ via: 'manus', network: 'facebook', taskId: 't', taskUrl: 'https://manus.im/app/t', mode: 'now', state, message: 'Manus reports it posted.', page: 'Copper Kettle', scheduledFor: '', requestedAt: 1, checkedAt: 1 });

const connected = (platform: ConnectionStatus['platform'], extra: Partial<ConnectionStatus> = {}): ConnectionStatus => ({ platform, state: 'connected', targetLabel: 'Copper Kettle', targetKind: 'fb_page', ...extra });
function use(posts: Post[], connections: ConnectionStatus[] = []) {
  useStore.setState({ projects: [project()], activeProjectId: 'p1', posts, settings: defaultSettings() });
  useAnalytics.setState({ connections, connectionsEnabled: connections.length > 0 });
}
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const html = (el: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
const button = (p: Post, connections: ConnectionStatus[] = [], primary?: boolean) => {
  use([p], connections);
  return html(createElement(PostNowButton, { post: p, primary }));
};
const status = (p: Post, connections: ConnectionStatus[] = []) => {
  use([p], connections);
  return html(createElement(PublishStatus, { post: p }));
};

beforeEach(() => {
  useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { facebook: ['manus'] } } });
  usePublishConfirm.getState().close();
  usePostItYourself.getState().close();
});

describe('the posting button', () => {
  it('connected and not posted: “Post on Facebook”, filled when it’s the view’s one action', () => {
    const b = button(post(), [connected('facebook')], true);
    expect(words(b)).toContain('Post on Facebook');
    expect(b).toContain('btn-primary');
    expect(button(post(), [connected('facebook')])).toContain('btn-secondary');
    // limited but still posting (TikTok private until approved)
    expect(words(button(post({ platform: 'tiktok' }), [connected('tiktok', { state: 'limited', limitedReason: 'private_only' })]))).toContain('Post on TikTok');
  });

  it('not connected (or connected without posting rights): “Post it yourself”, never filled', () => {
    for (const c of [[], [connected('facebook', { state: 'needs_reconnect' })], [connected('facebook', { state: 'limited', limitedReason: 'no_page_role' })], [connected('instagram')]]) {
      const b = button(post(), c, true);
      expect(words(b)).toContain('Post it yourself');
      expect(b).not.toContain('btn-primary');
      expect(words(b)).not.toContain('Post on Facebook');
    }
  });

  it('sending: “Posting…”, disabled', () => {
    const b = button(post({ external: api('working') }), [connected('facebook')]);
    expect(words(b)).toContain('Posting…');
    expect(b).toContain('disabled');
  });

  it('posted by the app: “Posted” and “View post”', () => {
    const b = button(post({ status: 'published', publishedBy: 'api', postUrl: 'https://facebook.com/p/1', external: api('posted', { url: 'https://facebook.com/p/1' }) }), [connected('facebook')]);
    expect(words(b)).toContain('Posted');
    expect(words(b)).toContain('View post');
    expect(b).toContain('href="https://facebook.com/p/1"');
    expect(b).toContain('rel="noopener noreferrer"');
    // a post you marked yourself has no button here (its card says who marked it)
    expect(button(post({ status: 'published', publishedBy: 'manual' }), [connected('facebook')])).toBe('');
  });

  it('failed (nothing went out): “Try again” opens a new confirm when connected, else Post it yourself', () => {
    expect(words(button(post({ external: api('failed') }), [connected('facebook')]))).toContain('Try again');
    expect(words(button(post({ external: api('failed') }), []))).toContain('Post it yourself');
  });

  it('unknown (it may have gone out): “Check again”, and never “Try again”', () => {
    const b = button(post({ external: api('unknown') }), [connected('facebook')], true);
    expect(words(b)).toContain('Check again');
    expect(words(b)).not.toContain('Try again');
    expect(words(b)).not.toContain('Post on Facebook');
    // a LinkedIn member post has no automatic check: mark it posted
    const li = button(post({ platform: 'linkedin', external: api('unknown', { network: 'linkedin' }) }), [connected('linkedin', { targetKind: 'li_person', targetLabel: 'Joe' })]);
    expect(words(li)).toContain('Mark as posted');
    expect(words(li)).not.toContain('Check again');
    expect(words(li)).not.toContain('Try again');
  });

  it('an older post sent with Manus: read-only, only “Mark as posted”', () => {
    const b = button(post({ external: manus('scheduled') }), [connected('facebook')]);
    expect(words(b)).toContain('Mark as posted');
    expect(words(b)).not.toContain('Post on Facebook');
    expect(words(status(post({ external: manus('scheduled') })))).toContain('Sent with Manus earlier');
  });

  it('keeps “Post to groups” (Manus) on a Facebook post, and only there', () => {
    use([post()]);
    expect(words(html(createElement(PostToGroupsButton, { post: post() })))).toContain('Post to groups');
    expect(html(createElement(PostToGroupsButton, { post: post({ platform: 'instagram' }) }))).toBe('');
  });
});

describe('the post’s status', () => {
  it('unknown: what to check, Check again, Mark as posted and Post it yourself, and no Try again', () => {
    const s = words(status(post({ external: api('unknown') }), [connected('facebook')]));
    expect(s).toContain('We couldn’t confirm the Facebook post went out');
    expect(s).toContain('Check your Facebook Page before trying anything else.');
    expect(s).toContain('Check again');
    expect(s).toContain('Mark as posted');
    expect(s).toContain('Post it yourself');
    expect(s).not.toContain('Try again');
  });

  it('failed: the plain reason, Try again and Post it yourself', () => {
    const s = words(status(post({ external: api('failed', { message: 'Facebook refused the image format' }) }), [connected('facebook')]));
    expect(s).toContain('The Facebook post didn’t go out');
    expect(s).toContain('Facebook refused the image format Nothing was posted.');
    expect(s).toContain('Try again');
    expect(s).toContain('Post it yourself');
    // its reason is text, never markup
    expect(status(post({ external: api('failed', { message: '<img src=x onerror=alert(1)>' }) }))).not.toContain('<img src=x');
  });

  it('sending: Posting… ; posted: nothing extra on the card', () => {
    expect(words(status(post({ external: api('working') })))).toContain('Posting on Facebook…');
    expect(status(post({ status: 'published', publishedBy: 'api', external: api('posted') }))).toBe('');
  });
});

describe('the windows', () => {
  it('the confirm shows the account, exactly what goes out, the first comment and one filled button', () => {
    const p = post({ linkPlacement: 'comment', firstComment: `Order here: ${PAGE}` });
    use([p], [connected('facebook', { targetLabel: 'Joe’s Bakery' })]);
    usePublishConfirm.getState().open(p.id);
    const out = html(createElement(PublishConfirmHost));
    const w = words(out);
    expect(w).toContain('Post on Facebook');
    expect(w).toContain('It goes out once, right away, on Joe’s Bakery (Page).');
    expect(w).toContain('Fresh bread daily. #bread');
    expect(w).toContain(`First comment Order here: ${PAGE}`);
    expect(out.match(/btn-primary/g)).toHaveLength(1);
    expect(w).not.toMatch(/Nango|treg/);
  });

  it('the confirm: X’s link cost is behind an InfoTip; TikTok private posting is said plainly', () => {
    const x = post({ platform: 'x', caption: `Fresh bread ${PAGE}`, hashtags: [] });
    use([x], [connected('x', { targetKind: 'x_account', targetLabel: '@copper' })]);
    usePublishConfirm.getState().open(x.id);
    const w = words(html(createElement(PublishConfirmHost)));
    expect(w).toContain('Posts with links cost more on X.');
    const media = { id: 'm1', kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, createdAt: 1, thumb: '' } as Post['media'];
    const tt = post({ platform: 'tiktok', format: 'video', media });
    use([tt], [connected('tiktok', { state: 'limited', limitedReason: 'private_only', targetKind: 'tt_account', targetLabel: '@copper' })]);
    usePublishConfirm.getState().open(tt.id);
    expect(words(html(createElement(PublishConfirmHost)))).toContain('It goes out as private until TikTok approves this app.');
  });

  it('Post it yourself: copy, the network, Mark as posted, and the way to connect', () => {
    const p = post({ platform: 'instagram', linkPlacement: 'bio' });
    use([p]);
    usePostItYourself.getState().open(p.id);
    const out = html(createElement(PostItYourselfHost));
    const w = words(out);
    expect(w).toContain('Post it yourself on Instagram');
    expect(w).toContain('Copy text');
    expect(w).toContain('Open Instagram');
    expect(w).toContain('Mark as posted');
    expect(w).toContain('Connect Instagram to post from here');
    expect(w).toContain('Check that your Instagram bio has');
    expect(out.match(/btn-primary/g)).toHaveLength(1);
  });
});

describe('no “Post with Manus” left', () => {
  it('on a post card, in every state', () => {
    const states: Post[] = [post({ status: 'draft' }), post(), post({ external: api('working') }), post({ external: api('unknown') }), post({ external: api('failed') }), post({ status: 'published', publishedBy: 'api', external: api('posted') }), post({ external: manus('posted') })];
    for (const p of states) {
      for (const c of [[], [connected('facebook')]]) {
        use([p], c);
        const out = words(html(createElement(PostCard, { post: p, brand: project().brand })));
        expect(out).not.toMatch(/post with manus|manus posts|posted by manus|with manus\b(?! earlier)|send all .* to manus/i);
      }
    }
  });
});

describe('no “Post with Manus” on the pages that had it', () => {
  const MANUS_POSTING = /post with manus|manus posts|posted by manus|with manus\b(?! earlier)|to manus\b/i;
  const many = (): Post[] => [
    post({ id: 'due', scheduledAt: '2020-01-01T10:00:00.000Z' }),
    post({ id: 'due2', platform: 'instagram', scheduledAt: '2020-01-02T10:00:00.000Z' }),
    post({ id: 'next' }),
    post({ id: 'sending', external: api('working') }),
    post({ id: 'unknown', external: api('unknown') }),
    post({ id: 'done', status: 'published', publishedBy: 'api', publishedAt: '2026-11-01T10:00:00.000Z', external: api('posted') }),
    post({ id: 'old', status: 'published', publishedBy: 'manus', publishedAt: '2026-10-01T10:00:00.000Z', external: manus('posted') }),
  ];

  it('the calendar, the dashboard and Create post', async () => {
    const { default: ContentCalendar } = await import('@/pages/calendar/ContentCalendar');
    const { Dashboard } = await import('@/pages/dashboard/Dashboard');
    const { QuickComposer } = await import('@/pages/dashboard/QuickComposer');
    for (const c of [[], [connected('facebook'), connected('instagram', { targetKind: 'ig_account' })]]) {
      use(many(), c);
      const cal = words(html(createElement(ContentCalendar)));
      expect(cal).not.toMatch(MANUS_POSTING);
      // the due posts each have their own button, with no bulk send
      expect(cal).toContain('2 posts due');
      expect(cal).not.toMatch(/send all/i);
      expect(words(html(createElement(Dashboard)))).not.toMatch(MANUS_POSTING);
      expect(words(html(createElement(QuickComposer)))).not.toMatch(MANUS_POSTING);
    }
  });
});
