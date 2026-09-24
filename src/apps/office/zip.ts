/**
 * Office — a dependency-free ZIP writer (كاتب ZIP بلا مكتبات).
 *
 * The viewer only *reads* ZIP files (`src/apps/viewer/formats.ts`); saving a Word,
 * Excel or PowerPoint file needs the other direction: OOXML packages are ZIP
 * archives of XML parts, so this file builds one.
 *
 * Deliberate choices, so nothing here is guessed:
 *  • Entries are **stored** (method 0, no compression). Storing needs no
 *    compressor and the viewer's reader already accepts method 0; the price is a
 *    bigger file, which is stated in the app's limits.
 *  • No ZIP64, no encryption, no data descriptors: every part is small and its
 *    size is known before the header is written.
 *  • UTF-8 names and the UTF-8 flag (bit 11) are set, although OOXML part names
 *    are ASCII; the flag keeps the writer honest if a name ever is not.
 *  • A fixed DOS timestamp (1980-01-01) keeps output byte-for-byte reproducible,
 *    which is what the tests assert; OOXML has its own modified-time fields and
 *    the archive timestamp carries no information the user can see.
 */

export interface ZipInput {
  /** Path inside the archive, with '/' separators, e.g. "word/document.xml". */
  name: string;
  data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION = 20; // 2.0 — stored/deflate, the oldest widely supported version
const METHOD_STORE = 0;
const FLAG_UTF8 = 0x0800;
/** 1980-01-01 00:00 — the earliest DOS timestamp, used for reproducible output. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

let crcTable: Uint32Array | null = null;

/** The standard reflected CRC-32 table (polynomial 0xEDB88320), built once. */
function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/** CRC-32 of a byte range, as an unsigned 32-bit number (the ZIP checksum). */
export function crc32(data: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** UTF-8 bytes of a string — the only text encoding OOXML parts may use. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function setU16(view: DataView, at: number, value: number): void {
  view.setUint16(at, value, true);
}
function setU32(view: DataView, at: number, value: number): void {
  view.setUint32(at, value >>> 0, true);
}

/**
 * Builds a ZIP archive holding every entry, in the given order.
 * Throws on a duplicate or empty name: either one would produce an archive whose
 * central directory lies about its contents.
 */
export function writeZip(entries: readonly ZipInput[]): Uint8Array {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.name) throw new Error('zip: entry name is empty');
    if (seen.has(entry.name)) throw new Error(`zip: duplicate entry: ${entry.name}`);
    seen.add(entry.name);
  }

  const encoded = entries.map((e) => ({ name: utf8(e.name), data: e.data, crc: crc32(e.data) }));
  let size = 22; // end-of-central-directory record
  for (const e of encoded) size += 30 + e.name.length + e.data.length + 46 + e.name.length;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;

  const offsets: number[] = [];
  for (const e of encoded) {
    offsets.push(at);
    setU32(view, at, LOCAL_SIG);
    setU16(view, at + 4, VERSION);
    setU16(view, at + 6, FLAG_UTF8);
    setU16(view, at + 8, METHOD_STORE);
    setU16(view, at + 10, DOS_TIME);
    setU16(view, at + 12, DOS_DATE);
    setU32(view, at + 14, e.crc);
    setU32(view, at + 18, e.data.length);
    setU32(view, at + 22, e.data.length);
    setU16(view, at + 26, e.name.length);
    setU16(view, at + 28, 0); // extra field length
    at += 30;
    out.set(e.name, at);
    at += e.name.length;
    out.set(e.data, at);
    at += e.data.length;
  }

  const centralAt = at;
  for (const [i, e] of encoded.entries()) {
    setU32(view, at, CENTRAL_SIG);
    setU16(view, at + 4, VERSION); // version made by
    setU16(view, at + 6, VERSION); // version needed
    setU16(view, at + 8, FLAG_UTF8);
    setU16(view, at + 10, METHOD_STORE);
    setU16(view, at + 12, DOS_TIME);
    setU16(view, at + 14, DOS_DATE);
    setU32(view, at + 16, e.crc);
    setU32(view, at + 20, e.data.length);
    setU32(view, at + 24, e.data.length);
    setU16(view, at + 28, e.name.length);
    setU16(view, at + 30, 0); // extra field length
    setU16(view, at + 32, 0); // comment length
    setU16(view, at + 34, 0); // disk number start
    setU16(view, at + 36, 0); // internal attributes
    setU32(view, at + 38, 0); // external attributes
    setU32(view, at + 42, offsets[i]);
    at += 46;
    out.set(e.name, at);
    at += e.name.length;
  }

  setU32(view, at, EOCD_SIG);
  setU16(view, at + 4, 0); // this disk
  setU16(view, at + 6, 0); // disk with the central directory
  setU16(view, at + 8, encoded.length);
  setU16(view, at + 10, encoded.length);
  setU32(view, at + 12, at - centralAt);
  setU32(view, at + 16, centralAt);
  setU16(view, at + 20, 0); // archive comment length
  at += 22;

  if (at !== size) throw new Error('zip: internal size mismatch');
  return out;
}
