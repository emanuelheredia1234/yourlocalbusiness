// The app's copy of what a form may send is the server's.
import { describe, expect, it } from 'vitest';
import * as server from '../../server/leads.mjs';
import { LEAD_FIELDS, LEAD_KINDS, LEAD_PAYLOAD_MAX, LEAD_SOURCES, fitField } from './leadFields';

describe('lead fields', () => {
  it('match server/leads.mjs', () => {
    expect({ ...LEAD_PAYLOAD_MAX }).toEqual({ ...server.LEAD_PAYLOAD_MAX });
    expect([...LEAD_KINDS]).toEqual([...server.LEAD_KINDS]);
    expect([...LEAD_SOURCES]).toEqual([...server.LEAD_SOURCES]);
    expect(Object.keys(LEAD_FIELDS)).toEqual(['name', 'email', 'phone', 'message', 'time']);
  });

  it('cut what a widget fills in to the limit, never over', () => {
    expect(fitField('score', '12')).toBe('12');
    const long = fitField('answers', 'x'.repeat(2000));
    expect(Array.from(long)).toHaveLength(1500);
  });
});
