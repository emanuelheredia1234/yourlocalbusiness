// What each AI provider key can power, and the effort settings each one really accepts.
//
// Effort is sent in exactly the field each provider documents (see `field` per kind), and the
// options offered are the ones the chosen model takes. Prices are list prices in US dollars per
// million tokens, used to estimate a request's cost when the provider doesn't report it.

import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync(new URL('../../shared/ai-functions.json', import.meta.url), 'utf8'));

export const FUNCTIONS = catalog.functions;
export const FUNCTION_GROUPS = catalog.groups;
export const FUNCTION_IDS = FUNCTIONS.map((f) => f.id);
export const fnById = Object.fromEntries(FUNCTIONS.map((f) => [f.id, f]));
export const KINDS = ['text', 'image', 'video', 'agent'];

/** Labels and one-line cost notes for every effort value, per scale. */
const SCALES = {
  reasoning: {
    none: ['None', 'No reasoning: fastest and cheapest.'],
    minimal: ['Minimal', 'Almost no reasoning tokens.'],
    low: ['Low', 'Light reasoning: fewer tokens, lower cost.'],
    medium: ['Medium', 'Balanced depth and cost.'],
    high: ['High', 'Deeper reasoning: more tokens, higher cost.'],
    xhigh: ['Extra high', 'Much deeper reasoning: several times the tokens.'],
    max: ['Max', 'The deepest reasoning: the most tokens and cost.'],
  },
  imageQuality: {
    low: ['Low', 'Fewest image tokens: fastest and cheapest.'],
    medium: ['Medium', 'Balanced detail and cost.'],
    high: ['High', 'More detail: several times the image tokens.'],
    xhigh: ['Extra high', 'Even more detail and tokens.'],
    max: ['Max', 'The most detail: the most tokens and cost.'],
  },
  imageSize: {
    '1K': ['1K', 'Standard size: the cheapest.'],
    '2K': ['2K', 'Sharper: costs more per image.'],
    '4K': ['4K', 'Sharpest: costs the most per image.'],
  },
  xaiQuality: {
    low: ['Low', 'xAI’s default: the cheapest.'],
    medium: ['Medium', 'More detail: billed at the higher quality.'],
  },
  metaStrength: {
    low: ['Low', 'Less planning: faster.'],
    high: ['High', 'More planning for better composition (Meta’s default).'],
  },
  videoResolution: {
    '360p': ['360p', 'Lowest resolution: the cheapest per video.'],
    '480p': ['480p', 'Draft quality: the cheapest per second.'],
    '720p': ['720p', 'HD: costs more per second.'],
    '768p': ['768p', 'Social quality: about 1.8× the 480p price.'],
    '1080p': ['1080p', 'Full HD: costs the most per second.'],
    '2K': ['2K', 'Best quality: about 5× the 480p price.'],
    '4k': ['4K', 'Sharpest: costs the most.'],
  },
  manusProfile: {
    lite: ['Lite', 'Fastest agent: the fewest credits.'],
    standard: ['Standard', 'Manus’s default agent.'],
    'max-medium': ['Max · medium', 'The Max agent with medium thinking: more credits.'],
    'max-high': ['Max · high', 'Max with deeper thinking: more credits again.'],
    'max-extra': ['Max · extra', 'Max with extra thinking (plain “max”).'],
    'max-ultra': ['Max · ultra', 'Deepest reasoning, slowest: the most credits.'],
  },
};

const ALL_REASONING = Object.keys(SCALES.reasoning);
const m = (id, label, efforts, defaultEffort, price, extra = {}) => ({ id, label, efforts, defaultEffort, price, ...extra });

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    envKeys: ['OPENROUTER_API_KEY'],
    keyUrl: 'https://openrouter.ai/settings/keys',
    note: 'One key for hundreds of models. OpenRouter reports the exact cost of every request.',
    kinds: {
      text: {
        field: 'reasoning.effort',
        scale: 'reasoning',
        // OpenRouter maps the effort onto each model's own reasoning control
        efforts: ALL_REASONING,
        defaultEffort: 'medium',
        defaultModel: 'google/gemini-3.8-flash',
        models: [
          m('google/gemini-3.8-flash', 'Gemini 3.8 Flash'),
          m('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'),
          m('anthropic/claude-opus-5.5', 'Claude Opus 5.5'),
          m('openai/gpt-6.1-sol', 'GPT-6.1 Sol'),
          m('x-ai/grok-4.6', 'Grok 4.6'),
          m('meta/muse-spark-1.3', 'Muse Spark 1.3'),
          m('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
        ],
      },
      image: {
        field: '',
        scale: 'imageQuality',
        efforts: [],
        defaultModel: 'meta/muse-image',
        models: [m('meta/muse-image', 'Meta Muse Image'), m('google/gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'), m('google/gemini-3-pro-image', 'Gemini 3 Pro Image')],
      },
      video: {
        field: 'resolution',
        scale: 'videoResolution',
        efforts: ['480p', '768p', '2K'],
        defaultEffort: '480p',
        defaultModel: 'heygen/heygen-video-1',
        models: [m('heygen/heygen-video-1', 'HeyGen Video 1', ['480p', '768p', '2K'], '480p', null, { perSecond: { '480p': 0.02, '768p': 0.036, '2K': 0.1 } })],
        aspects: ['9:16', '1:1', '16:9', '3:4', '4:3'],
        durations: [5, 15],
      },
    },
  },
  google: {
    label: 'Google Gemini',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Gemini for writing, Nano Banana for photos and Gemini Omni for video.',
    kinds: {
      text: {
        field: 'generation_config.thinking_level',
        scale: 'reasoning',
        efforts: ['minimal', 'low', 'medium', 'high'],
        defaultEffort: 'medium',
        defaultModel: 'gemini-3.8-flash',
        models: [
          m('gemini-3.8-flash', 'Gemini 3.8 Flash', ['minimal', 'low', 'medium', 'high'], 'medium', { input: 0.825, output: 4.125 }),
          m('gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)', ['low', 'medium', 'high'], 'medium', { input: 2, output: 12 }),
          m('gemini-3-flash-preview', 'Gemini 3 Flash (preview)', ['minimal', 'low', 'medium', 'high'], 'medium', { input: 0.5, output: 3 }),
        ],
      },
      image: {
        field: 'response_format.image_size',
        scale: 'imageSize',
        efforts: ['1K', '2K', '4K'],
        defaultEffort: '1K',
        defaultModel: 'gemini-nano-banana-2.1',
        models: [
          m('gemini-nano-banana-2.1', 'Nano Banana 2.1', ['1K', '2K', '4K'], '1K'),
          m('gemini-3.1-flash-image', 'Nano Banana 2 (3.1 Flash Image)', ['1K', '2K', '4K'], '1K'),
          m('gemini-3-pro-image', 'Nano Banana Pro (3 Pro Image)', ['1K', '2K', '4K'], '1K'),
          m('gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite', ['1K'], '1K'),
        ],
      },
      video: {
        field: 'response_format.resolution',
        scale: 'videoResolution',
        efforts: ['360p', '720p', '1080p', '4k'],
        defaultEffort: '720p',
        defaultModel: 'gemini-omni-1.1-flash',
        models: [m('gemini-omni-1.1-flash', 'Gemini Omni Flash', ['360p', '720p', '1080p', '4k'], '720p')],
        aspects: ['9:16', '16:9'],
        durations: null, // the model picks the length
      },
    },
  },
  xai: {
    label: 'xAI Grok',
    envKeys: ['XAI_API_KEY'],
    keyUrl: 'https://console.x.ai',
    note: 'Grok for writing, Grok Imagine for photos and video.',
    kinds: {
      text: {
        field: 'reasoning_effort',
        scale: 'reasoning',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
        defaultModel: 'grok-4.6',
        models: [
          m('grok-4.6', 'Grok 4.6', ['low', 'medium', 'high', 'xhigh'], 'medium', { input: 2, output: 6 }),
          m('grok-4.5', 'Grok 4.5', ['low', 'medium', 'high'], 'medium', { input: 2, output: 6 }),
          m('grok-4.20', 'Grok 4.20 (reasoning set by the model)', [], '', { input: 1.25, output: 2.5 }),
          m('grok-3-mini', 'Grok 3 Mini', ['low', 'high'], 'low'),
        ],
      },
      image: {
        field: 'quality',
        scale: 'xaiQuality',
        efforts: ['low', 'medium'],
        defaultEffort: 'low',
        defaultModel: 'grok-imagine-image-2.0',
        models: [m('grok-imagine-image-2.0', 'Grok Imagine Image 2.0', ['low', 'medium'], 'low')],
      },
      video: {
        field: 'resolution',
        scale: 'videoResolution',
        efforts: ['480p', '720p', '1080p'],
        defaultEffort: '480p',
        defaultModel: 'grok-imagine-video-1.5',
        models: [
          m('grok-imagine-video-1.5', 'Grok Imagine Video 1.5', ['480p', '720p', '1080p'], '480p'),
          m('grok-imagine-video-1.5-lite', 'Grok Imagine Video 1.5 Lite (lowest price)', ['480p', '720p', '1080p'], '480p'),
        ],
        aspects: ['9:16', '1:1', '16:9', '3:4', '4:3'],
        durations: [1, 15],
      },
    },
  },
  anthropic: {
    label: 'Anthropic Claude',
    envKeys: ['ANTHROPIC_API_KEY'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Claude for writing. Thinking is billed as output tokens.',
    kinds: {
      text: {
        field: 'output_config.effort',
        scale: 'reasoning',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
        defaultModel: 'claude-opus-5-5',
        models: [
          m('claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 4, output: 20 }, { fallbacks: true }),
          m('claude-sonnet-5-5', 'Claude Sonnet 5.5', ['low', 'medium', 'high', 'xhigh', 'max'], 'high', { input: 2, output: 10 }, { fallbacks: true }),
          m('claude-haiku-5-5', 'Claude Haiku 5.5', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 0.1, output: 0.5 }),
          m('claude-fable-5-1', 'Claude Fable 5.1', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 10, output: 50 }, { fallbacks: true }),
          m('claude-opus-5', 'Claude Opus 5', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 5, output: 25 }, { fallbacks: true }),
        ],
      },
    },
  },
  meta: {
    label: 'Meta Muse',
    envKeys: ['META_MODEL_API_KEY'],
    keyUrl: 'https://dev.meta.ai',
    note: 'Muse Spark for writing and Muse Image for photos.',
    kinds: {
      text: {
        field: 'reasoning_effort',
        scale: 'reasoning',
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
        defaultModel: 'muse-spark-1.3',
        models: [
          m('muse-spark-1.3', 'Muse Spark 1.3', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 1.25, output: 4.25 }),
          m('muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', ['minimal', 'low', 'medium', 'high', 'xhigh'], 'medium', { input: 0.1, output: 0.2 }),
          m('muse-wonder-1.0', 'Muse Wonder 1.0', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 4, output: 20 }),
        ],
      },
      image: {
        field: 'reasoning_strength',
        scale: 'metaStrength',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        defaultModel: 'muse-image-1.0',
        models: [m('muse-image-1.0', 'Muse Image 1.0', ['low', 'high'], 'high', null, { perImage: 0.011 })],
      },
    },
  },
  manus: {
    label: 'Manus',
    envKeys: ['MANUS_API_KEY'],
    keyUrl: 'https://manus.im/app?show_settings=integrations&app_name=api',
    note: 'An AI agent with its own browser. It schedules Facebook posts and can make photos; it uses Manus credits.',
    kinds: {
      image: {
        field: 'agent_profile',
        scale: 'manusProfile',
        efforts: Object.keys(SCALES.manusProfile),
        defaultEffort: 'standard',
        defaultModel: 'manus',
        models: [m('manus', 'Manus agent', Object.keys(SCALES.manusProfile), 'standard')],
      },
      agent: {
        field: 'agent_profile',
        scale: 'manusProfile',
        efforts: Object.keys(SCALES.manusProfile),
        defaultEffort: 'standard',
        defaultModel: 'manus',
        models: [m('manus', 'Manus agent', Object.keys(SCALES.manusProfile), 'standard')],
      },
    },
  },
  openai: {
    label: 'OpenAI',
    envKeys: ['OPENAI_API_KEY'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'GPT for writing and GPT Image for photos. OpenAI no longer offers video (Sora was shut down).',
    kinds: {
      text: {
        field: 'reasoning.effort',
        scale: 'reasoning',
        efforts: ALL_REASONING,
        defaultEffort: 'medium',
        defaultModel: 'gpt-6.1-sol',
        models: [
          m('gpt-6.1-sol', 'GPT-6.1 Sol', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 2, output: 10 }),
          m('gpt-6-astra', 'GPT-6 Astra', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 10, output: 50 }),
          m('gpt-6-sol', 'GPT-6 Sol', ALL_REASONING, 'medium', { input: 2, output: 10 }),
          m('gpt-6-luna', 'GPT-6 Luna', ALL_REASONING, 'medium', { input: 0.1, output: 0.5 }),
          m('gpt-6.1-terra', 'GPT-6.1 Terra', ALL_REASONING, 'medium', { input: 1, output: 5 }),
          m('gpt-5.6-terra', 'GPT-5.6 Terra', ALL_REASONING, 'medium', { input: 2, output: 12 }),
          m('gpt-5.6-luna', 'GPT-5.6 Luna', ALL_REASONING, 'medium', { input: 0.2, output: 1.2 }),
          m('gpt-5.5', 'GPT-5.5', ['none', 'low', 'medium', 'high', 'xhigh'], 'medium'),
        ],
      },
      image: {
        field: 'quality',
        scale: 'imageQuality',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
        defaultModel: 'gpt-image-2.5-flare',
        // image tokens: $8 per million in, $30 per million out; prompt text $5 per million
        models: [
          m('gpt-image-2.5-flare', 'GPT Image 2.5 Flare (fast, everyday)', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 5, output: 30, imageInput: 8 }, { customSizes: true }),
          m('gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst (precise edits)', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', { input: 5, output: 30, imageInput: 8 }, { customSizes: true }),
          m('gpt-image-2', 'GPT Image 2', ['low', 'medium', 'high'], 'medium', { input: 5, output: 30, imageInput: 8 }),
        ],
      },
    },
  },
};

/** The order the keys are shown in, and the default priority. */
export const PROVIDER_IDS = ['openrouter', 'google', 'xai', 'anthropic', 'meta', 'manus', 'openai'];

export function kindDef(providerId, kind) {
  return PROVIDERS[providerId]?.kinds?.[kind] ?? null;
}

export function modelDef(providerId, kind, model) {
  return kindDef(providerId, kind)?.models.find((x) => x.id === model) ?? null;
}

/** Whether a provider can power a function at all, and why not when it can't. */
export function supports(providerId, fnId) {
  const fn = fnById[fnId];
  if (!fn || !PROVIDERS[providerId]) return { ok: false, reason: 'Unknown' };
  if (kindDef(providerId, fn.kind)) return { ok: true, reason: '' };
  const label = PROVIDERS[providerId].label;
  if (fn.kind === 'video') return { ok: false, reason: providerId === 'openai' ? 'OpenAI shut down its video API (Sora) in September 2026.' : `${label} has no video API.` };
  if (fn.kind === 'image') return { ok: false, reason: `${label} doesn’t make photos.` };
  if (fn.kind === 'agent') return { ok: false, reason: 'Only the Manus agent can use a browser to schedule posts.' };
  if (providerId === 'manus') return { ok: false, reason: 'Manus is an agent: it schedules posts and makes photos, but doesn’t write the app’s content.' };
  return { ok: false, reason: `${label} can’t do this.` };
}

export function supportedFunctions(providerId) {
  return FUNCTION_IDS.filter((id) => supports(providerId, id).ok);
}

/** Effort values the chosen model accepts (models picked from a live list get the provider's list). */
export function effortIds(providerId, kind, model) {
  const k = kindDef(providerId, kind);
  if (!k) return [];
  const md = modelDef(providerId, kind, model);
  return md && Array.isArray(md.efforts) ? md.efforts : k.efforts;
}

export function defaultEffort(providerId, kind, model) {
  const k = kindDef(providerId, kind);
  if (!k) return '';
  const ids = effortIds(providerId, kind, model);
  const md = modelDef(providerId, kind, model);
  const want = md?.defaultEffort || k.defaultEffort || '';
  return ids.includes(want) ? want : ids[0] ?? '';
}

export function effortOptions(providerId, kind, model) {
  const k = kindDef(providerId, kind);
  if (!k) return [];
  const scale = SCALES[k.scale] ?? {};
  return effortIds(providerId, kind, model).map((id) => ({ id, label: scale[id]?.[0] ?? id, note: scale[id]?.[1] ?? '' }));
}

export function effortLabel(providerId, kind, effort) {
  const k = kindDef(providerId, kind);
  return (k && SCALES[k.scale]?.[effort]?.[0]) || effort || '';
}

const perMillion = (tokens, rate) => (tokens > 0 && rate > 0 ? (tokens * rate) / 1e6 : 0);

/**
 * Estimated dollar cost of one request from its usage, when the provider didn't report it.
 * usage: { input, output (billed output, reasoning included), imageInput? } in tokens.
 */
export function estimateCost(providerId, kind, model, usage, extra = {}) {
  const md = modelDef(providerId, kind, model);
  if (!md) return null;
  if (kind === 'image' && md.perImage) return md.perImage;
  if (kind === 'video' && md.perSecond && extra.seconds && extra.effort && md.perSecond[extra.effort]) return md.perSecond[extra.effort] * extra.seconds;
  const p = md.price;
  if (!p || !usage) return null;
  const usd = perMillion(usage.input, p.input) + perMillion(usage.output, p.output) + perMillion(usage.imageInput, p.imageInput ?? p.input);
  return usd > 0 ? Math.round(usd * 1e6) / 1e6 : null;
}

/** Public description of the catalog for the app's Settings page. */
export function describeProviders() {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    return {
      id,
      label: p.label,
      keyUrl: p.keyUrl,
      note: p.note,
      envKeys: p.envKeys,
      functions: Object.fromEntries(FUNCTION_IDS.map((fn) => [fn, supports(id, fn)])),
      kinds: Object.fromEntries(
        Object.entries(p.kinds).map(([kind, k]) => [
          kind,
          {
            field: k.field,
            defaultModel: k.defaultModel,
            models: k.models.map((x) => ({ id: x.id, label: x.label, efforts: effortOptions(id, kind, x.id), defaultEffort: defaultEffort(id, kind, x.id) })),
            efforts: effortOptions(id, kind, ''),
            aspects: k.aspects ?? null,
            durations: k.durations ?? null,
          },
        ]),
      ),
    };
  });
}
