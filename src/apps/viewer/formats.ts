/**
 * File Viewer — the pure part: what kind a file is, and reading the formats the
 * browser cannot show by itself (CSV, Excel .xlsx, Word .docx, PowerPoint .pptx).
 *
 * Office files are ZIP archives of XML. They are opened here with the browser's
 * own DecompressionStream and DOMParser: no library, nothing sent anywhere.
 * Only text is extracted; nothing from a file ever runs.
 */

export type FileKind = 'pdf' | 'sheet' | 'csv' | 'doc' | 'slides' | 'audio' | 'video' | 'image' | 'other';

const KINDS: Record<string, FileKind> = {
  '.pdf': 'pdf',
  '.xlsx': 'sheet', '.xlsm': 'sheet',
  '.csv': 'csv', '.tsv': 'csv',
  '.docx': 'doc',
  '.pptx': 'slides',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.oga': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio', '.opus': 'audio',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.m4v': 'video', '.ogv': 'video',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image', '.avif': 'image', '.ico': 'image',
};

const MIMES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
};

/** Every extension the viewer names in its manifest (it also takes any other file, as "*"). */
export const VIEWER_EXTENSIONS = Object.keys(KINDS).filter((e) => KINDS[e] !== 'image');

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function kindOf(path: string): FileKind {
  return KINDS[extensionOf(path)] ?? 'other';
}

/**
 * The type a blob of this file gets. Unknown files stay application/octet-stream,
 * so a browser downloads them and never renders them (an .html file is never run).
 */
export function mimeOf(path: string): string {
  return MIMES[extensionOf(path)] ?? 'application/octet-stream';
}

/* ───────────────────────────────── text ───────────────────────────────── */

/** True when the start of the file is readable UTF-8 text (no NUL bytes). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    // stream: a multi-byte character cut at the end of the sample is not an error.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** RFC 4180 CSV (quotes, doubled quotes, newlines inside quotes). A leading BOM is dropped. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ───────────────────────────────── zip ───────────────────────────────── */

/** Largest amount one archive may inflate to (guards against zip bombs). */
export const MAX_UNZIPPED = 64 * 1024 * 1024;

export interface ZipEntry { name: string; method: number; offset: number; size: number; compressed: number }

export class ZipError extends Error {}

/** Reads the central directory of a ZIP file (no ZIP64, no encryption). */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new ZipError('damaged zip file');
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, offset, size, compressed });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Response(data.slice()).body!.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new ZipError('file too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** An opened archive: `read` returns one member's bytes, or null when it is missing. */
export interface ZipReader {
  names(): string[];
  read(name: string): Promise<Uint8Array | null>;
}

export function openZip(bytes: Uint8Array): ZipReader {
  const entries = zipEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  let budget = MAX_UNZIPPED;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    names: () => entries.map((e) => e.name),
    async read(name) {
      const e = byName.get(name);
      if (!e) return null;
      if (e.offset + 30 > bytes.length || view.getUint32(e.offset, true) !== 0x04034b50) throw new ZipError('damaged zip file');
      const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
      const raw = bytes.subarray(start, start + e.compressed);
      let data: Uint8Array;
      if (e.method === 0) data = raw.slice();
      else if (e.method === 8) data = await inflateRaw(raw, budget);
      else throw new ZipError('unsupported compression');
      budget -= data.length;
      if (budget < 0) throw new ZipError('file too large');
      return data;
    },
  };
}

async function readXml(zip: ZipReader, name: string): Promise<Document | null> {
  const data = await zip.read(name);
  if (!data) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

/** Elements by local name, whatever namespace prefix the file uses. */
const byTag = (root: Document | Element, tag: string): Element[] => [...root.getElementsByTagNameNS('*', tag)];

/* ──────────────────────────────── Excel ──────────────────────────────── */

export const MAX_ROWS = 2000;
export const MAX_COLS = 100;

export interface Sheet { name: string; rows: string[][]; truncated: boolean }

/** "C12" → 2 (zero-based column). */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Normalizes a relationship target ("worksheets/sheet1.xml" or "/xl/worksheets/sheet1.xml") to a zip path. */
function resolveTarget(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function relationships(zip: ZipReader, relsPath: string, base: string): Promise<Map<string, string>> {
  const rels = new Map<string, string>();
  const doc = await readXml(zip, relsPath);
  if (!doc) return rels;
  for (const r of byTag(doc, 'Relationship')) {
    const id = r.getAttribute('Id');
    const target = r.getAttribute('Target');
    if (id && target) rels.set(id, resolveTarget(base, target));
  }
  return rels;
}

/** Reads every worksheet of an .xlsx file as plain text cells (values, not formulas). */
export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const zip = openZip(bytes);
  const workbook = await readXml(zip, 'xl/workbook.xml');
  if (!workbook) throw new ZipError('not an Excel workbook');
  const rels = await relationships(zip, 'xl/_rels/workbook.xml.rels', 'xl');

  const shared: string[] = [];
  const sst = await readXml(zip, 'xl/sharedStrings.xml');
  if (sst) {
    for (const si of byTag(sst, 'si')) {
      // Phonetic runs (rPh) are reading aids, not part of the cell text.
      shared.push(byTag(si, 't').filter((t) => t.parentElement?.localName !== 'rPh').map((t) => t.textContent ?? '').join(''));
    }
  }

  const sheets: Sheet[] = [];
  const declared = byTag(workbook, 'sheet');
  for (const [i, s] of declared.entries()) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? s.getAttribute('r:id');
    const path = (rid && rels.get(rid)) || `xl/worksheets/sheet${i + 1}.xml`;
    const doc = await readXml(zip, path);
    if (!doc) continue;
    const rows: string[][] = [];
    let truncated = false;
    for (const row of byTag(doc, 'row')) {
      const r = Number(row.getAttribute('r')) - 1;
      const at = Number.isInteger(r) && r >= 0 ? r : rows.length;
      if (at >= MAX_ROWS) { truncated = true; break; }
      const cells: string[] = [];
      let next = 0;
      for (const c of byTag(row, 'c')) {
        const ref = c.getAttribute('r');
        const col = ref ? columnIndex(ref) : next;
        next = col + 1;
        if (col >= MAX_COLS) { truncated = true; continue; }
        const type = c.getAttribute('t');
        const v = byTag(c, 'v')[0]?.textContent ?? '';
        let text: string;
        if (type === 's') text = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') text = byTag(c, 't').map((t) => t.textContent ?? '').join('');
        else if (type === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
        else text = v;
        while (cells.length < col) cells.push('');
        cells[col] = text;
      }
      while (rows.length < at) rows.push([]);
      rows[at] = cells;
    }
    sheets.push({ name: s.getAttribute('name') ?? `Sheet${i + 1}`, rows, truncated });
  }
  return sheets;
}

/* ──────────────────────────────── Word ──────────────────────────────── */

function paragraphText(p: Element): string {
  let out = '';
  const walk = (el: Element) => {
    for (const child of el.children) {
      const tag = child.localName;
      if (tag === 't') out += child.textContent ?? '';
      else if (tag === 'tab') out += '\t';
      else if (tag === 'br' || tag === 'cr') out += '\n';
      else if (tag === 'p') continue; // a nested paragraph (text box) is listed on its own
      else walk(child);
    }
  };
  walk(p);
  return out;
}

/** Paragraphs, minus the copies Office keeps for old readers (mc:Fallback repeats mc:Choice). */
function paragraphs(root: Document): Element[] {
  const inFallback = (el: Element) => {
    for (let a = el.parentElement; a; a = a.parentElement) if (a.localName === 'Fallback') return true;
    return false;
  };
  return byTag(root, 'p').filter((p) => !inFallback(p));
}

/** The paragraphs of a .docx document, in order (empty paragraphs kept as ''). */
export async function readDocx(bytes: Uint8Array): Promise<string[]> {
  const zip = openZip(bytes);
  const doc = await readXml(zip, 'word/document.xml');
  if (!doc) throw new ZipError('not a Word document');
  return paragraphs(doc).map(paragraphText);
}

/* ────────────────────────────── PowerPoint ────────────────────────────── */

/** The text of each slide of a .pptx file (one array of paragraphs per slide). */
export async function readPptx(bytes: Uint8Array): Promise<string[][]> {
  const zip = openZip(bytes);
  const slideNo = (n: string) => Number(/slide(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const names = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
  if (!names.length) throw new ZipError('not a PowerPoint presentation');
  const slides: string[][] = [];
  for (const name of names) {
    const doc = await readXml(zip, name);
    slides.push(doc ? paragraphs(doc).map(paragraphText).filter((s) => s.trim()) : []);
  }
  return slides;
}
