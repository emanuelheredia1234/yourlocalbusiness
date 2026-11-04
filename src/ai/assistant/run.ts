// One chat turn: ask the AI, run the tools it asks for under each class's rules, and ask again with
// their results, until it's done or the step cap. A turn isn't tied to the chat panel (closing the
// panel doesn't stop it; Stop does) and counts as an app-wide job in the busy registry, so moving
// between pages carries on and a reload warns first.
//
// The policy (runAction) is what keeps the assistant safe, whatever the model says: reads and local
// changes run; AI writing runs and is noted (writing that makes many requests, like a whole PDF, asks on
// a card first); videos, Manus, and a message drafted for Manus or Viktor wait for a card the owner confirms
// in the chat (the message goes only on yes, as the owner's); deletes wait for a
// danger confirm; public actions only open the app's own window; excluded tools are refused with the
// reason and the page where the owner does it.

import { currentRoute } from '@/lib/router';
import { beginBusy, endBusy } from '@/lib/busy';
import { useStore } from '@/store/useStore';
import { addMessage, askCard, beginTurn, chatOf, clearChat, endTurn, registerButtons, setStage, stopTurn, useAssistant, type ActivityStatus } from '@/store/assistant';
import { parseStep, type Action } from './protocol';
import { buildPrompt, type StepResult } from './prompt';
import { checkArgs, type AnyTool, type ArgProps, type ChatButton, type ConfirmCardSpec, type MediaKind, type PubWindow, type Registry, type ToolContext, type ToolResult } from './registry';
import { TOOL_GROUPS, registry } from './tools';
import { toolCatalog } from './catalog';
import { host } from './host';
import { matchPageIntent } from './intents';
import { workspaceSummary } from './workspace';
import { pageName } from './nav';
import { AssistantError, type Availability } from './transport';

/** AI requests per owner message, at most. */
export const MAX_STEPS = 6;
/** The busy-registry job a turn holds (app-wide: moving between pages doesn't stop it). */
export const BUSY_ID = 'assistant';
export const BUSY_LABEL = 'Assistant';

/** The turn an action runs in: its project, its Stop, and which step it is. */
export interface Turn {
  projectId: string;
  signal: AbortSignal;
  step: number;
}

const words = (name: string) => name.replace(/_/g, ' ');

function activity(turn: Turn, o: { tool: string; text: string; status: ActivityStatus; ai?: 'used' | 'builtin'; buttons?: ChatButton[] }) {
  addMessage(turn.projectId, { role: 'activity', text: o.text, tool: o.tool, status: o.status, ...(o.ai ? { ai: o.ai } : {}), ...(o.buttons?.length ? { buttons: registerButtons(o.buttons) } : {}) });
}

/** A card for a video, Manus or agent-message tool that didn't word its own. */
function plainCard(tool: AnyTool, kind: MediaKind): ConfirmCardSpec {
  const title = `${words(tool.name)[0].toUpperCase()}${words(tool.name).slice(1)}?`;
  // a message for Manus or Viktor: like a Manus job, it waits for the owner's yes (who answers, and that it's paid)
  if (kind === 'agent') return { title, what: tool.summary, who: 'Manus or Viktor (in Slack), who get it as your message.', cost: 'Uses your Manus credits, or counts toward your viktor.com plan.', confirmLabel: 'Send' };
  return {
    title,
    what: tool.summary,
    who: kind === 'manus' ? 'Manus, an AI agent working in its own browser (usually a few minutes).' : 'The key that powers Videos in Settings → AI.',
    cost: kind === 'manus' ? 'Uses your Manus credits.' : 'Billed to that key by the second.',
    confirmLabel: 'Go ahead',
  };
}

function windowNote(w: PubWindow): string {
  switch (w.kind) {
    case 'manus-post':
      return `Opened “Post with Manus” for ${w.postIds.length === 1 ? 'the post' : `${w.postIds.length} posts`}: check the account and when, then confirm there`;
    case 'manus-groups':
      return 'Opened “Post to groups”: choose the groups, then confirm there';
    case 'mark-posted':
      return 'Opened “Mark as posted”: add the link if you have one, then confirm there';
    case 'listing':
      return w.action === 'publish' ? 'Opened “Publish listing”: check what goes public, then confirm there' : `Opened “${w.action === 'show' ? 'Show' : 'Hide'} my listings”: confirm there`;
    case 'publish':
      return `Opened the Publish panel for ${w.page === 'seo' ? 'your SEO page' : `“${w.name}”`}: check the address, then publish there`;
    case 'agent-build':
      return `Opened “Build with ${w.agent === 'manus' ? 'Manus' : 'Viktor'}” for ${w.target === 'seo' ? 'your SEO page' : 'a new asset in Code & assets'}: fill it in and send it there`;
    case 'page':
      return `Opened ${pageName(w.route, w.tab)}: confirm there`;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Show a card in the chat and wait for the owner: null once they said yes, else what the step reports. */
async function askFirst(spec: ConfirmCardSpec, turn: Turn, tool: string): Promise<StepResult | null> {
  const base = { step: turn.step, tool };
  setStage('Waiting for you to confirm…');
  // the card is in the chat: show it, even if the owner closed the chat meanwhile
  useAssistant.getState().setOpen(true);
  const { answer } = askCard(turn.projectId, spec);
  const yes = await answer;
  if (!yes) return { ...base, ok: false, status: turn.signal.aborted ? 'cancelled' : 'declined', error: turn.signal.aborted ? 'Stopped by the owner.' : 'The owner said no on the card: nothing was started.' };
  if (turn.signal.aborted) return { ...base, ok: false, status: 'cancelled', error: 'Stopped by the owner.' };
  return null;
}

/** Run the tool, and note in the chat what it did (and whether AI wrote it). */
async function execute(tool: AnyTool & { run: (a: never, c: ToolContext) => ToolResult | Promise<ToolResult> }, args: Record<string, unknown>, ctx: ToolContext, turn: Turn): Promise<StepResult> {
  const base = { step: turn.step, tool: tool.name };
  let r: ToolResult;
  try {
    r = await tool.run(args as never, ctx);
  } catch (e) {
    if (turn.signal.aborted || (e as { code?: string })?.code === 'cancelled') return { ...base, ok: false, status: 'cancelled', error: 'Stopped by the owner.' };
    const msg = (e as Error)?.message || 'Something went wrong.';
    activity(turn, { tool: tool.name, text: `Couldn’t ${words(tool.name)}: ${msg}`, status: 'failed' });
    return { ...base, ok: false, status: 'failed', error: msg };
  }
  const ok = r.ok !== false;
  const used = ctx.ai.length ? (ctx.ai.some((a) => a.provider !== 'local') ? 'used' : 'builtin') : undefined;
  const why = used === 'builtin' ? ctx.ai.find((a) => a.note)?.note : undefined;
  const text = r.note ?? (ok ? `Done: ${words(tool.name)}` : `Couldn’t ${words(tool.name)}${r.error ? `: ${r.error}` : ''}`);
  activity(turn, { tool: tool.name, text: why ? `${text}. ${why}` : text, status: ok ? 'ok' : 'failed', ai: used, buttons: r.buttons });
  const aiLine = used === 'used' ? 'written by the owner’s AI' : used === 'builtin' ? `written by the built-in engine (the AI couldn’t answer${why ? `: ${why}` : ''})` : undefined;
  const result = aiLine ? { ...(isObject(r.data) ? r.data : r.data === undefined ? {} : { value: r.data }), ai: aiLine } : r.data;
  return {
    ...base,
    ok,
    status: ok ? 'ok' : 'failed',
    ...(result !== undefined ? { result } : {}),
    ...(ok ? {} : { error: r.error ?? 'It didn’t work.' }),
    ...(r.end ? { end: true } : {}),
  };
}

/** Run one action the AI asked for, under its tool's class rules. */
export async function runAction(action: Action, turn: Turn, tools: Registry = registry): Promise<StepResult> {
  const base = { step: turn.step, tool: action.tool };
  const failed = (error: string, text = error): StepResult => {
    activity(turn, { tool: action.tool, text, status: 'failed' });
    return { ...base, ok: false, status: 'failed', error };
  };
  const tool = tools.get(action.tool);
  if (!tool) return failed(`Unknown tool "${action.tool}". Use only tools from the list.`, `Couldn’t ${words(action.tool)}: that isn’t something I can do here`);

  // excluded: say why, and open the page where the owner does it
  if (tool.class === 'X') {
    const r = tool.refusal;
    const opened = r.route ? await host.openPage(r.route, r.tab).catch(() => false) : false;
    activity(turn, { tool: tool.name, text: r.text, status: 'refused' });
    return { ...base, ok: false, status: 'refused', error: r.text, ...(opened && r.route ? { result: { opened: `#${r.route}${r.tab ? `/${r.tab}` : ''}` } } : {}) };
  }

  const checked = checkArgs(tool.args as ArgProps, action.args);
  if (!checked.ok) return failed(checked.error, `Couldn’t ${words(tool.name)}: ${checked.error}`);
  const args = checked.args;
  const ctx: ToolContext = { signal: turn.signal, projectId: turn.projectId, stage: setStage, ai: [] };
  try {
    const problem = tool.validate?.(args as never, ctx);
    if (problem) return failed(problem, `Couldn’t ${words(tool.name)}: ${problem}`);
  } catch (e) {
    return failed((e as Error)?.message || 'Its details couldn’t be checked.');
  }
  setStage(`Working: ${words(tool.name)}…`);

  switch (tool.class) {
    case 'Pub': {
      // public: the tool only names the app's window; the app opens it and the owner confirms there
      let w: PubWindow | string;
      try {
        w = await tool.window(args as never, ctx);
      } catch (e) {
        return failed((e as Error)?.message || 'The window couldn’t be opened.');
      }
      if (typeof w === 'string') return failed(w, `Couldn’t ${words(tool.name)}: ${w}`);
      if (!(await host.openWindow(w))) return failed('The window couldn’t be opened (the owner stayed on this page).');
      activity(turn, { tool: tool.name, text: windowNote(w), status: 'opened' });
      return { ...base, ok: true, status: 'opened', result: { opened: w.kind, waiting: 'for the owner to confirm in that window: nothing is posted or published until they do' } };
    }
    case 'D': {
      // destructive: only after the owner says yes in the danger confirm
      const yes = await host.confirmDanger(tool.danger(args as never, ctx));
      if (!yes) {
        activity(turn, { tool: tool.name, text: 'You said no, so nothing was deleted', status: 'declined' });
        return { ...base, ok: false, status: 'declined', error: 'The owner said no: nothing was deleted.' };
      }
      if (turn.signal.aborted) return { ...base, ok: false, status: 'cancelled', error: 'Stopped by the owner.' };
      return execute(tool, args, ctx, turn);
    }
    case 'P-media': {
      // AI images run; videos, anything Manus and a drafted message for Manus or Viktor wait for the owner's OK on a card
      const kind = typeof tool.media === 'function' ? tool.media(args as never) : tool.media;
      if (kind !== 'image') {
        const stopped = await askFirst(tool.card?.(args as never, ctx) ?? plainCard(tool, kind), turn, tool.name);
        if (stopped) return stopped;
      }
      return execute(tool, args, ctx, turn);
    }
    case 'P-text': {
      // AI writing runs; writing that makes many requests (a whole PDF) asks on a card first
      const spec = tool.card?.(args as never, ctx);
      if (spec) {
        const stopped = await askFirst(spec, turn, tool.name);
        if (stopped) return stopped;
      }
      return execute(tool, args, ctx, turn);
    }
    default:
      return execute(tool, args, ctx, turn);
  }
}

/** No AI to ask: open the page the message names, and say what's missing. */
async function offlineTurn(projectId: string, message: string, avail: Availability) {
  const intent = matchPageIntent(message);
  const opened = intent ? await host.openPage(intent.route, intent.tab).catch(() => false) : false;
  if (intent && opened) addMessage(projectId, { role: 'activity', tool: 'navigate', status: 'ok', text: `Opened ${intent.label}` });
  addMessage(projectId, {
    role: 'error',
    settings: avail.settings,
    text: `${avail.reason} ${opened ? 'Until then I can only open pages, so I opened the one you mentioned.' : 'Until then I can only open pages: name one (the calendar, the Brain, Settings…) or pick one below.'}`,
  });
}

const stillActive = (projectId: string) => useStore.getState().activeProjectId === projectId;

async function runTurn(projectId: string, message: string, history: ReturnType<typeof chatOf>, signal: AbortSignal) {
  const avail = host.availability();
  if (!avail.ok) return offlineTurn(projectId, message, avail);
  const results: StepResult[] = [];
  const switched = () => {
    addMessage(projectId, { role: 'notice', text: 'You switched projects, so I stopped here.' });
  };
  for (let step = 1; step <= MAX_STEPS; step++) {
    if (signal.aborted) return;
    if (!stillActive(projectId)) return switched();
    setStage(step === 1 ? 'Thinking…' : 'Reading the results…');
    const route = currentRoute();
    // the core tools and the groups this step needs in full, the others by name (list_tools brings one in)
    const tools = toolCatalog(TOOL_GROUPS, { route, message, results, history });
    const prompt = buildPrompt({ message, history, results, route, workspace: workspaceSummary(), catalog: tools.full, catalogFallbacks: tools.fallbacks, step, maxSteps: MAX_STEPS }, host.budget());
    let raw: unknown;
    try {
      raw = await host.ask(prompt, signal);
    } catch (e) {
      if (signal.aborted || (e as AssistantError)?.code === 'cancelled') return;
      const err = e instanceof AssistantError ? e : new AssistantError((e as Error)?.message || 'The AI hit a problem. Try again.', 'error');
      addMessage(projectId, { role: 'error', text: err.message, settings: err.settings });
      return;
    }
    if (signal.aborted) return;
    const parsed = parseStep(raw);
    if (!parsed.actions.length) {
      addMessage(projectId, { role: 'assistant', text: parsed.reply || 'Sorry, I didn’t get a usable answer. Try asking again, maybe in other words.' });
      return;
    }
    // a final reply waits until its actions worked; an interim one shows now
    if (parsed.reply && !parsed.done) addMessage(projectId, { role: 'assistant', text: parsed.reply });
    let allOk = true;
    for (const action of parsed.actions) {
      if (signal.aborted) return;
      if (!stillActive(projectId)) return switched();
      const r = await runAction(action, { projectId, signal, step });
      results.push(r);
      if (signal.aborted || r.status === 'cancelled') return;
      if (!r.ok) allOk = false;
      if (r.end) {
        if (parsed.done && allOk && parsed.reply) addMessage(projectId, { role: 'assistant', text: parsed.reply });
        return;
      }
    }
    if (parsed.done && allOk) {
      if (parsed.reply) addMessage(projectId, { role: 'assistant', text: parsed.reply });
      return;
    }
    // more to do, or something didn't go as the reply assumed: ask again with the results
  }
  addMessage(projectId, { role: 'notice', text: `I stopped after ${MAX_STEPS} steps. Tell me if I should carry on.` });
}

/** Send the owner's message and run the turn (one at a time). Resolves when the turn is over. */
export async function sendToAssistant(text: string): Promise<void> {
  const message = text.trim().slice(0, 6000);
  if (!message || useAssistant.getState().running) return;
  const projectId = useStore.getState().activeProjectId;
  if (!projectId) return;
  const history = chatOf(projectId);
  addMessage(projectId, { role: 'user', text: message });
  const signal = beginTurn(projectId);
  beginBusy(BUSY_ID, BUSY_LABEL, 'app');
  try {
    await runTurn(projectId, message, history, signal);
  } catch (e) {
    // a mistake in a tool must not leave the chat stuck
    if (!signal.aborted) addMessage(projectId, { role: 'error', text: `Something went wrong: ${(e as Error)?.message || 'unknown error'}. Try again.` });
  } finally {
    endBusy(BUSY_ID);
    endTurn(signal);
  }
}

/** Stop the running turn (what it's doing is cancelled; a waiting card counts as no). */
export function stopAssistant(): void {
  const pid = useAssistant.getState().runProjectId;
  if (stopTurn() && pid) addMessage(pid, { role: 'notice', text: 'Stopped.' });
}

/** Start over: stops a turn running in this project's chat, then forgets the chat. */
export function newChat(projectId: string): void {
  if (useAssistant.getState().runProjectId === projectId) stopTurn();
  clearChat(projectId);
}
