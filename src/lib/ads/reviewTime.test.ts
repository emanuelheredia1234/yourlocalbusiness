// Meta's review time, said the same way in every place: about 10 minutes, sometimes up to 24 hours, live once
// approved; a paused launch is reviewed when it is turned on. Google keeps its own wording everywhere. (The campaign
// row's "In review" line is the server's: server/ads/reads.test.mjs.)
import { describe, expect, it } from 'vitest';
import { APP_GUIDE } from '@/ai/assistant/guide';
import { META_IN_REVIEW, META_REVIEW_ON_RESUME, META_REVIEW_TIME, META_REVIEW_WHEN_ON, launchedMessage, resumedMessage } from './reviewTime';

describe('Meta’s review time', () => {
  it('every sentence says about 10 minutes, up to 24 hours, and live once approved', () => {
    for (const t of [META_REVIEW_TIME, META_REVIEW_WHEN_ON, META_REVIEW_ON_RESUME, META_IN_REVIEW]) {
      expect(t).toContain('about 10 minutes (sometimes up to 24 hours)');
      expect(t).toContain('goes live once approved');
    }
  });

  it('after a launch: Active says the review takes about 10 minutes; Paused says it starts when turned on; Google says nothing', () => {
    expect(launchedMessage('meta', 'ACTIVE')).toEqual({ kind: 'success', title: 'Launching on Meta', body: META_REVIEW_TIME });
    expect(launchedMessage('meta', 'PAUSED')).toEqual({ kind: 'success', title: 'Launching on Meta, paused', body: META_REVIEW_WHEN_ON });
    expect(META_REVIEW_WHEN_ON).toBe('It starts paused. Meta reviews new ads when you turn it on, usually in about 10 minutes (sometimes up to 24 hours). It goes live once approved.');
    expect(launchedMessage('google', 'ACTIVE')).toBeNull();
    expect(launchedMessage('google', 'PAUSED')).toBeNull();
  });

  it('after a resume: Meta reviews ads it hasn’t approved yet first; Google says nothing', () => {
    expect(resumedMessage('meta')).toEqual({ kind: 'success', title: 'Turning it on at Meta', body: META_REVIEW_ON_RESUME });
    expect(resumedMessage('google')).toBeNull();
  });

  it('the assistant’s guide says it where it describes launching', () => {
    const ads = APP_GUIDE.split('\n').find((l) => l.startsWith('- #marketing-ads:')) ?? '';
    expect(ads).toContain('launched on Meta and Google');
    expect(ads).toContain('Meta reviews new ads before they run, usually in about 10 minutes (sometimes up to 24 hours), and a campaign goes live once approved; a campaign launched paused is reviewed when it is turned on.');
  });
});
