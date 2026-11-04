// Reading an OpenAI-style Responses API answer (OpenAI, and xAI and Meta for web research): the final
// text, and what its web searches found. Never the page snippets.

import { ProviderError, num, scrubKeys } from '../http.mjs';

/**
 * { text: the last message with text (narration before the searches isn't the answer), allText, refusal,
 *   sources: [{ url, title?, cited? }], queries, errors, searchCalls }. searchCalls counts web_search_call
 * items that ran a search (no action, or a `search` action) and didn't fail.
 */
export function responsesOutput(p) {
  const out = Array.isArray(p?.output) ? p.output : [];
  const msgs = out.filter((i) => i?.type === 'message');
  const parts = (m) => (Array.isArray(m?.content) ? m.content : []);
  const textOf = (m) =>
    parts(m)
      .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
  const last = [...msgs].reverse().find((m) => textOf(m));
  const sources = [];
  const queries = [];
  const errors = [];
  let searchCalls = 0;
  for (const m of msgs) {
    for (const c of parts(m)) {
      for (const a of Array.isArray(c?.annotations) ? c.annotations : []) {
        if (a?.type === 'url_citation' && typeof a.url === 'string') sources.push({ url: a.url, title: typeof a.title === 'string' ? a.title : '', cited: true });
      }
    }
  }
  for (const i of out) {
    if (i?.type !== 'web_search_call') continue;
    const a = i.action && typeof i.action === 'object' ? i.action : {};
    if (i.status === 'failed') errors.push(typeof i.error?.code === 'string' && i.error.code ? i.error.code : 'failed');
    else if (!a.type || a.type === 'search') searchCalls += 1;
    if (typeof a.query === 'string') queries.push(a.query);
    for (const q of Array.isArray(a.queries) ? a.queries : []) if (typeof q === 'string') queries.push(q);
    for (const s of Array.isArray(a.sources) ? a.sources : []) if (typeof s?.url === 'string') sources.push({ url: s.url });
    if (a.type === 'open_page' && typeof a.url === 'string') sources.push({ url: a.url });
    // Meta's include web_search_call.results: every source the model considered (titles and URLs only)
    for (const r of Array.isArray(i.results) ? i.results : []) if (typeof r?.url === 'string') sources.push({ url: r.url, title: typeof r.title === 'string' ? r.title : '' });
  }
  const refusal = msgs
    .flatMap(parts)
    .filter((c) => c?.type === 'refusal')
    .map((c) => String(c.refusal ?? ''))
    .join('');
  return { text: last ? textOf(last) : '', allText: msgs.map(textOf).join(''), refusal, sources, queries, errors, searchCalls };
}

/**
 * Tokens from a Responses API `usage`. `output` is everything billed as output: OpenAI counts reasoning
 * inside output_tokens; a host that counts it beside them shows it in total_tokens.
 */
export function responsesUsage(u) {
  if (!u || typeof u !== 'object') return { input: 0, output: 0, reasoning: null };
  const input = num(u.input_tokens) ?? 0;
  const output = num(u.output_tokens) ?? 0;
  const reasoning = num(u.output_tokens_details?.reasoning_tokens);
  const total = num(u.total_tokens);
  const separate = reasoning > 0 && total !== null && Math.abs(total - (input + output + reasoning)) < Math.abs(total - (input + output));
  return { input, output: separate ? output + reasoning : output, reasoning };
}

/** Why a Responses API answer has no text, as the error the app explains. */
export function noTextError(p, refusal, label) {
  if (refusal) return new ProviderError('REFUSAL', `${label} declined this request.`, { status: 422, provider: label });
  if (p?.status === 'failed') return new ProviderError('UPSTREAM', `${label} failed: ${scrubKeys(String(p.error?.message || 'unknown error')).slice(0, 400)}`, { provider: label });
  if (p?.status === 'incomplete') {
    if (p.incomplete_details?.reason === 'content_filter') return new ProviderError('CONTENT_POLICY', `${label} blocked this request under its content policy.`, { status: 422, provider: label });
    return new ProviderError('CUT_OFF', `${label} ran out of room before answering. Try a lower effort.`, { provider: label });
  }
  return new ProviderError('NO_OUTPUT', `${label} returned an empty answer.`, { provider: label });
}
