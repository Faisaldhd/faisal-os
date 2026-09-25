/**
 * PDF encryption — the Standard Security Handler (تشفير PDF بكلمة سر).
 *
 * pdf-lib cannot encrypt (its core has no `encrypt` anywhere) and no encryption library may be
 * added, so this module IS the encryption: a small, self-contained implementation of the one
 * scheme every reader understands, written after ISO 32000-1 §7.6.3 —
 *
 *   • **V 4 · R 4 · AESV2 (AES-128-CBC) · Length 128** — the classic Standard Security Handler
 *     with the AESV2 crypt filter, which Acrobat, Chrome/PDFium and pdf.js all implement;
 *   • MD5 is implemented here (RFC 1321) because WebCrypto deliberately has no MD5 and the key
 *     derivation needs it; RC4 is implemented here because WebCrypto has no RC4 and the scheme
 *     needs it for `/O` and `/U` only. **Every byte of document data is AES-128-CBC through
 *     WebCrypto**, which also supplies the PKCS#7 padding;
 *   • a fresh random 16-byte IV is prefixed to each encrypted string and stream — that prefix is
 *     what "AESV2" means, and it is what pdf.js reads back.
 *
 * What is encrypted (§7.6.3.7): every string and every stream of the body, except the two the
 * specification excludes — the `/Encrypt` dictionary itself and `/ID`. Metadata is always
 * encrypted here (`EncryptMetadata` is true), so the metadata exception never applies.
 *
 * The input is first normalised through pdf-lib (`useObjectStreams: false`), which is the same
 * canonical shape the engine already writes: `%PDF-1.7`, a classic `xref` table, uncompressed
 * indirect objects. That is what makes a byte-level pass possible. The pass then RE-PARSES what it
 * produced, re-derives the key from the password the owner typed, checks `/U` against the file,
 * repeats the check through the OWNER password, and decrypts samples (one stream, a few strings)
 * back to the plain document. Any mismatch throws — a half-written or wrongly-keyed file can never
 * be reported as saved.
 *
 * Honest limits (also on screen in the app): PDF permissions are **advisory** — a reader may
 * ignore `/P` and some do — and R4 with AES-128 is a 1990s scheme that stops a casual reader, not
 * a determined attacker with a weak password. There is no digital signature anywhere in this file.
 */
import { PDFDocument } from 'pdf-lib';
import { EngineRefusal } from './common';

/* ─────────────────────────────── MD5 (RFC 1321) ─────────────────────────────── */

/** Per-round left-rotation amounts (RFC 1321 §3.4). */
const MD5_SHIFT = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

/** K[i] = floor(2^32 × abs(sin(i + 1))) — the RFC 1321 table, computed the way the RFC defines it. */
const MD5_K = ((): Uint32Array => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  return k;
})();

const rotl32 = (value: number, by: number): number => ((value << by) | (value >>> (32 - by))) >>> 0;

/** MD5 of any byte string, 16 bytes. The test pins every published RFC 1321 vector. */
export function md5(input: Uint8Array): Uint8Array {
  const bitLengthLow = (input.length << 3) >>> 0;
  const bitLengthHigh = Math.floor(input.length / 536870912);
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  view.setUint32(padded.length - 8, bitLengthLow, true);
  view.setUint32(padded.length - 4, bitLengthHigh, true);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const carried = d;
      d = c;
      c = b;
      b = (b + rotl32((a + f + MD5_K[i] + view.getUint32(chunk + g * 4, true)) >>> 0, MD5_SHIFT[i])) >>> 0;
      a = carried;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const tail = new DataView(out.buffer);
  tail.setUint32(0, h0, true);
  tail.setUint32(4, h1, true);
  tail.setUint32(8, h2, true);
  tail.setUint32(12, h3, true);
  return out;
}

/* ────────────────────────────── RC4 (only for /O and /U) ────────────────────────────── */

/** RC4 — symmetric, so the same call encrypts and decrypts. Used only for `/O` and `/U`. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (!key.length) throw new EngineRefusal('unknown', 'RC4 needs a key');
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const swap = s[i];
    s[i] = s[j];
    s[j] = swap;
  }
  const out = new Uint8Array(data.length);
  for (let i = 0, a = 0, b = 0; i < data.length; i++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    const swap = s[a];
    s[a] = s[b];
    s[b] = swap;
    out[i] = data[i] ^ s[(s[a] + s[b]) & 0xff];
  }
  return out;
}

/* ──────────────────────── padding, keys and the two entries ──────────────────────── */

/** The 32-byte padding string of ISO 32000-1 §7.6.3.3. */
export const PAD_BYTES = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** R4 truncates longer passwords at 32 bytes, so a longer one is refused rather than weakened. */
export const PASSWORD_MAX_BYTES = 32;

/**
 * The password as the algorithm reads it: one byte per UTF-16 code unit (§7.6.3.3) — the same
 * conversion pdf.js makes (`charCodeAt(i) & 0xff`) and the same one PDFDocEncoding gives over the
 * ASCII range. Only that range is identical in every reader (Arabic letters are not in
 * PDFDocEncoding at all), so the UI accepts printable ASCII only and `protectionProblem` refuses
 * anything else instead of writing a file that opens "nowhere".
 */
export function passwordBytes(password: string): Uint8Array {
  const out = new Uint8Array(Math.min(password.length, PASSWORD_MAX_BYTES));
  for (let i = 0; i < out.length; i++) out[i] = password.charCodeAt(i) & 0xff;
  return out;
}

/** Pad or truncate to the algorithm's 32 bytes (step (a) of Algorithms 2, 3 and 4). */
export function padPassword(password: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  out.set(password.subarray(0, 32));
  if (password.length < 32) out.set(PAD_BYTES.subarray(0, 32 - password.length), password.length);
  return out;
}

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const xorKey = (key: Uint8Array, round: number): Uint8Array => {
  const out = new Uint8Array(key.length);
  for (let i = 0; i < key.length; i++) out[i] = key[i] ^ round;
  return out;
};

/**
 * Algorithm 3: the value of `/O`, built from the OWNER password (or from the user password when
 * there is none) around the padded user password, so that the owner password opens the document
 * and yields the user password — which is what makes owner rights work in a real reader.
 */
export function computeOwnerEntry(ownerPassword: Uint8Array, userPassword: Uint8Array): Uint8Array {
  let hash = md5(padPassword(ownerPassword));
  for (let i = 0; i < 50; i++) hash = md5(hash);
  const key = hash.subarray(0, 16);
  let out = rc4(key, padPassword(userPassword));
  for (let round = 1; round <= 19; round++) out = rc4(xorKey(key, round), out);
  return out;
}

/**
 * Algorithm 2: the 16-byte file key from the USER password, `/O` (32 bytes), `/P` (4 bytes
 * little-endian) and the first element of `/ID`, with the 50 extra MD5 rounds of R ≥ 3. The
 * `EncryptMetadata` flag only enters the hash when it is false.
 */
export function deriveFileKey(
  userPassword: Uint8Array,
  ownerEntry: Uint8Array,
  permissions: number,
  id0: Uint8Array,
  encryptMetadata = true,
): Uint8Array {
  const flagBytes = new Uint8Array([
    permissions & 0xff,
    (permissions >> 8) & 0xff,
    (permissions >> 16) & 0xff,
    (permissions >>> 24) & 0xff,
  ]);
  const metadataBytes = encryptMetadata ? new Uint8Array(0) : new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  let hash = md5(concatBytes(padPassword(userPassword), ownerEntry, flagBytes, id0, metadataBytes));
  for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, 16));
  return hash.subarray(0, 16);
}

/**
 * Algorithm 4: the value of `/U` for R = 4 — `MD5(padding + ID[0])` through RC4 with the file key,
 * then 19 rounds with round-derived keys, then 16 bytes of padding. A reader accepts a password
 * when those first 16 bytes match, which is exactly what the self-check tests.
 */
export function computeUserEntry(fileKey: Uint8Array, id0: Uint8Array): Uint8Array {
  let out = rc4(fileKey, md5(concatBytes(PAD_BYTES, id0)));
  for (let round = 1; round <= 19; round++) out = rc4(xorKey(fileKey, round), out);
  return concatBytes(out, new Uint8Array(16));
}

/**
 * Algorithm 1: the per-object key of AESV2 — `MD5(fileKey + num(3B LE) + gen(2B LE) + "sAlT")`,
 * first 16 bytes. The `sAlT` suffix is what tells the reader the object is AES rather than RC4.
 */
export function objectKey(fileKey: Uint8Array, num: number, gen: number): Uint8Array {
  const index = new Uint8Array([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
  return md5(concatBytes(fileKey, index, new Uint8Array([0x73, 0x41, 0x6c, 0x54]))).subarray(0, 16);
}

/* ──────────────────────────────── permissions (/P) ──────────────────────────────── */

/**
 * The eight permission bits of Table 22 that an owner can decide. Bits 1-2 are always 0, bits 7-8
 * are always 1 and bits 13-32 are always 1 — those are reserved, not the owner's choice.
 */
export interface PdfPermissions {
  print: boolean;
  printHighQuality: boolean;
  modify: boolean;
  assemble: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  accessibility: boolean;
}

/** The four choices the save dialog shows; the other four bits follow from them. */
export interface PermissionChoice {
  print: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
}

/** `0xFFFFF0C0` — reserved bits only: 7-8 and 13-32 set, 1-2 clear, no permission bit set. */
export const PERMISSION_BASE = 0xfffff0c0;

/**
 * The four visible choices expanded to the eight bits: high-quality printing follows printing,
 * assembling pages follows modifying content, filling a form follows annotating, and extracting
 * for accessibility is always allowed — blocking it locks out screen readers, which is not what
 * "do not let anyone copy" means.
 */
export function permissionsForChoice(choice: PermissionChoice): PdfPermissions {
  return {
    print: choice.print,
    printHighQuality: choice.print,
    modify: choice.modify,
    assemble: choice.modify,
    copy: choice.copy,
    annotate: choice.annotate,
    fillForms: choice.annotate,
    accessibility: true,
  };
}

/** Every permission allowed — the "no restrictions" set, used by the tests and the dialog default. */
export const ALL_PERMISSIONS: PdfPermissions = permissionsForChoice({ print: true, copy: true, modify: true, annotate: true });

/** The `/P` value: the reserved bits plus every allowed permission bit (Table 22). */
export function permissionBits(permissions: PdfPermissions): number {
  let bits = PERMISSION_BASE;
  if (permissions.print) bits |= 0x0004;
  if (permissions.modify) bits |= 0x0008;
  if (permissions.copy) bits |= 0x0010;
  if (permissions.annotate) bits |= 0x0020;
  if (permissions.fillForms) bits |= 0x0100;
  if (permissions.accessibility) bits |= 0x0200;
  if (permissions.assemble) bits |= 0x0400;
  if (permissions.printHighQuality) bits |= 0x0800;
  return bits >>> 0;
}

/* ─────────────────────────────── the owner's choice ─────────────────────────────── */

export interface PdfProtection {
  /** The password that opens the document (required: this app never writes a freely-opening file). */
  userPassword: string;
  /** The password that opens it with full rights; empty means "the same as the user password". */
  ownerPassword: string;
  permissions: PdfPermissions;
}

export type ProtectionProblem = 'noUserPassword' | 'notAscii' | 'tooLong' | 'samePassword';

/**
 * Why this protection cannot be written, or null when it can. `samePassword` is refused because a
 * document whose owner password equals its user password protects nothing — whoever opens it can
 * also change its permissions — and promising otherwise on screen would be a lie. A password
 * outside printable ASCII is refused because PDFDocEncoding does not carry those characters, so
 * another reader could compute different key bytes and refuse a correct password.
 */
export function protectionProblem(protection: PdfProtection): ProtectionProblem | null {
  const user = protection.userPassword;
  const owner = protection.ownerPassword || protection.userPassword;
  if (!user) return 'noUserPassword';
  if (user.length > PASSWORD_MAX_BYTES || owner.length > PASSWORD_MAX_BYTES) return 'tooLong';
  if (!/^[\x20-\x7e]+$/.test(user) || !/^[\x20-\x7e]+$/.test(owner)) return 'notAscii';
  if (user === owner) return 'samePassword';
  return null;
}

/* ────────────────────────────────── AES-128-CBC ────────────────────────────────── */

const webCrypto = (): Crypto => {
  const api = (globalThis as { crypto?: Crypto }).crypto;
  if (!api?.subtle) throw new EngineRefusal('unknown', 'this environment has no WebCrypto (AES-128 needs it)');
  return api;
};

const aesKey = async (key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> =>
  webCrypto().subtle.importKey('raw', key.slice(), { name: 'AES-CBC' }, false, [usage]);

/** AES-128-CBC with a fresh random IV in front — one AESV2 payload (string or stream). */
export async function aesEncrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(16);
  webCrypto().getRandomValues(iv);
  const cipher = new Uint8Array(await webCrypto().subtle.encrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'encrypt'), data.slice()));
  return concatBytes(iv, cipher);
}

/** The inverse, used by the self-check (WebCrypto strips the PKCS#7 padding itself). */
export async function aesDecrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 32 || data.length % 16 !== 0) {
    throw new EngineRefusal('unknown', 'an AESV2 block is not a whole number of 16-byte blocks');
  }
  const plain = await webCrypto().subtle.decrypt(
    { name: 'AES-CBC', iv: data.subarray(0, 16).slice() },
    await aesKey(key, 'decrypt'),
    data.subarray(16).slice(),
  );
  return new Uint8Array(plain);
}

/* ────────────────────────── scanning the canonical PDF ────────────────────────── */

const isPdfWhitespace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;

const isDelimiter = (byte: number): boolean =>
  byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b || byte === 0x5d
  || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;

const latin1 = (bytes: Uint8Array, start: number, end: number): string =>
  new TextDecoder('latin1').decode(bytes.subarray(start, end));

function matchesAt(bytes: Uint8Array, at: number, word: string): boolean {
  if (at < 0 || at + word.length > bytes.length) return false;
  for (let i = 0; i < word.length; i++) if (bytes[at + i] !== word.charCodeAt(i)) return false;
  return true;
}

function findLast(bytes: Uint8Array, word: string): number {
  for (let i = bytes.length - word.length; i >= 0; i--) if (matchesAt(bytes, i, word)) return i;
  return -1;
}

/** Whitespace and `%` comments. */
function skipSpace(bytes: Uint8Array, from: number): number {
  let i = from;
  for (;;) {
    while (i < bytes.length && isPdfWhitespace(bytes[i])) i++;
    if (i < bytes.length && bytes[i] === 0x25) {
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    return i;
  }
}

function readInteger(bytes: Uint8Array, from: number): { value: number; end: number } | null {
  let i = skipSpace(bytes, from);
  let sign = 1;
  if (bytes[i] === 0x2b || bytes[i] === 0x2d) {
    if (bytes[i] === 0x2d) sign = -1;
    i++;
  }
  const start = i;
  while (i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
  if (i === start) return null;
  return { value: sign * Number(latin1(bytes, start, i)), end: i };
}

interface StringSpan { start: number; end: number; literal: boolean }
interface DictEntry { start: number; end: number; text: string }

interface ScanResult {
  /** Every string token (delimiters included) of the value, in document order. */
  strings: StringSpan[];
  /** The entries of the value's own dictionary, when the value is a dictionary. */
  entries: Map<string, DictEntry>;
}

/** A name token `/Name`, ending at the first delimiter or whitespace. */
function readName(bytes: Uint8Array, from: number): number {
  let i = from + 1;
  while (i < bytes.length && !isPdfWhitespace(bytes[i]) && !isDelimiter(bytes[i])) i++;
  return i;
}

/** The index just past the `)` closing the literal string that starts at `from`. */
function scanLiteralString(bytes: Uint8Array, from: number): number {
  let depth = 1;
  for (let i = from + 1; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x5c) {
      i++;                                        // an escaped byte cannot close anything
      continue;
    }
    if (byte === 0x28) depth++;
    else if (byte === 0x29 && --depth === 0) return i + 1;
  }
  throw new EngineRefusal('unknown', 'a literal string in the file never closes');
}

/**
 * Walks one PDF value and returns where it ends, recording the strings it holds and — for a
 * top-level dictionary — the raw span of every entry, which is how `/Length` (streams) and
 * `/Root`, `/Info` (trailer) are found without re-serialising anything.
 */
function scanValue(bytes: Uint8Array, from: number, out: ScanResult, topLevel: boolean): number {
  let i = skipSpace(bytes, from);
  const byte = bytes[i];

  if (byte === 0x3c && bytes[i + 1] === 0x3c) {
    i += 2;
    for (;;) {
      i = skipSpace(bytes, i);
      if (i >= bytes.length) throw new EngineRefusal('unknown', 'a dictionary in the file never closes');
      if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) return i + 2;
      if (bytes[i] !== 0x2f) throw new EngineRefusal('unknown', `the dictionary key at byte ${i} is not a name`);
      const nameEnd = readName(bytes, i);
      const key = latin1(bytes, i + 1, nameEnd);
      const valueStart = skipSpace(bytes, nameEnd);
      const valueEnd = scanValue(bytes, valueStart, out, false);
      if (topLevel) out.entries.set(key, { start: valueStart, end: valueEnd, text: latin1(bytes, valueStart, valueEnd) });
      i = valueEnd;
    }
  }

  if (byte === 0x5b) {
    i++;
    for (;;) {
      i = skipSpace(bytes, i);
      if (i >= bytes.length) throw new EngineRefusal('unknown', 'an array in the file never closes');
      if (bytes[i] === 0x5d) return i + 1;
      i = scanValue(bytes, i, out, false);
    }
  }

  if (byte === 0x28) {
    const end = scanLiteralString(bytes, i);
    out.strings.push({ start: i, end, literal: true });
    return end;
  }

  if (byte === 0x3c) {
    const close = bytes.indexOf(0x3e, i + 1);
    if (close < 0) throw new EngineRefusal('unknown', 'a hexadecimal string in the file never closes');
    out.strings.push({ start: i, end: close + 1, literal: false });
    return close + 1;
  }

  if (byte === 0x2f) return readName(bytes, i);

  // A number, a reference (`n g R`) or a bare keyword.
  let j = i;
  while (j < bytes.length && !isPdfWhitespace(bytes[j]) && !isDelimiter(bytes[j])) j++;
  if (j === i) throw new EngineRefusal('unknown', `unreadable PDF token at byte ${i}`);
  if (/^\d+$/.test(latin1(bytes, i, j))) {
    const generation = readInteger(bytes, j);
    const refEnd = generation ? skipSpace(bytes, generation.end) : -1;
    const afterRef = refEnd + 1;
    const endsCleanly = afterRef >= bytes.length || isPdfWhitespace(bytes[afterRef]) || isDelimiter(bytes[afterRef]);
    if (generation && refEnd >= 0 && bytes[refEnd] === 0x52 && endsCleanly) return afterRef;   // `n g R`
  }
  return j;
}

/**
 * The VALUE of a literal string, as a reader computes it (§7.3.4.2): `\n \r \t \b \f`, escaped
 * parentheses and backslash, `\ddd` octal, a backslash before an end-of-line meaning "nothing",
 * and an unescaped end-of-line meaning one line feed.
 */
function literalStringValue(bytes: Uint8Array, start: number, end: number): Uint8Array {
  const out: number[] = [];
  for (let i = start + 1; i < end - 1; i++) {
    const byte = bytes[i];
    if (byte === 0x5c) {
      const next = bytes[++i];
      if (next === undefined) break;
      if (next === 0x6e) out.push(0x0a);
      else if (next === 0x72) out.push(0x0d);
      else if (next === 0x74) out.push(0x09);
      else if (next === 0x62) out.push(0x08);
      else if (next === 0x66) out.push(0x0c);
      else if (next === 0x28 || next === 0x29 || next === 0x5c) out.push(next);
      else if (next === 0x0a) continue;                                    // line continuation
      else if (next === 0x0d) {
        if (bytes[i + 1] === 0x0a) i++;
        continue;
      } else if (next >= 0x30 && next <= 0x37) {
        let octal = String.fromCharCode(next);
        while (octal.length < 3 && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x37) octal += String.fromCharCode(bytes[++i]);
        out.push(parseInt(octal, 8) & 0xff);
      } else out.push(next);
      continue;
    }
    if (byte === 0x0d) {                                                   // CR or CRLF → one line feed
      if (bytes[i + 1] === 0x0a) i++;
      out.push(0x0a);
      continue;
    }
    out.push(byte);
  }
  return new Uint8Array(out);
}

/** The VALUE of a hexadecimal string (§7.3.4.3): two digits per byte, a missing one counts as 0. */
function hexStringValue(bytes: Uint8Array, start: number, end: number): Uint8Array {
  const digits: number[] = [];
  for (let i = start + 1; i < end - 1; i++) {
    const byte = bytes[i];
    if (isPdfWhitespace(byte)) continue;
    const value = byte >= 0x30 && byte <= 0x39 ? byte - 0x30
      : byte >= 0x41 && byte <= 0x46 ? byte - 0x37
      : byte >= 0x61 && byte <= 0x66 ? byte - 0x57
      : -1;
    if (value < 0) throw new EngineRefusal('unknown', `"${String.fromCharCode(byte)}" is not a hexadecimal digit`);
    digits.push(value);
  }
  const out = new Uint8Array(Math.ceil(digits.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = ((digits[i * 2] ?? 0) << 4) | (digits[i * 2 + 1] ?? 0);
  return out;
}

interface RawObject {
  num: number;
  gen: number;
  /** Index just after the `obj` keyword: the object's own whitespace stays as it is. */
  bodyStart: number;
  /** Index of the `endobj` keyword. */
  bodyEnd: number;
  strings: StringSpan[];
  entries: Map<string, DictEntry>;
  stream: { start: number; end: number; lengthToken: { start: number; end: number } } | null;
}

interface ClassicPdf {
  /** Everything before the first object is the header, copied byte for byte. */
  headerEnd: number;
  objects: RawObject[];
  trailer: Map<string, DictEntry>;
  size: number;
}

/** Reads one indirect object, including its stream when it has one. */
function readObject(bytes: Uint8Array, num: number, gen: number, offset: number): RawObject {
  const head = readInteger(bytes, offset);
  const headGen = head ? readInteger(bytes, head.end) : null;
  const keywordAt = headGen ? skipSpace(bytes, headGen.end) : -1;
  if (!head || !headGen || head.value !== num || headGen.value !== gen || !matchesAt(bytes, keywordAt, 'obj')) {
    throw new EngineRefusal('unknown', `object ${num} ${gen} is not where the cross-reference table says it is`);
  }
  const bodyStart = keywordAt + 3;
  const scan: ScanResult = { strings: [], entries: new Map() };
  const valueEnd = scanValue(bytes, skipSpace(bytes, bodyStart), scan, true);

  let stream: RawObject['stream'] = null;
  let after = valueEnd;
  if (matchesAt(bytes, skipSpace(bytes, valueEnd), 'stream')) {
    let dataStart = skipSpace(bytes, valueEnd) + 6;
    if (bytes[dataStart] === 0x0d) dataStart++;
    if (bytes[dataStart] !== 0x0a) {
      throw new EngineRefusal('unknown', `the stream of object ${num} has no end of line after "stream"`);
    }
    dataStart++;
    const length = scan.entries.get('Length');
    if (!length || !/^\d+$/.test(length.text.trim())) {
      throw new EngineRefusal('unknown', `the stream of object ${num} has no direct /Length to follow`);
    }
    const dataEnd = dataStart + Number(length.text.trim());
    if (dataEnd > bytes.length) throw new EngineRefusal('unknown', `the stream of object ${num} runs past the end of the file`);
    if (!matchesAt(bytes, skipSpace(bytes, dataEnd), 'endstream')) {
      throw new EngineRefusal('unknown', `the stream of object ${num} does not end where /Length says it does`);
    }
    stream = { start: dataStart, end: dataEnd, lengthToken: { start: length.start, end: length.end } };
    after = skipSpace(bytes, dataEnd) + 9;
  }

  const endobjAt = skipSpace(bytes, after);
  if (!matchesAt(bytes, endobjAt, 'endobj')) throw new EngineRefusal('unknown', `object ${num} has no "endobj"`);
  return { num, gen, bodyStart, bodyEnd: endobjAt, strings: scan.strings, entries: scan.entries, stream };
}

/** The classic cross-reference table, the objects it points at, and the trailer entries. */
function readClassic(bytes: Uint8Array): ClassicPdf {
  const marker = findLast(bytes, 'startxref');
  if (marker < 0) throw new EngineRefusal('unknown', 'the PDF has no startxref');
  const start = readInteger(bytes, marker + 9);
  if (!start) throw new EngineRefusal('unknown', 'startxref is not followed by an offset');
  const xrefAt = skipSpace(bytes, start.value);
  if (!matchesAt(bytes, xrefAt, 'xref')) {
    throw new EngineRefusal('unknown', 'the PDF does not use a classic cross-reference table');
  }

  const entries = new Map<number, { offset: number; gen: number; free: boolean }>();
  let i = xrefAt + 4;
  for (;;) {
    i = skipSpace(bytes, i);
    if (matchesAt(bytes, i, 'trailer')) { i += 7; break; }
    const first = readInteger(bytes, i);
    const count = first ? readInteger(bytes, first.end) : null;
    if (!first || !count) throw new EngineRefusal('unknown', `unreadable cross-reference subsection at byte ${i}`);
    let at = count.end;
    if (bytes[at] === 0x0d) at++;
    if (bytes[at] === 0x0a) at++;
    for (let n = 0; n < count.value; n++, at += 20) {
      if (at + 20 > bytes.length) throw new EngineRefusal('unknown', 'the cross-reference table is cut short');
      const offset = Number(latin1(bytes, at, at + 10).trim());
      const gen = Number(latin1(bytes, at + 11, at + 16).trim());
      const kind = bytes[at + 17];
      if (!Number.isInteger(offset) || !Number.isInteger(gen) || (kind !== 0x6e && kind !== 0x66)) {
        throw new EngineRefusal('unknown', `cross-reference entry ${first.value + n} is malformed`);
      }
      entries.set(first.value + n, { offset, gen, free: kind === 0x66 });
    }
    i = at;
  }

  const trailerScan: ScanResult = { strings: [], entries: new Map() };
  scanValue(bytes, skipSpace(bytes, i), trailerScan, true);

  const objects: RawObject[] = [];
  let headerEnd = bytes.length;
  for (const [num, entry] of [...entries.entries()].sort((a, b) => a[0] - b[0])) {
    if (entry.free) continue;
    objects.push(readObject(bytes, num, entry.gen, entry.offset));
    headerEnd = Math.min(headerEnd, entry.offset);
  }
  if (!objects.length) throw new EngineRefusal('unknown', 'the PDF has no objects');
  const declared = Number(trailerScan.entries.get('Size')?.text.trim() ?? 0);
  return {
    headerEnd,
    objects,
    trailer: trailerScan.entries,
    size: Math.max(declared, objects[objects.length - 1].num + 1),
  };
}

/* ──────────────────────────── writing the encrypted PDF ──────────────────────────── */

const hexOf = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
};

const ascii = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

interface Edit { start: number; end: number; bytes: Uint8Array }

/** Replaces `[from, to)` with every edit that falls inside it, keeping everything else byte for byte. */
function applyEdits(bytes: Uint8Array, from: number, to: number, edits: Edit[]): Uint8Array {
  const inside = edits.filter((edit) => edit.start >= from && edit.end <= to).sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let at = from;
  for (const edit of inside) {
    if (edit.start < at) throw new EngineRefusal('unknown', 'two encrypted pieces overlap');
    parts.push(bytes.subarray(at, edit.start), edit.bytes);
    at = edit.end;
  }
  parts.push(bytes.subarray(at, to));
  return concatBytes(...parts);
}

/** The `/Encrypt` dictionary of the design: `/Filter /Standard`, V 4, R 4, AESV2, 128-bit key. */
function encryptDictionary(num: number, ownerEntry: Uint8Array, userEntry: Uint8Array, permissions: number): Uint8Array {
  const lines = [
    `${num} 0 obj`,
    '<<',
    '/CF <<',
    '/StdCF <<',
    '/AuthEvent /DocOpen',
    '/CFM /AESV2',
    '/Length 16',
    '>>',
    '>>',
    '/Filter /Standard',
    '/Length 128',
    `/O <${hexOf(ownerEntry)}>`,
    `/P ${permissions | 0}`,
    '/R 4',
    '/StmF /StdCF',
    '/StrF /StdCF',
    `/U <${hexOf(userEntry)}>`,
    '/V 4',
    '>>',
    'endobj',
    '',
    '',
  ];
  return ascii(lines.join('\n'));
}

/** The trailer keys this writer owns: copying the original ones would contradict the new file. */
const OWN_TRAILER_KEYS = new Set(['Size', 'ID', 'Encrypt', 'Prev', 'XRefStm', 'EncryptMetadata', 'DocChecksum']);

/** A header that can carry AESV2 must announce at least PDF 1.6; pdf-lib writes 1.7 already. */
function headerFor(header: Uint8Array): Uint8Array {
  const text = latin1(header, 0, Math.min(header.length, 8));
  const match = /^%PDF-(\d)\.(\d)/.exec(text);
  if (!match) throw new EngineRefusal('unknown', 'the file has no %PDF- header');
  if (Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 6)) return header;
  const patched = header.slice();
  patched.set(ascii('1.7'), 5);
  return patched;
}

/**
 * Normalises any PDF pdf-lib can open into the shape this pass needs: `%PDF-1.7`, a classic `xref`
 * table and uncompressed indirect objects. An already-encrypted file cannot be opened by pdf-lib
 * at all, and that refusal travels on unchanged (the app opens such a file read-only via pdf.js).
 */
async function canonicalise(bytes: Uint8Array): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new EngineRefusal(/encrypt/i.test(text) ? 'encrypted' : 'corrupt', `cannot prepare this file for encryption: ${text}`);
  }
  return doc.save({ useObjectStreams: false });
}

/** The plain bytes the self-check compares the decrypted output against, in document order. */
interface Samples { strings: Uint8Array[]; streams: Uint8Array[] }

const SAMPLE_STRINGS = 4;
const SAMPLE_STREAMS = 2;

/**
 * Encrypts `bytes` with the Standard Security Handler **V 4 / R 4 / AESV2** and returns the whole
 * file. The returned bytes have already passed the self-check below, so a caller may write them
 * straight to the file system: a file that cannot be opened with the password the owner typed is
 * never returned.
 */
export async function encryptPdf(bytes: Uint8Array, protection: PdfProtection): Promise<Uint8Array> {
  const problem = protectionProblem(protection);
  if (problem) throw new EngineRefusal('unknown', `refusing to write this protection: ${problem}`);

  const plain = await canonicalise(bytes);
  const parsed = readClassic(plain);

  const userPassword = passwordBytes(protection.userPassword);
  const ownerPassword = passwordBytes(protection.ownerPassword || protection.userPassword);
  const permissions = permissionBits(protection.permissions);
  const id0 = new Uint8Array(16);
  const id1 = new Uint8Array(16);
  webCrypto().getRandomValues(id0);
  webCrypto().getRandomValues(id1);

  const ownerEntry = computeOwnerEntry(ownerPassword, userPassword);
  const fileKey = deriveFileKey(userPassword, ownerEntry, permissions, id0);
  const userEntry = computeUserEntry(fileKey, id0);

  /* Every string and every stream of the body, each with its own object key. */
  const pieces: Uint8Array[] = [headerFor(plain.subarray(0, parsed.headerEnd))];
  const offsets = new Map<number, number>();
  const samples: Samples = { strings: [], streams: [] };
  let length = pieces[0].length;
  for (const object of parsed.objects) {
    const key = objectKey(fileKey, object.num, object.gen);
    const edits: Edit[] = [];
    for (const span of object.strings) {
      const value = span.literal
        ? literalStringValue(plain, span.start, span.end)
        : hexStringValue(plain, span.start, span.end);
      if (samples.strings.length < SAMPLE_STRINGS) samples.strings.push(value);
      edits.push({ start: span.start, end: span.end, bytes: ascii(`<${hexOf(await aesEncrypt(key, value))}>`) });
    }
    if (object.stream) {
      const payload = await aesEncrypt(key, plain.subarray(object.stream.start, object.stream.end));
      if (samples.streams.length < SAMPLE_STREAMS) samples.streams.push(plain.slice(object.stream.start, object.stream.end));
      edits.push({ start: object.stream.start, end: object.stream.end, bytes: payload });
      edits.push({ start: object.stream.lengthToken.start, end: object.stream.lengthToken.end, bytes: ascii(String(payload.length)) });
    }
    const body = applyEdits(plain, object.bodyStart, object.bodyEnd, edits);
    const head = ascii(`${object.num} ${object.gen} obj`);
    const tail = ascii('endobj\n\n');
    offsets.set(object.num, length);
    pieces.push(head, body, tail);
    length += head.length + body.length + tail.length;
  }

  /* The /Encrypt dictionary is a new indirect object, and it is never encrypted itself. */
  const encryptNumber = parsed.size;
  const encryptObject = encryptDictionary(encryptNumber, ownerEntry, userEntry, permissions);
  offsets.set(encryptNumber, length);
  pieces.push(encryptObject);
  length += encryptObject.length;
  const size = encryptNumber + 1;

  /* The cross-reference table, with every offset corrected to where the objects now are. */
  const xrefOffset = length;
  const xref: string[] = ['xref', `0 ${size}`, '0000000000 65535 f '];
  for (let num = 1; num < size; num++) {
    const offset = offsets.get(num);
    xref.push(offset === undefined
      ? '0000000000 65535 f '
      : `${String(offset).padStart(10, '0')} 00000 n `);
  }
  const xrefBytes = ascii(`${xref.join('\n')}\n`);
  pieces.push(xrefBytes);
  length += xrefBytes.length;

  /* The trailer names the new /ID and points at the /Encrypt object. */
  const trailer: string[] = ['trailer', '<<'];
  for (const [key, entry] of parsed.trailer) {
    if (!OWN_TRAILER_KEYS.has(key)) trailer.push(`/${key} ${entry.text.trim()}`);
  }
  trailer.push(`/Size ${size}`, `/ID [ <${hexOf(id0)}> <${hexOf(id1)}> ]`, `/Encrypt ${encryptNumber} 0 R`, '>>', '');
  const trailerBytes = ascii(`${trailer.join('\n')}\n`);
  pieces.push(trailerBytes);

  const out = concatBytes(...pieces, ascii(`startxref\n${xrefOffset}\n%%EOF\n`));

  await selfCheck(out, samples, {
    userPassword, ownerPassword, id0, permissions, encryptNumber,
  });
  return out;
}

/** The bytes to write for a document: encrypted when the owner asked for protection, unchanged when not. */
export async function protectedBytes(bytes: Uint8Array, protection: PdfProtection | null | undefined): Promise<Uint8Array> {
  return protection ? encryptPdf(bytes, protection) : bytes;
}

interface CheckInput {
  userPassword: Uint8Array;
  ownerPassword: Uint8Array;
  id0: Uint8Array;
  permissions: number;
  encryptNumber: number;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Reads the file back the way a reader would and proves the promises made to the owner:
 * the trailer has `/ID` and `/Encrypt`, the dictionary is V4/R4/AESV2 with a 128-bit key, `/U`
 * matches the key the USER password derives, `/U` matches the key the OWNER password derives
 * (so the owner password really opens the file with full rights), and the sampled strings and
 * stream decrypt back to exactly the plain bytes they had before. Anything else throws.
 */
async function selfCheck(out: Uint8Array, samples: Samples, input: CheckInput): Promise<void> {
  const parsed = readClassic(out);
  const ref = parsed.trailer.get('Encrypt');
  const refMatch = ref ? /^(\d+)\s+(\d+)\s+R$/.exec(ref.text.trim()) : null;
  if (!refMatch || Number(refMatch[1]) !== input.encryptNumber) {
    throw new EngineRefusal('unknown', 'the encrypted file has no /Encrypt entry in its trailer');
  }
  const idEntry = parsed.trailer.get('ID');
  const idText = idEntry ? idEntry.text : '';
  const idAt = out.indexOf(0x3c, idEntry?.start ?? 0);
  if (!idEntry || idAt < 0 || idAt > idEntry.end) throw new EngineRefusal('unknown', 'the encrypted file has no /ID');
  const id0 = hexStringValue(out, idAt, out.indexOf(0x3e, idAt) + 1);
  if (!sameBytes(id0, input.id0)) throw new EngineRefusal('unknown', 'the /ID of the encrypted file is not the one the key was derived from');

  const encrypt = parsed.objects.find((object) => object.num === input.encryptNumber);
  if (!encrypt) throw new EngineRefusal('unknown', 'the /Encrypt object is missing from the encrypted file');
  const entryText = (name: string): string => encrypt.entries.get(name)?.text.trim() ?? '';
  const dictionary = entryText('CF');
  if (entryText('Filter') !== '/Standard' || entryText('V') !== '4' || entryText('R') !== '4' || entryText('Length') !== '128') {
    throw new EngineRefusal('unknown', 'the /Encrypt dictionary is not Filter/Standard V4 R4 128');
  }
  if (!/\/StdCF/.test(dictionary) || !/\/AESV2/.test(dictionary) || !/\/AuthEvent\s*\/DocOpen/.test(dictionary)) {
    throw new EngineRefusal('unknown', 'the /Encrypt dictionary does not carry the AESV2 crypt filter');
  }
  if (entryText('StmF') !== '/StdCF' || entryText('StrF') !== '/StdCF') {
    throw new EngineRefusal('unknown', 'the /Encrypt dictionary does not use /StdCF for streams and strings');
  }
  if (entryText('P').trim() !== String(input.permissions | 0)) {
    throw new EngineRefusal('unknown', 'the /P of the encrypted file is not the permission set that was asked for');
  }

  const ownerEntry = hexStringValue(out, encrypt.entries.get('O')!.start, encrypt.entries.get('O')!.end);
  const userEntry = hexStringValue(out, encrypt.entries.get('U')!.start, encrypt.entries.get('U')!.end);
  if (ownerEntry.length !== 32 || userEntry.length !== 32) {
    throw new EngineRefusal('unknown', 'the /O or /U entry of the encrypted file is not 32 bytes');
  }
  if (!sameBytes(userEntry.subarray(0, 16), computeUserEntry(deriveFileKey(input.userPassword, ownerEntry, input.permissions, id0), id0).subarray(0, 16))) {
    throw new EngineRefusal('unknown', 'the user password does not unlock the file that was just written');
  }

  /* The owner path of Algorithm 3, in reverse: /O → the padded user password → the file key. */
  let ownerHash = md5(padPassword(input.ownerPassword));
  for (let i = 0; i < 50; i++) ownerHash = md5(ownerHash);
  let decoded = ownerEntry;
  for (let round = 19; round >= 0; round--) decoded = rc4(xorKey(ownerHash.subarray(0, 16), round), decoded);
  const ownerKey = deriveFileKey(decoded, ownerEntry, input.permissions, id0);
  if (!sameBytes(userEntry.subarray(0, 16), computeUserEntry(ownerKey, id0).subarray(0, 16))) {
    throw new EngineRefusal('unknown', 'the owner password does not unlock the file that was just written');
  }

  /* And the payload itself: decrypt the samples back to the bytes they had before. */
  const fileKey = deriveFileKey(input.userPassword, ownerEntry, input.permissions, id0);
  let stringCursor = 0;
  let streamCursor = 0;
  for (const object of parsed.objects) {
    if (object.num === input.encryptNumber) continue;
    const key = objectKey(fileKey, object.num, object.gen);
    for (const span of object.strings) {
      if (stringCursor >= samples.strings.length) break;
      const value = span.literal ? literalStringValue(out, span.start, span.end) : hexStringValue(out, span.start, span.end);
      if (!sameBytes(await aesDecrypt(key, value), samples.strings[stringCursor++])) {
        throw new EngineRefusal('unknown', `the string at byte ${span.start} did not decrypt back to what it was`);
      }
    }
    if (object.stream && streamCursor < samples.streams.length) {
      const payload = out.subarray(object.stream.start, object.stream.end);
      if (!sameBytes(await aesDecrypt(key, payload), samples.streams[streamCursor++])) {
        throw new EngineRefusal('unknown', 'a sampled stream did not decrypt back to what it was');
      }
    }
  }
  if (stringCursor !== samples.strings.length || streamCursor !== samples.streams.length) {
    throw new EngineRefusal('unknown', 'the encrypted file no longer holds everything it must');
  }
}
