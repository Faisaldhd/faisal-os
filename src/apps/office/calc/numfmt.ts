/**
 * Office Calc — number formats (تنسيقات الأرقام), Excel's format codes.
 *
 *   formatValue(value, pattern = 'General', { locale?: 'en' | 'ar', digits?: 'latin' | 'arabic' })
 *       → { text, color? }   the text a cell shows; `color` from [Red]/[Blue]… as a CSS colour
 *   isDateFormat(pattern)   → true for date/time codes (so the UI can offer a date picker)
 *   makeFormat(spec)        → a pattern from a toolbar choice:
 *       { kind: 'general' | 'number' | 'percent' | 'currency' | 'date' | 'time' | 'datetime' | 'scientific' | 'text',
 *         decimals?, grouping?, symbol?, symbolAfter?, style?: 'short' | 'long' | 'iso', seconds? }
 *   parseEntry(text, { dateOrder?: 'dmy' | 'mdy' }) → { value, format? }  what a typed entry means,
 *       like Excel: "12%" → 0.12 with "0%", "$1,200" → 1200 with a currency format,
 *       "2024-01-15" / "15/1/2024" → a date serial with a date format, "14:30" → a time.
 *   BUILTIN_FORMATS         → Excel's built-in numFmtId → pattern table (for .xlsx styles).
 *
 * Supported codes: General, 0 # ? . , (grouping and ×1000 scaling) %, E+/E-,
 * fractions (# ?/?, ?/8), sections (positive;negative;zero;text), [Red]-style
 * colours, [>100] conditions, "literal" \x _x *x, [$€-409] currency tags, @,
 * dates and times (yyyy yy m mm mmm mmmm mmmmm d dd ddd dddd h hh m mm s ss
 * AM/PM A/P, elapsed [h] [mm] [ss]). With locale 'ar', month/day names and AM/PM
 * are Arabic; digits 'arabic' writes Arabic-Indic digits (٠١٢…) and separators.
 */
import { dateToSerial, serialToDate } from '../formula/dates';
import { formatGeneral, isError, latinDigits, roundHalfAway, type Scalar } from '../formula/values';

export interface NumberFormatOptions {
  locale?: 'en' | 'ar';
  digits?: 'latin' | 'arabic';
}

export interface FormattedValue { text: string; color?: string }

type Tok =
  | { t: 'lit'; s: string }
  | { t: 'ph'; ch: '0' | '#' | '?' }
  | { t: 'dot' }
  | { t: 'comma' }
  | { t: 'pct' }
  | { t: 'exp'; sign: '+' | '-' }
  | { t: 'slash' }
  | { t: 'at' }
  | { t: 'general' }
  | { t: 'date'; code: string }
  | { t: 'elapsed'; unit: 'h' | 'm' | 's'; width: number }
  | { t: 'ampm'; short: boolean; lower: boolean };

interface Section {
  toks: Tok[];
  color?: string;
  cond?: { op: string; value: number };
  kind: 'number' | 'date' | 'text' | 'general' | 'empty';
}

const COLORS: Record<string, string> = {
  black: '#1a1d26', white: '#E8ECF4', red: '#E5484D', green: '#3DD68C', blue: '#5B8DEF',
  yellow: '#E3B94F', magenta: '#C86BD6', cyan: '#3DBFB0',
};

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

/** Splits a pattern into sections at ';' outside quotes, escapes and brackets. */
function splitSections(pattern: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let bracket = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (quote) { cur += ch; if (ch === '"') quote = false; continue; }
    if (ch === '"') { quote = true; cur += ch; continue; }
    if (ch === '\\' && i + 1 < pattern.length) { cur += ch + pattern[++i]; continue; }
    if (bracket) { cur += ch; if (ch === ']') bracket = false; continue; }
    if (ch === '[') { bracket = true; cur += ch; continue; }
    if (ch === ';') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function tokenizeSection(src: string): Section {
  const toks: Tok[] = [];
  const section: Section = { toks, kind: 'number' };
  let i = 0;
  const lit = (s: string): void => {
    const last = toks[toks.length - 1];
    if (last?.t === 'lit') last.s += s;
    else toks.push({ t: 'lit', s });
  };
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      const stop = end < 0 ? src.length : end;
      lit(src.slice(i + 1, stop));
      i = stop + 1;
      continue;
    }
    if (ch === '\\') { lit(src[i + 1] ?? ''); i += 2; continue; }
    if (ch === '_') { lit(' '); i += 2; continue; }
    if (ch === '*') { i += 2; continue; }
    if (ch === '[') {
      const end = src.indexOf(']', i);
      const body = src.slice(i + 1, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 1;
      const lower = body.toLowerCase();
      const cond = /^(<=|>=|<>|<|>|=)\s*(-?\d*\.?\d+)$/.exec(body);
      if (COLORS[lower]) section.color = COLORS[lower];
      else if (/^color\d+$/.test(lower)) section.color = undefined;
      else if (cond) section.cond = { op: cond[1], value: Number(cond[2]) };
      else if (/^(h+|m+|s+)$/.test(lower)) toks.push({ t: 'elapsed', unit: lower[0] as 'h' | 'm' | 's', width: lower.length });
      else if (body.startsWith('$')) lit(body.slice(1).split('-')[0]);
      continue;
    }
    if (/^general/i.test(rest)) { toks.push({ t: 'general' }); i += 7; continue; }
    if (/^am\/pm/i.test(rest)) { toks.push({ t: 'ampm', short: false, lower: rest[0] === 'a' }); i += 5; continue; }
    if (/^a\/p/i.test(rest)) { toks.push({ t: 'ampm', short: true, lower: rest[0] === 'a' }); i += 3; continue; }
    if (/[yYmMdDhHsS]/.test(ch)) {
      let j = i;
      while (j < src.length && src[j].toLowerCase() === ch.toLowerCase()) j++;
      toks.push({ t: 'date', code: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ((ch === 'E' || ch === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) {
      toks.push({ t: 'exp', sign: src[i + 1] as '+' | '-' });
      i += 2;
      continue;
    }
    if (ch === '0' || ch === '#' || ch === '?') { toks.push({ t: 'ph', ch }); i++; continue; }
    if (ch === '.') { toks.push({ t: 'dot' }); i++; continue; }
    if (ch === ',') { toks.push({ t: 'comma' }); i++; continue; }
    if (ch === '%') { toks.push({ t: 'pct' }); i++; continue; }
    if (ch === '/') { toks.push({ t: 'slash' }); i++; continue; }
    if (ch === '@') { toks.push({ t: 'at' }); i++; continue; }
    lit(ch);
    i++;
  }
  if (!toks.length) section.kind = 'empty';
  else if (toks.some((t) => t.t === 'date' || t.t === 'elapsed' || t.t === 'ampm')) section.kind = 'date';
  else if (toks.some((t) => t.t === 'at') && !toks.some((t) => t.t === 'ph')) section.kind = 'text';
  else if (toks.some((t) => t.t === 'general')) section.kind = 'general';
  else if (!toks.some((t) => t.t === 'ph')) section.kind = 'text';
  return section;
}

const cache = new Map<string, Section[]>();

function compile(pattern: string): Section[] {
  let sections = cache.get(pattern);
  if (!sections) {
    sections = splitSections(pattern).map(tokenizeSection);
    if (cache.size > 500) cache.clear();
    cache.set(pattern, sections);
  }
  return sections;
}

/** True when the pattern formats dates or times. */
export function isDateFormat(pattern: string): boolean {
  return compile(pattern).some((s) => s.kind === 'date');
}

/* ───────────────────────────── output ───────────────────────────── */

interface Out { parts: Array<{ s: string; lit: boolean }> }

function emit(out: Out, s: string, lit = false): void {
  if (s) out.parts.push({ s, lit });
}

function finish(out: Out, opts: NumberFormatOptions): string {
  return out.parts.map(({ s, lit }) => {
    if (lit || opts.digits !== 'arabic') return s;
    return s.replace(/[0-9]/g, (d) => String.fromCharCode(0x660 + Number(d))).replace(/\./g, '٫').replace(/,/g, '٬');
  }).join('');
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The integer placeholders' output for `digits` (right-aligned, extra digits at the first one). */
function emitInteger(out: Out, toks: Tok[], digits: string, grouping: boolean): void {
  const phs = toks.filter((t): t is Extract<Tok, { t: 'ph' }> => t.t === 'ph');
  const k = phs.length;
  if (grouping) {
    const minZeros = k - phs.findIndex((p) => p.ch === '0');
    const padded = phs.some((p) => p.ch === '0') ? digits.padStart(minZeros, '0') : digits;
    let first = true;
    for (const t of toks) {
      if (t.t === 'ph') { if (first) { emit(out, groupThousands(padded)); first = false; } }
      else if (t.t === 'lit') emit(out, t.s, true);
    }
    return;
  }
  let i = 0;
  for (const t of toks) {
    if (t.t === 'lit') { emit(out, t.s, true); continue; }
    if (t.t !== 'ph') continue;
    const idx = digits.length - k + i;
    if (i === 0 && digits.length > k) emit(out, digits.slice(0, idx + 1));
    else if (idx >= 0) emit(out, digits[idx]);
    else emit(out, t.ch === '0' ? '0' : t.ch === '?' ? ' ' : '');
    i++;
  }
}

function emitFraction(out: Out, toks: Tok[], digits: string): void {
  const phs = toks.filter((t): t is Extract<Tok, { t: 'ph' }> => t.t === 'ph');
  let keep = digits.length;
  while (keep > 0 && digits[keep - 1] === '0' && phs[keep - 1]?.ch !== '0') keep--;
  let i = 0;
  for (const t of toks) {
    if (t.t === 'lit') { emit(out, t.s, true); continue; }
    if (t.t === 'pct') { emit(out, '%', true); continue; }
    if (t.t !== 'ph') continue;
    if (i < keep) emit(out, digits[i]);
    else emit(out, t.ch === '?' ? ' ' : '');
    i++;
  }
}

function formatNumberSection(out: Out, sec: Section, value: number, autoSign: boolean): void {
  const toks = sec.toks;
  let v = Math.abs(value);
  const pctCount = toks.filter((t) => t.t === 'pct').length;
  v *= 100 ** pctCount;
  const expAt = toks.findIndex((t) => t.t === 'exp');
  const slashAt = toks.findIndex((t) => t.t === 'slash');
  const numberEnd = expAt >= 0 ? expAt : toks.length;
  const dotAt = toks.findIndex((t, i) => t.t === 'dot' && i < numberEnd);
  const intEnd = dotAt >= 0 ? dotAt : numberEnd;

  // Commas: between integer placeholders = grouping; right after the last one = ÷1000 each.
  let grouping = false;
  let scale = 0;
  const lastIntPh = toks.slice(0, intEnd).map((t) => t.t).lastIndexOf('ph');
  const lastPh = toks.slice(0, numberEnd).map((t) => t.t).lastIndexOf('ph');
  toks.forEach((t, i) => {
    if (t.t !== 'comma' || i >= numberEnd) return;
    if (i < lastIntPh) grouping = true;
    else if (i > lastPh && lastPh >= 0) scale++;
  });
  v /= 1000 ** scale;

  if (slashAt >= 0 && expAt < 0) { formatFractionSection(out, toks, v, value < 0 && autoSign); return; }

  const intToks = toks.slice(0, intEnd).filter((t) => t.t === 'ph' || t.t === 'lit');
  const fracToks = dotAt >= 0 ? toks.slice(dotAt + 1, numberEnd) : [];
  const fracMax = fracToks.filter((t) => t.t === 'ph').length;

  let exponent = 0;
  if (expAt >= 0) {
    const intPh = intToks.filter((t) => t.t === 'ph').length || 1;
    if (v !== 0) {
      exponent = Math.floor(Math.log10(v));
      if (intPh > 1) exponent = Math.floor(exponent / intPh) * intPh;
    }
    v /= 10 ** exponent;
    const r = roundHalfAway(v, fracMax);
    if (intPh === 1 && r >= 10) { v /= 10; exponent += 1; }
  }

  const rounded = roundHalfAway(v, fracMax);
  const fixed = rounded.toFixed(fracMax);
  const [intRaw, fracRaw = ''] = fixed.split('.');
  const hasZeroPh = intToks.some((t) => t.t === 'ph' && t.ch === '0');
  const intDigits = intRaw === '0' && !hasZeroPh ? '' : intRaw;

  if (value < 0 && autoSign && (Number(fixed) !== 0 || expAt >= 0)) emit(out, '-', true);
  // Literals keep their place around the digits (e.g. "$" in "$#,##0").
  emitInteger(out, intToks, intDigits, grouping);
  toks.slice(0, intEnd).forEach((t) => { if (t.t === 'pct') emit(out, '%', true); });
  if (dotAt >= 0) {
    emit(out, '.');
    emitFraction(out, fracToks, fracRaw);
  }
  if (expAt >= 0) {
    const sign = exponent < 0 ? '-' : (toks[expAt] as { sign: string }).sign === '+' ? '+' : '';
    const expToks = toks.slice(expAt + 1);
    const width = expToks.filter((t) => t.t === 'ph' && t.ch === '0').length;
    emit(out, `E${sign}${String(Math.abs(exponent)).padStart(width, '0')}`);
    expToks.forEach((t) => { if (t.t === 'lit') emit(out, t.s, true); if (t.t === 'pct') emit(out, '%', true); });
  }
}

/** Best fraction n/d with d ≤ maxDen (continued fractions). */
function approximate(x: number, maxDen: number): [number, number] {
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let b = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(b);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (Math.abs(b - a) < 1e-12) break;
    b = 1 / (b - a);
  }
  // Also try the best semiconvergent-free neighbour by brute force for small denominators.
  let best: [number, number] = [h1, k1 || 1];
  let err = Math.abs(x - best[0] / best[1]);
  if (maxDen <= 1000) {
    for (let d = 1; d <= maxDen; d++) {
      const n = Math.round(x * d);
      const e = Math.abs(x - n / d);
      if (e < err - 1e-15) { best = [n, d]; err = e; }
    }
  }
  return best;
}

function formatFractionSection(out: Out, toks: Tok[], v: number, negative: boolean): void {
  const slashAt = toks.findIndex((t) => t.t === 'slash');
  // Denominator: placeholders (max digits) or literal digits (fixed).
  const after = toks.slice(slashAt + 1);
  const denPh = after.filter((t) => t.t === 'ph').length;
  const fixedLit = after.find((t) => t.t === 'lit' && /^\d+/.test(t.s)) as { s: string } | undefined;
  const fixedDen = denPh === 0 && fixedLit ? Number(/^\d+/.exec(fixedLit.s)![0]) : 0;
  // Numerator = the placeholder run right before '/'; anything before a gap is the integer part.
  let j = slashAt - 1;
  while (j >= 0 && toks[j].t === 'ph') j--;
  const numToks = toks.slice(j + 1, slashAt);
  const intToks = toks.slice(0, j + 1);
  const hasInt = intToks.some((t) => t.t === 'ph');
  let whole = hasInt ? Math.floor(v) : 0;
  const frac = v - whole;
  let n: number;
  let d: number;
  if (fixedDen) { d = fixedDen; n = Math.round(frac * d); }
  else [n, d] = approximate(frac, 10 ** Math.max(1, denPh) - 1);
  if (hasInt && n === d) { whole += 1; n = 0; }
  if (negative) emit(out, '-', true);
  if (hasInt) emitInteger(out, intToks.filter((t) => t.t === 'ph' || t.t === 'lit'), whole === 0 && n !== 0 ? '' : String(whole), false);
  if (hasInt && n === 0) {
    // Excel leaves the fraction blank (spaces) when it is zero.
    emit(out, ' '.repeat(numToks.length + 1 + Math.max(denPh, String(fixedDen).length)));
    return;
  }
  emit(out, String(n).padStart(numToks.filter((t) => t.t === 'ph' && t.ch !== '#').length, ' '));
  emit(out, '/');
  if (fixedDen) emit(out, String(fixedDen)); else emit(out, String(d).padEnd(denPh, ' '));
  after.forEach((t) => { if (t.t === 'lit' && !(fixedLit && t === (fixedLit as unknown))) emit(out, t.s, true); });
}

function formatDateSection(out: Out, sec: Section, serial: number, opts: NumberFormatOptions): boolean {
  if (serial < 0) return false;
  const ar = opts.locale === 'ar';
  const toks = sec.toks;
  const hasAmPm = toks.some((t) => t.t === 'ampm');
  const rounded = Math.round(serial * 86400) / 86400;
  const date = serialToDate(rounded);
  const secs = Math.round((rounded - Math.floor(rounded)) * 86400);
  const hour = Math.floor(secs / 3600);
  const minute = Math.floor((secs % 3600) / 60);
  const second = secs % 60;
  const dateToks = toks.map((t, i) => ({ t, i })).filter(({ t }) => t.t === 'date' || t.t === 'elapsed');
  const isMinute = (idx: number): boolean => {
    const pos = dateToks.findIndex((x) => x.i === idx);
    const prev = dateToks[pos - 1]?.t;
    const next = dateToks[pos + 1]?.t;
    const code = (t: Tok | undefined): string => (t?.t === 'date' ? t.code[0] : t?.t === 'elapsed' ? t.unit : '');
    return code(prev) === 'h' || code(next) === 's';
  };
  toks.forEach((t, i) => {
    switch (t.t) {
      case 'lit': emit(out, t.s, true); break;
      case 'dot': emit(out, '.'); break;
      case 'comma': emit(out, ',', true); break;
      case 'slash': emit(out, '/', true); break;
      case 'pct': emit(out, '%', true); break;
      case 'ph': emit(out, '0'); break;
      case 'ampm': {
        const pm = hour >= 12;
        let s = ar ? (pm ? 'م' : 'ص') : t.short ? (pm ? 'P' : 'A') : pm ? 'PM' : 'AM';
        if (t.lower && !ar) s = s.toLowerCase();
        emit(out, s, ar);
        break;
      }
      case 'elapsed': {
        const total = t.unit === 'h' ? Math.floor(rounded * 24) : t.unit === 'm' ? Math.floor(rounded * 1440) : Math.round(rounded * 86400);
        emit(out, String(total).padStart(t.width, '0'));
        break;
      }
      case 'date': {
        const c = t.code;
        const k = c[0];
        const n = c.length;
        if (k === 'y') emit(out, n <= 2 ? String(date.year % 100).padStart(2, '0') : String(date.year));
        else if (k === 'd') {
          if (n <= 2) emit(out, String(date.day).padStart(n, '0'));
          else {
            const name = (ar ? DAYS_AR : DAYS_EN)[date.weekday];
            emit(out, n === 3 && !ar ? name.slice(0, 3) : name, true);
          }
        } else if (k === 'h') {
          const h = hasAmPm ? hour % 12 || 12 : hour;
          emit(out, String(h).padStart(Math.min(n, 2), '0'));
        } else if (k === 's') emit(out, String(second).padStart(Math.min(n, 2), '0'));
        else if (k === 'm') {
          if (n <= 2 && isMinute(i)) emit(out, String(minute).padStart(n, '0'));
          else if (n <= 2) emit(out, String(date.month).padStart(n, '0'));
          else {
            const name = (ar ? MONTHS_AR : MONTHS_EN)[date.month - 1];
            emit(out, n === 3 && !ar ? name.slice(0, 3) : n === 5 ? name[0] : name, true);
          }
        }
        break;
      }
      default: break;
    }
  });
  return true;
}

function condMatches(cond: { op: string; value: number }, v: number): boolean {
  switch (cond.op) {
    case '<': return v < cond.value;
    case '>': return v > cond.value;
    case '<=': return v <= cond.value;
    case '>=': return v >= cond.value;
    case '<>': return v !== cond.value;
    default: return v === cond.value;
  }
}

/** The text a cell shows for a value in a format. */
export function formatValue(value: Scalar, pattern = 'General', opts: NumberFormatOptions = {}): FormattedValue {
  if (value === null) return { text: '' };
  if (isError(value)) return { text: value.code };
  const sections = compile(pattern || 'General');
  const out: Out = { parts: [] };
  if (typeof value === 'boolean') {
    const text = opts.locale === 'ar' ? (value ? 'صحيح' : 'خطأ') : value ? 'TRUE' : 'FALSE';
    return { text };
  }
  if (typeof value === 'string') {
    const sec = sections[3] ?? (sections.length === 1 && sections[0].kind === 'text' ? sections[0] : undefined);
    if (!sec) return { text: value };
    for (const t of sec.toks) {
      if (t.t === 'at') emit(out, value, true);
      else if (t.t === 'lit') emit(out, t.s, true);
    }
    return { text: finish(out, opts), color: sec.color };
  }
  if (!Number.isFinite(value)) return { text: '#NUM!' };

  let sec: Section;
  let autoSign = true;
  const conditional = sections.filter((s) => s.cond);
  if (conditional.length) {
    const hit = sections.slice(0, 3).find((s) => s.cond && condMatches(s.cond, value));
    sec = hit ?? sections.find((s, i) => i < 3 && !s.cond) ?? sections[sections.length - 1];
    autoSign = !hit || hit.cond!.op !== '<';
  } else if (sections.length === 1 || sections[0].kind === 'text') {
    sec = sections[0];
  } else if (value > 0 || (value === 0 && sections.length < 3)) {
    sec = sections[0];
  } else if (value < 0) {
    sec = sections[1];
    autoSign = false;
  } else {
    sec = sections[2];
  }

  switch (sec.kind) {
    case 'empty': return { text: '', color: sec.color };
    case 'general': {
      const text = formatGeneral(autoSign ? value : Math.abs(value), 10);
      for (const t of sec.toks) {
        if (t.t === 'general') emit(out, text);
        else if (t.t === 'lit') emit(out, t.s, true);
      }
      break;
    }
    case 'date':
      if (!formatDateSection(out, sec, value, opts)) return { text: '#'.repeat(8) };
      break;
    case 'text': {
      for (const t of sec.toks) {
        if (t.t === 'lit') emit(out, t.s, true);
        else if (t.t === 'at') emit(out, formatGeneral(value, 10));
      }
      break;
    }
    default:
      formatNumberSection(out, sec, value, autoSign);
  }
  return { text: finish(out, opts), color: sec.color };
}

/* ───────────────────────────── building and parsing ───────────────────────────── */

export interface FormatSpec {
  kind: 'general' | 'number' | 'percent' | 'currency' | 'date' | 'time' | 'datetime' | 'scientific' | 'text';
  decimals?: number;
  grouping?: boolean;
  symbol?: string;
  symbolAfter?: boolean;
  style?: 'short' | 'long' | 'iso';
  seconds?: boolean;
}

/** A format pattern for a toolbar choice. */
export function makeFormat(spec: FormatSpec): string {
  const d = Math.max(0, Math.min(15, spec.decimals ?? (spec.kind === 'percent' ? 0 : 2)));
  const frac = d ? `.${'0'.repeat(d)}` : '';
  switch (spec.kind) {
    case 'general': return 'General';
    case 'number': return `${spec.grouping === false ? '0' : '#,##0'}${frac}`;
    case 'percent': return `0${frac}%`;
    case 'scientific': return `0${frac}E+00`;
    case 'text': return '@';
    case 'currency': {
      const sym = `"${(spec.symbol ?? '$').replace(/"/g, '')}"`;
      const body = `#,##0${frac}`;
      return spec.symbolAfter ? `${body} ${sym}` : `${sym}${body}`;
    }
    case 'date': return spec.style === 'long' ? 'd mmmm yyyy' : spec.style === 'iso' ? 'yyyy-mm-dd' : 'dd/mm/yyyy';
    case 'time': return spec.seconds ? 'hh:mm:ss' : 'hh:mm';
    default: return `yyyy-mm-dd hh:mm${spec.seconds ? ':ss' : ''}`;
  }
}

export interface ParsedEntry { value: Scalar; format?: string }

/**
 * What a typed entry means, as Excel reads it: a number (with the format its
 * shape implies), a date or time, TRUE/FALSE, or text. A leading apostrophe
 * forces text. Arabic-Indic digits are accepted.
 */
export function parseEntry(raw: string, opts: { dateOrder?: 'dmy' | 'mdy' } = {}): ParsedEntry {
  if (raw === '') return { value: null };
  if (raw.startsWith('\'')) return { value: raw.slice(1) };
  const text = latinDigits(raw).trim();
  const upper = text.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return { value: upper === 'TRUE' };
  let m = /^(-)?(\d+(?:\.\d+)?)%$/.exec(text);
  if (m) {
    const decimals = m[2].split('.')[1]?.length ?? 0;
    return { value: (m[1] ? -1 : 1) * Number(m[2]) / 100, format: decimals ? `0.${'0'.repeat(decimals)}%` : '0%' };
  }
  m = /^(-)?([$€£])\s?(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?$/.exec(text);
  if (m) {
    const n = Number(m[3].replace(/,/g, '') + (m[4] ?? ''));
    const d = m[4] ? m[4].length - 1 : 0;
    return { value: (m[1] ? -1 : 1) * n, format: makeFormat({ kind: 'currency', symbol: m[2], decimals: d }) };
  }
  m = /^(-)?(\d{1,3}(?:,\d{3})+)(\.\d+)?$/.exec(text);
  if (m) {
    const d = m[3] ? m[3].length - 1 : 0;
    return { value: (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, '') + (m[3] ?? '')), format: makeFormat({ kind: 'number', decimals: d }) };
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return { value: Number(text) };
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validDate(y, mo, d)) return { value: dateToSerial(y, mo, d), format: 'yyyy-mm-dd' };
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let y = Number(m[3]);
    if (m[3].length === 2) y += y < 30 ? 2000 : 1900;
    const [d, mo] = opts.dateOrder === 'mdy' ? [b, a] : [a, b];
    if (validDate(y, mo, d)) return { value: dateToSerial(y, mo, d), format: opts.dateOrder === 'mdy' ? 'mm/dd/yyyy' : 'dd/mm/yyyy' };
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(text);
  if (m) {
    let h = Number(m[1]);
    const mi = Number(m[2]);
    const s = Number(m[3] ?? 0);
    if (m[4]) { if (h < 1 || h > 12) return { value: raw }; h = (h % 12) + (/p/i.test(m[4]) ? 12 : 0); }
    if (h < 24 && mi < 60 && s < 60) {
      const fmt = `h:mm${m[3] ? ':ss' : ''}${m[4] ? ' AM/PM' : ''}`;
      return { value: (h * 3600 + mi * 60 + s) / 86400, format: fmt };
    }
  }
  return { value: raw };
}

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Excel's built-in number formats by numFmtId (the ones a .xlsx may reference without defining). */
export const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  12: '# ?/?', 13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss',
  46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};
