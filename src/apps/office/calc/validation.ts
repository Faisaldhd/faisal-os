/**
 * Office Calc — data validation (التحقق من البيانات). Pure, DOM-free.
 *
 *   validateEntry(input, rule) → { ok: true, value } | { ok: false, reason, message: { ar, en } }
 *       `input` is what the user typed (or a scalar); `value` is the typed scalar to store.
 *   listOptions(rule) → the dropdown items of a list rule (trimmed, de-duplicated, order kept)
 *   parseListSource("a, b ,c") / parseListSource("أ،ب") → items (comma, semicolon or Arabic comma)
 *   VALIDATION_MESSAGES → { ar: {...}, en: {...} } the default texts, for strings.ts
 *
 * Rules:
 *   { kind: 'list', items: string[], caseSensitive?, allowBlank? }
 *   { kind: 'whole' | 'decimal', op, min?, max? , allowBlank? }
 *   { kind: 'date', op, min?, max?, allowBlank? }        min/max: serials or 'yyyy-mm-dd'
 *   { kind: 'textLength', op, min?, max?, allowBlank? }
 *   op: 'between' | 'notBetween' | 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' (compares with min; between uses min and max)
 * A rule may carry its own error text ({ error: { ar, en } }), which replaces the default.
 * allowBlank defaults to true (an empty cell always passes), as in Excel.
 */
import { formatValue } from './numfmt';
import { textToNumber, scalarFromText, type Scalar } from '../formula/values';

export type CompareOp = 'between' | 'notBetween' | 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte';
export interface Bilingual { ar: string; en: string }

interface Base { allowBlank?: boolean; error?: Bilingual }
export type ValidationRule =
  | (Base & { kind: 'list'; items: readonly string[]; caseSensitive?: boolean })
  | (Base & { kind: 'whole' | 'decimal' | 'textLength'; op: CompareOp; min?: number; max?: number })
  | (Base & { kind: 'date'; op: CompareOp; min?: number | string; max?: number | string });

export type ValidationReason = 'notInList' | 'notNumber' | 'notWhole' | 'notDate' | 'outOfRange' | 'blank';
export type ValidationResult = { ok: true; value: Scalar } | { ok: false; reason: ValidationReason; message: Bilingual };

/** Default messages; `{a}`/`{b}` are the bounds, `{op}` the comparison. Add to strings.ts under office.validation.*. */
export const VALIDATION_MESSAGES: Readonly<Record<'ar' | 'en', Readonly<Record<string, string>>>> = {
  en: {
    notInList: 'Choose a value from the list.',
    notNumber: 'Enter a number.',
    notWhole: 'Enter a whole number.',
    notDate: 'Enter a date.',
    blank: 'This cell cannot be empty.',
    between: 'Enter a value between {a} and {b}.',
    notBetween: 'Enter a value outside {a} to {b}.',
    eq: 'Enter {a}.',
    neq: 'Enter any value except {a}.',
    gt: 'Enter a value greater than {a}.',
    lt: 'Enter a value less than {a}.',
    gte: 'Enter {a} or more.',
    lte: 'Enter {a} or less.',
    lengthPrefix: 'Text length: ',
  },
  ar: {
    notInList: 'اختر قيمة من القائمة.',
    notNumber: 'أدخل رقماً.',
    notWhole: 'أدخل عدداً صحيحاً.',
    notDate: 'أدخل تاريخاً.',
    blank: 'لا يمكن ترك هذه الخلية فارغة.',
    between: 'أدخل قيمة بين {a} و{b}.',
    notBetween: 'أدخل قيمة خارج النطاق من {a} إلى {b}.',
    eq: 'أدخل {a}.',
    neq: 'أدخل أي قيمة غير {a}.',
    gt: 'أدخل قيمة أكبر من {a}.',
    lt: 'أدخل قيمة أصغر من {a}.',
    gte: 'أدخل {a} أو أكثر.',
    lte: 'أدخل {a} أو أقل.',
    lengthPrefix: 'طول النص: ',
  },
};

function msg(key: string, params: { a?: string; b?: string } = {}, prefix = false): Bilingual {
  const fill = (lang: 'ar' | 'en'): string => {
    const t = VALIDATION_MESSAGES[lang][key].replace('{a}', params.a ?? '').replace('{b}', params.b ?? '');
    return prefix ? VALIDATION_MESSAGES[lang].lengthPrefix + t : t;
  };
  return { ar: fill('ar'), en: fill('en') };
}

export function parseListSource(text: string): string[] {
  return listOptions({ items: text.split(/[,;،]/) });
}

export function listOptions(rule: { items: readonly string[]; caseSensitive?: boolean }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rule.items) {
    const item = raw.trim();
    const k = rule.caseSensitive ? item : item.toLowerCase();
    if (!item || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function compare(op: CompareOp, v: number, a: number | undefined, b: number | undefined): boolean {
  const x = a ?? -Infinity;
  const y = b ?? Infinity;
  switch (op) {
    case 'between': return v >= Math.min(x, y) && v <= Math.max(x, y);
    case 'notBetween': return v < Math.min(x, y) || v > Math.max(x, y);
    case 'eq': return v === a;
    case 'neq': return v !== a;
    case 'gt': return v > x;
    case 'lt': return v < (a ?? Infinity);
    case 'gte': return v >= x;
    default: return v <= (a ?? Infinity);
  }
}

function toSerial(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return v;
  return textToNumber(v) ?? undefined;
}

export function validateEntry(input: string | Scalar, rule: ValidationRule): ValidationResult {
  const fail = (reason: ValidationReason, message: Bilingual): ValidationResult => ({ ok: false, reason, message: rule.error ?? message });
  const raw = typeof input === 'string' ? input : input;
  const blank = raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (blank) return rule.allowBlank === false ? fail('blank', msg('blank')) : { ok: true, value: null };

  if (rule.kind === 'list') {
    const text = typeof raw === 'string' ? raw.trim() : String(raw);
    const items = listOptions(rule);
    const hit = items.find((i) => (rule.caseSensitive ? i === text : i.toLowerCase() === text.toLowerCase()));
    return hit === undefined ? fail('notInList', msg('notInList')) : { ok: true, value: scalarFromText(hit) };
  }

  if (rule.kind === 'textLength') {
    const text = typeof raw === 'string' ? raw : String(raw);
    const ok = compare(rule.op, text.length, rule.min, rule.max);
    return ok ? { ok: true, value: typeof raw === 'string' ? scalarFromText(raw) : raw } : fail('outOfRange', msg(rule.op, { a: String(rule.min ?? ''), b: String(rule.max ?? '') }, true));
  }

  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? textToNumber(raw) : null;
  if (rule.kind === 'date') {
    if (n === null || n < 1) return fail('notDate', msg('notDate'));
    const a = toSerial(rule.min);
    const b = toSerial(rule.max);
    const show = (s: number | undefined): string => (s === undefined ? '' : formatValue(s, 'yyyy-mm-dd').text);
    return compare(rule.op, Math.floor(n), a, b) ? { ok: true, value: n } : fail('outOfRange', msg(rule.op, { a: show(a), b: show(b) }));
  }
  if (n === null) return fail('notNumber', msg(rule.kind === 'whole' ? 'notWhole' : 'notNumber'));
  if (rule.kind === 'whole' && !Number.isInteger(n)) return fail('notWhole', msg('notWhole'));
  return compare(rule.op, n, rule.min, rule.max)
    ? { ok: true, value: n }
    : fail('outOfRange', msg(rule.op, { a: String(rule.min ?? ''), b: String(rule.max ?? '') }));
}
