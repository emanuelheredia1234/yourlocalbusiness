// The claim check (spec §6.4): every string that will be sent to Meta or Google is checked for claims the business
// may not be able to back up (a licence, insurance, a guarantee, reviews, free estimates…). A hit is a flag the
// customer ticks ("This is true and I can show it") or fixes in the plan; an unticked flag blocks the launch. The
// word list is the planner's own (src/ai/local/studio.ts CLAIM_TERM) plus the template lines the app's clean-up
// removes (src/store/legacy/claims.ts purgeAdClaims): claims.test.mjs keeps them the same.

/** = src/ai/local/studio.ts CLAIM_TERM */
export const CLAIM_TERM = /licen[sc]ed|insured|bonded|certified|free estimate|guarantee|warranty|review|rated/i;

/** Template claims purgeAdClaims takes out of old plans (src/store/legacy/claims.ts); flagged the same way here. */
export const TEMPLATE_CLAIMS = Object.freeze(['Book Online in 60 Seconds', 'Instant Access · Start Today', 'Free Estimates · ', 'Trusted by ', '30-day guar', 'Free estimates', 'Instant access', 'Free instant download', 'Takes 2 minutes', 'Upfront pricing, friendly pros.', 'What neighbors say', 'Local, licensed & insured']);

const GLOBAL = new RegExp(CLAIM_TERM.source, 'gi');
const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Claims in the texts that will be sent. texts: [{ field, text }]. → [{ phrase, field }], one per phrase (the
 * matched words as written, lower case), in the order found.
 */
export function findClaims(texts) {
  const out = new Map();
  for (const { field, text } of texts) {
    const s = String(text ?? '');
    for (const m of s.matchAll(GLOBAL)) {
      const phrase = norm(m[0]);
      if (!out.has(phrase)) out.set(phrase, { phrase, field });
    }
    for (const t of TEMPLATE_CLAIMS) {
      if (s.toLowerCase().includes(t.toLowerCase().trim())) {
        const phrase = norm(t);
        if (!out.has(phrase)) out.set(phrase, { phrase, field });
      }
    }
  }
  return [...out.values()];
}

/** The flags the customer hasn't ticked. confirmed: the phrases they ticked (any case). */
export function unconfirmed(claims, confirmed = []) {
  const ok = new Set((Array.isArray(confirmed) ? confirmed : []).map(norm));
  return claims.filter((c) => !ok.has(c.phrase));
}
