/**
 * Office — a dependency-free ZIP reader and writer (قارئ وكاتب ZIP بلا مكتبات).
 *
 * The viewer only *reads* ZIP files (`src/apps/viewer/formats.ts`); saving a Word,
 * Excel or PowerPoint file needs the other direction: OOXML packages are ZIP
 * archives of XML parts, so this file builds one.
 *
 * There are two writers, deliberately:
 *  • `writeZip` builds a fresh archive and **stores** every entry (method 0, no
 *    compression). Storing needs no compressor and the viewer's reader already
 *    accepts method 0; the price is a bigger file, which the app's limits state.
 *  • `rebuildZip` is the surgical one: it takes an archive read by `readRawZip`,
 *    copies every entry it is not given byte-for-byte — local header, name, extra
 *    fields, compressed data and data descriptor included — and recompresses only
 *    the parts in the replacement map with deflate. That is what keeps an edited
 *    Word file's styles, images and headers alive.
 *
 * Deliberate choices, so nothing here is guessed:
 *  • No ZIP64, no encryption: `readRawZip` refuses those rather than guess.
 *  • UTF-8 names and the UTF-8 flag (bit 11) are set, although OOXML part names
 *    are ASCII; the flag keeps the writer honest if a name ever is not.
 *  • A fixed DOS timestamp (1980-01-01) keeps `writeZip` output byte-for-byte
 *    reproducible, which is what the tests assert; OOXML has its own
 *    modified-time fields and the archive timestamp carries nothing the user sees.
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

/* ─────────────────── reading an archive back, and patching it ─────────────────── */

const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;

/**
 * One entry of an existing archive, with everything needed to copy it out
 * untouched. The central directory is the source of truth for the values; the
 * local header is only located, never rewritten, unless the entry is replaced.
 */
export interface RawZipEntry {
  name: string;
  /** The name exactly as stored, so a rebuilt archive keeps its original bytes. */
  nameBytes: Uint8Array;
  method: number;
  flags: number;
  crc: number;
  /** Compressed size, as the central directory states it. */
  compressed: number;
  /** Uncompressed size. */
  size: number;
  localOffset: number;
  time: number;
  date: number;
  versionMadeBy: number;
  versionNeeded: number;
  diskStart: number;
  internalAttrs: number;
  externalAttrs: number;
  extra: Uint8Array;
  comment: Uint8Array;
  /** The whole local record: header + name + extra + data (+ data descriptor). */
  recordStart: number;
  recordEnd: number;
}

export interface RawZip {
  bytes: Uint8Array;
  entries: readonly RawZipEntry[];
  /** Where the central directory starts — the end of the last local record. */
  centralAt: number;
}

/**
 * Reads an archive's directory without decompressing anything.
 *
 * Refuses (throws) anything this writer cannot faithfully copy: a ZIP64 archive,
 * a multi-disk one, or one whose local records are not where the directory says.
 * The caller turns a refusal into the rebuild fallback, never into a guess.
 */
export function readRawZip(bytes: Uint8Array): RawZip {
  if (bytes.length < 22) throw new Error('zip: not a zip file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const first = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= first; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: not a zip file');
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 8, true);
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const centralAt = view.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0 || count !== total) throw new Error('zip: multi-disk archive');
  if (count === 0xffff || cdSize === 0xffffffff || centralAt === 0xffffffff) throw new Error('zip: ZIP64 archive');
  if (centralAt + cdSize > bytes.length) throw new Error('zip: central directory past the end of the file');

  const entries: RawZipEntry[] = [];
  let p = centralAt;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL_SIG) throw new Error('zip: damaged central directory');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (p + 46 + nameLen + extraLen + commentLen > bytes.length) throw new Error('zip: damaged central directory');
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      nameBytes: bytes.subarray(p + 46, p + 46 + nameLen),
      versionMadeBy: view.getUint16(p + 4, true),
      versionNeeded: view.getUint16(p + 6, true),
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      time: view.getUint16(p + 12, true),
      date: view.getUint16(p + 14, true),
      crc: view.getUint32(p + 16, true),
      compressed: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      diskStart: view.getUint16(p + 34, true),
      internalAttrs: view.getUint16(p + 36, true),
      externalAttrs: view.getUint32(p + 38, true),
      localOffset: view.getUint32(p + 42, true),
      extra: bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen),
      comment: bytes.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen),
      recordStart: 0,
      recordEnd: 0,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // A local record runs up to the next one in file order (or to the directory).
  // That length is what gets copied verbatim, so a data descriptor or an unknown
  // extra field travels with its entry instead of being re-derived.
  const order = entries.map((_, i) => i).sort((a, b) => entries[a].localOffset - entries[b].localOffset);
  for (const [k, index] of order.entries()) {
    const entry = entries[index];
    const next = k + 1 < order.length ? entries[order[k + 1]].localOffset : centralAt;
    entry.recordStart = entry.localOffset;
    entry.recordEnd = next;
    if (entry.localOffset + 30 > bytes.length || view.getUint32(entry.localOffset, true) !== LOCAL_SIG) {
      throw new Error(`zip: ${entry.name} has no local header`);
    }
    const nameLen = view.getUint16(entry.localOffset + 26, true);
    const extraLen = view.getUint16(entry.localOffset + 28, true);
    if (entry.localOffset + 30 + nameLen + extraLen + entry.compressed > entry.recordEnd) {
      throw new Error(`zip: ${entry.name} is not where the directory says`);
    }
  }
  return { bytes, entries, centralAt };
}

/** Inflates one deflate-raw stream with the browser's own decompressor. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('zip: no inflate support here');
  const stream = new Response(data.slice()).body!.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Deflates one buffer with the browser's own compressor (method 8). */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') throw new Error('zip: no deflate support here');
  const stream = new Response(data.slice()).body!.pipeThrough(new CompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** One entry's plain bytes, or null when the archive has no such entry. */
export async function entryData(archive: RawZip, name: string): Promise<Uint8Array | null> {
  const entry = archive.entries.find((e) => e.name === name);
  if (!entry) return null;
  const view = new DataView(archive.bytes.buffer, archive.bytes.byteOffset, archive.bytes.byteLength);
  const nameLen = view.getUint16(entry.localOffset + 26, true);
  const extraLen = view.getUint16(entry.localOffset + 28, true);
  const at = entry.localOffset + 30 + nameLen + extraLen;
  const raw = archive.bytes.subarray(at, at + entry.compressed);
  if (entry.flags & FLAG_ENCRYPTED) throw new Error(`zip: ${entry.name} is encrypted`);
  if (entry.method === METHOD_STORE) return raw.slice();
  if (entry.method === METHOD_DEFLATE) return inflateRaw(raw);
  throw new Error(`zip: ${entry.name} uses compression method ${entry.method}`);
}

/**
 * Rebuilds an archive with the given parts replaced and **everything else copied
 * byte-for-byte**: the untouched entries keep their local header, name, extra
 * field, data descriptor and compressed bytes exactly as they were, and their
 * compression method and flags are carried into the new central directory. Only a
 * replaced part is recompressed (deflate), and its data descriptor is dropped
 * because its sizes are known before its header is written.
 */
export async function rebuildZip(archive: RawZip, replacements: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
  for (const name of replacements.keys()) {
    if (!archive.entries.some((e) => e.name === name)) throw new Error(`zip: no such entry to replace: ${name}`);
  }

  interface Written { entry: RawZipEntry; replaced: boolean; method: number; flags: number; crc: number; compressed: number; size: number }
  const locals: Uint8Array[] = [];
  const written: Written[] = [];
  const offsets: number[] = [];
  let at = 0;

  for (const entry of archive.entries) {
    offsets.push(at);
    const replacement = replacements.get(entry.name);
    if (!replacement) {
      const copy = archive.bytes.slice(entry.recordStart, entry.recordEnd);
      locals.push(copy);
      written.push({ entry, replaced: false, method: entry.method, flags: entry.flags, crc: entry.crc, compressed: entry.compressed, size: entry.size });
      at += copy.length;
      continue;
    }
    const deflated = await deflateRaw(replacement);
    const flags = (entry.flags | FLAG_UTF8) & ~FLAG_DESCRIPTOR;
    const local = new Uint8Array(30 + entry.nameBytes.length + deflated.length);
    const view = new DataView(local.buffer);
    setU32(view, 0, LOCAL_SIG);
    setU16(view, 4, VERSION);
    setU16(view, 6, flags);
    setU16(view, 8, METHOD_DEFLATE);
    setU16(view, 10, entry.time);
    setU16(view, 12, entry.date);
    setU32(view, 14, crc32(replacement));
    setU32(view, 18, deflated.length);
    setU32(view, 22, replacement.length);
    setU16(view, 26, entry.nameBytes.length);
    setU16(view, 28, 0); // extra field length
    local.set(entry.nameBytes, 30);
    local.set(deflated, 30 + entry.nameBytes.length);
    locals.push(local);
    written.push({ entry, replaced: true, method: METHOD_DEFLATE, flags, crc: crc32(replacement), compressed: deflated.length, size: replacement.length });
    at += local.length;
  }

  const centralAt = at;
  let size = centralAt + 22;
  for (const w of written) size += 46 + w.entry.nameBytes.length + w.entry.extra.length + w.entry.comment.length;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let cursor = 0;
  for (const local of locals) { out.set(local, cursor); cursor += local.length; }

  let p = centralAt;
  for (const [i, w] of written.entries()) {
    const e = w.entry;
    setU32(view, p, CENTRAL_SIG);
    setU16(view, p + 4, e.versionMadeBy);
    setU16(view, p + 6, w.replaced ? Math.max(e.versionNeeded, VERSION) : e.versionNeeded);
    setU16(view, p + 8, w.flags);
    setU16(view, p + 10, w.method);
    setU16(view, p + 12, e.time);
    setU16(view, p + 14, e.date);
    setU32(view, p + 16, w.crc);
    setU32(view, p + 20, w.compressed);
    setU32(view, p + 24, w.size);
    setU16(view, p + 28, e.nameBytes.length);
    setU16(view, p + 30, e.extra.length);
    setU16(view, p + 32, e.comment.length);
    setU16(view, p + 34, e.diskStart);
    setU16(view, p + 36, e.internalAttrs);
    setU32(view, p + 38, e.externalAttrs);
    setU32(view, p + 42, offsets[i]);
    p += 46;
    out.set(e.nameBytes, p);
    p += e.nameBytes.length;
    out.set(e.extra, p);
    p += e.extra.length;
    out.set(e.comment, p);
    p += e.comment.length;
  }

  setU32(view, p, EOCD_SIG);
  setU16(view, p + 4, 0); // this disk
  setU16(view, p + 6, 0); // disk with the central directory
  setU16(view, p + 8, written.length);
  setU16(view, p + 10, written.length);
  setU32(view, p + 12, p - centralAt);
  setU32(view, p + 16, centralAt);
  setU16(view, p + 20, 0); // archive comment length
  p += 22;

  if (p !== size) throw new Error('zip: internal size mismatch');
  return out;
}
