// Every tool the assistant has, by group. Each group lives in its own file so they can grow apart;
// a name used twice, or a badly formed one, throws here (and fails the tests).

import { createRegistry } from '../registry';
import { coreTools } from './core';
import { socialTools } from './social';
import { studioTools } from './studio';
import { marketingTools } from './marketing';
import { brandTools } from './brand';
import { agentTools } from './agents';
import { excludedTools } from './excluded';

export const TOOL_GROUPS = { core: coreTools, social: socialTools, studio: studioTools, marketing: marketingTools, brand: brandTools, agents: agentTools, excluded: excludedTools };

export const registry = createRegistry(Object.values(TOOL_GROUPS).flat());
