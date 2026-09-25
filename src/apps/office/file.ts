/**
 * Office — the bridge between a file's bytes and the editable model.
 *
 * Reading is the viewer's readers, unchanged and unchanged-able from here
 * (`src/apps/viewer/formats.ts`): this file only maps their output into the
 * model. Writing goes the other way, through the ZIP writer and the OOXML
 * writers in this directory.
 *
 * Every path that cannot be rendered returns a reason instead of an empty screen:
 * a legacy binary extension, an unknown extension, a text file that is really
 * binary, or a package whose XML the readers refuse.
 */
import { basename } from '../../kernel/path';
import {
  MAX_COLS, MAX_ROWS, looksLikeText, parseCsv, readDocx, readPptx, readXlsx, type Sheet,
} from '../viewer/formats';
import { emptyModel, planFor, SHEET_ROWS, type FormatPlan, type Grid, type OfficeModel } from './model';
import { writeDocx, writeXlsx } from './ooxml';
import { writePptx } from './pptx';
import { readDocxFormats } from './patch';
import { readOdt } from './writer/odtread';
import { utf8 } from './zip';

export type LoadRefusal = 'legacy' | 'unknown' | 'binary' | 'damaged';

export type LoadResult =
  | { ok: true; plan: FormatPlan; model: OfficeModel; empty: boolean }
  | { ok: false; plan: FormatPlan; refusal: LoadRefusal };

function toGrids(sheets: readonly Sheet[]): Grid[] {
  if (!sheets.length) return [{ name: 'Sheet1', rows: [], truncated: false }];
  return sheets.map((s) => ({ name: s.name, rows: s.rows, truncated: s.truncated }));
}

/** Reads one file into the model, or reports exactly why it cannot be read. */
export async function loadOfficeFile(path: string, bytes: Uint8Array): Promise<LoadResult> {
  const plan = planFor(path);
  if (plan.refusal) return { ok: false, plan, refusal: plan.refusal };
  if (bytes.length === 0) return { ok: true, plan, model: emptyModel(plan, basename(path)), empty: true };

  try {
    switch (plan.kind) {
      case 'docx': {
        // An OpenDocument text file is read by the Writer's own ODF reader, into the same model a
        // Word file produces — so everything the editor can do works on it unchanged.
        if (plan.odf) {
          const read = await readOdt(bytes);
          if (!read.ok) return { ok: false, plan, refusal: 'damaged' };
          return {
            ok: true, plan, empty: false,
            model: {
              kind: 'docx',
              paragraphs: read.document.paragraphs,
              blocks: read.document.blocks,
              ...(Object.keys(read.document.formats).length ? { formats: read.document.formats } : {}),
            },
          };
        }
        const paragraphs = await readDocx(bytes);
        // What the file already says about bold/italic/size/alignment, so the
        // toolbar shows the truth and an untouched property is never rewritten.
        const formats = await readDocxFormats(bytes);
        return {
          ok: true, plan, empty: false,
          model: { kind: 'docx', paragraphs, ...(Object.keys(formats).length ? { formats } : {}) },
        };
      }
      case 'xlsx':
        return {
          ok: true, plan, empty: false,
          // The sheet editor draws only the rows on screen, so it reads a spreadsheet's worth of
          // rows (SHEET_ROWS) instead of the reader's preview-sized default.
          model: { kind: 'xlsx', grids: toGrids(await readXlsx(bytes, { maxRows: SHEET_ROWS })), active: 0, delimiter: ',' },
        };
      case 'pptx':
        return { ok: true, plan, model: { kind: 'pptx', slides: await readPptx(bytes) }, empty: false };
      case 'csv': {
        const rows = parseCsv(new TextDecoder().decode(bytes), plan.delimiter);
        const truncated = rows.length > SHEET_ROWS || rows.some((r) => r.length > MAX_COLS);
        return {
          ok: true, plan, empty: false,
          model: {
            kind: 'csv', active: 0, delimiter: plan.delimiter,
            grids: [{ name: basename(path), rows: rows.slice(0, SHEET_ROWS).map((r) => r.slice(0, MAX_COLS)), truncated }],
          },
        };
      }
      default:
        // A .txt that is not text stays untouched: showing binary as mojibake would
        // invite an edit that destroys the file.
        if (!looksLikeText(bytes)) return { ok: false, plan, refusal: 'binary' };
        return { ok: true, plan, model: { kind: 'text', text: new TextDecoder().decode(bytes) }, empty: false };
    }
  } catch {
    return { ok: false, plan, refusal: 'damaged' };
  }
}

/**
 * One CSV/TSV cell, quoted only when it must be (RFC 4180). CRLF line ends and a
 * final line end match what Excel writes; the reader accepts both.
 */
export function writeDelimited(rows: readonly (readonly string[])[], delimiter: ',' | '\t'): string {
  const cell = (value: string): string =>
    value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')
      ? `"${value.replace(/"/g, '""')}"`
      : value;
  if (!rows.length) return '';
  return `${rows.map((row) => row.map(cell).join(delimiter)).join('\r\n')}\r\n`;
}

/** The bytes to write for a model: real OOXML for Office files, text for the rest. */
export function serializeModel(model: OfficeModel): Uint8Array {
  switch (model.kind) {
    case 'docx': return writeDocx(model.paragraphs, model.formats);
    case 'xlsx': return writeXlsx(model.grids, model.formulas, model.sheetFormats);
    case 'csv': return utf8(writeDelimited(model.grids[0]?.rows ?? [], model.delimiter));
    case 'pptx': return writePptx(model.slides);
    default: return utf8(model.text);
  }
}
