// The tool list the model reads, at two levels, so every prompt stays small however many tools there are:
// the core tools (and the ones that only explain) and the groups that fit the request in full, with their
// arguments; the other groups by name only. A group goes in full when the model asks for it (list_tools),
// when one of its tools ran this turn, when the latest message is about one of its pages, or when it fits
// the page that's open (in that order, MAX_FULL_GROUPS at most); else when the chat used it lately.

import type { Route } from '@/lib/router';
import type { ChatMessage } from '@/store/assistant';
import { matchPageIntent } from './intents';
import type { StepResult } from './prompt';
import { arg, catalogLine, defineTool, type AnyTool } from './registry';

/** The groups listed by name until they're needed (any other group, the core and the excluded tools, is always in full). */
export const TOOL_GROUP_NAMES = ['social', 'studio', 'marketing', 'brand'] as const;
export type ToolGroupName = (typeof TOOL_GROUP_NAMES)[number];

/** What each group covers, in a few words (shown with its tools' names). */
export const GROUP_ABOUT: Record<ToolGroupName, string> = {
  social: 'posts, the calendar, campaign setup, 30-day plan, 7-day batch, post images and videos, posting with Manus',
  studio: 'prices and packages, the Marketplace listing (copy, images, publishing), outline and chapters or business model, PDF and workbook',
  marketing: 'lead magnet, emails, subscribers, leads, ad campaigns, the SEO page, code & assets, published pages',
  brand: 'brand kit, Brain skills and documents, brand voice, analytics, the Marketplace, product ideas, projects, backup',
};

/** The groups that fit each page, most fitting first (Code & assets is in Studio, its tools are marketing's). */
const PAGE_GROUPS: Partial<Record<Route, ToolGroupName[]>> = {
  dashboard: ['social'],
  calendar: ['social'],
  'marketing-social': ['social'],
  studio: ['studio', 'marketing'],
  marketing: ['marketing'],
  'marketing-seo': ['marketing'],
  'marketing-email': ['marketing'],
  'marketing-ads': ['marketing'],
  store: ['brand', 'studio'],
  brain: ['brand'],
  analytics: ['brand'],
  'workspace-settings': ['brand'],
};

/** At most this many groups go in full into one prompt (a group is 3,000-6,000 characters). */
export const MAX_FULL_GROUPS = 2;

const LIST_TOOLS = 'list_tools';

const isGroupName = (g: unknown): g is ToolGroupName => typeof g === 'string' && (TOOL_GROUP_NAMES as readonly string[]).includes(g);

/** The groups the latest message is about, by the page it names ("my lead magnet" is Email). */
function messageGroups(message: string): ToolGroupName[] {
  const intent = matchPageIntent(message);
  if (!intent) return [];
  if (intent.route === 'studio' && intent.tab === 'code') return ['marketing'];
  return PAGE_GROUPS[intent.route] ?? [];
}

export interface CatalogInput {
  route: Route | null;
  /** the owner's latest message */
  message?: string;
  /** this turn's results so far */
  results?: StepResult[];
  /** the chat before the latest message (oldest first) */
  history?: ChatMessage[];
}

/** Which groups go in full, most needed first. */
export function fullGroups(groups: Record<string, AnyTool[]>, o: CatalogInput): ToolGroupName[] {
  const groupOf = new Map<string, ToolGroupName>();
  for (const [g, tools] of Object.entries(groups)) if (isGroupName(g)) for (const t of tools) groupOf.set(t.name, g);
  const results = [...(o.results ?? [])].reverse();
  const asked = results.filter((r) => r.tool === LIST_TOOLS && r.ok).map((r) => (r.result as { group?: unknown } | undefined)?.group);
  const used = results.map((r) => groupOf.get(r.tool));
  const lately = [...(o.history ?? [])].reverse().map((m) => (m.role === 'activity' && m.tool ? groupOf.get(m.tool) : undefined));
  const wanted = [...asked, ...used, ...messageGroups(o.message ?? ''), ...(o.route ? PAGE_GROUPS[o.route] ?? [] : [])].filter(isGroupName);
  const out = [...new Set(wanted)].slice(0, MAX_FULL_GROUPS);
  // with room left, the group the chat used most recently
  const recent = lately.find((g): g is ToolGroupName => !!g && !out.includes(g));
  return recent && out.length < MAX_FULL_GROUPS ? [...out, recent] : out;
}

/**
 * The tool list for one step: `full` with the groups that fit (see fullGroups), and `compact` with every group
 * by name only (what a prompt falls back to when it runs long).
 */
export function toolCatalog(groups: Record<string, AnyTool[]>, o: CatalogInput): { full: string; compact: string; groups: ToolGroupName[] } {
  const inFull = fullGroups(groups, o);
  const render = (full: ToolGroupName[]) => {
    const always: AnyTool[] = [];
    const later: AnyTool[] = [];
    const named: string[] = [];
    for (const [g, tools] of Object.entries(groups)) {
      if (!isGroupName(g)) (g === 'excluded' ? later : always).push(...tools);
      else if (full.includes(g)) always.push(...tools);
      else if (tools.length) named.push(`- ${g} (${GROUP_ABOUT[g]}): ${tools.map((t) => t.name).join(', ')}`);
    }
    const lines = [...always, ...later].map(catalogLine);
    if (named.length) lines.push(`More tools, by name only: call ${LIST_TOOLS} {group} first to see their arguments (listed in full from your next step).`, ...named);
    return lines.join('\n');
  };
  return { full: render(inFull), compact: render([]), groups: inFull };
}

/** The model asks for a group's tools in full: the next step's tool list has them (see fullGroups). */
export const listTools = defineTool({
  name: LIST_TOOLS,
  class: 'R',
  summary: 'List a group’s tools in full, with their arguments, from your next step on.',
  args: { group: arg.enum(TOOL_GROUP_NAMES) },
  run: ({ group }) => ({ data: { group, next: 'Its tools are in the tool list, with their arguments, in your next step.' }, note: `Looked up the ${group} tools` }),
});
