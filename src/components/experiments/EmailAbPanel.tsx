// An email step's A/B test (P4b §A2, §S8): version B kept on the step until "Create A/B draft in Omnisend". One
// request, never retried here: the draft is made in Omnisend (Omnisend sends the test and picks the winner; the app
// never sends). A 502 CAMPAIGN_UNCONFIRMED means it may exist: check Omnisend before pressing again.

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import type { EmailStep, Project } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { openExperimentCard, useExperiments } from '@/store/experiments';
import { IntegrationApiError } from '@/lib/integrations/api';
import { createEmailAbDraft, deleteExperiment, experimentErrorCopy } from '@/lib/experiments/api';
import { Callout, Field, Spinner } from '../ui/primitives';
import { docOf, variantDoc } from '@/lib/emailDoc';
import { draftProblem, emailDraftPayload } from '@/lib/emailDraft';

export function EmailAbPanel({ project, step }: { project: Project; step: EmailStep }) {
  const v = step.variants;
  const exp = useExperiments((s) => s.byProject[project.id]?.experiments.find((e) => e.id === v?.experimentId));
  const [size, setSize] = useState(30);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [made, setMade] = useState<{ url?: string; note?: string } | null>(null);
  if (!v || __ARTIFACT_BUILD__) return null;
  const started = !!exp && exp.state !== 'draft';

  const dropVariant = () =>
    useStore.getState().updateProject(project.id, (p) => ({ ...p, marketing: { ...p.marketing, emails: p.marketing.emails.map((e) => (e.id === step.id ? { ...e, variants: undefined } : e)) } }));

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // both versions as block docs (P5): B is A's design with B's subject, or B's opening in its first text block
      const index = Math.max(0, project.marketing.emails.findIndex((e) => e.id === step.id));
      const { name: _a, ...a } = emailDraftPayload(project, step, index);
      const bDoc = variantDoc(step, project) ?? docOf({ ...step, body: v.b.body }, project);
      const { name: _b, ...b } = emailDraftPayload(project, step, index, { doc: bDoc, subject: v.b.subject, preview: v.b.preview });
      const problem = draftProblem(project, { name: '', ...a }) || draftProblem(project, { name: '', ...b });
      if (problem) {
        setError({ title: 'The A/B draft wasn’t made', body: problem });
        return;
      }
      const got = await createEmailAbDraft(v.experimentId, { a, b }, { testSizePercent: size, decisionHours: hours });
      useExperiments.getState().upsert(got.experiment);
      setMade({ url: got.campaign.url, note: got.split?.note });
    } catch (e) {
      const unconfirmed = e instanceof IntegrationApiError && e.code === 'CAMPAIGN_UNCONFIRMED';
      setError({ title: unconfirmed ? 'We couldn’t confirm the draft was made' : 'The A/B draft wasn’t made', body: unconfirmed ? 'It may have been created: check Omnisend before trying again.' : experimentErrorCopy(e) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await deleteExperiment(v.experimentId);
      useExperiments.getState().drop(project.id, v.experimentId);
    } catch {
      /* a test that ran is kept with its results; the version on the step still goes */
    }
    dropVariant();
  };

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-4" data-testid="email-ab">
      <p className="flex items-center gap-2 text-body font-medium text-ink">
        <FlaskConical size={16} aria-hidden="true" /> A/B test: {v.changed === 'subject' ? 'subject line' : 'opening'}
      </p>
      <div className="grid gap-2 text-small text-ink-2 sm:grid-cols-2">
        <p>
          <span className="label">A · Original</span>
          {v.changed === 'subject' ? step.subject : step.body.split(/\n\s*\n/)[0]}
        </p>
        <p>
          <span className="label">B</span>
          {v.changed === 'subject' ? v.b.subject : v.b.body.split(/\n\s*\n/)[0]}
        </p>
      </div>
      {!started && !made && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Test group" hint="Each version goes to half of this share of your list; the rest get the winner.">
            <select className="select" value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {[10, 20, 30, 40, 50].map((n) => (
                <option key={n} value={n}>
                  {n}% of the list
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pick the winner after">
            <select className="select" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {[4, 12, 24, 48].map((n) => (
                <option key={n} value={n}>
                  {n} hours
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {made && (
        <Callout tone="good" title="A/B draft made in Omnisend">
          {made.note ?? 'Choose who gets it and send it from Omnisend: it picks the winner by itself.'}{' '}
          {made.url && (
            <a className="link" href={made.url} target="_blank" rel="noopener noreferrer">
              Open in Omnisend
            </a>
          )}
        </Callout>
      )}
      {error && (
        <Callout tone={error.title.startsWith('We couldn’t confirm') ? 'warn' : 'bad'} title={error.title}>
          {error.body}
        </Callout>
      )}
      <div className="flex flex-wrap gap-2">
        {!started && !made ? (
          <>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void create()}>
              {busy && <Spinner />} Create A/B draft in Omnisend
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void cancel()}>
              Drop version B
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openExperimentCard(v.experimentId)}>
            See the results
          </button>
        )}
      </div>
      <p className="text-caption text-muted">Creating the draft counts as one of this month’s A/B tests. The app never sends: you send it from Omnisend.</p>
    </div>
  );
}
