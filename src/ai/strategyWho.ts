// Who writes the strategy and what it costs, shown above every paid button and inside every confirm. A pure
// function of the runtime state (which keys power Strategy, and which of them can search the web).
import { useRuntime } from '@/lib/platform';
import { routeFor } from './functions';

export interface StrategyWho {
  mode: 'web' | 'general' | 'claude' | 'builtin' | 'checking';
  /** one sentence */
  who: string;
  /** one sentence ('' for builtin/checking) */
  cost: string;
  /** show "Open Settings → AI" */
  settings: boolean;
  searchKey?: { id: string; label: string; model: string; perSearch: number; own: boolean };
  /** Deep research with Manus: hidden in the Artifact build */
  deep: { show: boolean; ok: boolean; reason: string; own: boolean };
}

export interface WhoOptions {
  /** requests this run makes (6 for a full run, 1 for a refresh) */
  requests?: number;
  /** the run includes the research step (the only one that searches) */
  research?: boolean;
  /** web searches the research step may make */
  maxSearches?: number;
}

/** "6 steps, 6 requests" · "1 request" */
const requestsText = (n: number) => (n === 1 ? '1 request' : `${n} steps, ${n} requests`);
/** "$0.01", "$0.005", "$0.0025" */
export const searchPriceText = (perSearch: number) => `$${+perSearch.toFixed(4)}`;
const SEARCH_KEYS = 'Anthropic, OpenAI, xAI, Meta or OpenRouter';

/** Deep research with Manus: available, or why not. */
function deepOf(): StrategyWho['deep'] {
  if (__ARTIFACT_BUILD__) return { show: false, ok: false, reason: '', own: false };
  const rt = useRuntime.getState();
  const manus = rt.ai.providers.find((x) => x.id === 'manus');
  const own = !!manus?.own;
  if (rt.server === 'down') return { show: true, ok: false, reason: 'Your AI server isn’t running.', own };
  if (!rt.ai.reachable) return { show: true, ok: false, reason: 'Checking your AI server…', own };
  if (routeFor('marketResearch').length > 0) return { show: true, ok: true, reason: '', own };
  if (rt.ai.posting?.reason === 'own_key_needed') return { show: true, ok: false, reason: 'Deep research uses your own Manus account: add your Manus API key in Settings → AI.', own };
  if (manus) return { show: true, ok: false, reason: 'Tick Deep research (Manus) for your Manus key in Settings → AI.', own };
  return { show: true, ok: false, reason: 'Add a Manus key in Settings → AI to use deep research.', own };
}

/** Who writes the strategy, with what, and what the run costs. */
export function strategyWho(o: WhoOptions = {}): StrategyWho {
  const n = o.requests ?? 6;
  const research = o.research ?? true;
  const maxSearches = o.maxSearches ?? 5;
  const deep = deepOf();
  const rt = useRuntime.getState();
  if (__ARTIFACT_BUILD__) {
    if (rt.claude === 'available' || rt.claude === 'checking' || rt.claude === 'limited')
      return { mode: 'claude', who: `Claude writes your strategy through your claude.ai account, in ${n === 1 ? '1 step' : `${n} steps`}.`, cost: research ? 'There’s no web search in claude.ai, so findings come from Claude’s general knowledge and may be out of date.' : '', settings: false, deep };
    return { mode: 'builtin', who: 'Claude isn’t available here, so the built-in engine writes a starter plan (free).', cost: '', settings: false, deep };
  }
  if (rt.server === 'down') return { mode: 'builtin', who: 'Your AI server isn’t running, so the built-in engine writes a starter plan (free).', cost: '', settings: true, deep };
  if (!rt.ai.reachable) return { mode: 'checking', who: 'Checking which AI key powers Strategy…', cost: '', settings: false, deep };
  const route = routeFor('strategy');
  if (!route.length) return { mode: 'builtin', who: 'No API key powers Strategy yet, so the built-in engine writes a starter plan: free, general guidance, not research.', cost: '', settings: true, deep };
  const providerOf = (id: string) => rt.ai.providers.find((x) => x.id === id);
  const searchId = route.find((id) => !!providerOf(id)?.research);
  const writerId = searchId ?? route[0];
  const w = providerOf(writerId);
  const own = !!w?.own;
  const baseLabel = w?.label || writerId;
  const label = own && !/\(your key\)/.test(baseLabel) ? `${baseLabel} (your key)` : baseLabel;
  const model = w?.models?.text || 'its default model';
  const effort = w?.effort?.text;
  const effortText = effort?.id ? `effort ${effort.label}` : 'effort set by the model';
  const who = `${label} writes your strategy with ${model} (${effortText}): ${requestsText(n)}.`;
  if (searchId && w?.research) {
    const perSearch = w.research.perSearch;
    const cost = research
      ? `Step 1 searches the web: up to ${maxSearches} searches at ${searchPriceText(perSearch)} each (list price), plus the pages it reads, billed as tokens.${/^openrouter\d*$/.test(searchId) ? ' OpenRouter reports the exact cost after.' : ''}${own ? ' Billed to your own key.' : ' Billed to the key that powers Strategy; if you have a daily AI limit, it counts toward it.'}`
      : own
        ? 'Billed to your own key.'
        : 'Billed to the key that powers Strategy; if you have a daily AI limit, it counts toward it.';
    return { mode: 'web', who, cost, settings: false, searchKey: { id: searchId, label, model, perSearch, own }, deep };
  }
  return { mode: 'general', who, cost: research ? `${label} can’t search the web for Strategy, so the research comes from its general knowledge (no sources). For sources, tick Strategy for a key that can search (${SEARCH_KEYS}) in Settings → AI.` : '', settings: research, deep };
}
