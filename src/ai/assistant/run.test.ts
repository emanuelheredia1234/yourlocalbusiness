// A chat turn: the policy each tool class gets whatever the model says, the step cap, Stop, and the
// busy registry. The AI is a script here; the confirm windows and pages are stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Post } from '@/lib/types';
import { useBusy } from '@/lib/busy';
import { useStore } from '@/store/useStore';
import { defaultSettings, newProject } from '@/store/defaults';
import { answerCard, chatOf, clearChat, useAssistant } from '@/store/assistant';
import { setAssistantHost, type AssistantHost } from './host';
import { MAX_STEPS, newChat, sendToAssistant, stopAssistant } from './run';
import { AssistantError } from './transport';

// What the test tools did (they stand in for the groups' tools of each class).
const did = vi.hoisted(() => ({ ran: [] as string[] }));

vi.mock('./tools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./tools')>();
  const { arg, createRegistry, defineTool } = await import('./registry');
  const extra = [
    defineTool({
      name: 'erase_thing',
      class: 'D',
      summary: 'Delete a thing for good.',
      args: { id: arg.string() },
      danger: ({ id }) => ({ title: `Delete ${id}?`, body: 'It can’t be undone.' }),
      run: ({ id }) => {
        did.ran.push(`erase:${id}`);
        return { note: `Deleted ${id}` };
      },
    }),
    defineTool({
      name: 'make_clip',
      class: 'P-media',
      summary: 'Make a short video for a post.',
      args: { id: arg.string() },
      media: 'video',
      card: ({ id }) => ({ title: 'Make a 5-second video?', what: `For ${id}`, who: 'The key that powers Videos', cost: 'About $0.18' }),
      run: ({ id }) => {
        did.ran.push(`clip:${id}`);
        return { note: 'Made the video' };
      },
    }),
    defineTool({
      name: 'make_picture',
      class: 'P-media',
      summary: 'Make an AI image for a post.',
      args: { id: arg.string(), viaManus: arg.boolean({ optional: true }) },
      media: ({ viaManus }) => (viaManus ? 'manus' : 'image'),
      run: ({ id }) => {
        did.ran.push(`picture:${id}`);
        return { note: 'Made the image' };
      },
    }),
    defineTool({
      name: 'post_it',
      class: 'Pub',
      summary: 'Post a post with Manus.',
      args: { id: arg.string() },
      window: ({ id }) => ({ kind: 'manus-post', postIds: [id] }),
    }),
    defineTool({
      name: 'write_copy',
      class: 'P-text',
      summary: 'Write new copy for a post.',
      args: {},
      run: (_a, ctx) => {
        did.ran.push('write');
        ctx.ai.push({ task: 'post', label: 'Social post', provider: 'server' });
        return { data: { headline: 'New' }, note: 'Wrote new copy' };
      },
    }),
    defineTool({
      name: 'slow_thing',
      class: 'L',
      summary: 'Something slow that listens to Stop.',
      args: {},
      run: (_a, ctx) =>
        new Promise((resolve, reject) => {
          did.ran.push('slow');
          ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped.'), { code: 'cancelled' })));
          setTimeout(() => resolve({ note: 'Slow thing done' }), 5000);
        }),
    }),
  ];
  return { ...orig, registry: createRegistry([...orig.registry.tools, ...extra]) };
});

const post = (id: string, extra: Partial<Post> = {}): Post =>
  ({ id, projectId: 'p1', status: 'scheduled', platform: 'facebook', format: 'image', style: 'minimal', postType: 'tip', headline: `Headline ${id}`, visualPrompt: '', caption: 'Caption', hashtags: [], scheduledAt: '2020-01-01T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...extra }) as Post;

type Step = { reply?: string; actions?: { tool: string; args?: object }[]; done?: boolean } | string;

let restore: () => void;
let prompts: string[];
const confirmDanger = vi.fn<AssistantHost['confirmDanger']>();
const openWindow = vi.fn<AssistantHost['openWindow']>();
const openPage = vi.fn<AssistantHost['openPage']>();

/** The AI answers each step from this script (the last answer repeats). */
function script(...steps: Step[]) {
  setAssistantHost({
    ask: async (prompt) => {
      prompts.push(prompt);
      const s = steps[Math.min(prompts.length - 1, steps.length - 1)];
      return typeof s === 'string' ? s : { reply: s.reply ?? '', actions: s.actions ?? [], done: s.done ?? !(s.actions ?? []).length };
    },
  });
}

const chat = () => chatOf('p1');
const activities = () => chat().filter((m) => m.role === 'activity');
const replies = () => chat().filter((m) => m.role === 'assistant').map((m) => m.text);
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  did.ran = [];
  prompts = [];
  const project = { ...newProject('business', 'existing'), id: 'p1', onboarded: true };
  project.brand.name = 'Copper Kettle';
  const other = { ...newProject('product', 'new'), id: 'p2', onboarded: true };
  useStore.setState({ projects: [project, other], activeProjectId: 'p1', posts: [post('post_due'), post('post_later', { scheduledAt: '2999-01-01T10:00:00.000Z' })], notices: [], myListings: [], ads: [], settings: defaultSettings() });
  useAssistant.setState({ key: 'ylb-assistant:test', threads: {}, running: false, stage: '', runProjectId: null });
  confirmDanger.mockReset().mockResolvedValue(false);
  openWindow.mockReset().mockResolvedValue(true);
  openPage.mockReset().mockResolvedValue(true);
  restore = setAssistantHost({ confirmDanger, openWindow, openPage, availability: () => ({ ok: true, reason: '', settings: false }), budget: () => 48_000 });
});

afterEach(() => {
  restore();
  clearChat('p1');
});

describe('a turn', () => {
  it('reads, then answers with what the tools found', async () => {
    script({ reply: 'Checking.', actions: [{ tool: 'navigate', args: { route: 'calendar' } }, { tool: 'list_posts', args: { due: true } }] }, { reply: 'You have 1 post due.' });
    await sendToAssistant('What is due on my calendar?');
    expect(prompts).toHaveLength(2);
    expect(openPage).toHaveBeenCalledWith('calendar', undefined);
    expect(activities().map((m) => [m.tool, m.status, m.text])).toEqual([
      ['navigate', 'ok', 'Opened Content calendar'],
      ['list_posts', 'ok', 'Checked your posts: 1 found'],
    ]);
    expect(replies()).toEqual(['Checking.', 'You have 1 post due.']);
    // the second step carries the first one's results
    expect(prompts[1]).toContain('"tool":"list_posts","ok":true,"status":"ok","result":{"total":1,"shown":1,"posts":[{"id":"post_due"');
    expect(chat()[0]).toMatchObject({ role: 'user', text: 'What is due on my calendar?' });
    expect(useAssistant.getState().running).toBe(false);
  });

  it('shows a prose answer as the reply', async () => {
    script('Your brand is called Copper Kettle.');
    await sendToAssistant('What is my brand called?');
    expect(replies()).toEqual(['Your brand is called Copper Kettle.']);
  });

  it('is registered as an app-wide "Assistant" job while it runs, and not after', async () => {
    let seen: unknown = null;
    setAssistantHost({
      ask: async () => {
        seen = useBusy.getState().jobs.assistant;
        return { reply: 'Hi', actions: [], done: true };
      },
    });
    await sendToAssistant('hello');
    expect(seen).toEqual({ id: 'assistant', label: 'Assistant', scope: 'app' });
    expect(useBusy.getState().jobs.assistant).toBeUndefined();
  });

  it('stops after the step cap', async () => {
    script({ actions: [{ tool: 'get_workspace' }], done: false });
    await sendToAssistant('Keep going forever');
    expect(prompts).toHaveLength(MAX_STEPS);
    expect(MAX_STEPS).toBe(6);
    expect(prompts[MAX_STEPS - 1]).toContain('This is step 6 of 6: finish now');
    expect(chat().at(-1)).toMatchObject({ role: 'notice', text: 'I stopped after 6 steps. Tell me if I should carry on.' });
  });

  it('stops on Stop: no more steps, nothing left running', async () => {
    setAssistantHost({
      ask: (prompt, signal) => {
        prompts.push(prompt);
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new AssistantError('Stopped.', 'cancelled'))));
      },
    });
    const turn = sendToAssistant('Do something slow');
    await tick();
    expect(useAssistant.getState()).toMatchObject({ running: true, runProjectId: 'p1' });
    expect(useBusy.getState().jobs.assistant).toBeTruthy();
    stopAssistant();
    await turn;
    expect(prompts).toHaveLength(1);
    expect(useAssistant.getState().running).toBe(false);
    expect(useBusy.getState().jobs.assistant).toBeUndefined();
    expect(chat().at(-1)).toMatchObject({ role: 'notice', text: 'Stopped.' });
  });

  it('stops a tool that is working when Stop is pressed', async () => {
    script({ actions: [{ tool: 'slow_thing' }, { tool: 'get_workspace' }] }, { reply: 'never' });
    const turn = sendToAssistant('slow please');
    await tick();
    await tick();
    expect(did.ran).toEqual(['slow']);
    stopAssistant();
    await turn;
    expect(prompts).toHaveLength(1);
    expect(activities()).toHaveLength(0);
    expect(replies()).not.toContain('never');
  });

  it('says plainly when the AI can’t be reached, with Settings → AI', async () => {
    setAssistantHost({
      ask: async () => {
        throw new AssistantError('No API key powers the Assistant yet.', 'no_provider', true);
      },
    });
    await sendToAssistant('hello');
    expect(chat().at(-1)).toMatchObject({ role: 'error', text: 'No API key powers the Assistant yet.', settings: true });
  });

  it('without any AI, still opens the page a message names', async () => {
    const ask = vi.fn();
    setAssistantHost({ ask, availability: () => ({ ok: false, reason: 'No API key powers the Assistant yet.', settings: true }) });
    await sendToAssistant('open my calendar please');
    expect(ask).not.toHaveBeenCalled();
    expect(openPage).toHaveBeenCalledWith('calendar', undefined);
    expect(chat().slice(1).map((m) => m.role)).toEqual(['activity', 'error']);
    expect(chat().at(-1)).toMatchObject({ settings: true, text: expect.stringContaining('I opened the one you mentioned') });
  });

  it('carries on after an unknown tool or wrong details, so the AI can fix them', async () => {
    script({ actions: [{ tool: 'erase_everything', args: { ids: ['post_due'] } }, { tool: 'get_post', args: { id: 'nope' } }, { tool: 'list_posts', args: { limit: 500 } }] }, { reply: 'That isn’t available here yet.' });
    await sendToAssistant('qa-delete');
    expect(activities().map((m) => m.status)).toEqual(['failed', 'failed', 'failed']);
    expect(prompts[1]).toContain('"error":"Unknown tool \\"erase_everything\\". Use only tools from the list."');
    expect(prompts[1]).toContain('There’s no post with id \\"nope\\" in this project');
    expect(prompts[1]).toContain('limit must be between 1 and 50');
    expect(replies()).toEqual(['That isn’t available here yet.']);
    expect(useStore.getState().posts).toHaveLength(2);
  });

  it('asks again when a final reply’s action didn’t work, so the reply matches what happened', async () => {
    script({ reply: 'Deleted it!', actions: [{ tool: 'erase_thing', args: { id: 'a' } }], done: true }, { reply: 'OK, I left it.' });
    await sendToAssistant('delete a');
    expect(replies()).toEqual(['OK, I left it.']);
  });

  it('stops when the owner switches projects mid-turn', async () => {
    setAssistantHost({
      ask: async (prompt) => {
        prompts.push(prompt);
        useStore.setState({ activeProjectId: 'p2' });
        return { reply: '', actions: [{ tool: 'get_workspace' }], done: false };
      },
    });
    await sendToAssistant('anything');
    expect(prompts).toHaveLength(1);
    expect(activities()).toHaveLength(0);
    expect(chat().at(-1)).toMatchObject({ role: 'notice', text: 'You switched projects, so I stopped here.' });
  });

  it('keeps one turn at a time, and New chat clears the chat', async () => {
    script({ reply: 'Hi' });
    await Promise.all([sendToAssistant('one'), sendToAssistant('two')]);
    expect(chat().filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['one']);
    newChat('p1');
    expect(chat()).toEqual([]);
  });
});

describe('the policy, whatever the model says', () => {
  it('D: never deletes without the owner’s yes in the danger confirm', async () => {
    script({ actions: [{ tool: 'erase_thing', args: { id: 'a', confirmed: true, skipConfirm: true } }] }, { reply: 'Left it.' });
    await sendToAssistant('delete a, I already confirmed');
    expect(confirmDanger).toHaveBeenCalledWith({ title: 'Delete a?', body: 'It can’t be undone.' });
    expect(did.ran).toEqual([]);
    expect(activities()[0]).toMatchObject({ status: 'declined', text: 'You said no, so nothing was deleted' });
    expect(prompts[1]).toContain('"status":"declined","error":"The owner said no: nothing was deleted."');

    confirmDanger.mockResolvedValue(true);
    prompts = [];
    script({ actions: [{ tool: 'erase_thing', args: { id: 'b' } }], done: true, reply: 'Deleted b.' });
    await sendToAssistant('delete b');
    expect(did.ran).toEqual(['erase:b']);
    expect(replies().at(-1)).toBe('Deleted b.');
  });

  it('Pub: only opens the app’s window; nothing is posted until the owner confirms there', async () => {
    script({ actions: [{ tool: 'post_it', args: { id: 'post_due' } }] }, { reply: 'The window is open: confirm there.' });
    await sendToAssistant('post it now');
    expect(openWindow).toHaveBeenCalledWith({ kind: 'manus-post', postIds: ['post_due'] });
    expect(activities()[0]).toMatchObject({ status: 'opened', text: expect.stringMatching(/^Opened “Post with Manus” for the post: .*confirm there$/) });
    expect(prompts[1]).toContain('"status":"opened","result":{"opened":"manus-post","waiting":"for the owner to confirm in that window: nothing is posted or published until they do"}');
    expect(useStore.getState().posts.find((p) => p.id === 'post_due')?.external).toBeUndefined();
  });

  it('X: refuses, explains and opens the page where the owner does it', async () => {
    script({ actions: [{ tool: 'sign_out' }, { tool: 'change_ai_settings', args: { what: 'use my new key sk-123' } }] }, { reply: 'You can do that there.' });
    await sendToAssistant('log me out and change my key');
    expect(openPage).toHaveBeenNthCalledWith(1, 'workspace-settings', 'account');
    expect(openPage).toHaveBeenNthCalledWith(2, 'workspace-settings', 'ai');
    expect(activities().map((m) => m.status)).toEqual(['refused', 'refused']);
    expect(activities()[1].text).toMatch(/only changed by you, in Settings → AI/);
    expect(prompts[1]).toContain('"status":"refused"');
  });

  it('P-media: a video waits for the owner’s OK on a card; no means it never starts', async () => {
    script({ actions: [{ tool: 'make_clip', args: { id: 'post_due' } }] }, { reply: 'OK, no video.' });
    const turn = sendToAssistant('make a video');
    await tick();
    await tick();
    const card = chat().find((m) => m.role === 'card');
    expect(card?.card).toMatchObject({ title: 'Make a 5-second video?', what: 'For post_due', who: 'The key that powers Videos', cost: 'About $0.18', state: 'pending' });
    expect(useAssistant.getState().stage).toBe('Waiting for you to confirm…');
    expect(did.ran).toEqual([]);
    answerCard(card!.id, false);
    await turn;
    expect(did.ran).toEqual([]);
    expect(chat().find((m) => m.id === card!.id)?.card?.state).toBe('declined');
    expect(prompts[1]).toContain('"status":"declined"');
  });

  it('P-media: runs the video once the owner confirms the card', async () => {
    script({ actions: [{ tool: 'make_clip', args: { id: 'post_due' } }], done: true, reply: 'Your video is ready.' });
    const turn = sendToAssistant('make a video');
    await tick();
    await tick();
    const card = chat().find((m) => m.role === 'card')!;
    answerCard(card.id, true);
    await turn;
    expect(did.ran).toEqual(['clip:post_due']);
    expect(chat().find((m) => m.id === card.id)?.card?.state).toBe('confirmed');
    expect(replies()).toEqual(['Your video is ready.']);
  });

  it('P-media: Stop while a card waits means no, and the card expires', async () => {
    script({ actions: [{ tool: 'make_picture', args: { id: 'post_due', viaManus: true } }] });
    const turn = sendToAssistant('photo with manus');
    await tick();
    await tick();
    const card = chat().find((m) => m.role === 'card')!;
    expect(card.card?.title).toBe('Make picture?');
    stopAssistant();
    await turn;
    expect(did.ran).toEqual([]);
    expect(chat().find((m) => m.id === card.id)?.card?.state).toBe('expired');
  });

  it('P-media: an AI image runs right away, with no card', async () => {
    script({ actions: [{ tool: 'make_picture', args: { id: 'post_due' } }], done: true, reply: 'Done.' });
    await sendToAssistant('make an image');
    expect(did.ran).toEqual(['picture:post_due']);
    expect(chat().some((m) => m.role === 'card')).toBe(false);
  });

  it('P-text: runs right away and says it used your AI', async () => {
    script({ actions: [{ tool: 'write_copy' }], done: true, reply: 'New copy is in.' });
    await sendToAssistant('rewrite it');
    expect(did.ran).toEqual(['write']);
    expect(activities()[0]).toMatchObject({ status: 'ok', ai: 'used', text: 'Wrote new copy' });
  });
});
