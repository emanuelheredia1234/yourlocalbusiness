import { beforeEach, describe, expect, it } from 'vitest';
import { beginBusy, busyId, busyJobs, endBusy, leaveMessage, useBusy } from './busy';

describe('what is generating', () => {
  beforeEach(() => useBusy.setState({ jobs: {} }));

  it('lists jobs while they run, and ending one twice is harmless', () => {
    const a = busyId('post');
    const b = busyId('manus');
    expect(a).not.toBe(b);
    beginBusy(a, 'Social post');
    beginBusy(b, 'Sending to Manus', 'app');
    expect(busyJobs().map((j) => j.label)).toEqual(['Social post', 'Sending to Manus']);
    expect(busyJobs('page').map((j) => j.id)).toEqual([a]);
    endBusy(a);
    endBusy(a);
    expect(busyJobs('page')).toEqual([]);
    expect(busyJobs('app')).toHaveLength(1);
  });

  it('warns only about what stops when you leave the page', () => {
    expect(leaveMessage([])).toBeNull();
    expect(leaveMessage([{ id: 'x', label: 'Sending to Manus', scope: 'app' }])).toBeNull();
    const one = leaveMessage([{ id: 'x', label: 'Social post', scope: 'page' }]);
    expect(one?.body).toBe('“Social post” is still being generated. If you leave this page, the generation will stop and what it was making won’t be kept.');
    const two = leaveMessage([
      { id: 'x', label: 'Social post', scope: 'page' },
      { id: 'y', label: 'AI image', scope: 'page' },
      { id: 'z', label: 'Social post', scope: 'page' },
    ]);
    expect(two?.body).toMatch(/^2 things are still being generated: Social post, AI image\./);
  });
});
