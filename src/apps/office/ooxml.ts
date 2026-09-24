/**
 * Office — writing Word (.docx) and Excel (.xlsx) packages.
 *
 * Both are ZIP archives of XML parts. Every part written here is built from the
 * model only, in plain text, and escaped through `xml.ts`: nothing from the file
 * is copied as markup. The result is a fresh, minimal but schema-shaped package —
 * which is exactly why the app says styling, images, charts and macros do not
 * survive a save (the reader never saw them, so they cannot be written back).
 */
import type { Grid } from './model';
import { cellName, isNumericText, sheetName, xmlText } from './xml';
import { utf8, writeZip, type ZipInput } from './zip';

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
 */
function docxRuns(text: string): string {
  let out = '';
  for (const part of text.replace(/\r\n?/g, '\n').split(/([\t\n])/)) {
    if (part === '\t') out += '<w:r><w:tab/></w:r>';
    else if (part === '\n') out += '<w:r><w:br/></w:r>';
    else if (part) out += `<w:r><w:t xml:space="preserve">${xmlText(part)}</w:t></w:r>`;
  }
  return out;
}

export function docxDocument(paragraphs: readonly string[]): string {
  const body = paragraphs.map((p) => (p ? `<w:p>${docxRuns(p)}</w:p>` : '<w:p/>')).join('');
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

/** A minimal Word document: paragraphs only, no styling beyond a default font. */
export function writeDocx(paragraphs: readonly string[]): Uint8Array {
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
    { name: 'word/document.xml', data: utf8(docxDocument(paragraphs)) },
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
 */
export function xlsxSheet(grid: Grid): string {
  const rows = grid.rows.map((row, r) => {
    const cells = row.map((value, c) => {
      if (value === '') return '';
      const ref = cellName(r, c);
      const trimmed = value.trim();
      if (isNumericText(value)) return `<c r="${ref}"><v>${xmlText(trimmed)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  return `${DECL}<worksheet xmlns="${S_NS}"><sheetData>${rows}</sheetData></worksheet>`;
}

/** A minimal Excel workbook: one worksheet part per grid, inline strings, no styles. */
export function writeXlsx(grids: readonly Grid[]): Uint8Array {
  const sheets: Grid[] = grids.length ? [...grids] : [{ name: 'Sheet1', rows: [], truncated: false }];
  const taken = new Set<string>();
  const names = sheets.map((grid, i) => {
    const name = sheetName(grid.name, i, taken);
    taken.add(name);
    return name;
  });

  const parts: ZipInput[] = [
    {
      name: '[Content_Types].xml',
      data: utf8(contentTypes([
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
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
        '</Relationships>'),
    },
    ...sheets.map((grid, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(xlsxSheet(grid)) })),
  ];
  return writeZip(parts);
}
