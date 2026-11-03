// The in-app scheduler never marks a post published that Manus is handling: only Facebook does that
// (or the app, once Manus reports it posted or scheduled it there).
import { describe, expect, it } from 'vitest';
import { useStore } from './useStore';

const post = (id: string, extra: object) => ({ id, projectId: 'p', status: 'scheduled', platform: 'facebook', format: 'image', style: 'minimal', postType: 'tip', headline: id, visualPrompt: '', caption: '', hashtags: [], scheduledAt: '2026-11-03T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...extra }) as never;

describe('the in-app scheduler and Manus', () => {
  it('leaves posts Manus is still working on (or failed) alone', () => {
    const ext = (state: string) => ({ external: { via: 'manus', network: 'facebook', mode: 'now', taskId: 't', taskUrl: '', state, message: '', page: '', scheduledFor: '', requestedAt: 1, checkedAt: 1 } });
    useStore.setState({ posts: [post('plain', {}), post('working', ext('working')), post('needs', ext('needs_input')), post('failed', ext('failed')), post('fbscheduled', { ...ext('scheduled'), external: { ...ext('scheduled').external, mode: 'schedule' } })] });
    const due = useStore.getState().autoPublishDue(Date.parse('2026-11-03T11:00:00Z')).map((p) => p.id);
    expect(due.sort()).toEqual(['fbscheduled', 'plain']);
    const status = Object.fromEntries(useStore.getState().posts.map((p) => [p.id, p.status]));
    expect(status).toMatchObject({ working: 'scheduled', needs: 'scheduled', failed: 'scheduled', plain: 'published', fbscheduled: 'published' });
  });
});
