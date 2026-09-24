/**
 * Office Calc engine — values (القيم).
 *
 * The value model every other engine module shares:
 *
 *   Scalar = number | string | boolean | CellError | null   (null = a blank cell)
 *   Area   = a rectangle of scalars: a sheet reference (RefArea) or a computed
 *            array (ArrayArea). `get(r, c)` is zero-based inside the rectangle.
 *   Value  = Scalar | Area — what an expression evaluates to.
 *
 * Plus Excel's coercion rules (`toNumber`, `toText`, `toBool`), its ordering for
 * comparisons (`compareScalars`: numbers < text < booleans, text case-insensitive),
 * the text→number parser Excel applies to "1,200", "15%", "$3", ISO dates and times
 * and Arabic-Indic digits (`textToNumber`), and the "General" text of a number
 * (`formatGeneral`, 15 significant digits so 0.1+0.2 reads 0.3).
 *
 * Pure: no DOM, no clock, no globals.
 */
import { dateToSerial } from './dates';

/** The Excel error values. */
export type ErrorCode = '#NULL!' | '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#NUM!' | '#N/A';

export const ERROR_CODES: readonly ErrorCode[] = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A'];

/** An error value. There is exactly one instance per code, so `===` compares them. */
export class CellError {
  private constructor(readonly code: ErrorCode) {}
  toString(): string { return this.code; }
  /** @internal */
  static make(code: ErrorCode): CellError { return new CellError(code); }
}

const ERROR_INSTANCES = new Map<ErrorCode, CellError>(ERROR_CODES.map((code) => [code, CellError.make(code)]));

/** The shared error instances. */
export const ERR = {
  NULL: ERROR_INSTANCES.get('#NULL!')!,
  DIV0: ERROR_INSTANCES.get('#DIV/0!')!,
  VALUE: ERROR_INSTANCES.get('#VALUE!')!,
  REF: ERROR_INSTANCES.get('#REF!')!,
  NAME: ERROR_INSTANCES.get('#NAME?')!,
  NUM: ERROR_INSTANCES.get('#NUM!')!,
  NA: ERROR_INSTANCES.get('#N/A')!,
} as const;

/** The error for an error text ("#DIV/0!"), or undefined when the text is not one. `#NAME!` is read as `#NAME?`. */
export function errorFromText(text: string): CellError | undefined {
  const upper = text.trim().toUpperCase();
  if (upper === '#NAME!') return ERR.NAME; // the old engine wrote this spelling
  return ERROR_INSTANCES.get(upper as ErrorCode);
}

export type Scalar = number | string | boolean | CellError | null;

/** A rectangle of values. `extentRows/extentCols` bound iteration (a whole column is clipped to the used part). */
export interface Area {
  readonly kind: 'area';
  readonly rows: number;
  readonly cols: number;
  readonly extentRows: number;
  readonly extentCols: number;
  get(r: number, c: number): Scalar;
}

export type Value = Scalar | Area;

export function isError(v: unknown): v is CellError {
  return v instanceof CellError;
}

export function isArea(v: unknown): v is Area {
  return typeof v === 'object' && v !== null && (v as Area).kind === 'area';
}

/** A computed array (from `{1,2;3,4}` or an operator applied to ranges). */
export class ArrayArea implements Area {
  readonly kind = 'area' as const;
  readonly rows: number;
  readonly cols: number;
  constructor(readonly data: Scalar[][]) {
    this.rows = data.length;
    this.cols = data[0]?.length ?? 0;
  }
  get extentRows(): number { return this.rows; }
  get extentCols(): number { return this.cols; }
  get(r: number, c: number): Scalar {
    const v = this.data[r]?.[c];
    return v === undefined ? null : v;
  }
}

/** What a RefArea reads cells through (the workbook). */
export interface CellReader {
  value(sheetId: number, row: number, col: number): Scalar;
  /** Rows and columns in use on the sheet (one past the last non-blank cell). */
  extent(sheetId: number): { rows: number; cols: number };
}

/** A reference to a rectangle of sheet cells. */
export class RefArea implements Area {
  readonly kind = 'area' as const;
  readonly extentRows: number;
  readonly extentCols: number;
  constructor(
    readonly reader: CellReader,
    readonly sheetId: number,
    readonly sheetName: string,
    readonly row: number,
    readonly col: number,
    readonly rows: number,
    readonly cols: number,
  ) {
    const used = reader.extent(sheetId);
    this.extentRows = Math.max(0, Math.min(rows, used.rows - row));
    this.extentCols = Math.max(0, Math.min(cols, used.cols - col));
  }
  get(r: number, c: number): Scalar {
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return null;
    return this.reader.value(this.sheetId, this.row + r, this.col + c);
  }
  /** The same sheet, another rectangle (for INDEX, OFFSET, XLOOKUP). */
  sub(r: number, c: number, rows: number, cols: number): RefArea {
    return new RefArea(this.reader, this.sheetId, this.sheetName, this.row + r, this.col + c, rows, cols);
  }
}

/** A sub-rectangle of any area (a RefArea keeps being a reference). */
export function subArea(area: Area, r: number, c: number, rows: number, cols: number): Area {
  if (area instanceof RefArea) return area.sub(r, c, rows, cols);
  const data: Scalar[][] = [];
  for (let i = 0; i < rows; i++) {
    const line: Scalar[] = [];
    for (let j = 0; j < cols; j++) line.push(area.get(r + i, c + j));
    data.push(line);
  }
  return new ArrayArea(data);
}

/* ─────────────────────────── text → number ─────────────────────────── */

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Arabic-Indic (and Persian) digits to ASCII, plus the Arabic decimal/thousands marks. */
export function latinDigits(text: string): string {
  return text
    .replace(ARABIC_DIGITS, (d) => {
      const code = d.charCodeAt(0);
      return String(code <= 0x669 ? code - 0x660 : code - 0x6f0);
    })
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

const NUMBER_RE = /^([+-])?\$?([+-])?(\d{1,3}(?:,\d{3})+|\d*)(\.\d*)?(?:[eE]([+-]?\d+))?(%)?$/;
const ISO_DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AaPp][Mm])?$/;

/**
 * The number Excel reads from a text, or null: "12", " -3.5 ", "1,200", "15%",
 * "$4", "1e3", "٣٫٥", "2024-01-15" (a date serial), "14:30" (a day fraction).
 */
export function textToNumber(raw: string): number | null {
  const text = latinDigits(raw).trim();
  if (text === '') return null;
  const m = NUMBER_RE.exec(text);
  if (m && (m[3] !== '' || (m[4] && m[4].length > 1))) {
    if (m[1] && m[2]) return null;
    const sign = m[1] === '-' || m[2] === '-' ? -1 : 1;
    let n = Number(`${m[3].replace(/,/g, '') || '0'}${m[4] ?? ''}${m[5] !== undefined ? `e${m[5]}` : ''}`);
    if (!Number.isFinite(n)) return null;
    if (m[6]) n /= 100;
    return sign * n;
  }
  const d = ISO_DATE_RE.exec(text);
  if (d) {
    const month = Number(d[2]);
    const day = Number(d[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let serial = dateToSerial(Number(d[1]), month, day);
    if (d[4] !== undefined) {
      const h = Number(d[4]);
      const mi = Number(d[5]);
      const s = Number(d[6] ?? 0);
      if (h > 23 || mi > 59 || s >= 60) return null;
      serial += (h * 3600 + mi * 60 + s) / 86400;
    }
    return serial;
  }
  const t = TIME_RE.exec(text);
  if (t) {
    let h = Number(t[1]);
    const mi = Number(t[2]);
    const s = Number(t[3] ?? 0);
    if (mi > 59 || s >= 60) return null;
    if (t[4]) {
      if (h < 1 || h > 12) return null;
      const pm = t[4].toLowerCase() === 'pm';
      h = (h % 12) + (pm ? 12 : 0);
    }
    return (h * 3600 + mi * 60 + s) / 86400;
  }
  return null;
}

/* ───────────────────────────── coercion ───────────────────────────── */

/** Excel's "General" text of a number: up to `digits` significant digits, no float noise. */
export function formatGeneral(n: number, digits = 15): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const s = String(Number(n.toPrecision(digits)));
  return s.includes('e') ? s.replace('e', 'E') : s;
}

/** A scalar's number: blank is 0, TRUE is 1, numeric text is read, other text is #VALUE!. */
export function toNumber(v: Scalar): number | CellError {
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isError(v)) return v;
  const n = textToNumber(v);
  return n === null ? ERR.VALUE : n;
}

/** A scalar's text: numbers in General form, TRUE/FALSE, blank as "". */
export function toText(v: Scalar): string | CellError {
  if (typeof v === 'string') return v;
  if (v === null) return '';
  if (typeof v === 'number') return formatGeneral(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

/** A scalar's truth: numbers are true when non-zero, "TRUE"/"FALSE" text is read, other text is #VALUE!. */
export function toBool(v: Scalar): boolean | CellError {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (isError(v)) return v;
  const upper = v.trim().toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  return ERR.VALUE;
}

function typeRank(v: Exclude<Scalar, null | CellError>): number {
  return typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;
}

/**
 * Excel's comparison of two scalars (-1, 0, 1): numbers < text < booleans, text
 * compared case-insensitively. A blank takes the other side's empty value
 * (0, "" or FALSE). Errors are handled by the caller.
 */
export function compareScalars(a: Exclude<Scalar, CellError>, b: Exclude<Scalar, CellError>): number {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === 'number' ? 0 : typeof b === 'string' ? '' : false;
  if (b === null) b = typeof a === 'number' ? 0 : typeof a === 'string' ? '' : false;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'string') {
    const x = a.toLowerCase();
    const y = (b as string).toLowerCase();
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const x = Number(a);
  const y = Number(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** Rounds half away from zero at `digits` decimals, ignoring float noise (ROUND(1.005, 2) = 1.01). */
export function roundHalfAway(x: number, digits: number, mode: 'round' | 'up' | 'down' = 'round'): number {
  const d = Math.trunc(digits);
  const scaled = d >= 0 ? Math.abs(x) * 10 ** d : Math.abs(x) / 10 ** -d;
  const clean = Number(scaled.toPrecision(15));
  const r = mode === 'up' ? Math.ceil(clean) : mode === 'down' ? Math.floor(clean) : Math.round(clean);
  const back = d >= 0 ? r / 10 ** d : r * 10 ** -d;
  return x < 0 ? -back : back;
}

/** The scalar a grid cell's text stands for: numbers, TRUE/FALSE and error texts are typed; the rest is text. */
export function scalarFromText(text: string): Scalar {
  if (text === '') return null;
  const trimmed = text.trim();
  if (/^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  if (trimmed.startsWith('#')) {
    const err = errorFromText(trimmed);
    if (err) return err;
  }
  return text;
}

/** The text a grid cell shows for a scalar (General format). */
export function scalarToText(v: Scalar): string {
  if (v === null) return '';
  if (isError(v)) return v.code;
  return toText(v) as string;
}
