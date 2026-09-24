import { describe, expect, it } from 'vitest';
import { registeredKeys, setLocale, t } from '../../kernel/i18n';
import type { Locale } from '../../kernel/types';
import './strings';

/**
 * The app's own parity guard.
 *
 * `src/apps/web/strings.test.ts` compares every namespace in the OS — but only for the apps it
 * imports, and it does not import this one (the Photo Editor is registered by the lead, after
 * this module was written). Without this file the `photo` namespace would be the one table
 * nothing checks, and `t()` resolves `ar → en → key` silently: a key present in only one
 * language would render as the other language, or as the raw key, with a green suite.
 *
 * The checks mirror that suite's four rules, scoped to `photo.*` so this file keeps passing
 * whether or not the app is imported elsewhere.
 */

const keysIn = (locale: Locale): string[] => registeredKeys(locale).filter((k) => k.startsWith('photo.'));

describe('photo strings — parity between Arabic and English', () => {
  it('registered a realistic number of keys, so a broken import cannot pass vacuously', () => {
    expect(keysIn('ar').length).toBeGreaterThan(100);
    expect(keysIn('en').length).toBe(keysIn('ar').length);
  });

  it('has exactly the same keys in both languages, in both directions', () => {
    const ar = new Set(keysIn('ar'));
    const en = new Set(keysIn('en'));
    const missingFromEnglish = keysIn('ar').filter((k) => !en.has(k));
    const missingFromArabic = keysIn('en').filter((k) => !ar.has(k));
    expect({ missingFromEnglish, missingFromArabic }).toEqual({ missingFromEnglish: [], missingFromArabic: [] });
  });

  it('resolves every key to real text in both languages, never to the key itself', () => {
    for (const locale of ['ar', 'en'] as Locale[]) {
      setLocale(locale);
      for (const key of keysIn(locale)) {
        const value = t(key);
        expect(value, `${key} [${locale}]`).not.toBe(key);
        expect(value.trim().length, `${key} [${locale}]`).toBeGreaterThan(0);
      }
    }
    setLocale('ar');
  });

  it('keeps the same {placeholder} names in both languages of every key', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keysIn('ar')) {
      setLocale('ar');
      const inAr = placeholders(t(key));
      setLocale('en');
      const inEn = placeholders(t(key));
      // A translation that renames {path} to {file} silently loses its value.
      expect(inEn, key).toEqual(inAr);
    }
    setLocale('ar');
  });

  it('carries the Arabic-first strings the app depends on, in both languages', () => {
    for (const key of [
      'photo.title', 'photo.openFile', 'photo.saveAsCopy', 'photo.overwrite', 'photo.undo', 'photo.redo',
      'photo.toolCrop', 'photo.toolText', 'photo.historyPolicy', 'photo.limitsTitle',
      'photo.exportDoneOverwrite', 'photo.errorTitle',
    ]) {
      expect(keysIn('ar'), key).toContain(key);
      expect(keysIn('en'), key).toContain(key);
    }
    setLocale('ar');
    expect(t('photo.title')).toBe('محرّر الصور');
    setLocale('en');
    expect(t('photo.title')).toBe('Photo Editor');
    setLocale('ar');
  });
});
