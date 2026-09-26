/**
 * Writer — mail merge (دمج المراسلات): a document with `{{حقل}}` fields, a CSV of rows, and one
 * copy per row.
 *
 * The engine is pure: it never touches the DOM or the file system. The window builds the field
 * markers (they must carry `data-skip="1"` and `contentEditable="false"`, exactly like every other
 * visible-but-not-text mark in this editor, or `reconcile()` would read them as part of the
 * paragraph and write them into the document), and this module decides what the copies say and what
 * they are called.
 *
 * What it promises, and what it deliberately does not:
 *   · a field the CSV has no column for is reported, and becomes empty in the copy — never a
 *     literal `{{الاسم}}` left in a letter;
 *   · a row that brings nothing (every matched value empty) is skipped and reported, not turned
 *     into an empty letter;
 *   · values may contain commas, Arabic, quotes or new lines: they are inserted as they are;
 *   · file names are made safe (no path characters, no reserved Windows names) and unique.
 *
 * Deferred, and said out loud: editing a field inside the editor (moving or renaming it once
 * inserted) and syncing the data source with the document are NOT part of this slice.
 */
import { parseCsv } from '../../viewer/formats';

/** The name of the class a field marker carries in the editor (the window's own mark). */
export const FIELD_CLASS = 'fo-marker';
/** The attribute that keeps a marker out of the paragraph's text. */
export const FIELD_SKIP_ATTR = 'data-skip';
/** The field as the document holds it: `{{الاسم}}`. */
export const fieldText = (name: string): string => `{{${name}}}`;

/** `{{ name }}` anywhere in a paragraph, allowing the spaces a person types. */
const FIELD = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** The field names a text carries, in order, once each. */
export function fieldsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FIELD)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The field names a whole document carries, in the order the paragraphs hold them. */
export function fieldsInDocument(paragraphs: readonly string[]): string[] {
  const out: string[] = [];
  for (const paragraph of paragraphs) for (const name of fieldsIn(paragraph)) if (!out.includes(name)) out.push(name);
  return out;
}

export interface MergeSource {
  /** The header row, trimmed ('' when the CSV had none). */
  columns: string[];
  /** The data rows, padded to the header's width so every row has a value per column. */
  rows: string[][];
}

/** Reads a CSV (the app's own reader) into a header and rows; an empty text is an empty source. */
export function parseSource(csv: string, delimiter: ',' | '\t' = ','): MergeSource {
  // A truly blank LINE is not a row; a line that exists as empty cells (",") is a row with nothing
  // in it, and the merge reports it as skipped rather than pretending it was never there.
  const parsed = parseCsv(csv, delimiter).filter((row) => !(row.length === 1 && row[0].trim() === ''));
  if (!parsed.length) return { columns: [], rows: [] };
  const columns = parsed[0].map((c) => c.trim());
  const rows = parsed.slice(1).map((row) => columns.map((_, i) => row[i] ?? ''));
  return { columns, rows };
}

export interface MergeMatch {
  /** The document's fields, in order. */
  fields: string[];
  /** Fields the source has a column for (case-insensitive, trimmed). */
  matched: string[];
  /** Fields with no column at all: they are reported, and become empty in the copies. */
  missing: string[];
  /** Columns no field uses: reported so the owner knows the CSV carries more than the letter needs. */
  unused: string[];
}

const key = (name: string): string => name.trim().toLowerCase();

/** Which of the document's fields the source can fill, and which columns go unused. */
export function matchFields(fields: readonly string[], source: MergeSource): MergeMatch {
  const columns = source.columns.map(key);
  const matched: string[] = [];
  const missing: string[] = [];
  const used = new Set<number>();
  for (const field of fields) {
    const at = columns.indexOf(key(field));
    if (at >= 0) {
      matched.push(field);
      used.add(at);
    } else missing.push(field);
  }
  const unused = source.columns.filter((_, i) => !used.has(i));
  return { fields: [...fields], matched, missing, unused };
}

/** The values one row gives the document's fields (a field with no column becomes empty). */
export function valuesOfRow(fieldNames: readonly string[], source: MergeSource, row: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fieldNames) {
    const at = source.columns.findIndex((c) => key(c) === key(field));
    values[field] = at >= 0 ? (row[at] ?? '') : '';
  }
  return values;
}

/** One paragraph with its fields filled in. A field with no value simply disappears. */
export function fillParagraph(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(FIELD, (_all, raw: string) => values[raw.trim()] ?? '');
}

/** Whether a row brings nothing at all for the fields the document asks for. */
export function rowIsEmpty(fieldNames: readonly string[], source: MergeSource, row: readonly string[]): boolean {
  const values = valuesOfRow(fieldNames, source, row);
  return fieldNames.every((field) => (values[field] ?? '').trim() === '');
}

const SAFE = /[\\/:*?"<>|\u0000-\u001F]/g;
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3']);

/**
 * A file name that is safe on every platform and never repeats: path characters and control
 * characters go, a reserved Windows name is prefixed, the length is capped, and a name already
 * taken gets `-2`, `-3`… (an empty result becomes "نسخة").
 */
export function safeFileName(name: string, taken: ReadonlySet<string> = new Set()): string {
  let base = name.replace(SAFE, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (base.length > 64) base = base.slice(0, 64).trim();
  if (!base) base = 'نسخة';
  if (RESERVED.has(base.toLowerCase())) base = `_${base}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

/**
 * The name of one copy: the pattern with its own fields filled in, then made safe and unique.
 * `{n}` is the row's number (1-based). A pattern that leaves nothing usable falls back to `رسالة n`.
 */
export function buildFileName(pattern: string, values: Readonly<Record<string, string>>, index: number, taken: ReadonlySet<string>): string {
  const filled = pattern.replace(/\{n\}/g, String(index + 1)).replace(FIELD, (_all, raw: string) => values[raw.trim()] ?? '');
  const cleaned = filled.replace(/\{\{[^{}]*\}\}/g, '').trim();
  return safeFileName(cleaned || `رسالة ${index + 1}`, taken);
}

export interface MergeCopy {
  /** The copy's paragraphs, with every field filled in. */
  paragraphs: string[];
  /** The values this row gave (a field with no column is ''). */
  values: Record<string, string>;
  /** The 0-based row of the source this copy came from. */
  row: number;
  /** The file name, without an extension. */
  name: string;
}

export interface MergeResult {
  copies: MergeCopy[];
  /** Rows that produced no copy, with the honest reason. */
  skipped: Array<{ row: number; reason: 'empty' | 'no-source' | 'no-fields' }>;
  match: MergeMatch;
}

/**
 * One copy per row. A row that brings nothing for the document's fields is skipped as `empty`; a
 * document with no fields at all is not a merge (`no-fields`); no rows at all is `no-source`.
 */
export function mergeDocuments(
  paragraphs: readonly string[],
  source: MergeSource,
  opts: { namePattern?: string } = {},
): MergeResult {
  const fields = fieldsInDocument(paragraphs);
  const match = matchFields(fields, source);
  const taken = new Set<string>();
  const copies: MergeCopy[] = [];
  const skipped: MergeResult['skipped'] = [];
  if (!fields.length) return { copies, skipped, match: { ...match, missing: [], unused: source.columns } };
  if (!source.rows.length) return { copies, skipped: [{ row: 0, reason: 'no-source' }], match };
  const pattern = opts.namePattern ?? (fields[0] ? fieldText(fields[0]) : '{n}');
  source.rows.forEach((row, index) => {
    if (rowIsEmpty(fields, source, row)) {
      skipped.push({ row: index, reason: 'empty' });
      return;
    }
    const values = valuesOfRow(fields, source, row);
    const name = buildFileName(pattern, values, index, taken);
    taken.add(name);
    copies.push({ paragraphs: paragraphs.map((p) => fillParagraph(p, values)), values, row: index, name });
  });
  return { copies, skipped, match };
}

/** The sentence the window shows after a merge: what happened, and what did not. */
export function resultMessage(result: MergeResult, labels: { created: (n: number) => string; skipped: (n: number, rows: string) => string; missing: (fields: string) => string }): string {
  const parts = [labels.created(result.copies.length)];
  if (result.skipped.length) parts.push(labels.skipped(result.skipped.length, result.skipped.map((s) => s.row + 1).join('، ')));
  if (result.match.missing.length) parts.push(labels.missing(result.match.missing.join('، ')));
  return parts.join(' · ');
}
