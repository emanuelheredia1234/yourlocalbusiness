import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Eye, Inbox, Mail, MousePointerClick, Play, RotateCcw, Square, Star } from 'lucide-react';
import type { Project, Subscriber } from '@/lib/types';
import { cn, emailValid, fmtDateTime } from '@/lib/utils';
import { delayToMs, renderTokens } from '@/ai/local/email';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Empty, Field, Segmented, Spinner } from '@/components/ui/primitives';
import { EmailView, addSubscriber, delayLabel, emailTokens, patchSubscriber, simulatedEngagement } from './shared';

type Speed = 'fast' | 'normal' | 'slow';
const MS_PER_DAY: Record<Speed, number> = { fast: 700, normal: 1800, slow: 4000 };

interface SimStep {
  step: number;
  virtualAt: number;
  status: 'pending' | 'sending' | 'delivered';
  opened: boolean;
  clicked: boolean;
  converted: boolean;
  read: boolean;
}

interface SimRun {
  subId: string;
  startedAt: number;
  steps: SimStep[];
  done: boolean;
}

export function SimulatePanel({ project, initialSubId, onWrite }: { project: Project; initialSubId: string | null; onWrite: () => void }) {
  const emails = project.marketing.emails;
  const profile = useStore((s) => s.settings.profile);
  const subs = project.marketing.subscribers.filter((s) => s.source !== 'sample');
  const [subId, setSubId] = useState<string>(initialSubId ?? subs[0]?.id ?? 'new');
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [speed, setSpeed] = useState<Speed>('normal');
  const [run, setRun] = useState<SimRun | null>(null);
  const [view, setView] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  const [clock, setClock] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scaleRef = useRef(1);

  useEffect(() => {
    if (initialSubId) setSubId(initialSubId);
  }, [initialSubId]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    if (!run || run.done) return;
    const t = setInterval(() => setClock((Date.now() - run.startedAt) * scaleRef.current), 120);
    return () => clearInterval(t);
  }, [run]);

  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRun((r) => (r ? { ...r, done: true } : r));
  };

  const start = () => {
    if (!emails.length) return;
    let sub: Subscriber | undefined = subs.find((s) => s.id === subId);
    if (subId === 'new' || !sub) {
      setTouched(true);
      if (!emailValid(email)) return;
      sub = addSubscriber(name, email, 'test');
      setSubId(sub.id);
    }
    const target = sub;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    patchSubscriber(target.id, { step: 0, opened: [], clicked: [], converted: false });

    // virtual schedule → real time (1 day ≈ MS_PER_DAY[speed]); keep at least 700ms between emails
    let virtual = 0;
    let real = 400;
    const msPerDay = MS_PER_DAY[speed];
    const steps: SimStep[] = emails.map((e, i) => {
      virtual += delayToMs(e.delay);
      return { step: i + 1, virtualAt: virtual, status: 'pending', opened: false, clicked: false, converted: false, read: false };
    });
    const realAt = steps.map((s, i) => {
      const gap = ((s.virtualAt - (steps[i - 1]?.virtualAt ?? 0)) / 86_400_000) * msPerDay;
      real += Math.max(i === 0 ? 0 : 700, gap);
      return real;
    });
    const lastVirtual = steps[steps.length - 1].virtualAt || 1;
    scaleRef.current = lastVirtual / Math.max(1, realAt[realAt.length - 1]);
    const startedAt = Date.now();
    setClock(0);
    setView(null);
    setRun({ subId: target.id, startedAt, steps, done: false });

    const update = (i: number, patch: Partial<SimStep>) => setRun((r) => (r ? { ...r, steps: r.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : r));
    const opened: number[] = [];
    const clicked: number[] = [];
    let converted = false;
    steps.forEach((s, i) => {
      const eng = simulatedEngagement(target, s.step);
      timers.current.push(setTimeout(() => update(i, { status: 'sending' }), Math.max(0, realAt[i] - 350)));
      timers.current.push(
        setTimeout(() => {
          update(i, { status: 'delivered' });
          patchSubscriber(target.id, { step: s.step });
        }, realAt[i]),
      );
      if (eng.open)
        timers.current.push(
          setTimeout(() => {
            opened.push(s.step);
            update(i, { opened: true });
            patchSubscriber(target.id, { opened: [...opened] });
          }, realAt[i] + 450),
        );
      if (eng.click)
        timers.current.push(
          setTimeout(() => {
            clicked.push(s.step);
            if (eng.convert) converted = true;
            update(i, { clicked: true, converted: eng.convert });
            patchSubscriber(target.id, { clicked: [...clicked], converted });
          }, realAt[i] + 850),
        );
    });
    timers.current.push(
      setTimeout(() => {
        setRun((r) => (r ? { ...r, done: true } : r));
        setClock(lastVirtual);
        toast({ kind: 'success', title: 'Sequence simulation complete', body: `${steps.length} emails delivered · ${opened.length} opened · ${clicked.length} clicked${converted ? ' · converted!' : ''}` });
      }, realAt[realAt.length - 1] + 1100),
    );
  };

  const target = run ? getActiveProject()!.marketing.subscribers.find((s) => s.id === run.subId) : subs.find((s) => s.id === subId);
  const tokens = emailTokens(project, target ?? { name, email });
  const delivered = run ? run.steps.filter((s) => s.status === 'delivered') : [];
  const lastVirtual = run ? run.steps[run.steps.length - 1].virtualAt || 1 : 1;
  const progress = run ? (run.done ? 1 : Math.min(1, clock / lastVirtual)) : 0;
  const virtualDay = Math.floor(clock / 86_400_000);

  if (!emails.length) {
    return <Empty icon={<Mail size={20} />} title="Write your sequence first" body="The simulator sends your 5 emails to a test subscriber on a compressed timeline." action={<button className="btn btn-primary btn-sm" onClick={onWrite}>Go to the sequence</button>} />;
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="flex min-w-0 flex-col gap-4">
        <section className="panel flex flex-col gap-3 p-4" aria-label="Simulation setup">
          <h2 className="text-[14px] font-semibold">Simulate subscriber & send sequence</h2>
          <p className="text-xs text-muted">Signs up a test subscriber and plays the sequence on a compressed clock. Nothing is actually emailed, and opens and clicks are simulated.</p>
          <Field label="Subscriber" htmlFor="sim-sub">
            <select id="sim-sub" className="select" value={subId} onChange={(e) => setSubId(e.target.value)} disabled={!!run && !run.done}>
              <option value="new">+ New test subscriber</option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.email}
                </option>
              ))}
            </select>
          </Field>
          {subId === 'new' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="First name" htmlFor="sim-name">
                <input id="sim-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" />
              </Field>
              <Field label="Email" htmlFor="sim-email" error={touched && !emailValid(email) ? 'Enter a valid email.' : undefined}>
                <input id="sim-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="alex@email.com" />
              </Field>
            </div>
          )}
          <Field label="Playback speed">
            <Segmented
              size="sm"
              value={speed}
              onChange={setSpeed}
              options={[
                { id: 'fast', label: 'Fast' },
                { id: 'normal', label: '1 day ≈ 2s' },
                { id: 'slow', label: 'Slow' },
              ]}
            />
          </Field>
          {run && !run.done ? (
            <button className="btn btn-secondary" onClick={stop}>
              <Square size={13} className="fill-current" /> Stop simulation
            </button>
          ) : (
            <button className="btn btn-primary" onClick={start}>
              {run ? <RotateCcw size={15} /> : <Play size={15} />} {run ? 'Run again' : 'Simulate subscriber & send sequence'}
            </button>
          )}
        </section>

        <section className="panel p-4" aria-label="Sequence timeline">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold">Timeline</h3>
            {run && (
              <span className="num text-xs text-muted">
                {run.done ? 'Finished' : `Simulated day ${virtualDay}`} · {Math.round(progress * 100)}%
              </span>
            )}
          </div>
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-primary transition-[width] duration-150" style={{ width: `${progress * 100}%` }} />
          </div>
          <ol className="flex flex-col gap-2.5">
            {emails.map((e, i) => {
              const s = run?.steps[i];
              return (
                <li key={e.id} className="flex items-start gap-2.5 text-[13px]">
                  <span className="mt-0.5 shrink-0">
                    {!s || s.status === 'pending' ? <Circle size={16} className="text-faint" /> : s.status === 'sending' ? <Spinner size={16} className="text-primary" /> : <CheckCircle2 size={16} className="text-good" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {i + 1}. {renderTokens(e.subject, tokens)}
                    </span>
                    <span className="block text-xs text-muted">{delayLabel(e, i)}</span>
                    {s && s.status === 'delivered' && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        <span className="badge bg-surface-2 text-ink-2">Delivered</span>
                        {s.opened && (
                          <span className="badge bg-info/15 text-info">
                            <Eye size={10} /> Opened
                          </span>
                        )}
                        {s.clicked && (
                          <span className="badge bg-good-soft text-good">
                            <MousePointerClick size={10} /> Clicked
                          </span>
                        )}
                        {s.converted && (
                          <span className="badge bg-accent/25 text-ink">
                            <Star size={10} /> Converted
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      </aside>

      <section className="panel flex min-h-[520px] min-w-0 flex-col overflow-hidden" aria-label="Simulated inbox">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <Inbox size={16} className="text-primary" />
          <h3 className="text-[13px] font-semibold">Inbox of {target ? `${target.name} <${target.email}>` : 'your test subscriber'}</h3>
          <span className="num ml-auto text-xs text-muted">{delivered.length} of {emails.length}</span>
        </div>
        {!run ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
            <Mail size={26} className="text-faint" />
            <p className="font-semibold">Emails will land here</p>
            <p className="max-w-[340px] text-[13px] text-muted">Press “Simulate subscriber & send sequence” to watch all five arrive on schedule.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 min-h-0 flex-1 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
            <ul className="max-h-[560px] divide-y divide-line overflow-y-auto border-b border-line md:border-b-0 md:border-r scroll-thin">
              {delivered.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-muted">Waiting for the first email…</li>}
              {[...delivered].reverse().map((s) => {
                const e = emails[s.step - 1];
                const unread = !s.read;
                return (
                  <li key={s.step}>
                    <button
                      className={cn('flex w-full animate-rise-in flex-col gap-0.5 px-4 py-3 text-left hover:bg-surface-2', view === s.step - 1 && 'bg-primary-soft')}
                      onClick={() => {
                        setView(s.step - 1);
                        setRun((r) => (r ? { ...r, steps: r.steps.map((x) => (x.step === s.step ? { ...x, read: true } : x)) } : r));
                      }}
                    >
                      <span className="flex items-center gap-2 text-[12.5px]">
                        {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-info" aria-label="Unread" />}
                        <b className={cn('min-w-0 flex-1 truncate', unread ? 'text-ink' : 'font-medium text-ink-2')}>{project.brand.name}</b>
                        <span className="num shrink-0 text-[11px] text-muted">{fmtDateTime(run.startedAt + s.virtualAt)}</span>
                      </span>
                      <span className={cn('truncate text-[13px]', unread ? 'font-semibold text-ink' : 'text-ink-2')}>{renderTokens(e.subject, tokens)}</span>
                      <span className="truncate text-xs text-muted">{renderTokens(e.preview, tokens)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="min-w-0 overflow-y-auto p-4 scroll-thin">
              {view !== null && emails[view] ? (
                <EmailView project={project} email={emails[view]} tokens={tokens} />
              ) : (
                <p className="py-10 text-center text-[13px] text-muted">{delivered.length ? 'Select an email to read it.' : ''}</p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
