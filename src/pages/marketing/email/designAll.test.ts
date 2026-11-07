// "Design all" (P5): a Stop is told apart from a failure, and the next run carries on from the email it stopped at.
import { describe, expect, it } from 'vitest';
import { designAllNotice, designEmails } from './designAll';

const emails = ['a', 'b', 'c', 'd', 'e'];

describe('designEmails', () => {
  it('designs each email in turn, from the one given', async () => {
    const ran: number[] = [];
    const written: string[] = [];
    const out = await designEmails({ from: 2, count: () => 5, emailAt: (i) => emails[i], run: async (_e, i) => (ran.push(i), { ok: i }), write: (e) => written.push(e), stopped: () => false });
    expect(out).toEqual({ kind: 'done', designed: 3 });
    expect(ran).toEqual([2, 3, 4]);
    expect(written).toEqual(['c', 'd', 'e']);
  });

  it('a Stop during email 3 is a stop, not a failure; emails 1–2 stay designed', async () => {
    let stop = false;
    const out = await designEmails({ from: 0, count: () => 5, emailAt: (i) => emails[i], run: async (_e, i) => (i === 2 ? ((stop = true), null) : {}), write: () => {}, stopped: () => stop });
    expect(out).toEqual({ kind: 'stopped', at: 2, designed: 2 });
    expect(designAllNotice(out as Extract<typeof out, { at: number }>)).toEqual({ kind: 'info', title: 'Stopped', body: 'Emails 1–2 are designed. Press Design all to carry on from email 3.' });
  });

  it('a design that doesn’t come back is a failure (never retried)', async () => {
    let calls = 0;
    const out = await designEmails({ from: 0, count: () => 5, emailAt: (i) => emails[i], run: async (_e, i) => (calls++, i === 1 ? null : {}), write: () => {}, stopped: () => false });
    expect(out).toEqual({ kind: 'failed', at: 1, designed: 1 });
    expect(calls).toBe(2);
    expect(designAllNotice(out as Extract<typeof out, { at: number }>).body).toBe('Its design didn’t come back. Email 1 is designed. Press Design all to carry on from email 2, or design it on its own.');
  });
});
