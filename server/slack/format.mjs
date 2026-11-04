// Slack text, both ways (pure functions).
//   Out: the app's messages are lists of parts ({ text } | { link } | { mention }, server/agents/templates.mjs).
//        Text is escaped (& < > become entities, so nothing the owner types turns into a mention or a link),
//        links are written as <url> markup, a mention only ever names the saved Viktor.
//   In:  a message from Slack becomes readable text for the chat: rich_text blocks when present, else the
//        mrkdwn text with only real Slack markup replaced and the entities decoded once. Code blocks become
//        short notes ([HTML page · 9.4 KB]); the page itself is fetched separately (server/agents/html.mjs).

import { codePlaceholders, extractHtml, fileKind, isHtmlFile } from '../agents/html.mjs';

const TEXT_MAX = 8000;

/** & < > as Slack's entities, in that order ("You shouldn't encode the entire piece of text"). */
export const escapeText = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The message as Slack gets it. */
export function renderParts(parts) {
  return parts
    .map((p) => {
      if (typeof p.link === 'string') return `<${p.link.replace(/&/g, '&amp;')}>`;
      if (typeof p.mention === 'string') return `<@${p.mention}>`;
      return escapeText(p.text);
    })
    .join('');
}

/** The message as the owner reads it in the confirm step: links as addresses, the mention as @name, no escaping. */
export function readableParts(parts, { viktorName = 'Viktor' } = {}) {
  return parts.map((p) => (typeof p.link === 'string' ? p.link : typeof p.mention === 'string' ? `@${viktorName || 'Viktor'}` : String(p.text ?? ''))).join('');
}

/** A message's length as Slack counts toward its limit (after escaping). */
export const slackLength = (text) => String(text ?? '').length;

/** Compare two Slack timestamps ("1793723980.736069"): -1, 0 or 1. */
export function tsCompare(a, b) {
  const [as, au = ''] = String(a ?? '').split('.');
  const [bs, bu = ''] = String(b ?? '').split('.');
  const s = Number(as) - Number(bs);
  if (s) return s < 0 ? -1 : 1;
  const u = Number(au.padEnd(6, '0')) - Number(bu.padEnd(6, '0'));
  return u < 0 ? -1 : u > 0 ? 1 : 0;
}

/** Slack's three entities, decoded exactly once in one pass. */
const decodeOnce = (s) => String(s).replace(/&(lt|gt|amp);/g, (_, n) => (n === 'lt' ? '<' : n === 'gt' ? '>' : '&'));

/**
 * Real Slack markup in mrkdwn → readable text (any other <…>, like a raw <!DOCTYPE html>, is left alone):
 * <@U…|x> / <@U…> → @name, <#C…|name> → #name, <!here> → @here, <!channel> → @channel, <url|label> → [label](url), <url> → url.
 */
export function replaceMarkup(text, names = {}) {
  return String(text ?? '')
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `@${names[id] || label || 'someone'}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `#${label || 'channel'}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, w) => `@${w}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label || '@team')
    .replace(/<((?:https?|mailto):[^|>\s]*)\|([^>]*)>/g, (_, url, label) => `[${label}](${url})`)
    .replace(/<((?:https?|mailto):[^|>\s]*)>/g, (_, url) => url);
}

/** A rich_text section's elements as text. */
function inline(elements, names) {
  return (Array.isArray(elements) ? elements : [])
    .map((x) => {
      switch (x?.type) {
        case 'text':
          return String(x.text ?? '');
        case 'link':
          return x.text ? `[${x.text}](${x.url ?? ''})` : String(x.url ?? '');
        case 'user':
          return `@${names[x.user_id] || 'someone'}`;
        case 'channel':
          return '#channel';
        case 'emoji':
          return `:${x.name ?? ''}:`;
        case 'broadcast':
          return `@${x.range ?? 'here'}`;
        case 'usergroup':
          return '@team';
        case 'date':
          return String(x.fallback ?? '');
        default:
          return '';
      }
    })
    .join('');
}

/** Slack's rich_text blocks as readable text (a code block as a fence, quotes with "> ", lists with "- "). */
function richText(blocks, names) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b?.type !== 'rich_text') continue;
    for (const el of Array.isArray(b.elements) ? b.elements : []) {
      if (el?.type === 'rich_text_section') out.push(inline(el.elements, names));
      else if (el?.type === 'rich_text_preformatted') out.push(`\`\`\`\n${inline(el.elements, names)}\n\`\`\`\n`);
      else if (el?.type === 'rich_text_quote') out.push(`${inline(el.elements, names).split('\n').map((l) => `> ${l}`).join('\n')}\n`);
      else if (el?.type === 'rich_text_list') {
        const ordered = el.style === 'ordered';
        out.push(`${(Array.isArray(el.elements) ? el.elements : []).map((s, i) => `${ordered ? `${i + 1}.` : '-'} ${inline(s?.elements, names)}`).join('\n')}\n`);
      }
    }
  }
  return out.join('');
}

const cut = (s, max) => (s.length <= max ? s : `${s.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')}…`);

/** A message as the chat shows it: readable text with code blocks replaced by notes, at most 8,000 characters. */
export function readable(m, names = {}) {
  const hasRich = Array.isArray(m?.blocks) && m.blocks.some((b) => b?.type === 'rich_text');
  const text = hasRich ? richText(m.blocks, names) : decodeOnce(replaceMarkup(m?.text ?? '', names));
  return cut(codePlaceholders(text).trim(), TEXT_MAX);
}

/** Whether a message only points somewhere (an https link) rather than holding a page. */
export function hasLink(m) {
  if (/<https:\/\/[^>\s]+>|<https:\/\/[^|>\s]+\|[^>]*>/.test(String(m?.text ?? ''))) return true;
  return (Array.isArray(m?.blocks) ? m.blocks : []).some((b) => JSON.stringify(b?.elements ?? []).includes('"type":"link"'));
}

/** A file that lives outside Slack (its address is chosen by an app): never fetched with the token. */
export const isExternalFile = (f) => !!f && (f.is_external === true || f.mode === 'external' || f.filetype === 'remote');

/** A message's files for the browser: no addresses, an id of "<ts>:<file id>". */
export function filesOf(m) {
  return (Array.isArray(m?.files) ? m.files : [])
    .filter((f) => f && typeof f.id === 'string')
    .map((f) => ({ id: `${m.ts}:${f.id}`, name: String(f.name || f.title || 'file').slice(0, 160), kind: fileKind(f), ...(Number.isFinite(f.size) ? { bytes: f.size } : {}), ...(typeof f.mimetype === 'string' && f.mimetype ? { mime: f.mimetype.slice(0, 100) } : {}) }));
}

/**
 * The page in a message: an attached .html file (preferred: the template asks for page.html first), or a
 * code block. { at, source, bytes, complete, filename } or null. A remote file isn't a page the app can fetch.
 */
export function messageHtml(m, { log } = {}) {
  const file = (Array.isArray(m?.files) ? m.files : []).find((f) => isHtmlFile(f) && !isExternalFile(f) && typeof f.id === 'string');
  if (file) return { at: `${m.ts}:${file.id}`, source: 'file', bytes: Number.isFinite(file.size) ? file.size : 0, complete: true, filename: String(file.name || 'page.html').slice(0, 160) };
  const page = extractHtml({ blocks: m?.blocks, text: m?.text ?? '' }, { log });
  if (!page) return null;
  return { at: String(m.ts), source: 'code', bytes: page.bytes, complete: page.complete, filename: 'page.html' };
}
