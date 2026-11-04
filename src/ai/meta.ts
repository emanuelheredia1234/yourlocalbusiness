// What served an AI request on your server: the key, model and effort it ran at, and what it used.

import type { GenMeta } from '@/lib/types';
import { isHttpUrl } from '@/lib/strategyNormalize';

/** Why a research request answered without web sources ('' when it searched and found sources). */
export type ResearchReason = '' | 'unsupported' | 'provider_refused' | 'not_used' | 'no_results' | 'search_failed';
/** A page the web search returned (the server numbers and de-duplicates them). */
export interface ResearchSource {
  n: number;
  url: string;
  title: string;
  domain: string;
  cited: boolean;
  quote?: string;
  pageAge?: string;
}
/** What the web search did for a research request (Strategy): on every reply to a request that asked for research. */
export interface ResearchMeta {
  web: boolean;
  reason: ResearchReason;
  searches: number;
  queries: string[];
  sources: ResearchSource[];
  errors: string[];
}

export interface AIMeta {
  provider: string;
  providerLabel: string;
  fn: string;
  kind: string;
  model: string;
  effort: string;
  effortLabel: string;
  /** the request field the effort was sent in, e.g. "reasoning.effort" */
  effortField: string;
  ms: number;
  /** tokens; `output` is everything billed as output, reasoning included */
  usage: { input: number; output: number; reasoning: number | null } | null;
  /** dollars: reported by the provider, or estimated from list prices */
  cost: { usd: number; source: 'provider' | 'estimate' } | null;
  /** Manus credits */
  credits: number | null;
  params?: Record<string, unknown> | null;
  note?: string;
  /** keys tried before this one, and why they failed */
  attempts?: { provider: string; providerLabel: string; code: string; error: string }[];
  /** web searches it ran (research requests) */
  searches?: number;
  /** what the web search did (research requests only; read it with readResearchMeta) */
  research?: ResearchMeta;
}

export function isAIMeta(v: unknown): v is AIMeta {
  return !!v && typeof v === 'object' && typeof (v as AIMeta).provider === 'string' && typeof (v as AIMeta).model === 'string';
}

const RESEARCH_REASONS: readonly string[] = ['', 'unsupported', 'provider_refused', 'not_used', 'no_results', 'search_failed'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown, max: number, len: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= len);

/**
 * The research part of a reply, checked strictly (the server's shape, §7.1): web a boolean, reason one of
 * the known ones, searches 0-50, at most 12 queries and 30 sources, every source with a whole number, an
 * http(s) URL, a title and a domain. Anything else gives null (then the app treats the reply as one from a
 * server without research: general knowledge, "unsupported").
 */
export function readResearchMeta(v: unknown): ResearchMeta | null {
  if (!isObj(v)) return null;
  if (typeof v.web !== 'boolean' || typeof v.reason !== 'string' || !RESEARCH_REASONS.includes(v.reason)) return null;
  if (typeof v.searches !== 'number' || !Number.isInteger(v.searches) || v.searches < 0 || v.searches > 50) return null;
  if (!strList(v.queries, 12, 200) || !strList(v.errors, 10, 200)) return null;
  if (!Array.isArray(v.sources) || v.sources.length > 30) return null;
  const sources: ResearchSource[] = [];
  for (const s of v.sources) {
    if (!isObj(s)) return null;
    if (typeof s.n !== 'number' || !Number.isInteger(s.n) || typeof s.url !== 'string' || s.url.length > 2000 || !isHttpUrl(s.url)) return null;
    if (typeof s.title !== 'string' || typeof s.domain !== 'string' || typeof s.cited !== 'boolean') return null;
    if ((s.quote !== undefined && typeof s.quote !== 'string') || (s.pageAge !== undefined && typeof s.pageAge !== 'string')) return null;
    sources.push({ n: s.n, url: s.url, title: s.title, domain: s.domain, cited: s.cited, ...(typeof s.quote === 'string' ? { quote: s.quote } : {}), ...(typeof s.pageAge === 'string' ? { pageAge: s.pageAge } : {}) });
  }
  return { web: v.web, reason: v.reason as ResearchReason, searches: v.searches, queries: [...v.queries], sources, errors: [...v.errors] };
}

export function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');
}

export function fmtUsdSmall(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return usd > 0 ? `$${usd.toFixed(4)}` : '$0';
}

/** The compact copy kept in the generation log. */
export function compactMeta(m: AIMeta): GenMeta {
  return {
    provider: m.provider,
    providerLabel: m.providerLabel,
    kind: m.kind,
    model: m.model,
    effort: m.effort,
    effortLabel: m.effortLabel,
    input: m.usage?.input,
    output: m.usage?.output,
    reasoning: m.usage?.reasoning ?? null,
    costUsd: m.cost?.usd ?? null,
    costEstimated: m.cost?.source === 'estimate',
    credits: m.credits,
    ...(m.searches ? { searches: m.searches } : {}),
  };
}

/** What the effort setting is called for each kind of work. */
export function effortWord(kind = 'text', provider = ''): string {
  if (provider === 'manus' || kind === 'agent') return 'agent profile';
  return kind === 'image' || kind === 'video' ? 'quality' : 'effort';
}

/** "OpenAI · gpt-6.1-sol · effort High · 2,840 reasoning tokens · ≈$0.031" (photos and videos say "quality") */
export function metaLine(m: GenMeta | AIMeta): string {
  const g: GenMeta = 'usage' in m ? compactMeta(m) : m;
  const word = effortWord(g.kind, g.provider);
  const effortText = g.effort ? `${word} ${g.effortLabel}` : `${word} set by the model`;
  const tokens = g.reasoning ? `${fmtTokens(g.reasoning)} reasoning tokens` : g.output ? `${fmtTokens(g.output)} output tokens` : '';
  const cost = g.costUsd != null ? `${g.costEstimated ? '≈' : ''}${fmtUsdSmall(g.costUsd)}` : g.credits ? `${g.credits} credits` : '';
  const searches = g.searches ? `${g.searches} web search${g.searches === 1 ? '' : 'es'}` : '';
  return [g.providerLabel, g.model, effortText, tokens, searches, cost].filter(Boolean).join(' · ');
}

/** Hover details: every number the provider reported. */
export function metaDetails(m: GenMeta | AIMeta, field = ''): string {
  const g: GenMeta = 'usage' in m ? compactMeta(m) : m;
  return [
    `${g.providerLabel}, model ${g.model}`,
    (() => {
      const word = effortWord(g.kind, g.provider);
      const Word = word[0].toUpperCase() + word.slice(1);
      return g.effort ? `${Word}: ${g.effortLabel}${field ? ` (sent as ${field}: "${g.effort}")` : ''}` : `${Word}: set by the model`;
    })(),
    g.input != null ? `Input tokens: ${g.input.toLocaleString('en-US')}` : '',
    g.output != null ? `Output tokens (billed, reasoning included): ${g.output.toLocaleString('en-US')}` : '',
    g.reasoning != null ? `Reasoning tokens: ${g.reasoning.toLocaleString('en-US')}` : '',
    g.searches ? `Web searches: ${g.searches}` : '',
    g.costUsd != null ? `Cost: ${fmtUsdSmall(g.costUsd)}${g.costEstimated ? ' (estimated from list prices)' : ' (reported by the provider)'}` : '',
    g.credits ? `Manus credits: ${g.credits}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
