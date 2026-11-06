// Ready-made words for what the assistant must ask before acting: the card a video or Manus tool shows
// in the chat (P-media), and the danger confirm a delete shows (D). The policy decides when to ask
// (by the tool's class); a tool only says what to show, through its `card` or `danger`.

import { listJoin, plural } from '@/lib/utils';
import { fmtUsd, videoCost, videoTransport, type VideoResolution } from '../video';
import { primaryProvider } from '../functions';
import type { ConfirmCardSpec, DangerSpec } from './registry';

/** The card before a video: who makes it and roughly what it costs (charged when it starts). */
export function videoCard(o: { what: string; seconds: number; resolution?: VideoResolution; confirmLabel?: string; /** plans: "2 of 3 videos used this week · resets Monday" */ week?: string | null }): ConfirmCardSpec {
  if (videoTransport.server) {
    const p = primaryProvider('videos');
    return {
      title: `Make a ${o.seconds}-second video?`,
      what: o.what,
      who: p ? `${p.label}, with ${p.models.video ?? 'its video model'} at ${p.effort.video?.label ?? 'its default'} quality (set in Settings › AI keys). It takes a minute or more.` : 'The key that powers Videos in Settings › AI keys.',
      cost: `Billed to that key by the second; the estimate counts toward today’s AI limit as soon as it starts.${o.week ? ` This business: ${o.week}.` : ''}`,
      confirmLabel: o.confirmLabel ?? 'Make the video',
    };
  }
  const resolution = o.resolution ?? '768p';
  return {
    title: `Make a ${o.seconds}-second video?`,
    what: o.what,
    who: 'HeyGen Video 1, through OpenRouter in your Zapier connector. It takes about a minute.',
    cost: `About ${fmtUsd(videoCost(o.seconds, resolution))} at ${resolution} (OpenRouter’s list price), billed to your OpenRouter account.`,
    confirmLabel: o.confirmLabel ?? 'Make the video',
  };
}

/** The card before anything Manus does for a tool (e.g. a photo made as a Manus task). */
export function manusCard(o: { title: string; what: string; cost?: string; confirmLabel?: string }): ConfirmCardSpec {
  return {
    title: o.title,
    what: o.what,
    who: 'Manus, an AI agent working in its own browser. It usually takes a few minutes.',
    cost: o.cost ?? 'Uses your Manus credits.',
    confirmLabel: o.confirmLabel ?? 'Start',
  };
}

/** The danger confirm before deleting things: names what goes (up to 5) and that it can't be undone. */
export function deleteConfirm(o: { thing: string; things?: string; names: string[]; extra?: string }): DangerSpec {
  const n = o.names.length;
  const shown = o.names.slice(0, 5).map((x) => `“${x || 'Untitled'}”`);
  const more = n > 5 ? ` and ${n - 5} more` : '';
  return {
    title: `Delete ${n === 1 ? `this ${o.thing}` : plural(n, o.thing, o.things)}?`,
    body: `${listJoin(shown)}${more} will be deleted. ${o.extra ? `${o.extra} ` : ''}This can’t be undone.`,
    confirmLabel: n === 1 ? `Delete ${o.thing}` : `Delete ${n}`,
  };
}
