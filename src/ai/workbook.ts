// The spreadsheet product: an AI-designed workbook spec, a strict compiler from that spec to
// Excel formulas, and the branded layout (Start here, data tabs, Dashboard).
//
// The AI never writes cell addresses. Row formulas use [Column name] tokens and a short list
// of functions; metrics are declared (sum/count/sumif…) and compiled here. Anything that
// doesn't check out is dropped, so a bad suggestion can't produce a broken file.

import type { BrandColors } from '@/lib/types';
import { colName, excelDate, newSheet, ref, safeSheetName, setCell, sheetRef, writeXlsx, type CellStyle, type SheetModel, type WorkbookModel } from '@/lib/xlsx';

export type ColumnType = 'text' | 'longtext' | 'number' | 'currency' | 'percent' | 'date' | 'choice' | 'yesno' | 'formula';
export type ValueFormat = 'number' | 'currency' | 'percent' | 'date' | 'text';

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  /** choice columns */
  options?: string[];
  /** formula columns: e.g. "[Amount] * [Tax rate]" */
  formula?: string;
  /** how a formula column's result is shown */
  format?: ValueFormat;
}

export interface SheetSpec {
  name: string;
  purpose: string;
  columns: ColumnSpec[];
  /** example rows, keyed by column name */
  rows: Record<string, unknown>[];
  totals?: boolean;
}

export type MetricOp = 'sum' | 'average' | 'count' | 'countif' | 'sumif' | 'min' | 'max';

export interface MetricSpec {
  label: string;
  op: MetricOp;
  sheet: string;
  column: string;
  whereColumn?: string;
  equals?: string;
  format?: ValueFormat;
}

export interface BreakdownSpec {
  title: string;
  sheet: string;
  byColumn: string;
  valueColumn?: string;
  op: 'sum' | 'count';
}

export interface WorkbookSpec {
  title: string;
  subtitle: string;
  instructions: string[];
  sheets: SheetSpec[];
  metrics: MetricSpec[];
  breakdowns: BreakdownSpec[];
}

export interface WorkbookSummary {
  sheets: { name: string; columns: string[]; rows: number }[];
  formulas: number;
  metrics: number;
  dropped: string[];
}

/** data rows prepared on every tab (formatting, dropdowns and formulas reach this far) */
export const DATA_ROWS = 200;
const TOTAL_ROW = 3;
const HEADER_ROW = 4;
const FIRST = 5;
const LAST = FIRST + DATA_ROWS - 1;
const MAX_SHEETS = 6;
const MAX_COLUMNS = 12;

const FUNCS = new Set(['IF', 'IFERROR', 'AND', 'OR', 'NOT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'MIN', 'MAX', 'ABS', 'SUM', 'AVERAGE', 'TODAY', 'YEAR', 'MONTH', 'DAY', 'DATE', 'EOMONTH', 'EDATE', 'NETWORKDAYS', 'DATEDIF', 'WEEKDAY', 'TEXT', 'LEN', 'LEFT', 'RIGHT', 'MID', 'UPPER', 'LOWER', 'PROPER', 'TRIM', 'INT', 'MOD', 'POWER', 'SQRT', 'CEILING', 'FLOOR', 'VALUE', 'ISBLANK', 'ISNUMBER']);

// ───────────── formulas ─────────────

export type Compiled = { ok: true; formula: string; refs: number[] } | { ok: false; error: string };

/** Compile a row formula with [Column] tokens into an Excel formula for one row. */
export function compileRowFormula(expr: string, colOf: (name: string) => number | undefined, row: number): Compiled {
  const src = expr.trim().replace(/^=/, '');
  let out = '';
  const refs: number[] = [];
  let depth = 0;
  let i = 0;
  // the last token ended a value (a cell, number, text or closing parenthesis)
  let value = false;
  const operand = (): Compiled | null => (value ? { ok: false, error: 'two values have no operator between them' } : null);
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (ch === '[') {
      const bad = operand();
      if (bad) return bad;
      const j = src.indexOf(']', i);
      if (j < 0) return { ok: false, error: 'a [column] is not closed' };
      const name = src.slice(i + 1, j).trim();
      const c = colOf(name);
      if (c === undefined) return { ok: false, error: `there is no column “${name}”` };
      refs.push(c);
      out += ref(c, row);
      i = j + 1;
      value = true;
      continue;
    }
    if (ch === '"') {
      const bad = operand();
      if (bad) return bad;
      let j = i + 1;
      let s = '"';
      for (; j < src.length; j++) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '""';
            j++;
            continue;
          }
          break;
        }
        s += src[j];
      }
      if (j >= src.length) return { ok: false, error: 'a "text" value is not closed' };
      out += `${s}"`;
      i = j + 1;
      value = true;
      continue;
    }
    if (/\s/.test(ch)) {
      // a space between ranges is Excel's intersection operator: never pass it through
      i++;
      continue;
    }
    const num = /^\d+(\.\d+)?%?/.exec(rest);
    if (num) {
      const bad = operand();
      if (bad) return bad;
      out += num[0];
      i += num[0].length;
      value = true;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    if (id) {
      const name = id[0].toUpperCase();
      const isCall = src.slice(i + id[0].length).trimStart().startsWith('(');
      if (isCall && !FUNCS.has(name)) return { ok: false, error: `the function ${name} isn’t allowed` };
      if (!isCall && name !== 'TRUE' && name !== 'FALSE') return { ok: false, error: `“${id[0]}” isn’t a [column] or a function` };
      const bad = operand();
      if (bad) return bad;
      out += name;
      i += id[0].length;
      // a function name is followed by its "(", a TRUE/FALSE is a value
      value = !isCall;
      continue;
    }
    const op = /^(<>|<=|>=|[-+*/^&=<>,()])/.exec(rest);
    if (op) {
      const t = op[0];
      if (t === '(') {
        // "(" opens a group or a function's arguments, never right after a value
        if (value) return { ok: false, error: 'a ( follows a value' };
        depth++;
      } else if (t === ')') {
        if (--depth < 0) return { ok: false, error: 'a ) has no matching (' };
        if (!value && !out.endsWith('(')) return { ok: false, error: 'something is missing before a )' };
        value = true;
      } else if (t === ',') {
        if (depth === 0) return { ok: false, error: 'a comma is outside a function' };
        value = false;
      } else {
        // binary operators need a value on their left; + and - may also be signs
        if (!value && t !== '-' && t !== '+') return { ok: false, error: `“${t}” has nothing on its left` };
        value = false;
      }
      out += t;
      i += t.length;
      if (t === ')') value = true;
      continue;
    }
    return { ok: false, error: `unexpected “${ch}”` };
  }
  if (depth !== 0) return { ok: false, error: 'a ( is not closed' };
  if (!value) return { ok: false, error: 'it ends with an operator' };
  if (!refs.length) return { ok: false, error: 'it uses no column' };
  if (!out) return { ok: false, error: 'it is empty' };
  return { ok: true, formula: out, refs };
}

// ───────────── normalizing what the AI sent ─────────────

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const TYPE_ALIASES: Record<string, ColumnType> = {
  text: 'text', string: 'text', name: 'text', email: 'text', url: 'text', link: 'text',
  longtext: 'longtext', textarea: 'longtext', notes: 'longtext', paragraph: 'longtext',
  number: 'number', int: 'number', integer: 'number', float: 'number', decimal: 'number', quantity: 'number', count: 'number',
  currency: 'currency', money: 'currency', price: 'currency', dollar: 'currency', dollars: 'currency', amount: 'currency',
  percent: 'percent', percentage: 'percent', pct: 'percent', rate: 'percent',
  date: 'date', datetime: 'date', day: 'date',
  choice: 'choice', select: 'choice', dropdown: 'choice', category: 'choice', status: 'choice', list: 'choice', enum: 'choice',
  yesno: 'yesno', 'yes/no': 'yesno', boolean: 'yesno', bool: 'yesno', checkbox: 'yesno', check: 'yesno',
  formula: 'formula', calculated: 'formula', calc: 'formula', computed: 'formula',
};
const FORMATS: ValueFormat[] = ['number', 'currency', 'percent', 'date', 'text'];
const OPS: MetricOp[] = ['sum', 'average', 'count', 'countif', 'sumif', 'min', 'max'];

function normColumn(raw: unknown): ColumnSpec | null {
  const o = objOf(raw);
  const name = str(o.name, 40).replace(/[[\]]/g, '');
  if (!name) return null;
  let type = TYPE_ALIASES[str(o.type, 20).toLowerCase()] ?? 'text';
  const options = [...new Set(arr(o.options).map((x) => str(x, 40).replace(/,/g, ' ').trim()).filter(Boolean))].slice(0, 25);
  const formula = str(o.formula, 400);
  if (type === 'choice' && options.length < 2) type = 'text';
  if (type === 'formula' && !formula) type = 'number';
  if (formula && type !== 'formula' && /\[/.test(formula)) type = 'formula';
  const fmt = str(o.format, 12).toLowerCase() as ValueFormat;
  const col: ColumnSpec = { name, type };
  if (type === 'choice') col.options = options;
  if (type === 'formula') {
    col.formula = formula;
    col.format = FORMATS.includes(fmt) ? fmt : 'number';
  }
  return col;
}

/** Clean up an AI-designed workbook; falls back to `base` when nothing usable came back. */
export function normalizeWorkbook(raw: unknown, base: WorkbookSpec): WorkbookSpec {
  const o = objOf(raw);
  const sheets: SheetSpec[] = [];
  for (const rs of arr(o.sheets).slice(0, MAX_SHEETS)) {
    const s = objOf(rs);
    const name = str(s.name, 31);
    if (!name || /^(start here|dashboard|lists)$/i.test(name)) continue;
    const seen = new Set<string>();
    const columns: ColumnSpec[] = [];
    for (const rc of arr(s.columns)) {
      const c = normColumn(rc);
      if (!c || seen.has(c.name.toLowerCase())) continue;
      seen.add(c.name.toLowerCase());
      columns.push(c);
      if (columns.length >= MAX_COLUMNS) break;
    }
    if (columns.length < 2) continue;
    const rows = arr(s.rows)
      .slice(0, 30)
      .map(objOf)
      .filter((r) => Object.keys(r).length);
    sheets.push({ name, purpose: str(s.purpose, 300), columns, rows, totals: s.totals !== false });
  }
  if (!sheets.length) return base;
  const metrics: MetricSpec[] = arr(o.metrics)
    .slice(0, 10)
    .map(objOf)
    .map((m) => ({
      label: str(m.label, 60),
      op: (OPS.includes(str(m.op).toLowerCase() as MetricOp) ? str(m.op).toLowerCase() : 'sum') as MetricOp,
      sheet: str(m.sheet, 31),
      column: str(m.column, 40),
      whereColumn: str(m.whereColumn, 40) || undefined,
      equals: str(m.equals, 60) || undefined,
      format: FORMATS.includes(str(m.format).toLowerCase() as ValueFormat) ? (str(m.format).toLowerCase() as ValueFormat) : undefined,
    }))
    .filter((m) => m.label && m.sheet && m.column);
  const breakdowns: BreakdownSpec[] = arr(o.breakdowns)
    .slice(0, 3)
    .map(objOf)
    .map((b) => ({ title: str(b.title, 60), sheet: str(b.sheet, 31), byColumn: str(b.byColumn, 40), valueColumn: str(b.valueColumn, 40) || undefined, op: (str(b.op).toLowerCase() === 'count' ? 'count' : 'sum') as 'sum' | 'count' }))
    .filter((b) => b.title && b.sheet && b.byColumn);
  const instructions = arr(o.instructions)
    .map((x) => str(x, 300))
    .filter(Boolean)
    .slice(0, 8);
  return {
    title: str(o.title, 80) || base.title,
    subtitle: str(o.subtitle, 200) || base.subtitle,
    instructions: instructions.length ? instructions : base.instructions,
    sheets,
    metrics,
    breakdowns,
  };
}

// ───────────── values ─────────────

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[$€£,\s]/g, '').replace(/%$/, '');
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  return parseFloat(t);
};

function dateSerial(v: unknown): number | null {
  if (typeof v === 'number' && v > 20000 && v < 80000) return Math.round(v);
  const s = str(v, 40);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return excelDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return excelDate(+m[3], +m[1], +m[2]);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return excelDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

function cellValue(col: ColumnSpec, v: unknown): string | number | { date: number } | null {
  if (v === undefined || v === null || v === '') return null;
  switch (col.type) {
    case 'number':
    case 'currency':
      return num(v) ?? str(v, 200);
    case 'percent': {
      const isPct = typeof v === 'string' && v.trim().endsWith('%');
      const n = num(v);
      if (n === null) return str(v, 200);
      return isPct || n > 1 ? n / 100 : n;
    }
    case 'date': {
      const d = dateSerial(v);
      return d === null ? str(v, 200) : { date: d };
    }
    case 'yesno': {
      const t = String(v).trim().toLowerCase();
      if (v === true || ['yes', 'y', 'true', 'x', 'done', '1', '✓'].includes(t)) return 'Yes';
      if (v === false || ['no', 'n', 'false', '0', ''].includes(t)) return 'No';
      return str(v, 40);
    }
    case 'formula':
      return null;
    default:
      return str(typeof v === 'string' ? v : String(v), 2000);
  }
}

const NUMFMT: Record<ValueFormat, string | undefined> = { currency: '"$"#,##0.00', percent: '0%', date: 'mmm d, yyyy', number: undefined, text: undefined };

/** Number format for a column: whole numbers get thousands separators, decimals two places. */
function numFmtFor(col: ColumnSpec, rows: Record<string, unknown>[]): string | undefined {
  const fmt = formatOf(col);
  if (fmt !== 'number') return NUMFMT[fmt];
  if (col.type === 'formula') return undefined;
  const key = (r: Record<string, unknown>) => Object.keys(r).find((k) => k.trim().toLowerCase() === col.name.trim().toLowerCase());
  const values = rows.map((r) => num(r[key(r) ?? ''])).filter((n): n is number => n !== null);
  return values.length && values.every((n) => Number.isInteger(n)) ? '#,##0' : '#,##0.00';
}

function formatOf(col: ColumnSpec): ValueFormat {
  switch (col.type) {
    case 'currency':
      return 'currency';
    case 'percent':
      return 'percent';
    case 'date':
      return 'date';
    case 'number':
      return 'number';
    case 'formula':
      return col.format ?? 'number';
    default:
      return 'text';
  }
}

// ───────────── colors ─────────────

function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const six = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(six.slice(i, i + 2), 16) || 0) as [number, number, number];
}
const toHex = (c: number[]) => `#${c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`;
/** mix a color toward white (t = 0..1 share of white) */
export const tint = (hex: string, t: number) => toHex(rgbOf(hex).map((x) => x + (255 - x) * t));
export function readableOn(hex: string, dark = '#1f2328'): string {
  const [r, g, b] = rgbOf(hex).map((x) => {
    const c = x / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? dark : '#ffffff';
}

// ───────────── layout ─────────────

export interface WorkbookBrand {
  name: string;
  website?: string;
  colors: BrandColors;
}

interface BuiltSheet {
  spec: SheetSpec;
  name: string;
  colIndex: Map<string, number>;
  columns: ColumnSpec[];
}

/** Lay out the workbook: Start here, one tab per sheet, a Dashboard, and a hidden Lists tab when needed. */
export function buildWorkbookModel(spec: WorkbookSpec, brand: WorkbookBrand, year = new Date().getFullYear()): { model: WorkbookModel; summary: WorkbookSummary } {
  const primary = brand.colors.primary || '#1f5f4a';
  const accent = brand.colors.accent || primary;
  const ink = brand.colors.ink || '#1f2328';
  const onPrimary = readableOn(primary, ink);
  const muted = '#6b7280';
  const line = '#d9dee4';
  const band = tint(primary, 0.92);
  const taken = new Set(['start here', 'dashboard', 'lists']);
  const dropped: string[] = [];
  let formulas = 0;

  const titleStyle: CellStyle = { bold: true, size: 18, color: primary, valign: 'center' };
  const subStyle: CellStyle = { italic: true, color: muted, wrap: true, valign: 'top' };
  const headStyle: CellStyle = { bold: true, color: onPrimary, fill: primary, wrap: true, valign: 'center', border: 'thin', borderColor: primary };

  const lists = newSheet('Lists', { hidden: true });
  let listCol = 0;
  const listRange = (options: string[]): string => {
    listCol++;
    options.forEach((o, i) => setCell(lists, listCol, i + 1, o));
    return `Lists!$${colName(listCol)}$1:$${colName(listCol)}$${options.length}`;
  };

  // data tabs
  const built: BuiltSheet[] = [];
  const dataSheets: SheetModel[] = [];
  for (const s of spec.sheets) {
    const name = safeSheetName(s.name, taken);
    const columns = s.columns.slice(0, MAX_COLUMNS);
    const colIndex = new Map(columns.map((c, i) => [c.name.trim().toLowerCase(), i + 1]));
    const colOf = (n: string) => colIndex.get(n.trim().toLowerCase());
    // formulas that don't compile become plain number columns
    for (const [i, c] of columns.entries()) {
      if (c.type !== 'formula') continue;
      const test = compileRowFormula(c.formula ?? '', colOf, FIRST);
      if (!test.ok || test.refs.includes(i + 1)) {
        dropped.push(`${name} › ${c.name}: formula left out (${test.ok ? 'it refers to itself' : test.error})`);
        columns[i] = { name: c.name, type: c.format === 'currency' ? 'currency' : c.format === 'percent' ? 'percent' : 'number' };
      }
    }
    const last = columns.length;
    const sh = newSheet(name, { tabColor: primary, freezeRows: HEADER_ROW, landscape: last > 6, merges: [`A1:${ref(last, 1)}`, `A2:${ref(last, 2)}`], rowHeights: { 1: 30, 2: 34, [HEADER_ROW]: 32 } });
    sh.cols = columns.map((c) => {
      const base = { text: 22, longtext: 40, number: 13, currency: 15, percent: 12, date: 15, choice: 18, yesno: 11, formula: 16 }[c.type];
      // text columns grow with the example content, up to a point
      const longest = c.type === 'text' || c.type === 'choice' ? Math.max(0, ...s.rows.map((r) => String(r[Object.keys(r).find((k) => k.trim().toLowerCase() === c.name.trim().toLowerCase()) ?? ''] ?? '').length), ...(c.options ?? []).map((o) => o.length)) : 0;
      return Math.min(46, Math.max(base, c.name.length + 4, Math.min(38, longest + 2)));
    });
    setCell(sh, 1, 1, name, titleStyle);
    setCell(sh, 1, 2, s.purpose || '', subStyle);
    const anyTotals = s.totals !== false && columns.some((c) => ['number', 'currency'].includes(c.type) || (c.type === 'formula' && ['number', 'currency'].includes(c.format ?? 'number')));
    columns.forEach((c, i) => {
      const col = i + 1;
      const fmt = formatOf(c);
      const numFmt = numFmtFor(c, s.rows);
      setCell(sh, col, HEADER_ROW, c.name, headStyle);
      const body: CellStyle = { numFmt, border: 'bottom', borderColor: line, valign: 'top', wrap: c.type === 'longtext' || c.type === 'text', align: c.type === 'yesno' ? 'center' : undefined };
      const formulaStyle: CellStyle = { ...body, color: '#374151', fill: '#f6f8fa' };
      for (let r = FIRST; r <= LAST; r++) {
        if (c.type === 'formula') {
          const f = compileRowFormula(c.formula!, colOf, r);
          if (f.ok) {
            setCell(sh, col, r, { formula: `IF(${ref(f.refs[0], r)}="","",IFERROR(${f.formula},""))` }, formulaStyle);
            formulas++;
          }
          continue;
        }
        const row = s.rows[r - FIRST];
        let v: unknown;
        if (row) {
          const key = Object.keys(row).find((k) => k.trim().toLowerCase() === c.name.trim().toLowerCase());
          v = key !== undefined ? row[key] : undefined;
        }
        setCell(sh, col, r, row ? cellValue(c, v) : null, body);
      }
      if (anyTotals) {
        if (col === 1) setCell(sh, 1, TOTAL_ROW, 'Totals', { bold: true, color: primary, fill: band });
        if (['number', 'currency'].includes(fmt) && col !== 1) {
          setCell(sh, col, TOTAL_ROW, { formula: `SUBTOTAL(109,${ref(col, FIRST)}:${ref(col, LAST)})` }, { bold: true, numFmt, fill: band, color: primary });
          formulas++;
        } else if (col !== 1) setCell(sh, col, TOTAL_ROW, null, { fill: band });
      }
      if (c.type === 'choice' && c.options?.length) {
        const joined = c.options.join(',');
        sh.validations = [...(sh.validations ?? []), { sqref: `${ref(col, FIRST)}:${ref(col, LAST)}`, list: joined.length <= 250 ? c.options : { range: listRange(c.options) } }];
      }
      if (c.type === 'yesno') sh.validations = [...(sh.validations ?? []), { sqref: `${ref(col, FIRST)}:${ref(col, LAST)}`, list: ['Yes', 'No'] }];
    });
    sh.autoFilter = `A${HEADER_ROW}:${ref(last, LAST)}`;
    sh.conditional = [{ sqref: `A${FIRST}:${ref(last, LAST)}`, type: 'expression', formula: `AND($A${FIRST}<>"",MOD(ROW(),2)=0)`, fill: band }];
    const yes = columns.findIndex((c) => c.type === 'yesno');
    if (yes >= 0) sh.conditional.push({ sqref: `${ref(yes + 1, FIRST)}:${ref(yes + 1, LAST)}`, type: 'expression', formula: `${ref(yes + 1, FIRST)}="Yes"`, color: primary, bold: true });
    built.push({ spec: s, name, colIndex, columns });
    dataSheets.push(sh);
  }

  const find = (sheet: string) => built.find((b) => b.name.toLowerCase() === sheet.trim().toLowerCase()) ?? built.find((b) => b.spec.name.toLowerCase() === sheet.trim().toLowerCase());
  const range = (b: BuiltSheet, col: number) => `${sheetRef(b.name)}!$${colName(col)}$${FIRST}:$${colName(col)}$${LAST}`;
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

  // dashboard
  const dash = newSheet('Dashboard', { tabColor: accent, gridLines: false, cols: [3, 38, 20, 3], merges: ['B1:C1', 'B2:C2'], rowHeights: { 1: 32, 2: 22 } });
  setCell(dash, 2, 1, 'Dashboard', { ...titleStyle, size: 20 });
  setCell(dash, 2, 2, 'Updates automatically from your other tabs.', subStyle);
  let r = 4;
  let metricCount = 0;
  const metricRows: [string, string, ValueFormat][] = [];
  const labelCount = new Map<string, number>();
  for (const m of spec.metrics) labelCount.set(m.label.toLowerCase(), (labelCount.get(m.label.toLowerCase()) ?? 0) + 1);
  for (const m of spec.metrics) {
    const b = find(m.sheet);
    const col = b?.colIndex.get(m.column.trim().toLowerCase());
    if (!b || !col) {
      dropped.push(`Dashboard › ${m.label}: left out (no “${m.column}” on “${m.sheet}”)`);
      continue;
    }
    const where = m.whereColumn ? b.colIndex.get(m.whereColumn.trim().toLowerCase()) : undefined;
    const rg = range(b, col);
    const column = b.columns[col - 1];
    let f = '';
    switch (m.op) {
      case 'sum':
        f = `SUM(${rg})`;
        break;
      case 'average':
        f = `IFERROR(ROUND(AVERAGE(${rg}),2),0)`;
        break;
      case 'count':
        f = `SUMPRODUCT(--(LEN(${rg})>0))`;
        break;
      case 'min':
        f = `IF(COUNT(${rg})=0,0,MIN(${rg}))`;
        break;
      case 'max':
        f = `IF(COUNT(${rg})=0,0,MAX(${rg}))`;
        break;
      case 'countif':
        if (!m.equals) break;
        f = `COUNTIF(${where ? range(b, where) : rg},${q(m.equals)})`;
        break;
      case 'sumif':
        if (!where || !m.equals) break;
        f = `SUMIF(${range(b, where)},${q(m.equals)},${rg})`;
        break;
    }
    if (!f) {
      dropped.push(`Dashboard › ${m.label}: left out (${m.op} needs ${m.op === 'sumif' ? 'whereColumn and equals' : 'equals'})`);
      continue;
    }
    const fmt: ValueFormat = m.format ?? (m.op === 'count' || m.op === 'countif' ? 'number' : formatOf(column) === 'text' ? 'number' : formatOf(column));
    // the same label from two tabs gets the tab's name
    const label = (labelCount.get(m.label.toLowerCase()) ?? 0) > 1 ? `${m.label} (${b.name})` : m.label;
    metricRows.push([label, f, fmt === 'date' && !['min', 'max'].includes(m.op) ? 'number' : fmt]);
  }
  if (metricRows.length) {
    setCell(dash, 2, r, 'Key numbers', { bold: true, size: 13, color: primary });
    r++;
    setCell(dash, 2, r, 'Metric', headStyle);
    setCell(dash, 3, r, 'Value', { ...headStyle, align: 'right' });
    r++;
    for (const [label, f, fmt] of metricRows) {
      setCell(dash, 2, r, label, { border: 'bottom', borderColor: line, valign: 'center' });
      setCell(dash, 3, r, { formula: f }, { bold: true, size: 13, color: ink, numFmt: NUMFMT[fmt], align: 'right', border: 'bottom', borderColor: line });
      dash.rowHeights![r] = 24;
      formulas++;
      metricCount++;
      r++;
    }
    r++;
  }
  for (const bd of spec.breakdowns) {
    const b = find(bd.sheet);
    const by = b?.colIndex.get(bd.byColumn.trim().toLowerCase());
    const val = bd.valueColumn ? b?.colIndex.get(bd.valueColumn.trim().toLowerCase()) : undefined;
    const byCol = b && by ? b.columns[by - 1] : undefined;
    const options = byCol?.type === 'choice' ? byCol.options ?? [] : [...new Set((b?.spec.rows ?? []).map((row) => str(row[Object.keys(row).find((k) => k.trim().toLowerCase() === bd.byColumn.trim().toLowerCase()) ?? ''], 40)).filter(Boolean))];
    if (!b || !by || !options.length || (bd.op === 'sum' && !val)) {
      dropped.push(`Dashboard › ${bd.title}: left out (needs a category column${bd.op === 'sum' ? ' and a number column' : ''} on “${bd.sheet}”)`);
      continue;
    }
    const fmt = bd.op === 'sum' && val ? formatOf(b.columns[val - 1]) : 'number';
    setCell(dash, 2, r, bd.title, { bold: true, size: 13, color: primary });
    r++;
    setCell(dash, 2, r, b.columns[by - 1].name, headStyle);
    setCell(dash, 3, r, bd.op === 'sum' && val ? b.columns[val - 1].name : 'Count', { ...headStyle, align: 'right' });
    r++;
    const top = r;
    for (const opt of options.slice(0, 25)) {
      setCell(dash, 2, r, opt, { border: 'bottom', borderColor: line });
      const f = bd.op === 'sum' && val ? `SUMIF(${range(b, by)},${ref(2, r)},${range(b, val)})` : `COUNTIF(${range(b, by)},${ref(2, r)})`;
      setCell(dash, 3, r, { formula: f }, { numFmt: bd.op === 'count' || fmt === 'text' || fmt === 'number' ? '#,##0' : NUMFMT[fmt], align: 'right', border: 'bottom', borderColor: line });
      formulas++;
      r++;
    }
    dash.conditional = [...(dash.conditional ?? []), { sqref: `C${top}:C${r - 1}`, type: 'dataBar', color: tint(accent, 0.25) }];
    r++;
  }
  const hasDash = metricCount > 0 || (dash.conditional?.length ?? 0) > 0;

  // start here
  const start = newSheet('Start here', { tabColor: accent, gridLines: false, cols: [3, 6, 28, 70], merges: ['B1:D1', 'B2:D2'], rowHeights: { 1: 36, 2: 34 } });
  setCell(start, 2, 1, spec.title, { ...titleStyle, size: 22 });
  setCell(start, 2, 2, spec.subtitle, { ...subStyle, size: 12 });
  let sr = 4;
  setCell(start, 2, sr, 'How to use this workbook', { bold: true, size: 13, color: primary });
  start.merges!.push(`B${sr}:D${sr}`);
  sr++;
  spec.instructions.forEach((step, i) => {
    setCell(start, 2, sr, i + 1, { bold: true, color: onPrimary, fill: accent === primary ? primary : accent, align: 'center', valign: 'center' });
    setCell(start, 3, sr, step, { wrap: true, valign: 'center' });
    start.merges!.push(`C${sr}:D${sr}`);
    start.rowHeights![sr] = step.length > 90 ? 34 : 22;
    sr++;
  });
  sr++;
  setCell(start, 2, sr, 'What’s inside', { bold: true, size: 13, color: primary });
  start.merges!.push(`B${sr}:D${sr}`);
  sr++;
  const linkStyle: CellStyle = { underline: true, bold: true, color: primary, valign: 'center' };
  for (const b of built) {
    setCell(start, 3, sr, b.name, linkStyle, `${sheetRef(b.name)}!A1`);
    setCell(start, 4, sr, b.spec.purpose || '', { wrap: true, color: '#374151', valign: 'center' });
    start.rowHeights![sr] = (b.spec.purpose?.length ?? 0) > 80 ? 34 : 22;
    sr++;
  }
  if (hasDash) {
    setCell(start, 3, sr, 'Dashboard', linkStyle, `${sheetRef('Dashboard')}!A1`);
    setCell(start, 4, sr, 'Your key numbers, updated automatically.', { wrap: true, color: '#374151', valign: 'center' });
    sr++;
  }
  sr++;
  setCell(start, 2, sr, `Tip: rows ${FIRST}–${LAST} on each tab are ready for your data: dropdowns, number formats and calculations are already set up. Grey cells calculate themselves.`, { italic: true, color: muted, wrap: true });
  start.merges!.push(`B${sr}:D${sr}`);
  start.rowHeights![sr] = 32;
  sr += 2;
  setCell(start, 2, sr, `© ${year} ${brand.name}${brand.website ? ` · ${brand.website}` : ''}`, { color: muted, size: 10 });
  start.merges!.push(`B${sr}:D${sr}`);

  const sheets = [start, ...dataSheets, ...(hasDash ? [dash] : []), ...(listCol ? [lists] : [])];
  return {
    model: { title: spec.title, author: brand.name, sheets },
    summary: { sheets: built.map((b) => ({ name: b.name, columns: b.columns.map((c) => c.name), rows: Math.min(b.spec.rows.length, DATA_ROWS) })), formulas, metrics: metricCount, dropped },
  };
}

/** The finished .xlsx file and what's in it. */
export function workbookFile(spec: WorkbookSpec, brand: WorkbookBrand, now = new Date()): { bytes: Uint8Array; summary: WorkbookSummary } {
  const { model, summary } = buildWorkbookModel(spec, brand, now.getFullYear());
  return { bytes: writeXlsx(model, now), summary };
}
