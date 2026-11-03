// Daily limits on the app's AI keys (server/limits.mjs): what Settings → AI shows a signed-in user.

/** The next midnight UTC after `now`, when today's counters reset. */
export function nextUtcMidnight(now: number = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/** "today at 7:00 PM" / "tomorrow at 1:00 AM", in this browser's time zone. */
export function resetLabel(resetsAt: string | undefined, now: number = Date.now()): string {
  const parsed = resetsAt ? Date.parse(resetsAt) : NaN;
  const at = Number.isFinite(parsed) && parsed > now ? new Date(parsed) : nextUtcMidnight(now);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return `${sameDay ? 'today' : 'tomorrow'} at ${time}`;
}

/** How full a limit is, 0–100 (0 when there's no limit). */
export function limitPercent(used: number, limit: number): number {
  if (!(limit > 0) || !(used > 0)) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}


// ───────────── Settings → AI: what the server's answers mean ─────────────

const KIND_NAMES: Record<string, string> = { text: 'Writing', image: 'Photos', video: 'Videos', agent: 'Agent tasks' };

export interface OwnKeyProvider {
  id: string;
  label: string;
  kinds: string[];
  keyUrl: string;
}
export interface MyKeys {
  available: boolean;
  byProvider: Record<string, { last4: string; updatedAt?: string } | null>;
  providers: OwnKeyProvider[];
}

/** GET/PUT/DELETE /api/ai/my-keys → what the own-keys card shows (tolerates missing or odd fields). */
export function parseMyKeys(j: unknown): MyKeys {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  const byProvider: MyKeys['byProvider'] = {};
  const raw = o.byProvider && typeof o.byProvider === 'object' ? (o.byProvider as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(raw)) {
    const x = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    byProvider[id] = x && typeof x.last4 === 'string' ? { last4: x.last4, ...(typeof x.updatedAt === 'string' ? { updatedAt: x.updatedAt } : {}) } : null;
  }
  // older servers answered with a list of saved keys only
  if (Array.isArray(o.keys)) {
    for (const k of o.keys as Array<Record<string, unknown>>) {
      if (k && typeof k.provider === 'string' && typeof k.last4 === 'string' && !byProvider[k.provider]) byProvider[k.provider] = { last4: k.last4 };
    }
  }
  const providers = (Array.isArray(o.providers) ? o.providers : []).filter(
    (p): p is OwnKeyProvider => !!p && typeof p === 'object' && typeof (p as OwnKeyProvider).id === 'string' && typeof (p as OwnKeyProvider).label === 'string',
  ).map((p) => ({ id: p.id, label: p.label, kinds: Array.isArray(p.kinds) ? p.kinds.filter((k) => typeof k === 'string') : [], keyUrl: typeof p.keyUrl === 'string' ? p.keyUrl : '' }));
  return { available: o.available !== false, byProvider, providers };
}

/**
 * What a user's own key for a provider actually runs on their account: the server routes writing,
 * photos and videos to own keys, but a Manus key only works for Manus tasks (photos made by the
 * Manus agent, and social posts), never for the app's regular photos.
 */
export function ownKeyCapability(p: Pick<OwnKeyProvider, 'id' | 'label' | 'kinds'>): { short: string; saved: string } {
  if (p.id === 'manus') {
    return {
      short: 'Manus tasks: agent photos, social posts',
      saved: 'Manus photo tasks and social posts now run in your own Manus account. Other photos still use the app’s keys, within the daily limit.',
    };
  }
  const kinds = p.kinds.filter((k) => k !== 'agent');
  const text = kinds.map((k) => KIND_NAMES[k] ?? k).join(', ');
  return { short: text, saved: `${text} now run${kinds.length === 1 ? 's' : ''} in your own ${p.label} account.` };
}

/** Requests that count toward the daily request limit right now: recorded ones plus those still running. */
export function requestsInUse(lim: { usedRequests: number; running?: number }): number {
  return (Number(lim.usedRequests) || 0) + Math.max(0, Number(lim.running) || 0);
}

export interface CountersProblem {
  code?: string;
  message?: string;
}

/**
 * Whether the daily counters are only in this server's memory (lost on restart, not shared), and what to
 * say about it: the server says 'memory', or Supabase is set up but isn't keeping them (storageProblem).
 */
export function countersNote(storage: string | undefined, problem: CountersProblem | null | undefined, { owner = false } = {}): string | null {
  if (problem?.message) {
    if (owner) return problem.message;
    return 'Counted on the server only for now: the numbers start again if it restarts.';
  }
  if (storage === 'memory') {
    return owner ? 'Usage is counted in this server’s memory (Supabase isn’t keeping the counters), so it starts again when the server restarts.' : 'Counted on the server only for now: the numbers start again if it restarts.';
  }
  return null;
}
