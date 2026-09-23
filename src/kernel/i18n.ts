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

export function getLocale(): Locale { return current; }

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = tables[current][key] ?? tables.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
