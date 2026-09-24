/**
 * Office — local export (التصدير المحلي), the pure part.
 *
 * Three serialisers, each one honest about what it really contains:
 *  • `.txt` — the text of the document: one line per paragraph, one line per slide
 *    paragraph, or a sheet's rows with tab-separated cells. No formatting at all;
 *  • `.csv` — one sheet as rows and cells (RFC 4180 quoting, through the same
 *    `writeDelimited` the app saves with), and a Word/text document as one
 *    single-column row per line, because a CSV holds rows and nothing else;
 *  • `.html` — a complete, self-contained page: paragraphs, or a real `<table>` for a
 *    sheet, with the direction the app is in. Every piece of document text is
 *    escaped, so a file that contains `<script>` stays text — never markup — in the
 *    exported page.
 *
 * The `.pdf` path is deliberately not here: it is the browser's own print-to-PDF on
 * a print-ready page (`toHtml` already carries the print rules), because writing a
 * PDF by hand could not embed an Arabic font with what this app has.
 */
import { writeDelimited } from './file';
import type { OfficeModel } from './model';

export type ExportFormat = 'txt' | 'csv' | 'html';

/** The text of a document, with nothing of its structure but the line breaks. */
export function plainText(model: OfficeModel): string {
  switch (model.kind) {
    case 'docx': return model.paragraphs.join('\n');
    case 'pptx': return model.slides.map((slide) => slide.join('\n')).join('\n\n');
    case 'text': return model.text;
    default: {
      const grid = model.grids[model.active] ?? model.grids[0];
      if (!grid) return '';
      return grid.rows.map((row) => row.join('\t')).join('\n');
    }
  }
}

/**
 * The rows of the document as a table: a sheet gives its active sheet's cells, and
 * anything else gives one single-column row per line, which is the most a CSV can
 * hold of a document that is not a table.
 */
export function sheetRows(model: OfficeModel): string[][] {
  if (model.kind === 'xlsx' || model.kind === 'csv') {
    const grid = model.grids[model.active] ?? model.grids[0];
    return grid ? grid.rows.map((row) => [...row]) : [];
  }
  const lines = model.kind === 'docx' ? model.paragraphs
    : model.kind === 'pptx' ? model.slides.flatMap((slide) => slide)
      : model.kind === 'text' ? [model.text]
        : [];
  return lines.map((line) => [line]);
}

/** RFC 4180 CSV of the active sheet (or of the document's lines). */
export function toCsv(model: OfficeModel): string {
  return writeDelimited(sheetRows(model), ',');
}

/** Everything XML and HTML give a meaning to. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped text, with CRLF normalised so it reads the same in every editor. */
function htmlText(text: string): string {
  return escapeHtml(text.replace(/\r\n?/g, '\n'));
}

const HTML_STYLE =
  'body{margin:0;padding:24px;font:16px/1.9 system-ui,"Segoe UI","Noto Sans Arabic",sans-serif;color:#111;background:#fff}' +
  'main{max-width:820px;margin:0 auto}' +
  'h1{font-size:22px;margin:0 0 18px}' +
  'p{margin:0 0 14px;overflow-wrap:anywhere;white-space:pre-wrap}' +
  'section.slide{border:1px solid #bbb;border-radius:8px;padding:14px 16px;margin:0 0 18px}' +
  'pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}' +
  'table{border-collapse:collapse;font-size:15px}' +
  'td{border:1px solid #999;padding:6px 10px;overflow-wrap:anywhere;white-space:pre-wrap}' +
  '@media print{body{padding:0}section.slide{break-inside:avoid}}';

/**
 * A complete, self-contained HTML page — the same page the PDF action prints.
 * `dir` is the direction of the app the owner is in; the sheet's own grid stays
 * left-to-right, exactly as it is in the window.
 */
export function toHtml(model: OfficeModel, title: string, dir: 'rtl' | 'ltr' = 'rtl'): string {
  let body: string;
  switch (model.kind) {
    case 'docx':
      body = model.paragraphs.map((paragraph) => `<p>${htmlText(paragraph)}</p>`).join('');
      break;
    case 'pptx':
      body = model.slides
        .map((slide) => `<section class="slide">${slide.map((text) => `<p>${htmlText(text)}</p>`).join('')}</section>`)
        .join('');
      break;
    case 'text':
      body = `<pre>${htmlText(model.text)}</pre>`;
      break;
    default: {
      const grid = model.grids[model.active] ?? model.grids[0];
      const rows = grid ? grid.rows : [];
      body = `<table dir="ltr"><tbody>${rows
        .map((row) => `<tr>${row.map((cell) => `<td>${htmlText(cell)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
      break;
    }
  }
  return '<!DOCTYPE html>\n'
    + `<html lang="${dir === 'rtl' ? 'ar' : 'en'}" dir="${dir}">\n<head>\n<meta charset="utf-8"/>\n`
    + '<meta name="viewport" content="width=device-width, initial-scale=1"/>\n'
    + `<title>${escapeHtml(title)}</title>\n<style>${HTML_STYLE}</style>\n</head>\n`
    + `<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>\n</html>\n`;
}

/** The characters a file name may not carry on Windows or carry a path with. */
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * A download name for a format: the opened file's own name with its extension
 * replaced, so "report.docx" exports as "report.txt". Anything that could act as a
 * path separator or a Windows-reserved character becomes a dash.
 */
export function exportName(base: string, format: ExportFormat): string {
  const leaf = base.split('/').pop() ?? base;
  const stem = leaf.replace(/\.[^.]*$/, '').replace(UNSAFE_NAME, '-').replace(/^\.+/, '').trim();
  return `${stem || 'document'}.${format}`;
}

/** The MIME type of an export; UTF-8 is named so the Arabic text is unambiguous. */
export function exportMime(format: ExportFormat): string {
  switch (format) {
    case 'csv': return 'text/csv;charset=utf-8';
    case 'html': return 'text/html;charset=utf-8';
    default: return 'text/plain;charset=utf-8';
  }
}
