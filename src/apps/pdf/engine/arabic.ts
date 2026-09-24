/**
 * PDF engine — Arabic text for the writer (تشكيل الحروف العربية وترتيبها للكتابة في PDF).
 *
 * PDF has no text shaping: a content stream shows glyphs, left to right, exactly as given.
 * So before Arabic reaches a page it must already be
 *   1. shaped: every letter replaced by its isolated / initial / medial / final form from the
 *      Unicode Presentation Forms (FE70–FEFF, plus FB50–FBFF for the Persian letters), with
 *      lam + alef merged into their ligature and the tashkeel kept on its letter; and
 *   2. put in visual order: a compact subset of the Unicode Bidirectional Algorithm (UAX #9)
 *      for ONE line with no explicit embeddings, so "مرحبا 2026 PDF" keeps its digits and its
 *      Latin word left-to-right inside the right-to-left line.
 *
 * Both steps are pure and tested on code points. The glyphs themselves come from an embedded
 * font (Noto Naskh Arabic, SIL OFL 1.1, in `./fonts/`), loaded lazily by `loadArabicFont()`
 * only when Arabic is really written; the drawing lives in `text.ts`.
 */
import { PDFDocument } from 'pdf-lib';
import { unsupportedWatermarkChars } from '../ops';
import type { OpResult } from '../pdfdoc';
import { EngineRefusal, checkPage, colorOf, pageContent, runOp } from './common';
import { drawTextBlock, embedTextFonts } from './text';

/* ───────────────────────────── character classes ───────────────────────────── */

/** Joining type: D dual, R right-only, C causing (tatweel, ZWJ), U none. */
type Joining = 'D' | 'R' | 'C' | 'U';

/** [isolated, final, initial, medial]; 0 = the form does not exist. */
type Forms = readonly [number, number, number, number];

const FORMS: ReadonlyMap<number, Forms> = (() => {
  const m = new Map<number, Forms>();
  const two = (cp: number, iso: number): void => { m.set(cp, [iso, iso + 1, 0, 0]); };
  const four = (cp: number, iso: number): void => { m.set(cp, [iso, iso + 1, iso + 2, iso + 3]); };
  m.set(0x0621, [0xfe80, 0, 0, 0]);
  two(0x0622, 0xfe81); two(0x0623, 0xfe83); two(0x0624, 0xfe85); two(0x0625, 0xfe87);
  four(0x0626, 0xfe89); two(0x0627, 0xfe8d); four(0x0628, 0xfe8f); two(0x0629, 0xfe93);
  four(0x062a, 0xfe95); four(0x062b, 0xfe99); four(0x062c, 0xfe9d); four(0x062d, 0xfea1);
  four(0x062e, 0xfea5); two(0x062f, 0xfea9); two(0x0630, 0xfeab); two(0x0631, 0xfead);
  two(0x0632, 0xfeaf); four(0x0633, 0xfeb1); four(0x0634, 0xfeb5); four(0x0635, 0xfeb9);
  four(0x0636, 0xfebd); four(0x0637, 0xfec1); four(0x0638, 0xfec5); four(0x0639, 0xfec9);
  four(0x063a, 0xfecd); four(0x0641, 0xfed1); four(0x0642, 0xfed5); four(0x0643, 0xfed9);
  four(0x0644, 0xfedd); four(0x0645, 0xfee1); four(0x0646, 0xfee5); four(0x0647, 0xfee9);
  two(0x0648, 0xfeed); two(0x0649, 0xfeef); four(0x064a, 0xfef1);
  // Persian / Urdu letters live in Presentation Forms-A, same [iso, fin, ini, med] order.
  two(0x0671, 0xfb50); four(0x067e, 0xfb56); four(0x0686, 0xfb7a); two(0x0698, 0xfb8a);
  four(0x06a9, 0xfb8e); four(0x06af, 0xfb92); four(0x06cc, 0xfbfc);
  return m;
})();

/** Lam + (alef variant) → [isolated, final] ligature. */
const LAM = 0x0644;
const LAM_ALEF: ReadonlyMap<number, readonly [number, number]> = new Map([
  [0x0622, [0xfef5, 0xfef6]],
  [0x0623, [0xfef7, 0xfef8]],
  [0x0625, [0xfef9, 0xfefa]],
  [0x0627, [0xfefb, 0xfefc]],
]);

function joiningOf(cp: number): Joining {
  if (cp === 0x0640 || cp === 0x200d) return 'C';
  const forms = FORMS.get(cp);
  if (!forms) return 'U';
  if (forms[2]) return 'D';
  if (forms[1]) return 'R';
  return 'U';
}

export function isArabicLetter(cp: number): boolean {
  return FORMS.has(cp);
}

/* ───────────────────────────── shaping ───────────────────────────── */

/**
 * Logical Arabic → logical presentation forms. Each letter takes the form its neighbours
 * allow (skipping tashkeel, which never breaks a join); lam + alef becomes one ligature glyph;
 * everything that is not an Arabic letter is copied unchanged, so tashkeel, digits, Latin and
 * spaces survive. The output is still in LOGICAL order — run `reorderLine` for the page.
 */
export function shapeArabic(text: string): string {
  const cps = [...text].map((ch) => ch.codePointAt(0) ?? 0);
  const out: number[] = [];
  const neighbour = (from: number, step: 1 | -1): number => {
    for (let i = from + step; i >= 0 && i < cps.length; i += step) {
      if (!isTransparentMark(cps[i])) return i;
    }
    return -1;
  };
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const forms = FORMS.get(cp);
    if (!forms) { out.push(cp); continue; }
    const p = neighbour(i, -1);
    const n = neighbour(i, 1);
    const prevJoins = p >= 0 && (joiningOf(cps[p]) === 'D' || joiningOf(cps[p]) === 'C');
    const self = joiningOf(cp);
    const joinPrev = prevJoins && self !== 'U';
    if (cp === LAM && n >= 0 && LAM_ALEF.has(cps[n])) {
      const lig = LAM_ALEF.get(cps[n]) as readonly [number, number];
      out.push(joinPrev ? lig[1] : lig[0]);
      // Marks between the lam and the alef stay, right after the ligature.
      for (let k = i + 1; k < n; k++) out.push(cps[k]);
      i = n;
      continue;
    }
    const nextJoins = n >= 0 && ['D', 'R', 'C'].includes(joiningOf(cps[n]));
    const joinNext = (self === 'D' || self === 'C') && nextJoins;
    let form: number;
    if (joinPrev && joinNext) form = forms[3];
    else if (joinPrev) form = forms[1];
    else if (joinNext) form = forms[2];
    else form = forms[0];
    out.push(form || forms[0] || cp);
  }
  return String.fromCodePoint(...out);
}

/** Tashkeel and other combining marks: they ride on the letter before them. */
export function isTransparentMark(cp: number): boolean {
  return (cp >= 0x0610 && cp <= 0x061a) || (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670
    || (cp >= 0x06d6 && cp <= 0x06dc) || (cp >= 0x06df && cp <= 0x06e4) || cp === 0x06e7 || cp === 0x06e8
    || (cp >= 0x06ea && cp <= 0x06ed) || (cp >= 0x0300 && cp <= 0x036f);
}

/* ───────────────────────────── bidi (UAX #9 subset) ───────────────────────────── */

export type BidiClass = 'L' | 'R' | 'AL' | 'EN' | 'AN' | 'ES' | 'ET' | 'CS' | 'NSM' | 'WS' | 'ON';

export function bidiClass(cp: number): BidiClass {
  if (isTransparentMark(cp)) return 'NSM';
  if (cp >= 0x30 && cp <= 0x39) return 'EN';
  if (cp >= 0x06f0 && cp <= 0x06f9) return 'EN';
  if ((cp >= 0x0660 && cp <= 0x0669) || cp === 0x066b || cp === 0x066c) return 'AN';
  if (cp === 0x2b || cp === 0x2d || cp === 0x2212) return 'ES';
  if (cp === 0x23 || cp === 0x24 || cp === 0x25 || (cp >= 0xa2 && cp <= 0xa5) || cp === 0xb0 || cp === 0xb1
    || cp === 0x066a || cp === 0x20ac || cp === 0x2030) return 'ET';
  if (cp === 0x2c || cp === 0x2e || cp === 0x2f || cp === 0x3a || cp === 0xa0 || cp === 0x060c) return 'CS';
  if (cp === 0x20 || cp === 0x09 || cp === 0x3000 || (cp >= 0x2000 && cp <= 0x200a)) return 'WS';
  if (cp >= 0x0590 && cp <= 0x05ff) return 'R';
  if (cp === 0x200f) return 'R';
  if (cp === 0x200e) return 'L';
  if ((cp >= 0x0600 && cp <= 0x07bf) || (cp >= 0x0860 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff)
    || (cp >= 0xfe70 && cp <= 0xfefe)) return 'AL';
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7)
    || (cp >= 0x0370 && cp <= 0x052f) || (cp >= 0x1e00 && cp <= 0x1fff) || cp === 0xaa || cp === 0xb5 || cp === 0xba
    || (cp >= 0x2c00 && cp <= 0xd7ff) || cp >= 0x10000) return 'L';
  return 'ON';
}

export type Direction = 'ltr' | 'rtl' | 'auto';

/** The paragraph direction UAX #9 P2/P3 picks: the first strong character decides. */
export function baseDirection(text: string, fallback: 'ltr' | 'rtl' = 'ltr'): 'ltr' | 'rtl' {
  for (const ch of text) {
    const c = bidiClass(ch.codePointAt(0) ?? 0);
    if (c === 'L') return 'ltr';
    if (c === 'R' || c === 'AL') return 'rtl';
  }
  return fallback;
}

const MIRROR: Record<string, string> = {
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«',
  '‹': '›', '›': '‹',
};

/** A base character plus the marks that ride on it: reordering never separates them. */
export interface Cluster { text: string; level: number }

/**
 * One line, logical → visual. Returns clusters (a base + its marks) left to right; inside a
 * cluster the marks stay AFTER their base, which is what the drawing code wants. Paired
 * brackets are mirrored in right-to-left runs.
 *
 * Implemented rules: W1–W7, N1–N2, I1–I2, L1 (trailing spaces), L2, L4 (mirroring). Not
 * implemented, because a stamped line never carries them: explicit embeddings/isolates
 * (X1–X10) and bracket pairing N0.
 */
export function reorderClusters(text: string, direction: Direction = 'auto'): Cluster[] {
  const clusters: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (clusters.length && bidiClass(cp) === 'NSM') clusters[clusters.length - 1] += ch;
    else clusters.push(ch);
  }
  const n = clusters.length;
  if (!n) return [];
  const para = direction === 'auto' ? baseDirection(text, 'ltr') : direction;
  const base = para === 'rtl' ? 1 : 0;
  const sos: BidiClass = base ? 'R' : 'L';
  const types: BidiClass[] = clusters.map((c) => bidiClass(c.codePointAt(0) ?? 0));
  // W1: a leading lone mark takes sos.
  for (let i = 0; i < n; i++) if (types[i] === 'NSM') types[i] = i ? types[i - 1] : sos;
  // W2: EN after AL becomes AN.
  let strong: BidiClass = sos;
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === 'L' || t === 'R' || t === 'AL') strong = t;
    else if (t === 'EN' && strong === 'AL') types[i] = 'AN';
  }
  // W3: AL → R.
  for (let i = 0; i < n; i++) if (types[i] === 'AL') types[i] = 'R';
  // W4: one separator between two numbers of the same kind joins them.
  for (let i = 1; i < n - 1; i++) {
    const t = types[i];
    if (t === 'ES' && types[i - 1] === 'EN' && types[i + 1] === 'EN') types[i] = 'EN';
    else if (t === 'CS' && types[i - 1] === 'EN' && types[i + 1] === 'EN') types[i] = 'EN';
    else if (t === 'CS' && types[i - 1] === 'AN' && types[i + 1] === 'AN') types[i] = 'AN';
  }
  // W5: terminators next to European numbers become EN.
  for (let i = 0; i < n; i++) {
    if (types[i] !== 'ET') continue;
    let j = i;
    while (j < n && types[j] === 'ET') j++;
    const touches = (i > 0 && types[i - 1] === 'EN') || (j < n && types[j] === 'EN');
    for (let k = i; k < j; k++) types[k] = touches ? 'EN' : 'ET';
    i = j - 1;
  }
  // W6: leftover separators and terminators are neutral.
  for (let i = 0; i < n; i++) if (types[i] === 'ES' || types[i] === 'ET' || types[i] === 'CS') types[i] = 'ON';
  // W7: EN after L (or at an L start) behaves as L.
  strong = sos;
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === 'L' || t === 'R') strong = t;
    else if (t === 'EN' && strong === 'L') types[i] = 'L';
  }
  // N1/N2: runs of neutrals take the surrounding direction, else the paragraph's.
  const strongOf = (t: BidiClass): 'L' | 'R' | null => (t === 'L' ? 'L' : t === 'R' || t === 'EN' || t === 'AN' ? 'R' : null);
  for (let i = 0; i < n; i++) {
    if (types[i] !== 'ON' && types[i] !== 'WS') continue;
    let j = i;
    while (j < n && (types[j] === 'ON' || types[j] === 'WS')) j++;
    const before = i > 0 ? strongOf(types[i - 1]) : sos === 'L' ? 'L' : 'R';
    const after = j < n ? strongOf(types[j]) : sos === 'L' ? 'L' : 'R';
    const resolved: BidiClass = before === after && before ? before : base ? 'R' : 'L';
    for (let k = i; k < j; k++) types[k] = resolved;
    i = j - 1;
  }
  // I1/I2: levels.
  const levels = types.map((t) => {
    if (base === 0) return t === 'R' ? 1 : t === 'AN' || t === 'EN' ? 2 : 0;
    return t === 'L' || t === 'EN' || t === 'AN' ? 2 : 1;
  });
  // L1: trailing whitespace goes back to the paragraph level.
  for (let i = n - 1; i >= 0 && /^\s+$/u.test(clusters[i]); i--) levels[i] = base;
  // L2: reverse every run at or above each odd level, from the highest level down.
  const order = clusters.map((_, i) => i);
  const max = Math.max(...levels);
  const minOdd = Math.min(...levels.filter((l) => l % 2 === 1), max + 1);
  for (let level = max; level >= minOdd && level > 0; level--) {
    for (let i = 0; i < n; i++) {
      if (levels[order[i]] < level) continue;
      let j = i;
      while (j < n && levels[order[j]] >= level) j++;
      const run = order.slice(i, j).reverse();
      for (let k = i; k < j; k++) order[k] = run[k - i];
      i = j - 1;
    }
  }
  return order.map((i) => {
    const level = levels[i];
    const c = clusters[i];
    const first = [...c][0];
    const mirrored = level % 2 === 1 && MIRROR[first] ? MIRROR[first] + c.slice(first.length) : c;
    return { text: mirrored, level };
  });
}

/** `reorderClusters` flattened to a string (marks after their base). */
export function reorderLine(text: string, direction: Direction = 'auto'): string {
  return reorderClusters(text, direction).map((c) => c.text).join('');
}

/** Shape, then reorder: what a page shows, left to right, for one line of logical text. */
export function visualLine(text: string, direction: Direction = 'auto'): string {
  const dir = direction === 'auto' ? baseDirection(text, 'ltr') : direction;
  return reorderLine(shapeArabic(text), dir);
}

/**
 * Does this text need the embedded Unicode font? True for anything the standard PDF fonts
 * (WinAnsi) cannot encode — Arabic above all — so the app can stay on the tiny standard-font
 * path for plain Latin and pull the Arabic font in only when it is really needed.
 */
export function needsUnicodeFont(text: string): boolean {
  return unsupportedWatermarkChars(text.replace(/[\r\n]/g, '')).length > 0;
}

/* ───────────────────────────── the font file ───────────────────────────── */

let fontPromise: Promise<Uint8Array> | null = null;

/**
 * The Arabic font's bytes (Noto Naskh Arabic Regular, SIL OFL 1.1, ~155 KB). The file is a
 * build asset inlined into its OWN lazy chunk, so it costs nothing until Arabic is written and
 * never needs the network or `fetch` (works the same on the web, in Electron's custom scheme
 * and in mobile web views). The promise is cached.
 */
export function loadArabicFont(): Promise<Uint8Array> {
  if (!fontPromise) {
    fontPromise = import('./fonts/NotoNaskhArabic-Regular.ttf?inline')
      .then((mod) => dataUrlBytes(mod.default))
      .catch((error: unknown) => {
        fontPromise = null;
        throw error;
      });
  }
  return fontPromise;
}

/** `data:…;base64,xxxx` → bytes. Exported for the test. */
export function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  const b64 = comma >= 0 ? url.slice(comma + 1) : url;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ───────────────────────────── the operation ───────────────────────────── */

export interface UnicodeTextInput {
  /** 0-based page index. */
  page: number;
  /** Logical text; may hold several lines (\n) and mix Arabic, Latin and digits. */
  text: string;
  /** Left edge of the text box for LTR lines; for RTL lines `x` is still the LEFT edge unless `align` says otherwise. */
  x: number;
  /** Baseline of the first line. */
  y: number;
  size: number;
  color: string;
  /** Optional: 'rtl' lines are right-aligned to `x + maxWidth` when `maxWidth` is given. */
  direction?: Direction;
  maxWidth?: number;
  lineHeight?: number;
  opacity?: number;
}

/**
 * Draws any Unicode text (Arabic shaped + bidi-ordered, Latin through Helvetica) on one page as
 * new content. The text is wrapped in marked content with `/ActualText`, so copying it from
 * Acrobat or Chrome gives back the LOGICAL text, not presentation forms in visual order.
 */
export async function addUnicodeText(bytes: Uint8Array, input: UnicodeTextInput, font: Uint8Array): Promise<OpResult> {
  const color = colorOf(input.color);
  if (!input.text.trim()) return { ok: false, code: 'unknown', detail: 'emptyText' };
  if (!Number.isFinite(input.size) || input.size < 2 || input.size > 400) return { ok: false, code: 'unknown', detail: 'badSize' };
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return { ok: false, code: 'unknown', detail: 'badPoint' };
  let before = 0;
  return runOp(bytes, async (doc: PDFDocument) => {
    const page = checkPage(doc, input.page);
    if (!color) throw new EngineRefusal('unknown', 'badColor');
    before = pageContent(doc, input.page).length;
    const fonts = await embedTextFonts(doc, input.text, font);
    drawTextBlock(page, fonts, input.text, {
      x: input.x,
      y: input.y,
      size: input.size,
      color,
      direction: input.direction ?? 'auto',
      maxWidth: input.maxWidth,
      lineHeight: input.lineHeight,
      opacity: input.opacity,
    });
    return `text on page ${input.page + 1}`;
  }, (doc) => {
    const content = pageContent(doc, input.page);
    const bad: string[] = [];
    if (content.length <= before) bad.push('page content did not grow');
    if (!content.includes('TJ')) bad.push('no text operator on the page');
    if (!content.includes('/ActualText')) bad.push('no ActualText');
    return bad;
  });
}
