import { it } from 'vitest';
import { useStore } from '@/store/useStore';
import { defaultSettings, newProject } from '@/store/defaults';
import { buildPrompt } from '@/ai/assistant/prompt';
import { registry, TOOL_GROUPS } from '@/ai/assistant/tools';
import { catalogLine } from '@/ai/assistant/registry';
import { toolCatalog } from '@/ai/assistant/catalog';
import { workspaceSummary } from '@/ai/assistant/workspace';
import { APP_GUIDE } from '@/ai/assistant/guide';
import { ROUTES } from '@/lib/router';

it('measures', () => {
  const project = { ...newProject('business', 'existing'), id: 'p1', onboarded: true, businessType: 'Bakery', location: { city: 'Austin', region: 'TX' } };
  project.brand.name = 'Copper Kettle';
  useStore.setState({ projects: [project], activeProjectId: 'p1', posts: [], notices: [], myListings: [], ads: [], settings: defaultSettings() });
  const out: string[] = [];
  out.push(`full catalog ${registry.catalog().length} guide ${APP_GUIDE.length} workspace ${JSON.stringify(workspaceSummary()).length}`);
  for (const [g, tools] of Object.entries(TOOL_GROUPS)) out.push(`${g}: ${tools.length} tools, ${tools.map(catalogLine).join('\n').length} chars`);
  for (const route of ROUTES) {
    const c = toolCatalog(TOOL_GROUPS, { route, message: 'What is due on my calendar?', results: [], history: [] });
    const p = buildPrompt({ message: 'What is due on my calendar?', history: [], results: [], route, workspace: workspaceSummary(), catalog: c.full, catalogCompact: c.compact, step: 1, maxSteps: 6 });
    out.push(`${route}: groups ${c.groups.join('+')} catalog ${c.full.length} compact ${c.compact.length} prompt ${p.length}`);
  }
  const all = toolCatalog(TOOL_GROUPS, { route: 'studio', message: 'my lead magnet and ads', results: [{ step: 1, tool: 'list_tools', ok: true, status: 'ok', result: { group: 'brand' } }], history: [] });
  out.push(`worst: ${all.groups.join('+')} ${all.full.length}`);
  for (const t of TOOL_GROUPS.marketing) out.push(`  ${catalogLine(t).length} ${t.name}`);
  console.log(out.join('\n'));
});
