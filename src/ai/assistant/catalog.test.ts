// The tool list at two levels: the core and the groups a step needs in full (the page's, the latest
// message's, ones listed with list_tools or used this turn), the others by name only; and a turn that
// asks for a group gets it in full in its next step.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/store/assistant';
import { chatOf, clearChat, useAssistant } from '@/store/assistant';
import { setAssistantHost } from './host';
import { GROUP_ABOUT, MAX_FULL_GROUPS, TOOL_GROUP_NAMES, fullGroups, toolCatalog } from './catalog';
import type { StepResult } from './prompt';
import { catalogLine } from './registry';
import { sendToAssistant } from './run';
import { TOOL_GROUPS, registry } from './tools';
import { runTool, seedWorkspace } from './testing';

const result = (tool: string, extra: Partial<StepResult> = {}): StepResult => ({ step: 1, tool, ok: true, status: 'ok', ...extra });
const activity = (tool: string): ChatMessage => ({ id: `m${Math.random()}`, role: 'activity', text: 'Done', tool, status: 'ok', at: 1 });
const full = (text: string, group: keyof typeof TOOL_GROUPS) => TOOL_GROUPS[group].every((t) => text.includes(catalogLine(t)));
const named = (text: string, group: (typeof TOOL_GROUP_NAMES)[number]) => text.includes(`\n- ${group} (${GROUP_ABOUT[group]}): ${TOOL_GROUPS[group].map((t) => t.name).join(', ')}`);

describe('the tool list', () => {
  it('has the core and the excluded tools in full, the page’s group in full, the others by name with how to get them', () => {
    const c = toolCatalog(TOOL_GROUPS, { route: 'marketing-ads', message: 'hello' });
    expect(c.groups).toEqual(['marketing']);
    expect(full(c.full, 'core') && full(c.full, 'excluded') && full(c.full, 'marketing')).toBe(true);
    for (const g of ['social', 'studio', 'brand'] as const) {
      expect(named(c.full, g), g).toBe(true);
      expect(c.full).not.toContain(catalogLine(TOOL_GROUPS[g][0]));
    }
    expect(c.full).toContain('call list_tools {group} first to see their arguments');
    // every tool is named either way
    for (const t of registry.tools) {
      expect(c.full).toContain(t.name);
      expect(c.compact).toContain(t.name);
    }
    // compact: only the core and the excluded tools in full
    expect(full(c.compact, 'core') && full(c.compact, 'excluded')).toBe(true);
    for (const g of TOOL_GROUP_NAMES) expect(named(c.compact, g), g).toBe(true);
  });

  it('fits each page: Studio has Code & assets (marketing’s), the Marketplace has brand and studio', () => {
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard' })).toEqual(['social']);
    expect(fullGroups(TOOL_GROUPS, { route: 'calendar' })).toEqual(['social']);
    expect(fullGroups(TOOL_GROUPS, { route: 'studio' })).toEqual(['studio', 'marketing']);
    expect(fullGroups(TOOL_GROUPS, { route: 'store' })).toEqual(['brand', 'studio']);
    expect(fullGroups(TOOL_GROUPS, { route: 'workspace-settings' })).toEqual(['brand']);
    expect(fullGroups(TOOL_GROUPS, { route: 'onboarding' })).toEqual([]);
    expect(fullGroups(TOOL_GROUPS, { route: null })).toEqual([]);
  });

  it('puts first what this step needs: asked for with list_tools, then used this turn, then the latest message’s page, then the open page', () => {
    // the latest message names another page's things
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'Write my lead magnet' })).toEqual(['marketing', 'social']);
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'Make my calculator dark' })).toEqual(['marketing', 'social']);
    // a tool of the group ran this turn (even one that failed, so its arguments are there to retry)
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'hi', results: [result('update_brand', { ok: false, status: 'failed' })] })).toEqual(['brand', 'social']);
    // asked for: first, and at most MAX_FULL_GROUPS in all
    const asked = fullGroups(TOOL_GROUPS, { route: 'studio', message: 'Write my lead magnet', results: [result('list_tools', { result: { group: 'brand' } })] });
    expect(asked).toEqual(['brand', 'marketing']);
    expect(asked.length).toBeLessThanOrEqual(MAX_FULL_GROUPS);
    // a refused list_tools (a bad group) brings in nothing
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', results: [result('list_tools', { ok: false, status: 'failed' })] })).toEqual(['social']);
  });

  it('with room left, keeps the group the chat used most recently (a follow-up like “make it shorter”)', () => {
    const history = [activity('update_post'), activity('edit_email')];
    expect(fullGroups(TOOL_GROUPS, { route: 'dashboard', message: 'Make it shorter', history })).toEqual(['social', 'marketing']);
    // no room: the page and the message come first
    expect(fullGroups(TOOL_GROUPS, { route: 'studio', message: 'Make it shorter', history: [activity('update_brand')] })).toEqual(['studio', 'marketing']);
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
