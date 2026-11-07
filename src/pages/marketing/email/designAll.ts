// "Design all" (P5): one AI request per email, one after another, from a given email on. The first failure stops it
// (nothing is retried); so does the owner's Stop, which is told apart from a failure so the words can say which,
// and the next "Design all" can carry on from the email it stopped at (the ones before it aren't paid for again).

export type DesignAllOutcome = { kind: 'done'; designed: number } | { kind: 'stopped' | 'failed'; at: number; designed: number } | { kind: 'gone'; designed: number };

export async function designEmails<T>(o: {
  from: number;
  count: () => number;
  /** the email at i, or undefined when it (or the business) is gone */
  emailAt: (i: number) => T | undefined;
  run: (e: T, i: number) => Promise<unknown>;
  write: (e: T, result: unknown) => void;
  stopped: () => boolean;
}): Promise<DesignAllOutcome> {
  let designed = 0;
  for (let i = o.from; i < o.count(); i++) {
    if (o.stopped()) return { kind: 'stopped', at: i, designed };
    const e = o.emailAt(i);
    if (!e) return { kind: 'gone', designed };
    const result = await o.run(e, i);
    if (!result) return { kind: o.stopped() ? 'stopped' : 'failed', at: i, designed };
    o.write(e, result);
    designed++;
  }
  return { kind: 'done', designed };
}

/** The toast after a stop or a failure at email `at` (0-based). */
export function designAllNotice(outcome: Extract<DesignAllOutcome, { at: number }>): { kind: 'info' | 'error'; title: string; body: string } {
  const n = outcome.at + 1;
  const before = outcome.at === 0 ? 'No email was designed.' : outcome.at === 1 ? 'Email 1 is designed.' : `Emails 1–${outcome.at} are designed.`;
  if (outcome.kind === 'stopped') return { kind: 'info', title: 'Stopped', body: `${before} Press Design all to carry on from email ${n}.` };
  return { kind: 'error', title: `Stopped at email ${n}`, body: `Its design didn’t come back. ${before} Press Design all to carry on from email ${n}, or design it on its own.` };
}
