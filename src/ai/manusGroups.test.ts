// Sharing a post in Facebook groups: the list you type, Manus's exact instructions, and its per-group report.
import { describe, expect, it } from 'vitest';
import type { ManusState } from './manus';
import { groupLinkError, groupStateFromManus, groupSummary, groupsPrompt, parseGroupResults, parseGroups } from './manusGroups';

const base: ManusState = { taskId: 't', status: 'stopped', agentStatus: 'stopped', done: true, waiting: false, waitingType: '', waitingDescription: '', error: '', title: '', taskUrl: '', creditUsage: 0, text: '', imageCount: 0, images: [] };

describe('the group list', () => {
  it('takes one group per line, names or links, without repeats or bullets', () => {
    expect(parseGroups('Austin Small Business\n- https://www.facebook.com/groups/123/\n\n2. Austin small business\n  Candle Makers  ')).toEqual(['Austin Small Business', 'https://www.facebook.com/groups/123/', 'Candle Makers']);
  });
  it('only accepts Facebook group links', () => {
    expect(groupLinkError('Austin Small Business')).toBeNull();
    expect(groupLinkError('https://www.facebook.com/groups/austinbiz')).toBeNull();
    expect(groupLinkError('facebook.com/groups/austinbiz')).toBeNull();
    expect(groupLinkError('https://www.facebook.com/somepage')).toMatch(/isn’t a Facebook group link/);
    expect(groupLinkError('https://evil.example/groups/x')).toMatch(/isn’t a Facebook group link/);
  });
});

describe('Manus’s instructions for groups', () => {
  const p = groupsPrompt({ groups: ['Austin Small Business', 'https://www.facebook.com/groups/123'], postAs: 'Candle Co', text: 'New candles!\n\n#handmade', media: 'image' });
  it('lists every group, posts the exact text once, and follows each group’s rules', () => {
    expect(p).toContain('1. Austin Small Business\n2. https://www.facebook.com/groups/123');
    expect(p).toContain('<<<POST TEXT\nNew candles!\n\n#handmade\nPOST TEXT>>>');
    expect(p).toMatch(/Read the group’s rules/);
    expect(p).toMatch(/never join a group/);
    expect(p).toContain('Post once in each group, straight away: don’t check whether the group already has this post.');
    expect(p).not.toMatch(/duplicate|exact text is already|do not post it again/i);
    expect(p).toMatch(/Wait about 2 minutes/);
    expect(p).toContain('Post as the Facebook Page "Candle Co"');
    expect(p).toContain('Attach the image file provided');
    expect(p).toContain('RESULT: GROUPS DONE');
  });
  it('posts as your profile when no Page is given', () => {
    expect(groupsPrompt({ groups: ['A'], postAs: '', text: 'x', media: null })).toContain('Post as the signed-in profile.');
  });
});

describe('Manus’s report', () => {
  const groups = ['Austin Small Business', 'Candle Makers', 'Etsy Sellers', 'Locals'];
  const text = ['Done.', '**GROUP:** Austin Small Business | POSTED | https://www.facebook.com/groups/1/posts/9', 'GROUP: candle makers | PENDING | waiting for admin approval', 'GROUP: Etsy Sellers | SKIPPED | No promotions allowed', 'RESULT: GROUPS DONE'].join('\n');
  it('reads each group, matched to how you listed it, with the post link', () => {
    const { results, done } = parseGroupResults(text, groups);
    expect(done).toBe(true);
    expect(results).toEqual([
      { group: 'Austin Small Business', state: 'posted', detail: 'https://www.facebook.com/groups/1/posts/9', url: 'https://www.facebook.com/groups/1/posts/9' },
      { group: 'Candle Makers', state: 'pending', detail: 'waiting for admin approval', url: undefined },
      { group: 'Etsy Sellers', state: 'skipped', detail: 'No promotions allowed', url: undefined },
    ]);
  });
  it('summarizes, including groups Manus didn’t mention', () => {
    const s = groupStateFromManus({ ...base, text }, groups);
    expect(s.state).toBe('done');
    expect(groupSummary({ results: s.results, groups })).toBe('posted in 1, 1 waiting for admin approval, 1 skipped, 1 not reported (of 4 groups)');
  });
  it('never keeps a link that isn’t Facebook', () => {
    expect(parseGroupResults('GROUP: Locals | POSTED | https://evil.example/x', groups).results[0].url).toBeUndefined();
  });
  it('maps running, waiting and unclear endings', () => {
    expect(groupStateFromManus({ ...base, done: false, status: 'running' }, groups).state).toBe('working');
    expect(groupStateFromManus({ ...base, done: false, waiting: true, status: 'waiting' }, groups).state).toBe('needs_input');
    expect(groupStateFromManus({ ...base, text: 'I posted them.' }, groups).state).toBe('finished');
    expect(groupStateFromManus({ ...base, status: 'error', error: 'boom' }, groups)).toMatchObject({ state: 'failed', message: 'boom' });
  });
});
