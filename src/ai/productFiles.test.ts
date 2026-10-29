import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { crc32 } from '@/lib/zip';
import { writeXlsx, safeSheetName } from '@/lib/xlsx';
import { parseMarkdown } from '@/lib/markdownBlocks';
import { buildEbookPdf } from '@/lib/ebook';
import { newProject } from '@/store/defaults';
import { draftSection, generateOutline } from './local/studio';
import { buildWorkbookModel, compileRowFormula, normalizeWorkbook, workbookFile, type WorkbookSpec } from './workbook';
import { localWorkbook } from './local/workbook';
import { disclaimerFor, localEbookExtras } from './local/ebook';
import { ebookExtrasTask } from './tasks';
import { ebookDoc } from './productFiles';

const colors = { primary: '#156343', secondary: '#0e3b2a', accent: '#f2b33d', ink: '#111814', paper: '#fbfaf6' };
const brand = { name: 'Sumari', website: 'sumari.com', colors };
const cols = new Map([['amount', 1], ['tax rate', 2], ['status', 3]]);
const colOf = (n: string) => cols.get(n.trim().toLowerCase());

/** Read one part of a stored (uncompressed) zip. */
function part(zipBytes: Uint8Array, name: string): string | null {
  const dec = new TextDecoder();
  const v = new DataView(zipBytes.buffer, zipBytes.byteOffset);
  for (let off = 0; v.getUint32(off, true) === 0x04034b50; ) {
    const size = v.getUint32(off + 18, true);
    const nameLen = v.getUint16(off + 26, true);
    const n = dec.decode(zipBytes.subarray(off + 30, off + 30 + nameLen));
    const start = off + 30 + nameLen;
    if (n === name) return dec.decode(zipBytes.subarray(start, start + size));
    off = start + size;
  }
  return null;
}

describe('xlsx files', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('compiles row formulas from [Column] names and refuses anything else', () => {
    expect(compileRowFormula('[Amount] * [Tax rate]', colOf, 7)).toEqual({ ok: true, formula: 'A7*B7', refs: [1, 2] });
    expect(compileRowFormula('=if([Status]="Done ""ok""", round([Amount],2), 0)', colOf, 5)).toMatchObject({ ok: true, formula: 'IF(C5="Done ""ok""",ROUND(A5,2),0)' });
    expect(compileRowFormula('[Amount]*A2', colOf, 5)).toMatchObject({ ok: false, error: expect.stringMatching(/A2/) });
    expect(compileRowFormula('VLOOKUP([Amount],1,2)', colOf, 5)).toMatchObject({ ok: false, error: expect.stringMatching(/VLOOKUP/) });
    expect(compileRowFormula('[Profit]*2', colOf, 5)).toMatchObject({ ok: false, error: expect.stringMatching(/Profit/) });
    expect(compileRowFormula('ROUND([Amount],2', colOf, 5)).toMatchObject({ ok: false });
    expect(compileRowFormula('TODAY()+1', colOf, 5)).toMatchObject({ ok: false, error: 'it uses no column' });
    // two values side by side, dangling operators and stray parentheses never reach the file
    expect(compileRowFormula('SUM([Amount] [Tax rate])', colOf, 5)).toMatchObject({ ok: false, error: expect.stringMatching(/no operator/) });
    expect(compileRowFormula('[Amount]*', colOf, 5)).toMatchObject({ ok: false });
    expect(compileRowFormula('[Amount]*/2', colOf, 5)).toMatchObject({ ok: false });
    expect(compileRowFormula('[Amount](2)', colOf, 5)).toMatchObject({ ok: false });
    expect(compileRowFormula('ROUND([Amount],)', colOf, 5)).toMatchObject({ ok: false });
    expect(compileRowFormula('[Amount],2', colOf, 5)).toMatchObject({ ok: false });
    expect(compileRowFormula('-[Amount]+ -2%', colOf, 5)).toEqual({ ok: true, formula: '-A5+-2%', refs: [1] });
    expect(compileRowFormula('IF(AND([Amount]>=100,[Status]<>"Lost"),[Amount]*0.1,0)', colOf, 9)).toMatchObject({ ok: true, formula: 'IF(AND(A9>=100,C9<>"Lost"),A9*0.1,0)' });
    expect(compileRowFormula('MAX(0,TODAY()-[Amount])', colOf, 5)).toMatchObject({ ok: true, formula: 'MAX(0,TODAY()-A5)' });
  });

  it('cleans up an AI design and falls back when nothing is usable', () => {
    const base = localWorkbook(newProject('product', 'new'));
    expect(normalizeWorkbook({ sheets: [{ name: 'X', columns: [{ name: 'Only one' }] }] }, base)).toBe(base);
    const w = normalizeWorkbook(
      {
        title: 'T',
        sheets: [
          { name: 'Dashboard', columns: [{ name: 'a' }, { name: 'b' }] },
          {
            name: 'Sales',
            columns: [
              { name: 'Item', type: 'string' },
              { name: 'Price', type: 'money' },
              { name: 'Price', type: 'number' },
              { name: 'Stage', type: 'dropdown', options: ['A'] },
              { name: 'Paid', type: 'checkbox' },
              { name: 'Total', type: 'number', formula: '[Price]*2' },
            ],
            rows: [{ Item: 'x' }],
          },
        ],
      },
      base,
    );
    expect(w.sheets.map((s) => s.name)).toEqual(['Sales']);
    expect(w.sheets[0].columns.map((c) => `${c.name}:${c.type}`)).toEqual(['Item:text', 'Price:currency', 'Stage:text', 'Paid:yesno', 'Total:formula']);
    expect(w.instructions).toEqual(base.instructions);
  });

  it('lays out tabs, dropdowns, totals and a dashboard, dropping what doesn’t check out', () => {
    const spec: WorkbookSpec = {
      title: 'Tracker',
      subtitle: 'Sub',
      instructions: ['Step one'],
      sheets: [
        { name: 'Log', purpose: 'p', rows: [{ Date: '2026-10-01', Type: 'Income', Amount: '$1,200' }], columns: [{ name: 'Date', type: 'date' }, { name: 'Type', type: 'choice', options: ['Income', 'Expense'] }, { name: 'Amount', type: 'currency' }, { name: 'Bad', type: 'formula', formula: '[Amount]*B2', format: 'currency' }] },
        { name: 'Log', purpose: 'second tab with the same name', rows: [], columns: [{ name: 'Goal', type: 'text' }, { name: 'Done', type: 'yesno' }] },
      ],
      metrics: [
        { label: 'Income', op: 'sumif', sheet: 'Log', column: 'Amount', whereColumn: 'Type', equals: 'Income' },
        { label: 'Count', op: 'count', sheet: 'Log', column: 'Date' },
        { label: 'Count', op: 'countif', sheet: 'Log 2', column: 'Done', equals: 'Yes' },
        { label: 'Nope', op: 'sum', sheet: 'Missing', column: 'Amount' },
      ],
      breakdowns: [{ title: 'By type', sheet: 'Log', byColumn: 'Type', valueColumn: 'Amount', op: 'sum' }],
    };
    const { model, summary } = buildWorkbookModel(spec, brand, 2026);
    expect(model.sheets.map((s) => s.name)).toEqual(['Start here', 'Log', 'Log 2', 'Dashboard']);
    expect(summary.dropped).toEqual([expect.stringMatching(/Log › Bad: formula left out/), expect.stringMatching(/Dashboard › Nope/)]);
    const log = model.sheets[1];
    expect(log.rows.get(5)!.get(1)!.v).toEqual({ date: 46296 });
    expect(log.rows.get(5)!.get(3)!.v).toBe(1200);
    expect(log.rows.get(3)!.get(3)!.v).toEqual({ formula: 'SUBTOTAL(109,C5:C204)' });
    expect(log.validations).toEqual([{ sqref: 'B5:B204', list: ['Income', 'Expense'] }]);
    const dash = model.sheets[3];
    const labels = [...dash.rows.values()].map((r) => r.get(2)?.v).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(['Income', 'Count (Log)', 'Count (Log 2)', 'Income', 'Expense']));
    expect([...dash.rows.values()].some((r) => JSON.stringify(r.get(3)?.v ?? '').includes("SUMIF('Log'!$B$5:$B$204,\\\"Income\\\",'Log'!$C$5:$C$204)"))).toBe(true);
  });

  it('writes a well-formed package', () => {
    const { bytes, summary } = workbookFile(localWorkbook(Object.assign(newProject('product', 'new'), { niche: 'Personal Finance', category: 'Budgeting', format: 'spreadsheet' })), brand);
    expect(new TextDecoder().decode(bytes.subarray(30, 49))).toBe('[Content_Types].xml');
    const wbXml = part(bytes, 'xl/workbook.xml')!;
    expect(wbXml).toContain('fullCalcOnLoad="1"');
    expect(wbXml).toContain('<sheet name="Start here" sheetId="1"');
    const types = part(bytes, '[Content_Types].xml')!;
    expect(types.match(/worksheet\+xml/g)).toHaveLength(summary.sheets.length + 2);
    const sheet = part(bytes, 'xl/worksheets/sheet2.xml')!;
    // schema order: sheetData before autoFilter before mergeCells before conditionalFormatting before dataValidations
    const order = ['<sheetData>', '<autoFilter', '<mergeCells', '<conditionalFormatting', '<dataValidations', '<pageMargins', '<pageSetup'].map((t) => sheet.indexOf(t));
    expect(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]))).toBe(true);
    expect(part(bytes, 'xl/styles.xml')).toContain('<fills count="');
    expect(safeSheetName('A/B: totals [2026]?', new Set())).toBe('A B totals 2026');
    expect(writeXlsx({ title: 't', author: 'a', sheets: [] }).length).toBeGreaterThan(100);
  });
});

describe('pdf files', () => {
  it('parses the Markdown that drafts use', () => {
    const b = parseMarkdown('## Title\n\nText with **bold** and *it*.\n\n- [ ] todo\n- [x] done\n1. one\n\n> tip\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---');
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'li', 'li', 'li', 'quote', 'table', 'hr']);
    expect(b[1]).toEqual({ t: 'p', runs: [{ text: 'Text with ' }, { text: 'bold', b: true }, { text: ' and ' }, { text: 'it', i: true }, { text: '.' }] });
    expect(b.slice(2, 4).map((x) => (x.t === 'li' ? x.check : null))).toEqual([false, true]);
  });

  it('writes the welcome, one workbook page per chapter and a fitting disclaimer offline', () => {
    const p = Object.assign(newProject('product', 'new'), { niche: 'Fitness', category: 'Home Workouts', format: 'ebook' as const });
    p.studio.outline = generateOutline(p).sections;
    const x = localEbookExtras(p);
    expect(x.worksheets).toHaveLength(p.studio.outline.length);
    expect(x.worksheets[0].prompts.length).toBeGreaterThanOrEqual(2);
    expect(x.disclaimer).toMatch(/not medical advice/);
    expect(disclaimerFor('Freelancer Tax Tracking')).toMatch(/not tax, legal or financial advice/);
    // Claude's answer is lined up with the chapters: missing or extra pages never shift them
    const merged = ebookExtrasTask.claude!.merge({ title: 'New title', worksheets: [{ title: 'W1', intro: 'i', prompts: ['q1', 'q2'], checklist: ['c'] }, ...Array(20).fill({ title: 'extra', prompts: ['q'] })] }, x, {}, { project: p, directives: {}, brainPrompt: '', variation: 0 });
    expect(merged.title).toBe('New title');
    expect(merged.worksheets).toHaveLength(p.studio.outline.length);
    expect(merged.worksheets[0].title).toBe('W1');
  });

  it('typesets a full book with contents links, bookmarks and fillable fields', async () => {
    const p = Object.assign(newProject('product', 'new'), { niche: 'Personal Finance', category: 'Freelancer Tax Tracking', format: 'pdf' as const });
    p.brand.name = 'Sumari';
    p.brand.colors = colors;
    p.studio.outline = generateOutline(p).sections.slice(0, 3);
    p.studio.outline[0].draft = `## ${p.studio.outline[0].title}\n\nEmoji 🧾 and arrows → are cleaned. Long ${'word'.repeat(60)} wraps.\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |`;
    p.studio.outline[1].draft = draftSection(p, p.studio.outline[1]);
    const doc = ebookDoc(p, localEbookExtras(p), { workbookPages: true });
    const { bytes, pages } = await buildEbookPdf(doc, { theme: 'classic', pageSize: 'a4', fillable: true });
    const back = await PDFDocument.load(bytes);
    expect(back.getPageCount()).toBe(pages);
    expect(pages).toBeGreaterThanOrEqual(3 + 1 + 3 * 2 + 2);
    // 3 prompts + up to 5 checklist items per chapter
    expect(back.getForm().getFields().length).toBeGreaterThanOrEqual(3 * 4);
    expect(back.catalog.get(PDFName.of('Outlines'))).toBeDefined();
    expect(back.getTitle()).toBe(doc.title);
    const toc = back.getPage(2).node.Annots();
    expect(toc?.size()).toBe(3 + 2);
  });
});
