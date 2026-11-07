// The assistant's email studio group (P5 §A8): read an email's design, design it or make it bolder with AI (a
// confirm card first: it uses AI credits), set its theme, add, edit, move and remove blocks (no AI; checked by
// the shared normalizeDoc), download its HTML for an email tool, and open the Manus/Viktor build window for an
// email or the lead magnet (the owner sends from there). The assistant never writes custom HTML into an email:
// that is pasted and cleaned in the studio, so model-written HTML never reaches a doc unreviewed.

import type { Block, BlockType, EmailDoc, Link, ThemeId } from '../../../../shared/email/blocks.mjs';
import { BLOCK_TYPES, THEME_IDS, normalizeDoc } from '../../../../shared/email/blocks.mjs';
import { ESP_IDS, ESP_TOOLS, RenderError, type EspId } from '../../../../shared/email/render.mjs';
import type { EmailStep, Project } from '@/lib/types';
import { listJoin, plural, slugify } from '@/lib/utils';
import { docOf, emailHtml, replaceDoc, setDoc, updateEmailTheme } from '@/lib/emailDoc';
import { busyJobs } from '@/lib/busy';
import { emailBlocksEditTask, emailBolderTask, emailDesignTask } from '@/ai/tasks';
import { agentReady, agentName } from '@/ai/agents/who';
import { download } from '@/components/ui/download';
import { BLOCK_LABEL, blockSummary, moveBlock, newBlock, removeBlock } from '@/pages/marketing/email/studio/blockOps';
import { designInput } from '@/pages/marketing/email/studio/AIActions';
import { warningLines } from '@/pages/marketing/email/studio/EmailFrame';
import { useStore } from '@/store/useStore';
import { runAITask } from '../aiTask';
import { noteInChat } from '../buttons';
import { activeProject } from '../lookup';
import { arg, defineTool, type AnyTool, type ToolContext } from '../registry';

const projectOf = (ctx: ToolContext): Project => useStore.getState().projects.find((p) => p.id === ctx.projectId) ?? activeProject();
const AGENTS = ['manus', 'viktor'] as const;
const EMAIL = arg.string({ max: 60, desc: 'an email id, or 1-5' });
const NO_CUSTOM = 'Paste custom HTML in the email studio (Email › Sequence › an email › Add block › Custom HTML): it is cleaned there before it’s kept.';
const credits = (n: number) => (__ARTIFACT_BUILD__ ? `About ${plural(n, 'request')} to Claude.` : `Uses AI credits: ${plural(n, 'AI request')}.`);

/** An email by id or number (1-5). */
function findEmail(p: Project, id: string): { e: EmailStep; i: number } | null {
  const t = id.trim();
  const i = /^[1-9]$/.test(t) ? Number(t) - 1 : p.marketing.emails.findIndex((e) => e.id === t);
  const e = p.marketing.emails[i];
  return e ? { e, i } : null;
}
const missing = (p: Project, id: string) => (p.marketing.emails.length ? `There’s no email “${id.slice(0, 40)}”: use 1-${p.marketing.emails.length} or an id from get_email_funnel.` : 'There are no emails yet: generate_email_sequence writes them.');

/** The block list the model sees: id, type and a short summary (columns' children too). */
export function blockLines(doc: EmailDoc): { id: string; type: BlockType; summary: string; in?: string }[] {
  const out: { id: string; type: BlockType; summary: string; in?: string }[] = [];
  for (const b of doc.blocks) {
    out.push({ id: b.id, type: b.type, summary: blockSummary(b) });
    if (b.type === 'columns') b.cols.forEach((c, ci) => c.blocks.forEach((x) => out.push({ id: x.id, type: x.type, summary: blockSummary(x), in: `${b.id} column ${ci + 1}` })));
  }
  return out;
}

const LINK = arg.object(
  { kind: arg.enum(['magnet', 'page', 'offer', 'url', 'asset'] as const), url: arg.string({ optional: true, max: 2048 }), offerId: arg.string({ optional: true, max: 22 }), assetId: arg.string({ optional: true, max: 80 }) },
  { optional: true, desc: 'magnet (free download), page, offer + offerId, url + url, asset + assetId' },
);
const FIELDS = arg.object(
  {
    text: arg.string({ optional: true, max: 5000, allowEmpty: true }),
    level: arg.number({ optional: true, int: true, min: 1, max: 3 }),
    label: arg.string({ optional: true, max: 60 }),
    link: LINK,
    style: arg.string({ optional: true, max: 10, desc: 'button: solid|outline; divider: line|space; social: icons|text' }),
    full: arg.boolean({ optional: true }),
    alt: arg.string({ optional: true, max: 200, allowEmpty: true }),
    src: arg.string({ optional: true, max: 2048, desc: 'image: an https address the app hosts' }),
    prompt: arg.string({ optional: true, max: 300, desc: 'image: a picture idea the owner generates' }),
    width: arg.number({ optional: true, int: true, min: 16, max: 600 }),
    size: arg.number({ optional: true, int: true, min: 8, max: 64 }),
    offerId: arg.string({ optional: true, max: 22 }),
    blurb: arg.string({ optional: true, max: 500, allowEmpty: true }),
    buttonLabel: arg.string({ optional: true, max: 60 }),
    caption: arg.string({ optional: true, max: 300, allowEmpty: true }),
    align: arg.enum(['left', 'center'] as const, { optional: true }),
  },
  { optional: true },
);
type Fields = Record<string, unknown> & { link?: Partial<Link> & { kind: Link['kind'] } };

/** A block with the fields applied, checked by normalizeDoc in the email it goes into. */
function withFields(b: Block, f: Fields | undefined): Block {
  return { ...b, ...(f ?? {}), id: b.id, type: b.type } as Block;
}
function checkDoc(doc: EmailDoc, id: string): string | null {
  const { problems } = normalizeDoc(doc);
  const i = doc.blocks.findIndex((b) => b.id === id);
  const mine = problems.find((x) => x.path.startsWith(`blocks[${i}]`)) ?? problems.find((x) => x.path === '' || x.path === 'blocks');
  return mine ? mine.message : null;
}
const busyDesigning = () => busyJobs().some((j) => [emailDesignTask.label, emailBolderTask.label].includes(j.label));

const getEmailDesign = defineTool({
  name: 'get_email_design',
  class: 'R',
  summary: 'An email’s design: its blocks (id, type, summary), theme and what the preview warns about.',
  args: { email: EMAIL },
  validate: ({ email }) => (findEmail(activeProject(), email) ? null : missing(activeProject(), email)),
  run: ({ email }, ctx) => {
    const p = projectOf(ctx);
    const { e, i } = findEmail(p, email)!;
    const doc = docOf(e, p);
    let warnings: string[] = [];
    try {
      warnings = warningLines(emailHtml(e, p, 'preview').warnings, doc);
    } catch (err) {
      warnings = [err instanceof RenderError && err.code === 'TOO_LARGE' ? 'Too large to send (over 200 KB).' : 'It couldn’t be shown.'];
    }
    return { data: { email: i + 1, designed: !!e.doc, theme: doc.theme, blocks: blockLines(doc), ...(warnings.length ? { warnings } : {}) }, note: `Looked at email ${i + 1}’s design` };
  },
});

const designEmail = defineTool({
  name: 'design_email',
  class: 'P-text',
  summary: 'AI designs an email (or "all") as blocks from its own words: one AI request per email, after the owner’s OK.',
  args: { email: arg.string({ max: 60, desc: '1-5, an id, or all' }) },
  validate: ({ email }) => {
    if (busyDesigning()) return 'An email is being designed right now. Wait for it to finish.';
    const p = activeProject();
    if (email.trim().toLowerCase() === 'all') return p.marketing.emails.length ? null : missing(p, email);
    return findEmail(p, email) ? null : missing(p, email);
  },
  card: ({ email }) => {
    const n = email.trim().toLowerCase() === 'all' ? activeProject().marketing.emails.length : 1;
    return { title: n === 1 ? 'Design this email with AI?' : `Design all ${n} emails with AI?`, what: `The AI lays out ${n === 1 ? 'the email’s' : 'each email’s'} own words as blocks${n > 1 ? ', one after another (it stops at the first that fails)' : ''}. Undo is on each email.`, who: 'The AI that writes your emails.', cost: credits(n), confirmLabel: n === 1 ? 'Design it' : `Design all ${n}` };
  },
  run: async ({ email }, ctx) => {
    const p = projectOf(ctx);
    const list = email.trim().toLowerCase() === 'all' ? p.marketing.emails.map((e, i) => ({ e, i })) : [findEmail(p, email)!];
    const done: number[] = [];
    for (const { e, i } of list) {
      const now = projectOf(ctx).marketing.emails.find((x) => x.id === e.id);
      if (!now) break;
      const r = await runAITask(emailDesignTask, designInput(now, projectOf(ctx), i), ctx);
      replaceDoc(ctx.projectId, e.id, r.data);
      done.push(i + 1);
    }
    return { data: { designed: done, blocks: done.length === 1 ? blockLines(docOf(projectOf(ctx).marketing.emails[done[0] - 1], projectOf(ctx))) : undefined }, note: `Designed ${done.length === 1 ? `email ${done[0]}` : `emails ${listJoin(done.map(String))}`}` };
  },
});

const makeEmailBolder = defineTool({
  name: 'make_email_bolder',
  class: 'P-text',
  summary: 'AI makes an email’s design bolder: contrast, heading size, spacing, shorter labels (body text unchanged). After the owner’s OK.',
  args: { email: EMAIL },
  validate: ({ email }) => (busyDesigning() ? 'An email is being designed right now. Wait for it to finish.' : findEmail(activeProject(), email) ? null : missing(activeProject(), email)),
  card: () => ({ title: 'Make this email bolder with AI?', what: 'Stronger contrast, a bigger heading, roomier spacing and shorter heading and button labels. Its words stay. Undo is on the email.', who: 'The AI that writes your emails.', cost: credits(1), confirmLabel: 'Make it bolder' }),
  run: async ({ email }, ctx) => {
    const p = projectOf(ctx);
    const { e, i } = findEmail(p, email)!;
    const r = await runAITask(emailBolderTask, { doc: docOf(e, p), brandColors: p.brand.colors as unknown as Record<string, string> }, ctx);
    replaceDoc(ctx.projectId, e.id, r.data);
    return { data: { email: i + 1, theme: r.data.theme }, note: `Made email ${i + 1} bolder` };
  },
});

const editEmailWithAI = defineTool({
  name: 'edit_email_design',
  class: 'P-text',
  summary: 'AI changes an email’s blocks as the owner asks (one AI request, after their OK). It never writes custom HTML.',
  args: { email: EMAIL, instruction: arg.string({ max: 600 }) },
  validate: ({ email }) => (findEmail(activeProject(), email) ? null : missing(activeProject(), email)),
  card: ({ instruction }) => ({ title: 'Change this email’s blocks with AI?', what: `“${instruction.slice(0, 200)}”. Undo is on the email.`, who: 'The AI that writes your emails.', cost: credits(1), confirmLabel: 'Change it' }),
  run: async ({ email, instruction }, ctx) => {
    const p = projectOf(ctx);
    const { e, i } = findEmail(p, email)!;
    const before = docOf(e, p);
    const r = await runAITask(emailBlocksEditTask, { doc: before, instruction, design: designInput(e, p, i) }, ctx);
    if (JSON.stringify(r.data) === JSON.stringify(before)) return { data: { email: i + 1, changed: false }, note: `The AI made no changes to email ${i + 1}` };
    replaceDoc(ctx.projectId, e.id, r.data);
    return { data: { email: i + 1, blocks: blockLines(r.data) }, note: `Changed email ${i + 1}’s blocks` };
  },
});

const setEmailTheme = defineTool({
  name: 'set_email_theme',
  class: 'L',
  summary: `Set an email’s theme, or all emails’ (scope all). Themes: ${THEME_IDS.join(', ')}.`,
  args: {
    theme: arg.enum(THEME_IDS),
    scope: arg.enum(['email', 'all'] as const),
    email: arg.string({ optional: true, max: 60 }),
    overrides: arg.object({ primary: arg.string({ optional: true, max: 7, pattern: /^#[0-9a-fA-F]{6}$/ }), size: arg.number({ optional: true, int: true, min: 14, max: 18 }), radius: arg.number({ optional: true, int: true, min: 0, max: 24 }), density: arg.enum(['airy', 'regular', 'tight'] as const, { optional: true }) }, { optional: true }),
  },
  validate: ({ scope, email }) => (scope === 'email' ? (email && findEmail(activeProject(), email) ? null : 'Say which email (1-5), or scope: all.') : null),
  run: ({ theme, scope, email, overrides }, ctx) => {
    const ref = { id: theme as ThemeId, ...(overrides && Object.values(overrides).some((v) => v !== undefined) ? { overrides: Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } : {}) };
    const p = projectOf(ctx);
    if (scope === 'all') {
      updateEmailTheme(ctx.projectId, ref);
      return { data: { theme: ref, scope }, note: `Set the ${theme} theme for all emails` };
    }
    const { e, i } = findEmail(p, email!)!;
    setDoc(ctx.projectId, e.id, { ...docOf(e, p), theme: ref });
    return { data: { theme: ref, email: i + 1 }, note: `Set email ${i + 1}’s theme to ${theme}` };
  },
});

const addEmailBlock = defineTool({
  name: 'add_email_block',
  class: 'L',
  summary: `Add a block to an email (after a block id, else at the end). Types: ${BLOCK_TYPES.filter((t) => t !== 'custom').join(', ')}.`,
  args: { email: EMAIL, type: arg.enum(BLOCK_TYPES), after: arg.string({ optional: true, max: 20 }), fields: FIELDS },
  validate: ({ email, type, fields }) => {
    const p = activeProject();
    const f = findEmail(p, email);
    if (!f) return missing(p, email);
    if (type === 'custom') return NO_CUSTOM;
    const b = withFields(newBlock(type, p), fields as Fields);
    const doc = docOf(f.e, p);
    return checkDoc({ ...doc, blocks: [...doc.blocks, b] }, b.id);
  },
  run: ({ email, type, after, fields }, ctx) => {
    const p = projectOf(ctx);
    const { e, i } = findEmail(p, email)!;
    const doc = docOf(e, p);
    const b = withFields(newBlock(type, p), fields as Fields);
    const at = after ? doc.blocks.findIndex((x) => x.id === after) : -1;
    const blocks = at < 0 ? [...doc.blocks, b] : [...doc.blocks.slice(0, at + 1), b, ...doc.blocks.slice(at + 1)];
    setDoc(ctx.projectId, e.id, { ...doc, blocks });
    return { data: { email: i + 1, added: { id: b.id, type, summary: blockSummary(b) } }, note: `Added ${BLOCK_LABEL[type].toLowerCase()} to email ${i + 1}` };
  },
});

const editEmailBlock = defineTool({
  name: 'edit_email_block',
  class: 'L',
  summary: 'Change a block’s fields (text, label, link, alt, style…). Custom HTML isn’t changed here.',
  args: { email: EMAIL, blockId: arg.string({ max: 20 }), fields: FIELDS },
  validate: ({ email, blockId, fields }) => {
    const p = activeProject();
    const f = findEmail(p, email);
    if (!f) return missing(p, email);
    const doc = docOf(f.e, p);
    const b = doc.blocks.find((x) => x.id === blockId);
    if (!b) return `Email ${f.i + 1} has no block “${blockId}”: get_email_design lists them.`;
    if (b.type === 'custom') return NO_CUSTOM;
    if (!fields || !Object.values(fields).some((v) => v !== undefined)) return 'Say what to change.';
    const next = withFields(b, fields as Fields);
    return checkDoc({ ...doc, blocks: doc.blocks.map((x) => (x.id === blockId ? next : x)) }, blockId);
  },
  run: ({ email, blockId, fields }, ctx) => {
    const p = projectOf(ctx);
    const { e, i } = findEmail(p, email)!;
    const doc = docOf(e, p);
    const next = withFields(doc.blocks.find((x) => x.id === blockId)!, fields as Fields);
    setDoc(ctx.projectId, e.id, { ...doc, blocks: doc.blocks.map((x) => (x.id === blockId ? next : x)) });
    return { data: { email: i + 1, block: { id: blockId, type: next.type, summary: blockSummary(next) } }, note: `Changed a ${BLOCK_LABEL[next.type].toLowerCase()} in email ${i + 1}` };
  },
});

const moveEmailBlock = defineTool({
  name: 'move_email_block',
  class: 'L',
  summary: 'Move a block of an email up or down.',
  args: { email: EMAIL, blockId: arg.string({ max: 20 }), dir: arg.enum(['up', 'down'] as const) },
  validate: ({ email, blockId }) => {
    const p = activeProject();
    const f = findEmail(p, email);
    if (!f) return missing(p, email);
    return docOf(f.e, p).blocks.some((x) => x.id === blockId) ? null : `Email ${f.i + 1} has no block “${blockId}”.`;
  },
  run: ({ email, blockId, dir }, ctx) => {
    const p = projectOf(ctx);
    const { e, i } = findEmail(p, email)!;
    const doc = docOf(e, p);
    setDoc(ctx.projectId, e.id, { ...doc, blocks: moveBlock(doc.blocks, blockId, dir === 'up' ? -1 : 1) });
    return { data: { email: i + 1, blocks: blockLines(docOf(projectOf(ctx).marketing.emails[i], projectOf(ctx))) }, note: `Moved a block ${dir} in email ${i + 1}` };
  },
});

const removeEmailBlock = defineTool({
  name: 'remove_email_block',
  class: 'L',
  summary: 'Remove a block from an email (Undo in the studio puts it back).',
  args: { email: EMAIL, blockId: arg.string({ max: 20 }) },
  validate: ({ email, blockId }) => {
    const p = activeProject();
    const f = findEmail(p, email);
    if (!f) return missing(p, email);
    return docOf(f.e, p).blocks.some((x) => x.id === blockId) ? null : `Email ${f.i + 1} has no block “${blockId}”.`;
  },
  run: ({ email, blockId }, ctx) => {
    const p = projectOf(ctx);
    const { e, i } = findEmail(p, email)!;
    const doc = docOf(e, p);
    replaceDoc(ctx.projectId, e.id, { ...doc, blocks: removeBlock(doc.blocks, blockId) });
    return { data: { email: i + 1, removed: blockId }, note: `Removed a block from email ${i + 1}` };
  },
});

const exportEmailHtml = defineTool({
  name: 'export_email_html',
  class: 'R',
  summary: `A download button for an email’s HTML for an email tool (${ESP_IDS.join(', ')}), with that tool’s unsubscribe tag.`,
  args: { email: EMAIL, esp: arg.enum(ESP_IDS) },
  validate: ({ email }) => (findEmail(activeProject(), email) ? null : missing(activeProject(), email)),
  run: ({ email, esp }, ctx) => {
    const p = projectOf(ctx);
    const { e, i } = findEmail(p, email)!;
    const name = `${slugify(p.brand.name) || 'email'}-email-${i + 1}.html`;
    const make = () => emailHtml(e, projectOf(ctx), 'export', { esp: esp as EspId }).html;
    try {
      make();
    } catch {
      return { ok: false, error: 'This email is too large to export (over 200 KB).' };
    }
    const run = async () => {
      try {
        await download(name, make());
      } catch {
        noteInChat('That email couldn’t be exported.', false);
      }
    };
    return { data: { file: name, tool: ESP_TOOLS[esp as EspId].label }, note: `Email ${i + 1}’s HTML for ${ESP_TOOLS[esp as EspId].label} is ready`, buttons: [{ label: `Download ${name}`, icon: 'download', run }] };
  },
});

const agentProblem = (via: 'manus' | 'viktor') => {
  const r = agentReady(via, 'build');
  if (!r.show) return r.text || `${agentName(via)} isn’t available here.`;
  return r.ready ? null : `${agentName(via)} isn’t ready to build: ${r.text || 'see Settings › AI keys.'}`;
};

const buildEmailWithAgent = defineTool({
  name: 'build_email_with_agent',
  class: 'Pub',
  summary: 'Open “Design an email with Manus or Viktor” for one email: the owner checks it and sends it there.',
  args: { email: EMAIL, via: arg.enum(AGENTS) },
  validate: ({ email, via }) => (findEmail(activeProject(), email) ? agentProblem(via) : missing(activeProject(), email)),
  window: ({ email, via }) => ({ kind: 'agent-build', target: 'email', agent: via, stepId: findEmail(activeProject(), email)!.e.id }),
});

const buildLeadMagnetWithAgent = defineTool({
  name: 'build_lead_magnet_with_agent',
  class: 'Pub',
  summary: 'Open “Make your lead magnet with Manus or Viktor”: the owner checks it and sends it there.',
  args: { via: arg.enum(AGENTS) },
  validate: ({ via }) => agentProblem(via),
  window: ({ via }) => ({ kind: 'agent-build', target: 'leadMagnet', agent: via }),
});

export const emailTools: AnyTool[] = [
  getEmailDesign,
  designEmail,
  makeEmailBolder,
  editEmailWithAI,
  setEmailTheme,
  addEmailBlock,
  editEmailBlock,
  moveEmailBlock,
  removeEmailBlock,
  exportEmailHtml,
  // Manus and Viktor work with the app's own server: not in the claude.ai build
  ...(__ARTIFACT_BUILD__ ? [] : [buildEmailWithAgent, buildLeadMagnetWithAgent]),
];
