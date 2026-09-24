/**
 * Office — «حفظ باسم»: what each document type can honestly be written as, and the bytes.
 *
 * The dialog itself is the shell's (`src/shell/save-as.ts`) — one surface for the whole suite.
 * This file only answers "what can this model become?", so the answer is testable without a DOM
 * and the UI cannot offer a format no writer here can produce (a `.xlsx` is never offered as
 * `.docx`, and a `.pptx` is never offered as a spreadsheet).
 */
import { serializeModel, writeDelimited } from './file';
import { utf8 } from './zip';
import type { OfficeModel } from './model';

export type SaveFormatId = 'docx' | 'xlsx' | 'pptx' | 'csv' | 'md' | 'txt';

export interface SaveFormatChoice {
  value: SaveFormatId;
  /** Extension without the dot. */
  ext: string;
  mime: string;
  /** An `office.*` string key; the caller resolves it, so this module stays DOM-free. */
  labelKey: string;
}

const INFO: Record<SaveFormatId, { ext: string; mime: string; labelKey: string }> = {
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', labelKey: 'office.formatDocx' },
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', labelKey: 'office.formatXlsx' },
  pptx: { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', labelKey: 'office.formatPptx' },
  csv: { ext: 'csv', mime: 'text/csv', labelKey: 'office.formatCsv' },
  md: { ext: 'md', mime: 'text/markdown', labelKey: 'office.formatMd' },
  txt: { ext: 'txt', mime: 'text/plain', labelKey: 'office.formatTxt' },
};

const choice = (id: SaveFormatId): SaveFormatChoice => ({ value: id, ...INFO[id] });

/**
 * The formats this model can be written as, with the one matching the file it came from FIRST
 * (so "Save as" on a `.md` keeps `.md` unless the owner picks otherwise).
 */
export function saveFormatChoices(model: OfficeModel, currentExt = ''): SaveFormatChoice[] {
  const ext = currentExt.replace(/^\./, '').toLowerCase();
  const order = <T extends SaveFormatChoice>(list: T[]): T[] =>
    [...list].sort((a, b) => Number(b.ext === ext) - Number(a.ext === ext));
  switch (model.kind) {
    case 'docx': return order([choice('docx'), choice('txt')]);
    case 'xlsx':
    case 'csv': return order([choice('xlsx'), choice('csv')]);
    case 'pptx': return [choice('pptx')];
    default: return order([choice('txt'), choice('md')]);
  }
}

/** The format the dialog opens on: the first choice, which is the file's own kind. */
export function defaultSaveFormat(model: OfficeModel, currentExt = ''): SaveFormatId {
  return saveFormatChoices(model, currentExt)[0].value;
}

/** The plain-text rendering of a document, used by the `.txt` / `.md` choices. */
export function textOf(model: OfficeModel): string {
  switch (model.kind) {
    case 'docx': return model.paragraphs.join('\n\n');
    case 'pptx': return model.slides.map((slide) => slide.join('\n')).join('\n\n---\n\n');
    case 'text': return model.text;
    default: return writeDelimited(model.grids[model.active]?.rows ?? [], ',');
  }
}

/**
 * The bytes for one format. A pair no writer here can produce throws instead of writing a file
 * with the wrong content — the dialog reports the message and writes nothing.
 */
export function serializeAs(model: OfficeModel, format: SaveFormatId): Uint8Array {
  switch (format) {
    case 'docx':
      if (model.kind !== 'docx') throw new Error(`office: cannot write a ${model.kind} file as .docx`);
      return serializeModel(model);
    case 'xlsx':
      if (model.kind !== 'xlsx' && model.kind !== 'csv') throw new Error(`office: cannot write a ${model.kind} file as .xlsx`);
      return serializeModel({ ...model, kind: 'xlsx' });
    case 'csv':
      if (model.kind !== 'xlsx' && model.kind !== 'csv') throw new Error(`office: cannot write a ${model.kind} file as .csv`);
      return serializeModel({ ...model, kind: 'csv', delimiter: ',' });
    case 'pptx':
      if (model.kind !== 'pptx') throw new Error(`office: cannot write a ${model.kind} file as .pptx`);
      return serializeModel(model);
    default:
      return utf8(textOf(model));
  }
}
