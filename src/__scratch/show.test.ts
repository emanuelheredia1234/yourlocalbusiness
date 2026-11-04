import { it } from 'vitest';
import { TOOL_GROUPS } from '@/ai/assistant/tools';
import { toolCatalog } from '@/ai/assistant/catalog';

it('shows', () => {
  const c = toolCatalog(TOOL_GROUPS, { route: 'marketing-email', message: 'write my lead magnet', results: [], history: [] });
  console.log(c.groups.join('+'), c.full.length);
  console.log(c.full);
});
