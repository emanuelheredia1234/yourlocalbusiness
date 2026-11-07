// Saving what "Make variations" made (P4b §A2 step 5), and taking it back when the server says no.
//
//   posts  new Post documents (copies of the source with the version's fields, the test set, the same plan slot),
//          saved to the account, then POST /api/experiments makes the draft; the source becomes version A.
//   email  a draft test; version B is kept on the step until "Create A/B draft in Omnisend".
//   page   a draft test; version B's changes are kept on the project (marketing.seoVariant) until the split starts.
//
// Nothing here posts, sends or publishes, and nothing counts toward the month's tests: a draft is free.

import type { EmailStep, Experiment, ExperimentChanged, Post, Project, SeoVariant, ShareMode, VariantKey } from '@/lib/types';
import { saveNow } from '@/lib/cloud/auth';
import { useStore } from '@/store/useStore';
import { useExperiments } from '@/store/experiments';
import { createExperiment, deleteExperiment } from './api';
import { KEYS, variantPost, type EmailFields, type PostFields } from './variants';

export interface PostVersion {
  label: string;
  fields: PostFields;
  media?: Post['media'];
  plannedAt?: string;
}

/** The posts' versions saved and the draft made. On a refusal the new posts are taken back out. → the draft */
export async function savePostTest(o: { source: Post; change: ExperimentChanged; mode: 'times' | 'trial_reels'; shareMode?: ShareMode; sourceLabel?: string; sourcePlannedAt?: string; versions: PostVersion[] }): Promise<Experiment> {
  const { source } = o;
  const st = useStore.getState();
  const tmpId = 'pending';
  const made: Post[] = o.versions.map((v, i) =>
    variantPost(source, { ...v.fields, ...(v.media !== undefined ? { media: v.media } : {}), ...(v.plannedAt ? { scheduledAt: v.plannedAt } : {}), ...(o.mode === 'trial_reels' && o.shareMode ? { instagram: { shareMode: o.shareMode } } : {}) }, { id: tmpId, key: KEYS[i + 1] }),
  );
  st.addPosts(made);
  const before = { experiment: source.experiment, instagram: source.instagram };
  if (o.mode === 'trial_reels' && o.shareMode) st.updatePost(source.id, { instagram: { shareMode: o.shareMode } });
  try {
    // the server reads the saved posts: they go to the account first
    await saveNow();
    const { experiment } = await createExperiment({
      projectId: source.projectId,
      kind: 'post',
      mode: o.mode,
      changed: o.change,
      network: source.platform,
      subjectRef: source.id,
      name: source.headline.slice(0, 120),
      variants: [
        { key: 'a', label: o.sourceLabel || 'Original', postId: source.id, ...(o.sourcePlannedAt || source.scheduledAt ? { plannedAt: o.sourcePlannedAt || source.scheduledAt } : {}), ...(o.mode === 'trial_reels' && o.shareMode ? { shareMode: o.shareMode } : {}) },
        ...made.map((p, i) => ({ key: KEYS[i + 1], label: o.versions[i].label, postId: p.id, ...(o.versions[i].plannedAt ? { plannedAt: o.versions[i].plannedAt } : {}), ...(o.mode === 'trial_reels' && o.shareMode ? { shareMode: o.shareMode } : {}) })),
      ],
    });
    const s = useStore.getState();
    s.updatePost(source.id, { experiment: { id: experiment.id, key: 'a' } });
    made.forEach((p, i) => s.updatePost(p.id, { experiment: { id: experiment.id, key: KEYS[i + 1] } }));
    useExperiments.getState().upsert(experiment);
    void saveNow();
    return experiment;
  } catch (e) {
    const s = useStore.getState();
    s.deletePosts(made.map((p) => p.id));
    s.updatePost(source.id, { experiment: before.experiment, instagram: before.instagram });
    throw e;
  }
}

/** An email step's draft test: version B kept on the step. */
export async function saveEmailTest(o: { project: Project; step: EmailStep; change: 'subject' | 'opening'; label: string; b: EmailFields }): Promise<Experiment> {
  const { experiment } = await createExperiment({
    projectId: o.project.id,
    kind: 'email',
    mode: 'omnisend_ab',
    changed: o.change,
    subjectRef: `emails:${o.step.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 59) || 'step'}`,
    name: o.step.subject.slice(0, 120),
    variants: [
      { key: 'a', label: 'Original' },
      { key: 'b', label: o.label || 'Version B' },
    ],
  });
  try {
    useStore.getState().updateProject(o.project.id, (p) => ({
      ...p,
      marketing: { ...p.marketing, emails: p.marketing.emails.map((e) => (e.id === o.step.id ? { ...e, variants: { experimentId: experiment.id, changed: o.change, b: { subject: o.b.subject, preview: o.b.preview, body: o.b.body } } } : e)) },
    }));
  } catch (e) {
    await deleteExperiment(experiment.id).catch(() => {});
    throw e;
  }
  useExperiments.getState().upsert(experiment);
  return experiment;
}

/** The SEO page's draft test: version B's changes kept on the project. */
export async function savePageTest(o: { project: Project; change: 'headline' | 'hero' | 'cta'; label: string; overrides: SeoVariant['overrides'] }): Promise<Experiment> {
  const { experiment } = await createExperiment({
    projectId: o.project.id,
    kind: 'page',
    mode: 'split',
    changed: o.change,
    subjectRef: `seo:${o.project.id}`,
    name: 'Sales page',
    variants: [
      { key: 'a', label: 'Original' },
      { key: 'b', label: o.label || 'Version B' },
    ],
  });
  useStore.getState().updateProject(o.project.id, (p) => ({ ...p, marketing: { ...p.marketing, seoVariant: { experimentId: experiment.id, changed: o.change, overrides: o.overrides } } }));
  useExperiments.getState().upsert(experiment);
  return experiment;
}

/** The posts of a test (the version's post for each key), from the workspace. */
export function postsOfTest(e: Pick<Experiment, 'variants'>, posts = useStore.getState().posts): Partial<Record<VariantKey, Post>> {
  const out: Partial<Record<VariantKey, Post>> = {};
  for (const v of e.variants) {
    const p = v.postId ? posts.find((x) => x.id === v.postId) : undefined;
    if (p) out[v.key] = p;
  }
  return out;
}
