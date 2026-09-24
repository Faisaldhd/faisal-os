/**
 * Office — the small XML helpers the writers share (مساعدات XML).
 *
 * Nothing here parses XML: the readers in `src/apps/viewer/formats.ts` do that.
 * This file only produces text that is safe inside an OOXML part, and the cell /
 * sheet addressing that Excel needs.
 */
import type { ParagraphAlign, ParagraphFormat } from './model';

/**
 * Escapes text for XML content and attribute values.
 *
 * Every user character that means something to an XML parser is replaced, so a
 * cell holding `a<b & "c"` cannot break the part it is written into.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Removes characters XML 1.0 forbids, so a pasted control character cannot make
 * the saved file unreadable. Tab, newline and carriage return are legal and kept;
 * the C0 controls, NUL, the two non-characters and lone surrogates are dropped.
 */
export function sanitizeXmlText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) { out += value[i]; continue; }
    if (code < 0x20 || code === 0xfffe || code === 0xffff) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += value[i] + value[i + 1]; i++; }
      continue; // a lone high surrogate cannot be encoded
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // a lone low surrogate
    out += value[i];
  }
  return out;
}

/** Escapes and sanitizes in one step — what the writers call for user text. */
export function xmlText(value: string): string {
  return escapeXml(sanitizeXmlText(value));
}

/** Column index → letters: 0 → "A", 25 → "Z", 26 → "AA" (the inverse of the reader's `columnIndex`). */
export function columnName(index: number): string {
  let n = Math.floor(index) + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

/** Zero-based row/column → an A1 reference ("A1", "AB12"). */
export function cellName(row: number, col: number): string {
  return `${columnName(col)}${Math.max(0, Math.floor(row)) + 1}`;
}

/**
 * A sheet name Excel accepts: no `\ / ? * [ ] :`, never empty, at most 31
 * characters, and unique inside the workbook. `taken` is the set of names
 * already used; the returned name is not added to it (the caller decides).
 */
export function sheetName(raw: string, index: number, taken: ReadonlySet<string> = new Set()): string {
  let base = (raw ?? '').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) base = `Sheet${index + 1}`;
  let name = base.slice(0, 31);
  if (!name) name = `Sheet${index + 1}`;
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = ` (${n})`;
    candidate = name.slice(0, 31 - suffix.length) + suffix;
  }
  return candidate;
}

/** True when a cell's text is a plain number Excel can store as `<v>` rather than text. */
export function isNumericText(value: string): boolean {
  return /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim()) && value.trim() !== '';
}

/* ──────────────────────── paragraph formatting markup ──────────────────────── */

/**
 * The run properties of a paragraph format, in the order OOXML's schema requires
 * (`b`, `i`, `sz`/`szCs`, `u`). `true` writes the toggle on, `false` writes it off
 * explicitly (`w:val="0"`), which is what beats a style's own value, and `null`
 * removes nothing here — the caller decides about removal.
 */
export function runPropertyChildren(format: ParagraphFormat | null | undefined): string[] {
  if (!format) return [];
  const out: string[] = [];
  if (format.bold === true) out.push('<w:b/>');
  else if (format.bold === false) out.push('<w:b w:val="0"/>');
  if (format.italic === true) out.push('<w:i/>');
  else if (format.italic === false) out.push('<w:i w:val="0"/>');
  if (typeof format.size === 'number') {
    const half = Math.max(2, Math.round(format.size * 2));
    out.push(`<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`);
  }
  if (format.underline === true) out.push('<w:u w:val="single"/>');
  else if (format.underline === false) out.push('<w:u w:val="none"/>');
  return out;
}

/** `<w:rPr>…</w:rPr>` for a paragraph format, or an empty string when it says nothing. */
export function runPropertiesMarkup(format: ParagraphFormat | null | undefined): string {
  const children = runPropertyChildren(format);
  return children.length ? `<w:rPr>${children.join('')}</w:rPr>` : '';
}

/** `justify` is Word's `both`; the other three are written as they are named. */
export function jcValue(align: ParagraphAlign): string {
  return align === 'justify' ? 'both' : align;
}

/** `<w:pPr><w:jc …/></w:pPr>` for the alignment, or an empty string. */
export function paragraphPropertiesMarkup(format: ParagraphFormat | null | undefined): string {
  if (!format || format.align === undefined || format.align === null) return '';
  return `<w:pPr><w:jc w:val="${jcValue(format.align)}"/></w:pPr>`;
}
