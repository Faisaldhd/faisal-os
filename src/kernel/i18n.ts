import type { Locale } from './types';

/**
 * كل مسار يسجّل نصوصه في namespace خاص به:
 *   defineStrings('files', { ar: { title: 'الملفات' }, en: { title: 'Files' } })
 *   t('files.title')
 */
type Dict = Record<string, string>;
const tables: Record<Locale, Dict> = { ar: {}, en: {} };
let current: Locale = 'ar';

export function defineStrings(ns: string, strings: Record<Locale, Dict>): void {
  for (const loc of ['ar', 'en'] as Locale[]) {
    for (const [k, v] of Object.entries(strings[loc] ?? {})) tables[loc][`${ns}.${k}`] = v;
  }
}

export function setLocale(loc: Locale): void {
  current = loc;
  document.documentElement.lang = loc;
  document.documentElement.dir = loc === 'ar' ? 'rtl' : 'ltr';
}

/**
 * Every key registered for a locale, sorted — for tests and diagnostics.
 *
 * Read-only and additive: it exists so a test can prove that a namespace really
 * has the same keys in Arabic and English. `t()` alone cannot show that, because
 * it silently falls back (`ar → en → key`), which is the right runtime behaviour
 * and the exact reason a missing Arabic or English string ships unnoticed.
 */
export function registeredKeys(locale: Locale): string[] {
  return Object.keys(tables[locale]).sort();
}

export function getLocale(): Locale { return current; }

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = tables[current][key] ?? tables.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
