// The tool list the model reads, at two levels, so a prompt stays small however many tools the groups get:
// the core tools (and the ones that only explain) are always listed in full, with their arguments, and so are
// the groups this step needs; every other group is one line of tool names. A group goes in full when the model
// asked for it with list_tools this turn (always), and otherwise, most needed first, while the groups in full
// fit in GROUP_BUDGET characters (the first one always): a group whose tool ran this turn, the one the latest
// message is about, the one the chat used last, then the ones that fit the open page.
//
// Any tool runs when called by name (the policy checks its arguments); a group whose tool was called is in
// full from the next step on, so a wrong guess at the arguments is fixed there.

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

/**
 * The most characters the groups a step lists in full may take (their tool lines), beyond the ones the model
 * asked for. The most needed group always goes in full, so a group should stay under this by itself: one that
 * outgrows it is split in two (catalog.test.ts checks). With it, a usual prompt is about 15,000-22,000
 * characters, whatever the number of groups.
 */
export const GROUP_BUDGET = 8_000;

const LIST_TOOLS = 'list_tools';

const isGroupName = (g: unknown): g is ToolGroupName => typeof g === 'string' && (TOOL_GROUP_NAMES as readonly string[]).includes(g);
const uniq = <T>(list: T[]) => [...new Set(list)];

/** A group's tool lines, as the tool list shows them in full. */
export const groupText = (tools: AnyTool[]) => tools.map(catalogLine).join('\n');

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

/** The groups the model asked for with list_tools this turn, newest first. */
function askedGroups(groups: Record<string, AnyTool[]>, results: StepResult[]): ToolGroupName[] {
  const asked = [...results].reverse().filter((r) => r.tool === LIST_TOOLS && r.ok);
  return uniq(asked.map((r) => (r.result as { group?: unknown } | undefined)?.group).filter(isGroupName)).filter((g) => groups[g]?.length);
}

/**
 * The groups a step lists in full, most needed first: every group the model asked for this turn, then the ones
 * it most likely needs while they all fit in `budget` characters (see the top of this file).
 */
export function fullGroups(groups: Record<string, AnyTool[]>, o: CatalogInput, budget = GROUP_BUDGET): ToolGroupName[] {
  const groupOf = new Map<string, ToolGroupName>();
  const size = new Map<ToolGroupName, number>();
  for (const [g, tools] of Object.entries(groups)) {
    if (!isGroupName(g) || !tools.length) continue;
    for (const t of tools) groupOf.set(t.name, g);
    size.set(g, groupText(tools).length);
  }
  const results = o.results ?? [];
  const asked = askedGroups(groups, results);
  const used = [...results].reverse().map((r) => groupOf.get(r.tool));
  const lately = [...(o.history ?? [])].reverse().map((m) => (m.role === 'activity' && m.tool ? groupOf.get(m.tool) : undefined)).find(Boolean);
  // a follow-up ("make it shorter") is about what the chat just did, more than about the page that's open
  const wanted = uniq([...used, ...messageGroups(o.message ?? ''), lately, ...(o.route ? PAGE_GROUPS[o.route] ?? [] : [])]).filter((g): g is ToolGroupName => isGroupName(g) && size.has(g) && !asked.includes(g));
  const out: ToolGroupName[] = [...asked];
  let total = asked.reduce((n, g) => n + (size.get(g) ?? 0), 0);
  for (const g of wanted) {
    const n = size.get(g) ?? 0;
    // the most needed group always; the next ones only while they fit
    if (out.length && total + n > budget) continue;
    out.push(g);
    total += n;
  }
  return out;
}

export interface ToolCatalog {
  /** this step's tool list: the core and the excluded tools, the groups in `groups` in full, the others by name */
  full: string;
  /** shorter lists for a prompt that runs long, longest first: only the groups the model asked for in full, then none */
  fallbacks: string[];
  /** the groups in full in `full`, most needed first */
  groups: ToolGroupName[];
}

/** The tool list for one step (see fullGroups), and the shorter ones a long prompt falls back to. */
export function toolCatalog(groups: Record<string, AnyTool[]>, o: CatalogInput, budget = GROUP_BUDGET): ToolCatalog {
  const inFull = fullGroups(groups, o, budget);
  const asked = askedGroups(groups, o.results ?? []);
  const render = (full: ToolGroupName[]) => {
    const first: AnyTool[] = [];
    const last: AnyTool[] = [];
    const named: string[] = [];
    // the core and the groups in full (in the registry's order), the tools that only explain, then the others by name
    for (const [g, tools] of Object.entries(groups)) {
      if (g === 'excluded') last.push(...tools);
      else if (!isGroupName(g) || full.includes(g)) first.push(...tools);
      else if (tools.length) named.push(`- ${g} (${GROUP_ABOUT[g]}): ${tools.map((t) => t.name).join(', ')}`);
    }
    const lines = [...first, ...last].map(catalogLine);
    if (named.length) lines.push(`More tools, by name only: call ${LIST_TOOLS} {group} to see a group's arguments (it is listed in full from your next step, so keep done false).`, ...named);
    return lines.join('\n');
  };
  const full = render(inFull);
  return { full, fallbacks: uniq([render(asked), render([])]).filter((t) => t !== full), groups: inFull };
}

/** The model asks for a group's tools in full: the next step's tool list has them (see fullGroups). */
export const listTools = defineTool({
  name: LIST_TOOLS,
  class: 'R',
  summary: 'See a group’s tools with their arguments: they are in the tool list from your next step on (keep done false).',
  args: { group: arg.enum(TOOL_GROUP_NAMES) },
  run: ({ group }) => ({ data: { group, next: 'Its tools are in the tool list, with their arguments, from your next step on.' }, note: `Looked up the ${group} tools` }),
});
