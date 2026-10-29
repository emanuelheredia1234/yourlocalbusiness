// A small .xlsx (Office Open XML) writer: styled cells, formulas, merged cells, frozen panes,
// filters, dropdowns, conditional formatting, internal links and hidden sheets. No dependencies;
// elements are written in the order the SpreadsheetML schema requires, which Excel enforces.

import { zip } from './zip';

export type CellValue = string | number | boolean | null | { formula: string } | { date: number };

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  /** hex like #1f5f4a */
  color?: string;
  fill?: string;
  /** Excel number format code, e.g. "$"#,##0.00 */
  numFmt?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'center' | 'bottom';
  wrap?: boolean;
  indent?: number;
  border?: 'thin' | 'bottom' | 'top';
  borderColor?: string;
}

export interface Cell {
  v: CellValue;
  s?: CellStyle;
  /** internal link target, e.g. 'Budget'!A1 */
  link?: string;
}

export type ConditionalRule =
  | { sqref: string; type: 'expression'; formula: string; fill?: string; color?: string; bold?: boolean }
  | { sqref: string; type: 'dataBar'; color: string };

export interface SheetModel {
  name: string;
  hidden?: boolean;
  rows: Map<number, Map<number, Cell>>;
  /** widths in characters, index 0 = column A */
  cols?: number[];
  rowHeights?: Record<number, number>;
  merges?: string[];
  /** number of rows kept visible at the top */
  freezeRows?: number;
  autoFilter?: string;
  validations?: { sqref: string; list: string[] | { range: string } }[];
  conditional?: ConditionalRule[];
  tabColor?: string;
  gridLines?: boolean;
  landscape?: boolean;
}

export interface WorkbookModel {
  title: string;
  author: string;
  sheets: SheetModel[];
}

// ───────────── helpers ─────────────

export function colName(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export const ref = (col: number, row: number, abs = false) => (abs ? `$${colName(col)}$${row}` : `${colName(col)}${row}`);

/** A sheet name as formulas need it: 'My Sheet'!A1 */
export const sheetRef = (name: string) => `'${name.replace(/'/g, "''")}'`;

/** Excel's date serial for a calendar date (1900 date system). */
export function excelDate(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/** Sheet names: at most 31 characters, none of []:*?/\ and unique (case-insensitive). */
export function safeSheetName(name: string, taken: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let out = base;
  for (let i = 2; taken.has(out.toLowerCase()); i++) {
    const suffix = ` ${i}`;
    out = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(out.toLowerCase());
  return out;
}

export function newSheet(name: string, init: Partial<SheetModel> = {}): SheetModel {
  return { name, rows: new Map(), ...init };
}

export function setCell(sheet: SheetModel, col: number, row: number, v: CellValue, s?: CellStyle, link?: string) {
  let r = sheet.rows.get(row);
  if (!r) sheet.rows.set(row, (r = new Map()));
  r.set(col, { v, s, link });
}

// invalid XML characters are dropped; text is escaped
const esc = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const argb = (hex: string) => {
  const h = hex.replace('#', '').trim();
  const six = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h.slice(0, 6);
  return `FF${/^[0-9a-f]{6}$/i.test(six) ? six.toUpperCase() : '000000'}`;
};

// ───────────── styles ─────────────

class Styles {
  fonts: string[] = ['<font><sz val="11"/><color rgb="FF1F2328"/><name val="Calibri"/><family val="2"/></font>'];
  fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  numFmts: string[] = [];
  xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  dxfs: string[] = [];
  private keys = new Map<string, number>();

  private index(list: string[], xml: string): number {
    const i = list.indexOf(xml);
    if (i >= 0) return i;
    list.push(xml);
    return list.length - 1;
  }

  xf(s: CellStyle | undefined): number {
    if (!s) return 0;
    const key = JSON.stringify(s);
    const known = this.keys.get(key);
    if (known !== undefined) return known;
    const font = this.index(this.fonts, `<font>${s.bold ? '<b/>' : ''}${s.italic ? '<i/>' : ''}${s.underline ? '<u/>' : ''}<sz val="${s.size ?? 11}"/><color rgb="${argb(s.color ?? '#1f2328')}"/><name val="Calibri"/><family val="2"/></font>`);
    const fill = s.fill ? this.index(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    let border = 0;
    if (s.border) {
      const c = `<color rgb="${argb(s.borderColor ?? '#d0d7de')}"/>`;
      const side = (on: boolean, tag: string) => (on ? `<${tag} style="thin">${c}</${tag}>` : `<${tag}/>`);
      const box = s.border === 'thin';
      border = this.index(this.borders, `<border>${side(box, 'left')}${side(box, 'right')}${side(box || s.border === 'top', 'top')}${side(box || s.border === 'bottom', 'bottom')}<diagonal/></border>`);
    }
    let numFmt = 0;
    if (s.numFmt) {
      const builtin: Record<string, number> = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10 };
      numFmt = builtin[s.numFmt] ?? 164 + this.index(this.numFmts, s.numFmt);
    }
    const align = s.align || s.valign || s.wrap || s.indent ? `<alignment${s.align ? ` horizontal="${s.align}"` : ''}${s.valign ? ` vertical="${s.valign}"` : ''}${s.wrap ? ' wrapText="1"' : ''}${s.indent ? ` indent="${s.indent}"` : ''}/>` : '';
    const xml = `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`;
    const i = this.index(this.xfs, xml);
    this.keys.set(key, i);
    return i;
  }

  dxf(fill?: string, color?: string, bold?: boolean): number {
    const font = color || bold ? `<font>${bold ? '<b/>' : ''}${color ? `<color rgb="${argb(color)}"/>` : ''}</font>` : '';
    const f = fill ? `<fill><patternFill patternType="solid"><bgColor rgb="${argb(fill)}"/></patternFill></fill>` : '';
    return this.index(this.dxfs, `<dxf>${font}${f}</dxf>`);
  }

  xml(): string {
    const nf = this.numFmts.length ? `<numFmts count="${this.numFmts.length}">${this.numFmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(c)}"/>`).join('')}</numFmts>` : '';
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      nf +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      `<dxfs count="${this.dxfs.length}">${this.dxfs.join('')}</dxfs>` +
      '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>'
    );
  }
}

// ───────────── sheets ─────────────

function cellXml(col: number, row: number, c: Cell, styles: Styles): string {
  const r = ref(col, row);
  const s = styles.xf(c.s);
  const sa = s ? ` s="${s}"` : '';
  const v = c.v;
  if (v === null || v === undefined || v === '') return `<c r="${r}"${sa}/>`;
  if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${r}"${sa}><v>${v}</v></c>` : `<c r="${r}"${sa}/>`;
  if (typeof v === 'boolean') return `<c r="${r}"${sa} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === 'object' && 'formula' in v) return `<c r="${r}"${sa}><f>${esc(v.formula.replace(/^=/, ''))}</f></c>`;
  if (typeof v === 'object' && 'date' in v) return `<c r="${r}"${sa}><v>${v.date}</v></c>`;
  const text = String(v).slice(0, 32_000);
  return `<c r="${r}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function sheetXml(sh: SheetModel, styles: Styles, selected: boolean): string {
  const rowNums = [...sh.rows.keys()].sort((a, b) => a - b);
  let maxCol = 1;
  for (const r of sh.rows.values()) for (const c of r.keys()) maxCol = Math.max(maxCol, c);
  const maxRow = rowNums.length ? rowNums[rowNums.length - 1] : 1;
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  // every tab prints fit to the page width
  parts.push(`<sheetPr>${sh.tabColor ? `<tabColor rgb="${argb(sh.tabColor)}"/>` : ''}<pageSetUpPr fitToPage="1"/></sheetPr>`);
  parts.push(`<dimension ref="A1:${ref(maxCol, maxRow)}"/>`);
  const view = `<sheetView${sh.gridLines === false ? ' showGridLines="0"' : ''}${selected ? ' tabSelected="1"' : ''} workbookViewId="0">`;
  if (sh.freezeRows) {
    const top = ref(1, sh.freezeRows + 1);
    parts.push(`<sheetViews>${view}<pane ySplit="${sh.freezeRows}" topLeftCell="${top}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="${top}" sqref="${top}"/></sheetView></sheetViews>`);
  } else parts.push(`<sheetViews>${view}</sheetView></sheetViews>`);
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (sh.cols?.length) parts.push(`<cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(1, Math.min(120, w))}" customWidth="1"/>`).join('')}</cols>`);
  parts.push('<sheetData>');
  const links: string[] = [];
  for (const rn of rowNums) {
    const cells = sh.rows.get(rn)!;
    const ht = sh.rowHeights?.[rn];
    parts.push(`<row r="${rn}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>`);
    for (const cn of [...cells.keys()].sort((a, b) => a - b)) {
      const c = cells.get(cn)!;
      parts.push(cellXml(cn, rn, c, styles));
      if (c.link) links.push(`<hyperlink ref="${ref(cn, rn)}" location="${esc(c.link)}" display="${esc(String(c.v ?? ''))}"/>`);
    }
    parts.push('</row>');
  }
  parts.push('</sheetData>');
  if (sh.autoFilter) parts.push(`<autoFilter ref="${sh.autoFilter}"/>`);
  if (sh.merges?.length) parts.push(`<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`);
  let priority = 1;
  for (const cf of sh.conditional ?? []) {
    if (cf.type === 'expression') parts.push(`<conditionalFormatting sqref="${cf.sqref}"><cfRule type="expression" dxfId="${styles.dxf(cf.fill, cf.color, cf.bold)}" priority="${priority++}"><formula>${esc(cf.formula)}</formula></cfRule></conditionalFormatting>`);
    else parts.push(`<conditionalFormatting sqref="${cf.sqref}"><cfRule type="dataBar" priority="${priority++}"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="${argb(cf.color)}"/></dataBar></cfRule></conditionalFormatting>`);
  }
  if (sh.validations?.length) {
    parts.push(`<dataValidations count="${sh.validations.length}">`);
    for (const dv of sh.validations) {
      const f = Array.isArray(dv.list) ? `"${dv.list.map((x) => x.replace(/[",]/g, ' ').trim()).join(',')}"` : dv.list.range;
      parts.push(`<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorStyle="warning" sqref="${dv.sqref}"><formula1>${esc(f)}</formula1></dataValidation>`);
    }
    parts.push('</dataValidations>');
  }
  if (links.length) parts.push(`<hyperlinks>${links.join('')}</hyperlinks>`);
  parts.push('<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>');
  parts.push(`<pageSetup orientation="${sh.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`);
  parts.push('</worksheet>');
  return parts.join('');
}

/** Serialize a workbook to .xlsx bytes. */
export function writeXlsx(wb: WorkbookModel, now = new Date()): Uint8Array {
  const styles = new Styles();
  const visibleFirst = Math.max(0, wb.sheets.findIndex((s) => !s.hidden));
  const sheetXmls = wb.sheets.map((s, i) => sheetXml(s, styles, i === visibleFirst));
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const n = wb.sheets.length;
  const files = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        wb.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    },
    {
      name: 'docProps/core.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${esc(wb.title)}</dc:title><dc:creator>${esc(wb.author)}</dc:creator><cp:lastModifiedBy>${esc(wb.author)}</cp:lastModifiedBy>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`,
    },
    {
      name: 'docProps/app.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Yourlocalbusiness</Application></Properties>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<workbookPr/><bookViews><workbookView activeTab="${visibleFirst}"/></bookViews><sheets>` +
        wb.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('') +
        '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        wb.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    ...sheetXmls.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
    // styles last: every sheet has registered its formats by now
    { name: 'xl/styles.xml', data: styles.xml() },
  ];
  return zip(files, now);
}
