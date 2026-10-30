// What served an AI request on your server: the key, model and effort it ran at, and what it used.

import type { GenMeta } from '@/lib/types';

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
}

export function isAIMeta(v: unknown): v is AIMeta {
  return !!v && typeof v === 'object' && typeof (v as AIMeta).provider === 'string' && typeof (v as AIMeta).model === 'string';
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
  return [g.providerLabel, g.model, effortText, tokens, cost].filter(Boolean).join(' · ');
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
    g.costUsd != null ? `Cost: ${fmtUsdSmall(g.costUsd)}${g.costEstimated ? ' (estimated from list prices)' : ' (reported by the provider)'}` : '',
    g.credits ? `Manus credits: ${g.credits}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
