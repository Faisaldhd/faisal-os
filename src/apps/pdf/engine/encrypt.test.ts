import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import {
  ALL_PERMISSIONS, PERMISSION_BASE, PASSWORD_MAX_BYTES, computeOwnerEntry, computeUserEntry,
  deriveFileKey, encryptPdf, md5, objectKey, padPassword, passwordBytes, permissionBits,
  permissionsForChoice, protectedBytes, protectionProblem, rc4, type PdfProtection,
} from './encrypt';
import { TINY_PNG } from './test-helpers';

/*
 * The encryption is proved against things this module does NOT own:
 *  • MD5 against the published RFC 1321 vectors and RC4 against the published test vectors;
 *  • the produced file against **pdf.js** — the renderer the window already uses — which must open
 *    it with the user password, must open it with the OWNER password, must refuse a wrong password
 *    and must read the permissions (including "copying is not allowed") back from `/P`;
 *  • the byte layout against a cross-reference reader written here in the test, so the offsets,
 *    the trailer and the `/Encrypt` dictionary are checked without asking the writer.
 */

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const ascii = (text: string): Uint8Array => Uint8Array.from([...text].map((char) => char.charCodeAt(0) & 0xff));

const VECTORS: [string, string][] = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
];

/** The four fake passwords every test here uses; none of them is a secret of this project. */
const USER = 'user-pass-1';
const OWNER = 'owner-pass-1';

const PROTECTION: PdfProtection = {
  userPassword: USER,
  ownerPassword: OWNER,
  permissions: permissionsForChoice({ print: true, copy: true, modify: true, annotate: true }),
};

const COPY_DENIED: PdfProtection = {
  userPassword: USER,
  ownerPassword: OWNER,
  permissions: permissionsForChoice({ print: true, copy: false, modify: false, annotate: false }),
};

/** A one-page document with a marked sentence and tricky metadata (escapes, Arabic, newline). */
async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 400]).drawText('MARKER-42 inside', { x: 20, y: 200, size: 14, font });
  doc.setTitle('تقرير (سري) Fai$al OS');
  doc.setAuthor('plain author');
  // A literal string written by hand, with the escapes a reader has to decode: `\(`, `\)`, `\\`
  // and an octal `\101` (the letter A). `getInfoDict` is private in pdf-lib, so the dictionary is
  // reached through the trailer, exactly where a reader looks for it.
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) throw new Error('the sample PDF has no /Info dictionary');
  info.set(PDFName.of('Keywords'), PDFString.of('esc \\( paren \\) \\\\ octal \\101'));
  return doc.save({ useObjectStreams: false });
}

interface Opened {
  pages: number;
  text: string;
  info: Record<string, unknown>;
  permissions: number[];
}

/** Opens bytes with pdf.js exactly like the window does, and returns what it read. */
async function openWith(bytes: Uint8Array, password?: string): Promise<Opened> {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = lib.getDocument({ data: bytes.slice(), password, verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const metadata = await doc.getMetadata();
  const raw = await doc.getPermissions();
  const permissions = raw instanceof Set ? [...raw] as number[] : [...(raw ?? []) as number[]];
  const opened: Opened = {
    pages: doc.numPages,
    text: content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
    info: (metadata as unknown as { info?: Record<string, unknown> }).info ?? {},
    permissions,
  };
  await doc.cleanup();
  return opened;
}

/** pdf.js permission bits (its own constants, not ours). */
const PRINT = 0x04;
const MODIFY = 0x08;
const COPY = 0x10;
const ANNOTATE = 0x20;
const ACCESSIBILITY = 0x200;

/**
 * A cross-reference reader written in the test: every offset in the produced file must land on
 * `<num> <gen> obj`, which is the whole promise of rewriting a table by hand.
 */
function xrefCheck(bytes: Uint8Array): { size: number; offsets: Map<number, number> } {
  const text = latin1(bytes);
  const at = text.lastIndexOf('startxref');
  const offset = Number(text.slice(at + 9).trim().split(/\s/)[0]);
  expect(text.slice(offset, offset + 4), 'startxref must point at the xref keyword').toBe('xref');
  let i = offset + 4;
  const offsets = new Map<number, number>();
  let size = 0;
  for (;;) {
    while (/\s/.test(text[i])) i++;
    if (text.startsWith('trailer', i)) break;
    const header = /^(\d+)\s+(\d+)\s*\r?\n?/.exec(text.slice(i));
    if (!header) throw new Error(`unreadable xref subsection at ${i}`);
    const first = Number(header[1]);
    const count = Number(header[2]);
    size = Math.max(size, first + count);
    i += header[0].length;
    for (let n = 0; n < count; n++, i += 20) {
      const entry = text.slice(i, i + 20);
      const kind = entry[17];
      if (kind !== 'n') continue;
      offsets.set(first + n, Number(entry.slice(0, 10)));
    }
  }
  for (const [num, entryOffset] of offsets) {
    expect(text.slice(entryOffset, entryOffset + 12), `object ${num}`).toMatch(new RegExp(`^${num}\\s+\\d+\\s+obj`));
  }
  return { size, offsets };
}

describe('MD5 (RFC 1321)', () => {
  it('matches every published vector, including the empty string, "abc" and "message digest"', () => {
    for (const [input, expected] of VECTORS) {
      expect(hex(md5(ascii(input))), `MD5("${input}")`).toBe(expected);
    }
  });

  it('handles multi-block input (the algorithm has to pad and chain 64-byte blocks)', () => {
    // 1000 × 'a' is the classic padding/block test; its MD5 is published in RFC 1321's errata list
    // and reproduced by every independent implementation.
    expect(hex(md5(ascii('a'.repeat(1000))))).toBe('cabe45dcc9ae5b66ba86600cca6b8ba8');
    expect(md5(ascii('anything')).length).toBe(16);
  });
});

describe('RC4 (only /O and /U use it)', () => {
  it('matches the published vectors', () => {
    expect(hex(rc4(ascii('Key'), ascii('Plaintext')))).toBe('bbf316e8d940af0ad3');
    expect(hex(rc4(ascii('Wiki'), ascii('pedia')))).toBe('1021bf0420');
    expect(hex(rc4(ascii('Secret'), ascii('Attack at dawn')))).toBe('45a01f645fc35b383552544b9bf5');
  });

  it('is its own inverse and never changes the length', () => {
    const key = ascii('a-key');
    const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff);
    const back = rc4(key, rc4(key, data));
    expect(hex(back)).toBe(hex(data));
  });

  it('refuses an empty key instead of pretending to encrypt', () => {
    expect(() => rc4(new Uint8Array(0), ascii('data'))).toThrow(/RC4 needs a key/);
  });
});

describe('key derivation and permissions', () => {
  it('pads a short password with the specification padding string', () => {
    const padded = padPassword(passwordBytes('abc'));
    expect(padded.length).toBe(32);
    expect(hex(padded.subarray(0, 3))).toBe('616263');
    expect(hex(padded.subarray(3, 8))).toBe('28bf4e5e4e');
  });

  it('refuses a password longer than the 32 bytes R4 can carry, instead of truncating it', () => {
    expect(PASSWORD_MAX_BYTES).toBe(32);
    expect(protectionProblem({ ...PROTECTION, userPassword: 'x'.repeat(33) })).toBe('tooLong');
    expect(protectionProblem({ ...PROTECTION, userPassword: 'x'.repeat(32) })).toBeNull();
  });

  it('refuses an empty, non-ASCII or identical password pair', () => {
    expect(protectionProblem({ ...PROTECTION, userPassword: '' })).toBe('noUserPassword');
    expect(protectionProblem({ ...PROTECTION, userPassword: 'كلمة السر' })).toBe('notAscii');
    expect(protectionProblem({ ...PROTECTION, ownerPassword: USER })).toBe('samePassword');
    expect(protectionProblem({ ...PROTECTION, ownerPassword: '' })).toBe('samePassword');
    expect(protectionProblem(PROTECTION)).toBeNull();
  });

  it('sets exactly the permission bits the four choices mean', () => {
    const bits = permissionBits(permissionsForChoice({ print: true, copy: false, modify: false, annotate: false }));
    expect(bits & PRINT).toBe(PRINT);                       // printing is allowed
    expect(bits & 0x800).toBe(0x800);                       // high-quality printing follows printing
    expect(bits & COPY).toBe(0);                            // copying is not
    expect(bits & MODIFY).toBe(0);
    expect(bits & ANNOTATE).toBe(0);
    expect(bits & 0x100).toBe(0);                           // filling a form follows annotating
    expect(bits & 0x400).toBe(0);                           // assembling follows modifying
    expect(bits & ACCESSIBILITY).toBe(ACCESSIBILITY);        // accessibility is never blocked
    expect(bits & 0x00000003).toBe(0);                      // bits 1-2 are reserved and clear
    expect(bits & 0x000000c0).toBe(0x000000c0);             // bits 7-8 are reserved and set
    expect(bits >>> 12).toBe(0xfffff);                      // bits 13-32 are reserved and set
    expect(bits).toBe((PERMISSION_BASE | PRINT | 0x800 | ACCESSIBILITY) >>> 0);
  });

  it('allows everything (and nothing) exactly as promised', () => {
    expect(permissionBits(ALL_PERMISSIONS)).toBe(0xfffffffc);
    expect(permissionBits(ALL_PERMISSIONS) | 0).toBe(-4);
    const none = permissionBits(permissionsForChoice({ print: false, copy: false, modify: false, annotate: false }));
    expect(none).toBe((PERMISSION_BASE | ACCESSIBILITY) >>> 0);
    expect(none | 0).toBe((PERMISSION_BASE | ACCESSIBILITY) | 0);
  });

  it('accepts a password only through the keys it really derives (the reader-side checks)', () => {
    const user = passwordBytes(USER);
    const owner = passwordBytes(OWNER);
    const id0 = ascii('0123456789abcdef');
    const permissions = permissionBits(COPY_DENIED.permissions);
    const ownerEntry = computeOwnerEntry(owner, user);
    const key = deriveFileKey(user, ownerEntry, permissions, id0);
    expect(key.length).toBe(16);
    expect(hex(computeUserEntry(key, id0)).length).toBe(64);       // 32 bytes of /U

    // The owner path of Algorithm 3, reversed: /O → the padded user password → the same key.
    let hash = md5(padPassword(owner));
    for (let i = 0; i < 50; i++) hash = md5(hash);
    let decoded = ownerEntry;
    for (let round = 19; round >= 0; round--) {
      const derived = Uint8Array.from(hash.subarray(0, 16), (byte) => byte ^ round);
      decoded = rc4(derived, decoded);
    }
    expect(hex(deriveFileKey(decoded, ownerEntry, permissions, id0))).toBe(hex(key));

    // A different ID or a different permission set derives a different key: nothing is cached.
    expect(hex(deriveFileKey(user, ownerEntry, permissions, ascii('fedcba9876543210')))).not.toBe(hex(key));
    expect(hex(deriveFileKey(user, ownerEntry, permissionBits(ALL_PERMISSIONS), id0))).not.toBe(hex(key));
  });

  it('gives each object its own key, salted the AESV2 way', () => {
    const fileKey = deriveFileKey(passwordBytes(USER), new Uint8Array(32), 0, ascii('0123456789abcdef'));
    expect(objectKey(fileKey, 1, 0)).toHaveLength(16);
    expect(hex(objectKey(fileKey, 1, 0))).not.toBe(hex(objectKey(fileKey, 2, 0)));
    expect(hex(objectKey(fileKey, 1, 0))).not.toBe(hex(objectKey(fileKey, 1, 1)));
    // The `sAlT` suffix: without it the key would be the plain Algorithm 1 hash.
    const withoutSalt = md5(Uint8Array.from([...fileKey, 1, 0, 0, 0, 0])).subarray(0, 16);
    expect(hex(objectKey(fileKey, 1, 0))).not.toBe(hex(withoutSalt));
  });
});

describe('encryptPdf against pdf.js (the independent reference)', () => {
  // A pdf.js decrypt + parse of this document measured past the suite's 20 s default while three
  // gates ran together on the shared machine (the same load that made the formula and photo budgets
  // swing 15x). The allowance is for the clock only: every claim below is still asserted, once.
  const HEAVY = { timeout: 60_000 } as const;
  it('opens with the user password and shows the page that was there', HEAVY, async () => {
    const out = await encryptPdf(await sample(), PROTECTION);
    const opened = await openWith(out, USER);
    expect(opened.pages).toBe(1);
    expect(opened.text).toContain('MARKER-42');
  });

  it('refuses the wrong password and refuses no password at all', async () => {
    const out = await encryptPdf(await sample(), PROTECTION);
    await expect(openWith(out, 'not-the-password')).rejects.toThrow(/password/i);
    await expect(openWith(out)).rejects.toThrow(/password/i);
  });

  it('opens with the OWNER password, which is what gives the owner full rights', async () => {
    const out = await encryptPdf(await sample(), COPY_DENIED);
    const opened = await openWith(out, OWNER);
    expect(opened.pages).toBe(1);
  });

  it('reads the declared permissions back: copying denied, printing allowed', async () => {
    const out = await encryptPdf(await sample(), COPY_DENIED);
    const opened = await openWith(out, USER);
    expect(opened.permissions).toContain(PRINT);
    expect(opened.permissions).toContain(ACCESSIBILITY);
    expect(opened.permissions).not.toContain(COPY);
    expect(opened.permissions).not.toContain(MODIFY);
    expect(opened.permissions).not.toContain(ANNOTATE);
  });

  it('allows copying when the owner allowed it', async () => {
    const out = await encryptPdf(await sample(), PROTECTION);
    const opened = await openWith(out, USER);
    for (const bit of [PRINT, COPY, MODIFY, ANNOTATE]) expect(opened.permissions).toContain(bit);
  });

  it('decrypts every string back to exactly the text the plain file had', async () => {
    const plain = await sample();
    const before = await openWith(plain);
    const after = await openWith(await encryptPdf(plain, PROTECTION), USER);
    expect(after.info.Title).toBe(before.info.Title);
    expect(after.info.Title).toBe('تقرير (سري) Fai$al OS');
    expect(after.info.Author).toBe(before.info.Author);
    expect(after.info.Keywords).toBe('esc ( paren ) \\ octal A');
    expect(after.info.Producer).toBe(before.info.Producer);
  });

  it('really encrypts: the marker, the title and the page stream are not readable in the bytes', async () => {
    const out = await encryptPdf(await sample(), PROTECTION);
    const text = latin1(out);
    expect(text).not.toContain('MARKER-42');
    expect(text).not.toContain('plain author');
    expect(text).not.toContain('Fai$al');
    expect(text).not.toContain('esc ( paren )');
  });

  it('cannot be opened by pdf-lib any more (a second implementation agrees it is encrypted)', async () => {
    const out = await encryptPdf(await sample(), PROTECTION);
    await expect(PDFDocument.load(out)).rejects.toThrow();
    const probe = await PDFDocument.load(out, { ignoreEncryption: true });
    expect(probe.isEncrypted).toBe(true);
  });

  it('writes a different file every time (fresh IVs and a fresh /ID, never a fixed key)', async () => {
    const plain = await sample();
    const first = await encryptPdf(plain, PROTECTION);
    const second = await encryptPdf(plain, PROTECTION);
    expect(hex(first)).not.toBe(hex(second));
    // …while both open with the same password, so the randomness is in the payload, not the key.
    expect((await openWith(first, USER)).text).toBe((await openWith(second, USER)).text);
  });

  it('decrypts a binary image stream too, not only text', async () => {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(TINY_PNG);
    doc.addPage([200, 200]).drawImage(image, { x: 10, y: 10, width: 100, height: 100 });
    const out = await encryptPdf(await doc.save({ useObjectStreams: false }), PROTECTION);

    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await lib.getDocument({ data: out.slice(), password: USER, verbosity: 0 }).promise;
    const ops = await (await pdf.getPage(1)).getOperatorList();
    // Painting an image means the stream came back byte for byte: a wrong IV, a wrong key or a
    // broken padding would have thrown long before this line.
    expect(ops.fnArray).toContain(lib.OPS.paintImageXObject);
    await pdf.cleanup();
  });

  it('starts with a PDF 1.7 header and ends with %%EOF', async () => {
    const out = await encryptPdf(await sample(), PROTECTION);
    expect(latin1(out.subarray(0, 9))).toBe('%PDF-1.7\n');
    expect(latin1(out.subarray(-6))).toBe('%%EOF\n');
  });

  it('refuses to encrypt an already encrypted file instead of writing nonsense', async () => {
    const once = await encryptPdf(await sample(), PROTECTION);
    await expect(encryptPdf(once, PROTECTION)).rejects.toThrow(/encrypt|prepare/i);
  });
});

describe('the byte layout of the produced file', () => {
  it('has one classic xref table whose every offset lands on its object', async () => {
    const out = await encryptPdf(await sample(), PROTECTION);
    const { size, offsets } = xrefCheck(out);
    expect(offsets.size).toBeGreaterThanOrEqual(6);
    expect(size).toBe(offsets.size + 1);                       // a free object 0, then every object
  });

  it('carries the /Encrypt dictionary the design names, and the trailer points at it', async () => {
    const out = await encryptPdf(await sample(), PROTECTION);
    const text = latin1(out);
    const trailer = text.slice(text.lastIndexOf('trailer', text.lastIndexOf('xref')));
    const ref = /\/Encrypt\s+(\d+)\s+0\s+R/.exec(trailer);
    expect(ref, 'the trailer must name the /Encrypt object').not.toBeNull();
    expect(trailer).toMatch(/\/ID\s*\[\s*<[0-9a-f]{32}>\s*<[0-9a-f]{32}>\s*\]/);

    const { offsets } = xrefCheck(out);
    const encryptAt = offsets.get(Number(ref![1]))!;
    const object = text.slice(encryptAt, text.indexOf('endobj', encryptAt));
    expect(object).toContain('/Filter /Standard');
    expect(object).toContain('/V 4');
    expect(object).toContain('/R 4');
    expect(object).toContain('/Length 128');
    expect(object).toContain('/CFM /AESV2');
    expect(object).toContain('/AuthEvent /DocOpen');
    expect(object).toContain('/StmF /StdCF');
    expect(object).toContain('/StrF /StdCF');
    expect(object).toMatch(/\/O <[0-9a-f]{64}>/);
    expect(object).toMatch(/\/U <[0-9a-f]{64}>/);
    expect(object).toContain(`/P ${permissionBits(PROTECTION.permissions) | 0}`);
  });

  it('leaves the file alone when there is no protection to write', async () => {
    const plain = await sample();
    expect(await protectedBytes(plain, null)).toBe(plain);
    expect(await protectedBytes(plain, undefined)).toBe(plain);
    expect(hex(await protectedBytes(plain, PROTECTION))).not.toBe(hex(plain));
  });

  it('keeps every page and every object of the original document', async () => {
    const plain = await sample();
    const before = await PDFDocument.load(plain);
    const out = await encryptPdf(plain, PROTECTION);
    const after = await PDFDocument.load(out, { ignoreEncryption: true });
    expect(after.getPageCount()).toBe(before.getPageCount());
    // pdf-lib skips decryption on purpose, so the title it reads is the ciphertext: the strings
    // really are encrypted, seen from a second implementation that cannot decrypt.
    expect(after.getTitle()).not.toBe(before.getTitle());
    // The /Encrypt object is the only addition.
    expect(after.context.enumerateIndirectObjects().length).toBe(before.context.enumerateIndirectObjects().length + 1);
  });
});
