// How to test an assistant tool: one example per class, run the way a turn runs them. Tool groups copy
// this pattern for their own tools (registered ones need no `tools` option).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '@/store/useStore';
import { answerCard } from '@/store/assistant';
import { arg, defineTool } from './registry';
import { deleteConfirm, manusCard } from './confirm';
import { findPost, missingPost, postSummary } from './lookup';
import { fakeHost, runTool, seedWorkspace, testChat, testPost } from './testing';

// examples of each class (a group defines its tools like these, in its own file under tools/)
const renamePost = defineTool({
  name: 'rename_post',
  class: 'L',
  summary: 'Change a post’s headline.',
  args: { id: arg.string({ desc: 'a post id' }), headline: arg.string({ max: 120 }) },
  validate: ({ id }) => (findPost(id) ? null : missingPost(id)),
  run: ({ id, headline }) => {
    useStore.getState().updatePost(id, { headline });
    return { data: postSummary(findPost(id)!), note: `Renamed the post to “${headline}”` };
  },
});
const removePosts = defineTool({
  name: 'remove_posts',
  class: 'D',
  summary: 'Delete posts.',
  args: { ids: arg.array(arg.string(), { min: 1, max: 50 }) },
  validate: ({ ids }) => ids.map((id) => (findPost(id) ? '' : missingPost(id))).find(Boolean) || null,
  danger: ({ ids }) => deleteConfirm({ thing: 'post', names: ids.map((id) => findPost(id)!.headline) }),
  run: ({ ids }) => {
    useStore.getState().deletePosts(ids);
    return { data: { deleted: ids.length }, note: `Deleted ${ids.length} post${ids.length === 1 ? '' : 's'}` };
  },
});
const postWithManus = defineTool({
  name: 'post_now',
  class: 'Pub',
  summary: 'Open “Post with Manus” for posts.',
  args: { ids: arg.array(arg.string(), { min: 1, max: 20 }) },
  validate: ({ ids }) => ids.map((id) => (findPost(id) ? '' : missingPost(id))).find(Boolean) || null,
  window: ({ ids }) => ({ kind: 'manus-post', postIds: ids }),
});
const manusPhoto = defineTool({
  name: 'manus_photo',
  class: 'P-media',
  summary: 'Make a post photo as a Manus task.',
  args: { id: arg.string() },
  media: 'manus',
  card: () => manusCard({ title: 'Make this photo with Manus?', what: 'A photo for your post.', cost: 'About 40 Manus credits.' }),
  run: ({ id }) => ({ data: { id }, note: 'Made the photo' }),
});
const tools = [renamePost, removePosts, postWithManus, manusPhoto];

let host: ReturnType<typeof fakeHost>;
beforeEach(() => {
  seedWorkspace({ posts: [testPost('post_a'), testPost('post_b')] });
  host = fakeHost();
});
afterEach(() => host.restore());

describe('testing tools, one class at a time', () => {
  it('L: runs, checks ids, and notes what it did', async () => {
    const r = await runTool('rename_post', { id: 'post_a', headline: 'Sourdough Saturday' }, { tools });
    expect(r).toMatchObject({ ok: true, status: 'ok', result: { id: 'post_a', headline: 'Sourdough Saturday' } });
    expect(testChat().at(-1)).toMatchObject({ role: 'activity', status: 'ok', text: 'Renamed the post to “Sourdough Saturday”' });
    expect((await runTool('rename_post', { id: 'post_zz', headline: 'x' }, { tools })).error).toBe(missingPost('post_zz'));
  });

  it('D: only after a yes in the danger confirm', async () => {
    expect(await runTool('remove_posts', { ids: ['post_a'] }, { tools })).toMatchObject({ ok: false, status: 'declined' });
    expect(host.calls.dangers[0]).toEqual({ title: 'Delete this post?', body: '“Headline post_a” will be deleted. This can’t be undone.', confirmLabel: 'Delete post' });
    expect(findPost('post_a')).toBeTruthy();
    host.restore();
    host = fakeHost({ confirm: true });
    expect(await runTool('remove_posts', { ids: ['post_a', 'post_b'] }, { tools })).toMatchObject({ ok: true, result: { deleted: 2 } });
    expect(findPost('post_a')).toBeUndefined();
  });

  it('Pub: only the window opens', async () => {
    expect(await runTool('post_now', { ids: ['post_b'] }, { tools })).toMatchObject({ ok: true, status: 'opened' });
    expect(host.calls.windows).toEqual([{ kind: 'manus-post', postIds: ['post_b'] }]);
  });

  it('P-media (Manus): waits for the card in the chat', async () => {
    const run = runTool('manus_photo', { id: 'post_a' }, { tools });
    await new Promise((r) => setTimeout(r, 0));
    const card = testChat().find((m) => m.role === 'card')!;
    expect(card.card).toMatchObject({ title: 'Make this photo with Manus?', who: expect.stringContaining('Manus'), cost: 'About 40 Manus credits.', state: 'pending' });
    answerCard(card.id, true);
    expect(await run).toMatchObject({ ok: true, status: 'ok' });
  });
});
