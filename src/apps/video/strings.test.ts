import { describe, expect, it } from 'vitest';
import { registeredKeys, setLocale, t } from '../../kernel/i18n';
// Imported for its side effect: it registers the `video` namespace in both tables.
import './strings';

/**
 * The repo-wide parity test (src/apps/web/strings.test.ts) compares every table,
 * but it only sees the namespaces its import list reaches — and `video` is not on
 * that list yet. These two checks are scoped to this app so a one-sided key here
 * cannot ship unnoticed in the meantime, and they stay useful afterwards.
 */
const keysIn = (locale: 'ar' | 'en'): string[] =>
  registeredKeys(locale).filter((key) => key.startsWith('video.'));

describe('video strings', () => {
  it('registers the namespace in both languages', () => {
    expect(keysIn('ar').length).toBeGreaterThan(80);
    expect(keysIn('en').length).toBe(keysIn('ar').length);
  });

  it('has exactly the same keys in Arabic and English', () => {
    expect(keysIn('en')).toEqual(keysIn('ar'));
  });

  it('resolves every key to real text in both languages, never to the key itself', () => {
    for (const locale of ['ar', 'en'] as const) {
      setLocale(locale);
      for (const key of keysIn(locale)) {
        const value = t(key);
        expect(value, `${key} [${locale}]`).not.toBe(key);
        expect(value.trim().length, `${key} [${locale}]`).toBeGreaterThan(0);
      }
    }
    setLocale('ar');
  });

  it('keeps the same {placeholder} names in both languages', () => {
    const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of keysIn('ar')) {
      setLocale('ar');
      const inArabic = placeholders(t(key));
      setLocale('en');
      expect(placeholders(t(key)), key).toEqual(inArabic);
    }
    setLocale('ar');
  });
});
