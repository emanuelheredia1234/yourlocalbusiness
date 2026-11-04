// Sharing a post in Facebook groups: the list you type, Manus's exact instructions, and its per-group report.
import { describe, expect, it } from 'vitest';
import type { ManusState } from './manus';
import { carriedResults, groupLinkError, groupPostText, groupRecord, groupStateFromManus, groupSummary, groupsAlreadyOut, groupsPrompt, groupsToRetry, parseGroupResults, parseGroups, rememberedGroups } from './manusGroups';

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
  it('puts the link in the text: Manus never comments in groups, and a bio there is the poster’s own', () => {
    const page = 'https://app.example/candle-co';
    const post = (caption: string) => ({ caption, hashtags: ['#candles'] });
    expect(groupPostText(post('New scents are in.\n\nGrab yours 👉 the link in the first comment'), page)).toBe(`New scents are in.\n\nGrab yours 👉 ${page}\n\n#candles`);
    expect(groupPostText(post('New scents are in.\n\nLink in bio 👆'), page)).toBe(`New scents are in.\n\n${page} 👆\n\n#candles`);
    expect(groupPostText(post('Visit candleco.com for more'), page, ['candleco.com'])).toBe(`Visit ${page} for more\n\n#candles`);
    // without a link, the text is the post's, as before
    expect(groupPostText(post('Grab yours 👉 the link in bio'), null)).toBe('Grab yours 👉 the link in bio\n\n#candles');
    // the link was going in the first comment, and the caption doesn't say so: the comment ends the text instead
    const comment = { linkPlacement: 'comment' as const, firstComment: `Shop here: ${page}` };
    expect(groupPostText({ ...post('Which scent should we make next? Tell us below.'), ...comment }, page)).toBe(`Which scent should we make next? Tell us below.\n\nShop here: ${page}\n\n#candles`);
    // once is enough: a caption that pointed to the comment gets the link in its place, with no comment added
    expect(groupPostText({ ...post('Grab yours 👉 the link in the first comment'), ...comment }, page)).toBe(`Grab yours 👉 ${page}\n\n#candles`);
    // a comment only counts while the link goes there
    expect(groupPostText({ ...post('Tell us below.'), linkPlacement: 'post', firstComment: `Shop here: ${page}` }, page)).toBe('Tell us below.\n\n#candles');
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

describe('sending to groups again', () => {
  // Manus doesn't look for an earlier copy before posting, so the groups that already have the post are left out
  const groups = ['Austin Small Business', 'Candle Makers', 'Etsy Sellers'];
  const posted = (group: string) => ({ group, state: 'posted' as const, detail: '', url: `https://www.facebook.com/groups/${group.length}/posts/1` });
  it('leaves out the groups Manus reported as posted or waiting for approval', () => {
    const results = [posted('Austin Small Business'), { group: 'Candle Makers', state: 'pending' as const, detail: 'waiting for admin approval' }];
    expect(groupsToRetry({ groups, results })).toEqual(['Etsy Sellers']);
    expect(groupsAlreadyOut({ groups, results })).toEqual(['Austin Small Business', 'Candle Makers']);
  });
  it('does so after a finished run too (a failed or unreported group is the usual reason to send again)', () => {
    const results = [posted('Austin Small Business'), { group: 'Candle Makers', state: 'failed' as const, detail: 'couldn’t find the group' }];
    expect(groupsToRetry({ groups, results })).toEqual(['Candle Makers', 'Etsy Sellers']);
  });
  it('offers skipped and failed groups again, and every group when nothing was reported', () => {
    expect(groupsToRetry({ groups, results: [{ group: 'Etsy Sellers', state: 'failed', detail: 'x' }, { group: 'Candle Makers', state: 'skipped', detail: 'no promotions' }] })).toEqual(groups);
    expect(groupsToRetry({ groups, results: [] })).toEqual(groups);
  });
  it('offers every group when all of them already have it (a new share: the window says it posts twice)', () => {
    const results = groups.map(posted);
    expect(groupsToRetry({ groups, results })).toEqual(groups);
    expect(groupsAlreadyOut({ groups, results })).toEqual(groups);
  });
  it('keeps the earlier groups’ results on the post, and counts them', () => {
    // run 1: Austin posted; run 2 (sent to the other two): Candle Makers posted, Etsy Sellers not reported
    const run1 = { groups, results: [posted('Austin Small Business')] };
    const earlier = carriedResults(run1, ['Candle Makers', 'Etsy Sellers']);
    expect(earlier).toEqual([posted('Austin Small Business')]);
    const run2 = { groups: ['Candle Makers', 'Etsy Sellers'], results: [posted('Candle Makers')], earlier };
    expect(groupRecord(run2)).toEqual({ groups, results: [posted('Austin Small Business'), posted('Candle Makers')] });
    expect(groupSummary(groupRecord(run2))).toBe('posted in 2, 1 not reported (of 3 groups)');
    expect(groupsToRetry(run2)).toEqual(['Etsy Sellers']);
    // a third send keeps both
    expect(carriedResults(run2, ['Etsy Sellers'])).toEqual([posted('Austin Small Business'), posted('Candle Makers')]);
    // a group sent again is reported by the new run, not kept
    expect(carriedResults(run2, ['Austin Small Business', 'Etsy Sellers'])).toEqual([posted('Candle Makers')]);
  });
  it('remembers the list you had plus the groups you added, once each, up to 10', () => {
    expect(rememberedGroups(groups, ['Etsy Sellers', 'https://www.facebook.com/groups/candlemakers'])).toEqual([...groups, 'https://www.facebook.com/groups/candlemakers']);
    expect(rememberedGroups(['Candle Makers'], ['candle makers', 'Candle Makers'])).toEqual(['Candle Makers']);
    // over 10, the groups just sent stay
    const nine = Array.from({ length: 9 }, (_, i) => `Group ${i + 1}`);
    expect(rememberedGroups(nine, ['New A', 'New B'])).toEqual([...nine.slice(0, 8), 'New A', 'New B']);
    // a group the last run reported failed and you didn't send again (often a name you corrected) is dropped
    const ten = [...nine, 'Candle Makers'];
    expect(rememberedGroups(ten, ['Candle Makers of Texas'], ['Candle Makers'])).toEqual([...nine, 'Candle Makers of Texas']);
    // unless you sent it again
    expect(rememberedGroups(['Candle Makers'], ['Candle Makers'], ['Candle Makers'])).toEqual(['Candle Makers']);
  });
  it('treats the same group typed differently (case, trailing slash) as one', () => {
    const link = 'https://www.facebook.com/groups/austinbiz';
    const run1 = { groups: [link, 'Candle Makers'], results: [{ group: link, state: 'pending' as const, detail: '' }, posted('Candle Makers')] };
    // re-added with a trailing slash: the new run reports it, the old result isn't kept beside it
    expect(carriedResults(run1, [`${link}/`])).toEqual([posted('Candle Makers')]);
    expect(carriedResults(run1, ['candle makers'])).toEqual([{ group: link, state: 'pending', detail: '' }]);
    const run2 = { groups: [`${link}/`], results: [], earlier: [{ group: link, state: 'pending' as const, detail: '' }] };
    expect(groupRecord(run2).groups).toEqual([`${link}/`]);
    expect(groupsToRetry({ groups: ['Candle Makers'], results: [posted('candle makers')] })).toEqual(['Candle Makers']);
    expect(groupsAlreadyOut({ groups: ['Candle Makers', 'Etsy'], results: [posted('candle makers')] })).toEqual(['Candle Makers']);
  });
});
