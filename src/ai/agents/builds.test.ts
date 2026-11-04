// Builds by Manus or Viktor: a start that sends the images first and the request once; an uncertain send settled by
// reading (never sent again); every read mapped to the build's state; the project saved only when something changed;
// the watcher's order, limit and 3-day give-up; Stop; and paid follow-ups that ask first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBuild, ManusRead, ViktorMessage, ViktorRead } from '@/lib/agentTypes';
import type { MediaRef, PromptImage } from '@/lib/types';

vi.mock('@/ai/agents/api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  sendImages: vi.fn(),
  manusStart: vi.fn(),
  manusSend: vi.fn(),
  manusRead: vi.fn(),
  manusHtml: vi.fn(),
  manusStop: vi.fn(),
  manusVerify: vi.fn(),
  viktorSend: vi.fn(),
  viktorRead: vi.fn(),
  viktorVerify: vi.fn(),
  viktorHtml: vi.fn(),
}));

const api = await import('./api');
const { AgentError } = api;
const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { useBusy } = await import('@/lib/busy');
const builds = await import('./builds');
const { buildsOf, findBuild, patchBuild, addBuild } = await import('./buildRecords');

const m = vi.mocked(api);
const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, thumb: 'data:image/jpeg;base64,AAAA' });
const img = (n: number, note?: string): PromptImage => ({ key: `img-${n}`, media: media(`m${n}`), ...(note ? { note } : {}) });
const PID = 'proj_b1';
const yes = async () => true;
const no = async () => false;

function reset() {
  const p = { ...newProject('business', 'new'), id: PID };
  p.brand = { ...p.brand, name: 'Calm Studio' };
  useStore.setState({ projects: [p], activeProjectId: PID, settings: defaultSettings(), notices: [] });
  useBusy.setState({ jobs: {} });
  builds.resetBuildMemory();
  vi.clearAllMocks();
  m.sendImages.mockImplementation(async (_via, images) => images.map((i) => ({ id: `file-${i.key}`, filename: `${i.key}.jpg` })));
}

const input = (via: 'manus' | 'viktor', extra: Partial<Parameters<typeof builds.startBuild>[0]> = {}) => ({
  projectId: PID,
  via,
  target: 'asset' as const,
  kind: 'booking',
  request: '  A booking widget for my yoga classes  ',
  website: 'https://calm.example',
  images: [img(1, 'our studio'), img(2)],
  facts: [{ id: 'name' as const, value: 'Calm Studio' }],
  ...extra,
});

const build = (patch: Partial<AgentBuild> = {}): AgentBuild => ({
  id: patch.id ?? 'build_x',
  via: 'viktor',
  target: 'asset',
  kind: 'booking',
  request: 'A booking widget',
  website: '',
  images: [],
  state: 'working',
  requestedAt: Date.now() - 60_000,
  lastSentAt: Date.now() - 60_000,
  ref: 'ylb-AAAAAA',
  rounds: 1,
  threadId: 'vk_aaaaaaaaaaaaaaaaaaaaaa',
  permalink: 'https://slack.example/p1',
  ...patch,
});

const manusRead = (patch: Partial<ManusRead> = {}): ManusRead => ({ status: 'running', waiting: null, background: false, credits: 0, taskUrl: 'https://manus.im/app/t1', events: [], truncated: false, webdev: false, ...patch });
const msg = (patch: Partial<ViktorMessage>): ViktorMessage => ({ ts: '1793723990.000100', from: 'viktor', via: 'slack', where: 'thread', text: '', edited: null, files: [], html: null, ...patch });
const thread = (patch: Partial<ViktorRead> = {}): ViktorRead => ({ threadId: 'vk_aaaaaaaaaaaaaaaaaaaaaa', state: 'waiting', messages: [], latestHtml: null, permalink: 'https://slack.example/p1', sinceTs: '1793723980.000100', checkedAt: Date.now(), ...patch });

beforeEach(reset);
afterEach(() => vi.useRealTimers());

describe('starting a build', () => {
  it('Manus: images first, then the request once; the build is working with its task', async () => {
    m.manusStart.mockResolvedValue({ taskId: 't1', taskUrl: 'https://manus.im/app/t1' });
    const r = await builds.startBuild(input('manus', { profile: 'max-high', ref: 'ylb-WINDOW' }));
    expect(r.outcome).toBe('sent');
    expect(m.sendImages).toHaveBeenCalledTimes(1);
    expect(m.manusStart).toHaveBeenCalledTimes(1);
    expect(m.manusStart.mock.calls[0][0]).toEqual({
      fn: 'build',
      build: { target: 'asset', kind: 'booking', facts: [{ id: 'name', value: 'Calm Studio' }], website: 'https://calm.example', request: 'A booking widget for my yoga classes', images: [{ key: 'img-1', note: 'our studio' }, { key: 'img-2', note: '' }] },
      files: [{ id: 'file-img-1', filename: 'img-1.jpg' }, { id: 'file-img-2', filename: 'img-2.jpg' }],
      ref: 'ylb-WINDOW',
      profile: 'max-high',
    });
    const b = buildsOf(PID)[0];
    expect(b).toMatchObject({ via: 'manus', state: 'working', taskId: 't1', taskUrl: 'https://manus.im/app/t1', rounds: 1, ref: 'ylb-WINDOW', profile: 'max-high' });
    // images are kept without their thumbnails (the project stays small)
    expect(b.images.every((i) => i.media.thumb === undefined)).toBe(true);
    // nothing is left "sending" in the leave guard
    expect(useBusy.getState().jobs).toEqual({});
  });

  it('Viktor: the thread is saved', async () => {
    m.viktorSend.mockResolvedValue({ threadId: 'vk_bbbbbbbbbbbbbbbbbbbbbb', permalink: 'https://slack.example/p2', ts: '1.2', located: true, sentAt: Date.now() });
    const r = await builds.startBuild(input('viktor'));
    expect(r.outcome).toBe('sent');
    expect(m.viktorSend.mock.calls[0][0]).toMatchObject({ kind: 'build', ref: expect.stringMatching(/^ylb-[A-Z0-9]{6}$/) });
    expect(buildsOf(PID)[0]).toMatchObject({ state: 'working', threadId: 'vk_bbbbbbbbbbbbbbbbbbbbbb', permalink: 'https://slack.example/p2' });
  });

  it('an image that couldn’t be sent: failed, and nothing was sent', async () => {
    m.sendImages.mockRejectedValue(new AgentError('Couldn’t send image 2 to Viktor: its file couldn’t be loaded.', 'NOT_SENT'));
    const r = await builds.startBuild(input('viktor'));
    expect(r.outcome).toBe('failed');
    expect(m.viktorSend).not.toHaveBeenCalled();
    expect(buildsOf(PID)[0]).toMatchObject({ state: 'failed', message: 'Couldn’t send image 2 to Viktor: its file couldn’t be loaded. Nothing was sent.' });
  });

  it('refused as too long: nothing kept, and the window can say so', async () => {
    m.manusStart.mockRejectedValue(new AgentError('Too long', 'TOO_LONG', { chars: 13000, limit: 12000 }));
    const r = await builds.startBuild(input('manus'));
    expect(r.outcome).toBe('refused');
    expect(buildsOf(PID)).toEqual([]);
  });

  it('refused for another reason: failed, with the reason', async () => {
    m.viktorSend.mockRejectedValue(new AgentError('channel_not_found', 'NOT_SENT'));
    expect((await builds.startBuild(input('viktor'))).outcome).toBe('failed');
    expect(buildsOf(PID)[0]).toMatchObject({ state: 'failed', message: 'Not sent: channel_not_found.' });
  });
});

describe('a send that may have been delivered', () => {
  it('is checked by reading, never sent again: found → working', async () => {
    m.viktorSend.mockRejectedValue(new AgentError('dropped', 'SEND_UNKNOWN'));
    m.viktorVerify.mockResolvedValue({ threadId: 'vk_cccccccccccccccccccccc', permalink: 'https://slack.example/p3', ts: '1.3', located: true, sentAt: Date.now() });
    const r = await builds.startBuild(input('viktor'));
    expect(r.outcome).toBe('unknown');
    await vi.waitFor(() => expect(buildsOf(PID)[0].state).toBe('working'));
    expect(buildsOf(PID)[0]).toMatchObject({ threadId: 'vk_cccccccccccccccccccccc', permalink: 'https://slack.example/p3' });
    expect(m.viktorSend).toHaveBeenCalledTimes(1);
    expect(m.viktorVerify.mock.calls[0][0]).toMatchObject({ ref: buildsOf(PID)[0].ref });
  });

  it('not found after two checks about 30 s apart → failed, “Not delivered”', async () => {
    vi.useFakeTimers();
    m.manusStart.mockRejectedValue(new AgentError('dropped', 'SEND_UNKNOWN'));
    m.manusVerify.mockResolvedValue(null);
    await builds.startBuild(input('manus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(buildsOf(PID)[0].state).toBe('unknown_start');
    expect(m.manusVerify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(builds.VERIFY_GAP);
    expect(m.manusVerify).toHaveBeenCalledTimes(2);
    expect(buildsOf(PID)[0]).toMatchObject({ state: 'failed', message: 'Not delivered: you can send it again.' });
    expect(m.manusStart).toHaveBeenCalledTimes(1);
  });

  it('a build left “sending” by a closed tab becomes uncertain and is checked', async () => {
    addBuild(PID, build({ id: 'b_old', state: 'sending', via: 'manus', threadId: undefined, lastSentAt: Date.now() - 3 * 60_000, requestedAt: Date.now() - 3 * 60_000 }));
    m.manusVerify.mockResolvedValue({ taskId: 't9', taskUrl: 'https://manus.im/app/t9' });
    await builds.buildWatchTick();
    expect(findBuild(PID, 'b_old')).toMatchObject({ state: 'working', taskId: 't9' });
  });
});

describe('reads', () => {
  it('Manus, each build state', () => {
    const b = (state: NonNullable<ManusRead['build']>['state'], reason = '', result: NonNullable<ManusRead['build']>['result'] = null) => ({ state, reason, result });
    expect(builds.fromManus(manusRead({ build: b('working') }))).toMatchObject({ state: 'working', message: undefined });
    expect(builds.fromManus(manusRead({ background: true, build: b('working', 'Manus is still finishing in the background.') }))).toMatchObject({ state: 'working', message: 'Manus is still finishing in the background.' });
    expect(builds.fromManus(manusRead({ credits: 41, build: b('built', '', { at: 'e4:0', filename: 'page.html', bytes: 900, source: 'file' }) }))).toEqual({ state: 'built', result: { at: 'e4:0', filename: 'page.html', bytes: 900, source: 'file' }, message: undefined, credits: 41 });
    expect(builds.fromManus(manusRead({ waiting: { type: 'messageAskUser', text: 'Which colors do you prefer?', answerHere: true }, build: b('needs_you') }))).toMatchObject({ state: 'needs_you', message: 'Manus asks: Which colors do you prefer?' });
    expect(builds.fromManus(manusRead({ waiting: { type: 'needConnectMyBrowser', text: 'Connect your browser', answerHere: false }, build: b('needs_you') })).message).toBe('Manus is waiting for you to approve something in Manus: Connect your browser Approve it in Manus.');
    expect(builds.fromManus(manusRead({ build: b('no_file', 'Manus sent page.zip, not one HTML file.') }))).toMatchObject({ state: 'needs_you', message: 'Manus sent page.zip, not one HTML file.' });
    expect(builds.fromManus(manusRead({ build: b('failed', 'QA: couldn’t open the website') }))).toMatchObject({ state: 'failed', message: 'QA: couldn’t open the website.' });
  });

  it('Manus: what it said after our latest request (newest first), cut to 600 characters', () => {
    const events: ManusRead['events'] = [
      { id: 'e3', type: 'assistant', at: 3, text: `Which colors? ${'x'.repeat(700)}`, files: [] },
      { id: 'e2', type: 'user', at: 2, text: 'Build ONE web page…', files: [] },
      { id: 'e1', type: 'assistant', at: 1, text: 'old words', files: [] },
    ];
    const said = builds.fromManus(manusRead({ events, build: { state: 'needs_you', reason: 'waiting', result: null } })).said!;
    expect(said.startsWith('Which colors?')).toBe(true);
    expect(said.length).toBe(builds.SAID_MAX);
  });

  it('Viktor, each thread state', () => {
    const now = Date.now();
    expect(builds.fromViktor(thread({ state: 'waiting' }))).toMatchObject({ state: 'working' });
    expect(builds.fromViktor(thread({ state: 'sent_unlocated' }))).toMatchObject({ state: 'working' });
    expect(builds.fromViktor(thread({ state: 'built', latestHtml: { at: '1793723990.000100', bytes: 9400, source: 'code', filename: 'page.html' } }))).toEqual({ state: 'built', result: { at: '1793723990.000100', filename: 'page.html', bytes: 9400, source: 'code' }, message: undefined });
    expect(builds.fromViktor(thread({ state: 'replied', messages: [msg({ text: 'Which colors do you prefer?' })] }))).toEqual({ state: 'needs_you', message: 'Viktor replied without the page.', said: 'Which colors do you prefer?' });
    expect(builds.fromViktor(thread({ state: 'link_only', messages: [msg({ text: 'Here: https://qa-hosted.example/page' })] }))).toMatchObject({ state: 'needs_you', message: 'Viktor sent a link instead of the page.' });
    expect(builds.fromViktor(thread({ state: 'gone' }))).toMatchObject({ state: 'failed', message: 'This request was deleted in Slack.' });
    // part of a page: Viktor may still be writing for 2 minutes
    const young = String((now - 30_000) / 1000);
    const old = String((now - 3 * 60_000) / 1000);
    expect(builds.fromViktor(thread({ state: 'partial', messages: [msg({ ts: young })] }), now)).toMatchObject({ state: 'working' });
    expect(builds.fromViktor(thread({ state: 'partial', messages: [msg({ ts: old })] }), now)).toMatchObject({ state: 'needs_you', message: 'Viktor sent only part of the page.' });
    // someone else's words are never kept
    expect(builds.fromViktor(thread({ state: 'replied', messages: [msg({ from: 'other', text: '' })] })).said).toBeUndefined();
  });

  it('a build the agent’s service doesn’t have any more fails; a read that fails otherwise is tried later', async () => {
    addBuild(PID, build({ id: 'b1' }));
    m.viktorRead.mockResolvedValueOnce({ threads: [], errors: { vk_aaaaaaaaaaaaaaaaaaaaaa: { code: 'NOT_FOUND', message: 'gone' } } });
    await builds.checkBuilds([{ projectId: PID, id: 'b1' }]);
    expect(findBuild(PID, 'b1')).toMatchObject({ state: 'failed', message: 'This build is older than 30 days, or wasn’t started by this app.' });
    addBuild(PID, build({ id: 'b2', threadId: 'vk_dddddddddddddddddddddd' }));
    m.viktorRead.mockRejectedValueOnce(new AgentError('down', 'NETWORK'));
    await builds.checkBuilds([{ projectId: PID, id: 'b2' }]);
    expect(findBuild(PID, 'b2')?.state).toBe('working');
  });

  it('the project is saved only when something changed (checking every few seconds saves nothing)', async () => {
    addBuild(PID, build({ id: 'b1' }));
    const real = useStore.getState().updateProject;
    const spy = vi.fn(real);
    useStore.setState({ updateProject: spy });
    m.viktorRead.mockResolvedValue({ threads: [thread({ state: 'waiting' })], errors: {} });
    for (let i = 0; i < 4; i++) await builds.checkBuilds([{ projectId: PID, id: 'b1' }]);
    expect(spy).not.toHaveBeenCalled();
    m.viktorRead.mockResolvedValue({ threads: [thread({ state: 'built', latestHtml: { at: '9.1', bytes: 10, source: 'code', filename: 'page.html' } })], errors: {} });
    await builds.checkBuilds([{ projectId: PID, id: 'b1' }]);
    await builds.checkBuilds([{ projectId: PID, id: 'b1' }]);
    expect(spy).toHaveBeenCalledTimes(1);
    useStore.setState({ updateProject: real });
  });

  it('Viktor builds are read together; a build that’s built is announced once (toast and bell)', async () => {
    addBuild(PID, build({ id: 'b1' }));
    addBuild(PID, build({ id: 'b2', threadId: 'vk_eeeeeeeeeeeeeeeeeeeeee' }));
    m.viktorRead.mockResolvedValue({ threads: [thread({ state: 'built', latestHtml: { at: '9.1', bytes: 10, source: 'code', filename: 'page.html' } }), thread({ threadId: 'vk_eeeeeeeeeeeeeeeeeeeeee' })], errors: {} });
    await builds.checkBuilds([{ projectId: PID, id: 'b1' }, { projectId: PID, id: 'b2' }]);
    expect(m.viktorRead).toHaveBeenCalledTimes(1);
    expect(m.viktorRead.mock.calls[0][0]).toEqual(['vk_aaaaaaaaaaaaaaaaaaaaaa', 'vk_eeeeeeeeeeeeeeeeeeeeee']);
    expect(findBuild(PID, 'b1')?.state).toBe('built');
    await builds.checkBuilds([{ projectId: PID, id: 'b1' }]);
    expect(useStore.getState().notices.map((n) => n.title)).toEqual(['Viktor built your booking widget for Calm Studio']);
  });
});

describe('the watcher', () => {
  it('checks at most 3 waiting builds, least recently checked first; nothing while the tab is hidden', async () => {
    const now = Date.now();
    for (const id of ['a', 'b', 'c', 'd']) addBuild(PID, build({ id, threadId: `vk_${id.repeat(22)}`, via: 'viktor' }));
    addBuild(PID, build({ id: 'done', state: 'built' }));
    m.viktorRead.mockResolvedValue({ threads: [], errors: {} });
    expect(await builds.buildWatchTick({ hidden: true })).toBe(0);
    expect(await builds.buildWatchTick({ now })).toBe(3);
    const first = m.viktorRead.mock.calls[0][0];
    expect(first).toHaveLength(3);
    expect(await builds.buildWatchTick({ now: now + 45_000 })).toBe(3);
    // the one not checked the first time goes first now
    const second = m.viktorRead.mock.calls[1][0];
    const missed = ['a', 'b', 'c', 'd'].map((x) => `vk_${x.repeat(22)}`).find((t) => !first.includes(t));
    expect(second[0]).toBe(missed);
  });

  it('gives up after 3 days: failed, “Stopped checking after 3 days”', async () => {
    const long = Date.now() - builds.GIVE_UP_AFTER - 1000;
    addBuild(PID, build({ id: 'b1', via: 'manus', taskId: 't1', threadId: undefined, requestedAt: long, lastSentAt: long }));
    await builds.buildWatchTick();
    expect(findBuild(PID, 'b1')).toMatchObject({ state: 'failed', message: 'Stopped checking after 3 days: open it in Manus.' });
    expect(m.manusRead).not.toHaveBeenCalled();
  });

  it('a card checks every 6 s for 2 minutes, then every 15 s until 10 minutes, then leaves it to the watcher', () => {
    const now = Date.now();
    expect(builds.cardCadence(build({ lastSentAt: now - 60_000 }), now)).toBe(6_000);
    expect(builds.cardCadence(build({ lastSentAt: now - 5 * 60_000 }), now)).toBe(15_000);
    expect(builds.cardCadence(build({ lastSentAt: now - 11 * 60_000 }), now)).toBeNull();
    expect(builds.cardCadence(build({ state: 'built' }), now)).toBeNull();
  });
});

describe('stop', () => {
  it('Manus: after the owner confirms, the task is stopped', async () => {
    addBuild(PID, build({ id: 'b1', via: 'manus', taskId: 't1', threadId: undefined }));
    expect(await builds.stopBuild(PID, 'b1', { confirm: no })).toBe(false);
    expect(m.manusStop).not.toHaveBeenCalled();
    expect(await builds.stopBuild(PID, 'b1', { confirm: yes })).toBe(true);
    expect(m.manusStop).toHaveBeenCalledWith('t1');
    expect(findBuild(PID, 'b1')?.state).toBe('stopped');
  });

  it('Viktor: Stop waiting sends nothing to Slack', async () => {
    addBuild(PID, build({ id: 'b1' }));
    await builds.stopBuild(PID, 'b1');
    expect(findBuild(PID, 'b1')?.state).toBe('stopped');
    expect(m.viktorSend).not.toHaveBeenCalled();
  });

  it('a stopped build only changes when a page arrived meanwhile', async () => {
    addBuild(PID, build({ id: 'b1', state: 'stopped' }));
    m.viktorRead.mockResolvedValueOnce({ threads: [thread({ state: 'replied', messages: [msg({ text: 'Done?' })] })], errors: {} });
    await builds.checkNow(PID, 'b1');
    expect(findBuild(PID, 'b1')?.state).toBe('stopped');
    m.viktorRead.mockResolvedValueOnce({ threads: [thread({ state: 'built', latestHtml: { at: '9.1', bytes: 10, source: 'code', filename: 'page.html' } })], errors: {} });
    await builds.checkNow(PID, 'b1');
    expect(findBuild(PID, 'b1')?.state).toBe('built');
  });
});

describe('follow-ups', () => {
  it('ask first (who and cost): no → nothing is sent', async () => {
    addBuild(PID, build({ id: 'b1', state: 'needs_you' }));
    const confirm = vi.fn(async (_c: { title: string; body: string; confirmLabel: string }) => false);
    expect(await builds.sendFollowup(PID, 'b1', { kind: 'answer', text: 'Blue' }, { confirm })).toEqual({ outcome: 'cancelled' });
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Send this to Viktor?', confirmLabel: 'Send (uses Viktor credits)' });
    expect(confirm.mock.calls[0][0].body).toContain('Viktor’s work counts toward your viktor.com plan');
    expect(m.viktorSend).not.toHaveBeenCalled();
  });

  it('an answer, once; the build is working on a new round', async () => {
    addBuild(PID, build({ id: 'b1', state: 'needs_you', said: 'Which colors?' }));
    m.viktorSend.mockResolvedValue({ threadId: 'vk_aaaaaaaaaaaaaaaaaaaaaa', permalink: '', ts: '2.1', located: true, sentAt: Date.now() });
    expect(await builds.sendFollowup(PID, 'b1', { kind: 'answer', text: ' Blue and green ' }, { confirm: yes })).toEqual({ outcome: 'sent' });
    expect(m.viktorSend.mock.calls[0][0]).toMatchObject({ kind: 'answer', threadId: 'vk_aaaaaaaaaaaaaaaaaaaaaa', text: 'Blue and green' });
    expect(findBuild(PID, 'b1')).toMatchObject({ state: 'working', rounds: 2 });
    expect(findBuild(PID, 'b1')?.said).toBeUndefined();
  });

  it('Ask for changes: new images go first and join the build’s images', async () => {
    addBuild(PID, build({ id: 'b1', via: 'manus', taskId: 't1', threadId: undefined, state: 'built', images: [img(1), img(2)] }));
    m.manusSend.mockResolvedValue();
    await builds.sendFollowup(PID, 'b1', { kind: 'edit', text: 'Darker', images: [img(3, 'logo')] }, { confirm: yes });
    expect(m.sendImages.mock.calls[0][1].map((i) => i.key)).toEqual(['img-3']);
    expect(m.manusSend).toHaveBeenCalledWith({ taskId: 't1', edit: { text: 'Darker', images: [{ key: 'img-3', note: 'logo' }] }, files: [{ id: 'file-img-3', filename: 'img-3.jpg' }] });
    expect(findBuild(PID, 'b1')?.images.map((i) => i.key)).toEqual(['img-1', 'img-2', 'img-3']);
  });

  it('“Ask for the page as one file” is the fixed follow-up', async () => {
    addBuild(PID, build({ id: 'b1', via: 'manus', taskId: 't1', threadId: undefined, state: 'needs_you' }));
    await builds.sendFollowup(PID, 'b1', { kind: 'missing_file' }, { confirm: yes });
    expect(m.manusSend).toHaveBeenCalledWith({ taskId: 't1', followup: 'missing_file' });
  });

  it('a follow-up that may have arrived is checked in the task, not sent again', async () => {
    addBuild(PID, build({ id: 'b1', via: 'manus', taskId: 't1', threadId: undefined, state: 'built' }));
    m.manusSend.mockRejectedValue(new AgentError('dropped', 'SEND_UNKNOWN'));
    m.manusRead.mockResolvedValue(manusRead({ events: [{ id: 'e9', type: 'user', at: Date.now(), text: 'Change page.html…', files: [] }] }));
    expect(await builds.sendFollowup(PID, 'b1', { kind: 'edit', text: 'Darker', images: [] }, { confirm: yes })).toEqual({ outcome: 'unknown' });
    await vi.waitFor(() => expect(findBuild(PID, 'b1')?.state).toBe('working'));
    expect(m.manusSend).toHaveBeenCalledTimes(1);
    expect(m.manusVerify).not.toHaveBeenCalled();
  });

  it('refused: the build stays as it was', async () => {
    addBuild(PID, build({ id: 'b1', state: 'built' }));
    m.viktorSend.mockRejectedValue(new AgentError('Too long', 'TOO_LONG', { chars: 4000, limit: 3900 }));
    const r = await builds.sendFollowup(PID, 'b1', { kind: 'edit', text: 'x', images: [] }, { confirm: yes });
    expect(r.outcome).toBe('refused');
    expect(findBuild(PID, 'b1')).toMatchObject({ state: 'built', rounds: 1 });
  });
});

describe('the build list', () => {
  it('keeps at most 20 builds, dropping the oldest finished ones first (never one in flight)', () => {
    for (let i = 0; i < 25; i++) addBuild(PID, build({ id: `b${i}`, state: i < 3 ? 'working' : i < 10 ? 'failed' : 'imported' }));
    const list = buildsOf(PID);
    expect(list).toHaveLength(20);
    for (const id of ['b0', 'b1', 'b2']) expect(list.some((b) => b.id === id)).toBe(true);
  });

  it('patchBuild writes only real changes, and removes fields set to undefined', () => {
    addBuild(PID, build({ id: 'b1', message: 'x' }));
    const before = useStore.getState().projects[0];
    patchBuild(PID, 'b1', { state: 'working' });
    expect(useStore.getState().projects[0]).toBe(before);
    patchBuild(PID, 'b1', { message: undefined });
    expect('message' in findBuild(PID, 'b1')!).toBe(false);
  });
});
