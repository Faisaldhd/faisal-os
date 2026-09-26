/**
 * Office — writing Word (.docx) and Excel (.xlsx) packages.
 *
 * Both are ZIP archives of XML parts. Every part written here is built from the
 * model only, in plain text, and escaped through `xml.ts`: nothing from the file
 * is copied as markup. The result is a fresh, minimal but schema-shaped package —
 * which is exactly why the app says styling, images, charts and macros do not
 * survive a save (the reader never saw them, so they cannot be written back).
 */
import { formulaKey, type Grid, type ParagraphFormat } from './model';
import { cellName, isNumericText, paragraphPropertiesMarkup, runPropertiesMarkup, sheetName, xmlText } from './xml';
import { utf8, writeZip, type ZipInput } from './zip';
import { addCellStyles, addDxfs, applySheetLook, MINIMAL_STYLES } from './grid/xlsxstyle';
import type { SheetFormat } from './grid/sheetfmt';
import { autoFilterRef, autoFilterXml, type AutoFilterColumn } from './grid/autofilter';
import { conditionalFormattingXml, dxfBody, sqrefOf } from './grid/condfmt-xml';
import type { CellStyle, CondRule } from './calc/index';
import { columnName } from './xml';

/** The style a rule paints with, whatever kind of rule it is (`''` for the ones without one). */
function ruleStyleOf(rule: CondRule): Partial<CellStyle> | undefined {
  return 'style' in rule ? rule.style : undefined;
}

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

export function contentTypes(overrides: readonly string[]): string {
  return `${DECL}<Types xmlns="${CONTENT_NS}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.join('') +
    '</Types>';
}

/* ─────────────────────────────── Word ─────────────────────────────── */

/**
 * One paragraph's runs. A tab becomes `<w:tab/>` and a line break `<w:br/>` —
 * the two things the reader can give back (`formats.ts: paragraphText`). Carriage
 * returns are normalized to newlines first, because XML parsers do that to
 * character data anyway and the reader only ever produces "\n".
 *
 * `format` adds the run properties the owner chose (bold, italic, size,
 * underline) to every run of that paragraph: this writer rebuilds the file from
 * text, so a paragraph has one formatting, exactly like the surgical patcher.
 */
function docxRuns(text: string, format?: ParagraphFormat): string {
  const rPr = runPropertiesMarkup(format);
  let out = '';
  for (const part of text.replace(/\r\n?/g, '\n').split(/([\t\n])/)) {
    if (part === '\t') out += `<w:r>${rPr}<w:tab/></w:r>`;
    else if (part === '\n') out += `<w:r>${rPr}<w:br/></w:r>`;
    else if (part) out += `<w:r>${rPr}<w:t xml:space="preserve">${xmlText(part)}</w:t></w:r>`;
  }
  // A paragraph with formatting but no text keeps an empty run, so the
  // formatting is not lost on the way back in.
  if (!out && rPr) out = `<w:r>${rPr}</w:r>`;
  return out;
}

/** One paragraph, with its alignment and its runs (an untouched one stays `<w:p/>`). */
function docxParagraph(text: string, format?: ParagraphFormat): string {
  const runs = docxRuns(text, format);
  const pPr = paragraphPropertiesMarkup(format);
  if (!runs && !pPr) return '<w:p/>';
  return `<w:p>${pPr}${runs}</w:p>`;
}

export function docxDocument(paragraphs: readonly string[], formats?: Record<number, ParagraphFormat>): string {
  const body = paragraphs.map((p, i) => docxParagraph(p, formats?.[i])).join('');
  return `${DECL}<w:document xmlns:w="${W_NS}"><w:body>${body}` +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>';
}

const DOCX_STYLES = `${DECL}<w:styles xmlns:w="${W_NS}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
  '</w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '</w:styles>';

/** A minimal Word document: paragraphs only, with the formatting the model carries. */
export function writeDocx(paragraphs: readonly string[], formats?: Record<number, ParagraphFormat>): Uint8Array {
  const parts: ZipInput[] = [
    {
      name: '[Content_Types].xml',
      data: utf8(contentTypes([
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
      ])),
    },
    {
      name: '_rels/.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="word/document.xml"/>` +
        '</Relationships>'),
    },
    { name: 'word/document.xml', data: utf8(docxDocument(paragraphs, formats)) },
    { name: 'word/styles.xml', data: utf8(DOCX_STYLES) },
    {
      name: 'word/_rels/document.xml.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${DOC_REL}/styles" Target="styles.xml"/>` +
        '</Relationships>'),
    },
  ];
  return writeZip(parts);
}

/* ────────────────────────────── Excel ────────────────────────────── */

/**
 * One worksheet part. Numbers are written as numbers (`<v>`), everything else as
 * an inline string, so a saved sheet still sums correctly; empty cells are left
 * out but every row element is written, which keeps row numbering identical to
 * what the reader gave us. Cell types the reader had already flattened (a boolean
 * became "TRUE") are written as text — the app cannot invent the type back.
 *
 * A cell the owner gave a formula keeps it: `<f>` holds the canonical formula and
 * `<v>` the value this app computed, which is what Excel shows without
 * recalculating and what every other reader sees.
 */
export function xlsxSheet(grid: Grid, sheet = 0, formulas?: Record<string, string>, filters?: readonly AutoFilterColumn[], conditional?: string | null): string {
  const rows = grid.rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const formula = formulas?.[formulaKey(sheet, r, c)];
      if (formula) {
        // Excel's <f> holds the formula without the "=" the cell shows.
        const type = value.startsWith('#') ? ' t="e"' : '';
        return `<c r="${cellName(r, c)}"${type}><f>${xmlText(formula.replace(/^=/, ''))}</f><v>${xmlText(value)}</v></c>`;
      }
      if (value === '') return '';
      const ref = cellName(r, c);
      const trimmed = value.trim();
      if (isNumericText(value)) return `<c r="${ref}"><v>${xmlText(trimmed)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  // The AutoFilter sits right after `</sheetData>`, and the conditional formatting after it: that is
  // the order the schema fixes, and it is what makes the saved sheet open — filtered, coloured and
  // clearable again — in Excel and LibreOffice instead of being repaired.
  const width = grid.rows.reduce((w, row) => Math.max(w, row.length), 0);
  const ref = autoFilterRef(grid.rows.length, width);
  const filter = filters?.length && ref ? autoFilterXml(filters, ref) : null;
  return `${DECL}<worksheet xmlns="${S_NS}"><sheetData>${rows}</sheetData>${filter ?? ''}${conditional ?? ''}</worksheet>`;
}

/**
 * A minimal Excel workbook: one worksheet part per grid, inline strings, and a
 * styles part carrying the owner's formatting (column widths, row heights, cell
 * formats) when the model has any.
 */
export function writeXlsx(
  grids: readonly Grid[],
  formulas?: Record<string, string>,
  formats?: Record<number, SheetFormat>,
  autoFilters?: Record<number, readonly AutoFilterColumn[]>,
  condRules?: Record<number, readonly CondRule[]>,
): Uint8Array {
  const sheets: Grid[] = grids.length ? [...grids] : [{ name: 'Sheet1', rows: [], truncated: false }];
  const taken = new Set<string>();
  const names = sheets.map((grid, i) => {
    const name = sheetName(grid.name, i, taken);
    taken.add(name);
    return name;
  });

  // Formatting: every styled cell gets an xf built over the default one.
  let styles = MINIMAL_STYLES;
  const sheetXml = sheets.map((grid, i) => {
    // Conditional formatting: the rules first (they give the dxfs their indices), then the element
    // that points at them, which belongs after the AutoFilter.
    const rules = condRules?.[i] ?? [];
    let conditional: string | null = null;
    if (rules.length) {
      const bodies = rules.map((rule) => dxfBody(ruleStyleOf(rule)));
      const dxfs = addDxfs(styles, bodies.filter((b): b is string => b !== null));
      styles = dxfs.xml;
      let next = 0;
      const ids = bodies.map((b) => (b === null ? null : dxfs.ids[next++]));
      const width = grid.rows.reduce((w, row) => Math.max(w, row.length), 0);
      conditional = conditionalFormattingXml(rules, sqrefOf({ r0: 0, c0: 0, r1: Math.max(0, grid.rows.length - 1), c1: Math.max(0, width - 1) }, columnName), ids);
    }
    const xml = xlsxSheet(grid, i, formulas, autoFilters?.[i], conditional);
    const fmt = formats?.[i];
    if (!fmt) return xml;
    const keys = Object.keys(fmt.cells ?? {});
    const added = addCellStyles(styles, keys.map((key) => ({ base: 0, format: (fmt.cells ?? {})[key] })));
    styles = added.xml;
    const cells = new Map(keys.map((key, k) => [key, added.ids[k]]));
    const rows = new Map(Object.entries(fmt.rows ?? {}).map(([k, v]) => [Number(k), v]));
    const cols = new Map(Object.entries(fmt.cols ?? {}).map(([k, v]) => [Number(k), v]));
    return applySheetLook(xml, { cells, rows, cols });
  });

  const parts: ZipInput[] = [
    {
      name: '[Content_Types].xml',
      data: utf8(contentTypes([
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        ...sheets.map((_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
      ])),
    },
    {
      name: '_rels/.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>'),
    },
    {
      name: 'xl/workbook.xml',
      data: utf8(`${DECL}<workbook xmlns="${S_NS}" xmlns:r="${DOC_REL}"><sheets>` +
        names.map((name, i) => `<sheet name="${xmlText(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        names.map((_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${DOC_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${names.length + 1}" Type="${DOC_REL}/styles" Target="styles.xml"/>` +
        '</Relationships>'),
    },
    { name: 'xl/styles.xml', data: utf8(styles) },
    ...sheets.map((_, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml[i]) })),
  ];
  return writeZip(parts);
}
