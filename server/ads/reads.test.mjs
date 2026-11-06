// Reading verdicts and the tree (server/ads/reads.mjs): Google's review fields, Meta's paused-but-approved ads, and a
// campaign that is refused only when every one of its ads is.
import { describe, expect, it } from 'vitest';
import { adsNotApproved, stateFromNode, verdictOf } from './reads.mjs';

describe('verdictOf', () => {
  it('reads Google’s approvalStatus (its reviewStatus is REVIEWED)', () => {
    expect(verdictOf({ approved: false, approvalStatus: 'DISAPPROVED', reviewStatus: 'REVIEWED', policyTopics: [{ topic: 'x' }] })).toBe('rejected');
    expect(verdictOf({ approved: true, approvalStatus: 'APPROVED_LIMITED', reviewStatus: 'REVIEWED' })).toBe('with_issues');
    expect(verdictOf({ approved: true, approvalStatus: 'APPROVED', reviewStatus: 'REVIEWED' })).toBe('approved');
    expect(verdictOf({ approved: false, approvalStatus: 'UNKNOWN', reviewStatus: 'REVIEW_IN_PROGRESS' })).toBe('in_review');
  });

  it('Meta: DISAPPROVED is refused; an ad under a paused campaign with no rejection has left review', () => {
    expect(verdictOf({ approved: false, reviewStatus: 'DISAPPROVED', rejections: [{ reasons: ['x'] }] })).toBe('rejected');
    expect(verdictOf({ approved: false, reviewStatus: 'CAMPAIGN_PAUSED', rejections: [] })).toBe('approved');
    expect(verdictOf({ approved: false, reviewStatus: 'PENDING_REVIEW', rejections: [] })).toBe('in_review');
    expect(verdictOf({ approved: true, reviewStatus: 'ACTIVE' })).toBe('approved');
  });
});

describe('stateFromNode', () => {
  const row = { state: 'in_review', configured_status: 'ACTIVE', review: {}, remote: { zernioAdIds: ['z1', 'z2', 'z3'] } };
  const node = (verdicts, extra = {}) => ({ status: 'rejected', reviewStatus: 'rejected', configuredStatus: 'ACTIVE', adSets: [{ ads: verdicts.map((v, i) => ({ _id: `z${i + 1}`, reviewStatus: v })) }], ...extra });

  it('one refused ad of three keeps the campaign running and names the refused ad', () => {
    const s = stateFromNode(row, node(['approved', 'rejected', 'approved']));
    expect(s.state).not.toBe('rejected');
    expect(s.reviewPatch.adsRejected).toEqual(['z2']);
    expect(adsNotApproved({ ...row, review: s.reviewPatch })).toEqual({ count: 1, of: 3 });
  });

  it('every ad refused: the campaign is refused', () => {
    expect(stateFromNode(row, node(['rejected', 'rejected', 'rejected'])).state).toBe('rejected');
  });
});
