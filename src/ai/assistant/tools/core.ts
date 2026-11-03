// The assistant's own tools: reading the workspace, help, and moving around the app (pages, posts,
// the composer, projects) plus a few preferences. The groups (social, studio, marketing, brand) add
// the rest in their own files.

import type { AppSettings } from '@/lib/types';
import { fmtRelative, toDateStr } from '@/lib/utils';
import { useRuntime } from '@/lib/platform';
import { readiness } from '@/lib/readiness';
import { POST_PLATFORMS } from '@/ai/knowledge';
import { useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { serverFetch } from '../../claude';
import { AI_FUNCTIONS, routeFor } from '../../functions';
import { HELP_TOPICS, HELP_TOPIC_IDS } from '../guide';
import { host } from '../host';
import { activeProject, findPost, missingPost, postSummary, postWhen, projectPosts } from '../lookup';
import { OPENABLE_ROUTES, pageName, switchProject, tabProblem } from '../nav';
import { arg, clip, defineTool, untrusted, type AnyTool } from '../registry';
import { aiSummary, isDueNow, projectList, workspaceSummary } from '../workspace';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const getWorkspace = defineTool({
  name: 'get_workspace',
  class: 'R',
  summary: 'The workspace now: the active project, post counts (due, planned, drafts, posted) with a few post ids, each channel’s state, launch readiness and what the AI here can do.',
  args: {},
  run: () => ({ data: workspaceSummary(), note: 'Looked at your workspace' }),
});

const listProjects = defineTool({
  name: 'list_projects',
  class: 'R',
  summary: 'All projects on this account: id, name, track, which is active, whether it’s set up.',
  args: {},
  run: () => ({ data: projectList(), note: 'Looked at your projects' }),
});

const SECTIONS = ['overview', 'brand', 'offer', 'listing', 'social', 'email', 'seo', 'ads'] as const;

const getProject = defineTool({
  name: 'get_project',
  class: 'R',
  summary: 'One part of the active project in more detail: overview, brand, offer (product, outline or packages, price), listing, social (campaign setup and plan), email, seo or ads.',
  args: { section: arg.enum(SECTIONS) },
  run: ({ section }) => {
    const p = activeProject();
    const s = useStore.getState();
    const b = p.brand;
    const m = p.marketing;
    const st = p.studio;
    let data: unknown;
    switch (section) {
      case 'overview':
        data = { ...workspaceSummary()?.project, description: clip(p.summary, 400) || undefined, origin: p.origin, onboarded: p.onboarded };
        break;
      case 'brand':
        data = { name: b.name, tagline: b.tagline, pitch: clip(b.pitch, 400), valueProp: clip(b.valueProp, 300), audience: clip(b.audience, 200), personality: b.personality, mission: clip(b.mission, 300), website: b.websiteUrl || null, colors: b.colors, socials: b.socials, learnsVoiceFrom: Object.entries(b.voiceFrom ?? {}).filter(([, v]) => v?.learn).map(([k]) => k) };
        break;
      case 'offer':
        data = {
          product: p.idea ? { title: p.idea.title, hook: clip(p.idea.hook, 200), audience: clip(p.idea.audience, 160), features: p.idea.features.slice(0, 8) } : null,
          price: st.price || null,
          priceModel: st.priceModel,
          compareAt: st.compareAt || null,
          outline: st.outline.map((x) => ({ id: x.id, title: x.title, items: x.items.length, drafted: !!x.draft })),
          packages: st.packages.map((x) => ({ id: x.id, name: x.name, price: x.price, priceModel: x.priceModel, includes: x.includes.slice(0, 6) })),
          codeAssets: st.codeAssets.map((x) => ({ id: x.id, name: x.name, kind: x.kind, published: x.published?.url ?? null })),
          productFiles: (st.productFiles ?? []).map((f) => ({ id: f.id, kind: f.kind, name: f.name })),
        };
        break;
      case 'listing': {
        const l = st.listing;
        data = { title: l.title, tagline: l.tagline, description: clip(l.description, 600), category: l.category, tags: l.tags, bookingType: l.bookingType, buyUrl: l.buyUrl || null, contactEmail: l.contactEmail || null, phone: l.phone || null, hours: l.hours || null, onMarketplace: s.myListings.some((x) => x.projectId === p.id), images: { cover: !!l.coverImageId, gallery: l.galleryIds?.length ?? 0, demoVideo: !!l.demoVideo } };
        break;
      }
      case 'social': {
        const c = m.campaign;
        data = {
          setup: { days: c.days, postsPerDay: c.postsPerDay, videosPerDay: c.videosPerDay, platforms: c.platforms, imageStyles: c.imageStyles, videoStyles: c.videoStyles, postTypes: c.postTypes, startDate: c.startDate, times: c.times, goal: c.goal, watermark: c.watermark },
          plan: m.plan ? { startDate: m.plan.startDate, total: m.plan.summary.total, strategy: clip(m.plan.strategy, 300), weeks: m.plan.weeks.map((w) => ({ week: w.week, theme: w.theme })) } : null,
          facebookGroups: m.facebookGroups ?? [],
        };
        break;
      }
      case 'email':
        data = { leadMagnet: m.leadMagnet ? { type: m.leadMagnet.type, title: m.leadMagnet.title, sections: m.leadMagnet.sections.length } : null, emails: m.emails.map((e) => ({ id: e.id, index: e.index, subject: e.subject, delay: e.delay })), subscribers: m.subscribers.length };
        break;
      case 'seo':
        data = { meta: m.seo ? { title: m.seo.metaTitle, description: m.seo.metaDescription, primaryKeyword: m.seo.primaryKeyword, slug: m.seo.slug } : null, salesPage: m.salesPage ? m.salesPage.sections.map((x) => ({ id: x.id, type: x.type, visible: x.visible })) : null, published: m.seoPublished?.url ?? null };
        break;
      case 'ads':
        data = s.ads.filter((a) => a.projectId === p.id).map((a) => ({ id: a.id, name: a.name, objective: a.objective, platforms: a.platforms, dailyBudget: a.dailyBudget, durationDays: a.durationDays, startDate: a.startDate, creatives: a.creatives.length, searchAds: !!a.search }));
        break;
    }
    return { data, note: `Read your project’s ${section === 'seo' ? 'SEO page' : section}` };
  },
});

const listPosts = defineTool({
  name: 'list_posts',
  class: 'R',
  summary: 'Posts of the active project, filtered: status (scheduled = planned on the calendar, published = posted), platform, format, due (planned, time passed, not posted), dates, words. Returns total and the posts (id, platform, when, headline…).',
  args: {
    status: arg.enum(['draft', 'scheduled', 'published', 'all'], { optional: true }),
    platform: arg.enum(POST_PLATFORMS, { optional: true }),
    format: arg.enum(['image', 'video'], { optional: true }),
    due: arg.boolean({ optional: true, desc: 'only due posts' }),
    from: arg.string({ optional: true, pattern: DATE, desc: 'YYYY-MM-DD' }),
    to: arg.string({ optional: true, pattern: DATE, desc: 'YYYY-MM-DD' }),
    q: arg.string({ optional: true, max: 100, desc: 'words in headline, caption or hashtags' }),
    limit: arg.number({ optional: true, int: true, min: 1, max: 50, desc: 'default 20' }),
  },
  run: (a) => {
    const now = Date.now();
    const q = a.q?.toLowerCase();
    const day = (iso: string) => toDateStr(new Date(iso));
    const found = projectPosts()
      .filter((p) => (!a.status || a.status === 'all' || p.status === a.status) && (!a.platform || p.platform === a.platform) && (!a.format || p.format === a.format))
      .filter((p) => a.due === undefined || isDueNow(p, now) === a.due)
      .filter((p) => (!a.from || day(postWhen(p)) >= a.from) && (!a.to || day(postWhen(p)) <= a.to))
      .filter((p) => !q || `${p.headline} ${p.caption} ${p.hashtags.join(' ')}`.toLowerCase().includes(q))
      .sort((x, y) => postWhen(x).localeCompare(postWhen(y)));
    // posted ones: newest first; the rest in the order they go out
    if (a.status === 'published') found.reverse();
    const shown = found.slice(0, a.limit ?? 20).map((p) => postSummary(p, now));
    const due = found.filter((p) => isDueNow(p, now)).length;
    return { data: { total: found.length, shown: shown.length, posts: shown }, note: `Checked your posts: ${found.length} found${due && a.due === undefined ? `, ${due} due` : ''}` };
  },
});

const getPost = defineTool({
  name: 'get_post',
  class: 'R',
  summary: 'One post in full: text, hashtags, media, when, and what Manus reported for it.',
  args: { id: arg.string({ desc: 'a post id' }) },
  validate: ({ id }) => (findPost(id) ? null : missingPost(id)),
  run: ({ id }) => {
    const p = findPost(id)!;
    const ext = p.external;
    const gs = p.groupShare;
    return {
      data: {
        ...postSummary(p),
        style: p.style,
        caption: clip(p.caption, 2200),
        hashtags: p.hashtags,
        visualPrompt: clip(p.visualPrompt, 300),
        planned: p.scheduledAt,
        postedAt: p.publishedAt ?? null,
        postedBy: p.publishedBy ?? null,
        link: p.postUrl ?? null,
        media: p.media ? { kind: p.media.kind, name: p.media.name, madeBy: p.media.generated?.provider ?? 'uploaded' } : null,
        watermark: p.watermark,
        source: p.source,
        manus: ext ? { state: ext.state, network: ext.network, mode: ext.mode ?? 'schedule', account: ext.page, scheduledFor: ext.scheduledFor, link: ext.url ?? null, report: untrusted(ext.message) } : null,
        facebookGroups: gs ? { state: gs.state, groups: gs.groups.length, results: gs.results.map((r) => ({ group: clip(r.group, 80), state: r.state, link: r.url ?? null, detail: untrusted(r.detail, 160) })) } : null,
      },
      note: `Read the post “${clip(p.headline, 60) || 'Untitled'}”`,
    };
  },
});

const getReadiness = defineTool({
  name: 'get_readiness',
  class: 'R',
  summary: 'Launch readiness, as on the Dashboard: each step (brand, offer, asset, listing, email, SEO page, social, first post), done or not, and the page to do it on.',
  args: {},
  run: () => {
    const p = activeProject();
    const posts = projectPosts();
    const listed = useStore.getState().myListings.some((l) => l.projectId === p.id);
    const r = readiness(p, { scheduled: posts.filter((x) => x.status !== 'draft').length, posted: posts.filter((x) => x.status === 'published').length, listed });
    return { data: { done: r.done, of: r.items.length, steps: r.items.map((i) => ({ step: i.label, done: i.done, page: `#${i.route}` })) }, note: `Checked your launch readiness: ${r.done} of ${r.items.length} done` };
  },
});

/** Today's AI use for the signed-in person (requests and dollars, and their limits), when the server says. */
async function myUsage(signal: AbortSignal): Promise<unknown> {
  if (__ARTIFACT_BUILD__ || useRuntime.getState().server === 'down') return null;
  const timeout = new AbortController();
  const t = setTimeout(() => timeout.abort(), 5000);
  const stop = () => timeout.abort();
  signal.addEventListener('abort', stop);
  try {
    const res = await serverFetch(useStore.getState().settings.ai.serverUrl, '/api/ai/my-usage', { method: 'GET', signal: timeout.signal });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { today?: { requests?: number; usd?: number }; limits?: { unlimited?: boolean; requestsPerDay?: number; usdPerDay?: number } } | null;
    if (!body?.today) return null;
    return { today: { requests: body.today.requests ?? 0, usd: body.today.usd ?? 0 }, limits: body.limits?.unlimited ? 'none (owner)' : { requestsPerDay: body.limits?.requestsPerDay, usdPerDay: body.limits?.usdPerDay } };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
    signal.removeEventListener('abort', stop);
  }
}

const getAIStatus = defineTool({
  name: 'get_ai_status',
  class: 'R',
  summary: 'What the AI here can do: which functions have a key (self-hosted), photos, videos, Manus posting, the Brain switch, and today’s AI use and limits when signed in.',
  args: {},
  run: async (_a, ctx) => {
    const rt = useRuntime.getState();
    const functions = __ARTIFACT_BUILD__ || !rt.ai.reachable ? undefined : AI_FUNCTIONS.map((f) => ({ fn: f.label, poweredBy: routeFor(f.id).map((id) => rt.ai.providers.find((p) => p.id === id)?.label ?? id) }));
    return { data: { ...aiSummary(), functions, brain: useStore.getState().settings.ai.useBrain ? 'on' : 'off', usage: await myUsage(ctx.signal) }, note: 'Checked what your AI can do' };
  },
});

const listNotifications = defineTool({
  name: 'list_notifications',
  class: 'R',
  summary: 'The notifications in the top bar (newest first): title, when, read or not, and the page it points to.',
  args: { unread: arg.boolean({ optional: true, desc: 'only unread' }), limit: arg.number({ optional: true, int: true, min: 1, max: 30 }) },
  run: ({ unread, limit }) => {
    const all = useStore.getState().notices.filter((n) => !unread || !n.read);
    const list = all.slice(0, limit ?? 10).map((n) => ({ id: n.id, title: clip(n.title, 120), body: clip(n.body, 160) || undefined, kind: n.kind, when: fmtRelative(n.createdAt), read: n.read, page: n.route ? `#${n.route}` : undefined }));
    return { data: { total: all.length, notifications: list }, note: `Checked your notifications: ${all.filter((n) => !n.read).length} unread` };
  },
});

const help = defineTool({
  name: 'help',
  class: 'R',
  summary: `How a part of the app works, in more detail than the guide. Topics: ${HELP_TOPIC_IDS.join(', ')}.`,
  args: { topic: arg.enum(HELP_TOPIC_IDS) },
  run: ({ topic }) => ({ data: { topic, text: HELP_TOPICS[topic] }, note: `Looked up how ${topic === 'ai' ? 'AI' : topic} works` }),
});

const navigateTool = defineTool({
  name: 'navigate',
  class: 'L',
  summary: 'Open a page, on one of its tabs when given (see the guide). Something generating on the current page makes the app ask the owner first.',
  args: { route: arg.enum(OPENABLE_ROUTES), tab: arg.string({ optional: true, max: 40 }) },
  validate: ({ route, tab }) => tabProblem(route, tab) || null,
  run: async ({ route, tab }) => {
    const ok = await host.openPage(route, tab);
    if (!ok) return { ok: false, error: 'The owner chose to stay on this page (something is still generating here).', note: 'Stayed on this page: something is still generating here' };
    return { data: { opened: `#${route}${tab ? `/${tab}` : ''}` }, note: `Opened ${pageName(route, tab)}` };
  },
});

const openPost = defineTool({
  name: 'open_post',
  class: 'L',
  summary: 'Open a post in the post editor, on whatever page is open.',
  args: { id: arg.string({ desc: 'a post id' }) },
  validate: ({ id }) => (findPost(id) ? null : missingPost(id)),
  run: ({ id }) => {
    useUI.getState().openPostEditor(id);
    return { data: { opened: id }, note: `Opened the post “${clip(findPost(id)?.headline, 60) || 'Untitled'}”` };
  },
});

const openComposer = defineTool({
  name: 'open_composer',
  class: 'L',
  summary: '“Create individual post” in the Social media engine, starting a new draft from a topic when given (the owner finishes it there).',
  args: { topic: arg.string({ optional: true, max: 200 }) },
  run: async ({ topic }) => {
    if (!(await host.openPage('marketing-social'))) return { ok: false, error: 'The owner chose to stay on this page (something is still generating here).', note: 'Stayed on this page: something is still generating here' };
    useUI.getState().openComposer(topic ? { topic } : undefined);
    return { data: { opened: '#marketing-social/create', topic: topic ?? null }, note: topic ? `Started a new post about “${clip(topic, 60)}”` : 'Opened Create individual post' };
  },
});

const switchProjectTool = defineTool({
  name: 'switch_project',
  class: 'L',
  summary: 'Switch to another project (ids from list_projects). This chat stays with the current project, so this ends your turn.',
  args: { id: arg.string({ desc: 'a project id' }) },
  validate: ({ id }) => (useStore.getState().projects.some((p) => p.id === id) ? null : `There’s no project with id "${id}". Use list_projects.`),
  run: async ({ id }) => {
    const name = useStore.getState().projects.find((p) => p.id === id)?.brand.name || 'Untitled project';
    const r = await switchProject(id);
    if (r === 'stayed') return { ok: false, error: 'The owner chose to stay (something is still generating).', note: 'Stayed in this project: something is still generating' };
    if (r === 'missing') return { ok: false, error: 'That project is gone.' };
    return { data: { switchedTo: name }, note: `Switched to “${name}”`, end: true };
  },
});

const setPreferences = defineTool({
  name: 'set_preferences',
  class: 'L',
  summary: 'Change preferences: theme, the Brain switch (skills shape every AI output), and the profile name or email used to pre-fill sign-offs.',
  args: {
    theme: arg.enum(['system', 'light', 'dark'], { optional: true }),
    useBrain: arg.boolean({ optional: true }),
    name: arg.string({ optional: true, max: 80 }),
    email: arg.string({ optional: true, max: 120, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, desc: 'an email address' }),
  },
  validate: (a) => (a.theme === undefined && a.useBrain === undefined && a.name === undefined && a.email === undefined ? 'Say what to change.' : null),
  run: (a) => {
    const changed: string[] = [];
    useStore.getState().updateSettings((s): AppSettings => {
      const next = { ...s, ai: { ...s.ai }, profile: { ...s.profile } };
      if (a.theme) {
        next.theme = a.theme;
        changed.push(`theme ${a.theme}`);
      }
      if (a.useBrain !== undefined) {
        next.ai.useBrain = a.useBrain;
        changed.push(`Brain ${a.useBrain ? 'on' : 'off'}`);
      }
      if (a.name !== undefined) {
        next.profile.name = a.name;
        changed.push('your name');
      }
      if (a.email !== undefined) {
        next.profile.email = a.email;
        changed.push('your email');
      }
      return next;
    });
    return { data: { changed }, note: `Changed ${changed.join(', ')}` };
  },
});

export const coreTools: AnyTool[] = [getWorkspace, listProjects, getProject, listPosts, getPost, getReadiness, getAIStatus, listNotifications, help, navigateTool, openPost, openComposer, switchProjectTool, setPreferences];
