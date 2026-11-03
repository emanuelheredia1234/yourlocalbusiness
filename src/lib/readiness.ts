import type { Project } from './types';
import type { Route } from './router';

/** Launch readiness: the steps from a brand to a first post, each with where to do it (the Dashboard shows it; the assistant reads it). */
export function readiness(project: Project, ctx: { scheduled: number; posted: number; listed: boolean }) {
  const items: { label: string; done: boolean; route: Route; cta: string }[] = [
    { label: 'Brand kit', done: !!project.brand.name && project.onboarded, route: 'workspace-settings', cta: 'Edit brand' },
    { label: project.track === 'business' ? 'Packages & operating model' : 'Product outline', done: project.studio.outline.length > 0 || project.studio.packages.length > 0, route: 'studio', cta: 'Open Studio' },
    { label: 'Interactive asset', done: project.studio.codeAssets.length > 0, route: 'studio', cta: 'Generate code' },
    { label: 'Listed on the Marketplace', done: ctx.listed, route: 'studio', cta: 'Publish' },
    { label: 'Lead magnet + 5 emails', done: !!project.marketing.leadMagnet && project.marketing.emails.length >= 5, route: 'marketing-email', cta: 'Build funnel' },
    { label: 'SEO sales page', done: !!project.marketing.salesPage, route: 'marketing-seo', cta: 'Build page' },
    { label: 'Social posts on your calendar', done: ctx.scheduled > 0, route: 'marketing-social', cta: 'Plan campaign' },
    { label: 'First post out', done: ctx.posted > 0, route: 'calendar', cta: 'Open calendar' },
  ];
  return { items, done: items.filter((i) => i.done).length };
}
