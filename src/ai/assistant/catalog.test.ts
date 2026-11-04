// The tool list at two levels: the core and the groups a step needs in full (asked for with list_tools,
// used this turn, the latest message's, the chat's last, the page's), within a character budget, and the
// others by name only; a turn that asks for a group gets it in full in its next step.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/store/assistant';
import { chatOf, clearChat, useAssistant } from '@/store/assistant';
import { setAssistantHost } from './host';
import { GROUP_ABOUT, GROUP_BUDGET, TOOL_GROUP_NAMES, fullGroups, groupText, toolCatalog } from './catalog';
import type { StepResult } from './prompt';
import { catalogLine, defineTool, type AnyTool } from './registry';
import { sendToAssistant } from './run';
import { TOOL_GROUPS, registry } from './tools';
import { runTool, seedWorkspace } from './testing';

type Group = (typeof TOOL_GROUP_NAMES)[number];
const result = (tool: string, extra: Partial<StepResult> = {}): StepResult => ({ step: 1, tool, ok: true, status: 'ok', ...extra });
const asked = (group: Group) => result('list_tools', { result: { group } });
const activity = (tool: string): ChatMessage => ({ id: `m${Math.random()}`, role: 'activity', text: 'Done', tool, status: 'ok', at: 1 });
const full = (text: string, group: keyof typeof TOOL_GROUPS) => TOOL_GROUPS[group].every((t) => text.includes(catalogLine(t)));
const named = (text: string, group: Group) => text.includes(`\n- ${group} (${GROUP_ABOUT[group]}): ${TOOL_GROUPS[group].map((t) => t.name).join(', ')}`);
const size = (g: Group) => groupText(TOOL_GROUPS[g]).length;
const ALL = Infinity;

describe('the tool list', () => {
  it('has the core and the excluded tools in full, the page’s group in full, the others by name with how to get them', () => {
    const c = toolCatalog(TOOL_GROUPS, { route: 'marketing-ads', message: 'hello' });
    expect(c.groups).toEqual(['marketing']);
    expect(full(c.full, 'core') && full(c.full, 'excluded') && full(c.full, 'marketing')).toBe(true);
    for (const g of ['social', 'studio', 'brand'] as const) {
      expect(named(c.full, g), g).toBe(true);
      expect(c.full).not.toContain(catalogLine(TOOL_GROUPS[g][0]));
    }
    expect(c.full).toContain('call list_tools {group} to see a group\'s arguments (it is listed in full from your next step, so keep done false)');
    // shorter: every group by name (nothing was asked for)
    expect(c.fallbacks).toHaveLength(1);
    const [names] = c.fallbacks;
    expect(full(names, 'core') && full(names, 'excluded')).toBe(true);
    for (const g of TOOL_GROUP_NAMES) expect(named(names, g), g).toBe(true);
    // every tool is named either way
    for (const t of registry.tools) {
      expect(c.full).toContain(t.name);
      expect(names).toContain(t.name);
    }
  });

  it('fits each page: Studio has Code & assets (marketing’s) next, the Marketplace has studio next, when there’s room', () => {
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard' })).toEqual(['social']);
    expect(fullGroups(TOOL_GROUPS, { route: 'calendar' })).toEqual(['social']);
    expect(fullGroups(TOOL_GROUPS, { route: 'workspace-settings' })).toEqual(['brand']);
    expect(fullGroups(TOOL_GROUPS, { route: 'studio' }, ALL)).toEqual(['studio', 'marketing']);
    expect(fullGroups(TOOL_GROUPS, { route: 'store' }, ALL)).toEqual(['brand', 'studio']);
    expect(fullGroups(TOOL_GROUPS, { route: 'studio' })[0]).toBe('studio');
    expect(fullGroups(TOOL_GROUPS, { route: 'onboarding' })).toEqual([]);
    expect(fullGroups(TOOL_GROUPS, { route: null })).toEqual([]);
  });

  it('puts first what this step needs: used this turn, then the latest message’s page, then the chat’s last group, then the open page', () => {
    // the latest message names another page's things
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'Write my lead magnet' }, ALL)).toEqual(['marketing', 'social']);
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'Make my calculator dark' }, ALL)).toEqual(['marketing', 'social']);
    // a tool of the group ran this turn (even one that failed, so its arguments are there to retry)
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'hi', results: [result('update_brand', { ok: false, status: 'failed' })] }, ALL)).toEqual(['brand', 'social']);
    // a follow-up like “make it shorter” is about what the chat just did
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'Make it shorter', history: [activity('update_post'), activity('edit_email')] }, ALL)).toEqual(['marketing', 'social']);
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'Make it shorter', history: [activity('edit_email')] })[0]).toBe('marketing');
    // a refused list_tools (a bad group) brings in nothing
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', results: [result('list_tools', { ok: false, status: 'failed' })] })).toEqual(['social']);
  });

  it('lists in full what it can within its budget (the most needed group always), and every group fits it by itself', () => {
    for (const g of TOOL_GROUP_NAMES) expect(size(g), `${g} has outgrown GROUP_BUDGET: split it into two groups`).toBeLessThanOrEqual(GROUP_BUDGET);
    const cases = [
      { route: 'studio' as const },
      { route: 'store' as const },
      { route: 'marketing-email' as const, message: 'What is due on my calendar?' },
      { route: 'dashboard' as const, message: 'Write my lead magnet' },
      { route: 'calendar' as const, message: 'Make it shorter', history: [activity('update_brand')] },
    ];
    for (const o of cases) {
      const groups = fullGroups(TOOL_GROUPS, o);
      expect(groups.length).toBeGreaterThan(0);
      expect(groups.reduce((n, g) => n + size(g), 0), JSON.stringify(o)).toBeLessThanOrEqual(GROUP_BUDGET);
      // with no budget there are more, in the same order
      const unbounded = fullGroups(TOOL_GROUPS, o, ALL);
      expect(groups[0]).toBe(unbounded[0]);
      expect(unbounded.filter((g) => groups.includes(g))).toEqual(groups);
    }
    // a small budget keeps only the most needed group
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'Write my lead magnet' }, 10)).toEqual(['marketing']);
  });

  it('a group the model asked for is in full whatever the budget, first, with the others after it while they fit', () => {
    const o = { route: 'studio' as const, message: 'Write my lead magnet', results: [asked('brand'), asked('social')] };
    expect(fullGroups(TOOL_GROUPS, o, 10)).toEqual(['social', 'brand']);
    const tight = toolCatalog(TOOL_GROUPS, o, 10);
    expect(full(tight.full, 'brand') && full(tight.full, 'social') && named(tight.full, 'marketing')).toBe(true);
    expect(tight.fallbacks).toHaveLength(1);
    // with room, the step's own groups follow; a long prompt drops them first, then the asked-for ones
    const d = { route: 'dashboard' as const, message: 'hello', results: [asked('studio')] };
    expect(fullGroups(TOOL_GROUPS, d, ALL)).toEqual(['studio', 'social']);
    const c = toolCatalog(TOOL_GROUPS, d, ALL);
    expect(full(c.full, 'studio') && full(c.full, 'social')).toBe(true);
    expect(c.fallbacks).toHaveLength(2);
    expect(full(c.fallbacks[0], 'studio') && named(c.fallbacks[0], 'social')).toBe(true);
    expect(named(c.fallbacks[1], 'studio') && named(c.fallbacks[1], 'social')).toBe(true);
  });

  it('grows by a name, not a line, for each tool a step doesn’t need (more tools keep a prompt the same size)', () => {
    const extra: AnyTool[] = Array.from({ length: 60 }, (_, i) => defineTool({ name: `extra_brand_tool_${i}`, class: 'R', summary: `An extra tool with a long summary that would cost a lot of room in every prompt (${i}).`, args: {}, run: () => ({}) }));
    const bigger = { ...TOOL_GROUPS, brand: [...TOOL_GROUPS.brand, ...extra] };
    const before = toolCatalog(TOOL_GROUPS, { route: 'marketing-email', message: 'hello' }).full.length;
    const after = toolCatalog(bigger, { route: 'marketing-email', message: 'hello' }).full.length;
    expect(after - before).toBeLessThan(extra.reduce((n, t) => n + t.name.length + 2, 0) + 1);
    expect(after - before).toBeLessThan(groupText(extra).length / 5);
  });
});

describe('list_tools', () => {
  beforeEach(() => {
    seedWorkspace();
  });

  it('is a core read tool: it names the group, which the next step lists in full', async () => {
    expect(registry.get('list_tools')?.class).toBe('R');
    expect(TOOL_GROUPS.core.some((t) => t.name === 'list_tools')).toBe(true);
    expect(await runTool('list_tools', { group: 'Marketing' })).toMatchObject({ ok: true, result: { group: 'marketing' } });
    expect(await runTool('list_tools', { group: 'everything' })).toMatchObject({ ok: false, error: expect.stringContaining('group must be one of: social, studio, marketing, brand') });
  });
});

describe('a turn', () => {
  let restore: () => void;
  let prompts: string[];
  beforeEach(() => {
    seedWorkspace();
    prompts = [];
    useAssistant.setState({ key: 'ylb-assistant:test', threads: {}, running: false, stage: '', runProjectId: null });
  });
  afterEach(() => {
    restore();
    clearChat('p1');
  });

  it('gets a group in full in the step after it asks for it with list_tools', async () => {
    restore = setAssistantHost({
      availability: () => ({ ok: true, reason: '', settings: false }),
      budget: () => 48_000,
      ask: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? { reply: '', actions: [{ tool: 'list_tools', args: { group: 'brand' } }], done: false } : { reply: 'Here’s what I can do with your brand.', actions: [], done: true };
      },
    });
    await sendToAssistant('Hello there');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain(catalogLine(registry.get('update_brand')!));
    expect(prompts[0]).toContain('- brand (');
    expect(prompts[1]).toContain(catalogLine(registry.get('update_brand')!));
    expect(chatOf('p1').find((m) => m.role === 'activity')).toMatchObject({ tool: 'list_tools', text: 'Looked up the brand tools' });
  });
});
