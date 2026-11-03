// Reading the AI's reply: the JSON step, JSON in a code fence, and plain prose.
import { describe, expect, it } from 'vitest';
import { MAX_ACTIONS_PER_STEP, MAX_REPLY_CHARS, parseStep } from './protocol';

describe('reading a step', () => {
  it('takes a well-formed JSON step, as text or as the parsed object', () => {
    const step = { reply: 'Opening your calendar.', actions: [{ tool: 'navigate', args: { route: 'calendar' } }], done: false };
    expect(parseStep(JSON.stringify(step))).toEqual({ ...step, prose: false });
    expect(parseStep(step)).toEqual({ ...step, prose: false });
    expect(parseStep({ reply: 'All done.', actions: [], done: true })).toEqual({ reply: 'All done.', actions: [], done: true, prose: false });
  });

  it('takes JSON in a code fence, or with words around it', () => {
    const fenced = 'Here you go:\n```json\n{"reply": "Hi!", "actions": [], "done": true}\n```';
    expect(parseStep(fenced)).toMatchObject({ reply: 'Hi!', done: true, prose: false });
    expect(parseStep('Sure. {"reply":"Checking.","actions":[{"tool":"list_posts","args":{"due":true}}],"done":false} Thanks')).toMatchObject({ reply: 'Checking.', actions: [{ tool: 'list_posts', args: { due: true } }], done: false });
  });

  it('shows plain prose as the reply', () => {
    expect(parseStep('You have **3** posts due today.')).toEqual({ reply: 'You have **3** posts due today.', actions: [], done: true, prose: true });
    expect(parseStep('Use {name} in your caption.')).toMatchObject({ reply: 'Use {name} in your caption.', prose: true });
    expect(parseStep('   ')).toMatchObject({ reply: '', actions: [], done: true });
  });

  it('keeps the reply of an answer cut off mid-JSON instead of showing raw JSON', () => {
    expect(parseStep('{"reply": "Your calendar has 2 posts due.\\nWant me to open it?", "actions": [{"tool": "nav')).toEqual({ reply: 'Your calendar has 2 posts due.\nWant me to open it?', actions: [], done: true, prose: true });
  });

  it('is tolerant of how actions are written, and drops ones without a tool', () => {
    const s = parseStep({ message: 'ok', actions: [{ name: 'Get-Post', arguments: '{"id":"post_1"}' }, { tool: 'list_posts' }, { args: { x: 1 } }, 'nope'], continue: true });
    expect(s).toEqual({ reply: 'ok', actions: [{ tool: 'get_post', args: { id: 'post_1' } }, { tool: 'list_posts', args: {} }], done: false, prose: false });
    // a bare list of actions means more to do
    expect(parseStep([{ tool: 'get_workspace', args: {} }])).toEqual({ reply: '', actions: [{ tool: 'get_workspace', args: {} }], done: false, prose: false });
    // args that aren't an object become {}
    expect(parseStep({ actions: [{ tool: 'help', args: ['posting'] }] }).actions[0].args).toEqual({});
  });

  it('is done when there is nothing left to run, whatever "done" says', () => {
    expect(parseStep({ reply: 'Hmm', actions: [], done: false }).done).toBe(true);
    expect(parseStep({ reply: 'Going', actions: [{ tool: 'get_workspace' }] }).done).toBe(false);
  });

  it('caps the actions per step and the reply length', () => {
    const many = Array.from({ length: 20 }, () => ({ tool: 'get_workspace', args: {} }));
    expect(parseStep({ actions: many }).actions).toHaveLength(MAX_ACTIONS_PER_STEP);
    expect(parseStep({ reply: 'x'.repeat(10_000) }).reply.length).toBe(MAX_REPLY_CHARS);
  });

  it('gives an empty reply for JSON that isn’t a step (the turn then says it didn’t get an answer)', () => {
    expect(parseStep('{"ok":true,"note":"mock answer"}')).toEqual({ reply: '', actions: [], done: true, prose: false });
  });
});
